// charts.js
// Plotly-based rendering for Panels 2-5. Pure "draw" code: every function
// here takes already-computed data (from physics.js) and (re)renders a
// Plotly chart. Plotly.react is used instead of Plotly.newPlot for updates
// so the DOM/WebGL context is reused rather than rebuilt every frame.

const PLOTLY_BASE_LAYOUT = {
  margin: { l: 55, r: 20, t: 36, b: 45 },
  font: { family: "system-ui, sans-serif", size: 12, color: "#1f2430" },
  paper_bgcolor: "#ffffff",
  plot_bgcolor: "#f4f5f7",
  showlegend: false,
};

const PLOTLY_CONFIG = {
  responsive: true,
  displayModeBar: false,
};

// A visible box drawn around every plot's data area (all four axis lines,
// mirrored), rather than just the bare left/bottom axis lines Plotly uses
// by default.
const BOXED_AXIS = {
  showline: true,
  linewidth: 1,
  linecolor: "#8a919e",
  mirror: true,
};

function boxedAxis(overrides) {
  return Object.assign({}, BOXED_AXIS, overrides);
}

function mergeLayout(overrides) {
  return Object.assign({}, PLOTLY_BASE_LAYOUT, overrides);
}

// ---------------------------------------------------------------------------
// Panel 2: intensity histogram (bars only), x-range spans the data's noise
// floor to signal ceiling with padding (see computeDisplayRange in canvas.js
// - callers pass vmin/vmax computed the same way as Panel 1).
// ---------------------------------------------------------------------------

function initHistogramChart(divId) {
  Plotly.newPlot(
    divId,
    [{ x: [], y: [], type: "bar", marker: { color: "#185FA5" }, opacity: 0.85 }],
    mergeLayout({
      title: { text: "Intensity Histogram", font: { size: 13 } },
      xaxis: boxedAxis({ title: "Calculated ADU" }),
      yaxis: boxedAxis({ title: "Pixel Count", type: "linear" }),
    }),
    PLOTLY_CONFIG
  );
}

/**
 * (Re)draws the histogram from already-computed bin centers/counts, without
 * rebinning - used both by updateHistogramChart() below (which does the
 * binning) and directly by main.js's Linear/Log toggle button, which only
 * needs to redraw the SAME data under a different y-axis scale rather than
 * resimulating a frame.
 */
function renderHistogramChart(divId, { centers, counts, vmin, vmax, yMax, yAxisType = "linear" }) {
  const yAxis = boxedAxis({ title: "Pixel Count", type: yAxisType });
  if (yMax !== undefined) {
    // Log-axis ranges are specified in log10 units; linear ranges are not.
    yAxis.range = yAxisType === "log" ? [0, Math.log10(Math.max(yMax, 1))] : [0, yMax];
  }

  Plotly.react(
    divId,
    [{ x: centers, y: counts, type: "bar", marker: { color: "#185FA5" }, opacity: 0.85 }],
    mergeLayout({
      title: { text: "Intensity Histogram", font: { size: 13 } },
      xaxis: boxedAxis({ title: "Calculated ADU", range: [vmin, vmax] }),
      yaxis: yAxis,
    }),
    PLOTLY_CONFIG
  );
}

function updateHistogramChart(divId, { adu, bins = 80, vmin, vmax, yMax, yAxisType = "linear" }) {
  const counts = new Array(bins).fill(0);
  const span = vmax - vmin || 1;
  const binWidth = span / bins;

  for (let i = 0; i < adu.length; i++) {
    let idx = Math.floor((adu[i] - vmin) / binWidth);
    if (idx < 0) idx = 0;
    else if (idx >= bins) idx = bins - 1;
    counts[idx]++;
  }

  const centers = new Array(bins);
  for (let i = 0; i < bins; i++) centers[i] = vmin + (i + 0.5) * binWidth;

  renderHistogramChart(divId, { centers, counts, vmin, vmax, yMax, yAxisType });

  return { centers, counts };
}

