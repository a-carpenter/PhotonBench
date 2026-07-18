// colormap.js
// A compact approximation of matplotlib's "inferno" colormap (the same one
// used for Panel 1 in the Jupyter prototype), built from a handful of known
// control-point colors and linear interpolation in RGB space. Not a
// pixel-exact reproduction of matplotlib's LUT, but visually equivalent for
// a false-color sensor readout.

const INFERNO_STOPS = [
  [0.0, 0, 0, 4],
  [0.13, 31, 12, 72],
  [0.25, 85, 15, 109],
  [0.38, 136, 34, 106],
  [0.5, 186, 54, 85],
  [0.63, 227, 89, 51],
  [0.75, 249, 140, 10],
  [0.87, 249, 201, 50],
  [1.0, 252, 255, 164],
];

/**
 * Build a `size`-entry Uint8ClampedArray LUT (RGB triples) by interpolating
 * between INFERNO_STOPS. Building this once and indexing into it per-pixel
 * is much cheaper than interpolating per-pixel at render time.
 */
function buildInfernoLUT(size = 256) {
  const lut = new Uint8ClampedArray(size * 3);
  let stopIdx = 0;

  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);

    while (
      stopIdx < INFERNO_STOPS.length - 2 &&
      t > INFERNO_STOPS[stopIdx + 1][0]
    ) {
      stopIdx++;
    }

    const [t0, r0, g0, b0] = INFERNO_STOPS[stopIdx];
    const [t1, r1, g1, b1] = INFERNO_STOPS[stopIdx + 1];
    const span = t1 - t0 || 1;
    const f = (t - t0) / span;

    lut[i * 3 + 0] = r0 + (r1 - r0) * f;
    lut[i * 3 + 1] = g0 + (g1 - g0) * f;
    lut[i * 3 + 2] = b0 + (b1 - b0) * f;
  }

  return lut;
}

window.CameraColormap = { buildInfernoLUT, INFERNO_STOPS };
