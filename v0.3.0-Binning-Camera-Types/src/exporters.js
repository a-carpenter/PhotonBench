// exporters.js
// Everything needed for the export buttons: downloading PNGs of each panel
// and text (CSV-style) files of the underlying data, with the current
// parameters recorded as a metadata header in each text file.
//
// exportAll() (Box 1's "Export All" button) exports every panel using one
// shared timestamp, so the full batch of files is grouped together by name.
// Each panel also has its own export button (Boxes 2-5) that calls the
// matching exportHistogram/exportLineProfile/exportSNR/exportNoise function
// directly, generating a fresh timestamp for just that panel.

function triggerDownload(filename, blobOrDataUrl) {
  const a = document.createElement("a");
  if (typeof blobOrDataUrl === "string") {
    a.href = blobOrDataUrl;
  } else {
    a.href = URL.createObjectURL(blobOrDataUrl);
  }
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function downloadTextFile(filename, textContent) {
  triggerDownload(filename, new Blob([textContent], { type: "text/plain" }));
}

function downloadCanvasPNG(canvas, filename) {
  triggerDownload(filename, canvas.toDataURL("image/png"));
}

/**
 * Plotly.downloadImage triggers a download itself (no data URL needed).
 */
function downloadPlotlyPNG(divId, filename) {
  return window.Plotly.downloadImage(divId, {
    format: "png",
    filename: filename.replace(/\.png$/, ""),
    width: 900,
    height: 550,
  });
}

function buildMetadataHeader(params) {
  const lines = ["# PhotonBench export", "# Parameters:"];
  for (const [key, value] of Object.entries(params)) {
    lines.push(`#   ${key}: ${value}`);
  }
  lines.push("");
  return lines.join("\n");
}

function arraysToCSV(columnNames, columns) {
  const rows = [columnNames.join(",")];
  const n = columns[0].length;
  for (let i = 0; i < n; i++) {
    rows.push(columns.map((col) => col[i]).join(","));
  }
  return rows.join("\n") + "\n";
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Panel 2 (histogram): PNG + CSV of bin centers/counts.
 * @param {object} args
 * @param {object} args.params  current parameter values (for metadata)
 * @param {object} args.frame   { histCenters, histCounts }
 * @param {string} [args.stamp] shared timestamp, if called as part of exportAll
 */
function exportHistogram({ params, frame, stamp = timestamp() }) {
  const header = buildMetadataHeader(params);
  downloadPlotlyPNG("histogram-chart", `histogram_${stamp}.png`);
  const csv = header + arraysToCSV(
    ["ADU", "PixelCount"],
    [frame.histCenters, frame.histCounts]
  );
  downloadTextFile(`histogram_${stamp}.txt`, csv);
}

/**
 * Panel 3 (line profile): PNG + CSV of pixel column vs. ADU.
 * @param {object} args
 * @param {object} args.params  current parameter values (for metadata)
 * @param {object} args.frame   { rowData }
 * @param {string} [args.stamp] shared timestamp, if called as part of exportAll
 */
function exportLineProfile({ params, frame, stamp = timestamp() }) {
  const header = buildMetadataHeader(params);
  downloadPlotlyPNG("line-profile-chart", `line-profile_${stamp}.png`);
  const rowIndices = Array.from(frame.rowData, (_, i) => i);
  const csv = header + arraysToCSV(
    ["PixelColumn", "ADU"],
    [rowIndices, Array.from(frame.rowData)]
  );
  downloadTextFile(`line-profile_${stamp}.txt`, csv);
}

/**
 * Panel 4 (SNR curve): PNG + CSV of incident photons vs. SNR, plus a third
 * column for the same curve normalized to a 13 µm reference pixel
 * (SNR * pixelSize^2 / 13^2 - the same ratio used by the Camera Sensitivity
 * Comparison panel's "Compare" button), all in one file.
 * @param {object} args
 * @param {object} args.params  current parameter values (for metadata; also
 *   supplies pixelSize for the normalized column)
 * @param {object} args.staticData  { photonRange, snr }
 * @param {string} [args.stamp] shared timestamp, if called as part of exportAll
 */
function exportSNR({ params, staticData, stamp = timestamp() }) {
  const header = buildMetadataHeader(params);
  downloadPlotlyPNG("snr-chart", `snr-curve_${stamp}.png`);
  const ratio = (params.pixelSize * params.pixelSize) / (13 * 13);
  const normalizedSnr = staticData.snr.map((v) => v * ratio);
  const csv = header + arraysToCSV(
    ["IncidentPhotons", "SNR", "NormalizedSNR_13umPixel"],
    [staticData.photonRange, staticData.snr, normalizedSnr]
  );
  downloadTextFile(`snr-curve_${stamp}.txt`, csv);
}

/**
 * Panel 5 (noise contributions): PNG + CSV of incident photons vs. each
 * noise component.
 * @param {object} args
 * @param {object} args.params  current parameter values (for metadata)
 * @param {object} args.staticData  { photonRange, noiseShot, noiseDark, noiseRead, noiseTotal }
 * @param {string} [args.stamp] shared timestamp, if called as part of exportAll
 */
function exportNoise({ params, staticData, stamp = timestamp() }) {
  const header = buildMetadataHeader(params);
  downloadPlotlyPNG("noise-chart", `noise-contributions_${stamp}.png`);
  const csv = header + arraysToCSV(
    ["IncidentPhotons", "ShotNoise_e", "DarkNoise_e", "ReadNoise_e", "TotalNoise_e"],
    [staticData.photonRange, staticData.noiseShot, staticData.noiseDark, staticData.noiseRead, staticData.noiseTotal]
  );
  downloadTextFile(`noise-contributions_${stamp}.txt`, csv);
}

/**
 * Camera Sensitivity Comparison panel: PNGs of both plots, plus one CSV
 * covering every saved trace on both (long format - one row per trace per
 * photon-range point - since different traces can have been saved under
 * different parameters and so don't necessarily share the same x-axis
 * points). No single `params` metadata header applies here the way it does
 * for the other panels, since each trace was saved at a different, possibly
 * different, point in time with its own settings.
 * @param {object} args
 * @param {Array<{name: string, photonRange: number[], snr: number[], snrNormalized: number[]}>} args.comparisonTraces
 * @param {string} [args.stamp] shared timestamp, if called as part of a future exportAll-style batch
 */
function exportComparison({ comparisonTraces, stamp = timestamp() }) {
  downloadPlotlyPNG("comparison-plot-1", `comparison-snr_${stamp}.png`);
  downloadPlotlyPNG("comparison-plot-2", `comparison-snr-normalized_${stamp}.png`);

  const traceNames = comparisonTraces.map((t) => t.name).join(", ") || "(none saved)";
  const header = [
    "# PhotonBench export",
    "# Camera Sensitivity Comparison",
    `# Traces: ${traceNames}`,
    "",
  ].join("\n");

  const rows = ["TraceName,IncidentPhotons,SNR,NormalizedSNR_13umPixel"];
  for (const t of comparisonTraces) {
    for (let i = 0; i < t.photonRange.length; i++) {
      rows.push([t.name, t.photonRange[i], t.snr[i], t.snrNormalized[i]].join(","));
    }
  }
  const csv = header + rows.join("\n") + "\n";
  downloadTextFile(`comparison-snr_${stamp}.txt`, csv);
}

/**
 * Export everything: PNGs for panels 1-5, text (CSV) files for panels 2-5,
 * with `params` written as a metadata header in each text file. All files
 * share one timestamp so the batch reads as a matched set.
 *
 * @param {object} args
 * @param {HTMLCanvasElement} args.sensorCanvas
 * @param {object} args.params  current parameter values (for metadata)
 * @param {object} args.frame   { histCenters, histCounts, rowData }
 * @param {object} args.staticData  { photonRange, snr, noiseShot, noiseDark, noiseRead, noiseTotal }
 */
function exportAll({ sensorCanvas, params, frame, staticData }) {
  const stamp = timestamp();

  downloadCanvasPNG(sensorCanvas, `sensor-frame_${stamp}.png`);
  exportHistogram({ params, frame, stamp });
  exportLineProfile({ params, frame, stamp });
  exportSNR({ params, staticData, stamp });
  exportNoise({ params, staticData, stamp });
}

window.CameraExporters = {
  exportAll,
  exportHistogram,
  exportLineProfile,
  exportSNR,
  exportNoise,
  exportComparison,
  downloadTextFile,
  downloadCanvasPNG,
  downloadPlotlyPNG,
  buildMetadataHeader,
  arraysToCSV,
};