// ---------------------------------------------------------------------------
// Panel 3: middle-row line profile. Y-axis expands to cover the current
// frame's actual min/max (noise floor to signal ceiling); if the signal ever
// exceeds the current bound the axis is recomputed (handled by the caller
// passing a fresh vmin/vmax every frame - see main.js). A dashed red line
// (+ a text label that tracks it) marks the mean of the illuminated
// (signal) portion of the row.
// ---------------------------------------------------------------------------

const LINE_PROFILE_COLOR = "#00838f";

function initLineProfileChart(divId) {
  Plotly.newPlot(
    divId,
    [{ x: [], y: [], type: "scatter", mode: "lines", line: { color: LINE_PROFILE_COLOR, width: 1 } }],
    mergeLayout({
      title: { text: "Line Plot", font: { size: 13 } },
      xaxis: boxedAxis({ title: "Pixel column" }),
      yaxis: boxedAxis({ title: "ADU" }),
    }),
    PLOTLY_CONFIG
  );
}

function updateLineProfileChart(divId, { rowData, vmin, vmax, colStart, colEnd, signalMean }) {
  const x = new Array(rowData.length);
  for (let i = 0; i < rowData.length; i++) x[i] = i;

  const shapes = [];
  const annotations = [];
  if (signalMean !== undefined && colEnd > colStart) {
    shapes.push({
      type: "line",
      xref: "x",
      yref: "y",
      x0: colStart,
      x1: colEnd,
      y0: signalMean,
      y1: signalMean,
      line: { color: "#e63946", width: 1.5, dash: "dash" },
    });
    annotations.push({
      x: colEnd,
      xref: "x",
      y: signalMean,
      yref: "y",
      yshift: 12,
      xanchor: "right",
      text: `<b>${signalMean.toFixed(1)}</b>`,
      showarrow: false,
      font: { size: 10, color: "#e63946" },
      bgcolor: "rgba(255,255,255,0.5)",
    });
  }

  Plotly.react(
    divId,
    [{ x, y: Array.from(rowData), type: "scatter", mode: "lines", line: { color: LINE_PROFILE_COLOR, width: 1 } }],
    mergeLayout({
      title: { text: "Line Plot", font: { size: 13 } },
      xaxis: boxedAxis({ title: "Pixel column", range: [0, rowData.length - 1] }),
      yaxis: boxedAxis({ title: "ADU", range: [vmin, vmax] }),
      shapes,
      annotations,
    }),
    PLOTLY_CONFIG
  );
}

// ---------------------------------------------------------------------------
// Panel 4: static SNR curve (log-log), with a red marker at the current
// operating point and a shaded +/-1 SNR band. When EM Gain and/or Binning
// are active, a second "Modified SNR" trace shows the actual current-settings
// curve (labeled generically since either modifier, or both together, can be
// what's driving it - not just Binning), and the baseline "Single Pixel SNR"
// curve is dashed so the two read as reference vs. modified rather than
// looking like two equally-valid curves.
// ---------------------------------------------------------------------------

const SNR_BASELINE_COLOR = "#185FA5";
const SNR_ACTIVE_COLOR = "#c9822f";

function initSNRChart(divId) {
  Plotly.newPlot(divId, [], mergeLayout({ title: { text: "Signal-to-Noise", font: { size: 13 } } }), PLOTLY_CONFIG);
}

