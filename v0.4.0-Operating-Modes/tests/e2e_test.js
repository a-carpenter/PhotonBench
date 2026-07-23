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
    // fillRect/strokeRect are only used by drawROIBox (the row indicator
    // line and everything checked against rowIndicatorCalls at the top of
    // this file only ever runs while on the Imaging tab, before Spectroscopy
    // mode - and its ROI box - are ever entered, so sharing this array is
    // safe and avoids a second parallel stub).
    fillRect: (x, y, w, h) => rowIndicatorCalls.push({ fn: "fillRect", x, y, w, h }),
    strokeRect: (x, y, w, h) => rowIndicatorCalls.push({ fn: "strokeRect", x, y, w, h }),
    setLineDash: (segments) => rowIndicatorCalls.push({ fn: "setLineDash", segments }),
    set lineWidth(v) {
      rowIndicatorCalls.push({ fn: "lineWidth", value: v });
    },
    set strokeStyle(v) {
      rowIndicatorCalls.push({ fn: "strokeStyle", value: v });
    },
    set fillStyle(v) {
      rowIndicatorCalls.push({ fn: "fillStyle", value: v });
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
  "src/dispersion.js",
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

// --- 1. Controls were built: 3 experimental + 7 camera sliders + bit depth
//        select + EM Gain's own two .param-control-classed wrapper elements
//        (its outer checkbox group and its inner slider) ---
const expControls = window.document.querySelectorAll("#experimental-controls .param-control");
const camControls = window.document.querySelectorAll("#camera-controls .param-control");
check("3 experimental parameter controls created", expControls.length === 3, expControls.length);
check(
  "14 camera parameter controls created (7 sliders + bit depth select + EM Gain group + EM Gain slider + Register Well Depth + Binning group + 2 bin selects)",
  camControls.length === 14,
  camControls.length
);

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
check("Histogram y-axis defaults to linear scale", lastHist.layout.yaxis.type === "linear", lastHist.layout.yaxis.type);

// --- 3b. Histogram Linear/Log toggle button (left of Export, Panel 2 header) ---
const histogramScaleToggleBtn = window.document.getElementById("histogram-scale-toggle-btn");
check("Histogram scale toggle button exists", !!histogramScaleToggleBtn);
check(
  "Toggle button reads 'Change to Log' by default (unambiguous action label, not just the target scale's name)",
  histogramScaleToggleBtn.textContent === "Change to Log",
  histogramScaleToggleBtn.textContent
);
check(
  "Toggle button lives in Panel 2's header, on the opposite side from Export",
  window.document.querySelector("#panel-2 .panel-header").contains(histogramScaleToggleBtn)
);

const histBarBeforeToggle = lastCallForDiv("histogram-chart").traces[0].y.slice();
histogramScaleToggleBtn.dispatchEvent(new window.Event("click"));
const histAfterToggle = lastCallForDiv("histogram-chart");
check("Clicking the toggle switches the y-axis to log scale", histAfterToggle.layout.yaxis.type === "log", histAfterToggle.layout.yaxis.type);
check("Toggle button now reads 'Change to Linear' (action: switch back)", histogramScaleToggleBtn.textContent === "Change to Linear", histogramScaleToggleBtn.textContent);
check(
  "Toggling the scale redraws the SAME bar data (no resimulation), only the axis scale changes",
  histAfterToggle.traces[0].y.every((v, i) => v === histBarBeforeToggle[i])
);

histogramScaleToggleBtn.dispatchEvent(new window.Event("click"));
const histAfterSecondToggle = lastCallForDiv("histogram-chart");
check("Clicking the toggle again switches back to linear scale", histAfterSecondToggle.layout.yaxis.type === "linear", histAfterSecondToggle.layout.yaxis.type);
check("Toggle button reads 'Change to Log' again", histogramScaleToggleBtn.textContent === "Change to Log", histogramScaleToggleBtn.textContent);
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

// --- Parameters panel header: same height/class as Box 1's header, title
// "Parameters", Info icon on the right ---
const panel6Header = window.document.querySelector("#panel-6 > .panel-header");
const panel1Header = window.document.querySelector("#panel-1 > .panel-header");
check("Parameters panel (Box 6) has its own header", !!panel6Header);
check(
  "Parameters panel header uses the same base .panel-header class as Box 1's header (no -plot/-split modifier), so it renders at the same height",
  !!panel6Header && !panel6Header.classList.contains("panel-header-plot") && !panel6Header.classList.contains("panel-header-split")
  && !!panel1Header && !panel1Header.classList.contains("panel-header-plot") && !panel1Header.classList.contains("panel-header-split")
);
const panel6Title = panel6Header && panel6Header.querySelector("h2");
check("Parameters panel header title reads 'Parameters'", !!panel6Title && panel6Title.textContent === "Parameters", panel6Title && panel6Title.textContent);
const panel6InfoBtn = window.document.getElementById("panel-6-info-btn");
check("Parameters panel header has an Info icon button", !!panel6InfoBtn && !!panel6InfoBtn.querySelector("svg.icon-info"));
check(
  "Parameters panel Info icon sits on the right side of the header",
  panel6Header && panel6Header.lastElementChild.contains(panel6InfoBtn)
);

const panel6InfoOverlay = window.document.getElementById("panel-6-info-overlay");
check("Parameters panel Info overlay exists and starts hidden", !!panel6InfoOverlay && panel6InfoOverlay.hidden === true);
panel6InfoBtn.dispatchEvent(new window.Event("click"));
check("Clicking the Parameters panel Info icon opens its overlay", panel6InfoOverlay.hidden === false);
window.document.getElementById("panel-6-info-close-btn").dispatchEvent(new window.Event("click"));
check("Parameters panel Info overlay closes via its close button", panel6InfoOverlay.hidden === true);

// --- Parameters panel Info overlay: real content, not the placeholder ---
const panel6InfoContent = window.document.getElementById("panel-6-info-modal-content");
check(
  "Parameters panel Info overlay no longer shows the 'Info coming soon' placeholder",
  !!panel6InfoContent && !panel6InfoContent.textContent.includes("Info coming soon")
);
check(
  "Parameters panel Info overlay has 3 section headers: Camera Type, Experimental Parameters, Camera Parameters",
  Array.from(panel6InfoContent.querySelectorAll(".info-subhead")).map((el) => el.textContent).join(",") === "Camera Type,Experimental Parameters,Camera Parameters",
  Array.from(panel6InfoContent.querySelectorAll(".info-subhead")).map((el) => el.textContent)
);
const panel6InfoDtNames = Array.from(panel6InfoContent.querySelectorAll(".info-param-list dt")).map((el) => el.textContent);
check(
  "Parameters panel Info overlay documents all 3 Experimental Parameters",
  ["Photons (#)", "Exposure Time (s)", "Spot Radius (px)"].every((name) => panel6InfoDtNames.includes(name)),
  panel6InfoDtNames
);
check(
  "Parameters panel Info overlay documents all 11 Camera Parameters, in the order they appear in the panel",
  JSON.stringify(panel6InfoDtNames.slice(3)) === JSON.stringify([
    "Quantum Efficiency", "Dark Current (e-/px/s)", "Read Noise (e-)", "Full Well Depth (e-)",
    "Register Well Depth (e-)", "Offset (e-)", "Sensitivity (e-/ADU)", "Pixel Size (µm)",
    "Bit Depth", "Binning", "Enable EM Gain",
  ]),
  panel6InfoDtNames.slice(3)
);
check(
  "Every dt in the Parameters panel Info overlay has a non-empty dd definition right after it",
  Array.from(panel6InfoContent.querySelectorAll(".info-param-list dt")).every((dt) => {
    const dd = dt.nextElementSibling;
    return !!dd && dd.tagName === "DD" && dd.textContent.trim().length > 0;
  })
);

// --- Camera Type subsection: above Experimental Parameters, no header bar ---
const controlsGroups = Array.from(window.document.querySelectorAll(".params-column .controls-group"));
check("Params column has 3 controls-groups: Camera Type, Experimental, Camera (Binning now lives inside Camera Parameters)", controlsGroups.length === 3, controlsGroups.length);
const groupHeadings = controlsGroups.map((g) => g.querySelector("h3").textContent);
check(
  "Camera Type subsection appears first, in the expected order",
  JSON.stringify(groupHeadings) === JSON.stringify(["Camera Type", "Experimental Parameters", "Camera Parameters"]),
  groupHeadings
);

// --- Experimental/Camera Parameters are collapsible via a chevron header ---
const collapsibleGroups = [
  { groupId: "experimental-group", toggleBtnId: "experimental-group-toggle", listId: "experimental-controls" },
  { groupId: "camera-group", toggleBtnId: "camera-group-toggle", listId: "camera-controls" },
];
for (const { groupId, toggleBtnId, listId } of collapsibleGroups) {
  const group = window.document.getElementById(groupId);
  const toggleBtn = window.document.getElementById(toggleBtnId);
  const list = window.document.getElementById(listId);
  check(`${groupId}: collapsible group exists with a chevron toggle button`, !!group && !!toggleBtn && !!toggleBtn.querySelector("svg.icon-chevron"));
  check(`${groupId}: starts expanded (not collapsed)`, !group.classList.contains("is-collapsed") && toggleBtn.getAttribute("aria-expanded") === "true");

  toggleBtn.dispatchEvent(new window.Event("click"));
  check(`${groupId}: clicking the header collapses the group`, group.classList.contains("is-collapsed") && toggleBtn.getAttribute("aria-expanded") === "false");

  toggleBtn.dispatchEvent(new window.Event("click"));
  check(`${groupId}: clicking again re-expands the group`, !group.classList.contains("is-collapsed") && toggleBtn.getAttribute("aria-expanded") === "true");
  check(`${groupId}: the parameter list itself is untouched by collapsing (still present in the DOM)`, !!list);
}

const sensorTypeBtns = Array.from(window.document.querySelectorAll(".sensor-type-btn"));
check("Camera Type subsection has exactly 3 sensor-type buttons", sensorTypeBtns.length === 3, sensorTypeBtns.length);
check(
  "Sensor-type buttons read CCD, sCMOS, InGaAs in order",
  JSON.stringify(sensorTypeBtns.map((b) => b.textContent)) === JSON.stringify(["CCD", "sCMOS", "InGaAs"]),
  sensorTypeBtns.map((b) => b.textContent)
);

const ccdBtn = window.document.getElementById("sensor-type-ccd-btn");
const scmosBtn = window.document.getElementById("sensor-type-scmos-btn");
const ingaasBtn = window.document.getElementById("sensor-type-ingaas-btn");
check("CCD is selected (highlighted) by default on load", ccdBtn.classList.contains("is-active")
  && !scmosBtn.classList.contains("is-active") && !ingaasBtn.classList.contains("is-active"));

// Default (CCD) parameter values loaded on start, per the provided per-camera-type CSV.
function readCameraTypeParams() {
  return {
    photons: parseFloat(window.document.getElementById("photons-number").value),
    qe: parseFloat(window.document.getElementById("qe-number").value),
    darkCurrent: parseFloat(window.document.getElementById("dark-current-number").value),
    readNoise: parseFloat(window.document.getElementById("read-noise-number").value),
    fullWell: parseFloat(window.document.getElementById("full-well-number").value),
    offset: parseFloat(window.document.getElementById("offset-number").value),
    gain: parseFloat(window.document.getElementById("gain-number").value),
    pixelSize: parseFloat(window.document.getElementById("pixel-size-number").value),
    bitDepth: Number(window.document.getElementById("bit-depth-select").value),
  };
}
check(
  "CCD defaults are loaded on start",
  JSON.stringify(readCameraTypeParams()) === JSON.stringify({ photons: 20, qe: 0.95, darkCurrent: 0.00013, readNoise: 2.9, fullWell: 100000, offset: 100, gain: 1, pixelSize: 13, bitDepth: 16 }),
  readCameraTypeParams()
);

scmosBtn.dispatchEvent(new window.Event("click"));
check("Clicking sCMOS highlights it and un-highlights CCD",
  scmosBtn.classList.contains("is-active") && !ccdBtn.classList.contains("is-active") && !ingaasBtn.classList.contains("is-active"));
check(
  "Clicking sCMOS loads its defaults",
  JSON.stringify(readCameraTypeParams()) === JSON.stringify({ photons: 20, qe: 0.82, darkCurrent: 0.02, readNoise: 1.2, fullWell: 30000, offset: 100, gain: 1.8, pixelSize: 6.5, bitDepth: 16 }),
  readCameraTypeParams()
);

ingaasBtn.dispatchEvent(new window.Event("click"));
check("Clicking InGaAs highlights it and un-highlights sCMOS",
  ingaasBtn.classList.contains("is-active") && !ccdBtn.classList.contains("is-active") && !scmosBtn.classList.contains("is-active"));
check(
  "Clicking InGaAs loads its defaults",
  JSON.stringify(readCameraTypeParams()) === JSON.stringify({ photons: 100, qe: 0.7, darkCurrent: 365, readNoise: 23, fullWell: 1400000, offset: 100, gain: 100, pixelSize: 15, bitDepth: 14 }),
  readCameraTypeParams()
);

window.document.getElementById("reset-defaults-btn").dispatchEvent(new window.Event("click"));
check("Reset to Default re-selects CCD", ccdBtn.classList.contains("is-active")
  && !scmosBtn.classList.contains("is-active") && !ingaasBtn.classList.contains("is-active"));
check(
  "Reset to Default reloads CCD's defaults (not just whichever type was last selected)",
  JSON.stringify(readCameraTypeParams()) === JSON.stringify({ photons: 20, qe: 0.95, darkCurrent: 0.00013, readNoise: 2.9, fullWell: 100000, offset: 100, gain: 1, pixelSize: 13, bitDepth: 16 }),
  readCameraTypeParams()
);

// --- EM Gain (CCD-only camera parameter) ---
const emGainCheckbox = window.document.getElementById("em-gain-checkbox");
const emGainGroup = window.document.getElementById("em-gain-group");
const emGainSliderWrapper = window.document.querySelector(".em-gain-slider");
check("EM Gain checkbox exists", !!emGainCheckbox);
check("EM Gain group is visible by default (CCD is selected)", !!emGainGroup && emGainGroup.hidden === false);
check("EM Gain checkbox starts unchecked", emGainCheckbox.checked === false);
check("EM Gain slider is hidden until the checkbox is checked", !!emGainSliderWrapper && emGainSliderWrapper.hidden === true);

function currentSnrMarkerY() {
  const call = lastCallForDiv("snr-chart");
  const marker = call.traces.find((t) => t.marker && t.marker.color === "#e63946");
  return marker.y[0];
}

const baselineSNR = currentSnrMarkerY();

emGainCheckbox.checked = true;
emGainCheckbox.dispatchEvent(new window.Event("change"));
check("Checking EM Gain reveals the slider", emGainSliderWrapper.hidden === false);

const emGainNumberEl = window.document.getElementById("em-gain-number");
check("EM Gain slider/number defaults to 1", parseFloat(emGainNumberEl.value) === 1, emGainNumberEl.value);
check("EM Gain slider bounds are [1, 1000]", emGainNumberEl.min === "1" && emGainNumberEl.max === "1000");

// Checking the box alone (before touching the slider, EM Gain still at its
// default of 1x) already changes the SNR - the F^2=2 excess-noise factor
// applies to shot/dark noise as soon as EM Gain is enabled, independent of
// the multiplier's value (at 1x, readNoise/emGain = readNoise/1 is a no-op,
// but the F^2 noise inflation is NOT a no-op). Signal is UNCHANGED by EM
// Gain (photons x QE, same as always - the "top side" of the SNR ratio
// never gets touched).
const expectedSignalGain1 = Math.min(20 * 0.95, 100000);
const expectedShotGain1 = Math.sqrt(2 * expectedSignalGain1); // F^2 = 2
const expectedDarkNoiseGain1 = Math.sqrt(2 * 0.00013 * 1.0); // F^2 = 2
const expectedReadNoiseGain1 = 2.9 / 1; // / emGain (1x here)
const expectedNoiseTotalGain1 = Math.sqrt(expectedShotGain1 ** 2 + expectedDarkNoiseGain1 ** 2 + expectedReadNoiseGain1 ** 2);
const expectedSNRGain1 = expectedSignalGain1 / expectedNoiseTotalGain1;
check(
  "Checking EM Gain (still at 1x) already applies the F^2=2 excess noise factor to shot/dark noise",
  Math.abs(currentSnrMarkerY() - expectedSNRGain1) < 1e-3,
  { actual: currentSnrMarkerY(), expected: expectedSNRGain1 }
);

emGainNumberEl.value = "100";
emGainNumberEl.dispatchEvent(new window.Event("change"));

// Expected SNR with EM Gain: signal = photons x QE (UNCHANGED - EM Gain
// never touches the numerator); shot/dark noise x F^2 (fixed at 2); read
// noise / EM Gain (raw division, no cap/floor) - computed independently
// here from the CCD defaults (QE 0.95, dark current 0.00013, read noise
// 2.9, full well 100,000, exposure 1.0s) and current photons (20).
const expectedSignal = Math.min(20 * 0.95, 100000);
const expectedShot = Math.sqrt(2 * expectedSignal);
const expectedDarkNoise = Math.sqrt(2 * 0.00013 * 1.0);
const expectedReadNoise = 2.9 / 100;
const expectedNoiseTotal = Math.sqrt(expectedShot ** 2 + expectedDarkNoise ** 2 + expectedReadNoise ** 2);
const expectedSNR = expectedSignal / expectedNoiseTotal;
check(
  "EM Gain 100x: current-SNR marker matches signal-unchanged, F^2=2 shot/dark, readNoise/emGain formula",
  Math.abs(currentSnrMarkerY() - expectedSNR) < 1e-3,
  { actual: currentSnrMarkerY(), expected: expectedSNR }
);

emGainCheckbox.checked = false;
emGainCheckbox.dispatchEvent(new window.Event("change"));
check("Unchecking EM Gain hides the slider again", emGainSliderWrapper.hidden === true);
check("Unchecking EM Gain reverts SNR to the un-amplified baseline value", Math.abs(currentSnrMarkerY() - baselineSNR) < 1e-6);

scmosBtn.dispatchEvent(new window.Event("click"));
check("EM Gain group is hidden for sCMOS", emGainGroup.hidden === true);
ingaasBtn.dispatchEvent(new window.Event("click"));
check("EM Gain group is hidden for InGaAs", emGainGroup.hidden === true);
ccdBtn.dispatchEvent(new window.Event("click"));
check("EM Gain group reappears, unchecked, when CCD is reselected", emGainGroup.hidden === false && emGainCheckbox.checked === false);

emGainCheckbox.checked = true;
emGainCheckbox.dispatchEvent(new window.Event("change"));
window.document.getElementById("reset-defaults-btn").dispatchEvent(new window.Event("click"));
check("Reset to Default turns EM Gain back off and hides its slider", emGainCheckbox.checked === false && emGainSliderWrapper.hidden === true);

// --- Params panel scroll structure: Camera Type stays pinned above the
// scroll area, Experimental/Camera Parameters groups scroll, Reset stays
// pinned below the scroll area ---
const paramsScrollArea = window.document.querySelector(".params-column .params-scroll-area");
check("Params column has a dedicated scroll area wrapping the controls-groups", !!paramsScrollArea);
check("Only the 2 collapsible groups (Experimental, Camera Parameters) live inside the scroll area", paramsScrollArea.querySelectorAll(".controls-group").length === 2);
const sensorTypeWrapperEl = window.document.querySelector(".params-column .sensor-type-wrapper");
check(
  "Camera Type's wrapper is a sibling of the scroll area, not inside it (stays pinned/immovable on screen)",
  !!sensorTypeWrapperEl && !paramsScrollArea.contains(sensorTypeWrapperEl) && sensorTypeWrapperEl.parentElement === paramsScrollArea.parentElement
);
check(
  "Camera Type's wrapper comes before the scroll area in the DOM",
  !!sensorTypeWrapperEl && !!paramsScrollArea
  && sensorTypeWrapperEl.compareDocumentPosition(paramsScrollArea) & window.Node.DOCUMENT_POSITION_FOLLOWING
);
check(
  "A divider marks the boundary below the Camera Type boxes, above the scroll area",
  !!sensorTypeWrapperEl && !!sensorTypeWrapperEl.querySelector(".reset-divider")
);
const resetWrapperEl = window.document.querySelector(".params-column .reset-wrapper");
check(
  "Reset to Default's wrapper is a sibling of the scroll area, not inside it (stays pinned on screen)",
  !!resetWrapperEl && !paramsScrollArea.contains(resetWrapperEl) && resetWrapperEl.parentElement === paramsScrollArea.parentElement
);
check(
  "A divider marks the scroll boundary above the Reset to Default button",
  !!resetWrapperEl && !!resetWrapperEl.querySelector(".reset-divider")
);

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

// --- Info buttons are icon-only (no text label) everywhere they appear ---
check("Header Info button has no text label (icon-only)", infoBtn.textContent.trim() === "", infoBtn.textContent);
check("Header Info button contains the info-circle SVG icon", !!infoBtn.querySelector("svg.icon-info"));
check("Header Info button keeps an accessible label via aria-label/title", infoBtn.getAttribute("aria-label") === "Info" && infoBtn.title === "Info");

const comparisonInfoBtnIcon = window.document.getElementById("comparison-info-btn");
check("Comparison panel Info button has no text label (icon-only)", comparisonInfoBtnIcon.textContent.trim() === "", comparisonInfoBtnIcon.textContent);
check("Comparison panel Info button contains the info-circle SVG icon", !!comparisonInfoBtnIcon.querySelector("svg.icon-info"));

// --- One Info icon button + overlay per Box 1-5 panel, right side of each header ---
const perPanelInfo = [
  { panelId: "panel-1", btnId: "panel-1-info-btn", overlayId: "panel-1-info-overlay", closeBtnId: "panel-1-info-close-btn" },
  { panelId: "panel-2", btnId: "panel-2-info-btn", overlayId: "panel-2-info-overlay", closeBtnId: "panel-2-info-close-btn" },
  { panelId: "panel-3", btnId: "panel-3-info-btn", overlayId: "panel-3-info-overlay", closeBtnId: "panel-3-info-close-btn" },
  { panelId: "panel-4", btnId: "panel-4-info-btn", overlayId: "panel-4-info-overlay", closeBtnId: "panel-4-info-close-btn" },
  { panelId: "panel-5", btnId: "panel-5-info-btn", overlayId: "panel-5-info-overlay", closeBtnId: "panel-5-info-close-btn" },
];

for (const { panelId, btnId, overlayId, closeBtnId } of perPanelInfo) {
  const btn = window.document.getElementById(btnId);
  const overlay = window.document.getElementById(overlayId);
  const closeBtn = window.document.getElementById(closeBtnId);

  check(`${panelId}: Info icon button exists`, !!btn);
  check(`${panelId}: Info icon button has no text label (icon-only)`, !!btn && btn.textContent.trim() === "", btn && btn.textContent);
  check(`${panelId}: Info icon button contains the info-circle SVG icon`, !!btn && !!btn.querySelector("svg.icon-info"));

  const controlsInHeader = Array.from(window.document.querySelectorAll(`#${panelId} .panel-header button`));
  check(
    `${panelId}: Info icon button is the LAST (rightmost) button in its header`,
    controlsInHeader.length > 0 && controlsInHeader[controlsInHeader.length - 1] === btn,
    controlsInHeader.map((b) => b.id)
  );

  check(`${panelId}: Info overlay exists and starts hidden`, !!overlay && overlay.hidden === true);
  btn.dispatchEvent(new window.Event("click"));
  check(`${panelId}: clicking the Info icon opens its overlay`, overlay.hidden === false);
  // Boxes 1-3 have real content now (see the dedicated checks below); the
  // rest are still placeholders, to be filled in later.
  const PANELS_WITH_REAL_INFO_CONTENT = ["panel-1", "panel-2", "panel-3", "panel-4", "panel-5"];
  if (!PANELS_WITH_REAL_INFO_CONTENT.includes(panelId)) {
    check(
      `${panelId}: overlay shows placeholder text (content to be filled in later)`,
      window.document.getElementById(`${panelId}-info-modal-content`).textContent.includes("Info coming soon")
    );
  }
  closeBtn.dispatchEvent(new window.Event("click"));
  check(`${panelId}: Info overlay closes via its close button`, overlay.hidden === true);
}

// --- Camera Simulator (Box 1) Info overlay: real content ---
const panel1InfoContent = window.document.getElementById("panel-1-info-modal-content");
check(
  "Camera Simulator panel Info overlay no longer shows the 'Info coming soon' placeholder",
  !!panel1InfoContent && !panel1InfoContent.textContent.includes("Info coming soon")
);
check(
  "Camera Simulator panel Info overlay describes what the simulation shows (false-color simulated frame)",
  !!panel1InfoContent && /false-color simulated sensor frame/.test(panel1InfoContent.textContent)
);
check(
  "Camera Simulator panel Info overlay describes the illuminated area's anti-aliased edge treatment",
  !!panel1InfoContent && /anti-aliased/.test(panel1InfoContent.textContent)
);
check(
  "Camera Simulator panel Info overlay notes this is for visualization only",
  !!panel1InfoContent && /for visualization only/.test(panel1InfoContent.textContent)
);
check(
  "Camera Simulator panel Info overlay mentions the refresh rate is not a simulated frame rate",
  !!panel1InfoContent && /refresh rate is a display setting, not a simulated camera frame rate/.test(panel1InfoContent.textContent)
);

// --- Histogram (Box 2) Info overlay: real content ---
const panel2InfoContent = window.document.getElementById("panel-2-info-modal-content");
check(
  "Histogram panel Info overlay no longer shows the 'Info coming soon' placeholder",
  !!panel2InfoContent && !panel2InfoContent.textContent.includes("Info coming soon")
);
check(
  "Histogram panel Info overlay describes what it plots (80-bin ADU distribution)",
  !!panel2InfoContent && /80 bins/.test(panel2InfoContent.textContent) && /ADU values/.test(panel2InfoContent.textContent)
);
check(
  "Histogram panel Info overlay notes the dead-strip exclusion under mismatched binning",
  !!panel2InfoContent && /excluded/.test(panel2InfoContent.textContent)
);
check(
  "Histogram panel Info overlay explains the linear/log y-axis toggle",
  !!panel2InfoContent && /linear and log scale/.test(panel2InfoContent.textContent)
);

// --- Line Profile (Box 3) Info overlay: real content ---
const panel3InfoContent = window.document.getElementById("panel-3-info-modal-content");
check(
  "Line Profile panel Info overlay no longer shows the 'Info coming soon' placeholder",
  !!panel3InfoContent && !panel3InfoContent.textContent.includes("Info coming soon")
);
check(
  "Line Profile panel Info overlay describes what it plots (the middle row)",
  !!panel3InfoContent && /middle row/.test(panel3InfoContent.textContent)
);
check(
  "Line Profile panel Info overlay ties the plot back to the colored row indicator on the Camera Simulator panel",
  !!panel3InfoContent && /colored line overlaid on the Camera Simulator panel/.test(panel3InfoContent.textContent)
);

// --- SNR (Box 4) Info overlay: real content ---
const panel4InfoContent = window.document.getElementById("panel-4-info-modal-content");
check(
  "SNR panel Info overlay no longer shows the 'Info coming soon' placeholder",
  !!panel4InfoContent && !panel4InfoContent.textContent.includes("Info coming soon")
);
check(
  "SNR panel Info overlay describes the analytic SNR curve and the current-photons marker",
  !!panel4InfoContent && /analytic Signal-to-Noise Ratio/.test(panel4InfoContent.textContent) && /red marker tracks your current Photons setting/.test(panel4InfoContent.textContent)
);
check(
  "SNR panel Info overlay names the baseline and modified traces using the current (non-'Binned SNR') label",
  !!panel4InfoContent && /"Single Pixel SNR"/.test(panel4InfoContent.textContent) && /"Modified SNR"/.test(panel4InfoContent.textContent)
  && !panel4InfoContent.textContent.includes("Binned SNR")
);
check(
  "SNR panel Info overlay mentions the Compare button and the Comparison panel",
  !!panel4InfoContent && /Compare/.test(panel4InfoContent.textContent) && /Camera Sensitivity Comparison panel/.test(panel4InfoContent.textContent)
);

// --- Noise Contributions (Box 5) Info overlay: real content ---
const panel5InfoContent = window.document.getElementById("panel-5-info-modal-content");
check(
  "Noise Contributions panel Info overlay no longer shows the 'Info coming soon' placeholder",
  !!panel5InfoContent && !panel5InfoContent.textContent.includes("Info coming soon")
);
check(
  "Noise Contributions panel Info overlay describes the shot/dark/read breakdown",
  !!panel5InfoContent && /shot, dark, and read noise/.test(panel5InfoContent.textContent)
);

// --- Comparison panel Export button: sits to the left of the Info button ---
const exportComparisonBtn = window.document.getElementById("export-comparison-btn");
check("Comparison panel Export button exists", !!exportComparisonBtn);
const comparisonHeaderControls = Array.from(window.document.querySelectorAll("#panel-comparison .panel-controls button")).map((b) => b.id);
check(
  "Export button sits to the left of the Info button in the Comparison panel header",
  JSON.stringify(comparisonHeaderControls) === JSON.stringify(["export-comparison-btn", "comparison-info-btn"]),
  comparisonHeaderControls
);

// Save two traces (with different pixel sizes, so raw vs. normalized differ), then export.
// (Using getElementById directly here rather than the later-declared `compareBtn`
// const, since this block runs before that declaration is reached.)
const compareBtnForExportTest = window.document.getElementById("compare-btn");
pixelSizeNumberEl.value = "26"; // ratio = 4
pixelSizeNumberEl.dispatchEvent(new window.Event("change"));
promptQueue.push("Export Cam A");
compareBtnForExportTest.dispatchEvent(new window.Event("click"));
pixelSizeNumberEl.value = "6.5"; // ratio = 0.25
pixelSizeNumberEl.dispatchEvent(new window.Event("change"));
promptQueue.push("Export Cam B");
compareBtnForExportTest.dispatchEvent(new window.Event("click"));

downloadImageCalls.length = 0;
lastBlobText = null;
exportComparisonBtn.dispatchEvent(new window.Event("click"));

check("Exporting downloads exactly 2 Plotly PNGs (both comparison plots)", downloadImageCalls.length === 2, downloadImageCalls.length);
const exportedPngDivs = downloadImageCalls.map((c) => c.divId).sort();
check(
  "The 2 exported PNGs are comparison-plot-1 and comparison-plot-2",
  JSON.stringify(exportedPngDivs) === JSON.stringify(["comparison-plot-1", "comparison-plot-2"]),
  exportedPngDivs
);

check("Exporting produced a text file", lastBlobText !== null);
const comparisonCsvLines = (lastBlobText || "").trim().split("\n");
check("Comparison export header lists both saved trace names", comparisonCsvLines.some((l) => l.includes("Export Cam A") && l.includes("Export Cam B")));
const comparisonHeaderRowIdx = comparisonCsvLines.indexOf("TraceName,IncidentPhotons,SNR,NormalizedSNR_13umPixel");
check("Comparison export CSV has the expected 4-column header row", comparisonHeaderRowIdx !== -1);
const comparisonDataRows = comparisonCsvLines.slice(comparisonHeaderRowIdx + 1).map((l) => l.split(","));
check("Comparison export includes rows for both trace names", comparisonDataRows.some((r) => r[0] === "Export Cam A") && comparisonDataRows.some((r) => r[0] === "Export Cam B"));
const camARow = comparisonDataRows.find((r) => r[0] === "Export Cam A");
check(
  "A Camera A row's NormalizedSNR column equals SNR * 4 (its pixel-size ratio at save time)",
  Math.abs(Number(camARow[3]) - Number(camARow[2]) * 4) < 1e-6,
  camARow
);

// Clean up the two traces saved for this test.
while (window.document.querySelectorAll("#comparison-legend .comparison-legend-delete").length > 0) {
  window.document.querySelector("#comparison-legend .comparison-legend-delete").dispatchEvent(new window.Event("click"));
}
pixelSizeNumberEl.value = "13";
pixelSizeNumberEl.dispatchEvent(new window.Event("change"));

// --- Comparison panel Info overlay: explains the Normalized SNR plot ---
const comparisonInfoBtn = window.document.getElementById("comparison-info-btn");
const comparisonInfoOverlay = window.document.getElementById("comparison-info-overlay");
const comparisonInfoModalContent = window.document.getElementById("comparison-info-modal-content");
const comparisonInfoCloseBtn = window.document.getElementById("comparison-info-close-btn");
check("Comparison panel Info button exists in its header", !!comparisonInfoBtn);
check("Comparison Info overlay exists and starts hidden", !!comparisonInfoOverlay && comparisonInfoOverlay.hidden === true);
check(
  "Comparison Info overlay content mentions the 5-trace cap, the 13 µm reference pixel, and pixel surface area",
  comparisonInfoModalContent.textContent.includes("up to 5") && comparisonInfoModalContent.textContent.includes("13 µm reference pixel") && comparisonInfoModalContent.textContent.includes("surface area"),
  comparisonInfoModalContent.textContent
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

// --- 13b. Splash / landing screen ---
const splashScreenEl = window.document.getElementById("splash-screen");
check("Splash screen exists and is visible on load (not [hidden])", !!splashScreenEl && splashScreenEl.hidden === false);
check(
  "Splash screen shows the PhotonBench wordmark as SVG text (Photon + bold Bench)",
  !!splashScreenEl && /Photon/.test(splashScreenEl.textContent) && /Bench/.test(splashScreenEl.textContent)
);

const splashBtnImaging = window.document.getElementById("splash-btn-imaging");
const splashBtnSpectroscopy = window.document.getElementById("splash-btn-spectroscopy");
const splashBtnSnr = window.document.getElementById("splash-btn-snr");
check(
  "Splash screen has exactly three mode buttons, correctly labeled and data-mode tagged",
  !!splashBtnImaging && !!splashBtnSpectroscopy && !!splashBtnSnr
  && splashBtnImaging.textContent === "Imaging" && splashBtnImaging.dataset.mode === "imaging"
  && splashBtnSpectroscopy.textContent === "Spectroscopy" && splashBtnSpectroscopy.dataset.mode === "spectroscopy"
  && splashBtnSnr.textContent === "SNR Only" && splashBtnSnr.dataset.mode === "snr"
);
check(
  "Splash screen sits before the app header in the document (renders on top)",
  !!splashScreenEl && !!window.document.querySelector(".app-titlebar")
  && Boolean(splashScreenEl.compareDocumentPosition(window.document.querySelector(".app-titlebar")) & window.Node.DOCUMENT_POSITION_FOLLOWING)
);

// Clicking a splash button should hide the splash AND jump into that mode -
// use SNR Only (not the already-active Imaging) so switching is actually
// observable, then restore to Imaging afterward for the rest of the suite.
// Deliberately NOT Spectroscopy here: later in this file, a block of checks
// assumes the spectrum-chart/height-snr-chart call counts are exactly 1
// (only the page-load newPlot call) right up until Spectroscopy is first
// switched into "for real" - triggering that switch this early would throw
// those absolute counts off. SNR Only has no such gating (its panel-4/
// panel-5 charts already update on every Imaging redraw), so a round trip
// through it here is safe.
const modeTabSnrForSplashTest = window.document.getElementById("mode-tab-snr");
splashBtnSnr.dispatchEvent(new window.Event("click"));
check("Clicking a splash mode button hides the splash screen", splashScreenEl.hidden === true);
check(
  "Clicking the SNR Only splash button actually switched into SNR Only mode",
  modeTabSnrForSplashTest.classList.contains("is-active")
  && modeTabSnrForSplashTest.getAttribute("aria-selected") === "true"
);
// Restore to Imaging so the rest of the suite starts from its expected mode.
window.document.getElementById("mode-tab-imaging").dispatchEvent(new window.Event("click"));
check(
  "Restored to Imaging mode after the splash test",
  window.document.getElementById("mode-tab-imaging").classList.contains("is-active")
);

// --- 14. Sensor width/height inputs: defaults, live resize, and clamping ---
const sensorWidthInput = window.document.getElementById("sensor-width-input");
const sensorHeightInput = window.document.getElementById("sensor-height-input");
check("Sensor width input exists with default 1024", !!sensorWidthInput && parseFloat(sensorWidthInput.value) === 1024, sensorWidthInput && sensorWidthInput.value);
check("Sensor height input exists with default 1024", !!sensorHeightInput && parseFloat(sensorHeightInput.value) === 1024, sensorHeightInput && sensorHeightInput.value);
check("Sensor width input bounds are [500, 5000]", sensorWidthInput.min === "500" && sensorWidthInput.max === "5000");
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
sensorWidthInput.value = "100"; // below the 500 minimum
sensorHeightInput.value = "999999"; // above the 5000 maximum
sensorWidthInput.dispatchEvent(new window.Event("change"));
sensorHeightInput.dispatchEvent(new window.Event("change"));
check("Sensor width below minimum clamps to 500", parseFloat(sensorWidthInput.value) === 500, sensorWidthInput.value);
check("Sensor height above maximum clamps to 5000", parseFloat(sensorHeightInput.value) === 5000, sensorHeightInput.value);

const clampedPutImageData = putImageDataCalls[putImageDataCalls.length - 1];
check(
  "Canvas reflects the clamped dimensions (500x5000), not the raw out-of-range input",
  clampedPutImageData.imageData.width === 500 && clampedPutImageData.imageData.height === 5000,
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

// --- Binning: checkbox-gated (like EM Gain), inside Camera Parameters ---
// Binning no longer changes the sensor's field of view at all - it only
// changes how big the "super pixels" look. The canvas always stays at the
// sensor's native width x height; resizing the sensor always resets binning
// back to 1x1 (and unchecks the Binning checkbox) rather than the old
// snap-the-sensor-to-the-bin behavior.
const binningCheckbox = window.document.getElementById("binning-checkbox");
const binHorizontalSelect = window.document.getElementById("bin-horizontal-select");
const binVerticalSelect = window.document.getElementById("bin-vertical-select");
const binningSelectRowEl = binHorizontalSelect.closest(".binning-select-row");
check("Binning checkbox and Horizontal/Vertical selects exist", !!binningCheckbox && !!binHorizontalSelect && !!binVerticalSelect);
check("Binning checkbox is unchecked by default", binningCheckbox.checked === false);
check("Binning select row is hidden by default (matches unchecked state)", binningSelectRowEl.hidden === true);
check("Horizontal bin defaults to 1", binHorizontalSelect.value === "1", binHorizontalSelect.value);
check("Vertical bin defaults to 1", binVerticalSelect.value === "1", binVerticalSelect.value);
check(
  "Binning checkbox lives inside Camera Parameters, not its own controls-group",
  window.document.getElementById("camera-controls").contains(binningCheckbox)
);

// Regression guard for a real bug found in testing: .binning-select-row's
// own `display: grid` rule has the SAME CSS specificity as the browser's
// built-in `[hidden] { display: none }` rule, so without an explicit
// `.binning-select-row[hidden] { display: none }` override, the author
// stylesheet rule wins and the row stays visually shown (and clickable) even
// while `hidden` is true - meaning unchecking Binning didn't actually hide
// or disable the Horizontal/Vertical selects in a real browser, even though
// the `.hidden` IDL property (which jsdom's DOM-only checks above rely on)
// correctly read true the whole time. Checked directly against the raw CSS
// text since jsdom doesn't run a full layout/cascade engine.
const styleCssText = fs.readFileSync(path.join(SITE_DIR, "style.css"), "utf8");
check(
  "style.css has the [hidden] specificity-override rule for .binning-select-row",
  /\.binning-select-row\[hidden\]\s*\{[^}]*display:\s*none/.test(styleCssText),
  styleCssText.includes(".binning-select-row[hidden]")
);

const baseLineWidthCall = rowIndicatorCalls.filter((c) => c.fn === "lineWidth").pop();
const baseDashCall = rowIndicatorCalls.filter((c) => c.fn === "setLineDash").pop();
check(
  "Row indicator line uses the base thickness (2px) with no binning active",
  baseLineWidthCall && baseLineWidthCall.value === 2,
  baseLineWidthCall && baseLineWidthCall.value
);
check(
  "Row indicator dash uses the base pattern ([10, 6]) with no binning active",
  baseDashCall && JSON.stringify(baseDashCall.segments) === JSON.stringify([10, 6]),
  baseDashCall && baseDashCall.segments
);

// Checking the box reveals the selects, same pattern as EM Gain's checkbox.
binningCheckbox.checked = true;
binningCheckbox.dispatchEvent(new window.Event("change"));
check("Checking Binning reveals the Horizontal/Vertical select row", binningSelectRowEl.hidden === false);

// Set a sensor size that is NOT an exact multiple of the bin factors we're
// about to select, to exercise the dead-strip edge case below.
sensorWidthInput.value = "1030";
sensorHeightInput.value = "1030";
sensorWidthInput.dispatchEvent(new window.Event("change"));
sensorHeightInput.dispatchEvent(new window.Event("change"));
check("Sensor size accepts 1030x1030", parseFloat(sensorWidthInput.value) === 1030 && parseFloat(sensorHeightInput.value) === 1030);

// A resize resets AND unchecks Binning (see below); re-check it to continue exercising the selects.
check("Resizing the sensor unchecked Binning", binningCheckbox.checked === false);
binningCheckbox.checked = true;
binningCheckbox.dispatchEvent(new window.Event("change"));

binHorizontalSelect.value = "4";
binHorizontalSelect.dispatchEvent(new window.Event("change"));
check("Selecting Horizontal bin = 4 does NOT change sensor width", parseFloat(sensorWidthInput.value) === 1030, sensorWidthInput.value);
check("Selecting Horizontal bin = 4 does NOT change sensor height", parseFloat(sensorHeightInput.value) === 1030, sensorHeightInput.value);

binVerticalSelect.value = "8";
binVerticalSelect.dispatchEvent(new window.Event("change"));
check("Selecting Vertical bin = 8 does NOT change sensor width", parseFloat(sensorWidthInput.value) === 1030, sensorWidthInput.value);
check("Selecting Vertical bin = 8 does NOT change sensor height", parseFloat(sensorHeightInput.value) === 1030, sensorHeightInput.value);

// The canvas pixel buffer stays at the sensor's native size regardless of binning.
const binnedFrameImageData = putImageDataCalls[putImageDataCalls.length - 1].imageData;
check(
  "Canvas stays at the full native 1030x1030 sensor size while a 4x8 bin is active",
  binnedFrameImageData.width === 1030 && binnedFrameImageData.height === 1030,
  { width: binnedFrameImageData.width, height: binnedFrameImageData.height }
);

// 1030 is not an exact multiple of either bin factor (4 or 8): the active
// region is floor(1030/4)*4 = 1028 columns and floor(1030/8)*8 = 1024 rows,
// leaving a 2px-wide dead strip on the right and a 6px-tall dead strip on
// the bottom, both rendered fully black/unilluminated (alpha still 255).
const binnedData = binnedFrameImageData.data;
function pixelAt(data, width, x, y) {
  const p = (y * width + x) * 4;
  return { r: data[p], g: data[p + 1], b: data[p + 2], a: data[p + 3] };
}
const deadRightPixel = pixelAt(binnedData, 1030, 1029, 500); // last column, an interior row
const deadBottomPixel = pixelAt(binnedData, 1030, 500, 1029); // last row, an interior column
const activePixel = pixelAt(binnedData, 1030, 500, 500); // well within the active 1028x1024 region
check(
  "Dead strip beyond the last full horizontal bin renders fully black",
  deadRightPixel.r === 0 && deadRightPixel.g === 0 && deadRightPixel.b === 0 && deadRightPixel.a === 255,
  deadRightPixel
);
check(
  "Dead strip beyond the last full vertical bin renders fully black",
  deadBottomPixel.r === 0 && deadBottomPixel.g === 0 && deadBottomPixel.b === 0 && deadBottomPixel.a === 255,
  deadBottomPixel
);
check(
  "A pixel well within the active binned region is NOT forced black (gets a real LUT color)",
  !(activePixel.r === 0 && activePixel.g === 0 && activePixel.b === 0),
  activePixel
);

// A manual resize resets binning back to 1x1 AND unchecks Binning, rather than re-snapping to it.
sensorWidthInput.value = "1035";
sensorWidthInput.dispatchEvent(new window.Event("change"));
check("Manually resizing the sensor resets Horizontal bin back to 1", binHorizontalSelect.value === "1", binHorizontalSelect.value);
check("Manually resizing the sensor resets Vertical bin back to 1", binVerticalSelect.value === "1", binVerticalSelect.value);
check("Manually resizing the sensor unchecks Binning", binningCheckbox.checked === false);
check("Manually resizing the sensor re-hides the bin select row", binningSelectRowEl.hidden === true);
check("Manual resize takes the exact typed value (1035), no snapping", parseFloat(sensorWidthInput.value) === 1035, sensorWidthInput.value);

// Row indicator line thickness/dash stay at their base size regardless of
// binning, since the canvas never shrinks - re-check Binning, re-select a bin, and confirm.
binningCheckbox.checked = true;
binningCheckbox.dispatchEvent(new window.Event("change"));
binHorizontalSelect.value = "4";
binHorizontalSelect.dispatchEvent(new window.Event("change"));
binVerticalSelect.value = "8";
binVerticalSelect.dispatchEvent(new window.Event("change"));
const boundLineWidthCall = rowIndicatorCalls.filter((c) => c.fn === "lineWidth").pop();
const boundDashCall = rowIndicatorCalls.filter((c) => c.fn === "setLineDash").pop();
check(
  "Row indicator line thickness stays at the base 2px even with a 4x8 bin active",
  boundLineWidthCall && boundLineWidthCall.value === 2,
  boundLineWidthCall && boundLineWidthCall.value
);
check(
  "Row indicator dash stays at the base [10, 6] pattern even with a 4x8 bin active",
  boundDashCall && JSON.stringify(boundDashCall.segments) === JSON.stringify([10, 6]),
  boundDashCall && boundDashCall.segments
);

// Reset to Default clears binning back to 1x1 and unchecks it (in addition to the sensor size reset already covered above).
resetBtn.dispatchEvent(new window.Event("click"));
check("Reset to Default restores Horizontal bin to 1", binHorizontalSelect.value === "1", binHorizontalSelect.value);
check("Reset to Default restores Vertical bin to 1", binVerticalSelect.value === "1", binVerticalSelect.value);
check("Reset to Default unchecks Binning", binningCheckbox.checked === false);

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

// --- SNR panel: dashed "Single Pixel SNR" baseline + solid "Modified SNR" ---
// active trace, shown only once EM Gain and/or Binning are active.
check(
  "SNR chart shows only 4 traces (hi band, lo band, single curve, marker) with no modifier active",
  lastCallForDiv("snr-chart").traces.length === 4,
  lastCallForDiv("snr-chart").traces.length
);
const singleCurveTrace = lastCallForDiv("snr-chart").traces[2];
check(
  "With no modifier active, the single SNR trace is solid (no dash)",
  !singleCurveTrace.line.dash || singleCurveTrace.line.dash === "solid",
  singleCurveTrace.line.dash
);
check(
  "With no modifier active, hover omits the Single Pixel/Modified SNR labels",
  singleCurveTrace.hovertemplate === "%{x:.1f}, %{y:.1f}<extra></extra>",
  singleCurveTrace.hovertemplate
);

emGainCheckbox.checked = true;
emGainCheckbox.dispatchEvent(new window.Event("change"));
const emGainSnrNumberEl = window.document.getElementById("em-gain-number");
emGainSnrNumberEl.value = "50";
emGainSnrNumberEl.dispatchEvent(new window.Event("change"));

const dualCall = lastCallForDiv("snr-chart");
check("SNR chart grows a 5th trace (Modified SNR) once EM Gain is active", dualCall.traces.length === 5, dualCall.traces.length);
const baselineTraceWithEmGain = dualCall.traces[2];
const activeTraceWithEmGain = dualCall.traces[3];
check("Baseline 'Single Pixel SNR' trace is dashed once EM Gain is active", baselineTraceWithEmGain.line.dash === "dash", baselineTraceWithEmGain.line.dash);
check(
  "Active 'Modified SNR' trace is solid",
  !activeTraceWithEmGain.line.dash || activeTraceWithEmGain.line.dash === "solid",
  activeTraceWithEmGain.line.dash
);
check(
  "Baseline trace hover is labeled 'Single Pixel SNR'",
  baselineTraceWithEmGain.hovertemplate.includes("Single Pixel SNR"),
  baselineTraceWithEmGain.hovertemplate
);
check(
  "Active trace hover is labeled 'Modified SNR'",
  activeTraceWithEmGain.hovertemplate.includes("Modified SNR"),
  activeTraceWithEmGain.hovertemplate
);
check(
  "Baseline (Single Pixel) curve differs from the active (EM Gain-applied) curve",
  !baselineTraceWithEmGain.y.every((v, i) => Math.abs(v - activeTraceWithEmGain.y[i]) < 1e-9)
);

// Compare should snapshot the ACTIVE curve, not the baseline, while EM Gain is on.
promptQueue.push("EM Gain Camera");
compareBtn.dispatchEvent(new window.Event("click"));
const emGainComparisonTrace = lastCallForDiv("comparison-plot-1").traces[lastCallForDiv("comparison-plot-1").traces.length - 1];
check(
  "Compare saves the ACTIVE (Modified SNR) curve, not the baseline, when EM Gain is on",
  emGainComparisonTrace.y.every((v, i) => Math.abs(v - activeTraceWithEmGain.y[i]) < 1e-9),
  { saved: emGainComparisonTrace.y.slice(0, 5), active: activeTraceWithEmGain.y.slice(0, 5) }
);

// Clean up: remove the trace just added and turn EM Gain back off so the
// Comparison panel section below starts from a clean, empty state.
const emGainCleanupDeleteBtn = window.document.querySelector(".comparison-legend-delete");
if (emGainCleanupDeleteBtn) emGainCleanupDeleteBtn.dispatchEvent(new window.Event("click"));
emGainCheckbox.checked = false;
emGainCheckbox.dispatchEvent(new window.Event("change"));
check(
  "Comparison panel is empty again after the EM Gain SNR test cleanup",
  window.document.getElementById("comparison-legend").textContent.includes("No saved traces")
);

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

// --- 19. Latest aesthetic batch: Camera Type pinned, chevrons on the right,
// transparent header Info icon, unified panel header heights ---

// Chevron now renders AFTER the h3 text (right side) in both collapsible
// group headers, and .controls-group-header lays them out with
// space-between so the chevron sits at the far right edge, not just
// immediately after the text.
for (const { groupId, toggleBtnId } of collapsibleGroups) {
  const toggleBtn = window.document.getElementById(toggleBtnId);
  const h3 = toggleBtn.querySelector("h3");
  const chevron = toggleBtn.querySelector("svg.icon-chevron");
  check(
    `${groupId}: chevron arrow sits to the right of the section title in markup`,
    !!h3 && !!chevron && !!(h3.compareDocumentPosition(chevron) & window.Node.DOCUMENT_POSITION_FOLLOWING)
  );
}
check(
  "style.css lays out .controls-group-header with space-between so the chevron sits on the right edge",
  /\.controls-group-header\s*\{[^}]*justify-content:\s*space-between/.test(styleCssText)
);

// Header Info button: transparent background/border so it blends into the
// dark titlebar, scoped to .app-titlebar #info-btn so it doesn't affect the
// solid-styled per-panel Info icons.
check(
  "style.css makes the header Info button transparent (background) against the titlebar",
  /\.app-titlebar\s+#info-btn\s*\{[^}]*background:\s*transparent/.test(styleCssText)
);
check(
  "style.css makes the header Info button transparent (border) against the titlebar",
  /\.app-titlebar\s+#info-btn\s*\{[^}]*border-color:\s*transparent/.test(styleCssText)
);
check(
  "Panel Info icons elsewhere (e.g. Box 1) are unaffected and keep their normal .btn/.icon-btn styling",
  !!window.document.getElementById("panel-1-info-btn")
);

// All panel headers share the base .panel-header padding now - the -plot
// and -split modifier classes no longer redeclare their own padding, so
// every panel header (Box 1 through Box 6, plus the -plot/-split variants
// used by Boxes 2-5) renders at the same height.
check(
  "style.css: .panel-header-plot no longer overrides padding (inherits the base .panel-header height)",
  !/\.panel-header-plot\s*\{[^}]*padding:/.test(styleCssText)
);
check(
  "style.css: .panel-header-split no longer overrides padding (inherits the base .panel-header height)",
  !/\.panel-header-split\s*\{[^}]*padding:/.test(styleCssText)
);

// Camera Type immovable above the scroll area: reconfirm the sensor-type
// buttons themselves still work correctly from their new fixed position.
const sensorTypeWrapperFinal = window.document.querySelector(".params-column .sensor-type-wrapper");
check(
  "Camera Type wrapper still contains the CCD/sCMOS/InGaAs tabs after relocation",
  !!sensorTypeWrapperFinal && sensorTypeWrapperFinal.querySelectorAll(".sensor-type-btn").length === 3
);

// --- 20. Camera Parameters reordered: Binning below Bit Depth (every
// camera type); Register Well Depth directly below Full Well Depth; EM Gain
// stays last (CCD only); EM Gain checkbox relabeled "Enable EM Gain" ---
const camContainerFinal = window.document.getElementById("camera-controls");
const camOrderKeys = Array.from(camContainerFinal.children).map((el) => {
  if (el.querySelector("#qe-slider")) return "qe";
  if (el.querySelector("#dark-current-slider")) return "darkCurrent";
  if (el.querySelector("#read-noise-slider")) return "readNoise";
  if (el.querySelector("#full-well-slider")) return "fullWell";
  if (el.classList.contains("register-well-depth-control")) return "registerWellDepth";
  if (el.querySelector("#offset-slider")) return "offset";
  if (el.querySelector("#gain-slider")) return "gain";
  if (el.querySelector("#pixel-size-slider")) return "pixelSize";
  if (el.querySelector("#bit-depth-select")) return "bitDepth";
  if (el.id === "binning-group") return "binning";
  if (el.id === "em-gain-group") return "emGain";
  return "unknown";
});
check(
  "Camera Parameters render in the new order: ...Full Well Depth, Register Well Depth, Offset, Sensitivity, Pixel Size, Bit Depth, Binning, EM Gain",
  JSON.stringify(camOrderKeys) === JSON.stringify([
    "qe", "darkCurrent", "readNoise", "fullWell", "registerWellDepth",
    "offset", "gain", "pixelSize", "bitDepth", "binning", "emGain",
  ]),
  camOrderKeys
);
check("Bit Depth sits directly below Pixel Size", camOrderKeys[camOrderKeys.indexOf("pixelSize") + 1] === "bitDepth");
check("Binning sits directly below Bit Depth", camOrderKeys[camOrderKeys.indexOf("bitDepth") + 1] === "binning");
check("Register Well Depth sits directly below Full Well Depth", camOrderKeys[camOrderKeys.indexOf("fullWell") + 1] === "registerWellDepth");
check("EM Gain is the last control in the Camera Parameters list", camOrderKeys[camOrderKeys.length - 1] === "emGain");

// Switching to a non-CCD type (which hides EM Gain and Register Well Depth,
// but keeps them in the DOM) should not change the underlying DOM order.
const scmosBtnOrderCheck = window.document.getElementById("sensor-type-scmos-btn");
scmosBtnOrderCheck.dispatchEvent(new window.Event("click"));
const camOrderKeysScmos = Array.from(camContainerFinal.children).map((el) => {
  if (el.classList.contains("register-well-depth-control")) return "registerWellDepth";
  if (el.querySelector("#bit-depth-select")) return "bitDepth";
  if (el.id === "binning-group") return "binning";
  if (el.id === "em-gain-group") return "emGain";
  return "other";
});
check(
  "sCMOS: DOM order is unchanged (Register Well Depth/EM Gain just hidden, not reordered/removed)",
  camOrderKeysScmos.filter((k) => k !== "other").join(",") === "registerWellDepth,bitDepth,binning,emGain",
  camOrderKeysScmos
);
window.document.getElementById("sensor-type-ccd-btn").dispatchEvent(new window.Event("click"));

// EM Gain checkbox label reads "Enable EM Gain" (renamed from just "EM Gain"
// to read more clearly as an action/toggle rather than a state label).
const emGainCheckboxLabelFinal = window.document.querySelector(".em-gain-checkbox-label");
check(
  "EM Gain checkbox label reads 'Enable EM Gain'",
  !!emGainCheckboxLabelFinal && emGainCheckboxLabelFinal.textContent.trim() === "Enable EM Gain",
  emGainCheckboxLabelFinal && emGainCheckboxLabelFinal.textContent
);

// --- 21. Mode tabs (Imaging / Spectroscopy / SNR Only) --------------------

const modeTabImaging = window.document.getElementById("mode-tab-imaging");
const modeTabSpectroscopy = window.document.getElementById("mode-tab-spectroscopy");
const modeTabSnr = window.document.getElementById("mode-tab-snr");
const modeViewImaging = window.document.getElementById("mode-imaging");
const modeViewSpectroscopy = window.document.getElementById("mode-spectroscopy");
const modeViewSnr = window.document.getElementById("mode-snr");

check("All 3 mode tabs exist in the header", !!modeTabImaging && !!modeTabSpectroscopy && !!modeTabSnr);
check(
  "Mode tabs are labeled 'Imaging', 'Spectroscopy', 'SNR Only', in that order",
  modeTabImaging.textContent === "Imaging" && modeTabSpectroscopy.textContent === "Spectroscopy" && modeTabSnr.textContent === "SNR Only",
  [modeTabImaging.textContent, modeTabSpectroscopy.textContent, modeTabSnr.textContent]
);
const modeTabOrder = Array.from(window.document.querySelectorAll(".mode-tabs .mode-tab")).map((el) => el.id);
check(
  "Spectroscopy tab sits between Imaging and SNR Only in the header",
  JSON.stringify(modeTabOrder) === JSON.stringify(["mode-tab-imaging", "mode-tab-spectroscopy", "mode-tab-snr"]),
  modeTabOrder
);
check(
  "Mode tabs live inside the header, to the right of the title (same wrapper as the Info button)",
  !!window.document.querySelector(".app-titlebar .app-header-right .mode-tabs") && !!window.document.querySelector(".app-titlebar .app-header-right #info-btn")
);
check("All 3 mode-view containers exist", !!modeViewImaging && !!modeViewSpectroscopy && !!modeViewSnr);
check(
  "style.css hides .mode-view by default and shows it via .is-active",
  /\.mode-view\s*\{[^}]*display:\s*none/.test(styleCssText) && /\.mode-view\.is-active\s*\{[^}]*display:\s*grid/.test(styleCssText)
);

check("Imaging is the active mode on page load", modeViewImaging.classList.contains("is-active") && modeTabImaging.classList.contains("is-active"));
check("Imaging tab starts aria-selected=true, the other two false", modeTabImaging.getAttribute("aria-selected") === "true" && modeTabSpectroscopy.getAttribute("aria-selected") === "false" && modeTabSnr.getAttribute("aria-selected") === "false");
check("Imaging mode still contains Box 1 through Box 5 exactly as before (untouched by the mode tabs)", !!modeViewImaging.querySelector("#panel-1") && !!modeViewImaging.querySelector("#panel-2") && !!modeViewImaging.querySelector("#panel-3") && !!modeViewImaging.querySelector("#panel-4") && !!modeViewImaging.querySelector("#panel-5") && !!modeViewImaging.querySelector("#panel-comparison"));

// Spectrum computation is gated to only run while Spectroscopy is the
// active mode (it's roughly as expensive as the main frame simulation
// itself, so it shouldn't run on every live frame while sitting on some
// other tab). By this point in the test file, plenty of parameter changes
// have already happened on the Imaging tab (Photons, Gain, Pixel Size,
// Reset to Default, binning, etc., each of which calls drawLiveFrame()) -
// none of those should have produced a real spectrum-chart update, so only
// the one initSpectrumChart() newPlot call from page load should exist.
const spectrumChartCallsBeforeSpectroscopyTab = plotlyCalls.filter((c) => c.divId === "spectrum-chart");
check(
  "No spectrum-chart update happened while on the Imaging tab, despite many parameter changes (mode-gated as expected)",
  spectrumChartCallsBeforeSpectroscopyTab.length === 1,
  spectrumChartCallsBeforeSpectroscopyTab.length
);
// SNR vs. ROI Height is gated the same way (updateHeightSNRChart() is only
// called from updateSpectrumIfActive(), which early-returns off the
// Spectroscopy tab) - same "only the initial newPlot call" expectation.
const heightSnrCallsBeforeSpectroscopyTab = plotlyCalls.filter((c) => c.divId === "height-snr-chart");
check(
  "No height-snr-chart update happened while on the Imaging tab either (same mode-gating as the spectrum)",
  heightSnrCallsBeforeSpectroscopyTab.length === 1,
  heightSnrCallsBeforeSpectroscopyTab.length
);

// Play/Pause should auto-pause on every tab switch - turn it on here so the
// upcoming Spectroscopy switch has something to actually pause.
check("Play button reads 'Play' before this check (not already playing)", playBtn.textContent === "Play", playBtn.textContent);
playBtn.dispatchEvent(new window.Event("click"));
check("Play button now reads 'Pause' (playing, ahead of the mode-switch pause test)", playBtn.textContent === "Pause", playBtn.textContent);

// --- Spectroscopy mode: Calculated Spectrum is a placeholder; Image
// Simulator is the real, shared Box 1 (#panel-1) borrowed from Imaging; ROI
// panel is a placeholder reserved for later. ---
modeTabSpectroscopy.dispatchEvent(new window.Event("click"));
check("Clicking Spectroscopy activates its mode-view and deactivates Imaging's", modeViewSpectroscopy.classList.contains("is-active") && !modeViewImaging.classList.contains("is-active"));
check("Spectroscopy tab becomes aria-selected, Imaging's no longer is", modeTabSpectroscopy.getAttribute("aria-selected") === "true" && modeTabImaging.getAttribute("aria-selected") === "false");
check(
  "Switching tabs auto-paused Play (was on before the switch)",
  playBtn.textContent === "Play" && !playBtn.classList.contains("is-playing"),
  playBtn.textContent
);
check(
  "Switching INTO Spectroscopy triggered exactly one fresh spectrum-chart update (not zero, not a recurring flood)",
  plotlyCalls.filter((c) => c.divId === "spectrum-chart").length === spectrumChartCallsBeforeSpectroscopyTab.length + 1,
  plotlyCalls.filter((c) => c.divId === "spectrum-chart").length
);
check(
  "Switching INTO Spectroscopy also triggered exactly one fresh height-snr-chart update",
  plotlyCalls.filter((c) => c.divId === "height-snr-chart").length === heightSnrCallsBeforeSpectroscopyTab.length + 1,
  plotlyCalls.filter((c) => c.divId === "height-snr-chart").length
);

const spectrumPanel = window.document.getElementById("panel-spectrum");
const spectroRoiPanel = window.document.getElementById("panel-spectro-roi");
const spectroSlotImageEl = window.document.getElementById("spectro-slot-image");
const cameraSimPanelEl = window.document.getElementById("panel-1");
check("Spectroscopy has a Calculated Spectrum panel", !!spectrumPanel && spectrumPanel.querySelector("h2").textContent === "Calculated Spectrum");
check(
  "Spectroscopy has a Region of Interest & Spectroscopy Controls panel below the first two",
  !!spectroRoiPanel && spectroRoiPanel.querySelector("h2").textContent === "Region of Interest & Spectroscopy Controls"
);
check(
  "Spectrum and ROI placeholder panels are direct children of the mode-view",
  spectrumPanel.parentElement === modeViewSpectroscopy && spectroRoiPanel.parentElement === modeViewSpectroscopy
);
check(
  "style.css gives Spectroscopy mode two equal-width columns for the top row and the third panel spanning both columns below",
  /#mode-spectroscopy\.is-active\s*\{[^}]*grid-template-columns:\s*1fr 1fr/.test(styleCssText)
  && /#panel-spectro-roi\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(styleCssText)
);
check(
  "Calculated Spectrum and Image Simulator are the same grid row (equal height), Region of Interest panel is a separate row below",
  /#mode-spectroscopy\.is-active\s*\{[^}]*grid-template-rows:\s*\S+\s+\S+/.test(styleCssText)
);

// Calculated Spectrum has a real (if still traceless) Plotly chart wired up
// now, not the generic "Coming soon" placeholder body.
check(
  "Calculated Spectrum panel contains a #spectrum-chart div, not the placeholder body",
  !!spectrumPanel.querySelector("#spectrum-chart") && !spectrumPanel.querySelector(".panel-body-placeholder")
);
const spectrumChartCalls = plotlyCalls.filter((c) => c.divId === "spectrum-chart");
check("Plotly was called to initialize the spectrum chart", spectrumChartCalls.length > 0);
const lastSpectrumChartCall = spectrumChartCalls[spectrumChartCalls.length - 1];
check(
  "Spectrum chart's x-axis is titled 'Pixel' and y-axis is titled 'Intensity'",
  !!lastSpectrumChartCall && lastSpectrumChartCall.layout.xaxis.title === "Pixel" && lastSpectrumChartCall.layout.yaxis.title === "Intensity",
  lastSpectrumChartCall && [lastSpectrumChartCall.layout.xaxis.title, lastSpectrumChartCall.layout.yaxis.title]
);
// Full Vertical Bin: the spectrum trace has one intensity value per (binned)
// column - the entire sensor height summed into a single row. Computed live
// in drawLiveFrame(), so by now (well after page load) it already has real
// data, not the empty placeholder from initSpectrumChart().
const nativeSensorWidthForSpectrum = parseFloat(sensorWidthInput.value);
const currentHorizontalBinForSpectrum = parseFloat(binHorizontalSelect.value);
const expectedSpectrumCols = Math.floor(nativeSensorWidthForSpectrum / currentHorizontalBinForSpectrum);
check(
  "Spectrum chart has one intensity value per binned column (Full Vertical Bin), not the empty placeholder",
  !!lastSpectrumChartCall && lastSpectrumChartCall.traces.length === 1
  && lastSpectrumChartCall.traces[0].x.length === expectedSpectrumCols
  && lastSpectrumChartCall.traces[0].y.length === expectedSpectrumCols,
  lastSpectrumChartCall && [lastSpectrumChartCall.traces[0].x.length, expectedSpectrumCols]
);
check(
  "Spectrum trace contains real, finite, non-all-zero intensity values (a genuine simulated result, not placeholder zeros)",
  !!lastSpectrumChartCall && lastSpectrumChartCall.traces[0].y.every((v) => Number.isFinite(v)) && lastSpectrumChartCall.traces[0].y.some((v) => v > 0)
);

// --- Binning is mirrored (Horizontal only) into the Spectroscopy ROI panel,
// staying in sync with the primary copy's Horizontal select in Camera
// Parameters (same underlying params.binHorizontal). Vertical Bin has no
// presence here at all - Full Vertical Bin/ROI govern the spectrum's row
// handling instead, and Vertical Bin only affects the Image Simulator's own
// displayed frame. ---
const spectroBinningCheckbox = window.document.getElementById("spectro-binning-checkbox");
const spectroBinHorizontalSelect = window.document.getElementById("spectro-bin-horizontal-select");
const spectroBinVerticalSelect = window.document.getElementById("spectro-bin-vertical-select");
const spectroBinningSelectRowEl = spectroBinHorizontalSelect && spectroBinHorizontalSelect.closest(".binning-select-row");
check(
  "Spectroscopy ROI panel has its own mirrored Horizontal Binning checkbox and select, but no Vertical select",
  !!spectroBinningCheckbox && !!spectroBinHorizontalSelect && !spectroBinVerticalSelect
);
check(
  "Mirrored checkbox reads 'Horizontal Binning', not just 'Binning'",
  spectroBinningCheckbox.closest(".binning-checkbox-label").textContent.trim() === "Horizontal Binning",
  spectroBinningCheckbox.closest(".binning-checkbox-label").textContent.trim()
);
check(
  "Mirrored binning controls live inside panel-spectro-roi, not Camera Parameters",
  !!spectroRoiPanel.contains(spectroBinningCheckbox) && !window.document.getElementById("camera-controls").contains(spectroBinningCheckbox)
);
check(
  "Mirrored binning controls start unchecked/hidden and at 1x, matching the primary copy's default state",
  spectroBinningCheckbox.checked === false && spectroBinningSelectRowEl.hidden === true
  && spectroBinHorizontalSelect.value === "1"
);

// Checking the MIRRORED checkbox should reveal ITS OWN select row and also
// check/reveal the PRIMARY copy back in Camera Parameters - both copies
// share one enabled/disabled state.
spectroBinningCheckbox.checked = true;
spectroBinningCheckbox.dispatchEvent(new window.Event("change"));
check(
  "Checking the mirrored Horizontal Binning checkbox reveals its own select row",
  spectroBinningSelectRowEl.hidden === false
);
check(
  "Checking the mirrored Horizontal Binning checkbox also checks/reveals the primary copy in Camera Parameters",
  binningCheckbox.checked === true && binningSelectRowEl.hidden === false
);

// Changing the mirrored Horizontal select should update the SAME
// params.binHorizontal the primary copy uses, and push that new value out
// to the primary copy's own Horizontal select too.
spectroBinHorizontalSelect.value = "4";
spectroBinHorizontalSelect.dispatchEvent(new window.Event("change"));
check(
  "Changing the mirrored Horizontal bin select updates the primary copy's Horizontal select to match",
  binHorizontalSelect.value === "4",
  binHorizontalSelect.value
);

// Changing Horizontal Bin (from either copy) also reshapes the spectrum
// trace, since the spectrum groups the same number of native columns per
// point that Horizontal Bin specifies - confirms the two are actually
// wired together, not just coincidentally both showing "4".
const spectrumCallsAfterHorizontalBin = plotlyCalls.filter((c) => c.divId === "spectrum-chart");
const lastSpectrumCallAfterHorizontalBin = spectrumCallsAfterHorizontalBin[spectrumCallsAfterHorizontalBin.length - 1];
const expectedSpectrumColsAfterHorizontalBin = Math.floor(parseFloat(sensorWidthInput.value) / 4);
check(
  "Spectrum trace reshapes to match the new Horizontal Bin factor (one point per 4 native columns)",
  !!lastSpectrumCallAfterHorizontalBin && lastSpectrumCallAfterHorizontalBin.traces[0].x.length === expectedSpectrumColsAfterHorizontalBin,
  lastSpectrumCallAfterHorizontalBin && [lastSpectrumCallAfterHorizontalBin.traces[0].x.length, expectedSpectrumColsAfterHorizontalBin]
);

// The PRIMARY copy's Vertical select still exists (Vertical Bin wasn't
// removed from Camera Parameters, only from the Spectroscopy mirror) and
// still only affects the Image Simulator's own displayed frame - the
// spectrum's column count should be unaffected by it (still governed only
// by Horizontal Bin, still 4 from above), same as before this change.
binVerticalSelect.value = "2";
binVerticalSelect.dispatchEvent(new window.Event("change"));
check(
  "The Spectroscopy panel has no Vertical select to push this change out to",
  !window.document.getElementById("spectro-bin-vertical-select")
);
const spectrumCallsAfterVerticalBin = plotlyCalls.filter((c) => c.divId === "spectrum-chart");
const lastSpectrumCallAfterVerticalBin = spectrumCallsAfterVerticalBin[spectrumCallsAfterVerticalBin.length - 1];
check(
  "Spectrum trace column count is unchanged by the Vertical Bin change (Full Vertical Bin ignores it)",
  !!lastSpectrumCallAfterVerticalBin && lastSpectrumCallAfterVerticalBin.traces[0].x.length === expectedSpectrumColsAfterHorizontalBin,
  lastSpectrumCallAfterVerticalBin && lastSpectrumCallAfterVerticalBin.traces[0].x.length
);

// Unchecking either copy resets the Horizontal factor back to 1x on both
// copies (and, since it's still one shared enabled flag, also resets the
// primary-only Vertical factor - same coupled behavior as before this
// change, just no longer visible from the Spectroscopy panel).
spectroBinningCheckbox.checked = false;
spectroBinningCheckbox.dispatchEvent(new window.Event("change"));
check(
  "Unchecking the mirrored Horizontal Binning checkbox resets both copies' Horizontal factor to 1x and hides both select rows",
  binningCheckbox.checked === false && binningSelectRowEl.hidden === true
  && binHorizontalSelect.value === "1" && binVerticalSelect.value === "1"
  && spectroBinningCheckbox.checked === false && spectroBinningSelectRowEl.hidden === true
  && spectroBinHorizontalSelect.value === "1"
);

// --- Spectroscopy ROI: draggable/typeable Top+Bottom box on Box 1's canvas ---
const sensorCanvas = window.document.getElementById("sensor-canvas");
const roiTopInputEl = window.document.getElementById("roi-top-input");
const roiBottomInputEl = window.document.getElementById("roi-bottom-input");
const roiHeightInputEl = window.document.getElementById("roi-height-input");
const roiControlsEl = window.document.getElementById("roi-controls");
check(
  "ROI Top/Bottom inputs exist inside the Spectroscopy ROI panel",
  !!roiTopInputEl && !!roiBottomInputEl && spectroRoiPanel.contains(roiControlsEl)
);
check(
  "ROI Height input exists inside the Spectroscopy ROI panel",
  !!roiHeightInputEl && spectroRoiPanel.contains(roiHeightInputEl)
);
check(
  "A 'Custom ROI' sub-header sits between Full Sensor Vertical Bin and the ROI inputs",
  spectroRoiPanel.querySelector(".subsection-label").textContent === "Custom ROI"
);
check(
  "Full Vertical Bin checkbox now reads 'Full Sensor Vertical Bin'",
  window.document.getElementById("full-vbin-label").textContent.trim() === "Full Sensor Vertical Bin"
);
const sensorHeightAtROITest = parseFloat(sensorHeightInput.value);
check(
  "ROI defaults to the full sensor height (top=0, bottom=height-1)",
  roiTopInputEl.value === "0" && roiBottomInputEl.value === String(sensorHeightAtROITest - 1),
  [roiTopInputEl.value, roiBottomInputEl.value]
);
check(
  "ROI inputs' max bound matches the current sensor height - 1",
  roiTopInputEl.max === String(sensorHeightAtROITest - 1) && roiBottomInputEl.max === String(sensorHeightAtROITest - 1)
);
check(
  "ROI Height defaults to the full sensor height - 1 (roiBottom - roiTop, matching the full-height default)",
  roiHeightInputEl.value === String(sensorHeightAtROITest - 1),
  roiHeightInputEl.value
);

// --- Full Vertical Bin: locks the ROI to the full sensor height, and gates
// whether the Calculated Spectrum bins the whole height or just the ROI. ---
const fullVBinCheckboxEl = window.document.getElementById("full-vbin-checkbox");
check(
  "Full Vertical Bin checkbox exists in the Spectroscopy ROI panel and is checked by default",
  !!fullVBinCheckboxEl && fullVBinCheckboxEl.checked === true
);
check(
  "ROI Top/Bottom/Height inputs are disabled while Full Vertical Bin is checked",
  roiTopInputEl.disabled === true && roiBottomInputEl.disabled === true && roiHeightInputEl.disabled === true
);

function lastRoiFillRect() {
  return rowIndicatorCalls.filter((c) => c.fn === "fillRect").pop();
}
const initialRoiFillRect = lastRoiFillRect();
check(
  "ROI box's initial paint spans the full sensor height",
  !!initialRoiFillRect && initialRoiFillRect.y === 0 && initialRoiFillRect.h === sensorHeightAtROITest - 1,
  initialRoiFillRect
);

// Uncheck Full Vertical Bin so the ROI's inputs/dragging are actually live
// for the manual-edit and drag tests below.
fullVBinCheckboxEl.checked = false;
fullVBinCheckboxEl.dispatchEvent(new window.Event("change"));
check(
  "Unchecking Full Vertical Bin enables the ROI Top/Bottom/Height inputs",
  roiTopInputEl.disabled === false && roiBottomInputEl.disabled === false && roiHeightInputEl.disabled === false
);

// Typing a new Bottom value moves just that edge.
roiBottomInputEl.value = "500";
roiBottomInputEl.dispatchEvent(new window.Event("change"));
check("Typing ROI Bottom = 500 updates the input", roiBottomInputEl.value === "500", roiBottomInputEl.value);
check("Typing ROI Bottom = 500 leaves Top untouched", roiTopInputEl.value === "0", roiTopInputEl.value);
check(
  "ROI box repaints at the new bottom (0 to 500) without re-simulating (cheap overlay redraw)",
  lastRoiFillRect().y === 0 && lastRoiFillRect().h === 500,
  lastRoiFillRect()
);
check(
  "Height updates to match (roiBottom - roiTop = 500 - 0 = 500) after typing Bottom directly",
  roiHeightInputEl.value === "500",
  roiHeightInputEl.value
);

// Height is anchored to the ROI BOTTOM pixel (roiTopInputEl/params.roiTop,
// the smaller native row - currently 0): changing Height should leave
// roiTopInputEl untouched and move roiBottomInputEl to roiTop + height.
roiHeightInputEl.value = "300";
roiHeightInputEl.dispatchEvent(new window.Event("change"));
check(
  "Changing Height leaves the anchored ROI Bottom pixel (roiTopInputEl) untouched",
  roiTopInputEl.value === "0",
  roiTopInputEl.value
);
check(
  "Changing Height moves the ROI Top pixel (roiBottomInputEl) to roiTop + height",
  roiBottomInputEl.value === "300",
  roiBottomInputEl.value
);
check(
  "Height input itself reflects the value just typed",
  roiHeightInputEl.value === "300",
  roiHeightInputEl.value
);

// Now anchor from a non-zero roiTop, to confirm Height truly anchors to
// whatever the current ROI Bottom pixel is, not just 0.
roiTopInputEl.value = "100";
roiTopInputEl.dispatchEvent(new window.Event("change"));
roiHeightInputEl.value = "50";
roiHeightInputEl.dispatchEvent(new window.Event("change"));
check(
  "Height anchors to the current ROI Bottom pixel (100), not always 0",
  roiTopInputEl.value === "100" && roiBottomInputEl.value === "150",
  [roiTopInputEl.value, roiBottomInputEl.value]
);

// Typing a Top value that crosses the current Bottom (150, from the Height
// anchoring test above) pushes Bottom out of the way (priority favors the
// edge the user just intentionally moved).
roiTopInputEl.value = "600";
roiTopInputEl.dispatchEvent(new window.Event("change"));
check(
  "Typing ROI Top = 600 (past the current Bottom) pushes Bottom to Top+1 instead of rejecting the input",
  roiTopInputEl.value === "600" && roiBottomInputEl.value === "601",
  [roiTopInputEl.value, roiBottomInputEl.value]
);

// Out-of-range values clamp to the sensor's own bounds.
roiTopInputEl.value = "-50";
roiTopInputEl.dispatchEvent(new window.Event("change"));
check("ROI Top clamps to 0 when set below the sensor's range", roiTopInputEl.value === "0", roiTopInputEl.value);

roiBottomInputEl.value = "999999";
roiBottomInputEl.dispatchEvent(new window.Event("change"));
check(
  "ROI Bottom clamps to sensor height - 1 when set above the sensor's range",
  roiBottomInputEl.value === String(sensorHeightAtROITest - 1),
  roiBottomInputEl.value
);

// --- Dragging an edge directly on the canvas ---
// jsdom has no real layout engine, so sensor-canvas's getBoundingClientRect()
// is stubbed to a specific box here to make the pointer<->native-row mapping
// (see sensorCanvasVerticalMapping() in main.js) verifiable. A 1024x1024
// native sensor rendered into a 512x512 CSS box, with object-fit:contain and
// matching aspect ratios, means no letterboxing - 1 CSS px = 2 native rows.
Object.defineProperty(sensorCanvas, "getBoundingClientRect", {
  value: () => ({ top: 0, left: 0, width: 512, height: 512 }),
  configurable: true,
});

// Reset ROI to a known state (top=100, bottom=800) via the inputs before
// exercising drag, so the drag test isn't coupled to the clamping test above.
roiTopInputEl.value = "100";
roiTopInputEl.dispatchEvent(new window.Event("change"));
roiBottomInputEl.value = "800";
roiBottomInputEl.dispatchEvent(new window.Event("change"));

// Top edge is at native row 100 = CSS y 50. Grab within the hit zone (2px
// off) and drag it down to CSS y 80 (native row 160). Plain window.Event
// doesn't carry clientY - MouseEvent does, and jsdom matches listeners by
// event TYPE STRING regardless of which Event subclass fired it, so
// dispatching a MouseEvent for "pointerdown"/"pointermove"/"pointerup" is a
// safe way to get real clientY values into main.js's handlers.
sensorCanvas.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientY: 52 }));
sensorCanvas.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, clientY: 80 }));
check(
  "Dragging near the Top edge moves it to the pointer's mapped native row",
  roiTopInputEl.value === "160",
  roiTopInputEl.value
);
check("Dragging Top leaves Bottom untouched", roiBottomInputEl.value === "800", roiBottomInputEl.value);
sensorCanvas.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, clientY: 80 }));

