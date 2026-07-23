# Changelog

All notable changes to PhotonBench are documented here.

PhotonBench is in **pre-release** (version `0.y.z`, per [Semantic Versioning](https://semver.org/)). It is still in an active feedback-gathering phase and is not yet intended for broad, general release - expect things to keep changing.

## [0.4.0] - 2026-07-22

New Spectroscopy mode: a full ROI/binning-driven calculated spectrum with an optional wavelength axis, plus completed Info content across every panel.

### Added
- **Splash screen**: a full-viewport landing screen shown on every page load, with a light-pulse-waveform graphic and the PhotonBench wordmark on the left and three mode buttons (Imaging, Spectroscopy, SNR Only) on the right. Picking a mode hides the splash and jumps straight into that tab.
- **SNR Only mode**: a new top-level tab giving a focused, chart-only view of the SNR and Noise Contributions panels side by side, plus the Camera Sensitivity Comparison panel below - the same live panels used in Imaging mode, borrowed into a dedicated layout rather than duplicated.
- **Spectroscopy mode**: a new top-level tab alongside Imaging and SNR Only, reusing the live Camera Simulator panel and adding a Calculated Spectrum panel and a Region of Interest & Spectroscopy Controls panel.
- **Full Sensor Vertical Bin / Custom ROI**: the Calculated Spectrum bins either the entire sensor height or a user-defined ROI (Top, Bottom, and a linked Height field that anchors to the ROI's bottom pixel) down to a single row, using the same per-camera-type binning rules as the rest of the simulation.
- **Horizontal Binning** in Spectroscopy, mirrored from (and linked to) the primary Camera Parameters panel, reducing point count and improving SNR along the spectrum's x-axis.
- **Dispersion Model**: a generic, non-proprietary Czerny-Turner grating model mapping native pixel position to wavelength, with adjustable Focal Length, Center Wavelength, Grating Groove Density (l/mm), Slit Width, and f-number. A Pixel/Wavelength toggle on the Calculated Spectrum switches its x-axis, falling back to Pixel when the current geometry has no physical solution.
- **SNR vs. ROI Height** chart: a static curve showing how SNR scales with vertical bin height across the full sensor height range, reflecting the current photon level, camera type, and Horizontal Binning, with a red dashed line marking the current effective bin height.
- Info panel content completed for the Calculated Spectrum and Region of Interest & Spectroscopy Controls panels - every panel in the app now has real Info content (none left as "coming soon" placeholders).
- **Wavelength Range / Resolution** readouts: a collapsed-by-default dropdown off the "Dispersion Model" header showing the span of wavelengths the sensor's native pixels cover (Wavelength Range) and the standard monochromator bandpass - reciprocal linear dispersion x Slit Width (Resolution) - both recomputed live from the Dispersion Model settings, falling back to "-" on an invalid grating geometry.
- **Export** button on the SNR vs. ROI Height chart, downloading a PNG plus a Height/SNR CSV with the usual parameter metadata header, plus the current effective bin height (where the chart's red dashed line sits).

### Changed
- sCMOS default Sensitivity raised to 1.8 e-/ADU.
- Sensor Width's minimum lowered from 1024 to 500 px.
- Calculated Spectrum's chart no longer repeats its own title in the plot area, since the panel header already carries it.
- App header's contact email updated.
- Main Info panel's overview text now describes all three tabs (Imaging, Spectroscopy, SNR Only) instead of just the original single-view simulation.

### Fixed
- Reset to Default now also resets Spectroscopy's ROI back to full sensor height and the Calculated Spectrum's x-axis back to Pixel, previously left stale after a reset.
- **EM Gain noise model corrected.** The previous implementation approximated EM Gain by substituting an "effective QE" - (QE / 2) x EM Gain - into the ordinary no-EM-Gain formulas. That incorrectly let shot noise scale up right along with the artificially boosted signal, and left the signal itself modified by EM Gain when it shouldn't be. The model now applies the physically correct treatment everywhere (the live simulated frame and the analytic SNR/Noise Contributions curves alike): signal (photons x QE) is completely unchanged by EM Gain; shot noise and dark current noise both pick up the gain register's excess noise factor (F^2 = 2, fixed, not user-adjustable); and read noise is divided by EM Gain outright, with no cap or floor.

## [0.3.0] - 2026-07-20

Major feature work since 0.2.0: new camera types, pixel binning, and a reworked illumination model, plus SNR/histogram display upgrades, a reorganized Parameters panel, and general UI polish and bug fixes.

### Added
- **Camera Type selector** (CCD, sCMOS, InGaAs) with per-type default parameter sets, pinned above the scrollable Parameters list.
- **Pixel binning**: independent Horizontal/Vertical bin factors (1/2/4/8), checkbox-gated in Camera Parameters for every camera type. The sensor's field of view never changes with binning - the display stays at native resolution, with binned "super pixel" blocks rendered in place and any leftover native pixels (when the sensor size isn't an exact multiple of the bin factor) drawn unilluminated. Changing sensor width/height resets binning back to 1x1.
- **EM Gain** (CCD-only): checkbox-gated 1-1000x multiplier applied to the effective quantum efficiency, with its own slider. Checkbox relabeled "Enable EM Gain" for clarity.
- **Register Well Depth** (CCD-only): the charge-summing register's capacity, used as the clipping ceiling for binned CCD charge in place of the per-pixel Full Well Depth.
- SNR panel now plots both a dashed "Single Pixel SNR" baseline and a solid "Binned SNR" trace whenever EM Gain and/or Binning are active, so their effect can be compared directly; the Comparison panel snapshots the active (Binned SNR) curve.
- Histogram panel: Linear/Log y-axis toggle ("Change to Log"/"Change to Linear"), defaulting to linear.
- Circled-"i" Info icon and popup added to every panel header (previously only the app header and Comparison panel had one); placeholder text on panels without content yet.
- Parameters panel (Box 6) header, matching the Camera Simulator panel's height, with its own Info icon.
- "Experimental Parameters" and "Camera Parameters" sections are now collapsible via a chevron toggle.

### Changed
- **Illumination model**: the circular illumination disc is now anti-aliased (supersampled at its boundary) instead of a hard binary mask, removing discretization artifacts that showed up as extra histogram populations under binning.
- Camera Parameters reordered: Register Well Depth now sits directly below Full Well Depth; Bit Depth now sits directly below Pixel Size; Binning sits directly below Bit Depth; EM Gain remains last (CCD only).
- Camera Type selector is now pinned/immovable above the scrolling parameter list, with a divider marking the boundary, mirroring the Reset to Default button's treatment at the bottom.
- Collapsible-section chevrons moved to the right side of their section titles.
- All panel headers (Boxes 1-6) now render at the same height.
- App header's Info icon is now transparent, blending into the titlebar instead of appearing as a solid button.

### Fixed
- Binning controls remained visibly active and interactive even when the Binning checkbox was unchecked, due to a CSS specificity conflict with the browser's built-in `[hidden]` rule.

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