function updateSNRChart(divId, { photonRange, baselineSnr, activeSnr, modifierActive, currentPhotons, currentSNR }) {
  // The shaded +/-1 SNR band always tracks the ACTIVE curve (what you're
  // actually configured for right now), same as the current-point marker.
  const snrHi = activeSnr.map((v) => v + 1);
  const snrLo = activeSnr.map((v) => Math.max(v - 1, 0));
  const bandColor = modifierActive ? "rgba(201,130,47,0.15)" : "rgba(24,95,165,0.2)";

  // Fix the x-axis to the span of the photon sweep itself (which only
  // depends on full well / QE, not on the current photon count). Without an
  // explicit range, Plotly auto-fits the axis to everything drawn on it -
  // including the current-photons marker below - so the axis would shift
  // and compress every time the Photons slider moves, even though the curve
  // itself hasn't changed.
  const xRange = [Math.log10(photonRange[0]), Math.log10(photonRange[photonRange.length - 1])];

  const traces = [
    {
      x: photonRange, y: snrHi, type: "scatter", mode: "lines",
      line: { width: 0 }, hoverinfo: "skip",
    },
    {
      x: photonRange, y: snrLo, type: "scatter", mode: "lines",
      fill: "tonexty", fillcolor: bandColor, line: { width: 0 },
      hoverinfo: "skip",
    },
    {
      x: photonRange, y: baselineSnr, type: "scatter", mode: "lines",
      line: { color: SNR_BASELINE_COLOR, width: 2, dash: modifierActive ? "dash" : "solid" },
      // Match the Comparison panel's hover precision (one decimal place)
      // rather than the default full floating-point display; append a label
      // only once there's a second curve to tell it apart from.
      hovertemplate: modifierActive
        ? "%{x:.1f}, %{y:.1f}<br>Single Pixel SNR<extra></extra>"
        : "%{x:.1f}, %{y:.1f}<extra></extra>",
    },
  ];

  if (modifierActive) {
    traces.push({
      x: photonRange, y: activeSnr, type: "scatter", mode: "lines",
      line: { color: SNR_ACTIVE_COLOR, width: 2 },
      hovertemplate: "%{x:.1f}, %{y:.1f}<br>Modified SNR<extra></extra>",
    });
  }

  traces.push({
    x: [currentPhotons], y: [currentSNR], type: "scatter", mode: "markers",
    marker: { color: "#e63946", size: 10, line: { color: "#7a1620", width: 1 } },
    hovertemplate: "%{x:.1f}, %{y:.1f}<extra></extra>",
  });

  Plotly.react(
    divId,
    traces,
    mergeLayout({
      title: { text: "Signal-to-Noise", font: { size: 13 } },
      xaxis: boxedAxis({ title: "Incident Photons / Pixel", type: "log", range: xRange }),
      yaxis: boxedAxis({ title: "Signal-to-Noise", type: "log" }),
    }),
    PLOTLY_CONFIG
  );
}

// ---------------------------------------------------------------------------
// Panel 5: static noise-contributions curve (log-log): shot/dark/read/total.
// ---------------------------------------------------------------------------

function initNoiseChart(divId) {
  Plotly.newPlot(
    divId, [],
    mergeLayout({
      title: { text: "Noise Contributions", font: { size: 13 } },
      showlegend: true,
    }),
    PLOTLY_CONFIG
  );
}