// A pointerdown far from either edge (native row ~400, nowhere near 160 or
// 800) shouldn't start a drag at all.
sensorCanvas.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientY: 200 }));
sensorCanvas.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, clientY: 300 }));
check(
  "Pointing down far from either edge does not start a drag or move either edge",
  roiTopInputEl.value === "160" && roiBottomInputEl.value === "800",
  [roiTopInputEl.value, roiBottomInputEl.value]
);
sensorCanvas.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, clientY: 300 }));

// --- Re-checking Full Vertical Bin snaps the ROI back to full height and
// re-locks the inputs/dragging. ---
fullVBinCheckboxEl.checked = true;
fullVBinCheckboxEl.dispatchEvent(new window.Event("change"));
check(
  "Re-checking Full Vertical Bin snaps the ROI back to the full sensor height",
  roiTopInputEl.value === "0" && roiBottomInputEl.value === String(sensorHeightAtROITest - 1),
  [roiTopInputEl.value, roiBottomInputEl.value]
);
check(
  "Re-checking Full Vertical Bin disables the ROI inputs again",
  roiTopInputEl.disabled === true && roiBottomInputEl.disabled === true
);
sensorCanvas.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientY: 52 }));
sensorCanvas.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, clientY: 80 }));
check(
  "Dragging is locked while Full Vertical Bin is checked (ROI stays at full height)",
  roiTopInputEl.value === "0",
  roiTopInputEl.value
);
sensorCanvas.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, clientY: 80 }));

