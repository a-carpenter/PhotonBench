# Changelog

All notable changes to PhotonBench are documented here.

PhotonBench is in **pre-release** (version `0.y.z`, per [Semantic Versioning](https://semver.org/)). It is still in an active feedback-gathering phase and is not yet intended for broad, general release - expect things to keep changing.

## [0.2.0] - 2026-07-18

Feature and usability work since the initial pre-release, largely driven by early user feedback.

### Added
- **Camera Sensitivity Comparison panel**: save named SNR curves ("Compare" button in the SNR panel) and view them side by side as a raw curve and a curve normalized to a 13 µm reference pixel (accounting for pixel surface area, for comparing cameras under equivalent illumination). Includes a color-coded, scrollable legend with per-trace delete, a collapsible legend panel, and a 5-trace cap to keep the plots readable.
- **Pixel Size** camera parameter (µm, range 1-30, default 13).
- Adjustable sensor **width/height** inputs directly in the Camera Simulator panel header (height can go as low as 1, for line-scan sensors).
- **Info** button and popup in the app header, replacing the old always-visible info/disclaimer text panel.
- **Info** button and popup on the Camera Sensitivity Comparison panel, explaining the Normalized SNR plot.
- SNR panel's Export button now writes both the raw and pixel-size-normalized SNR curves into a single exported file.

### Changed
- Camera Simulator panel reverted to its original size after the info-text panel was moved into the header overlay, freeing up space for the new Comparison panel.
- Photons parameter's maximum raised to 5x the Full Well Depth, so the sensor can actually be driven into saturation.
- "Full Well" parameter renamed to "Full Well Depth".
- SNR chart's hover labels rounded to one decimal place, matching the Comparison panel's plots.

### Fixed
- Sensor display could occasionally render larger than its panel, cutting off part of the image, when the sensor's width/height were changed. The display is now pegged to the panel's width, matching real camera sensors (usually wider than tall).

## [0.1.0] - 2026-07-16

First working version, published to GitHub Pages under the GNU AGPL-3.0 license.

### Added
- Live camera sensor simulation with a false-color rendering of a simulated frame (Panel 1).
- Live intensity histogram (Panel 2) and middle-row line profile (Panel 3).
- Static, analytic Signal-to-Noise curve (Panel 4) and noise-contributions breakdown (Panel 5), both as functions of incident photon flux.
- Full set of adjustable experimental and camera parameters (photon flux, exposure time, spot radius, quantum efficiency, dark current, read noise, full well, gain, offset, bit depth).
- Play/Pause control, Reset to Default, and per-panel + "Export All" data/image export.
- Embedded info and disclaimer text panel.
