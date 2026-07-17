const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SITE_DIR = path.join(__dirname, "site");
const html = fs.readFileSync(path.join(SITE_DIR, "index.html"), "utf8");

const dom = new JSDOM(html, {
  url: "http://localhost/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;

// --- Stub fetch to always fail, forcing the Info fallback path (simulates file://) ---
window.fetch = () => Promise.reject(new Error("fetch disabled in test"));

// --- Stub Plotly ---
const plotlyCalls = [];
const downloadImageCalls = [];
window.Plotly = {
  newPlot: (divId, traces, layout) => plotlyCalls.push({ fn: "newPlot", divId, traces, layout }),
  react: (divId, traces, layout) => plotlyCalls.push({ fn: "react", divId, traces, layout }),
  downloadImage: (divId, opts) => {
    downloadImageCalls.push({ divId, opts });
    return Promise.resolve();
  },
};

// --- Stub canvas 2D context ---
class FakeImageData {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
window.HTMLCanvasElement.prototype.getContext = function () {
  return {
    createImageData: (w, h) => new FakeImageData(w, h),
    putImageData: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    setLineDash: () => {},
    set lineWidth(v) {},
    set strokeStyle(v) {},
  };
};
window.HTMLCanvasElement.prototype.toDataURL = function () {
  return "data:image/png;base64,FAKE";
};

// --- Stub URL.createObjectURL / anchor click (download machinery) ---
window.URL.createObjectURL = () => "blob:fake";
const downloadedFiles = [];
const originalCreateElement = window.document.createElement.bind(window.document);
window.document.createElement = function (tag) {
  const el = originalCreateElement(tag);
  if (tag === "a") {
    const origClick = el.click ? el.click.bind(el) : () => {};
    el.click = function () {
      downloadedFiles.push({ href: el.href, download: el.download });
    };
  }
  return el;
};

// --- Capture the live-loop interval callback so we can drive it manually ---
let liveTickFn = null;
const realSetInterval = window.setInterval.bind(window);
window.setInterval = (fn, ms) => {
  liveTickFn = fn;
  return 1; // fake timer id; we never let the real interval run in this test
};
window.clearInterval = () => {};

// --- Load application scripts ---
const scriptFiles = [
  "src/physics.js",
  "src/colormap.js",
  "src/canvas.js",
  "src/charts.js",
  "src/controls.js",
  "src/info.js",
  "src/exporters.js",
  "src/main.js",
];
for (const file of scriptFiles) {
  window.eval(fs.readFileSync(path.join(SITE_DIR, file), "utf8"));
}

let failures = 0;
function check(label, cond, extra) {
  if (cond) {
    console.log("PASS:", label);
  } else {
    failures++;
    console.log("FAIL:", label, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

function lastCallFor(divId) {
  const calls = plotlyCalls.filter((c) => c.divId === divId);
  return calls[calls.length - 1];
}

// ============================================================================
// 1. Vertical dashed line on the noise chart
// ============================================================================
const noiseCall = lastCallFor("noise-chart");
const shapes = noiseCall.layout.shapes || [];
check("Noise chart has exactly one shape (vertical line)", shapes.length === 1, shapes.length);
check("Vertical line x-position matches current photons (default 20)", shapes[0] && shapes[0].x0 === 20, shapes[0] && shapes[0].x0);
check("Vertical line spans full plot height (yref=paper, 0 to 1)", shapes[0] && shapes[0].yref === "paper" && shapes[0].y0 === 0 && shapes[0].y1 === 1);
check("Vertical line is dashed", shapes[0] && shapes[0].line.dash === "dash");

const annotations = noiseCall.layout.annotations || [];
check("Noise chart has a 'Current photons' annotation instead of a legend entry", annotations.some((a) => a.text === "Current photons"));
check("Noise chart has only 4 traces now (no ghost legend trace)", noiseCall.traces.length === 4, noiseCall.traces.length);
check("Legend on noise chart sits below the plot (y < 0)", noiseCall.layout.legend.y < 0, noiseCall.layout.legend.y);
check("Legend is horizontally centered (xanchor: center)", noiseCall.layout.legend.xanchor === "center");

// ============================================================================
// 2. Axes/color scale frozen across live frames; refreshed on parameter change
// ============================================================================
// Play, so the interval is "running" (we drive it manually via liveTickFn)
window.document.getElementById("play-pause-btn").dispatchEvent(new window.Event("click"));
check("Live-loop interval callback was captured after clicking Play", typeof liveTickFn === "function");

const histRangesBeforeParamChange = [];
for (let i = 0; i < 5; i++) {
  liveTickFn();
  const call = lastCallFor("histogram-chart");
  histRangesBeforeParamChange.push(JSON.stringify(call.layout.xaxis.range));
}
const allIdenticalBeforeChange = histRangesBeforeParamChange.every((r) => r === histRangesBeforeParamChange[0]);
check(
  "Histogram x-range identical across 5 live frames with NO parameter change (frozen, not recomputed per-frame)",
  allIdenticalBeforeChange,
  histRangesBeforeParamChange
);

const lineCallBefore = lastCallFor("line-profile-chart");
const yRangeBefore = JSON.stringify(lineCallBefore.layout.yaxis.range);

// Now change a parameter drastically (photons way up) and confirm ranges get refreshed
const photonsSlider = window.document.getElementById("photons-slider");
photonsSlider.value = "1000"; // top of internal 0-1000 log-scale slider -> near max photons (1000)
photonsSlider.dispatchEvent(new window.Event("input"));

const histRangeAfterChange = JSON.stringify(lastCallFor("histogram-chart").layout.xaxis.range);
check(
  "Histogram x-range changes after a parameter change (re-derived from new params)",
  histRangeAfterChange !== histRangesBeforeParamChange[0],
  { before: histRangesBeforeParamChange[0], after: histRangeAfterChange }
);

// And after THIS change, it should again stay frozen across further live frames
const histRangesAfterChange = [];
for (let i = 0; i < 3; i++) {
  liveTickFn();
  histRangesAfterChange.push(JSON.stringify(lastCallFor("histogram-chart").layout.xaxis.range));
}
check(
  "Histogram x-range frozen again across new live frames after the change",
  histRangesAfterChange.every((r) => r === histRangeAfterChange),
  histRangesAfterChange
);

// ============================================================================
// 3. Inline info text (under Box 1, no button/overlay anymore)
// ============================================================================
// Info.loadInfoText() is awaited at load time in main.js; flush microtasks.
(async () => {
  await new Promise((r) => setTimeout(r, 20));
  const infoTextEl = window.document.getElementById("info-text");
  check("Info panel exists and has no button/overlay wrapper", !!infoTextEl && !window.document.getElementById("info-overlay"));
  check(
    "Info text populates automatically with fallback text (since fetch is stubbed to fail)",
    infoTextEl.textContent.includes("PhotonBench"),
    infoTextEl.textContent.slice(0, 60)
  );

  // ============================================================================
  // 4. Export button: pauses playback and triggers all expected downloads
  // ============================================================================
  // The interval has been running (isPlaying=true) since the earlier click and was
  // never paused, so it should still read "Pause" here.
  check("Still playing before export", window.document.getElementById("play-pause-btn").textContent === "Pause");

  downloadImageCalls.length = 0;
  downloadedFiles.length = 0;
  window.document.getElementById("export-btn").dispatchEvent(new window.Event("click"));

  check("Export pauses playback", window.document.getElementById("play-pause-btn").textContent === "Play");
  check("Export downloads 4 Plotly PNGs (histogram, line profile, SNR, noise)", downloadImageCalls.length === 4, downloadImageCalls.length);
  const pngDivs = downloadImageCalls.map((c) => c.divId).sort();
  check(
    "Plotly PNG exports cover the right 4 panels",
    JSON.stringify(pngDivs) === JSON.stringify(["histogram-chart", "line-profile-chart", "noise-chart", "snr-chart"]),
    pngDivs
  );

  const txtFiles = downloadedFiles.filter((f) => f.download && f.download.endsWith(".txt"));
  const pngFiles = downloadedFiles.filter((f) => f.download && f.download.endsWith(".png"));
  check("Export downloads 1 canvas PNG (sensor frame) via anchor", pngFiles.length === 1, pngFiles.map((f) => f.download));
  check("Export downloads 4 text files", txtFiles.length === 4, txtFiles.map((f) => f.download));

  // ============================================================================
  // 5. Per-panel export buttons: each exports exactly 1 Plotly PNG + 1 text file
  // ============================================================================
  const perPanelButtons = {
    "export-histogram-btn": "histogram-chart",
    "export-line-btn": "line-profile-chart",
    "export-snr-btn": "snr-chart",
    "export-noise-btn": "noise-chart",
  };
  for (const [btnId, divId] of Object.entries(perPanelButtons)) {
    downloadImageCalls.length = 0;
    downloadedFiles.length = 0;
    window.document.getElementById(btnId).dispatchEvent(new window.Event("click"));
    check(`${btnId} downloads exactly 1 Plotly PNG for #${divId}`,
      downloadImageCalls.length === 1 && downloadImageCalls[0].divId === divId,
      downloadImageCalls);
    const txt = downloadedFiles.filter((f) => f.download && f.download.endsWith(".txt"));
    check(`${btnId} downloads exactly 1 text file`, txt.length === 1, txt.map((f) => f.download));
  }

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`));
  process.exit(failures === 0 ? 0 : 1);
})();
