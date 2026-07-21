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
const downloadImageCalls = [];
window.Plotly = {
  newPlot: (divId, traces, layout, config) => {
    plotlyCalls.push({ fn: "newPlot", divId, traces, layout });
  },
  react: (divId, traces, layout, config) => {
    plotlyCalls.push({ fn: "react", divId, traces, layout });
  },
  downloadImage: (divId, opts) => {
    downloadImageCalls.push({ divId, opts });
    return Promise.resolve();
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

// --- Capture text-file Blob contents (for verifying exported CSV data) ---
const OriginalBlob = window.Blob;
let lastBlobText = null;
window.Blob = function (parts, opts) {
  lastBlobText = parts.join("");
  return new OriginalBlob(parts, opts);
};
window.URL.createObjectURL = () => "blob:fake";

// --- Stub anchor click (download machinery used by downloadTextFile/downloadCanvasPNG) ---
const originalCreateElement = window.document.createElement.bind(window.document);
window.document.createElement = function (tag) {
  const el = originalCreateElement(tag);
  if (tag === "a") {
    el.click = function () {}; // no-op; jsdom can't actually navigate/download
  }
  return el;
};

// --- Stub window.prompt (jsdom doesn't implement it) for the Compare button ---
let promptQueue = [];
window.prompt = () => (promptQueue.length ? promptQueue.shift() : null);

// --- Stub window.alert (jsdom doesn't implement it) for the trace-cap warning ---
const alertCalls = [];
window.alert = (msg) => alertCalls.push(msg);

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
check("8 camera parameter controls created (7 sliders + bit depth select)", camControls.length === 8, camControls.length);

const pixelSizeNumberEl = window.document.getElementById("pixel-size-number");
check("Pixel Size control exists with default 13", !!pixelSizeNumberEl && parseFloat(pixelSizeNumberEl.value) === 13, pixelSizeNumberEl && pixelSizeNumberEl.value);
check("Pixel Size control bounds are [1, 30]", pixelSizeNumberEl.min === "1" && pixelSizeNumberEl.max === "30");

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
check(
  "SNR curve and marker hover to one decimal place, matching the Comparison panel's hover precision",
  snrTrace.hovertemplate === "%{x:.1f}, %{y:.1f}<extra></extra>" && markerTrace.hovertemplate === "%{x:.1f}, %{y:.1f}<extra></extra>",
  { snr: snrTrace.hovertemplate, marker: markerTrace.hovertemplate }
);

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

check("Info button lives in the header, not under Box 1", !!window.document.querySelector(".app-titlebar #info-btn"));
check("Center column no longer contains an inline info panel", !window.document.querySelector(".center-column #info-text") && !window.document.querySelector(".info-panel"));

// --- Camera Sensitivity Comparison panel: repurposed old info-text space ---
const comparisonPanel = window.document.querySelector(".center-column #panel-comparison");
check("Camera Sensitivity Comparison panel exists below Box 1 in the center column", !!comparisonPanel);
const comparisonTitle = comparisonPanel && comparisonPanel.querySelector(".panel-header h2");
check("Comparison panel title reads 'Camera Sensitivity Comparison'", !!comparisonTitle && comparisonTitle.textContent === "Camera Sensitivity Comparison", comparisonTitle && comparisonTitle.textContent);
const comparisonBody = comparisonPanel && comparisonPanel.querySelector(".panel-body");
check("Comparison panel body contains the two plot divs and the legend", !!comparisonBody
  && !!comparisonBody.querySelector("#comparison-plot-1")
  && !!comparisonBody.querySelector("#comparison-plot-2")
  && !!comparisonBody.querySelector("#comparison-legend"));

// --- Info overlay: hidden by default, opens on click, closes 3 ways ---
const infoBtn = window.document.getElementById("info-btn");
const infoOverlay = window.document.getElementById("info-overlay");
const infoModalContent = window.document.getElementById("info-modal-content");
const infoCloseBtn = window.document.getElementById("info-close-btn");
check("Info overlay exists and starts hidden", !!infoOverlay && infoOverlay.hidden === true);

infoBtn.dispatchEvent(new window.Event("click"));
check("Info overlay opens (unhidden) after clicking the Info button", infoOverlay.hidden === false);
// Note: Info overlay content itself is populated async (Info.loadInfoText()
// resolves via a microtask), and this test file runs fully synchronously
// without flushing microtasks - e2e_test2.js already covers the resolved
// content under an `await`, so this file only checks the open/close
// mechanics rather than re-asserting on content timing.

infoCloseBtn.dispatchEvent(new window.Event("click"));
check("Info overlay closes via its close (X) button", infoOverlay.hidden === true);

infoBtn.dispatchEvent(new window.Event("click"));
infoOverlay.dispatchEvent(new window.Event("click")); // clicking the backdrop itself (event.target === overlay)
check("Info overlay closes via a backdrop click", infoOverlay.hidden === true);

infoBtn.dispatchEvent(new window.Event("click"));
window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
check("Info overlay closes via the Escape key", infoOverlay.hidden === true);

infoBtn.dispatchEvent(new window.Event("click"));
const infoModalBox = window.document.querySelector(".info-modal");
infoModalBox.dispatchEvent(new window.Event("click", { bubbles: true })); // click inside the modal box itself, not the backdrop
check("Clicking inside the modal box (not the backdrop) does NOT close the overlay", infoOverlay.hidden === false);
infoOverlay.hidden = true; // leave state clean for any later checks

// --- Comparison panel Info overlay: explains the Normalized SNR plot ---
const comparisonInfoBtn = window.document.getElementById("comparison-info-btn");
const comparisonInfoOverlay = window.document.getElementById("comparison-info-overlay");
const comparisonInfoModalContent = window.document.getElementById("comparison-info-modal-content");
const comparisonInfoCloseBtn = window.document.getElementById("comparison-info-close-btn");
check("Comparison panel Info button exists in its header", !!comparisonInfoBtn);
check("Comparison Info overlay exists and starts hidden", !!comparisonInfoOverlay && comparisonInfoOverlay.hidden === true);
check(
  "Comparison Info overlay content mentions Normalized SNR and pixel surface area",
  comparisonInfoModalContent.textContent.includes("Normalized SNR") && comparisonInfoModalContent.textContent.includes("surface area")
);

comparisonInfoBtn.dispatchEvent(new window.Event("click"));
check("Comparison Info overlay opens after clicking its Info button", comparisonInfoOverlay.hidden === false);

comparisonInfoCloseBtn.dispatchEvent(new window.Event("click"));
check("Comparison Info overlay closes via its close (X) button", comparisonInfoOverlay.hidden === true);

comparisonInfoBtn.dispatchEvent(new window.Event("click"));
comparisonInfoOverlay.dispatchEvent(new window.Event("click")); // backdrop click
check("Comparison Info overlay closes via a backdrop click", comparisonInfoOverlay.hidden === true);

comparisonInfoBtn.dispatchEvent(new window.Event("click"));
window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
check("Comparison Info overlay closes via the Escape key", comparisonInfoOverlay.hidden === true);

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

pixelSizeNumberEl.value = "5.5";
pixelSizeNumberEl.dispatchEvent(new window.Event("change"));
check("Pixel Size changed away from default ahead of reset test", parseFloat(pixelSizeNumberEl.value) === 5.5, pixelSizeNumberEl.value);

photonsSlider.value = "1000";
photonsSlider.dispatchEvent(new window.Event("input"));

const plotlyCallCountBeforeReset = plotlyCalls.length;
resetBtn.dispatchEvent(new window.Event("click"));

check("Reset restores gain to 1", parseFloat(gainNumberEl.value) === 1, gainNumberEl.value);
check("Reset restores offset to 100", parseFloat(offsetNumberEl.value) === 100, offsetNumberEl.value);
check("Reset restores pixel size to 13", parseFloat(pixelSizeNumberEl.value) === 13, pixelSizeNumberEl.value);
check("Reset restores photons slider to default (20)", parseFloat(window.document.getElementById("photons-number").value) === 20, window.document.getElementById("photons-number").value);
check("Reset triggers new Plotly renders", plotlyCalls.length > plotlyCallCountBeforeReset);

// --- 13. App title bar shows the product name and tagline ---
check("Page title is 'PhotonBench - A Camera Simulation Tool'", window.document.title === "PhotonBench - A Camera Simulation Tool", window.document.title);
const titleEl = window.document.querySelector(".app-titlebar h1");
const subtitleEl = window.document.querySelector(".app-subtitle");
check("Title bar h1 reads 'PhotonBench'", !!titleEl && titleEl.textContent === "PhotonBench", titleEl && titleEl.textContent);
check("Title bar subtitle reads 'A Camera Simulation Tool'", !!subtitleEl && subtitleEl.textContent === "A Camera Simulation Tool", subtitleEl && subtitleEl.textContent);

const versionEl = window.document.querySelector(".app-version");
check("Title bar shows a version identifier next to the subtitle", !!versionEl && /^v\d+\.\d+\.\d+$/.test(versionEl.textContent), versionEl && versionEl.textContent);

// --- 14. Sensor width/height inputs: defaults, live resize, and clamping ---
const sensorWidthInput = window.document.getElementById("sensor-width-input");
const sensorHeightInput = window.document.getElementById("sensor-height-input");
check("Sensor width input exists with default 1024", !!sensorWidthInput && parseFloat(sensorWidthInput.value) === 1024, sensorWidthInput && sensorWidthInput.value);
check("Sensor height input exists with default 1024", !!sensorHeightInput && parseFloat(sensorHeightInput.value) === 1024, sensorHeightInput && sensorHeightInput.value);
check("Sensor width input bounds are [1024, 5000]", sensorWidthInput.min === "1024" && sensorWidthInput.max === "5000");
check("Sensor height input bounds are [1, 5000]", sensorHeightInput.min === "1" && sensorHeightInput.max === "5000");

// Resize to a non-square sensor and confirm the canvas pixel buffer follows.
sensorWidthInput.value = "2000";
sensorHeightInput.value = "500";
sensorWidthInput.dispatchEvent(new window.Event("change"));
sensorHeightInput.dispatchEvent(new window.Event("change"));

const resizedPutImageData = putImageDataCalls[putImageDataCalls.length - 1];
check(
  "Canvas pixel buffer follows a non-square resize (2000x500)",
  resizedPutImageData.imageData.width === 2000 && resizedPutImageData.imageData.height === 500,
  { width: resizedPutImageData.imageData.width, height: resizedPutImageData.imageData.height }
);

const resizedHistTrace = lastCallForDiv("histogram-chart").traces[0];
check(
  "Histogram after resize is still binned over the full new pixel count (2000*500)",
  resizedHistTrace.y.reduce((a, b) => a + b, 0) === 2000 * 500,
  resizedHistTrace.y.reduce((a, b) => a + b, 0)
);

// Out-of-range values should clamp back into bounds, not pass through raw.
sensorWidthInput.value = "500"; // below the 1024 minimum
sensorHeightInput.value = "999999"; // above the 5000 maximum
sensorWidthInput.dispatchEvent(new window.Event("change"));
sensorHeightInput.dispatchEvent(new window.Event("change"));
check("Sensor width below minimum clamps to 1024", parseFloat(sensorWidthInput.value) === 1024, sensorWidthInput.value);
check("Sensor height above maximum clamps to 5000", parseFloat(sensorHeightInput.value) === 5000, sensorHeightInput.value);

const clampedPutImageData = putImageDataCalls[putImageDataCalls.length - 1];
check(
  "Canvas reflects the clamped dimensions (1024x5000), not the raw out-of-range input",
  clampedPutImageData.imageData.width === 1024 && clampedPutImageData.imageData.height === 5000,
  { width: clampedPutImageData.imageData.width, height: clampedPutImageData.imageData.height }
);

// A height of 0 (below the new minimum of 1) should clamp up to 1, and a
// height of exactly 1 (line-scan sensor) should render without error.
sensorWidthInput.value = "1024";
sensorHeightInput.value = "0";
sensorWidthInput.dispatchEvent(new window.Event("change"));
sensorHeightInput.dispatchEvent(new window.Event("change"));
check("Sensor height of 0 clamps up to the new minimum of 1", parseFloat(sensorHeightInput.value) === 1, sensorHeightInput.value);

const lineScanPutImageData = putImageDataCalls[putImageDataCalls.length - 1];
check(
  "Line-scan sensor (height=1) renders a valid 1024x1 frame",
  lineScanPutImageData.imageData.width === 1024 && lineScanPutImageData.imageData.height === 1,
  { width: lineScanPutImageData.imageData.width, height: lineScanPutImageData.imageData.height }
);

const lineScanHistTrace = lastCallForDiv("histogram-chart").traces[0];
check(
  "Line-scan sensor histogram bins the full 1024x1 pixel count with no NaN",
  lineScanHistTrace.y.reduce((a, b) => a + b, 0) === 1024 * 1 && !lineScanHistTrace.y.some((v) => Number.isNaN(v)),
  lineScanHistTrace.y.reduce((a, b) => a + b, 0)
);

// --- 15. Reset to Default also restores the sensor array size to 1024x1024 ---
sensorWidthInput.value = "3000";
sensorHeightInput.value = "4000";
sensorWidthInput.dispatchEvent(new window.Event("change"));
sensorHeightInput.dispatchEvent(new window.Event("change"));

resetBtn.dispatchEvent(new window.Event("click"));

check("Reset restores sensor width input to 1024", parseFloat(sensorWidthInput.value) === 1024, sensorWidthInput.value);
check("Reset restores sensor height input to 1024", parseFloat(sensorHeightInput.value) === 1024, sensorHeightInput.value);

const postResetPutImageData = putImageDataCalls[putImageDataCalls.length - 1];
check(
  "Canvas reflects the 1024x1024 array size after Reset to Default",
  postResetPutImageData.imageData.width === 1024 && postResetPutImageData.imageData.height === 1024,
  { width: postResetPutImageData.imageData.width, height: postResetPutImageData.imageData.height }
);

// --- 16. SNR panel reverted to single-mode display; new "Compare" placeholder ---
check("SNR mode toggle buttons no longer exist (feature reverted)",
  !window.document.getElementById("snr-mode-per-pixel-btn") && !window.document.getElementById("snr-mode-normalized-btn"));

const compareBtn = window.document.getElementById("compare-btn");
check("Compare button exists in the SNR panel header", !!compareBtn);
check("Compare button reads 'Compare'", compareBtn && compareBtn.textContent === "Compare", compareBtn && compareBtn.textContent);

check(
  "SNR chart x-axis title is 'Incident Photons / Pixel'",
  lastCallForDiv("snr-chart").layout.xaxis.title === "Incident Photons / Pixel",
  lastCallForDiv("snr-chart").layout.xaxis.title
);

// Pixel size no longer affects the SNR panel's own curve (normalization is
// deferred to a future "store for comparison" step, not applied live here).
const pixelSizeNumberElForSNR = window.document.getElementById("pixel-size-number");
const snrTraceBeforePixelChange = lastCallForDiv("snr-chart").traces[2].y.slice();
pixelSizeNumberElForSNR.value = "26";
pixelSizeNumberElForSNR.dispatchEvent(new window.Event("change"));
const snrTraceAfterPixelChange = lastCallForDiv("snr-chart").traces[2].y;
check(
  "Changing Pixel Size does NOT change the SNR panel's curve",
  snrTraceAfterPixelChange.every((v, i) => Math.abs(v - snrTraceBeforePixelChange[i]) < 1e-9)
);
pixelSizeNumberElForSNR.value = "13";
pixelSizeNumberElForSNR.dispatchEvent(new window.Event("change"));

// --- 17. Camera Sensitivity Comparison panel: Compare button + two plots + legend ---
check("Comparison plot 1 exists and Plotly was called for it", divsCalled.has("comparison-plot-1") || plotlyCalls.some((c) => c.divId === "comparison-plot-1"));
check("Comparison plot 2 exists and Plotly was called for it", plotlyCalls.some((c) => c.divId === "comparison-plot-2"));

const legendEl = window.document.getElementById("comparison-legend");
check("Legend shows an empty-state message before any trace is saved", legendEl.textContent.includes("No saved traces"), legendEl.textContent);

// Set pixel size to something other than 13 so normalization actually does something,
// then save a trace named "Camera A" via the (stubbed) prompt.
pixelSizeNumberEl.value = "26"; // ratio = 26^2/13^2 = 4
pixelSizeNumberEl.dispatchEvent(new window.Event("change"));
const rawSnrAtSave = lastCallForDiv("snr-chart").traces[2].y.slice();

promptQueue.push("Camera A");
compareBtn.dispatchEvent(new window.Event("click"));

const plot1CallA = lastCallForDiv("comparison-plot-1");
const plot2CallA = lastCallForDiv("comparison-plot-2");
check("Comparison plot 1 has exactly 1 trace after saving one camera", plot1CallA.traces.length === 1, plot1CallA.traces.length);
check("Comparison plot 2 has exactly 1 trace after saving one camera", plot2CallA.traces.length === 1, plot2CallA.traces.length);
check("Saved trace name is 'Camera A' on both plots", plot1CallA.traces[0].name === "Camera A" && plot2CallA.traces[0].name === "Camera A");
check("Plot 1 (raw) trace matches the SNR panel's curve at save time", plot1CallA.traces[0].y.every((v, i) => Math.abs(v - rawSnrAtSave[i]) < 1e-9));
check(
  "Plot 2 (normalized) trace equals plot 1's trace times (pixelSize^2/13^2) = 4",
  plot2CallA.traces[0].y.every((v, i) => Math.abs(v - plot1CallA.traces[0].y[i] * 4) < 1e-6)
);
check("Plot 1 title is 'Signal-to-Noise'", plot1CallA.layout.title.text === "Signal-to-Noise", plot1CallA.layout.title.text);
check("Plot 2 title is 'Normalized SNR'", plot2CallA.layout.title.text === "Normalized SNR", plot2CallA.layout.title.text);
check("Plot 1 x-axis title is 'Photons / Pixel'", plot1CallA.layout.xaxis.title === "Photons / Pixel", plot1CallA.layout.xaxis.title);
check("Plot 2 x-axis title is 'Photons / 13 µm Pixel'", plot2CallA.layout.xaxis.title === "Photons / 13 µm Pixel", plot2CallA.layout.xaxis.title);
check("Both plots have no legend of their own (custom legend lives in the side panel instead)", plot1CallA.layout.showlegend === false && plot2CallA.layout.showlegend === false);
check(
  "Trace hovertemplate shows the trace name and rounds x/y to one decimal place",
  plot1CallA.traces[0].hovertemplate === "%{x:.1f}, %{y:.1f}<br>%{fullData.name}<extra></extra>"
    && plot2CallA.traces[0].hovertemplate === "%{x:.1f}, %{y:.1f}<br>%{fullData.name}<extra></extra>",
  plot1CallA.traces[0].hovertemplate
);

const legendItemsAfterA = legendEl.querySelectorAll(".comparison-legend-item");
check("Legend shows exactly 1 entry after saving one trace", legendItemsAfterA.length === 1, legendItemsAfterA.length);
check("Legend entry shows the trace name", legendItemsAfterA[0].querySelector(".comparison-legend-name").textContent === "Camera A");
const swatchA = legendItemsAfterA[0].querySelector(".comparison-legend-swatch");
check("Legend entry has a non-empty swatch color set", !!swatchA && swatchA.style.backgroundColor !== "", swatchA && swatchA.style.backgroundColor);

// Save a second trace at a different pixel size and confirm both are distinct colors and both plots grow to 2 traces.
pixelSizeNumberEl.value = "6.5"; // ratio = 6.5^2/13^2 = 0.25
pixelSizeNumberEl.dispatchEvent(new window.Event("change"));
promptQueue.push("Camera B");
compareBtn.dispatchEvent(new window.Event("click"));

const plot1CallB = lastCallForDiv("comparison-plot-1");
const plot2CallB = lastCallForDiv("comparison-plot-2");
check("Comparison plot 1 has 2 traces after saving a second camera", plot1CallB.traces.length === 2, plot1CallB.traces.length);
check("Comparison plot 2 has 2 traces after saving a second camera", plot2CallB.traces.length === 2, plot2CallB.traces.length);
check(
  "The two saved traces use different colors",
  plot1CallB.traces[0].line.color !== plot1CallB.traces[1].line.color,
  [plot1CallB.traces[0].line.color, plot1CallB.traces[1].line.color]
);
check(
  "Trace color for a given camera is identical on plot 1 and plot 2",
  plot1CallB.traces[0].line.color === plot2CallB.traces[0].line.color && plot1CallB.traces[1].line.color === plot2CallB.traces[1].line.color
);

const legendItemsAfterB = legendEl.querySelectorAll(".comparison-legend-item");
check("Legend shows exactly 2 entries after saving two traces", legendItemsAfterB.length === 2, legendItemsAfterB.length);

// Cancelling the prompt (returns null) should not add a trace.
promptQueue.push(null);
compareBtn.dispatchEvent(new window.Event("click"));
check("Cancelling the name prompt does not add a trace", lastCallForDiv("comparison-plot-1").traces.length === 2);

// Deleting via the legend's "x" button removes that trace from both plots and the legend.
const deleteBtnForA = Array.from(legendEl.querySelectorAll(".comparison-legend-item"))
  .find((item) => item.querySelector(".comparison-legend-name").textContent === "Camera A")
  .querySelector(".comparison-legend-delete");
check("Delete ('x') button exists on a legend entry", !!deleteBtnForA);
deleteBtnForA.dispatchEvent(new window.Event("click"));

const plot1CallAfterDelete = lastCallForDiv("comparison-plot-1");
check("Deleting 'Camera A' leaves exactly 1 trace on plot 1", plot1CallAfterDelete.traces.length === 1, plot1CallAfterDelete.traces.length);
check("The remaining trace is 'Camera B'", plot1CallAfterDelete.traces[0].name === "Camera B", plot1CallAfterDelete.traces[0].name);
const legendItemsAfterDelete = legendEl.querySelectorAll(".comparison-legend-item");
check("Legend shows exactly 1 entry after deleting one trace", legendItemsAfterDelete.length === 1, legendItemsAfterDelete.length);

// Delete the last remaining trace and confirm the empty-state message comes back.
const deleteBtnForB = legendEl.querySelector(".comparison-legend-delete");
deleteBtnForB.dispatchEvent(new window.Event("click"));
check("Comparison plot 1 has 0 traces after deleting the last one", lastCallForDiv("comparison-plot-1").traces.length === 0);
check("Legend empty-state message returns after deleting all traces", legendEl.textContent.includes("No saved traces"), legendEl.textContent);

// --- Cap of 5 traces on the comparison panel ---
for (const camName of ["Cam 1", "Cam 2", "Cam 3", "Cam 4", "Cam 5"]) {
  promptQueue.push(camName);
  compareBtn.dispatchEvent(new window.Event("click"));
}
check("5 traces can be saved with no cap warning", lastCallForDiv("comparison-plot-1").traces.length === 5 && alertCalls.length === 0, {
  traceCount: lastCallForDiv("comparison-plot-1").traces.length,
  alerts: alertCalls.length,
});

alertCalls.length = 0;
promptQueue.push("Cam 6"); // should never be consumed - the cap check should short-circuit before the prompt
compareBtn.dispatchEvent(new window.Event("click"));
check("A 6th Compare click is blocked: still exactly 5 traces", lastCallForDiv("comparison-plot-1").traces.length === 5, lastCallForDiv("comparison-plot-1").traces.length);
check("A 6th Compare click shows the cap warning", alertCalls.length === 1, alertCalls);
check("Blocking the 6th click leaves the name prompt unused", promptQueue.length === 1, promptQueue);
promptQueue.length = 0; // clean up the unused queued name

// Deleting one frees a slot back up under the cap.
const firstDeleteBtn = legendEl.querySelector(".comparison-legend-delete");
firstDeleteBtn.dispatchEvent(new window.Event("click"));
check("Deleting a trace drops the count below the cap", lastCallForDiv("comparison-plot-1").traces.length === 4);

alertCalls.length = 0;
promptQueue.push("Cam 7");
compareBtn.dispatchEvent(new window.Event("click"));
check("Adding a trace after freeing a slot succeeds (back to 5, no warning)",
  lastCallForDiv("comparison-plot-1").traces.length === 5 && alertCalls.length === 0,
  { traceCount: lastCallForDiv("comparison-plot-1").traces.length, alerts: alertCalls.length });

// Clean the panel back to empty for a tidy end state.
while (window.document.querySelectorAll("#comparison-legend .comparison-legend-delete").length > 0) {
  window.document.querySelector("#comparison-legend .comparison-legend-delete").dispatchEvent(new window.Event("click"));
}
check("Comparison panel is empty again after cleanup", lastCallForDiv("comparison-plot-1").traces.length === 0);

pixelSizeNumberEl.value = "13"; // restore default for cleanliness
pixelSizeNumberEl.dispatchEvent(new window.Event("change"));

// --- SNR panel export: one text file with both the raw and pixel-size-normalized SNR curves ---
pixelSizeNumberEl.value = "26"; // ratio = 26^2/13^2 = 4, so the two columns are clearly distinct
pixelSizeNumberEl.dispatchEvent(new window.Event("change"));

lastBlobText = null;
window.document.getElementById("export-snr-btn").dispatchEvent(new window.Event("click"));

check("SNR export produced a text file", lastBlobText !== null);
const snrCsvLines = (lastBlobText || "").trim().split("\n");
const snrCsvHeaderRow = snrCsvLines.find((l) => l.startsWith("IncidentPhotons,"));
check(
  "SNR export CSV has 3 columns: IncidentPhotons, SNR, NormalizedSNR_13umPixel",
  snrCsvHeaderRow === "IncidentPhotons,SNR,NormalizedSNR_13umPixel",
  snrCsvHeaderRow
);

const snrCsvDataRows = snrCsvLines.slice(snrCsvLines.indexOf(snrCsvHeaderRow) + 1);
const parsedRows = snrCsvDataRows.map((line) => line.split(",").map(Number));
const ratiosMatch = parsedRows.every(([photons, snr, normalizedSnr]) => Math.abs(normalizedSnr - snr * 4) < 1e-6);
check("Every row's NormalizedSNR_13umPixel column equals SNR * (pixelSize^2/13^2) = 4", ratiosMatch);

pixelSizeNumberEl.value = "13"; // restore default for cleanliness
pixelSizeNumberEl.dispatchEvent(new window.Event("change"));

// --- 18. Trace legend collapse/expand toggle ---
const legendWrap = window.document.getElementById("comparison-legend-wrap");
const legendToggle = window.document.getElementById("comparison-legend-toggle");
check("Legend toggle button exists", !!legendToggle);
check("Legend wrap starts expanded (not collapsed)", !legendWrap.classList.contains("is-collapsed"));

legendToggle.dispatchEvent(new window.Event("click"));
check("Clicking the toggle collapses the legend wrap", legendWrap.classList.contains("is-collapsed"));

legendToggle.dispatchEvent(new window.Event("click"));
check("Clicking the toggle again re-expands the legend wrap", !legendWrap.classList.contains("is-collapsed"));

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