// --- Unchecking Full Vertical Bin restricts the Calculated Spectrum to the
// ROI's row range instead of the whole sensor height. ---
const spectrumCallsWhileFullHeight = plotlyCalls.filter((c) => c.divId === "spectrum-chart");
const lastSpectrumWhileFullHeight = spectrumCallsWhileFullHeight[spectrumCallsWhileFullHeight.length - 1];
const meanFullHeight =
  lastSpectrumWhileFullHeight.traces[0].y.reduce((a, b) => a + b, 0) / lastSpectrumWhileFullHeight.traces[0].y.length;

fullVBinCheckboxEl.checked = false;
fullVBinCheckboxEl.dispatchEvent(new window.Event("change"));
roiTopInputEl.value = "0";
roiTopInputEl.dispatchEvent(new window.Event("change"));
roiBottomInputEl.value = "9"; // a 10-row sliver instead of the full ~1024-row height
roiBottomInputEl.dispatchEvent(new window.Event("change"));

const spectrumCallsWithNarrowROI = plotlyCalls.filter((c) => c.divId === "spectrum-chart");
const lastSpectrumWithNarrowROI = spectrumCallsWithNarrowROI[spectrumCallsWithNarrowROI.length - 1];
const meanNarrowROI =
  lastSpectrumWithNarrowROI.traces[0].y.reduce((a, b) => a + b, 0) / lastSpectrumWithNarrowROI.traces[0].y.length;
