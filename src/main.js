// main.js
// Wires everything together: builds the Box 6 controls, holds the current
// parameter state, and drives the "compute a frame" (physics.js) -> "draw a
// frame" (canvas.js / charts.js) pipeline.
//
// Panels 1-3 are the LIVE panels: they redraw either on every tick of the
// Play/Pause-gated loop, or once immediately after any parameter changes
// (so you see the effect right away even while paused). Their axis/color
// ranges are only RECOMPUTED when a parameter changes (refreshDisplayRanges);
// individual live frames reuse the cached range so the axes don't jitter
// from frame to frame as new random noise realizations come in.
//
// Panels 4-5 are STATIC: they only recompute when a parameter changes, never
// on the live-loop timer, since they're analytic curves over a photon-count
// sweep rather than a single simulated frame.

(function () {
  // Sensor width/height are user-adjustable (see the W x H inputs in Box 1's
  // header) so they live on `params` alongside the other simulation
  // parameters, rather than as fixed constants - `params.sensorWidth` and
  // `params.sensorHeight` are the single source of truth for sensor size.
  const SENSOR_WIDTH_MIN = 1024;
  const SENSOR_WIDTH_MAX = 5000;
  const SENSOR_HEIGHT_MIN = 1; // 1 = a line-scan sensor (a single row)
  const SENSOR_HEIGHT_MAX = 5000;
  const DEFAULT_SENSOR_WIDTH = 1024;
  const DEFAULT_SENSOR_HEIGHT = 1024;
  const LIVE_FRAME_INTERVAL_MS = 200; // ~5 fps; matches the notebook's animation interval
  const LINE_PROFILE_ROW_COLOR = "#00838f"; // must match LINE_PROFILE_COLOR in charts.js

  const Physics = window.CameraPhysics;
  const Colormap = window.CameraColormap;
  const CanvasR = window.CameraCanvas;
  const Charts = window.CameraCharts;
  const Controls = window.CameraControls;
  const Info = window.CameraInfo;
  const Exporters = window.CameraExporters;

  const lut = Colormap.buildInfernoLUT(256);

  // --- Parameter state -------------------------------------------------

  const DEFAULT_SENSOR_TYPE = "ccd";

  // Per-camera-type defaults, keyed by the same ids as the Camera Type
  // buttons. Photons is included here (even though it lives under
  // Experimental Parameters, not Camera Parameters) since it's just as
  // camera-type-dependent as the rest - a CCD and an InGaAs sensor are
  // typically operated at very different illumination levels. Applied in
  // full whenever a Camera Type button is clicked (see setSensorType()
  // below); CCD's set doubles as what "Reset to Default" restores.
  const SENSOR_TYPE_DEFAULTS = {
    ccd: { photons: 20, qe: 0.95, darkCurrent: 0.00013, readNoise: 2.9, fullWell: 100000, offset: 100, gain: 1, pixelSize: 13, bitDepth: 16 },
    scmos: { photons: 20, qe: 0.82, darkCurrent: 0.02, readNoise: 1.2, fullWell: 30000, offset: 100, gain: 1, pixelSize: 6.5, bitDepth: 16 },
    ingaas: { photons: 100, qe: 0.7, darkCurrent: 365, readNoise: 23, fullWell: 1400000, offset: 100, gain: 1, pixelSize: 15, bitDepth: 14 },
  };

  // Default values for the two experimental parameters that are NOT
  // camera-type-specific (Photons is - see SENSOR_TYPE_DEFAULTS above).
  const DEFAULT_PARAMS = {
    exposureTime: 1.0,
    spotRadius: 300,
  };

  const params = {
    // Sensor form factor
    sensorWidth: DEFAULT_SENSOR_WIDTH,
    sensorHeight: DEFAULT_SENSOR_HEIGHT,
    // Experimental
    photons: SENSOR_TYPE_DEFAULTS[DEFAULT_SENSOR_TYPE].photons,
    exposureTime: DEFAULT_PARAMS.exposureTime,
    spotRadius: DEFAULT_PARAMS.spotRadius,
    // Camera
    qe: SENSOR_TYPE_DEFAULTS[DEFAULT_SENSOR_TYPE].qe,
    darkCurrent: SENSOR_TYPE_DEFAULTS[DEFAULT_SENSOR_TYPE].darkCurrent,
    readNoise: SENSOR_TYPE_DEFAULTS[DEFAULT_SENSOR_TYPE].readNoise,
    fullWell: SENSOR_TYPE_DEFAULTS[DEFAULT_SENSOR_TYPE].fullWell,
    offset: SENSOR_TYPE_DEFAULTS[DEFAULT_SENSOR_TYPE].offset,
    gain: SENSOR_TYPE_DEFAULTS[DEFAULT_SENSOR_TYPE].gain,
    pixelSize: SENSOR_TYPE_DEFAULTS[DEFAULT_SENSOR_TYPE].pixelSize,
    bitDepth: SENSOR_TYPE_DEFAULTS[DEFAULT_SENSOR_TYPE].bitDepth,
    // EM Gain: CCD-only, off by default for every camera type (including on
    // load and after Reset to Default) - see cameraParamsForPhysics() below.
    emGainEnabled: false,
    emGain: 1,
    // Register Well Depth: CCD-only, used as the binned-charge clipping
    // ceiling in place of Full Well Depth once binning combines more than
    // one native pixel (see simulateBinnedFrame() in physics.js).
    registerWellDepth: 400000,
    // Binning: horizontal (column) and vertical (row) factors, independent
    // of each other, off (1x1) by default for every camera type.
    binHorizontal: 1,
    binVertical: 1,
  };

  // EM Gain (CCD-only): when enabled, physics.js is handed an *effective* QE
  // of (user's QE / 2) * EM Gain instead of the raw QE the user typed - the
  // displayed QE control/value itself is never touched. Since QE only ever
  // enters the pipeline at the "how many photoelectrons landed" step (the
  // very first thing computed, in both the Monte Carlo frame simulation and
  // the analytic SNR/noise curves), and everything downstream of that step
  // (dark current, read noise, offset, full-well clip, ADU conversion) is
  // completely unaware of QE, this one substitution is enough to get all of
  // the requested behavior with no changes to physics.js itself:
  //   - The photoelectron signal (photons x effective QE) is exactly what
  //     gets multiplied by EM Gain, per spec.
  //   - That multiplication necessarily happens before dark current/read
  //     noise/offset are summed in, since those are separate terms added
  //     afterward - satisfying "amplifying signal before read noise".
  //   - Shot noise's formula is untouched (still sqrt(signal) / still a
  //     Poisson draw on the mean signal) - it isn't a new/added noise term,
  //     it's the exact same calculation as always, just fed a bigger input.
  // Simplifications worth flagging: dark-current electrons are NOT
  // multiplied by EM Gain (the spec calls out only the photon-derived
  // signal), and real EMCCDs have an extra ~1.4x "excess noise factor" from
  // the stochastic multiplication process that this deliberately omits
  // (matching "keep shot noise the same").
  // The raw, unmodified per-pixel physics params - no EM Gain substitution.
  // Used as the "Single Pixel SNR" baseline on the SNR panel (see
  // updateStaticPanels below) so there's always a true, modifier-free
  // reference curve to compare against, regardless of what EM Gain/Binning
  // are currently set to.
  function rawParamsForPhysics() {
    return {
      exposureTime: params.exposureTime,
      qe: params.qe,
      darkCurrent: params.darkCurrent,
      readNoise: params.readNoise,
      offset: params.offset,
      fullWell: params.fullWell,
      registerWellDepth: params.registerWellDepth,
      gain: params.gain,
      bitDepth: params.bitDepth,
    };
  }

  function cameraParamsForPhysics() {
    const emGainActive = sensorType === "ccd" && params.emGainEnabled;
    const raw = rawParamsForPhysics();
    if (!emGainActive) return raw;
    return Object.assign({}, raw, { qe: (params.qe / 2) * params.emGain });
  }

  // --- Build Box 6 controls ---------------------------------------------

  const EXPERIMENTAL_PARAM_DEFS = [
    // Max is 5x the Full Well Depth slider's own max (200,000,000 e-), so a
    // user can actually drive the sensor into saturation (max QE + max
    // photons) instead of being capped well below the full-well ceiling.
    { key: "photons", id: "photons", label: "Photons", min: 1, max: 1000000000, scale: "log", value: params.photons },
    { key: "exposureTime", id: "exposure", label: "Exposure", unit: "s", min: 0.001, max: 3600, scale: "log", value: params.exposureTime },
    { key: "spotRadius", id: "spot-radius", label: "Spot Radius", unit: "px", min: 10, max: 500, scale: "linear", value: params.spotRadius },
  ];

  const CAMERA_PARAM_DEFS = [
    { key: "qe", id: "qe", label: "Quantum Efficiency", min: 0, max: 1, scale: "linear", step: 0.001, value: params.qe },
    { key: "darkCurrent", id: "dark-current", label: "Dark Current", unit: "e-/px/s", min: 0.0001, max: 5000000, scale: "log", value: params.darkCurrent },
    { key: "readNoise", id: "read-noise", label: "Read Noise", unit: "e- rms", min: 0.1, max: 10000, scale: "log", value: params.readNoise },
    { key: "fullWell", id: "full-well", label: "Full Well Depth", unit: "e-", min: 1000, max: 200000000, scale: "log", value: params.fullWell },
    { key: "offset", id: "offset", label: "Offset", unit: "e-", min: 0, max: 2000, scale: "linear", value: params.offset },
    { key: "gain", id: "gain", label: "Sensitivity", unit: "e-/ADU", min: 0.1, max: 50, scale: "log", value: params.gain },
    { key: "pixelSize", id: "pixel-size", label: "Pixel Size", unit: "µm", min: 1, max: 30, scale: "linear", step: 0.01, value: params.pixelSize },
  ];

  const experimentalContainer = document.getElementById("experimental-controls");
  const cameraContainer = document.getElementById("camera-controls");

  function onAnyParamChange(key, value) {
    params[key] = value;
    refreshDisplayRanges();  // parameters changed -> recompute + freeze new ranges
    drawLiveFrame();         // immediate feedback even while paused
    updateStaticPanels();
  }

  // Keep a handle to each slider-backed control so "Reset to Default" can
  // update both the visible slider/number and the underlying params object.
  const controlsByKey = {};

  for (const def of EXPERIMENTAL_PARAM_DEFS) {
    const control = Controls.createParamControl({
      id: def.id, label: def.label, min: def.min, max: def.max,
      value: def.value, scale: def.scale, step: def.step, unit: def.unit,
      onChange: (v) => onAnyParamChange(def.key, v),
    });
    controlsByKey[def.key] = control;
    experimentalContainer.appendChild(control.element);
  }

  for (const def of CAMERA_PARAM_DEFS) {
    const control = Controls.createParamControl({
      id: def.id, label: def.label, min: def.min, max: def.max,
      value: def.value, scale: def.scale, step: def.step, unit: def.unit,
      onChange: (v) => onAnyParamChange(def.key, v),
    });
    controlsByKey[def.key] = control;
    cameraContainer.appendChild(control.element);
  }

  // --- Register Well Depth (CCD-only camera parameter) --------------------
  // The charge-summing register's capacity, used in place of the per-pixel
  // Full Well Depth as the clipping ceiling once binning combines more than
  // one native pixel's charge together (see simulateBinnedFrame() in
  // physics.js). Bounds mirror Full Well Depth's own [1,000, 200,000,000]
  // range, scaled up 4x (a bin register is built to hold more charge than
  // any single native pixel could) - default 400,000 = 4x the CCD Full Well
  // Depth default. Hidden entirely for sCMOS/InGaAs, and reset to its
  // default every time a camera type is (re)selected, including Reset to
  // Default - same treatment as EM Gain below.
  //
  // Inserted directly below Full Well Depth (and above Offset) rather than
  // appended at the end, since it's conceptually the same kind of
  // "capacity" parameter and reads better sitting right next to it.

  const REGISTER_WELL_DEPTH_MIN = 1000;
  const REGISTER_WELL_DEPTH_MAX = 800000000;
  const REGISTER_WELL_DEPTH_DEFAULT = 400000;

  const registerWellDepthControl = Controls.createParamControl({
    id: "register-well-depth", label: "Register Well Depth", unit: "e-",
    min: REGISTER_WELL_DEPTH_MIN, max: REGISTER_WELL_DEPTH_MAX, scale: "log",
    value: REGISTER_WELL_DEPTH_DEFAULT,
    onChange: (v) => onAnyParamChange("registerWellDepth", v),
  });
  registerWellDepthControl.element.classList.add("register-well-depth-control");
  cameraContainer.insertBefore(registerWellDepthControl.element, controlsByKey["offset"].element);

  const bitDepthControl = Controls.createSelectControl({
    id: "bit-depth", label: "Bit Depth", options: [8, 10, 12, 14, 16], value: params.bitDepth,
    onChange: (v) => onAnyParamChange("bitDepth", v),
  });
  cameraContainer.appendChild(bitDepthControl.element);

  // --- Binning (checkbox-gated, in Camera Parameters - like EM Gain) ------
  // Horizontal (column) and vertical (row) bin factors, independent of each
  // other. Only 1/2/4/8 are offered right now, but the value itself is a
  // plain integer, not a hardcoded power-of-two enum - vertical binning is
  // expected to later grow into an arbitrary factor (up to the full sensor
  // height) for a spectroscopy mode, and nothing here needs to change for
  // that.
  //
  // Binning never changes the sensor's width/height - the field of view the
  // user set is exactly what's simulated and displayed. Instead, binning
  // changes how big the "super pixels" look: Physics.simulateBinnedFrame()
  // combines binHorizontal x binVertical native pixels into one output value
  // (the CCD "charge"/sCMOS-InGaAs "digital" split), and
  // CanvasR.renderSensorFrame() paints that value across the corresponding
  // binH x binV block of NATIVE pixels on a canvas that always stays at the
  // sensor's native width x height. If the sensor size isn't an exact
  // multiple of the bin factor, the leftover strip of native pixels at the
  // right/bottom edge (at most binFactor - 1 pixels wide) is drawn
  // unilluminated (dead/black) and excluded from the histogram/line-profile
  // stats, since it was never actually part of a complete, readable bin.
  //
  // Unlike EM Gain, Binning applies to every camera type - it's never
  // hidden by applySensorTypeDefaults(). A checkbox reveals the
  // Horizontal/Vertical selects when checked; unchecking resets both back
  // to 1x1. Resizing the sensor (Box 1's W/H inputs, see onSensorDimsChange
  // below) also resets bin factors to 1x1 AND unchecks this box, so a dead
  // strip only ever shows up as the direct result of a bin factor picked for
  // the sensor size currently on screen - never as a stale mismatch left
  // over from an earlier resize, and the checkbox never looks "on" while
  // doing nothing.
  //
  // Appended directly below Bit Depth, for every camera type.

  const BINNING_OPTIONS = [1, 2, 4, 8];

  const binningGroup = document.createElement("div");
  binningGroup.className = "param-control binning-control";
  binningGroup.id = "binning-group";

  const binningCheckboxLabel = document.createElement("label");
  binningCheckboxLabel.className = "binning-checkbox-label";
  const binningCheckbox = document.createElement("input");
  binningCheckbox.type = "checkbox";
  binningCheckbox.id = "binning-checkbox";
  binningCheckboxLabel.appendChild(binningCheckbox);
  binningCheckboxLabel.appendChild(document.createTextNode(" Binning"));
  binningGroup.appendChild(binningCheckboxLabel);

  const binningSelectRow = document.createElement("div");
  binningSelectRow.className = "binning-select-row";
  binningSelectRow.hidden = true;

  const horizontalBinControl = Controls.createSelectControl({
    id: "bin-horizontal", label: "Horizontal", options: BINNING_OPTIONS, value: params.binHorizontal,
    onChange: (v) => {
      params.binHorizontal = v;
      refreshDisplayRanges();
      drawLiveFrame();
      updateStaticPanels();
    },
  });
  binningSelectRow.appendChild(horizontalBinControl.element);

  const verticalBinControl = Controls.createSelectControl({
    id: "bin-vertical", label: "Vertical", options: BINNING_OPTIONS, value: params.binVertical,
    onChange: (v) => {
      params.binVertical = v;
      refreshDisplayRanges();
      drawLiveFrame();
      updateStaticPanels();
    },
  });
  binningSelectRow.appendChild(verticalBinControl.element);

  binningGroup.appendChild(binningSelectRow);
  cameraContainer.appendChild(binningGroup);

  function setBinningEnabled(enabled) {
    binningCheckbox.checked = enabled;
    binningSelectRow.hidden = !enabled;
    if (!enabled) {
      params.binHorizontal = 1;
      params.binVertical = 1;
      horizontalBinControl.setValue(1);
      verticalBinControl.setValue(1);
    }
  }

  binningCheckbox.addEventListener("change", () => {
    setBinningEnabled(binningCheckbox.checked);
    refreshDisplayRanges();
    drawLiveFrame();
    updateStaticPanels();
  });

  // --- EM Gain (CCD-only camera parameter) --------------------------------
  // A checkbox; checking it reveals an integer 1-1000 slider and switches on
  // the effective-QE substitution in cameraParamsForPhysics() above. Hidden
  // entirely for sCMOS/InGaAs (see applySensorTypeDefaults below), and reset
  // to off/1 every time a camera type is (re)selected, including Reset to
  // Default. Appended last so it always renders at the very bottom of the
  // Camera Parameters list for CCD.

  const EM_GAIN_MIN = 1;
  const EM_GAIN_MAX = 1000;
  const EM_GAIN_DEFAULT = 1;

  const emGainGroup = document.createElement("div");
  emGainGroup.className = "param-control em-gain-control";
  emGainGroup.id = "em-gain-group";

  const emGainCheckboxLabel = document.createElement("label");
  emGainCheckboxLabel.className = "em-gain-checkbox-label";
  const emGainCheckbox = document.createElement("input");
  emGainCheckbox.type = "checkbox";
  emGainCheckbox.id = "em-gain-checkbox";
  emGainCheckboxLabel.appendChild(emGainCheckbox);
  emGainCheckboxLabel.appendChild(document.createTextNode(" Enable EM Gain"));
  emGainGroup.appendChild(emGainCheckboxLabel);

  const emGainSliderControl = Controls.createParamControl({
    id: "em-gain", label: "EM Gain", min: EM_GAIN_MIN, max: EM_GAIN_MAX,
    value: EM_GAIN_DEFAULT, scale: "linear", step: 1,
    onChange: (v) => onAnyParamChange("emGain", Math.round(v)),
  });
  emGainSliderControl.element.hidden = true;
  emGainSliderControl.element.classList.add("em-gain-slider");
  emGainGroup.appendChild(emGainSliderControl.element);
  cameraContainer.appendChild(emGainGroup);

  emGainCheckbox.addEventListener("change", () => {
    params.emGainEnabled = emGainCheckbox.checked;
    emGainSliderControl.element.hidden = !emGainCheckbox.checked;
    refreshDisplayRanges();
    drawLiveFrame();
    updateStaticPanels();
  });

  // --- Camera Type (Box 6, above Experimental Parameters) -----------------
  // Clicking a button highlights it and immediately loads that camera's
  // full set of defaults (SENSOR_TYPE_DEFAULTS above) into every affected
  // slider/number control and params. CCD is selected and loaded on start
  // and whenever Reset to Default is clicked.

  const sensorTypeButtons = {
    ccd: document.getElementById("sensor-type-ccd-btn"),
    scmos: document.getElementById("sensor-type-scmos-btn"),
    ingaas: document.getElementById("sensor-type-ingaas-btn"),
  };
  let sensorType = DEFAULT_SENSOR_TYPE;

  function applySensorTypeDefaults(type) {
    const defaults = SENSOR_TYPE_DEFAULTS[type];
    for (const key of Object.keys(defaults)) {
      if (key === "bitDepth") continue; // discrete select control, handled separately below
      params[key] = defaults[key];
      const control = controlsByKey[key];
      if (control) control.setValue(defaults[key]);
    }
    params.bitDepth = defaults.bitDepth;
    bitDepthControl.setValue(defaults.bitDepth);

    // EM Gain is CCD-only: shown only for that type, and always reset to
    // off/1 on every camera-type switch (including re-selecting CCD, and
    // Reset to Default) rather than carried over between types.
    emGainGroup.hidden = type !== "ccd";
    params.emGainEnabled = false;
    params.emGain = EM_GAIN_DEFAULT;
    emGainCheckbox.checked = false;
    emGainSliderControl.setValue(EM_GAIN_DEFAULT);
    emGainSliderControl.element.hidden = true;

    // Register Well Depth is CCD-only, same treatment as EM Gain: shown only
    // for that type, and always reset to its default on every camera-type
    // switch (including re-selecting CCD, and Reset to Default).
    registerWellDepthControl.element.hidden = type !== "ccd";
    params.registerWellDepth = REGISTER_WELL_DEPTH_DEFAULT;
    registerWellDepthControl.setValue(REGISTER_WELL_DEPTH_DEFAULT);

    refreshDisplayRanges();
    drawLiveFrame();
    updateStaticPanels();
  }

  function setSensorType(type) {
    sensorType = type;
    for (const [key, btn] of Object.entries(sensorTypeButtons)) {
      btn.classList.toggle("is-active", key === type);
    }
    applySensorTypeDefaults(type);
  }

  for (const [key, btn] of Object.entries(sensorTypeButtons)) {
    btn.addEventListener("click", () => setSensorType(key));
  }

  // --- Reset to Default ---------------------------------------------------

  const resetDefaultsBtn = document.getElementById("reset-defaults-btn");
  resetDefaultsBtn.addEventListener("click", () => {
    // Non-camera-type-specific experimental params.
    for (const key of Object.keys(DEFAULT_PARAMS)) {
      params[key] = DEFAULT_PARAMS[key];
      const control = controlsByKey[key];
      if (control) control.setValue(DEFAULT_PARAMS[key]);
    }
    // Sensor width/height live in Box 1's header rather than among the
    // slider-backed controls above, so they're reset here explicitly.
    params.sensorWidth = DEFAULT_SENSOR_WIDTH;
    params.sensorHeight = DEFAULT_SENSOR_HEIGHT;
    sensorWidthInput.value = DEFAULT_SENSOR_WIDTH;
    sensorHeightInput.value = DEFAULT_SENSOR_HEIGHT;
    // Binning also lives outside the slider-backed controls loop above.
    setBinningEnabled(false);
    // CCD + its full defaults (Photons, QE, Dark Current, Read Noise, Full
    // Well Depth, Offset, Gain, Pixel Size, Bit Depth); this also triggers
    // the refresh/redraw, so it's called last.
    setSensorType(DEFAULT_SENSOR_TYPE);
  });

  // --- Panels 1-3: live sensor image, histogram, line profile ------------

  const sensorCanvas = document.getElementById("sensor-canvas");

  Charts.initHistogramChart("histogram-chart");
  Charts.initLineProfileChart("line-profile-chart");
  Charts.initSNRChart("snr-chart");
  Charts.initNoiseChart("noise-chart");

  // Cached, parameter-derived display range for panels 1-3. Only
  // recomputed by refreshDisplayRanges() (called on parameter change / init),
  // NOT on every live frame - so the axes/color scale stay put while Play is
  // running and only move when you actually change a parameter.
  let cachedRange = { vmin: 0, vmax: Math.pow(2, params.bitDepth) - 1 };
  let cachedHistYMax = params.sensorWidth * params.sensorHeight;

  // Last-drawn frame data, kept around so the Export button can save exactly
  // what's on screen without re-simulating (and without being affected by a
  // Play tick that might fire mid-export).
  let lastFrame = { histCenters: [], histCounts: [], rowData: new Float32Array(0) };

  // --- Histogram Linear/Log y-axis toggle (Panel 2 header) -----------------
  // A display preference, not a simulation parameter - like the Comparison
  // panel's legend-collapse toggle, it's not reset by Reset to Default.
  // Defaults to linear: the long tail of anti-aliased edge pixels between
  // the signal and background peaks (see makeCircularIllumination) is a tiny
  // population that a log axis exaggerates into a prominent staircase; on
  // linear it reads as the vanishingly small population it actually is.
  const histogramScaleToggleBtn = document.getElementById("histogram-scale-toggle-btn");
  let histogramYAxisType = "linear";

  function updateHistogramScaleToggleLabel() {
    // Follows the same convention as the Play/Pause button: the label names
    // the ACTION a click will take (i.e. the axis type you'd switch TO),
    // not the currently-active one.
    const label = histogramYAxisType === "linear"
      ? "Switch histogram to log y-axis"
      : "Switch histogram to linear y-axis";
    // Spelling out "Change to" avoids the confusing appearance of a button
    // reading just "Log" while a linear plot is already on screen (looks
    // like a state label rather than an action) - it should read
    // unambiguously as something to click.
    histogramScaleToggleBtn.textContent = histogramYAxisType === "linear" ? "Change to Log" : "Change to Linear";
    histogramScaleToggleBtn.setAttribute("aria-label", label);
    histogramScaleToggleBtn.title = label;
  }
  updateHistogramScaleToggleLabel();

  histogramScaleToggleBtn.addEventListener("click", () => {
    histogramYAxisType = histogramYAxisType === "linear" ? "log" : "linear";
    updateHistogramScaleToggleLabel();
    // Redraws the SAME already-computed bin centers/counts under the new
    // scale - no need to resimulate a frame just to flip the axis type.
    Charts.renderHistogramChart("histogram-chart", {
      centers: lastFrame.histCenters,
      counts: lastFrame.histCounts,
      vmin: cachedRange.vmin,
      vmax: cachedRange.vmax,
      yMax: cachedHistYMax,
      yAxisType: histogramYAxisType,
    });
  });

  // Binning readout mode: CCD combines charge on-chip before the single
  // read-noise draw ("charge"); sCMOS/InGaAs read each native pixel out
  // independently and sum digitally afterward ("digital"). See
  // Physics.simulateBinnedFrame() in physics.js for the full explanation.
  function currentBinningMode() {
    return sensorType === "ccd" ? "charge" : "digital";
  }

  function refreshDisplayRanges() {
    const photonMap = Physics.makeCircularIllumination(
      params.sensorHeight, params.sensorWidth, params.photons, params.spotRadius
    );
    const { adu } = Physics.simulateBinnedFrame(
      photonMap, params.sensorHeight, params.sensorWidth, cameraParamsForPhysics(),
      params.binHorizontal, params.binVertical, currentBinningMode()
    );
    const maxAdu = Math.pow(2, params.bitDepth) - 1;
    cachedRange = CanvasR.computeDisplayRange(adu, maxAdu);

    const bins = 80;
    const span = cachedRange.vmax - cachedRange.vmin || 1;
    const binWidth = span / bins;
    const counts = new Array(bins).fill(0);
    for (let i = 0; i < adu.length; i++) {
      let idx = Math.floor((adu[i] - cachedRange.vmin) / binWidth);
      if (idx < 0) idx = 0;
      else if (idx >= bins) idx = bins - 1;
      counts[idx]++;
    }
    cachedHistYMax = Math.max(...counts, 1) * 1.3;
  }

  function drawLiveFrame() {
    const photonMap = Physics.makeCircularIllumination(
      params.sensorHeight, params.sensorWidth, params.photons, params.spotRadius
    );
    const { adu, binnedRows, binnedCols } = Physics.simulateBinnedFrame(
      photonMap, params.sensorHeight, params.sensorWidth, cameraParamsForPhysics(),
      params.binHorizontal, params.binVertical, currentBinningMode()
    );
    const { vmin, vmax } = cachedRange;

    CanvasR.renderSensorFrame(
      sensorCanvas, adu, binnedRows, binnedCols, params.binHorizontal, params.binVertical,
      params.sensorHeight, params.sensorWidth, lut, vmin, vmax
    );

    // The indicator line/line-profile both key off the same BINNED middle
    // row; the line itself is drawn in NATIVE canvas coordinates (the canvas
    // always stays at native resolution - see renderSensorFrame above), so
    // its native row is that binned row's block, centered within the block.
    const binnedMiddleRow = Math.floor(binnedRows / 2);
    const nativeIndicatorRow = binnedMiddleRow * params.binVertical + Math.floor(params.binVertical / 2);
    CanvasR.drawRowIndicatorLine(sensorCanvas, nativeIndicatorRow, LINE_PROFILE_ROW_COLOR);

    const { centers, counts } = Charts.updateHistogramChart("histogram-chart", {
      adu, bins: 80, vmin, vmax, yMax: cachedHistYMax, yAxisType: histogramYAxisType,
    });

    const rowData = adu.subarray(binnedMiddleRow * binnedCols, (binnedMiddleRow + 1) * binnedCols);

    // The illuminated ("signal") portion of this row, in BINNED-pixel
    // coordinates: the illumination disc is defined in native-pixel space
    // (see makeCircularIllumination above), so its radius is scaled down by
    // the horizontal bin factor to land on the corresponding binned columns.
    const centerCol = Math.floor(binnedCols / 2);
    const binnedRadius = params.spotRadius / params.binHorizontal;
    const colStart = Math.max(0, Math.round(centerCol - binnedRadius));
    const colEnd = Math.min(binnedCols - 1, Math.round(centerCol + binnedRadius));
    let signalMean;
    if (colEnd > colStart) {
      let sum = 0;
      for (let i = colStart; i <= colEnd; i++) sum += rowData[i];
      signalMean = sum / (colEnd - colStart + 1);
    }

    Charts.updateLineProfileChart("line-profile-chart", { rowData, vmin, vmax, colStart, colEnd, signalMean });

    lastFrame = { histCenters: centers, histCounts: counts, rowData: Float32Array.from(rowData) };
  }

  // --- Panels 4-5: static SNR curve + noise contributions -----------------
  // Note: pixel size does NOT factor into this panel's SNR curve - it's a
  // single-camera view. Pixel-area normalization (pixelSize^2 / 13^2, for
  // comparing sensitivity across cameras with different pixel sizes under
  // the same illumination) will instead be applied later, at the point
  // where a curve is stored via the "Compare" button for the future Camera
  // Sensitivity Comparison feature - not on every live update here.
  //
  // The Noise Contributions panel (5) and the underlying per-pixel sweep
  // stay exactly as before - unaffected by binning, per the earlier decision
  // that those describe per-pixel sensor characteristics. What's new here is
  // the SNR panel (4) itself: whenever EM Gain and/or Binning are active, it
  // now shows TWO curves instead of one, so you can see the effect you're
  // configuring against an unmodified reference:
  //   - "Single Pixel SNR" (dashed): the true, unmodified single-pixel
  //     curve - raw QE, no EM Gain, no binning - via rawParamsForPhysics().
  //     Always the same regardless of EM Gain/Binning settings.
  //   - "Binned SNR" (solid): the actual current-settings curve. EM Gain
  //     (CCD-only) is folded in via cameraParamsForPhysics()'s existing
  //     effective-QE substitution (unchanged from before); binning is then
  //     layered on top via combineForBinning() below.
  // When neither EM Gain nor Binning is active, the two curves are
  // identical, so only the single (solid) curve is drawn - visually
  // unchanged from before this feature existed.

  // Combines n native pixels' worth of per-pixel signal/noise components
  // into one binned point, following the same two readout models as
  // Physics.simulateBinnedFrame() in physics.js:
  //   - "charge" (CCD): signal sums n-fold; shot/dark noise (each summed
  //     from n independent Poisson draws) grow by sqrt(n); read noise is a
  //     SINGLE draw per bin, so it does NOT scale with n at all.
  //   - "digital" (sCMOS/InGaAs): every term - shot, dark, AND read - scales
  //     by sqrt(n) uniformly (n independent full reads summed), which is
  //     algebraically identical to just multiplying the single-pixel SNR by
  //     sqrt(n).
  // With n = 1 both branches reduce exactly to the unbinned single-pixel
  // values, so this is safe to call unconditionally.
  function combineForBinning(signalArr, shotArr, darkArr, readArr, n, mode) {
    const len = signalArr.length;
    const signal = new Array(len);
    const snr = new Array(len);
    for (let i = 0; i < len; i++) {
      const s = n * signalArr[i];
      let noiseTotal;
      if (mode === "charge") {
        noiseTotal = Math.sqrt(n * shotArr[i] * shotArr[i] + n * darkArr[i] * darkArr[i] + readArr[i] * readArr[i]);
      } else {
        const singleNoiseTotal = Math.sqrt(shotArr[i] * shotArr[i] + darkArr[i] * darkArr[i] + readArr[i] * readArr[i]);
        noiseTotal = Math.sqrt(n) * singleNoiseTotal;
      }
      signal[i] = s;
      snr[i] = noiseTotal > 0 ? s / noiseTotal : 0;
    }
    return { signal, snr };
  }

  let lastStaticData = {
    photonRange: [], snr: [], activeSnr: [], modifierActive: false,
    noiseShot: [], noiseDark: [], noiseRead: [], noiseTotal: [],
  };

  function updateStaticPanels() {
    const camParams = cameraParamsForPhysics(); // raw, or EM-Gain-effective if active
    const photonMax = Math.max((params.fullWell / Math.max(params.qe, 1e-6)) * 2, 10);
    const nPoints = 200;
    const logMin = 0;
    const logMax = Math.log10(photonMax);
    const photonRange = new Array(nPoints);
    for (let i = 0; i < nPoints; i++) {
      photonRange[i] = Math.pow(10, logMin + ((logMax - logMin) * i) / (nPoints - 1));
    }

    const stats = Physics.analyticNoise(photonRange, camParams);

    const n = params.binHorizontal * params.binVertical;
    const mode = currentBinningMode();
    const modifierActive = (sensorType === "ccd" && params.emGainEnabled) || n > 1;

    // "Single Pixel SNR": the true, unmodified baseline - raw QE, no EM
    // Gain, no binning - computed fresh only when it can actually differ
    // from the effective curve above (i.e. only when EM Gain is active;
    // when it's not, camParams === raw params already, so reusing `stats`
    // avoids a redundant analyticNoise call).
    const baselineStats = (sensorType === "ccd" && params.emGainEnabled)
      ? Physics.analyticNoise(photonRange, rawParamsForPhysics())
      : stats;
    const snr = new Array(nPoints);
    for (let i = 0; i < nPoints; i++) {
      snr[i] = baselineStats.noise_total[i] > 0 ? baselineStats.signal_e[i] / baselineStats.noise_total[i] : 0;
    }

    // "Binned SNR": the actual current-settings curve - effective (EM
    // Gain-applied) per-pixel stats, combined across the active bin.
    const activeSnr = combineForBinning(stats.signal_e, stats.noise_shot, stats.noise_dark, stats.noise_read, n, mode).snr;

    const currentStats = Physics.analyticNoise([params.photons], camParams);
    const currentSNR = combineForBinning(
      currentStats.signal_e, currentStats.noise_shot, currentStats.noise_dark, currentStats.noise_read, n, mode
    ).snr[0];

    Charts.updateSNRChart("snr-chart", {
      photonRange, baselineSnr: snr, activeSnr, modifierActive, currentPhotons: params.photons, currentSNR,
    });

    Charts.updateNoiseChart("noise-chart", {
      photonRange,
      noiseShot: Array.from(stats.noise_shot),
      noiseDark: Array.from(stats.noise_dark),
      noiseRead: Array.from(stats.noise_read),
      noiseTotal: Array.from(stats.noise_total),
      currentPhotons: params.photons,
    });

    lastStaticData = {
      photonRange,
      snr,
      activeSnr,
      modifierActive,
      noiseShot: Array.from(stats.noise_shot),
      noiseDark: Array.from(stats.noise_dark),
      noiseRead: Array.from(stats.noise_read),
      noiseTotal: Array.from(stats.noise_total),
    };
  }

  // --- Camera Sensitivity Comparison panel --------------------------------
  // "Compare" (SNR panel header) snapshots the SNR panel's current curve
  // into this panel under a user-given name: as-is on the left plot, and
  // pixel-size-normalized (multiplied by pixelSize^2 / 13^2, same ratio as
  // the earlier per-camera toggle) on the right plot, so cameras with
  // different pixel sizes can be compared under equivalent illumination.
  // Both plots show only the bare SNR curve (no +/-1 noise band, no
  // current-point marker) since the point here is comparing shapes across
  // multiple saved cameras, not reading one camera's live noise margin.

  const COMPARISON_REFERENCE_PIXEL_SIZE_UM = 13;
  const COMPARISON_MAX_TRACES = 5; // cap to avoid cluttering the plots/legend
  const COMPARISON_PALETTE = [
    "#185FA5", "#e63946", "#0F6E56", "#c98a1f",
    "#7F77DD", "#8a3ea8", "#c04f8a", "#3aa6a0",
  ];

  const COMPARISON_PLOT_1_TITLE = "Signal-to-Noise";
  const COMPARISON_PLOT_1_X_TITLE = "Photons / Pixel";
  const COMPARISON_PLOT_2_TITLE = "Normalized SNR";
  const COMPARISON_PLOT_2_X_TITLE = "Photons / 13 µm Pixel";

  const compareBtn = document.getElementById("compare-btn");
  const comparisonLegendEl = document.getElementById("comparison-legend");
  const comparisonLegendWrap = document.getElementById("comparison-legend-wrap");
  const comparisonLegendToggle = document.getElementById("comparison-legend-toggle");

  let comparisonTraces = [];
  let comparisonIdCounter = 0;

  Charts.initComparisonChart("comparison-plot-1", { title: COMPARISON_PLOT_1_TITLE, xAxisTitle: COMPARISON_PLOT_1_X_TITLE });
  Charts.initComparisonChart("comparison-plot-2", { title: COMPARISON_PLOT_2_TITLE, xAxisTitle: COMPARISON_PLOT_2_X_TITLE });

  function renderComparisonCharts() {
    Charts.updateComparisonChart("comparison-plot-1", {
      title: COMPARISON_PLOT_1_TITLE,
      xAxisTitle: COMPARISON_PLOT_1_X_TITLE,
      traces: comparisonTraces.map((t) => ({ name: t.name, color: t.color, x: t.photonRange, y: t.snr })),
    });
    Charts.updateComparisonChart("comparison-plot-2", {
      title: COMPARISON_PLOT_2_TITLE,
      xAxisTitle: COMPARISON_PLOT_2_X_TITLE,
      traces: comparisonTraces.map((t) => ({ name: t.name, color: t.color, x: t.photonRange, y: t.snrNormalized })),
    });
    renderComparisonLegend();
  }

  // --- Trace legend collapse/expand ---------------------------------------
  // Hides just the trace list (a thin toggle strip stays clickable at the
  // same spot), letting both plots grow to fill the reclaimed width.
  let comparisonLegendCollapsed = false;

  function setComparisonLegendCollapsed(collapsed) {
    comparisonLegendCollapsed = collapsed;
    comparisonLegendWrap.classList.toggle("is-collapsed", collapsed);
    comparisonLegendToggle.textContent = collapsed ? "«" : "»"; // « to expand, » to collapse
    const label = collapsed ? "Show trace legend" : "Hide trace legend";
    comparisonLegendToggle.setAttribute("aria-label", label);
    comparisonLegendToggle.title = label;
    resizeComparisonPlots();
  }

  function resizeComparisonPlots() {
    // Plotly's responsive:true config only reacts to window resize events,
    // not container size changes from a CSS/layout change like this one, so
    // the plots need an explicit nudge to redraw at their new width.
    if (window.Plotly && window.Plotly.Plots && typeof window.Plotly.Plots.resize === "function") {
      window.Plotly.Plots.resize(document.getElementById("comparison-plot-1"));
      window.Plotly.Plots.resize(document.getElementById("comparison-plot-2"));
    }
  }

  comparisonLegendToggle.addEventListener("click", () => setComparisonLegendCollapsed(!comparisonLegendCollapsed));

  function renderComparisonLegend() {
    comparisonLegendEl.innerHTML = "";

    if (comparisonTraces.length === 0) {
      const empty = document.createElement("div");
      empty.className = "comparison-legend-empty";
      empty.textContent = "No saved traces yet. Click Compare in the SNR panel above to add one.";
      comparisonLegendEl.appendChild(empty);
      return;
    }

    for (const t of comparisonTraces) {
      const item = document.createElement("div");
      item.className = "comparison-legend-item";

      const swatch = document.createElement("span");
      swatch.className = "comparison-legend-swatch";
      swatch.style.backgroundColor = t.color;

      const name = document.createElement("span");
      name.className = "comparison-legend-name";
      name.textContent = t.name;
      name.title = t.name;

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "comparison-legend-delete";
      deleteBtn.textContent = "×";
      deleteBtn.setAttribute("aria-label", `Remove ${t.name}`);
      deleteBtn.addEventListener("click", () => {
        comparisonTraces = comparisonTraces.filter((tr) => tr.id !== t.id);
        renderComparisonCharts();
      });

      item.appendChild(swatch);
      item.appendChild(name);
      item.appendChild(deleteBtn);
      comparisonLegendEl.appendChild(item);
    }
  }

  compareBtn.addEventListener("click", () => {
    if (comparisonTraces.length >= COMPARISON_MAX_TRACES) {
      window.alert(`You can compare up to ${COMPARISON_MAX_TRACES} cameras at a time. Delete one from the legend before adding another.`);
      return;
    }

    const rawName = window.prompt("Name this trace for the Camera Sensitivity Comparison panel:");
    if (!rawName) return; // cancelled, dismissed, or left blank
    const name = rawName.trim();
    if (!name) return; // whitespace-only name - don't save an unlabeled trace

    const ratio = (params.pixelSize * params.pixelSize) / (COMPARISON_REFERENCE_PIXEL_SIZE_UM * COMPARISON_REFERENCE_PIXEL_SIZE_UM);
    const color = COMPARISON_PALETTE[comparisonIdCounter % COMPARISON_PALETTE.length];

    // Save whichever curve is currently ACTIVE on the SNR panel - the
    // current-settings curve (with EM Gain/Binning folded in) when either is
    // on, or the plain single-pixel curve when neither is active (the two
    // are identical in that case anyway). This is what the user is actually
    // configuring and wants to compare against other cameras; the unbinned
    // case is trivial for them to add separately if they want it too.
    const activeSnr = lastStaticData.modifierActive ? lastStaticData.activeSnr : lastStaticData.snr;

    comparisonTraces.push({
      id: comparisonIdCounter++,
      name,
      color,
      photonRange: lastStaticData.photonRange.slice(),
      snr: activeSnr.slice(),
      snrNormalized: activeSnr.map((v) => v * ratio),
    });

    renderComparisonCharts();
  });

  document.getElementById("export-comparison-btn").addEventListener("click", () => {
    Exporters.exportComparison({ comparisonTraces });
  });

  renderComparisonCharts();

  // --- Sensor dimensions (Box 1 header) -----------------------------------
  // Plain clamped number inputs rather than the slider controls used in Box
  // 6 - this is a form-factor choice made rarely, not something you'd drag a
  // slider to explore, and it lives in the header next to Export/Play rather
  // than among the other simulation parameters.

  const sensorWidthInput = document.getElementById("sensor-width-input");
  const sensorHeightInput = document.getElementById("sensor-height-input");

  function clampSensorDim(rawValue, min, max, fallback) {
    const n = Math.round(Number(rawValue));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  }

  function onSensorDimsChange() {
    params.sensorWidth = clampSensorDim(sensorWidthInput.value, SENSOR_WIDTH_MIN, SENSOR_WIDTH_MAX, params.sensorWidth);
    params.sensorHeight = clampSensorDim(sensorHeightInput.value, SENSOR_HEIGHT_MIN, SENSOR_HEIGHT_MAX, params.sensorHeight);
    sensorWidthInput.value = params.sensorWidth;
    sensorHeightInput.value = params.sensorHeight;
    // Resizing the sensor always resets binning back to 1x1 (and unchecks
    // the Binning checkbox - see the Binning section above) rather than
    // re-snapping the new size to whatever bin factors happened to be
    // active before.
    setBinningEnabled(false);
    refreshDisplayRanges();
    drawLiveFrame();
  }

  sensorWidthInput.addEventListener("change", onSensorDimsChange);
  sensorHeightInput.addEventListener("change", onSensorDimsChange);

  // --- Play / Pause loop for panels 1-3 ------------------------------------

  let isPlaying = false;
  let liveTimer = null;
  const playPauseBtn = document.getElementById("play-pause-btn");

  function setPlaying(playing) {
    isPlaying = playing;
    if (isPlaying) {
      playPauseBtn.textContent = "Pause";
      playPauseBtn.classList.add("is-playing");
      liveTimer = setInterval(drawLiveFrame, LIVE_FRAME_INTERVAL_MS);
    } else {
      playPauseBtn.textContent = "Play";
      playPauseBtn.classList.remove("is-playing");
      if (liveTimer) clearInterval(liveTimer);
      liveTimer = null;
    }
  }

  playPauseBtn.addEventListener("click", () => setPlaying(!isPlaying));

  // --- Info overlays (header + one per panel, all icon-only "i" buttons) --
  // Every Info button follows the same open/close/backdrop-click/Escape
  // wiring, so it's factored into one helper instead of repeating it per
  // overlay. Returns {open, close} in case a caller needs to trigger the
  // overlay itself (the header's does, to load its content asynchronously).
  function setupInfoOverlay(btnId, overlayId, closeBtnId) {
    const btn = document.getElementById(btnId);
    const overlay = document.getElementById(overlayId);
    const closeBtn = document.getElementById(closeBtnId);

    function open() {
      overlay.hidden = false;
    }
    function close() {
      overlay.hidden = true;
    }

    btn.addEventListener("click", open);
    closeBtn.addEventListener("click", close);

    // Clicking the dimmed backdrop (not the modal box itself) closes it too.
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    // Escape closes the overlay whenever it's open.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !overlay.hidden) close();
    });

    return { open, close };
  }

  // Header Info: content is loaded asynchronously from README.md (see
  // info.js), unlike every other overlay below, which has its content
  // written directly into the HTML.
  setupInfoOverlay("info-btn", "info-overlay", "info-close-btn");
  const infoModalContent = document.getElementById("info-modal-content");
  Info.loadInfoText().then((html) => {
    infoModalContent.innerHTML = html;
  });

  // Comparison panel Info: explains the Normalized SNR plot.
  setupInfoOverlay("comparison-info-btn", "comparison-info-overlay", "comparison-info-close-btn");

  // One Info overlay per Box 1-5 panel header, content to be filled in later
  // (each currently shows placeholder text - see index.html).
  setupInfoOverlay("panel-1-info-btn", "panel-1-info-overlay", "panel-1-info-close-btn");
  setupInfoOverlay("panel-2-info-btn", "panel-2-info-overlay", "panel-2-info-close-btn");
  setupInfoOverlay("panel-3-info-btn", "panel-3-info-overlay", "panel-3-info-close-btn");
  setupInfoOverlay("panel-4-info-btn", "panel-4-info-overlay", "panel-4-info-close-btn");
  setupInfoOverlay("panel-5-info-btn", "panel-5-info-overlay", "panel-5-info-close-btn");
  setupInfoOverlay("panel-6-info-btn", "panel-6-info-overlay", "panel-6-info-close-btn");

  // --- Collapsible parameter groups (Experimental/Camera Parameters) ------
  // Clicking the group's header row (chevron + h3) toggles a `.is-collapsed`
  // class on the group, which hides its .controls-list via CSS (see
  // style.css - deliberately NOT the `hidden` attribute, since
  // .controls-list already sets its own `display: grid`). Starts expanded,
  // same as every other collapse/toggle control in this app.
  function setupCollapsibleGroup(groupId, toggleBtnId) {
    const group = document.getElementById(groupId);
    const toggleBtn = document.getElementById(toggleBtnId);
    let collapsed = false;

    function setCollapsed(next) {
      collapsed = next;
      group.classList.toggle("is-collapsed", collapsed);
      toggleBtn.setAttribute("aria-expanded", String(!collapsed));
    }

    toggleBtn.addEventListener("click", () => setCollapsed(!collapsed));
  }

  setupCollapsibleGroup("experimental-group", "experimental-group-toggle");
  setupCollapsibleGroup("camera-group", "camera-group-toggle");

  // --- Export All button (Box 1) ----------------------------------------

  const exportBtn = document.getElementById("export-btn");
  exportBtn.addEventListener("click", () => {
    setPlaying(false); // pause so the exported frame matches what's on screen
    Exporters.exportAll({
      sensorCanvas,
      params,
      frame: lastFrame,
      staticData: lastStaticData,
    });
  });

  // --- Per-panel export buttons (Boxes 2-5) -------------------------------

  document.getElementById("export-histogram-btn").addEventListener("click", () => {
    Exporters.exportHistogram({ params, frame: lastFrame });
  });
  document.getElementById("export-line-btn").addEventListener("click", () => {
    Exporters.exportLineProfile({ params, frame: lastFrame });
  });
  document.getElementById("export-snr-btn").addEventListener("click", () => {
    Exporters.exportSNR({ params, staticData: lastStaticData });
  });
  document.getElementById("export-noise-btn").addEventListener("click", () => {
    Exporters.exportNoise({ params, staticData: lastStaticData });
  });

  // --- Initial render (paused by default) ----------------------------------

  refreshDisplayRanges();
  drawLiveFrame();
  updateStaticPanels();
  setPlaying(false);
})();