function updateNoiseChart(divId, { photonRange, noiseShot, noiseDark, noiseRead, noiseTotal, currentPhotons, showLegend = true }) {
  // Same fix as the SNR chart: pin the x-axis to the photon sweep's own
  // span so the current-photons reference line (below) can't drag the axis
  // around as the Photons slider moves.
  const xRange = [Math.log10(photonRange[0]), Math.log10(photonRange[photonRange.length - 1])];

  const shapes = [];
  const annotations = [];
  if (currentPhotons !== undefined) {
    shapes.push({
      type: "line",
      xref: "x",
      yref: "paper",
      x0: currentPhotons,
      x1: currentPhotons,
      y0: 0,
      y1: 1,
      line: { color: "#e63946", width: 1.5, dash: "dash" },
    });
    annotations.push({
      x: currentPhotons,
      xref: "x",
      y: 0.98,
      yref: "paper",
      yanchor: "top",
      xshift: 4,
      text: "Current photons",
      showarrow: false,
      align: "left",
      font: { size: 9, color: "#e63946" },
    });
  }

  Plotly.react(
    divId,
    [
      { x: photonRange, y: noiseTotal, type: "scatter", mode: "lines", name: "Total", line: { color: "#2C2C2A", width: 2 } },
      { x: photonRange, y: noiseShot, type: "scatter", mode: "lines", name: "Shot", line: { color: "#185FA5", width: 1.5, dash: "dash" } },
      { x: photonRange, y: noiseDark, type: "scatter", mode: "lines", name: "Dark", line: { color: "#0F6E56", width: 1.5, dash: "dash" } },
      { x: photonRange, y: noiseRead, type: "scatter", mode: "lines", name: "Read", line: { color: "#7F77DD", width: 1.5, dash: "dash" } },
    ],
    mergeLayout({
      title: { text: "Noise Contributions", font: { size: 13 } },
      xaxis: boxedAxis({ title: "Incident photons", type: "log", range: xRange }),
      yaxis: boxedAxis({ title: "Noise (e- RMS)", type: "log" }),
      shapes,
      annotations,
      showlegend: showLegend,
      // Legend hidden (SNR Only mode, where the noise chart sits right next
      // to the SNR chart at the same height and the legend's reserved strip
      // made the two plot areas visibly mismatched): reclaim the bottom
      // margin the legend was using, since there's nothing left to draw
      // down there.
      margin: showLegend ? { l: 55, r: 20, t: 36, b: 95 } : { l: 55, r: 20, t: 36, b: 40 },
      legend: {
        orientation: "h",
        x: 0.5,
        xanchor: "center",
        y: -0.42, // pushed below the x-axis title (adding the per-panel export
        // button header shrank the plot area, which had dragged this back up)
        yanchor: "top",
        font: { size: 10 },
      },
    }),
    PLOTLY_CONFIG
  );
}

// ---------------------------------------------------------------------------
// Camera Sensitivity Comparison panel: two side-by-side log-log SNR plots
// (raw and pixel-size-normalized), each holding zero or more named,
// user-saved traces. Unlike the live Panel 4 SNR chart, these show only the
// bare curve - no +/-1 SNR shaded band, no current-operating-point marker -
// since the goal here is comparing shapes/positions of multiple saved
// curves, not reading off one camera's live noise margin.
// ---------------------------------------------------------------------------

function initComparisonChart(divId, { title, xAxisTitle }) {
  Plotly.newPlot(
    divId, [],
    mergeLayout({
      title: { text: title, font: { size: 13 } },
      xaxis: boxedAxis({ title: xAxisTitle, type: "log" }),
      yaxis: boxedAxis({ title: "Signal-to-Noise", type: "log" }),
    }),
    PLOTLY_CONFIG
  );
}

function updateComparisonChart(divId, { title, xAxisTitle, traces }) {
  const plotlyTraces = traces.map((t) => ({
    x: t.x, y: t.y, type: "scatter", mode: "lines",
    name: t.name, line: { color: t.color, width: 2 },
    // A custom hovertemplate rather than the default hoverinfo formatting -
    // this both guarantees the trace name shows up (so you can tell which
    // saved camera a curve belongs to) and rounds x/y to one decimal place
    // (the default would print full floating-point precision).
    hovertemplate: "%{x:.1f}, %{y:.1f}<br>%{fullData.name}<extra></extra>",
  }));

  Plotly.react(
    divId,
    plotlyTraces,
    mergeLayout({
      title: { text: title, font: { size: 13 } },
      xaxis: boxedAxis({ title: xAxisTitle, type: "log" }),
      yaxis: boxedAxis({ title: "Signal-to-Noise", type: "log" }),
      hovermode: "closest",
    }),
    PLOTLY_CONFIG
  );
}

window.CameraCharts = {
  initHistogramChart,
  updateHistogramChart,
  renderHistogramChart,
  initLineProfileChart,
  updateLineProfileChart,
  initSNRChart,
  updateSNRChart,
  initNoiseChart,
  updateNoiseChart,
  initComparisonChart,
  updateComparisonChart,
};
