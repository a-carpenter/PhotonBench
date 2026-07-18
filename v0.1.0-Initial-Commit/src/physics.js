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

/**
 * Build a per-pixel incident-photon map: a uniformly illuminated disc of the
 * given radius (photon count = nPhotons inside, 0 outside), centered by
 * default in the middle of the sensor.
 *
 * @returns {Float64Array} length rows*cols, row-major (index = row*cols+col)
 */
function makeCircularIllumination(rows, cols, nPhotons, radius, centerRow, centerCol) {
  const cy = centerRow ?? Math.floor(rows / 2);
  const cx = centerCol ?? Math.floor(cols / 2);
  const photonMap = new Float64Array(rows * cols);
  const r2 = radius * radius;
  for (let y = 0; y < rows; y++) {
    const dy = y - cy;
    const dy2 = dy * dy;
    const rowOffset = y * cols;
    for (let x = 0; x < cols; x++) {
      const dx = x - cx;
      if (dy2 + dx * dx <= r2) {
        photonMap[rowOffset + x] = nPhotons;
      }
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
  analyticNoise,
  expectedSignalElectrons,
};