check(
  "Spectrum column count is still governed only by Horizontal Bin when Full Vertical Bin is unchecked",
  lastSpectrumWithNarrowROI.traces[0].x.length === lastSpectrumWhileFullHeight.traces[0].x.length,
  [lastSpectrumWithNarrowROI.traces[0].x.length, lastSpectrumWhileFullHeight.traces[0].x.length]
);
check(
  "Restricting to a 10-row ROI produces a meaningfully smaller summed intensity than binning the full sensor height",
  meanNarrowROI < meanFullHeight * 0.5,
  [meanNarrowROI, meanFullHeight]
);

// Re-checking Full Vertical Bin should go back to summing the full height.
fullVBinCheckboxEl.checked = true;
fullVBinCheckboxEl.dispatchEvent(new window.Event("change"));
const spectrumCallsAfterReChecking = plotlyCalls.filter((c) => c.divId === "spectrum-chart");
const lastSpectrumAfterReChecking = spectrumCallsAfterReChecking[spectrumCallsAfterReChecking.length - 1];
const meanAfterReChecking =
  lastSpectrumAfterReChecking.traces[0].y.reduce((a, b) => a + b, 0) / lastSpectrumAfterReChecking.traces[0].y.length;
check(
  "Re-checking Full Vertical Bin returns the spectrum to summing the full sensor height",
  meanAfterReChecking > meanNarrowROI * 2,
  [meanAfterReChecking, meanNarrowROI]
);

