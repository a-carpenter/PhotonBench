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
  const SENSOR_HEIGHT_MIN = 100;
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

  // Default values for every slider-backed parameter (bit depth is a
  // discrete select and isn't part of the "Reset to Default" spec, so it's
  // left out here and untouched by the reset button).
  const DEFAULT_PARAMS = {
    photons: 20,
    exposureTime: 1.0,
    spotRadius: 300,
    qe: 0.7,
    darkCurrent: 0.1,
    readNoise: 4.0,
    fullWell: 30000,
    offset: 100.0,
    gain: 1.0,
  };

  const params = {
    // Sensor form factor
    sensorWidth: DEFAULT_SENSOR_WIDTH,
    sensorHeight: DEFAULT_SENSOR_HEIGHT,
    // Experimental
    photons: DEFAULT_PARAMS.photons,
    exposureTime: DEFAULT_PARAMS.exposureTime,
    spotRadius: DEFAULT_PARAMS.spotRadius,
    // Camera
    qe: DEFAULT_PARAMS.qe,
    darkCurrent: DEFAULT_PARAMS.darkCurrent,
    readNoise: DEFAULT_PARAMS.readNoise,
    fullWell: DEFAULT_PARAMS.fullWell,
    offset: DEFAULT_PARAMS.offset,
    gain: DEFAULT_PARAMS.gain,
    bitDepth: 12,
  };

  function cameraParamsForPhysics() {
    return {
      exposureTime: params.exposureTime,
      qe: params.qe,
      darkCurrent: params.darkCurrent,
      readNoise: params.readNoise,
      offset: params.offset,
      fullWell: params.fullWell,
      gain: params.gain,
      bitDepth: params.bitDepth,
    };
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

  const bitDepthControl = Controls.createSelectControl({
    id: "bit-depth", label: "Bit Depth", options: [8, 10, 12, 14, 16], value: params.bitDepth,
    onChange: (v) => onAnyParamChange("bitDepth", v),
  });
  cameraContainer.appendChild(bitDepthControl.element);

  // --- Reset to Default ---------------------------------------------------

  const resetDefaultsBtn = document.getElementById("reset-defaults-btn");
  resetDefaultsBtn.addEventListener("click", () => {
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
    refreshDisplayRanges();
    drawLiveFrame();
    updateStaticPanels();
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

  function refreshDisplayRanges() {
    const photonMap = Physics.makeCircularIllumination(
      params.sensorHeight, params.sensorWidth, params.photons, params.spotRadius
    );
    const { adu } = Physics.simulateSensor(photonMap, cameraParamsForPhysics());
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
    const middleRow = Math.floor(params.sensorHeight / 2);
    const photonMap = Physics.makeCircularIllumination(
      params.sensorHeight, params.sensorWidth, params.photons, params.spotRadius
    );
    const { adu } = Physics.simulateSensor(photonMap, cameraParamsForPhysics());
    const { vmin, vmax } = cachedRange;

    CanvasR.renderSensorFrame(sensorCanvas, adu, params.sensorHeight, params.sensorWidth, lut, vmin, vmax);
    CanvasR.drawRowIndicatorLine(sensorCanvas, middleRow, LINE_PROFILE_ROW_COLOR);

    const { centers, counts } = Charts.updateHistogramChart("histogram-chart", {
      adu, bins: 80, vmin, vmax, yMax: cachedHistYMax,
    });

    const rowData = adu.subarray(middleRow * params.sensorWidth, (middleRow + 1) * params.sensorWidth);

    // The illuminated ("signal") portion of this row: since illumination is a
    // disc centered on the sensor and the middle row passes through that
    // center, the lit segment spans [centerCol - radius, centerCol + radius].
    const centerCol = Math.floor(params.sensorWidth / 2);
    const colStart = Math.max(0, Math.round(centerCol - params.spotRadius));
    const colEnd = Math.min(params.sensorWidth - 1, Math.round(centerCol + params.spotRadius));
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

  let lastStaticData = { photonRange: [], snr: [], noiseShot: [], noiseDark: [], noiseRead: [], noiseTotal: [] };

  function updateStaticPanels() {
    const camParams = cameraParamsForPhysics();
    const photonMax = Math.max((params.fullWell / Math.max(params.qe, 1e-6)) * 2, 10);
    const nPoints = 200;
    const logMin = 0;
    const logMax = Math.log10(photonMax);
    const photonRange = new Array(nPoints);
    for (let i = 0; i < nPoints; i++) {
      photonRange[i] = Math.pow(10, logMin + ((logMax - logMin) * i) / (nPoints - 1));
    }

    const stats = Physics.analyticNoise(photonRange, camParams);
    const snr = new Array(nPoints);
    for (let i = 0; i < nPoints; i++) {
      snr[i] = stats.noise_total[i] > 0 ? stats.signal_e[i] / stats.noise_total[i] : 0;
    }

    const currentStats = Physics.analyticNoise([params.photons], camParams);
    const currentSNR = currentStats.noise_total[0] > 0
      ? currentStats.signal_e[0] / currentStats.noise_total[0]
      : 0;

    Charts.updateSNRChart("snr-chart", {
      photonRange, snr, currentPhotons: params.photons, currentSNR,
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
      noiseShot: Array.from(stats.noise_shot),
      noiseDark: Array.from(stats.noise_dark),
      noiseRead: Array.from(stats.noise_read),
      noiseTotal: Array.from(stats.noise_total),
    };
  }

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

  // --- Info text (inline, under Box 1) ---------------------------------------

  const infoText = document.getElementById("info-text");
  Info.loadInfoText().then((html) => {
    infoText.innerHTML = html;
  });

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
