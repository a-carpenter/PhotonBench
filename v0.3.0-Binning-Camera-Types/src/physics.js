// physics.js
// Core sensor photoresponse simulation, ported from the Python prototype
// (pixel_photoresponse.py / camera_simulator_prototype.ipynb). Kept free of
// any DOM/canvas/Plotly code on purpose: this module only ever produces
// plain typed arrays and numbers ("compute a frame"). Rendering ("draw a
// frame") lives in canvas.js / charts.js and consumes this module's output.

/**
 * Standard normal random variable via Box-Muller.
 */
function gaussianRandom(mean = 0, std = 1) {
  let u = 1 - Math.random(); // (0, 1]
  let v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return mean + std * z;
}

/**
 * Poisson-distributed random integer with mean `lambda`.
 *
 * Uses Knuth's exact algorithm for small lambda, and a normal approximation
 * (mean=lambda, std=sqrt(lambda), rounded, clipped >= 0) for large lambda.
 * The normal approximation is required here, not just an optimization: the
 * UI allows dark current up to 5,000,000 e-/s and exposure times up to 3600s,
 * so dark_mean = dark_current * exposure_time can reach ~1.8e10. Knuth's
 * algorithm is O(lambda) and would never finish at that scale; the normal
 * approximation is also extremely accurate for lambda this large (Poisson
 * converges to Normal as lambda grows).
 */
function poissonRandom(lambda) {
  if (lambda <= 0) return 0;
  if (lambda < 50) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= Math.random();
    } while (p > L);
    return k - 1;
  }
  const z = gaussianRandom(0, 1);
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
}

// Sub-pixel supersampling grid used only for native pixels straddling the
// illumination disc's edge (see makeCircularIllumination below): a 4x4 grid
// of sample points per edge pixel is enough to anti-alias the boundary
// smoothly without meaningfully affecting performance, since the pixels that
// need it form a thin ring (O(radius)) rather than the whole sensor
// (O(rows*cols)).
const ILLUMINATION_EDGE_SUPERSAMPLE = 4;
// A pixel's half-diagonal (distance from center to corner) - the farthest a
// point within a pixel can be from that pixel's own center. Any pixel whose
// center is farther than this from the disc's boundary radius cannot
// possibly be split by that boundary, and can skip supersampling entirely.
const ILLUMINATION_EDGE_MARGIN = Math.SQRT1_2;

/**
 * Fraction (0-1) of a single pixel, centered at (dx, dy) relative to the
 * disc's center, that falls inside a disc of squared radius `r2` - found by
 * averaging subN x subN evenly-spaced sample points across the pixel's area.
 */
function pixelDiscCoverage(dx, dy, r2, subN) {
  let count = 0;
  const step = 1 / subN;
  const start = -0.5 + step / 2;
  for (let sy = 0; sy < subN; sy++) {
    const yy = dy + start + sy * step;
    const yy2 = yy * yy;
    for (let sx = 0; sx < subN; sx++) {
      const xx = dx + start + sx * step;
      if (xx * xx + yy2 <= r2) count++;
    }
  }
  return count / (subN * subN);
}

/**
 * Build a per-pixel incident-photon map: a uniformly illuminated disc of the
 * given radius (photon count = nPhotons fully inside, 0 fully outside),
 * centered by default in the middle of the sensor.
 *
 * Pixels stradding the disc's boundary get a FRACTIONAL photon count
 * (nPhotons times how much of that pixel's area actually falls inside the
 * disc), rather than being forced all-or-nothing - i.e. the edge is
 * anti-aliased. This matters once binning enters the picture: a hard,
 * un-anti-aliased edge means every native pixel is strictly "fully lit" or
 * "fully dark", so a binned super-pixel straddling the boundary ends up
 * being some exact whole-number mix of the two (e.g. with a 2x2 bin, exactly
 * 0, 1, 2, 3, or 4 lit native sub-pixels) - each mix produces a visibly
 * different signal level, which shows up as extra, spurious-looking
 * populations in the intensity histogram purely as an artifact of where the
 * bin grid happens to land relative to the circle, not anything physically
 * meaningful. Anti-aliasing the edge here means a binned super-pixel's
 * signal varies smoothly with how much of the disc it covers instead of in
 * discrete jumps, so that artifact goes away.
 *
 * @returns {Float64Array} length rows*cols, row-major (index = row*cols+col)
 */