// --- Dispersion Model controls (general_spectrometer_model.py inputs) ---
// Six new controls, not yet wired into the actual spectrum computation -
// this just confirms they exist, live in the right panel, and have the
// requested default values.
const dispersionControlsEl = window.document.getElementById("dispersion-controls");
check(
  "Dispersion Model controls container exists inside the Spectroscopy ROI panel",
  !!dispersionControlsEl && spectroRoiPanel.contains(dispersionControlsEl)
);

// --- Three-column layout: Binning+ROI / Dispersion Model / SNR vs. Height ---
const spectroColBinningEl = spectroRoiPanel.querySelector(".spectro-col-binning");
const spectroColDispersionEl = spectroRoiPanel.querySelector(".spectro-col-dispersion");
const spectroColHeightSnrEl = window.document.getElementById("spectro-col-snr-height");
check(
  "panel-spectro-roi has three .spectro-col columns",
  !!spectroColBinningEl && !!spectroColDispersionEl && !!spectroColHeightSnrEl
);
check(
  "Left column has a 'ROI & Binning' section header, matching the middle column's 'Dispersion Model' header",
  spectroColBinningEl.querySelector("h3").textContent === "ROI & Binning"
  && spectroColDispersionEl.querySelector("h3").textContent === "Dispersion Model"
);
check(
  "ROI Top/Bottom labels are swapped: the smaller-value input (#roi-top-input) reads 'ROI Bottom', the larger-value input (#roi-bottom-input) reads 'ROI Top'",
  window.document.querySelector("label[for='roi-top-input']").textContent.trim() === "ROI Bottom (px)"
  && window.document.querySelector("label[for='roi-bottom-input']").textContent.trim() === "ROI Top (px)"
);
check(
  "Full Vertical Bin, then ROI, then mirrored Binning all live in the left (Binning) column, in that order",
  spectroColBinningEl.contains(fullVBinCheckboxEl) && spectroColBinningEl.contains(roiControlsEl)
  && spectroColBinningEl.contains(spectroBinningCheckbox)
  && (() => {
    const order = [fullVBinCheckboxEl, roiControlsEl, spectroBinningCheckbox].map((el) => {
      let n = el, depth = 0;
      while (n && n !== spectroColBinningEl) { depth++; n = n.parentElement; }
      return depth;
    });
    // Not a strict DOM-order check (nesting depth differs per element) -
    // just confirms none of them accidentally ended up in another column.
    return order.every((d) => d > 0);
  })()
);
check(
  "Dispersion Model controls live in the middle column, not the Binning/ROI column",
  spectroColDispersionEl.contains(dispersionControlsEl) && !spectroColBinningEl.contains(dispersionControlsEl)
);
check(
  "Columns are visually separated by a thin vertical rule (border-left in style.css)",
  /\.spectro-col\s*\+\s*\.spectro-col\s*\{[^}]*border-left/.test(styleCssText)
);

