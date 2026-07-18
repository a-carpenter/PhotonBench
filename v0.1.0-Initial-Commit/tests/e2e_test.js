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

// --- Stub Plotly (real Plotly needs a browser rendering engine; we only
// need to confirm charts.js calls it with sane, correctly-shaped data). ---
const plotlyCalls = [];
window.Plotly = {
  newPlot: (divId, traces, layout, config) => {
    plotlyCalls.push({ fn: "newPlot", divId, traces, layout });
  },
  react: (divId, traces, layout, config) => {
    plotlyCalls.push({ fn: "react", divId, traces, layout });
  },
};

// --- Stub canvas 2D context (jsdom doesn't implement real rendering) ---
class FakeImageData {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
const putImageDataCalls = [];
const rowIndicatorCalls = [];
window.HTMLCanvasElement.prototype.getContext = function () {
  const canvasEl = this;
  return {
    createImageData: (w, h) => new FakeImageData(w, h),
    putImageData: (imageData, x, y) => {
      putImageDataCalls.push({ imageData, x, y, canvasWidth: canvasEl.width, canvasHeight: canvasEl.height });
    },
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: (x, y) => rowIndicatorCalls.push({ fn: "moveTo", x, y }),
    lineTo: (x, y) => rowIndicatorCalls.push({ fn: "lineTo", x, y }),
    stroke: () => {},
    setLineDash: () => {},
    set lineWidth(v) {},
    set strokeStyle(v) {
      rowIndicatorCalls.push({ fn: "strokeStyle", value: v });
    },
  };
};

// --- Stub fetch (Info.loadInfoText does a fetch("README.md") on load) ---
window.fetch = () => Promise.reject(new Error("fetch disabled in test"));

// --- Load application scripts, in the same order as index.html, into the jsdom window ---
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
  const code = fs.readFileSync(path.join(SITE_DIR, file), "utf8");
  window.eval(code);
}

// ============================================================================
// Assertions
// ============================================================================