function makeCircularIllumination(rows, cols, nPhotons, radius, centerRow, centerCol) {
  const cy = centerRow ?? Math.floor(rows / 2);
  const cx = centerCol ?? Math.floor(cols / 2);
  const photonMap = new Float64Array(rows * cols);
  const r2 = radius * radius;
  const rInner = Math.max(radius - ILLUMINATION_EDGE_MARGIN, 0);
  const rOuter = radius + ILLUMINATION_EDGE_MARGIN;
  const rInner2 = rInner * rInner;
  const rOuter2 = rOuter * rOuter;

  for (let y = 0; y < rows; y++) {
    const dy = y - cy;
    const dy2 = dy * dy;
    const rowOffset = y * cols;
    for (let x = 0; x < cols; x++) {
      const dx = x - cx;
      const dist2 = dy2 + dx * dx;

      if (dist2 <= rInner2) {
        photonMap[rowOffset + x] = nPhotons; // fully inside - no ambiguity
      } else if (dist2 < rOuter2) {
        // Straddles the boundary - supersample for a smooth fractional value.
        const coverage = pixelDiscCoverage(dx, dy, r2, ILLUMINATION_EDGE_SUPERSAMPLE);
        photonMap[rowOffset + x] = nPhotons * coverage;
      }
      // else: fully outside - leave at the Float64Array default of 0.
    }
  }
  return photonMap;
}

/**
 * Simulate one full sensor frame: shot noise + dark current (thermal) noise
 * + read noise + fixed offset, clipped to full well, then digitized to
 * `bitDepth` ADU via `gain`. Mirrors simulate_sensor() in the Python
 * notebook exactly (same order of operations, same clipping behavior).
 *
 * @param {Float64Array} photonMap  incident photons per pixel
 * @returns {{adu: Float32Array, signalElectrons: Float32Array}}
 */
function simulateSensor(photonMap, params) {
  const { exposureTime, qe, darkCurrent, readNoise, offset, fullWell, gain, bitDepth } = params;
  const n = photonMap.length;
  const adu = new Float32Array(n);
  const signalElectrons = new Float32Array(n);
  const darkMean = darkCurrent * exposureTime;
  const maxAdu = Math.pow(2, bitDepth) - 1;

  for (let i = 0; i < n; i++) {
    const pe = poissonRandom(photonMap[i] * qe);
    const de = poissonRandom(darkMean);
    const rn = gaussianRandom(0, readNoise);

    let se = pe + de + rn + offset;
    se = Math.min(Math.max(se, 0), fullWell);

    let a = se / gain;
    a = Math.min(Math.max(a, 0), maxAdu);

    signalElectrons[i] = se;
    adu[i] = a;
  }

  return { adu, signalElectrons };
}

/**
 * Simulate one full sensor frame, with optional binning. binHorizontal x
 * binVertical native pixels are combined into one output pixel, using one of
 * two algorithms depending on how the camera physically reads out:
 *
 *   - "charge" (CCD): every native pixel's photoelectrons and dark electrons
 *     are summed FIRST, in the charge domain, before read noise or offset -
 *     since binning combines charge on-chip before the single amplifier/ADC
 *     ever sees it, there is exactly ONE read-noise draw and ONE offset for
 *     the whole bin, not one per native pixel. The combined charge is
 *     clipped to `registerWellDepth` (the bin's charge-summing register
 *     capacity) rather than the per-pixel `fullWell` once more than one
 *     native pixel is being combined - a real bin register is built to hold
 *     more charge than any single native pixel could.
 *
 *   - "digital" (sCMOS/InGaAs): every native pixel is read out completely
 *     independently - its own shot/dark/read noise, its own `fullWell`
 *     clip, exactly as if it weren't binned at all - and only afterward are
 *     the resulting electron counts summed together in software. That sum
 *     is then clipped to the bit-depth ceiling, since adding together
 *     several already-read pixels can exceed what the display can
 *     represent even if no single pixel saturated on its own.
 *
 * With binHorizontal = binVertical = 1 (no binning), both algorithms reduce
 * to exactly the original per-pixel behavior (see simulateSensor above).
 *
 * @param {Float64Array} photonMap  incident photons per NATIVE pixel, length rows*cols
 * @param {number} rows  native sensor rows
 * @param {number} cols  native sensor columns
 * @param {object} params  as simulateSensor(), plus `registerWellDepth` (only used by "charge" mode when binning)
 * @param {number} binHorizontal  native columns combined per output pixel
 * @param {number} binVertical  native rows combined per output pixel
 * @param {"charge"|"digital"} binningMode
 * @returns {{adu: Float32Array, signalElectrons: Float32Array, binnedRows: number, binnedCols: number}}
 */