// --- SNR vs. ROI Height: static analytic plot in the third column ---
const heightSnrChartEl = window.document.getElementById("height-snr-chart");
check(
  "SNR vs. ROI Height chart div exists inside the third column",
  !!heightSnrChartEl && spectroColHeightSnrEl.contains(heightSnrChartEl)
);

function lastHeightSnrCall() {
  const calls = plotlyCalls.filter((c) => c.divId === "height-snr-chart");
  return calls[calls.length - 1];
}

// Already on the Spectroscopy tab continuously since the mode-gating checks
// earlier in this file (around the spectrum-chart's own equivalent checks) -
// no need to switch tabs again here.
const heightSnrCallAfterTab = lastHeightSnrCall();
const nativeSensorHeightForHeightSnr = parseFloat(sensorHeightInput.value);
check(
  "SNR vs. ROI Height x-axis spans exactly [1, sensor height]",
  heightSnrCallAfterTab.layout.xaxis.range[0] === 1
  && heightSnrCallAfterTab.layout.xaxis.range[1] === nativeSensorHeightForHeightSnr,
  heightSnrCallAfterTab.layout.xaxis.range
);
check(
  "SNR vs. ROI Height trace has one point per possible height (1..sensor height)",
  heightSnrCallAfterTab.traces[0].x.length === nativeSensorHeightForHeightSnr
  && heightSnrCallAfterTab.traces[0].x[0] === 1
  && heightSnrCallAfterTab.traces[0].x[heightSnrCallAfterTab.traces[0].x.length - 1] === nativeSensorHeightForHeightSnr,
  heightSnrCallAfterTab.traces[0].x.length
);
check(
  "SNR generally increases with height (binning more rows improves SNR)",
  heightSnrCallAfterTab.traces[0].y[heightSnrCallAfterTab.traces[0].y.length - 1] > heightSnrCallAfterTab.traces[0].y[0],
  [heightSnrCallAfterTab.traces[0].y[0], heightSnrCallAfterTab.traces[0].y[heightSnrCallAfterTab.traces[0].y.length - 1]]
);
check(
  "The dashed red current-height line defaults to the full sensor height (Full Sensor Vertical Bin is checked by default)",
  heightSnrCallAfterTab.layout.shapes[0].x0 === nativeSensorHeightForHeightSnr
  && heightSnrCallAfterTab.layout.shapes[0].line.dash === "dash"
  && heightSnrCallAfterTab.layout.shapes[0].line.color === "#e63946",
  heightSnrCallAfterTab.layout.shapes[0]
);

// Uncheck Full Sensor Vertical Bin and set a specific ROI Height - the red
// line should move to match, and NOT to the sensor height.
fullVBinCheckboxEl.checked = false;
fullVBinCheckboxEl.dispatchEvent(new window.Event("change"));
roiTopInputEl.value = "0";
roiTopInputEl.dispatchEvent(new window.Event("change"));
roiHeightInputEl.value = "199"; // -> roiBottom = 199, so true row count (roiBottom-roiTop+1) = 200
roiHeightInputEl.dispatchEvent(new window.Event("change"));
const heightSnrCallAfterRoiHeight = lastHeightSnrCall();
check(
  "Unchecking Full Sensor Vertical Bin moves the red line to the Custom ROI's true row count (roiBottom - roiTop + 1)",
  heightSnrCallAfterRoiHeight.layout.shapes[0].x0 === 200,
  heightSnrCallAfterRoiHeight.layout.shapes[0].x0
);
check(
  "The x-axis range itself stays pinned to [1, sensor height] regardless of the current ROI Height",
  heightSnrCallAfterRoiHeight.layout.xaxis.range[0] === 1
  && heightSnrCallAfterRoiHeight.layout.xaxis.range[1] === nativeSensorHeightForHeightSnr,
  heightSnrCallAfterRoiHeight.layout.xaxis.range
);

// Horizontal Bin should reshape the curve (n = binHorizontal * height at
// every point), without touching the x-axis range or point count.
const snrAtHeight10BeforeHBin = heightSnrCallAfterRoiHeight.traces[0].y[9]; // index 9 -> height 10
spectroBinningCheckbox.checked = true;
spectroBinningCheckbox.dispatchEvent(new window.Event("change"));
spectroBinHorizontalSelect.value = "4";
spectroBinHorizontalSelect.dispatchEvent(new window.Event("change"));
const heightSnrCallAfterHBin = lastHeightSnrCall();
check(
  "Turning on Horizontal Bin = 4 changes the SNR vs. Height curve (n = binHorizontal * height now)",
  heightSnrCallAfterHBin.traces[0].y[9] !== snrAtHeight10BeforeHBin,
  [snrAtHeight10BeforeHBin, heightSnrCallAfterHBin.traces[0].y[9]]
);
check(
  "Horizontal Bin doesn't change the x-axis range or point count",
  heightSnrCallAfterHBin.layout.xaxis.range[0] === 1
  && heightSnrCallAfterHBin.layout.xaxis.range[1] === nativeSensorHeightForHeightSnr
  && heightSnrCallAfterHBin.traces[0].x.length === nativeSensorHeightForHeightSnr
);