let failures = 0;
function check(label, cond, extra) {
  if (cond) {
    console.log("PASS:", label);
  } else {
    failures++;
    console.log("FAIL:", label, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

// --- 0. Default gain/offset values ---
const gainNumberEl = window.document.getElementById("gain-number");
const offsetNumberEl = window.document.getElementById("offset-number");
check("Default gain is 1", parseFloat(gainNumberEl.value) === 1, gainNumberEl.value);
check("Default offset is 100", parseFloat(offsetNumberEl.value) === 100, offsetNumberEl.value);

// --- 1. Controls were built: 3 experimental + 7 camera (incl. bit depth select) ---
const expControls = window.document.querySelectorAll("#experimental-controls .param-control");
const camControls = window.document.querySelectorAll("#camera-controls .param-control");
check("3 experimental parameter controls created", expControls.length === 3, expControls.length);
check("7 camera parameter controls created (6 sliders + bit depth select)", camControls.length === 7, camControls.length);

// --- 2. Plotly was called for all 4 chart panels, at least once each ---
const divsCalled = new Set(plotlyCalls.map((c) => c.divId));
for (const id of ["histogram-chart", "line-profile-chart", "snr-chart", "noise-chart"]) {
  check(`Plotly called for #${id}`, divsCalled.has(id));
}

// --- 3. Histogram: bars only (no line overlay), no NaN, correct titles, no legend ---
const histCalls = plotlyCalls.filter((c) => c.divId === "histogram-chart");
const lastHist = histCalls[histCalls.length - 1];
check("Histogram has exactly 1 trace (bars only, line overlay removed)", lastHist.traces.length === 1, lastHist.traces.length);
const histBarTrace = lastHist.traces[0];
const anyNaNInHist = histBarTrace.y.some((v) => Number.isNaN(v));
check("Histogram bar trace has no NaN counts", !anyNaNInHist);
check("Histogram counts sum to 1024*1024 (every pixel binned)", histBarTrace.y.reduce((a, b) => a + b, 0) === 1024 * 1024, histBarTrace.y.reduce((a, b) => a + b, 0));
check("Histogram title has no 'Panel' prefix", lastHist.layout.title.text === "Intensity Histogram", lastHist.layout.title.text);
check("Histogram x-axis title is 'Calculated ADU'", lastHist.layout.xaxis.title === "Calculated ADU");
check("Histogram y-axis title is 'Pixel Count'", lastHist.layout.yaxis.title === "Pixel Count");
check("Histogram legend is hidden", lastHist.layout.showlegend === false);
check("Histogram axes are boxed (showline + mirror)", lastHist.layout.xaxis.mirror === true && lastHist.layout.yaxis.mirror === true);

// --- 4. Line profile has 1024 points, values within the reported y-range, signal-mean marker present ---
const lineCalls = plotlyCalls.filter((c) => c.divId === "line-profile-chart");
const lastLine = lineCalls[lineCalls.length - 1];
const lineTrace = lastLine.traces[0];
check("Line profile has 1024 x-values", lineTrace.x.length === 1024, lineTrace.x.length);
const [yMin, yMax] = lastLine.layout.yaxis.range;
const allWithinRange = lineTrace.y.every((v) => v >= yMin - 1e-6 && v <= yMax + 1e-6);
check("All line-profile y-values fall within the reported y-axis range", allWithinRange);
check("Line profile title is simply 'Line Plot'", lastLine.layout.title.text === "Line Plot", lastLine.layout.title.text);
check("Line profile legend is hidden", lastLine.layout.showlegend === false);
const meanShape = (lastLine.layout.shapes || [])[0];
check("Line profile has a dashed red signal-mean shape", !!meanShape && meanShape.line.color === "#e63946" && meanShape.line.dash === "dash");
const meanAnnotation = (lastLine.layout.annotations || [])[0];
check("Line profile has a moving mean-value label (one decimal place)", !!meanAnnotation && /^<b>\d+\.\d<\/b>$/.test(meanAnnotation.text), meanAnnotation && meanAnnotation.text);
check("Line profile mean label is bold", !!meanAnnotation && meanAnnotation.text.startsWith("<b>") && meanAnnotation.text.endsWith("</b>"), meanAnnotation && meanAnnotation.text);
check("Line profile mean label has a 50%-transparent white background", !!meanAnnotation && meanAnnotation.bgcolor === "rgba(255,255,255,0.5)", meanAnnotation && meanAnnotation.bgcolor);
check("Row indicator was drawn on the sensor canvas (same teal color as the line plot)",
  rowIndicatorCalls.some((c) => c.fn === "strokeStyle" && c.value === "#00838f"));

// --- 5. SNR chart: monotonic (no discontinuity), red marker present, renamed title/axis, no legend ---
const snrCalls = plotlyCalls.filter((c) => c.divId === "snr-chart");
const lastSNR = snrCalls[snrCalls.length - 1];
const snrTrace = lastSNR.traces[2]; // [0]=hi band, [1]=lo band+fill, [2]=main SNR line, [3]=marker
let decreasingPoints = 0;
for (let i = 1; i < snrTrace.y.length; i++) {
  if (snrTrace.y[i] < snrTrace.y[i - 1] - 1e-9) decreasingPoints++;
}
check("SNR curve is monotonically non-decreasing (no saturation discontinuity)", decreasingPoints === 0, decreasingPoints);
const markerTrace = lastSNR.traces.find((t) => t.marker && t.marker.color === "#e63946");
check("Red current-parameters marker present on SNR chart", !!markerTrace);
check("Red marker sits at a single point", markerTrace && markerTrace.x.length === 1);
check("SNR title is 'Signal-to-Noise'", lastSNR.layout.title.text === "Signal-to-Noise", lastSNR.layout.title.text);
check("SNR y-axis title is 'Signal-to-Noise'", lastSNR.layout.yaxis.title === "Signal-to-Noise");
check("SNR legend is hidden", lastSNR.layout.showlegend === false);

// --- 6. Noise chart has 4 data traces (shot/dark/read/total); the current-photons
//        line is a Plotly shape + text annotation, not a trace (see charts.js) ---
const noiseCalls = plotlyCalls.filter((c) => c.divId === "noise-chart");
const lastNoise = noiseCalls[noiseCalls.length - 1];
check("Noise chart has 4 traces (shot/dark/read/total)", lastNoise.traces.length === 4, lastNoise.traces.length);
check("Noise chart has a 'Current photons' text annotation (not a legend entry)",
  (lastNoise.layout.annotations || []).some((a) => a.text === "Current photons"));
check("Legend is positioned below the plot (y < 0), not overlapping the title",
  lastNoise.layout.legend.y < 0, lastNoise.layout.legend.y);
check("Noise chart title has no 'Panel'/'vs. Incident Photons' suffix", lastNoise.layout.title.text === "Noise Contributions", lastNoise.layout.title.text);
check("Noise chart legend is still shown (only chart that keeps one)", lastNoise.layout.showlegend === true);
check("Noise chart legend sits below the x-axis title (y between -0.6 and -0.3)", lastNoise.layout.legend.y <= -0.3 && lastNoise.layout.legend.y >= -0.6, lastNoise.layout.legend.y);
check("Noise chart axes are boxed too", lastNoise.layout.xaxis.mirror === true);

// --- 6b. Three-column layout structure ---
check("Params column (Box 6) present", !!window.document.querySelector(".params-column"));
check("Center column (Box 1 + info) present", !!window.document.querySelector(".center-column"));
check("Plots column (Boxes 2-5) present", !!window.document.querySelector(".plots-column"));

const stackedPanelIds = Array.from(window.document.querySelectorAll(".plots-column .panel")).map((el) => el.id);
check(
  "Stacked plots appear in order 2, 3, 4, 5",
  JSON.stringify(stackedPanelIds) === JSON.stringify(["panel-2", "panel-3", "panel-4", "panel-5"]),
  stackedPanelIds
);

check("Info text element sits under Box 1 in the center column, no overlay/button", !!window.document.querySelector(".center-column #info-text"));
check("No Info button/overlay remain in the DOM", !window.document.getElementById("info-btn") && !window.document.getElementById("info-overlay"));

// --- 7. Canvas was drawn with the correct sensor dimensions ---
const lastPutImageData = putImageDataCalls[putImageDataCalls.length - 1];
check("Canvas received a 1024x1024 image", lastPutImageData.imageData.width === 1024 && lastPutImageData.imageData.height === 1024);

// --- 8. Physics sanity: illuminated spot brighter than dark background, in the actual rendered frame ---
const pixels = lastPutImageData.imageData.data;
function pixelBrightness(idx) {
  const p = idx * 4;
  return pixels[p] + pixels[p + 1] + pixels[p + 2]; // rough brightness proxy from the false-color LUT
}
const centerIdx = 512 * 1024 + 512;
const cornerIdx = 5 * 1024 + 5;
check(
  "Illuminated-spot pixel renders brighter (false-color) than dark-background pixel",
  pixelBrightness(centerIdx) > pixelBrightness(cornerIdx),
  { center: pixelBrightness(centerIdx), corner: pixelBrightness(cornerIdx) }
);

// --- 9. Simulate a parameter change through the real slider element and confirm re-render ---
const photonsSlider = window.document.getElementById("photons-slider");
check("Photons slider control exists", !!photonsSlider);
const snrXRangeBefore = JSON.stringify(lastCallForDiv("snr-chart").layout.xaxis.range);
const noiseXRangeBefore = JSON.stringify(lastCallForDiv("noise-chart").layout.xaxis.range);
const plotlyCallCountBefore = plotlyCalls.length;
photonsSlider.value = "1000"; // near top of the internal 0-1000 log-scale range
photonsSlider.dispatchEvent(new window.Event("input"));
check("Changing the photons slider triggers new Plotly renders", plotlyCalls.length > plotlyCallCountBefore);

const snrXRangeAfter = JSON.stringify(lastCallForDiv("snr-chart").layout.xaxis.range);
const noiseXRangeAfter = JSON.stringify(lastCallForDiv("noise-chart").layout.xaxis.range);
check(
  "SNR chart x-axis range does NOT shift when only the Photons slider changes (full well/QE unchanged)",
  snrXRangeAfter === snrXRangeBefore,
  { before: snrXRangeBefore, after: snrXRangeAfter }
);
check(
  "Noise chart x-axis range does NOT shift when only the Photons slider changes (full well/QE unchanged)",
  noiseXRangeAfter === noiseXRangeBefore,
  { before: noiseXRangeBefore, after: noiseXRangeAfter }
);

function lastCallForDiv(divId) {
  const calls = plotlyCalls.filter((c) => c.divId === divId);
  return calls[calls.length - 1];
}

// --- 10. Play/Pause button toggles label and starts/stops the interval ---
const playBtn = window.document.getElementById("play-pause-btn");
check("Play button starts labeled 'Play'", playBtn.textContent === "Play", playBtn.textContent);
playBtn.dispatchEvent(new window.Event("click"));
check("Button switches to 'Pause' after clicking", playBtn.textContent === "Pause", playBtn.textContent);
playBtn.dispatchEvent(new window.Event("click"));
check("Button switches back to 'Play' after clicking again", playBtn.textContent === "Play", playBtn.textContent);

// --- 11. Box 1 export button reads "Export All"; each plot panel has its own Export button ---
const exportAllBtn = window.document.getElementById("export-btn");
check("Box 1 export button reads 'Export All'", exportAllBtn.textContent === "Export All", exportAllBtn.textContent);
for (const id of ["export-histogram-btn", "export-line-btn", "export-snr-btn", "export-noise-btn"]) {
  check(`Per-panel export button #${id} exists`, !!window.document.getElementById(id));
}

// --- 12. Reset to Default button restores every slider-backed param and re-renders ---
const resetBtn = window.document.getElementById("reset-defaults-btn");
check("Reset to Default button exists", !!resetBtn);

const gainSlider = window.document.getElementById("gain-slider");
const gainNumberBefore = gainNumberEl.value;
gainNumberEl.value = "25";
gainNumberEl.dispatchEvent(new window.Event("change"));
check("Gain changed away from default ahead of reset test", parseFloat(gainNumberEl.value) === 25, gainNumberEl.value);

photonsSlider.value = "1000";
photonsSlider.dispatchEvent(new window.Event("input"));

const plotlyCallCountBeforeReset = plotlyCalls.length;
resetBtn.dispatchEvent(new window.Event("click"));

check("Reset restores gain to 1", parseFloat(gainNumberEl.value) === 1, gainNumberEl.value);
check("Reset restores offset to 100", parseFloat(offsetNumberEl.value) === 100, offsetNumberEl.value);
check("Reset restores photons slider to default (20)", parseFloat(window.document.getElementById("photons-number").value) === 20, window.document.getElementById("photons-number").value);
check("Reset triggers new Plotly renders", plotlyCalls.length > plotlyCallCountBeforeReset);

// --- 13. App title bar shows the product name and tagline ---
check("Page title is 'PhotonBench - A Camera Simulation Tool'", window.document.title === "PhotonBench - A Camera Simulation Tool", window.document.title);
const titleEl = window.document.querySelector(".app-titlebar h1");
const subtitleEl = window.document.querySelector(".app-subtitle");
check("Title bar h1 reads 'PhotonBench'", !!titleEl && titleEl.textContent === "PhotonBench", titleEl && titleEl.textContent);
check("Title bar subtitle reads 'A Camera Simulation Tool'", !!subtitleEl && subtitleEl.textContent === "A Camera Simulation Tool", subtitleEl && subtitleEl.textContent);

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
