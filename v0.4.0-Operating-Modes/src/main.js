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
  const SENSOR_WIDTH_MIN = 500;
  const SENSOR_WIDTH_MAX = 5000;
  const SENSOR_HEIGHT_MIN = 1; // 1 = a line-scan sensor (a single row)
  const SENSOR_HEIGHT_MAX = 5000;
  const DEFAULT_SENSOR_WIDTH = 1024;
  const DEFAULT_SENSOR_HEIGHT = 1024;
  const LIVE_FRAME_INTERVAL_MS = 200; // ~5 fps; matches the notebook's animation interval
  const LINE_PROFILE_ROW_COLOR = "#00838f"; // must match LINE_PROFILE_COLOR in charts.js

  const Physics = window.CameraPhysics;
  const Dispersion = window.CameraDispersion;
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
    scmos: { photons: 20, qe: 0.82, darkCurrent: 0.02, readNoise: 1.2, fullWell: 30000, offset: 100, gain: 1.8, pixelSize: 6.5, bitDepth: 16 },
    ingaas: { photons: 100, qe: 0.7, darkCurrent: 365, readNoise: 23, fullWell: 1400000, offset: 100, gain: 100, pixelSize: 15, bitDepth: 14 },
  };

  // Default values for the two experimental parameters that are NOT
  // camera-type-specific (Photons is - see SENSOR_TYPE_DEFAULTS above).
  const DEFAULT_PARAMS = {
    exposureTime: 1.0,
    spotRadius: 300,
    // Dispersion Model (general_spectrometer_model.py port - see
    // Spectroscopy's "Dispersion Model" group below): a generic,
    // non-proprietary Czerny-Turner grating model. Not camera-type-specific,
    // same treatment as Exposure/Spot Radius above.
    centerWavelengthNm: 600,
    grooveDensity: 300,
    includedAngle2K: 60,
    focalLengthMm: 300,
    fNumber: 4,
    slitWidthUm: 10,
  };

  const params = {
    // Sensor form factor
    sensorWidth: DEFAULT_SENSOR_WIDTH,
    sensorHeight: DEFAULT_SENSOR_HEIGHT,
    // Experimental
    photons: SENSOR_TYPE_DEFAULTS[DEFAULT_SENSOR_TYPE].photons,
    exposureTime: DEFAULT_PARAMS.exposureTime,
    spotRadius: DEFAULT_PARAMS.spotRadius,
    // Dispersion Model (Spectroscopy) - see DEFAULT_PARAMS above.
    centerWavelengthNm: DEFAULT_PARAMS.centerWavelengthNm,
    grooveDensity: DEFAULT_PARAMS.grooveDensity,
    includedAngle2K: DEFAULT_PARAMS.includedAngle2K,
    focalLengthMm: DEFAULT_PARAMS.focalLengthMm,
    fNumber: DEFAULT_PARAMS.fNumber,
    slitWidthUm: DEFAULT_PARAMS.slitWidthUm,
    // Calculated Spectrum x-axis: "pixel" (raw column index, the original
    // behavior) or "wavelength" (computed live from the Dispersion Model
    // params above via dispersion.js). Not a slider-backed control - toggled
    // by the Pixel/Wavelength buttons on the panel header (see
    // setSpectrumXAxisMode() below).
    spectrumXAxisMode: "pixel",
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
    // Spectroscopy Region of Interest: the native pixel ROWS (inclusive)
    // that the ROI-restricted spectrum calculation uses when Full Vertical
    // Bin (below) is unchecked. Full sensor height by default (0 to
    // sensorHeight-1) - i.e. no restriction - reset back to full height any
    // time the sensor is resized, since a stale ROI from a previous sensor
    // size could otherwise fall outside the new one entirely.
    roiTop: 0,
    roiBottom: DEFAULT_SENSOR_HEIGHT - 1,
    // Full Vertical Bin: checked by default, meaning the Calculated Spectrum
    // bins the entire sensor height (the ROI box is locked to full height
    // while this is true). Unchecking it restricts the spectrum's binning
    // to just the ROI's row range instead.
    fullVerticalBin: true,
  };

  // EM Gain (CCD-only): the noise model now lives entirely in physics.js
  // (see the EM Gain block at the top of that file) - QE is NEVER touched
  // here. cameraParamsForPhysics() just passes the real QE straight through
  // plus emGainEnabled/emGain, and analyticNoise()/simulateSensor()/
  // simulateBinnedFrame() apply the F^2 excess-noise-on-shot/dark and
  // divide-read-noise-by-gain treatment internally, gated on those two
  // fields. (Earlier versions of this file computed a fake "effective QE" -
  // (QE/2) x EM Gain - and fed that into the ordinary no-EM-Gain formulas,
  // which incorrectly let shot noise scale up right along with the boosted
  // signal. That approach is retired.)
  //
  // The raw, unmodified per-pixel physics params - emGainEnabled explicitly
  // false, no EM Gain treatment at all. Used as the "Single Pixel SNR"
  // baseline on the SNR panel (see updateStaticPanels below) so there's
  // always a true, modifier-free reference curve to compare against,
  // regardless of what EM Gain/Binning are currently set to.
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
      emGainEnabled: false,
    };
  }

  function cameraParamsForPhysics() {
    const emGainActive = sensorType === "ccd" && params.emGainEnabled;
    return Object.assign({}, rawParamsForPhysics(), {
      emGainEnabled: emGainActive,
      emGain: params.emGain,
    });
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
    { key: "gain", id: "gain", label: "Sensitivity", unit: "e-/ADU", min: 0.1, max: 5000, scale: "log", value: params.gain },
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

  // --- Dispersion Model (Spectroscopy) -------------------------------------
  // Inputs to the general_spectrometer_model.py port - a generic,
  // non-proprietary Czerny-Turner grating dispersion/resolution model
  // (deliberately NOT one of Andor's or Teledyne's reverse-engineered,
  // manufacturer-specific models). These six are its parameters that aren't
  // already covered by an existing control (Pixel Size and the sensor's own
  // native pixel count are reused as-is from Camera Parameters/Box 1's
  // sensor width). Feed the Calculated Spectrum's Wavelength x-axis toggle
  // (see updateSpectrumIfActive() and the Pixel/Wavelength buttons on the
  // panel header) via dispersion.js's pixelToWavelength().
  //
  // Lives in the Spectroscopy tab's "Region of Interest & Spectroscopy
  // Controls" panel (panel-spectro-roi), in its own "Dispersion Model"
  // group, not Camera Parameters - these describe the spectrograph/grating,
  // not the sensor itself.
  const DISPERSION_PARAM_DEFS = [
    { key: "focalLengthMm", id: "focal-length", label: "Focal Length", unit: "mm", min: 50, max: 1000, scale: "linear", value: params.focalLengthMm },
    { key: "centerWavelengthNm", id: "center-wavelength", label: "Center Wavelength", unit: "nm", min: 200, max: 1100, scale: "linear", value: params.centerWavelengthNm },
    { key: "grooveDensity", id: "groove-density", label: "Grating Groove Density (l/mm)", min: 100, max: 3600, scale: "linear", value: params.grooveDensity },
    { key: "slitWidthUm", id: "slit-width", label: "Slit Width", unit: "µm", min: 1, max: 500, scale: "linear", value: params.slitWidthUm },
    { key: "fNumber", id: "f-number", label: "f-number", min: 1, max: 20, scale: "linear", step: 0.1, value: params.fNumber },
    // Included Angle 2K (includedAngle2K) is intentionally NOT exposed as a
    // control - it's a fixed geometry constant of the (simulated) spectrometer,
    // not something the user should be tuning. params.includedAngle2K keeps
    // its DEFAULT_PARAMS value (60 deg) untouched and is still passed into
    // Dispersion.pixelToWavelength() below.
  ];

  const dispersionContainer = document.getElementById("dispersion-controls");

  for (const def of DISPERSION_PARAM_DEFS) {
    const control = Controls.createParamControl({
      id: def.id, label: def.label, min: def.min, max: def.max,
      value: def.value, scale: def.scale, step: def.step, unit: def.unit,
      // These don't affect the main sensor frame at all (see comment above)
      // - only the Calculated Spectrum's Wavelength axis, when that's
      // selected - so this refreshes just the spectrum (like setROI() does
      // for ROI edits), not a full drawLiveFrame(). Harmless/no-op when the
      // Pixel axis is selected instead (updateSpectrumIfActive() still
      // recomputes the spectrum itself either way, just relabels nothing).
      onChange: (v) => { params[def.key] = v; updateSpectrumIfActive(); },
    });
    controlsByKey[def.key] = control;
    dispersionContainer.appendChild(control.element);
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
  // The Spectroscopy tab's Region of Interest & Spectroscopy Controls panel
  // (panel-spectro-roi) mirrors the HORIZONTAL half of this control only -
  // same underlying params.binHorizontal, same checkbox+select UI, just
  // relabeled "Horizontal Binning" and with no Vertical select at all (see
  // createBinningControls()'s `includeVertical` option below). Vertical Bin
  // only affects the Image Simulator's own displayed frame, never the
  // Calculated Spectrum, so it has no place in the Spectroscopy panel.
  // createBinningControls() is a small factory so both copies share the same
  // markup/classes/behavior (different element ids so both can coexist in
  // the DOM), and syncBinningControls() keeps every existing copy's
  // displayed state (checkbox + whichever selects it has) in lockstep
  // whenever any one of them changes.
  //
  // The primary copy is appended directly below Bit Depth, for every camera
  // type; the mirrored copy is appended into panel-spectro-roi below.

  const BINNING_OPTIONS = [1, 2, 4, 8];
  const binningControlInstances = [];

  // `includeVertical: false` (used by the Spectroscopy copy below) omits
  // the Vertical select entirely and relabels the checkbox "Horizontal
  // Binning" - Vertical Bin only affects the Image Simulator's own displayed
  // frame, never the Calculated Spectrum (which uses Full Vertical Bin/ROI
  // instead - see updateSpectrumIfActive()), so it has no reason to appear
  // in the Spectroscopy panel. The Horizontal factor itself is still the
  // exact same shared params.binHorizontal as the primary copy - only the
  // Vertical piece is left out of this copy's UI.
  function createBinningControls(idPrefix, { includeVertical = true, checkboxText = "Binning" } = {}) {
    const group = document.createElement("div");
    group.className = "param-control binning-control";
    group.id = `${idPrefix}binning-group`;

    const checkboxLabel = document.createElement("label");
    checkboxLabel.className = "binning-checkbox-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `${idPrefix}binning-checkbox`;
    checkboxLabel.appendChild(checkbox);
    checkboxLabel.appendChild(document.createTextNode(` ${checkboxText}`));
    group.appendChild(checkboxLabel);

    const selectRow = document.createElement("div");
    selectRow.className = "binning-select-row";
    if (!includeVertical) selectRow.classList.add("binning-select-row-single");
    selectRow.hidden = true;

    const horizontalControl = Controls.createSelectControl({
      id: `${idPrefix}bin-horizontal`, label: "Horizontal", options: BINNING_OPTIONS, value: params.binHorizontal,
      onChange: (v) => {
        params.binHorizontal = v;
        syncBinningControls();
        refreshDisplayRanges();
        drawLiveFrame();
        updateStaticPanels();
      },
    });
    selectRow.appendChild(horizontalControl.element);

    let verticalControl = null;
    if (includeVertical) {
      verticalControl = Controls.createSelectControl({
        id: `${idPrefix}bin-vertical`, label: "Vertical", options: BINNING_OPTIONS, value: params.binVertical,
        onChange: (v) => {
          params.binVertical = v;
          syncBinningControls();
          refreshDisplayRanges();
          drawLiveFrame();
          updateStaticPanels();
        },
      });
      selectRow.appendChild(verticalControl.element);
    }

    group.appendChild(selectRow);

    checkbox.addEventListener("change", () => {
      setBinningEnabled(checkbox.checked);
      refreshDisplayRanges();
      drawLiveFrame();
      updateStaticPanels();
    });

    const instance = { checkbox, selectRow, horizontalControl, verticalControl };
    binningControlInstances.push(instance);
    return { element: group, ...instance };
  }

  // Whether Binning is checked at all - tracked separately from the bin
  // factors themselves (checking the box is what REVEALS the Horizontal/
  // Vertical selects; picking non-1 factors happens afterward, so this can't
  // just be inferred from binHorizontal/binVertical > 1 without breaking
  // that check-then-choose sequence).
  let binningEnabled = false;

  // Pushes the current enabled state and params.binHorizontal/binVertical
  // out to every registered copy's UI - called after any one copy changes a
  // value, so all copies always agree.
  function syncBinningControls() {
    for (const c of binningControlInstances) {
      c.checkbox.checked = binningEnabled;
      c.selectRow.hidden = !binningEnabled;
      c.horizontalControl.setValue(params.binHorizontal);
      if (c.verticalControl) c.verticalControl.setValue(params.binVertical);
    }
  }

  function setBinningEnabled(enabled) {
    binningEnabled = enabled;
    if (!enabled) {
      params.binHorizontal = 1;
      params.binVertical = 1;
    }
    syncBinningControls();
  }

  const primaryBinningControls = createBinningControls("");
  cameraContainer.appendChild(primaryBinningControls.element);

  const spectroBinningControls = createBinningControls("spectro-", {
    includeVertical: false,
    checkboxText: "Horizontal Binning",
  });
  document.getElementById("spectro-binning-container").appendChild(spectroBinningControls.element);

  // --- EM Gain (CCD-only camera parameter) --------------------------------
  // A checkbox; checking it reveals an integer 1-1000 slider and switches on
  // the EM Gain noise treatment in physics.js (via cameraParamsForPhysics()'s
  // emGainEnabled/emGain fields above). Hidden
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
    // ROI bounds/inputs are derived from sensor height and won't otherwise
    // pick up the reset above (this handler sets params.sensorHeight
    // directly rather than going through onSensorDimsChange()). Also snaps
    // Full Vertical Bin back to checked/locked, its own default.
    setFullVerticalBin(true);
    // Calculated Spectrum x-axis toggle isn't a slider-backed control either
    // (see params.spectrumXAxisMode above), so it needs the same explicit
    // reset back to its own default (Pixel).
    setSpectrumXAxisMode("pixel");
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

  // Spectroscopy's Calculated Spectrum: axes only for now (Pixel vs.
  // Intensity) - no trace/data until the vertical-binning calculation is
  // built.
  Charts.initSpectrumChart("spectrum-chart");

  // Spectroscopy's third column: SNR vs. ROI Height (static/analytic plot -
  // see updateHeightSNRChart() below).
  Charts.initHeightSNRChart("height-snr-chart");

  // Pixel/Wavelength x-axis toggle (panel header) - see updateSpectrumIfActive()
  // for the actual pixelToWavelength() wiring this switches on.
  const spectrumXAxisPixelBtn = document.getElementById("spectrum-xaxis-pixel-btn");
  const spectrumXAxisWavelengthBtn = document.getElementById("spectrum-xaxis-wavelength-btn");

  function setSpectrumXAxisMode(mode) {
    params.spectrumXAxisMode = mode;
    spectrumXAxisPixelBtn.classList.toggle("is-active", mode === "pixel");
    spectrumXAxisWavelengthBtn.classList.toggle("is-active", mode === "wavelength");
    updateSpectrumIfActive();
  }

  spectrumXAxisPixelBtn.addEventListener("click", () => setSpectrumXAxisMode("pixel"));
  spectrumXAxisWavelengthBtn.addEventListener("click", () => setSpectrumXAxisMode("wavelength"));

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

  // Same idea, for Spectroscopy's SNR vs. ROI Height chart - kept around so
  // its Export button (see main.js's export-height-snr-btn listener) can
  // save exactly what's on screen, including the derived currentHeight value
  // (where the red dashed line sits), without recomputing it.
  let lastHeightSNRStaticData = { heights: [], snr: [], currentHeight: 0 };

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

  // --- Spectroscopy: Calculated Spectrum (Full Vertical Bin / ROI) ---------
  // "Full Vertical Bin" (checked, the default) sums the ENTIRE sensor
  // height into a single row, giving one intensity value per column - that's
  // the spectrum trace itself. This is deliberately independent of whatever
  // Vertical Bin factor governs the Image Simulator's own displayed frame
  // (that control only groups Box 1's own binned view; the spectrum always
  // wants the full column when this is checked). Horizontal Bin, on the
  // other hand, IS shared - the spectrum groups the same number of native
  // columns per point that the Image Simulator is currently grouping, since
  // Horizontal Bin is one control mirrored between both panels.
  //
  // Unchecking Full Vertical Bin hands control to the ROI instead: only the
  // native rows inside [roiTop, roiBottom] are summed (still into a single
  // output row spanning just the ROI's height - same "collapse to one row"
  // idea, just a shorter column instead of the full sensor). This is done by
  // handing simulateBinnedFrame() a row-restricted VIEW of a fresh
  // photonMap (a subarray - no copy) with binVertical set to the ROI's own
  // height, rather than teaching simulateBinnedFrame itself about the ROI at
  // all. makeCircularIllumination() is pure geometry (no randomness), so
  // regenerating it here - separately from drawLiveFrame()'s own copy -
  // costs nothing but is never stale.
  //
  // Factored out of drawLiveFrame() (which also calls this) so that editing
  // or dragging the ROI - which doesn't touch the main sensor frame at all -
  // can refresh JUST the spectrum trace, without paying for a full
  // drawLiveFrame() (frame simulation + histogram + line profile) on every
  // pointermove while dragging.
  //
  // Same camera-type readout physics as everywhere else (currentBinningMode():
  // CCD sums charge on-chip with one read-noise draw and a Register Well
  // Depth clip; sCMOS/InGaAs read each native pixel out independently and
  // sum digitally, clipped to the bit-depth ceiling).
  //
  // Gated to only run while the Spectroscopy tab (currentMode, set by
  // setMode() further down) is actually active - full-height binning is
  // roughly as expensive as the main frame simulation itself (another
  // rows*cols worth of noise draws), so there's no reason to pay it while
  // sitting on another tab. setMode() forces a single drawLiveFrame() call
  // right when you switch INTO Spectroscopy so the chart is never left
  // showing a stale frame from before the switch.
  // Shared params object shape dispersion.js expects, built from the six
  // Dispersion Model controls plus the sensor's own native pixel size/count -
  // factored out since both the Wavelength x-axis mapping and the Wavelength
  // Range readout (see updateWavelengthRangeDisplay() below) need the exact
  // same shape.
  function dispersionModelParams() {
    return {
      centerWavelengthNm: params.centerWavelengthNm,
      grooveDensity: params.grooveDensity,
      includedAngle2K: params.includedAngle2K,
      focalLengthMm: params.focalLengthMm,
      order: 1,
      pixelSizeUm: params.pixelSize,
      sensorPxCount: params.sensorWidth,
    };
  }

  const wavelengthRangeDisplayEl = document.getElementById("wavelength-range-display");
  const resolutionDisplayEl = document.getElementById("resolution-display");

  // "Wavelength Range" / "Resolution" readouts above the Dispersion Model
  // controls - both computed from the same Dispersion Model settings, so
  // updated together in one pass:
  //   - Wavelength Range: the span of wavelengths the sensor's native pixel
  //     columns actually cover, i.e. the wavelength at native pixel 0 to the
  //     wavelength at the last native pixel column (params.sensorWidth - 1) -
  //     NOT dependent on ROI/binning, just the sensor's own width.
  //   - Resolution: the standard monochromator bandpass formula - reciprocal
  //     linear dispersion (nm/mm, at the center wavelength) x Slit Width
  //     (mm) - via Dispersion.nominalDispersion().
  // Both fall back to an em-dash on an invalid grating geometry, same
  // treatment as the Calculated Spectrum's Pixel-axis fallback.
  function updateWavelengthRangeDisplay() {
    try {
      const dParams = dispersionModelParams();

      if (wavelengthRangeDisplayEl) {
        const wAtStart = Dispersion.pixelToWavelength(0, dParams);
        const wAtEnd = Dispersion.pixelToWavelength(params.sensorWidth - 1, dParams);
        const lo = Math.min(wAtStart, wAtEnd);
        const hi = Math.max(wAtStart, wAtEnd);
        wavelengthRangeDisplayEl.textContent =
          `Wavelength Range: ${lo.toFixed(1)}–${hi.toFixed(1)} nm (${(hi - lo).toFixed(1)} nm span)`;
      }

      if (resolutionDisplayEl) {
        const dispersionNmPerMm = Dispersion.nominalDispersion(dParams);
        const slitWidthMm = params.slitWidthUm / 1000;
        const resolutionNm = Math.abs(dispersionNmPerMm) * slitWidthMm;
        resolutionDisplayEl.textContent = `Resolution: ${resolutionNm.toFixed(2)} nm`;
      }
    } catch (e) {
      if (wavelengthRangeDisplayEl) wavelengthRangeDisplayEl.textContent = "Wavelength Range: —";
      if (resolutionDisplayEl) resolutionDisplayEl.textContent = "Resolution: —";
    }
  }

  function updateSpectrumIfActive() {
    if (currentMode !== "spectroscopy") return;
    updateWavelengthRangeDisplay();
    const photonMap = Physics.makeCircularIllumination(
      params.sensorHeight, params.sensorWidth, params.photons, params.spotRadius
    );
    let spectrumSourceMap = photonMap;
    let spectrumRows = params.sensorHeight;
    if (!params.fullVerticalBin) {
      spectrumRows = Math.max(params.roiBottom - params.roiTop + 1, 1);
      spectrumSourceMap = photonMap.subarray(
        params.roiTop * params.sensorWidth,
        (params.roiTop + spectrumRows) * params.sensorWidth
      );
    }
    const spectrum = Physics.simulateBinnedFrame(
      spectrumSourceMap, spectrumRows, params.sensorWidth, cameraParamsForPhysics(),
      params.binHorizontal, spectrumRows, currentBinningMode()
    );

    // X-axis: either the raw (binned) pixel index, unchanged from before, or
    // - if the Wavelength toggle is selected - each bin's wavelength,
    // computed from the Dispersion Model controls via dispersion.js. Mapping
    // is always against NATIVE pixels (params.pixelSize/params.sensorWidth),
    // regardless of Horizontal Bin - each bin's wavelength is just the
    // wavelength at that bin's CENTER native pixel, so Horizontal Bin still
    // only reduces point count/improves SNR, exactly as it did before this
    // toggle existed (see the "map to native pixels" decision this was
    // built from).
    let spectrumX;
    let xAxisTitle;
    if (params.spectrumXAxisMode === "wavelength") {
      const nativeCenters = new Array(spectrum.binnedCols);
      for (let i = 0; i < spectrum.binnedCols; i++) {
        nativeCenters[i] = i * params.binHorizontal + (params.binHorizontal - 1) / 2;
      }
      try {
        spectrumX = Dispersion.pixelToWavelength(nativeCenters, dispersionModelParams());
        xAxisTitle = "Wavelength (nm)";
      } catch (e) {
        // No real grating solution at this groove density/wavelength/angle
        // combination (see dispersion.js's InvalidGratingGeometry) - fall
        // back to Pixel for this render rather than leaving the chart blank
        // or throwing. It'll switch back to Wavelength automatically once
        // the Dispersion Model controls describe a valid geometry again.
        spectrumX = nativeCenters.map((_, i) => i);
        xAxisTitle = "Pixel";
      }
    } else {
      spectrumX = new Array(spectrum.binnedCols);
      for (let i = 0; i < spectrum.binnedCols; i++) spectrumX[i] = i;
      xAxisTitle = "Pixel";
    }

    Charts.updateSpectrumChart("spectrum-chart", { x: spectrumX, y: Array.from(spectrum.adu), xAxisTitle });

    updateHeightSNRChart();
  }

  // Spectroscopy's third column: SNR vs. ROI Height - a static, analytic
  // curve (not Monte Carlo, unlike the Calculated Spectrum above) showing
  // how SNR trends as the vertically-binned height grows from 1 up to the
  // full sensor height, at the CURRENT single-pixel photon level. Reuses
  // combineForBinning() (defined further down, alongside the primary SNR
  // panel's own "Modified SNR" curve) so the exact same charge/digital
  // binning-mode combination rules apply here - "binning rules for the
  // camera type should change this" is satisfied by construction rather than
  // by a second, parallel implementation.
  //
  // n at each height h is params.binHorizontal * h - Horizontal Bin (if
  // active; it's just 1 otherwise) scales the curve exactly the same way it
  // scales the actual binned frame, so the curve reflects Horizontal Bin
  // changes too.
  //
  // Called from updateSpectrumIfActive() (itself called from every place
  // that already recomputes the spectrum - drawLiveFrame(), setROI(), the
  // Dispersion Model controls, etc.) rather than from its own separate set
  // of triggers, since this curve depends on exactly the same
  // camera/photon/binning/ROI state the spectrum does.
  function updateHeightSNRChart() {
    if (currentMode !== "spectroscopy") return;
    const camParams = cameraParamsForPhysics();
    const currentStats = Physics.analyticNoise([params.photons], camParams);
    const mode = currentBinningMode();
    const maxHeight = Math.max(params.sensorHeight, 1);

    const heights = new Array(maxHeight);
    const snr = new Array(maxHeight);
    for (let h = 1; h <= maxHeight; h++) {
      const n = params.binHorizontal * h;
      const combined = combineForBinning(
        currentStats.signal_e, currentStats.noise_shot, currentStats.noise_dark, currentStats.noise_read, n, mode
      );
      heights[h - 1] = h;
      snr[h - 1] = combined.snr[0];
    }

    // The height actually being binned for the Calculated Spectrum right
    // now: the full sensor height when Full Sensor Vertical Bin is checked,
    // otherwise the Custom ROI's Height (roiBottom - roiTop + 1, the true
    // row count - see updateSpectrumIfActive()'s own spectrumRows).
    const currentHeight = params.fullVerticalBin
      ? params.sensorHeight
      : Math.max(params.roiBottom - params.roiTop + 1, 1);

    lastHeightSNRStaticData = { heights, snr, currentHeight };
    Charts.updateHeightSNRChart("height-snr-chart", { heights, snr, currentHeight, maxHeight });
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

    lastRenderedImageData = CanvasR.renderSensorFrame(
      sensorCanvas, adu, binnedRows, binnedCols, params.binHorizontal, params.binVertical,
      params.sensorHeight, params.sensorWidth, lut, vmin, vmax
    );

    // The indicator line/line-profile both key off the same BINNED middle
    // row; the line itself is drawn in NATIVE canvas coordinates (the canvas
    // always stays at native resolution - see renderSensorFrame above), so
    // its native row is that binned row's block, centered within the block.
    const binnedMiddleRow = Math.floor(binnedRows / 2);
    const nativeIndicatorRow = binnedMiddleRow * params.binVertical + Math.floor(params.binVertical / 2);
    lastNativeIndicatorRow = nativeIndicatorRow;
    CanvasR.drawRowIndicatorLine(sensorCanvas, nativeIndicatorRow, LINE_PROFILE_ROW_COLOR);

    // Spectroscopy ROI box: drawn on top of the same live canvas (shared
    // with Imaging - see panel-1), but only while Spectroscopy is actually
    // active, since it's a Spectroscopy-specific control (see
    // redrawCanvasOverlaysOnly() and the ROI section below for the
    // drag-to-resize handlers that also use this same drawing call).
    if (currentMode === "spectroscopy") {
      CanvasR.drawROIBox(sensorCanvas, params.roiTop, params.roiBottom, ROI_COLOR);
    }

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

    updateSpectrumIfActive();
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
  //   - "Modified SNR" (solid): the actual current-settings curve - named
  //     generically since EM Gain, Binning, or both together can be driving
  //     it. EM Gain (CCD-only) is folded in via cameraParamsForPhysics()'s
  //     emGainEnabled/emGain fields, applied inside physics.js itself
  //     (F^2 excess noise on shot/dark, read noise divided by gain - signal
  //     is untouched); binning is then layered on top via
  //     combineForBinning() below.
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

    // "Modified SNR": the actual current-settings curve - effective (EM
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
      // In SNR Only mode the noise chart sits directly beside the SNR chart
      // at the same height (see #mode-snr's CSS grid) - the legend's
      // reserved bottom strip made that pairing look mismatched, so it's
      // hidden there. Imaging mode (where it stacks with Boxes 2-4 instead)
      // keeps the legend as before.
      showLegend: currentMode !== "snr",
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
    // Same reasoning for the Spectroscopy ROI: a stale top/bottom from the
    // previous sensor height could fall outside (or no longer span
    // meaningfully within) the new one, so it's reset back to full height
    // rather than re-snapped.
    resetROIToFull();
    refreshDisplayRanges();
    drawLiveFrame();
  }

  sensorWidthInput.addEventListener("change", onSensorDimsChange);
  sensorHeightInput.addEventListener("change", onSensorDimsChange);

  // --- Spectroscopy Region of Interest (ROI) -------------------------------
  // A full-width band drawn on top of Box 1's sensor canvas (shown in both
  // Imaging and Spectroscopy, but only DRAWN while Spectroscopy is active -
  // see redrawCanvasOverlaysOnly() below), marking the native pixel rows the
  // Calculated Spectrum bins over when Full Vertical Bin (below) is
  // unchecked. Top/bottom can be set exactly via the ROI Top/Bottom number
  // inputs in the Spectroscopy tab's Region of Interest & Spectroscopy
  // Controls panel, or dragged directly on the canvas by grabbing either
  // edge - both are disabled while Full Vertical Bin is checked, since the
  // box is locked to the full sensor height in that case (see
  // setFullVerticalBin() below).
  const ROI_COLOR = "#185FA5"; // matches the Calculated Spectrum trace's own color
  const roiTopInput = document.getElementById("roi-top-input");
  const roiBottomInput = document.getElementById("roi-bottom-input");
  const roiHeightInput = document.getElementById("roi-height-input");
  const fullVBinCheckbox = document.getElementById("full-vbin-checkbox");

  // Cached from the last drawLiveFrame() call so the ROI box (and the row
  // indicator line) can be cheaply repainted - via redrawCanvasOverlaysOnly()
  // below - without re-running the frame simulation. ROI changes never
  // affect the simulated pixel data itself, only which rows are marked, so
  // there's no need to pay drawLiveFrame()'s full cost (comparable to the
  // Spectrum's own Full Vertical Bin computation) just to move the box -
  // this keeps dragging smooth even on a large sensor.
  let lastRenderedImageData = null;
  let lastNativeIndicatorRow = 0;

  function updateROIInputBounds() {
    const maxRow = Math.max(params.sensorHeight - 1, 0);
    roiTopInput.max = String(maxRow);
    roiBottomInput.max = String(maxRow);
    roiHeightInput.max = String(maxRow); // largest possible Height: roiTop=0, roiBottom=maxRow
  }

  // Clamps a proposed (top, bottom) pair to the sensor's own row range and
  // keeps top < bottom (minimum 1-row gap). `priority` says which edge was
  // just intentionally moved by the user - if the pair crosses, the OTHER
  // edge is the one nudged out of the way, not the one just set.
  function clampROI(top, bottom, priority) {
    const maxRow = Math.max(params.sensorHeight - 1, 0);
    const clampInt = (v, fallback) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(Math.max(n, 0), maxRow) : fallback;
    };
    let t = clampInt(top, params.roiTop);
    let b = clampInt(bottom, params.roiBottom);
    if (t >= b) {
      if (priority === "bottom") {
        t = Math.max(b - 1, 0);
        if (t >= b) b = Math.min(t + 1, maxRow);
      } else {
        b = Math.min(t + 1, maxRow);
        if (t >= b) t = Math.max(b - 1, 0);
      }
    }
    return { top: t, bottom: b };
  }

  function setROI(top, bottom, priority) {
    const clamped = clampROI(top, bottom, priority);
    params.roiTop = clamped.top;
    params.roiBottom = clamped.bottom;
    roiTopInput.value = params.roiTop;
    roiBottomInput.value = params.roiBottom;
    roiHeightInput.value = params.roiBottom - params.roiTop;
    redrawCanvasOverlaysOnly();
    // The ROI box itself is just an overlay (doesn't touch the simulated
    // frame - hence redrawCanvasOverlaysOnly() above being a cheap repaint,
    // not a re-simulation), but when Full Vertical Bin is unchecked, the
    // Calculated Spectrum's OWN binning range depends on the ROI - so moving
    // the box (by typing or dragging) needs to refresh the spectrum trace
    // too. This only re-simulates the spectrum's own row range, not the
    // whole frame, so dragging stays smooth even while it's live-updating.
    updateSpectrumIfActive();
  }

  // Height is a convenience field on top of Top/Bottom - the difference
  // between the ROI Top and ROI Bottom pixel positions (params.roiBottom -
  // params.roiTop, per the label swap above). Anchored to the ROI BOTTOM
  // pixel (params.roiTop, the smaller native row): changing Height keeps
  // that fixed and moves the ROI TOP pixel (params.roiBottom) to match,
  // exactly as if the user had typed/dragged the Top edge directly - so this
  // reuses setROI() with priority "bottom" (the native `bottom` var is the
  // one being intentionally moved here) rather than duplicating the
  // clamping logic.
  function setROIHeight(height) {
    const h = Math.max(Math.round(Number(height)) || 1, 1);
    setROI(params.roiTop, params.roiTop + h, "bottom");
  }

  function resetROIToFull() {
    updateROIInputBounds();
    params.roiTop = 0;
    params.roiBottom = Math.max(params.sensorHeight - 1, 0);
    roiTopInput.value = params.roiTop;
    roiBottomInput.value = params.roiBottom;
    roiHeightInput.value = params.roiBottom - params.roiTop;
  }

  // Full Vertical Bin: checking it snaps the ROI box to the full sensor
  // height (same values resetROIToFull() produces) and locks the ROI
  // controls/dragging, since the box can't be moved independently while the
  // spectrum is binning the whole height anyway. Unchecking it just unlocks
  // them again - it deliberately leaves roiTop/roiBottom wherever they
  // already are (full height, from having just been snapped there) rather
  // than jumping to some other default, so the user's next move is an
  // intentional drag/edit from a known starting point.
  function setFullVerticalBin(enabled) {
    params.fullVerticalBin = enabled;
    fullVBinCheckbox.checked = enabled;
    if (enabled) {
      resetROIToFull();
    }
    roiTopInput.disabled = enabled;
    roiBottomInput.disabled = enabled;
    roiHeightInput.disabled = enabled;
    redrawCanvasOverlaysOnly();
  }

  fullVBinCheckbox.addEventListener("change", () => {
    setFullVerticalBin(fullVBinCheckbox.checked);
    drawLiveFrame();
  });

  // Repaints the last-computed frame (from cache, no re-simulation) plus its
  // overlays. The ROI box only ever paints while Spectroscopy is the active
  // mode - it's a Spectroscopy-specific control, so it shouldn't appear on
  // Box 1 while looking at the Imaging tab.
  function redrawCanvasOverlaysOnly() {
    if (!lastRenderedImageData) return;
    const ctx = sensorCanvas.getContext("2d");
    ctx.putImageData(lastRenderedImageData, 0, 0);
    CanvasR.drawRowIndicatorLine(sensorCanvas, lastNativeIndicatorRow, LINE_PROFILE_ROW_COLOR);
    if (currentMode === "spectroscopy") {
      CanvasR.drawROIBox(sensorCanvas, params.roiTop, params.roiBottom, ROI_COLOR);
    }
  }

  roiTopInput.addEventListener("change", () => setROI(roiTopInput.value, params.roiBottom, "top"));
  roiBottomInput.addEventListener("change", () => setROI(params.roiTop, roiBottomInput.value, "bottom"));
  roiHeightInput.addEventListener("change", () => setROIHeight(roiHeightInput.value));

  // --- Dragging the ROI box's top/bottom edges directly on the canvas -----
  // Maps a pointer's clientY to a NATIVE sensor row, accounting for
  // object-fit:contain's possible letterboxing: #sensor-canvas's CSS box
  // (see style.css) can be larger, on one axis, than the image it's actually
  // painting when the sensor's aspect ratio doesn't match the box's, so the
  // box's own getBoundingClientRect() alone isn't enough - the letterboxed
  // offset has to be computed and subtracted first.
  function sensorCanvasVerticalMapping() {
    const rect = sensorCanvas.getBoundingClientRect();
    const nativeRows = sensorCanvas.height || 1;
    const nativeCols = sensorCanvas.width || 1;
    const boxW = rect.width || 1;
    const boxH = rect.height || 1;
    const imageAr = nativeCols / nativeRows;
    const boxAr = boxW / boxH;
    // width-constrained (image fills the box's width, letterboxed top/bottom)
    // vs height-constrained (fills height, letterboxed left/right) - only the
    // vertical scale/offset matter here since ROI dragging is vertical-only.
    const scale = imageAr > boxAr ? boxW / nativeCols : boxH / nativeRows;
    const offsetY = imageAr > boxAr ? (boxH - nativeRows * scale) / 2 : 0;
    return { rectTop: rect.top, scale: scale || 1, offsetY };
  }

  function clientYToNativeRow(clientY) {
    const { rectTop, scale, offsetY } = sensorCanvasVerticalMapping();
    return (clientY - rectTop - offsetY) / scale;
  }

  // How close (in CSS px) a pointer needs to be to an edge to grab it -
  // converted to native rows via the same scale as the mapping above, so the
  // grab zone feels the same size on screen regardless of sensor size/zoom.
  const ROI_DRAG_HIT_PX = 8;

  let roiDragEdge = null; // "top" | "bottom" | null while a drag is active

  sensorCanvas.addEventListener("pointerdown", (e) => {
    if (currentMode !== "spectroscopy") return; // box isn't shown/grabbable elsewhere
    if (params.fullVerticalBin) return; // locked to full height - nothing to grab
    const row = clientYToNativeRow(e.clientY);
    const { scale } = sensorCanvasVerticalMapping();
    const hitRows = ROI_DRAG_HIT_PX / scale;
    const distTop = Math.abs(row - params.roiTop);
    const distBottom = Math.abs(row - params.roiBottom);
    if (distTop > hitRows && distBottom > hitRows) return; // not close to either edge
    roiDragEdge = distTop <= distBottom ? "top" : "bottom";
    if (sensorCanvas.setPointerCapture) sensorCanvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  sensorCanvas.addEventListener("pointermove", (e) => {
    if (!roiDragEdge) return;
    const row = clientYToNativeRow(e.clientY);
    if (roiDragEdge === "top") {
      setROI(row, params.roiBottom, "top");
    } else {
      setROI(params.roiTop, row, "bottom");
    }
  });

  function endROIDrag(e) {
    if (!roiDragEdge) return;
    roiDragEdge = null;
    if (sensorCanvas.releasePointerCapture && e && e.pointerId !== undefined) {
      sensorCanvas.releasePointerCapture(e.pointerId);
    }
  }
  sensorCanvas.addEventListener("pointerup", endROIDrag);
  sensorCanvas.addEventListener("pointercancel", endROIDrag);

  updateROIInputBounds();
  roiTopInput.value = params.roiTop;
  roiBottomInput.value = params.roiBottom;
  roiHeightInput.value = params.roiBottom - params.roiTop;
  fullVBinCheckbox.checked = params.fullVerticalBin;
  roiTopInput.disabled = params.fullVerticalBin;
  roiBottomInput.disabled = params.fullVerticalBin;
  roiHeightInput.disabled = params.fullVerticalBin;

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

  // Spectroscopy mode's two placeholder panels get the same treatment.
  // Image Simulator has no Info button of its own - it's the real #panel-1,
  // borrowed in from Imaging mode, and reuses panel-1's own Info overlay.
  setupInfoOverlay("panel-spectrum-info-btn", "panel-spectrum-info-overlay", "panel-spectrum-info-close-btn");
  setupInfoOverlay("panel-spectro-roi-info-btn", "panel-spectro-roi-info-overlay", "panel-spectro-roi-info-close-btn");

  // --- Collapsible parameter groups (Experimental/Camera Parameters) ------
  // Clicking the group's header row (chevron + h3) toggles a `.is-collapsed`
  // class on the group, which hides its .controls-list via CSS (see
  // style.css - deliberately NOT the `hidden` attribute, since
  // .controls-list already sets its own `display: grid`). Starts expanded,
  // same as every other collapse/toggle control in this app.
  function setupCollapsibleGroup(groupId, toggleBtnId, startCollapsed = false) {
    const group = document.getElementById(groupId);
    const toggleBtn = document.getElementById(toggleBtnId);
    let collapsed = startCollapsed;

    function setCollapsed(next) {
      collapsed = next;
      group.classList.toggle("is-collapsed", collapsed);
      toggleBtn.setAttribute("aria-expanded", String(!collapsed));
    }

    toggleBtn.addEventListener("click", () => setCollapsed(!collapsed));
  }

  setupCollapsibleGroup("experimental-group", "experimental-group-toggle");
  setupCollapsibleGroup("camera-group", "camera-group-toggle");
  // Dispersion Model's Wavelength Range/Resolution readouts start collapsed
  // (unlike the two groups above) - they're computed results rather than
  // controls, and the point of tucking them behind this dropdown is to save
  // vertical space in the Spectroscopy Controls panel's middle column by
  // default.
  setupCollapsibleGroup("dispersion-results-group", "dispersion-results-toggle", true);

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
  document.getElementById("export-height-snr-btn").addEventListener("click", () => {
    Exporters.exportHeightSNR({ params, staticData: lastHeightSNRStaticData });
  });

  // --- Mode tabs (Imaging / Spectroscopy / SNR Only) ----------------------
  // Box 6 (Parameters) and the physics underneath it are identical across
  // all three modes - only which panels are on screen changes. Panels used
  // by more than one mode (Box 1/panel-1 the sensor sim, shared between
  // Imaging and Spectroscopy; the SNR chart, Noise chart, and Camera
  // Sensitivity Comparison panel, shared between Imaging and SNR Only) are
  // real, single DOM nodes that get reparented into the active mode's slot
  // rather than duplicated - one live element per panel no matter which
  // mode is currently showing it, and no risk of "copies" drifting out of
  // sync.
  //
  // Spectroscopy's Calculated Spectrum and Region of Interest panels are
  // still layout-only placeholders (see index.html) while the real
  // vertical-binning spectrum and the ROI selector get built. modeViews/
  // modeTabs/CHART_IDS_BY_MODE are plain keyed objects, iterated generically
  // in setMode(), so a mode needs no special-casing beyond a key in each
  // (and, if it borrows panels, an entry in MODE_BORROWS below).

  const modeViews = {
    imaging: document.getElementById("mode-imaging"),
    spectroscopy: document.getElementById("mode-spectroscopy"),
    snr: document.getElementById("mode-snr"),
  };
  const modeTabs = {
    imaging: document.getElementById("mode-tab-imaging"),
    spectroscopy: document.getElementById("mode-tab-spectroscopy"),
    snr: document.getElementById("mode-tab-snr"),
  };

  // Every panel that gets borrowed by some non-Imaging mode. Each one's
  // original parent + next sibling is captured once, up front, so it can
  // always be put back in its exact original spot in Imaging mode's layout
  // - Imaging mode itself is never modified or rebuilt, just temporarily
  // missing whichever of these the active mode has currently borrowed.
  const cameraSimPanel = document.getElementById("panel-1");
  const snrChartPanel = document.getElementById("panel-4");
  const noiseChartPanel = document.getElementById("panel-5");
  const comparisonPanelEl = document.getElementById("panel-comparison");
  const sharedModePanels = [cameraSimPanel, snrChartPanel, noiseChartPanel, comparisonPanelEl];

  const panelHomes = new Map();
  for (const el of sharedModePanels) {
    panelHomes.set(el, { parent: el.parentElement, next: el.nextElementSibling });
  }
  function restorePanelHome(el) {
    const home = panelHomes.get(el);
    if (!home) return;
    if (home.next && home.next.parentElement === home.parent) {
      home.parent.insertBefore(el, home.next);
    } else {
      home.parent.appendChild(el);
    }
  }

  // Which panels each non-Imaging mode borrows, and which slot (a
  // display:contents landing spot - see .mode-slot in style.css) each one
  // goes into. Declarative and keyed generically so setMode() below doesn't
  // need an if-branch per mode.
  const MODE_BORROWS = {
    spectroscopy: [
      { panel: cameraSimPanel, slotId: "spectro-slot-image" },
    ],
    snr: [
      { panel: snrChartPanel, slotId: "snr-slot-chart" },
      { panel: noiseChartPanel, slotId: "snr-slot-noise" },
      { panel: comparisonPanelEl, slotId: "snr-slot-comparison" },
    ],
  };

  // Plotly's responsive:true config only reacts to window resize events,
  // not container size changes from a mode switch, so every chart that's
  // now visible needs an explicit nudge to redraw at its new size (same
  // fix already used for the Comparison legend collapse toggle above).
  const CHART_IDS_BY_MODE = {
    imaging: ["histogram-chart", "line-profile-chart", "snr-chart", "noise-chart", "comparison-plot-1", "comparison-plot-2"],
    spectroscopy: ["spectrum-chart"],
    snr: ["snr-chart", "noise-chart", "comparison-plot-1", "comparison-plot-2"],
  };

  function resizeChartsForMode(mode) {
    if (!(window.Plotly && window.Plotly.Plots && typeof window.Plotly.Plots.resize === "function")) return;
    for (const id of CHART_IDS_BY_MODE[mode] || []) {
      const el = document.getElementById(id);
      if (el) window.Plotly.Plots.resize(el);
    }
  }

  let currentMode = "imaging";

  function setMode(mode) {
    if (!modeViews[mode] || mode === currentMode) return;

    // Switching tabs always pauses Play - simulations/animations shouldn't
    // keep running on a tab you've just navigated away from (or arrived at
    // expecting a static view). setPlaying(false) is a no-op if Play was
    // already off. The one-time drawLiveFrame() call right after currentMode
    // is updated below gives the newly active tab an immediately fresh,
    // correct frame despite now being paused - same "immediate feedback
    // even while paused" idiom used by onAnyParamChange() elsewhere in this
    // file - rather than leaving it to show a stale frame from whenever it
    // was last drawn.
    setPlaying(false);

    // Leaving a mode that borrowed panels: hand them all back to Imaging
    // mode before hiding it, so Imaging looks exactly as it did before.
    for (const { panel } of MODE_BORROWS[currentMode] || []) {
      restorePanelHome(panel);
    }

    for (const key of Object.keys(modeViews)) {
      modeViews[key].classList.toggle("is-active", key === mode);
      modeTabs[key].classList.toggle("is-active", key === mode);
      modeTabs[key].setAttribute("aria-selected", String(key === mode));
    }

    // Entering a mode that borrows panels: move each one into its slot.
    for (const { panel, slotId } of MODE_BORROWS[mode] || []) {
      document.getElementById(slotId).appendChild(panel);
    }

    currentMode = mode;

    // The Noise chart's legend is shown/hidden depending on currentMode
    // (see updateStaticPanels), so it needs a real redraw - not just a
    // resize - whenever the mode changes, in either direction.
    updateStaticPanels();

    // One-shot refresh of the live-frame-driven panels (Box 1's canvas,
    // Histogram, Line Profile, and - since currentMode is already updated
    // above - the Calculated Spectrum if we just switched into
    // Spectroscopy). Cheap to call once per switch even though Spectrum's
    // own computation inside drawLiveFrame() is gated to skip when some
    // OTHER mode is active, since this call only happens right here, not on
    // a recurring timer.
    drawLiveFrame();

    // Wait a frame so the browser has applied the new layout before asking
    // Plotly to measure its containers - measuring immediately can still
    // read the pre-switch (hidden or old-mode) dimensions. The sensor
    // canvas doesn't need this: it's CSS-scaled from its own fixed
    // width/height attributes (see #sensor-canvas in style.css), not
    // measured/redrawn on container resize, so moving panel-1 between
    // Imaging and Spectroscopy needs no extra redraw call here.
    requestAnimationFrame(() => {
      resizeChartsForMode(mode);
    });
  }

  for (const [mode, btn] of Object.entries(modeTabs)) {
    btn.addEventListener("click", () => setMode(mode));
  }

  // --- Splash / landing screen ----------------------------------------------
  // Shown full-viewport on every load, on top of the app (which still
  // initializes normally underneath it). Picking a mode button hides the
  // splash and jumps straight into that tab via the same setMode() used by
  // the header's mode tabs - one-way, no path back to the splash from inside
  // the app.
  function initSplashScreen() {
    const splashEl = document.getElementById("splash-screen");
    if (!splashEl) return;
    const splashButtons = splashEl.querySelectorAll(".splash-mode-btn");
    splashButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.mode;
        splashEl.hidden = true;
        setMode(mode);
      });
    });
  }
  initSplashScreen();

  // --- Initial render (paused by default) ----------------------------------

  refreshDisplayRanges();
  drawLiveFrame();
  updateStaticPanels();
  setPlaying(false);
})();