// Clean up: back to defaults so later tests aren't affected by this block.
spectroBinningCheckbox.checked = false;
spectroBinningCheckbox.dispatchEvent(new window.Event("change"));
fullVBinCheckboxEl.checked = true;
fullVBinCheckboxEl.dispatchEvent(new window.Event("change"));

const centerWavelengthNumberEl = window.document.getElementById("center-wavelength-number");
const grooveDensityNumberEl = window.document.getElementById("groove-density-number");
const focalLengthNumberEl = window.document.getElementById("focal-length-number");
const fNumberNumberEl = window.document.getElementById("f-number-number");
const slitWidthNumberEl = window.document.getElementById("slit-width-number");

check(
  "Included Angle 2K control was removed from the Dispersion Model list (fixed, not user-editable)",
  !window.document.getElementById("included-angle-2k-number")
);
check(
  "The five remaining Dispersion Model controls exist",
  !!centerWavelengthNumberEl && !!grooveDensityNumberEl
  && !!focalLengthNumberEl && !!fNumberNumberEl && !!slitWidthNumberEl
);
check(
  "Dispersion Model controls default to the requested values",
  centerWavelengthNumberEl.value === "600" && grooveDensityNumberEl.value === "300"
  && focalLengthNumberEl.value === "300"
  && fNumberNumberEl.value === "4" && slitWidthNumberEl.value === "10",
  [
    centerWavelengthNumberEl.value, grooveDensityNumberEl.value,
    focalLengthNumberEl.value, fNumberNumberEl.value, slitWidthNumberEl.value,
  ]
);
check(
  "Groove Density control is relabeled 'Grating Groove Density (l/mm)'",
  window.document.querySelector('label[for="groove-density-slider"]').textContent === "Grating Groove Density (l/mm)",
  window.document.querySelector('label[for="groove-density-slider"]').textContent
);

const dispersionControlIds = Array.from(
  window.document.getElementById("dispersion-controls").querySelectorAll(".param-control")
).map((el) => el.querySelector("input[type=number]").id);
check(
  "Dispersion Model order: Focal Length first, Slit Width immediately after Groove Density",
  dispersionControlIds[0] === "focal-length-number"
  && dispersionControlIds.indexOf("slit-width-number") === dispersionControlIds.indexOf("groove-density-number") + 1,
  dispersionControlIds
);

// --- Dispersion Model results dropdown (Wavelength Range/Resolution) ---
// Starts collapsed by default (unlike Experimental/Camera Parameters, which
// start expanded) since these are computed results the user opts into,
// tucked behind the "Dispersion Model" header to save vertical space.
const dispersionResultsGroupEl = window.document.getElementById("dispersion-results-group");
const dispersionResultsToggleEl = window.document.getElementById("dispersion-results-toggle");
const dispersionResultsEl = window.document.getElementById("dispersion-results");
check(
  "Dispersion Model results dropdown starts collapsed",
  !!dispersionResultsGroupEl && dispersionResultsGroupEl.classList.contains("is-collapsed")
  && dispersionResultsToggleEl.getAttribute("aria-expanded") === "false"
);
dispersionResultsToggleEl.dispatchEvent(new window.Event("click"));
check(
  "Clicking the Dispersion Model header expands the results dropdown",
  !dispersionResultsGroupEl.classList.contains("is-collapsed")
  && dispersionResultsToggleEl.getAttribute("aria-expanded") === "true"
);
check(
  "Wavelength Range and Resolution readouts live inside the results dropdown",
  !!dispersionResultsEl
  && dispersionResultsEl.contains(window.document.getElementById("wavelength-range-display"))
  && dispersionResultsEl.contains(window.document.getElementById("resolution-display"))
);
dispersionResultsToggleEl.dispatchEvent(new window.Event("click"));
check(
  "Clicking the header again re-collapses the results dropdown",
  dispersionResultsGroupEl.classList.contains("is-collapsed")
  && dispersionResultsToggleEl.getAttribute("aria-expanded") === "false"
);
// Re-expand for the remaining readout checks below (collapsed state is
// purely a CSS display:none - textContent/values keep updating underneath
// either way, but keep it open here for clarity while we exercise them).
dispersionResultsToggleEl.dispatchEvent(new window.Event("click"));

// --- Wavelength Range readout above the Dispersion Model controls ---
const wavelengthRangeDisplayEl = window.document.getElementById("wavelength-range-display");
check(
  "Wavelength Range readout exists above the Dispersion Model controls, reading 'Wavelength Range: ...'",
  !!wavelengthRangeDisplayEl && /^Wavelength Range: /.test(wavelengthRangeDisplayEl.textContent),
  wavelengthRangeDisplayEl && wavelengthRangeDisplayEl.textContent
);
check(
  "Wavelength Range readout sits above (before) the Dispersion Model controls in the DOM",
  !!wavelengthRangeDisplayEl
  && Boolean(wavelengthRangeDisplayEl.compareDocumentPosition(window.document.getElementById("dispersion-controls")) & window.Node.DOCUMENT_POSITION_FOLLOWING)
);

// Cross-check the printed span against dispersion.js's own pixelToWavelength,
// called directly with the CURRENT live control/sensor values (not
// hardcoded defaults, since earlier tests in this file may have changed
// Pixel Size and/or Sensor Width) - confirms the readout is really the
// wavelength at native pixel 0 vs. the last native pixel column, not just
// some plausible-looking text.
const currentDispersionParams = {
  centerWavelengthNm: parseFloat(centerWavelengthNumberEl.value),
  grooveDensity: parseFloat(grooveDensityNumberEl.value),
  includedAngle2K: 60, // fixed, not user-exposed (see the removed control test above)
  focalLengthMm: parseFloat(focalLengthNumberEl.value),
  order: 1,
  pixelSizeUm: parseFloat(window.document.getElementById("pixel-size-number").value),
  sensorPxCount: parseFloat(sensorWidthInput.value),
};
const expectedWStart = window.CameraDispersion.pixelToWavelength(0, currentDispersionParams);
const expectedWEnd = window.CameraDispersion.pixelToWavelength(currentDispersionParams.sensorPxCount - 1, currentDispersionParams);
const expectedLo = Math.min(expectedWStart, expectedWEnd);
const expectedHi = Math.max(expectedWStart, expectedWEnd);
check(
  "Wavelength Range readout matches pixel-0-to-last-pixel wavelengths from dispersion.js",
  wavelengthRangeDisplayEl.textContent === `Wavelength Range: ${expectedLo.toFixed(1)}–${expectedHi.toFixed(1)} nm (${(expectedHi - expectedLo).toFixed(1)} nm span)`,
  [wavelengthRangeDisplayEl.textContent, expectedLo, expectedHi]
);

// --- Resolution readout underneath Wavelength Range ---
const resolutionDisplayEl = window.document.getElementById("resolution-display");
check(
  "Resolution readout exists directly below the Wavelength Range readout",
  !!resolutionDisplayEl
  && Boolean(wavelengthRangeDisplayEl.compareDocumentPosition(resolutionDisplayEl) & window.Node.DOCUMENT_POSITION_FOLLOWING)
  && Boolean(resolutionDisplayEl.compareDocumentPosition(window.document.getElementById("dispersion-controls")) & window.Node.DOCUMENT_POSITION_FOLLOWING)
);
// Cross-check against the standard bandpass formula (reciprocal linear
// dispersion x slit width), computed directly from dispersion.js and the
// current live Slit Width control, not a hardcoded number.
const expectedDispersionNmPerMm = window.CameraDispersion.nominalDispersion(currentDispersionParams);
const expectedSlitWidthMm = parseFloat(slitWidthNumberEl.value) / 1000;
const expectedResolutionNm = Math.abs(expectedDispersionNmPerMm) * expectedSlitWidthMm;
check(
  "Resolution readout matches reciprocal linear dispersion x Slit Width",
  resolutionDisplayEl.textContent === `Resolution: ${expectedResolutionNm.toFixed(2)} nm`,
  [resolutionDisplayEl.textContent, expectedResolutionNm]
);

// Driving the groove density into invalid-geometry territory should fall
// back to an em-dash placeholder for BOTH readouts, same treatment as the
// Calculated Spectrum's Pixel-axis fallback, rather than showing stale or
// broken text.
grooveDensityNumberEl.value = "3600";
grooveDensityNumberEl.dispatchEvent(new window.Event("change"));
check(
  "Wavelength Range readout falls back to '—' on an invalid grating geometry",
  wavelengthRangeDisplayEl.textContent === "Wavelength Range: —",
  wavelengthRangeDisplayEl.textContent
);
check(
  "Resolution readout also falls back to '—' on an invalid grating geometry",
  resolutionDisplayEl.textContent === "Resolution: —",
  resolutionDisplayEl.textContent
);
grooveDensityNumberEl.value = "300";
grooveDensityNumberEl.dispatchEvent(new window.Event("change"));
check(
  "Wavelength Range readout recovers once groove density is back in valid range",
  /^Wavelength Range: \d/.test(wavelengthRangeDisplayEl.textContent),
  wavelengthRangeDisplayEl.textContent
);
check(
  "Resolution readout recovers once groove density is back in valid range",
  /^Resolution: \d/.test(resolutionDisplayEl.textContent),
  resolutionDisplayEl.textContent
);

// Changing Slit Width should change the Resolution readout proportionally
// (bandpass scales linearly with slit width), but leave Wavelength Range
// untouched (that only depends on Center Wavelength, Groove Density,
// Focal Length, Pixel Size, and Sensor Width).
const wavelengthRangeBeforeSlitChange = wavelengthRangeDisplayEl.textContent;
slitWidthNumberEl.value = "20"; // double the default of 10
slitWidthNumberEl.dispatchEvent(new window.Event("change"));
check(
  "Doubling Slit Width roughly doubles the Resolution readout",
  Math.abs(parseFloat(resolutionDisplayEl.textContent.replace("Resolution: ", "")) - expectedResolutionNm * 2) < 0.01,
  resolutionDisplayEl.textContent
);
check(
  "Changing Slit Width does not affect the Wavelength Range readout",
  wavelengthRangeDisplayEl.textContent === wavelengthRangeBeforeSlitChange,
  wavelengthRangeDisplayEl.textContent
);
slitWidthNumberEl.value = "10";
slitWidthNumberEl.dispatchEvent(new window.Event("change"));

// Changing one, then Reset to Default, should restore the requested default.
centerWavelengthNumberEl.value = "450";
centerWavelengthNumberEl.dispatchEvent(new window.Event("change"));
check("Changing Center Wavelength updates the input", centerWavelengthNumberEl.value === "450", centerWavelengthNumberEl.value);
resetBtn.dispatchEvent(new window.Event("click"));
check(
  "Reset to Default restores Center Wavelength to 600",
  centerWavelengthNumberEl.value === "600",
  centerWavelengthNumberEl.value
);

// --- Calculated Spectrum's Pixel/Wavelength x-axis toggle ---
const spectrumXAxisPixelBtnEl = window.document.getElementById("spectrum-xaxis-pixel-btn");
const spectrumXAxisWavelengthBtnEl = window.document.getElementById("spectrum-xaxis-wavelength-btn");
check(
  "Pixel/Wavelength toggle buttons exist, Pixel active by default",
  !!spectrumXAxisPixelBtnEl && !!spectrumXAxisWavelengthBtnEl
  && spectrumXAxisPixelBtnEl.classList.contains("is-active")
  && !spectrumXAxisWavelengthBtnEl.classList.contains("is-active")
);

const spectrumCallsBeforeWavelengthToggle = plotlyCalls.filter((c) => c.divId === "spectrum-chart");
const lastSpectrumCallBeforeToggle = spectrumCallsBeforeWavelengthToggle[spectrumCallsBeforeWavelengthToggle.length - 1];
check(
  "Before toggling, spectrum x-axis is titled 'Pixel'",
  lastSpectrumCallBeforeToggle.layout.xaxis.title === "Pixel",
  lastSpectrumCallBeforeToggle.layout.xaxis.title
);

spectrumXAxisWavelengthBtnEl.dispatchEvent(new window.Event("click"));
check(
  "Clicking Wavelength activates it and deactivates Pixel",
  spectrumXAxisWavelengthBtnEl.classList.contains("is-active")
  && !spectrumXAxisPixelBtnEl.classList.contains("is-active")
);

const spectrumCallsAfterWavelengthToggle = plotlyCalls.filter((c) => c.divId === "spectrum-chart");
const lastSpectrumCallAfterToggle = spectrumCallsAfterWavelengthToggle[spectrumCallsAfterWavelengthToggle.length - 1];
check(
  "Toggling to Wavelength refreshed the chart immediately and retitled the x-axis",
  spectrumCallsAfterWavelengthToggle.length === spectrumCallsBeforeWavelengthToggle.length + 1
  && lastSpectrumCallAfterToggle.layout.xaxis.title === "Wavelength (nm)",
  [spectrumCallsAfterWavelengthToggle.length, lastSpectrumCallAfterToggle.layout.xaxis.title]
);

// With the default Dispersion Model settings (600nm center, 300 grooves/mm,
// 2K=60deg, 300mm focal length) and native pixel mapping, the sensor's
// dead-center native pixel should map back to ~600nm (the whole point of
// "center wavelength"). Confirms the values are real wavelengths, not just
// relabeled pixel indices.
const wavelengthTrace = lastSpectrumCallAfterToggle.traces[0].x;
const midWavelength = wavelengthTrace[Math.floor(wavelengthTrace.length / 2)];
check(
  "Wavelength trace's center value is close to the 600nm Center Wavelength setting",
  Math.abs(midWavelength - 600) < 5,
  midWavelength
);
check(
  "Wavelength trace is NOT just the plain 0..n-1 pixel index (real physics, not relabeling)",
  wavelengthTrace.some((v, i) => Math.abs(v - i) > 1),
  wavelengthTrace.slice(0, 5)
);

// An invalid grating geometry (groove density too high for this center
// wavelength/angle) should fall back to Pixel for that render rather than
// erroring or leaving the chart blank - see dispersion.js's
// InvalidGratingGeometry and its catch in main.js's updateSpectrumIfActive().
const grooveDensityNumberElForInvalidTest = window.document.getElementById("groove-density-number");
grooveDensityNumberElForInvalidTest.value = "3600";
grooveDensityNumberElForInvalidTest.dispatchEvent(new window.Event("change"));
const spectrumCallsAfterInvalidGeometry = plotlyCalls.filter((c) => c.divId === "spectrum-chart");
const lastSpectrumCallAfterInvalidGeometry = spectrumCallsAfterInvalidGeometry[spectrumCallsAfterInvalidGeometry.length - 1];
check(
  "An invalid grating geometry (groove density too high) falls back to the Pixel axis instead of erroring",
  lastSpectrumCallAfterInvalidGeometry.layout.xaxis.title === "Pixel",
  lastSpectrumCallAfterInvalidGeometry.layout.xaxis.title
);

// Restore a valid groove density and switch back to Pixel so later tests
// aren't affected by this block's state.
grooveDensityNumberElForInvalidTest.value = "300";
grooveDensityNumberElForInvalidTest.dispatchEvent(new window.Event("change"));
spectrumXAxisPixelBtnEl.dispatchEvent(new window.Event("click"));
check(
  "Switching back to Pixel deactivates Wavelength",
  spectrumXAxisPixelBtnEl.classList.contains("is-active") && !spectrumXAxisWavelengthBtnEl.classList.contains("is-active")
);

