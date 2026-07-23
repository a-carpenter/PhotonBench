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

// --- Stub window.prompt (jsdom doesn't implement it) for the Compare button ---
window.prompt = () => null;

// --- Stub window.alert (jsdom doesn't implement it) for the trace-cap warning ---
window.alert = () => {};

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
// 3. Info overlay (header button), replacing the old inline info text
// ============================================================================
// Info.loadInfoText() is awaited at load time in main.js; flush microtasks.
(async () => {
  await new Promise((r) => setTimeout(r, 20));
  const infoModalContentEl = window.document.getElementById("info-modal-content");
  const infoOverlayEl = window.document.getElementById("info-overlay");
  check("Info overlay exists in the DOM and starts hidden", !!infoOverlayEl && infoOverlayEl.hidden === true);
  check(
    "Info overlay content populates automatically with fallback text (since fetch is stubbed to fail)",
    infoModalContentEl.textContent.includes("PhotonBench"),
    infoModalContentEl.textContent.slice(0, 60)
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

  // ============================================================================
  // 6. Register Well Depth control (CCD-only) + binned-frame scaling laws
  // ============================================================================
  const registerWellDepthSlider = window.document.getElementById("register-well-depth-slider");
  const registerWellDepthNumber = window.document.getElementById("register-well-depth-number");
  check("Register Well Depth control exists", !!registerWellDepthSlider && !!registerWellDepthNumber);
  check("Register Well Depth defaults to 400000", Number(registerWellDepthNumber.value) === 400000, registerWellDepthNumber.value);

  const registerWellDepthWrapper = registerWellDepthSlider.closest(".param-control");
  check("Register Well Depth control is visible for CCD (default type)", registerWellDepthWrapper.hidden === false);

  window.document.getElementById("sensor-type-scmos-btn").dispatchEvent(new window.Event("click"));
  check("Register Well Depth control hides for sCMOS", registerWellDepthWrapper.hidden === true);
  window.document.getElementById("sensor-type-ccd-btn").dispatchEvent(new window.Event("click"));
  check("Register Well Depth control reappears for CCD", registerWellDepthWrapper.hidden === false);

  registerWellDepthNumber.value = "999999";
  registerWellDepthNumber.dispatchEvent(new window.Event("change"));
  window.document.getElementById("reset-defaults-btn").dispatchEvent(new window.Event("click"));
  check("Reset to Default restores Register Well Depth to 400000", Number(registerWellDepthNumber.value) === 400000, registerWellDepthNumber.value);

  // --- Binned-frame scaling laws, driven directly through Physics.simulateBinnedFrame ---
  // Read-noise-dominated regime (qe=0, darkCurrent=0) isolates the read-noise
  // term: a CCD bin takes exactly ONE read-noise draw no matter how many
  // native pixels it combines, so signalElectrons variance should stay flat
  // as n grows; sCMOS/InGaAs sum n INDEPENDENT reads, so variance should grow
  // proportionally to n (std grows as sqrt(n)).
  const Physics = window.CameraPhysics;
  const scalingParams = {
    exposureTime: 1, qe: 0, darkCurrent: 0, readNoise: 50, offset: 250,
    fullWell: 1e9, registerWellDepth: 1e9, gain: 1, bitDepth: 16,
  };
  const trials = 4000;
  const nativeRows = 4, nativeCols = 4;
  const flatPhotonMap = new Float64Array(nativeRows * nativeCols);

  function sampleVariance(binH, binV, mode) {
    const values = [];
    for (let t = 0; t < trials; t++) {
      const { signalElectrons } = Physics.simulateBinnedFrame(
        flatPhotonMap, nativeRows, nativeCols, scalingParams, binH, binV, mode
      );
      values.push(signalElectrons[0]);
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  }

  const ccdVar1 = sampleVariance(1, 1, "charge");
  const ccdVar4 = sampleVariance(2, 2, "charge");
  check(
    "CCD (charge-domain) binning: read-noise variance stays ~flat from 1x1 to 2x2 bin (single read draw per bin)",
    ccdVar4 > ccdVar1 * 0.6 && ccdVar4 < ccdVar1 * 1.6,
    { ccdVar1, ccdVar4, ratio: ccdVar4 / ccdVar1 }
  );

  const digitalVar1 = sampleVariance(1, 1, "digital");
  const digitalVar4 = sampleVariance(2, 2, "digital");
  check(
    "sCMOS/InGaAs (digital) binning: read-noise variance scales ~4x from 1x1 to 2x2 bin (n independent reads summed, std grows as sqrt(n))",
    digitalVar4 > digitalVar1 * 3 && digitalVar4 < digitalVar1 * 5.5,
    { digitalVar1, digitalVar4, ratio: digitalVar4 / digitalVar1 }
  );

  // --- Signal-domain (mean) scaling: strong signal, negligible noise -------
  // Stubbing Math.random to a fixed value forces poissonRandom()'s
  // normal-approximation branch (used whenever lambda >= 50, which is true
  // here since photons=1000, qe=1) to return an identical, deterministic
  // draw every call - this removes shot-noise's own ~3% run-to-run jitter
  // from the assertion, which was otherwise easily enough to blow past a
  // tight 4x tolerance and make this check flaky.
  const meanSignalParams = {
    exposureTime: 1, qe: 1, darkCurrent: 0, readNoise: 0.001, offset: 0,
    fullWell: 1e9, registerWellDepth: 1e9, gain: 1, bitDepth: 16,
  };
  const brightPhotonMap = new Float64Array(nativeRows * nativeCols).fill(1000);
  // physics.js runs inside the jsdom `window` realm (loaded via window.eval),
  // which has its own Math object distinct from this outer Node script's -
  // stub window.Math.random, not the bare global, or the override has no effect.
  const realRandom = window.Math.random;
  window.Math.random = () => 0.5;
  const { signalElectrons: ccdSignal1 } = Physics.simulateBinnedFrame(brightPhotonMap, nativeRows, nativeCols, meanSignalParams, 1, 1, "charge");
  const { signalElectrons: ccdSignal4 } = Physics.simulateBinnedFrame(brightPhotonMap, nativeRows, nativeCols, meanSignalParams, 2, 2, "charge");
  window.Math.random = realRandom;
  check(
    "CCD combined-charge signal for a 2x2 bin is ~4x a single native pixel's signal (linear in n)",
    Math.abs(ccdSignal4[0] / ccdSignal1[0] - 4) < 0.01,
    { single: ccdSignal1[0], binned: ccdSignal4[0], ratio: ccdSignal4[0] / ccdSignal1[0] }
  );

  // --- Register Well Depth clipping (CCD, binned charge only) --------------
  const clipParams = { ...meanSignalParams, registerWellDepth: 500 };
  const { signalElectrons: clippedSignal } = Physics.simulateBinnedFrame(brightPhotonMap, nativeRows, nativeCols, clipParams, 2, 2, "charge");
  check(
    "CCD binned charge is clipped to Register Well Depth once n > 1, not per-pixel Full Well Depth",
    clippedSignal[0] === 500,
    clippedSignal[0]
  );

  // --- Bit-depth ceiling clipping (sCMOS/InGaAs, digital sum) ---------------
  const bitDepthClipParams = { ...meanSignalParams, bitDepth: 4 }; // maxAdu = 15
  const { adu: digitalClippedAdu } = Physics.simulateBinnedFrame(brightPhotonMap, nativeRows, nativeCols, bitDepthClipParams, 2, 2, "digital");
  check(
    "sCMOS/InGaAs digitally-summed bin is clipped to the bit-depth ceiling",
    digitalClippedAdu[0] === 15,
    digitalClippedAdu[0]
  );

  // --- Canvas stays at native sensor size when binning is active (verifying main.js wiring, not just physics.js) ---
  const binHorizSelect = window.document.getElementById("bin-horizontal-select");
  const binVertSelect = window.document.getElementById("bin-vertical-select");
  const binningCheckboxEl = window.document.getElementById("binning-checkbox");
  const nativeWidth = parseInt(window.document.getElementById("sensor-width-input").value, 10);
  const nativeHeight = parseInt(window.document.getElementById("sensor-height-input").value, 10);
  binningCheckboxEl.checked = true;
  binningCheckboxEl.dispatchEvent(new window.Event("change"));
  binHorizSelect.value = "4";
  binHorizSelect.dispatchEvent(new window.Event("change"));
  binVertSelect.value = "2";
  binVertSelect.dispatchEvent(new window.Event("change"));
  const canvasEl = window.document.getElementById("sensor-canvas");
  check(
    "Sensor canvas stays at the full native sensor size (field of view unchanged) with a 4x2 bin active",
    canvasEl.width === nativeWidth && canvasEl.height === nativeHeight,
    { canvasWidth: canvasEl.width, canvasHeight: canvasEl.height, nativeWidth, nativeHeight }
  );
  check(
    "Selecting a bin factor did not change the sensor size inputs",
    parseInt(window.document.getElementById("sensor-width-input").value, 10) === nativeWidth &&
    parseInt(window.document.getElementById("sensor-height-input").value, 10) === nativeHeight
  );

  // Changing the sensor size resets binning back to 1x1.
  const widthInputEl = window.document.getElementById("sensor-width-input");
  widthInputEl.value = String(nativeWidth + 10);
  widthInputEl.dispatchEvent(new window.Event("change"));
  check(
    "Resizing the sensor resets Horizontal/Vertical bin back to 1x1",
    binHorizSelect.value === "1" && binVertSelect.value === "1",
    { horiz: binHorizSelect.value, vert: binVertSelect.value }
  );

  // ============================================================================
  // 8. Illumination edge anti-aliasing: boundary native pixels get a
  // fractional photon count (not just 0 or nPhotons), so a binned
  // super-pixel straddling the disc's edge gets a smoothly graded signal
  // instead of jumping in discrete "k of n lit sub-pixels" steps - which is
  // what was producing spurious extra populations in the histogram under
  // binning. Pure geometry, no randomness, so exact-value checks throughout.
  // ============================================================================
  const aaRows = 40, aaCols = 40, aaRadius = 10, aaPhotons = 1000;
  const aaMap = window.CameraPhysics.makeCircularIllumination(aaRows, aaCols, aaPhotons, aaRadius);
  const aaCenterY = Math.floor(aaRows / 2);
  const aaCenterX = Math.floor(aaCols / 2);

  check(
    "Illumination: a pixel well inside the disc is exactly nPhotons (unaffected by anti-aliasing)",
    aaMap[aaCenterY * aaCols + aaCenterX] === aaPhotons,
    aaMap[aaCenterY * aaCols + aaCenterX]
  );
  check(
    "Illumination: a pixel well outside the disc is exactly 0",
    aaMap[0 * aaCols + 0] === 0,
    aaMap[0 * aaCols + 0]
  );

  let aaFractionalCount = 0;
  let aaFullCount = 0;
  let aaZeroCount = 0;
  for (let i = 0; i < aaMap.length; i++) {
    if (aaMap[i] === 0) aaZeroCount++;
    else if (aaMap[i] === aaPhotons) aaFullCount++;
    else aaFractionalCount++;
  }
  check(
    "Illumination edge is anti-aliased: at least one boundary pixel has a fractional (neither 0 nor nPhotons) value",
    aaFractionalCount > 0,
    { aaFractionalCount, aaFullCount, aaZeroCount }
  );
  check(
    "Every fractional boundary value is strictly between 0 and nPhotons (a valid coverage fraction)",
    Array.from(aaMap).every((v) => v === 0 || v === aaPhotons || (v > 0 && v < aaPhotons))
  );

  // ============================================================================
  // 9. SNR panel "Binned SNR" trace obeys the correct scaling law per camera
  // type. analyticNoise() is a pure formula (no Math.random involved), so
  // these are checked with exact equality rather than a statistical sample.
  // ============================================================================
  function lastSNRCall() {
    return plotlyCalls.filter((c) => c.divId === "snr-chart").pop();
  }

  // sCMOS: every noise term (shot, dark, read) scales by sqrt(n) uniformly
  // for independent/digital readout, so Binned SNR should be EXACTLY sqrt(n)
  // times the Single Pixel baseline, at every point on the curve.
  window.document.getElementById("sensor-type-scmos-btn").dispatchEvent(new window.Event("click"));
  const scmosBinningCheckbox = window.document.getElementById("binning-checkbox");
  scmosBinningCheckbox.checked = true;
  scmosBinningCheckbox.dispatchEvent(new window.Event("change"));
  window.document.getElementById("bin-horizontal-select").value = "2";
  window.document.getElementById("bin-horizontal-select").dispatchEvent(new window.Event("change"));
  window.document.getElementById("bin-vertical-select").value = "2"; // n = 4
  window.document.getElementById("bin-vertical-select").dispatchEvent(new window.Event("change"));

  const scmosCall = lastSNRCall();
  const scmosBaseline = scmosCall.traces[2].y;
  const scmosActive = scmosCall.traces[3].y;
  const sqrtN = Math.sqrt(4);
  check(
    "sCMOS Binned SNR trace equals sqrt(n) x the Single Pixel baseline (n=4 bin)",
    scmosActive.every((v, i) => Math.abs(v - scmosBaseline[i] * sqrtN) < 1e-6 * Math.max(1, Math.abs(scmosBaseline[i] * sqrtN))),
    { sampleBaseline: scmosBaseline[100], sampleActive: scmosActive[100], expected: scmosBaseline[100] * sqrtN }
  );

  scmosBinningCheckbox.checked = false;
  scmosBinningCheckbox.dispatchEvent(new window.Event("change"));

  // CCD: shot/dark noise scale by sqrt(n), but read noise does NOT scale (a
  // single read per bin) - the Binned SNR trace should match the quadrature
  // combination formula, NOT a flat sqrt(n) (or n) multiplier of the baseline.
  window.document.getElementById("sensor-type-ccd-btn").dispatchEvent(new window.Event("click"));
  const ccdBinningCheckbox = window.document.getElementById("binning-checkbox");
  ccdBinningCheckbox.checked = true;
  ccdBinningCheckbox.dispatchEvent(new window.Event("change"));
  window.document.getElementById("bin-horizontal-select").value = "2";
  window.document.getElementById("bin-horizontal-select").dispatchEvent(new window.Event("change"));
  window.document.getElementById("bin-vertical-select").value = "2"; // n = 4
  window.document.getElementById("bin-vertical-select").dispatchEvent(new window.Event("change"));

  const ccdCall = lastSNRCall();
  const ccdBaselineSnr = ccdCall.traces[2].y;
  const ccdActiveSnr = ccdCall.traces[3].y;

  // Independently recompute the expected CCD-binned curve straight from
  // analyticNoise()'s components (reading the same params off the DOM main.js
  // is currently showing), to verify main.js's internal combination logic
  // against the formula rather than against itself.
  const ccdQe = Number(window.document.getElementById("qe-number").value);
  const ccdDarkCurrent = Number(window.document.getElementById("dark-current-number").value);
  const ccdReadNoise = Number(window.document.getElementById("read-noise-number").value);
  const ccdFullWell = Number(window.document.getElementById("full-well-number").value);
  const ccdOffset = Number(window.document.getElementById("offset-number").value);
  const ccdGain = Number(window.document.getElementById("gain-number").value);
  const ccdBitDepth = Number(window.document.getElementById("bit-depth-select").value);
  const ccdExposure = Number(window.document.getElementById("exposure-number").value);

  const ccdPhotonMax = Math.max((ccdFullWell / Math.max(ccdQe, 1e-6)) * 2, 10);
  const ccdNPoints = 200;
  const ccdLogMax = Math.log10(ccdPhotonMax);
  const ccdPhotonRange = new Array(ccdNPoints);
  for (let i = 0; i < ccdNPoints; i++) ccdPhotonRange[i] = Math.pow(10, (ccdLogMax * i) / (ccdNPoints - 1));

  const ccdRawParams = {
    exposureTime: ccdExposure, qe: ccdQe, darkCurrent: ccdDarkCurrent, readNoise: ccdReadNoise,
    offset: ccdOffset, fullWell: ccdFullWell, registerWellDepth: 1e9, gain: ccdGain, bitDepth: ccdBitDepth,
  };
  const ccdBaselineStats = window.CameraPhysics.analyticNoise(ccdPhotonRange, ccdRawParams);
  const nCcd = 4;
  const expectedCcdActive = ccdPhotonRange.map((_, i) => {
    const s = nCcd * ccdBaselineStats.signal_e[i];
    const noiseTotal = Math.sqrt(
      nCcd * ccdBaselineStats.noise_shot[i] * ccdBaselineStats.noise_shot[i] +
      nCcd * ccdBaselineStats.noise_dark[i] * ccdBaselineStats.noise_dark[i] +
      ccdBaselineStats.noise_read[i] * ccdBaselineStats.noise_read[i]
    );
    return noiseTotal > 0 ? s / noiseTotal : 0;
  });

  check(
    "CCD Binned SNR trace matches the quadrature-combine formula (shot/dark scale sqrt(n), read noise does not scale)",
    ccdActiveSnr.every((v, i) => Math.abs(v - expectedCcdActive[i]) < 1e-6 * Math.max(1, Math.abs(expectedCcdActive[i]))),
    { sampleActual: ccdActiveSnr[100], sampleExpected: expectedCcdActive[100] }
  );
  check(
    "CCD Binned SNR differs from a naive flat sqrt(n) multiply of the baseline (confirms it's not just a scalar)",
    !ccdActiveSnr.every((v, i) => Math.abs(v - ccdBaselineSnr[i] * Math.sqrt(nCcd)) < 1e-6 * Math.max(1, Math.abs(ccdBaselineSnr[i])))
  );

  window.document.getElementById("reset-defaults-btn").dispatchEvent(new window.Event("click"));

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`));
  process.exit(failures === 0 ? 0 : 1);
})();
