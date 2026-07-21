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
    pixelSize: 13.0,
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
    pixelSize: DEFAULT_PARAMS.pixelSize,
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
  // Note: pixel size does NOT factor into this panel's SNR curve - it's a
  // single-camera view. Pixel-area normalization (pixelSize^2 / 13^2, for
  // comparing sensitivity across cameras with different pixel sizes under
  // the same illumination) will instead be applied later, at the point
  // where a curve is stored via the "Compare" button for the future Camera
  // Sensitivity Comparison feature - not on every live update here.

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

    comparisonTraces.push({
      id: comparisonIdCounter++,
      name,
      color,
      photonRange: lastStaticData.photonRange.slice(),
      snr: lastStaticData.snr.slice(),
      snrNormalized: lastStaticData.snr.map((v) => v * ratio),
    });

    renderComparisonCharts();
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

  // --- Info overlay (header button) ---------------------------------------

  const infoBtn = document.getElementById("info-btn");
  const infoOverlay = document.getElementById("info-overlay");
  const infoModalContent = document.getElementById("info-modal-content");
  const infoCloseBtn = document.getElementById("info-close-btn");

  Info.loadInfoText().then((html) => {
    infoModalContent.innerHTML = html;
  });

  function openInfoOverlay() {
    infoOverlay.hidden = false;
  }

  function closeInfoOverlay() {
    infoOverlay.hidden = true;
  }

  infoBtn.addEventListener("click", openInfoOverlay);
  infoCloseBtn.addEventListener("click", closeInfoOverlay);

  // Clicking the dimmed backdrop (not the modal box itself) closes it too.
  infoOverlay.addEventListener("click", (e) => {
    if (e.target === infoOverlay) closeInfoOverlay();
  });

  // Escape closes the overlay whenever it's open.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !infoOverlay.hidden) closeInfoOverlay();
  });

  // --- Comparison panel Info overlay (explains the Normalized SNR plot) ---

  const comparisonInfoBtn = document.getElementById("comparison-info-btn");
  const comparisonInfoOverlay = document.getElementById("comparison-info-overlay");
  const comparisonInfoCloseBtn = document.getElementById("comparison-info-close-btn");

  function openComparisonInfoOverlay() {
    comparisonInfoOverlay.hidden = false;
  }

  function closeComparisonInfoOverlay() {
    comparisonInfoOverlay.hidden = true;
  }

  comparisonInfoBtn.addEventListener("click", openComparisonInfoOverlay);
  comparisonInfoCloseBtn.addEventListener("click", closeComparisonInfoOverlay);

  comparisonInfoOverlay.addEventListener("click", (e) => {
    if (e.target === comparisonInfoOverlay) closeComparisonInfoOverlay();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !comparisonInfoOverlay.hidden) closeComparisonInfoOverlay();
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