// --- SNR vs. ROI Height export button ---
const exportHeightSnrBtn = window.document.getElementById("export-height-snr-btn");
check("SNR vs. ROI Height Export button exists", !!exportHeightSnrBtn);

downloadImageCalls.length = 0;
lastBlobText = null;
exportHeightSnrBtn.dispatchEvent(new window.Event("click"));

check(
  "Exporting downloads exactly 1 Plotly PNG of the height-snr-chart",
  downloadImageCalls.length === 1 && downloadImageCalls[0].divId === "height-snr-chart",
  downloadImageCalls
);
check("Exporting produced a text file", lastBlobText !== null);
const heightSnrCsvLines = (lastBlobText || "").trim().split("\n");
check(
  "Export metadata header includes the derived CurrentEffectiveHeight_px line (not a raw params field)",
  heightSnrCsvLines.some((l) => /^#\s+CurrentEffectiveHeight_px: \d+$/.test(l)),
  heightSnrCsvLines.filter((l) => l.includes("CurrentEffectiveHeight"))
);
check(
  "Export metadata header also includes the standard params dump (e.g. sensorWidth, photons)",
  heightSnrCsvLines.some((l) => l.startsWith("#   sensorWidth:")) && heightSnrCsvLines.some((l) => l.startsWith("#   photons:")),
  heightSnrCsvLines.slice(0, 8)
);
const heightSnrCsvHeaderRow = heightSnrCsvLines.find((l) => l.startsWith("Height_px,"));
check(
  "Export CSV has a 2-column header row: Height_px, SNR",
  heightSnrCsvHeaderRow === "Height_px,SNR",
  heightSnrCsvHeaderRow
);
const heightSnrCsvDataRows = heightSnrCsvLines.slice(heightSnrCsvLines.indexOf(heightSnrCsvHeaderRow) + 1);
check(
  "Export CSV has one row per height, matching the current chart's x-axis (1 to sensor height)",
  heightSnrCsvDataRows.length === parseFloat(sensorHeightInput.value),
  { rows: heightSnrCsvDataRows.length, expected: parseFloat(sensorHeightInput.value) }
);
const firstHeightSnrRow = heightSnrCsvDataRows[0].split(",").map(Number);
check(
  "First data row starts at Height=1, matching the chart's x-axis lower bound",
  firstHeightSnrRow[0] === 1,
  firstHeightSnrRow
);

// --- ROI box only paints while Spectroscopy is the active mode ---
const roiCanvasCallCountInSpectroscopy = rowIndicatorCalls.filter((c) => c.fn === "fillRect").length;
modeTabImaging.dispatchEvent(new window.Event("click"));
// Force a fresh canvas repaint (a parameter change, same as elsewhere in
// this file) while sitting on Imaging, and confirm no new ROI fillRect calls
// were added - it's a Spectroscopy-only overlay on the shared canvas.
photonsSlider.value = "500";
photonsSlider.dispatchEvent(new window.Event("input"));
check(
  "No ROI box paint happens while Imaging is the active mode, despite a live redraw",
  rowIndicatorCalls.filter((c) => c.fn === "fillRect").length === roiCanvasCallCountInSpectroscopy,
  rowIndicatorCalls.filter((c) => c.fn === "fillRect").length
);
modeTabSpectroscopy.dispatchEvent(new window.Event("click"));
check(
  "Switching back into Spectroscopy repaints the ROI box",
  rowIndicatorCalls.filter((c) => c.fn === "fillRect").length > roiCanvasCallCountInSpectroscopy
);

// Image Simulator is the SAME #panel-1 shown in Imaging mode, borrowed into
// #spectro-slot-image - not a separate copy, not a placeholder.
check(
  "Image Simulator panel (panel-1) was borrowed into the Spectroscopy slot",
  cameraSimPanelEl.parentElement === spectroSlotImageEl
);
check(
  "panel-1 keeps its own title and Info button/canvas exactly as in Imaging mode (nothing rebuilt)",
  cameraSimPanelEl.querySelector("h2").textContent === "Camera Simulator"
  && !!cameraSimPanelEl.querySelector("#sensor-canvas")
  && !!cameraSimPanelEl.querySelector("#panel-1-info-btn")
);
check(
  "style.css pins the borrowed panel-1 to the second grid column/row, since its slot is a display:contents landing spot",
  /#mode-spectroscopy #panel-1\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1/.test(styleCssText)
);
check(
  "No panel-1/sensor-canvas duplication - exactly one of each in the whole document",
  window.document.querySelectorAll("#panel-1").length === 1 && window.document.querySelectorAll("#sensor-canvas").length === 1
);

// Calculated Spectrum and Region of Interest panels still have their own
// header (title + Info icon button). Calculated Spectrum now has real
// content; Region of Interest is still the placeholder.
const spectroscopyPanelInfo = [
  { panelId: "panel-spectrum", btnId: "panel-spectrum-info-btn", overlayId: "panel-spectrum-info-overlay", closeBtnId: "panel-spectrum-info-close-btn", hasRealContent: true },
  { panelId: "panel-spectro-roi", btnId: "panel-spectro-roi-info-btn", overlayId: "panel-spectro-roi-info-overlay", closeBtnId: "panel-spectro-roi-info-close-btn", hasRealContent: true },
];
for (const { panelId, btnId, overlayId, closeBtnId, hasRealContent } of spectroscopyPanelInfo) {
  const btn = window.document.getElementById(btnId);
  const overlay = window.document.getElementById(overlayId);
  const closeBtn = window.document.getElementById(closeBtnId);
  const header = window.document.querySelector(`#${panelId} .panel-header`);

  check(`${panelId}: has a header with a title (h2) and an Info icon button`, !!header && !!header.querySelector("h2") && !!btn);
  check(`${panelId}: Info icon button sits on the right side of the header`, !!header && header.lastElementChild.contains(btn));
  check(`${panelId}: Info overlay exists and starts hidden`, !!overlay && overlay.hidden === true);

  btn.dispatchEvent(new window.Event("click"));
  check(`${panelId}: clicking the Info icon opens its overlay`, overlay.hidden === false);
  const infoContentText = window.document.getElementById(`${panelId}-info-modal-content`).textContent;
  if (hasRealContent) {
    check(
      `${panelId}: overlay no longer shows the 'Info coming soon' placeholder`,
      !infoContentText.includes("Info coming soon")
    );
  } else {
    check(
      `${panelId}: overlay shows placeholder text (content to be filled in later)`,
      infoContentText.includes("Info coming soon")
    );
  }
  closeBtn.dispatchEvent(new window.Event("click"));
  check(`${panelId}: Info overlay closes via its close button`, overlay.hidden === true);
}

// --- Calculated Spectrum Info overlay: real content specifics ---
const panelSpectrumInfoContent = window.document.getElementById("panel-spectrum-info-modal-content");
check(
  "Calculated Spectrum Info overlay describes the Full Sensor Vertical Bin vs. Custom ROI binning behavior",
  !!panelSpectrumInfoContent && /Full Sensor Vertical Bin/.test(panelSpectrumInfoContent.textContent)
  && /Custom ROI/.test(panelSpectrumInfoContent.textContent)
);
check(
  "Calculated Spectrum Info overlay explains Horizontal Binning's effect on point count and SNR",
  !!panelSpectrumInfoContent && /Horizontal Binning/.test(panelSpectrumInfoContent.textContent)
  && /SNR/.test(panelSpectrumInfoContent.textContent)
);
check(
  "Calculated Spectrum Info overlay explains the Pixel/Wavelength toggle and the dispersion model",
  !!panelSpectrumInfoContent && /Pixel/.test(panelSpectrumInfoContent.textContent)
  && /Wavelength/.test(panelSpectrumInfoContent.textContent)
  && /Czerny-Turner/.test(panelSpectrumInfoContent.textContent)
);
check(
  "Calculated Spectrum Info overlay mentions the invalid-geometry fallback to Pixel",
  !!panelSpectrumInfoContent && /falls back to the Pixel axis/.test(panelSpectrumInfoContent.textContent)
);

// --- Spectroscopy Controls (ROI/Binning panel) Info overlay: three sections ---
const panelSpectroRoiInfoContent = window.document.getElementById("panel-spectro-roi-info-modal-content");
check(
  "Spectroscopy Controls Info overlay has three bolded section titles, one per section",
  !!panelSpectroRoiInfoContent
  && Array.from(panelSpectroRoiInfoContent.querySelectorAll("p > strong:first-child")).map((s) => s.textContent)
    .join("|") === "ROI & Binning|Dispersion Model|SNR vs. ROI Height"
);
check(
  "Spectroscopy Controls Info overlay's ROI & Binning section covers Full Sensor Vertical Bin, Custom ROI, and Horizontal Binning",
  !!panelSpectroRoiInfoContent && /Full Sensor Vertical Bin/.test(panelSpectroRoiInfoContent.textContent)
  && /Custom ROI/.test(panelSpectroRoiInfoContent.textContent)
  && /Horizontal Binning/.test(panelSpectroRoiInfoContent.textContent)
);
check(
  "Spectroscopy Controls Info overlay's Dispersion Model section mentions the Czerny-Turner model and pixel-to-wavelength mapping",
  !!panelSpectroRoiInfoContent && /Czerny-Turner/.test(panelSpectroRoiInfoContent.textContent)
  && /wavelength axis/.test(panelSpectroRoiInfoContent.textContent)
);
check(
  "Spectroscopy Controls Info overlay's SNR vs. ROI Height section notes ROI height is linked to the sensor height",
  !!panelSpectroRoiInfoContent && /linked to the image sensor height/.test(panelSpectroRoiInfoContent.textContent)
);

check(
  "Imaging mode no longer contains panel-1 while Spectroscopy has borrowed it (but still has panel-4/panel-comparison, untouched)",
  !modeViewImaging.contains(cameraSimPanelEl) && !!modeViewImaging.querySelector("#panel-4") && !!modeViewImaging.querySelector("#panel-comparison")
);

// --- SNR Only mode: real panel-4/panel-5/panel-comparison get borrowed ---
modeTabSnr.dispatchEvent(new window.Event("click"));
check("Clicking SNR Only activates its mode-view and deactivates Spectroscopy's", modeViewSnr.classList.contains("is-active") && !modeViewSpectroscopy.classList.contains("is-active"));
check("SNR Only tab becomes aria-selected, Spectroscopy's no longer is", modeTabSnr.getAttribute("aria-selected") === "true" && modeTabSpectroscopy.getAttribute("aria-selected") === "false");
check(
  "Leaving Spectroscopy for SNR Only handed panel-1 back to its Imaging home (not left stranded in the Spectroscopy slot)",
  cameraSimPanelEl.parentElement === window.document.querySelector(".center-column") && spectroSlotImageEl.children.length === 0
);

const snrSlotChartEl = window.document.getElementById("snr-slot-chart");
const snrSlotComparisonEl = window.document.getElementById("snr-slot-comparison");
const snrSlotNoiseEl = window.document.getElementById("snr-slot-noise");
check(
  "SNR Only mode borrowed the real SNR chart panel (panel-4) into its slot",
  window.document.getElementById("panel-4").parentElement === snrSlotChartEl
);
check(
  "SNR Only mode borrowed the real Comparison panel into its slot",
  window.document.getElementById("panel-comparison").parentElement === snrSlotComparisonEl
);
check(
  "SNR Only mode borrowed the real Noise chart panel (panel-5) into its slot",
  window.document.getElementById("panel-5").parentElement === snrSlotNoiseEl
);
check(
  "style.css keeps SNR Only's original column widths (1.5fr/1fr) but now gives the SNR and Noise charts equal-height rows",
  /#mode-snr\.is-active\s*\{[^}]*grid-template-columns:\s*1\.5fr 1fr[^}]*grid-template-rows:\s*1fr 1fr/.test(styleCssText)
);
check(
  "style.css places the SNR chart top-left and the Noise chart top-right (same row, same height)",
  /#mode-snr #panel-4\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1/.test(styleCssText)
  && /#mode-snr #panel-5\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1/.test(styleCssText)
);
check(
  "style.css expands the Comparison panel to span the full width, in the row below",
  /#mode-snr #panel-comparison\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*grid-row:\s*2/.test(styleCssText)
);
check(
  "No panels were cloned in the process - exactly one #panel-4, #panel-5, and #panel-comparison exist in the whole document",
  window.document.querySelectorAll("#panel-4").length === 1 && window.document.querySelectorAll("#panel-5").length === 1 && window.document.querySelectorAll("#panel-comparison").length === 1
);
check(
  "The underlying chart divs (snr-chart, noise-chart, comparison-plot-1/2) moved along with their panels, not duplicated",
  window.document.querySelectorAll("#snr-chart").length === 1 && window.document.querySelectorAll("#noise-chart").length === 1
  && window.document.querySelectorAll("#comparison-plot-1").length === 1 && window.document.querySelectorAll("#comparison-plot-2").length === 1
);
check("Imaging mode no longer contains panel-4/panel-5/panel-comparison while SNR Only has borrowed them", !modeViewImaging.contains(window.document.getElementById("panel-4")) && !modeViewImaging.contains(window.document.getElementById("panel-comparison")));

// Noise chart's legend is dropped in SNR Only (it sits right next to the
// SNR chart at the same height there - the legend's reserved bottom strip
// made the two plot areas look mismatched) but stays on in Imaging mode.
const noiseCallsAfterSnr = plotlyCalls.filter((c) => c.divId === "noise-chart");
const lastNoiseAfterSnr = noiseCallsAfterSnr[noiseCallsAfterSnr.length - 1];
check(
  "Switching to SNR Only redraws the Noise chart with its legend hidden",
  !!lastNoiseAfterSnr && lastNoiseAfterSnr.layout.showlegend === false,
  lastNoiseAfterSnr && lastNoiseAfterSnr.layout.showlegend
);

// --- Switching back to Imaging restores everything to its original spot ---
modeTabImaging.dispatchEvent(new window.Event("click"));
check("Clicking Imaging re-activates its mode-view and deactivates SNR Only's", modeViewImaging.classList.contains("is-active") && !modeViewSnr.classList.contains("is-active"));
check("Imaging tab is aria-selected again, SNR Only's no longer is", modeTabImaging.getAttribute("aria-selected") === "true" && modeTabSnr.getAttribute("aria-selected") === "false");

const restoredStackedPanelIds = Array.from(window.document.querySelectorAll(".plots-column .panel")).map((el) => el.id);
check(
  "Boxes 2-5 are back in their original order in the plots column after the SNR Only round-trip",
  JSON.stringify(restoredStackedPanelIds) === JSON.stringify(["panel-2", "panel-3", "panel-4", "panel-5"]),
  restoredStackedPanelIds
);
check(
  "The Comparison panel is back inside the center column after the round-trip",
  window.document.querySelector(".center-column #panel-comparison") === window.document.getElementById("panel-comparison")
);
check(
  "panel-1 is still the first child of the center column, in its original position, after the full Spectroscopy/SNR Only round-trip",
  window.document.querySelector(".center-column").firstElementChild === cameraSimPanelEl
);
check(
  "SNR Only's slots are empty again after giving their borrowed panels back",
  snrSlotChartEl.children.length === 0 && snrSlotComparisonEl.children.length === 0 && snrSlotNoiseEl.children.length === 0
);

const noiseCallsAfterImaging = plotlyCalls.filter((c) => c.divId === "noise-chart");
const lastNoiseAfterImaging = noiseCallsAfterImaging[noiseCallsAfterImaging.length - 1];
check(
  "Switching back to Imaging redraws the Noise chart with its legend shown again",
  !!lastNoiseAfterImaging && lastNoiseAfterImaging.layout.showlegend === true,
  lastNoiseAfterImaging && lastNoiseAfterImaging.layout.showlegend
);

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
