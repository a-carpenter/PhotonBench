// dispersion.js
// Port of general_spectrometer_model.py - a generic, non-proprietary
// Czerny-Turner grating dispersion model (deliberately NOT one of Andor's or
// Teledyne's reverse-engineered, manufacturer-specific models - see that
// file's own docstring for the full "what got replaced, and with what"
// rationale). Kept free of any DOM/chart code, same convention as
// physics.js: this module only ever computes plain numbers from a plain
// params object.
//
// Params object shape (all required for the functions below, except `order`
// which defaults to 1 - the real calculator this was cross-checked against
// doesn't expose an order parameter either):
//   centerWavelengthNm, grooveDensity (grooves/mm), includedAngle2K (deg),
//   focalLengthMm, order (default 1), pixelSizeUm, sensorPxCount
//
// Note pixelSizeUm/sensorPxCount are meant to be the sensor's own NATIVE
// pixel size/column count (params.pixelSize / params.sensorWidth in main.js)
// - wavelength is mapped against native pixels regardless of Horizontal Bin,
// per the "Horizontal Bin still just reduces point count and improves SNR,
// it doesn't change the wavelength math" decision made when this was
// designed. Callers average/center over native pixels within the current
// bin, not this module.

/**
 * Thrown when the grating equation has no real solution at the given
 * settings (groove density too high for this center wavelength/angle) - a
 * genuine physical limit, not a bug.
 */
class InvalidGratingGeometry extends Error {}

/**
 * The largest groove density (grooves/mm) for which a real grating solution
 * exists at this center wavelength / included angle.
 */
function maxValidGrooveDensityPerMm(centerWavelengthNm, includedAngle2KDeg, order = 1) {
  const K = ((includedAngle2KDeg / 2) * Math.PI) / 180;
  const dMinNm = (order * centerWavelengthNm) / (2 * Math.cos(K));
  return 1.0e6 / dMinNm;
}

/**
 * Solves the symmetric Czerny-Turner grating equation for the incidence
 * (alpha) and center diffraction (betaCenter) angles, in radians.
 * @throws {InvalidGratingGeometry}
 */
function solveGratingGeometry(params) {
  const order = params.order ?? 1;
  const K = ((params.includedAngle2K / 2) * Math.PI) / 180;
  const d = 1.0e6 / params.grooveDensity; // groove spacing, nm
  const sinTheta = (order * params.centerWavelengthNm) / (2 * d * Math.cos(K));
  if (Math.abs(sinTheta) > 1) {
    const gMax = maxValidGrooveDensityPerMm(params.centerWavelengthNm, params.includedAngle2K, order);
    throw new InvalidGratingGeometry(
      `No real grating solution: groove_density=${params.grooveDensity} l/mm exceeds the max ` +
      `valid density (${gMax.toFixed(1)} l/mm) at lambda=${params.centerWavelengthNm} nm, ` +
      `2K=${params.includedAngle2K} deg.`
    );
  }
  const theta = Math.asin(sinTheta);
  return { alpha: theta + K, betaCenter: theta - K };
}

/**
 * Wavelength (nm) at sensor position `xMm` (mm from center). Pass a cached
 * {alpha, betaCenter} (from solveGratingGeometry) when calling this in a
 * loop to avoid re-solving the geometry per pixel.
 */
function wavelengthAtX(params, xMm, geometry) {
  const { alpha, betaCenter } = geometry ?? solveGratingGeometry(params);
  const order = params.order ?? 1;
  const d = 1.0e6 / params.grooveDensity;
  const beta = betaCenter + Math.atan(xMm / params.focalLengthMm);
  return (d / order) * (Math.sin(alpha) + Math.sin(beta));
}

/**
 * Local dispersion (nm/mm) at sensor position `xMm`.
 */
function dispersionAtX(params, xMm, geometry) {
  const { betaCenter } = geometry ?? solveGratingGeometry(params);
  const order = params.order ?? 1;
  const d = 1.0e6 / params.grooveDensity;
  const beta = betaCenter + Math.atan(xMm / params.focalLengthMm);
  return (d * Math.cos(beta)) / (order * params.focalLengthMm);
}

function nominalDispersion(params) {
  return dispersionAtX(params, 0);
}

/**
 * Maps native pixel index(es) to wavelength (nm). `pixelIndex` may be a
 * single number or an array/typed array (0-indexed, sensor-center-relative
 * offset computed the same way as the Python original: pixel (sensorPxCount
 * - 1) / 2 is dead-center).
 * @throws {InvalidGratingGeometry}
 */
function pixelToWavelength(pixelIndex, params) {
  const geometry = solveGratingGeometry(params);
  const pixelSizeMm = params.pixelSizeUm / 1000.0;
  const xOffset = (params.sensorPxCount - 1) / 2.0;

  function mapOne(px) {
    const xMm = (px - xOffset) * pixelSizeMm;
    return wavelengthAtX(params, xMm, geometry);
  }

  if (Array.isArray(pixelIndex) || ArrayBuffer.isView(pixelIndex)) {
    const out = new Array(pixelIndex.length);
    for (let i = 0; i < pixelIndex.length; i++) out[i] = mapOne(pixelIndex[i]);
    return out;
  }
  return mapOne(pixelIndex);
}

window.CameraDispersion = {
  InvalidGratingGeometry,
  maxValidGrooveDensityPerMm,
  solveGratingGeometry,
  wavelengthAtX,
  dispersionAtX,
  nominalDispersion,
  pixelToWavelength,
};