function simulateBinnedFrame(photonMap, rows, cols, params, binHorizontal, binVertical, binningMode) {
  const { exposureTime, qe, darkCurrent, readNoise, offset, fullWell, registerWellDepth, gain, bitDepth } = params;
  const darkMean = darkCurrent * exposureTime;
  const maxAdu = Math.pow(2, bitDepth) - 1;
  const binnedRows = Math.floor(rows / binVertical);
  const binnedCols = Math.floor(cols / binHorizontal);
  const n = binHorizontal * binVertical;

  const adu = new Float32Array(binnedRows * binnedCols);
  const signalElectrons = new Float32Array(binnedRows * binnedCols);

  for (let by = 0; by < binnedRows; by++) {
    for (let bx = 0; bx < binnedCols; bx++) {
      const outIdx = by * binnedCols + bx;

      if (binningMode === "charge") {
        let combinedPE = 0;
        let combinedDE = 0;
        for (let dy = 0; dy < binVertical; dy++) {
          const rowOffset = (by * binVertical + dy) * cols;
          for (let dx = 0; dx < binHorizontal; dx++) {
            const nativeIdx = rowOffset + (bx * binHorizontal + dx);
            combinedPE += poissonRandom(photonMap[nativeIdx] * qe);
            combinedDE += poissonRandom(darkMean);
          }
        }
        const rn = gaussianRandom(0, readNoise); // one read-noise draw for the whole bin
        let se = combinedPE + combinedDE + rn + offset;
        const wellCeiling = n > 1 ? registerWellDepth : fullWell;
        se = Math.min(Math.max(se, 0), wellCeiling);

        let a = se / gain;
        a = Math.min(Math.max(a, 0), maxAdu);

        signalElectrons[outIdx] = se;
        adu[outIdx] = a;
      } else {
        let summedElectrons = 0;
        for (let dy = 0; dy < binVertical; dy++) {
          const rowOffset = (by * binVertical + dy) * cols;
          for (let dx = 0; dx < binHorizontal; dx++) {
            const nativeIdx = rowOffset + (bx * binHorizontal + dx);
            const pe = poissonRandom(photonMap[nativeIdx] * qe);
            const de = poissonRandom(darkMean);
            const rn = gaussianRandom(0, readNoise); // each native pixel gets its own read noise
            let se = pe + de + rn + offset;
            se = Math.min(Math.max(se, 0), fullWell); // each native pixel clips at its own full well
            summedElectrons += se;
          }
        }

        let a = summedElectrons / gain;
        a = Math.min(Math.max(a, 0), maxAdu); // the SUM is clipped to the bit-depth ceiling

        signalElectrons[outIdx] = summedElectrons;
        adu[outIdx] = a;
      }
    }
  }

  return { adu, signalElectrons, binnedRows, binnedCols };
}

/**
 * Analytic (non-Monte-Carlo) noise budget in electrons, for a single pixel,
 * as a function of incident photon count(s). Mirrors analytic_noise() in
 * the Python notebook, INCLUDING the full-well fix: the signal is clipped to
 * `fullWell` before computing shot noise, so shot noise saturates alongside
 * the signal instead of continuing to grow past the point where the pixel
 * can physically hold any more charge (which previously produced a
 * discontinuity/peak-then-decline in the SNR curve right at saturation).
 *
 * @param {number[]|Float64Array} nPhotonsArray
 * @returns {{signal_e: Float64Array, noise_shot: Float64Array, noise_dark: Float64Array, noise_read: Float64Array, noise_total: Float64Array}}
 */
function analyticNoise(nPhotonsArray, params) {
  const { exposureTime, qe, darkCurrent, readNoise, fullWell } = params;
  const n = nPhotonsArray.length;

  const signal_e = new Float64Array(n);
  const noise_shot = new Float64Array(n);
  const noise_dark = new Float64Array(n);
  const noise_read = new Float64Array(n);
  const noise_total = new Float64Array(n);

  const darkMean = darkCurrent * exposureTime;
  const darkNoise = Math.sqrt(darkMean);

  for (let i = 0; i < n; i++) {
    const sUnclipped = nPhotonsArray[i] * qe;
    const s = Math.min(sUnclipped, fullWell);
    const shot = Math.sqrt(s);

    signal_e[i] = s;
    noise_shot[i] = shot;
    noise_dark[i] = darkNoise;
    noise_read[i] = readNoise;
    noise_total[i] = Math.sqrt(shot * shot + darkNoise * darkNoise + readNoise * readNoise);
  }

  return { signal_e, noise_shot, noise_dark, noise_read, noise_total };
}

/**
 * Convenience: expected (noise-free) mean signal in electrons for a pixel
 * receiving `nPhotons` incident photons, clipped to full well. Used for
 * reference lines / sanity displays.
 */
function expectedSignalElectrons(nPhotons, params) {
  const { exposureTime, qe, darkCurrent, offset, fullWell } = params;
  const raw = nPhotons * qe + darkCurrent * exposureTime + offset;
  return Math.min(raw, fullWell);
}

// Exposed as plain globals (no bundler/module system assumed - see the
// "Hosting" decision: GitHub Pages, plain <script> tags).
window.CameraPhysics = {
  gaussianRandom,
  poissonRandom,
  makeCircularIllumination,
  simulateSensor,
  simulateBinnedFrame,
  analyticNoise,
  expectedSignalElectrons,
};
