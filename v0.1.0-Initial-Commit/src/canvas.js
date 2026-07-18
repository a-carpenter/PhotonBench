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
 * Render one sensor frame (Float32Array of ADU values, row-major rows x
 * cols) into `canvas` using the given false-color LUT, scaled to [vmin,vmax].
 * The canvas's pixel buffer (canvas.width/height) is set to rows x cols so
 * one LUT lookup maps to exactly one physical pixel; CSS handles displayed
 * scaling (see style.css - image-rendering left to the browser default for
 * smooth resampling when the box is smaller than 1024x1024).
 */
function renderSensorFrame(canvas, aduArray, rows, cols, lut, vmin, vmax) {
  if (canvas.width !== cols) canvas.width = cols;
  if (canvas.height !== rows) canvas.height = rows;

  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(cols, rows);
  const pixels = imageData.data;

  const span = (vmax - vmin) || 1;
  const lutSize = lut.length / 3;

  for (let i = 0; i < aduArray.length; i++) {
    let t = (aduArray[i] - vmin) / span;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;

    const lutIdx = Math.min(lutSize - 1, Math.round(t * (lutSize - 1)));
    const p = i * 4;
    pixels[p + 0] = lut[lutIdx * 3 + 0];
    pixels[p + 1] = lut[lutIdx * 3 + 1];
    pixels[p + 2] = lut[lutIdx * 3 + 2];
    pixels[p + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
}

/**
 * Draw a dashed horizontal line across the sensor image at `row`, in the
 * given color, on top of whatever renderSensorFrame() just drew. Used to
 * show exactly which row Panel 3's line profile is plotting - same color as
 * that line-plot trace, so the two panels read as connected at a glance.
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

window.CameraCanvas = { computeDisplayRange, renderSensorFrame, drawRowIndicatorLine };
