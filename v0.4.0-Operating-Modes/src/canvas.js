// canvas.js
// Panel 1 (sensor image) rendering. Pure "draw a frame" code: takes the
// typed arrays produced by physics.js and paints them into a <canvas>. No
// simulation logic lives here.

/**
 * Fit a display range to the ACTUAL data range of a frame (not the full
 * bit-depth range), with a little padding, so small noise fluctuations stay
 * visible instead of being compressed against a much larger fixed scale.
 * Same idea as compute_display_range() in the notebook; reused by Panels
 * 1-3 so their scales stay consistent with each other.
 */
function computeDisplayRange(dataArray, maxValue) {
  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (let i = 0; i < dataArray.length; i++) {
    const v = dataArray[i];
    if (v < dataMin) dataMin = v;
    if (v > dataMax) dataMax = v;
  }
  if (!isFinite(dataMin) || !isFinite(dataMax)) {
    return { vmin: 0, vmax: maxValue };
  }
  const pad = Math.max((dataMax - dataMin) * 0.05, 1.0);
  let vmin = Math.max(dataMin - pad, 0);
  let vmax = maxValue !== undefined ? Math.min(dataMax + pad, maxValue) : dataMax + pad;
  if (vmax <= vmin) {
    vmin = Math.max(vmin - 1, 0);
    vmax = vmin + 1;
  }
  return { vmin, vmax };
}

/**
 * Render one sensor frame into `canvas` using the given false-color LUT,
 * scaled to [vmin,vmax]. The canvas's pixel buffer always stays at the
 * sensor's NATIVE resolution (nativeRows x nativeCols) - the field of view
 * the user set - regardless of binning, so the sensor's on-screen size never
 * changes when the bin factors change (only the apparent pixel size does).
 *
 * `aduArray` holds one value per BINNED output pixel (binnedRows x
 * binnedCols, row-major); each value is painted across its
 * binHorizontal x binVertical block of native pixels ("super pixels"). If
 * the native sensor size isn't an exact multiple of the bin factors, the
 * leftover strip of native pixels beyond the last full bin (at most
 * binFactor - 1 pixels wide, along the right and/or bottom edge) is drawn
 * unilluminated (black) - those pixels were never part of a complete,
 * readable bin, so they carry no signal.
 *
 * With binHorizontal = binVertical = 1, this reduces to one LUT lookup per
 * native pixel, identical to the original unbinned behavior.
 *
 * Returns the ImageData it painted, so callers can cache it and cheaply
 * repaint the same frame (e.g. while dragging an overlay like the ROI box)
 * without re-running the simulation.
 */
function renderSensorFrame(canvas, aduArray, binnedRows, binnedCols, binHorizontal, binVertical, nativeRows, nativeCols, lut, vmin, vmax) {
  if (canvas.width !== nativeCols) canvas.width = nativeCols;
  if (canvas.height !== nativeRows) canvas.height = nativeRows;

  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(nativeCols, nativeRows);
  const pixels = imageData.data;

  const span = (vmax - vmin) || 1;
  const lutSize = lut.length / 3;
  const activeRows = binnedRows * binVertical;
  const activeCols = binnedCols * binHorizontal;

  for (let y = 0; y < nativeRows; y++) {
    const rowBase = y * nativeCols;
    const dead = y >= activeRows;
    const by = dead ? 0 : Math.floor(y / binVertical);

    for (let x = 0; x < nativeCols; x++) {
      const p = (rowBase + x) * 4;

      if (dead || x >= activeCols) {
        pixels[p + 0] = 0;
        pixels[p + 1] = 0;
        pixels[p + 2] = 0;
        pixels[p + 3] = 255;
        continue;
      }

      const bx = Math.floor(x / binHorizontal);
      let t = (aduArray[by * binnedCols + bx] - vmin) / span;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;

      const lutIdx = Math.min(lutSize - 1, Math.round(t * (lutSize - 1)));
      pixels[p + 0] = lut[lutIdx * 3 + 0];
      pixels[p + 1] = lut[lutIdx * 3 + 1];
      pixels[p + 2] = lut[lutIdx * 3 + 2];
      pixels[p + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return imageData;
}

/**
 * Draw a dashed horizontal line across the sensor image at `row` (in NATIVE
 * pixel coordinates), in the given color, on top of whatever
 * renderSensorFrame() just drew. Used to show exactly which row Panel 3's
 * line profile is plotting - same color as that line-plot trace, so the two
 * panels read as connected at a glance.
 *
 * Since the canvas's pixel buffer always stays at the sensor's native
 * resolution regardless of binning (see renderSensorFrame above), the line's
 * on-screen size is already constant with a fixed thickness/dash - no
 * bin-dependent compensation needed here.
 */
function drawRowIndicatorLine(canvas, row, color) {
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.setLineDash([10, 6]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, row + 0.5);
  ctx.lineTo(canvas.width, row + 0.5);
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw the Spectroscopy Region of Interest box on top of whatever
 * renderSensorFrame() just painted: a full-width band from `topRow` to
 * `bottomRow` (NATIVE pixel coordinates, inclusive), with a translucent fill
 * so the illuminated frame stays visible underneath, a solid border all the
 * way around, and thicker "handle" strokes right on the top/bottom edges
 * themselves - those thicker lines are exactly where a mouse/pointer drag
 * will grab the box (see the pointer handlers in main.js), so the extra
 * weight there is a visual affordance, not just decoration.
 *
 * Always spans the full canvas width - the ROI only ever narrows the
 * sensor's vertical extent, per the "Full Vertical Bin" spectrum design
 * (see main.js), so there is no horizontal bound to draw.
 */
function drawROIBox(canvas, topRow, bottomRow, color) {
  const ctx = canvas.getContext("2d");
  const top = Math.min(topRow, bottomRow);
  const bottom = Math.max(topRow, bottomRow);
  const height = Math.max(bottom - top, 0);

  ctx.save();
  ctx.fillStyle = color + "26"; // ~15% alpha translucent fill (hex alpha suffix)
  ctx.fillRect(0, top, canvas.width, height);

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.strokeRect(0.75, top + 0.75, canvas.width - 1.5, height - 1.5);

  // Thicker grab-handle strokes right on the top/bottom edges.
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, top + 2);
  ctx.lineTo(canvas.width, top + 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, bottom - 2);
  ctx.lineTo(canvas.width, bottom - 2);
  ctx.stroke();
  ctx.restore();
}

window.CameraCanvas = { computeDisplayRange, renderSensorFrame, drawRowIndicatorLine, drawROIBox };
