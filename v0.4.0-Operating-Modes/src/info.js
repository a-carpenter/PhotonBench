// info.js
// Content + renderer for the info panel under Box 1: a short About/attribution
// note (title, author/date byline, body paragraphs, disclaimer). This is
// fixed content owned by this file - it renders as structured HTML (title
// styled larger, byline styled smaller) rather than plain text, so it's
// built with loadInfoText() returning HTML instead of fetching README.md.

const INFO_TITLE = "PhotonBench – A Camera Simulation Tool";

const INFO_META_LINES = [
  "Author: Andrew P. Carpenter, Ph.D.",
  "Created 2026",
];

// Each entry is { html, extraClass? }. `html` is trusted, hand-authored
// markup (not escaped) so specific words/phrases can carry inline emphasis
// (see "publicly available", the email address, and "Disclaimer" below).
// `extraClass` lets a specific paragraph get extra spacing/styling - the
// disclaimer gets a second line-break's worth of margin above it to set it
// apart from the preceding paragraph.
const INFO_BODY_PARAGRAPHS = [
  { html: 'This tool simulates camera performance using <em class="info-emphasis">publicly available</em> specifications from manufacturer datasheets. Given an incident photon flux, it computes the photoresponse of each camera pixel, accounting for read noise, dark noise, and shot noise. The resulting signal is converted to ADU (analog-to-digital units) using the camera’s sensitivity (gain) and a fixed offset, with this calculation performed across every pixel in the sensor. SNR and total noise are computed relative to the camera’s full well capacity; the shaded region in SNR plots reflects the influence of total noise, showing how per-pixel SNR varies with actual noise fluctuations.' },
  { html: 'The simulator is organized into three tabs. <strong>Imaging</strong> shows a live, false-color simulated sensor frame alongside its intensity histogram, a middle-row line profile, and static SNR and noise-contribution curves. <strong>Spectroscopy</strong> builds a calculated spectrum by vertically binning either a user-defined region of interest or the full sensor into a single row, with an optional wavelength axis driven by an adjustable grating dispersion model. <strong>SNR Only</strong> distills the SNR and noise-contribution curves into a focused, side-by-side view alongside the camera sensitivity comparison chart.' },
  { html: 'For any questions or suggested features, please email the author at: <strong><em class="info-emphasis">carpenter[dot]a[at]icloud[dot]com</em></strong>' },
  { html: '<em class="info-emphasis">Disclaimer</em>: At present APC is an employee of Oxford Instruments plc, which owns the camera manufacturer Andor Technologies. This simulation tool was developed as an independent project by APC, separate from their employer, and Oxford Instruments plc assumes no responsibility or liability for any errors, omissions, damages, or losses arising from the use of this simulation tool. Under no circumstances shall Oxford Instruments plc be held liable for any direct, indirect, or incidental damages.', extraClass: "info-disclaimer" },
];

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildInfoHTML() {
  const metaHtml = INFO_META_LINES
    .map((line) => `<div class="info-meta-line">${escapeHtml(line)}</div>`)
    .join("");
  const bodyHtml = INFO_BODY_PARAGRAPHS
    .map(({ html, extraClass }) => `<p${extraClass ? ` class="${extraClass}"` : ""}>${html}</p>`)
    .join("");

  return (
    `<h2 class="info-title">${escapeHtml(INFO_TITLE)}</h2>` +
    `<div class="info-meta">${metaHtml}</div>` +
    bodyHtml
  );
}

// Kept async/Promise-returning so main.js's existing `.then(...)` call site
// doesn't need to change shape even though there's no actual fetch anymore.
async function loadInfoText() {
  return buildInfoHTML();
}

window.CameraInfo = {
  loadInfoText,
  buildInfoHTML,
  INFO_TITLE,
  INFO_META_LINES,
  INFO_BODY_PARAGRAPHS,
};
