# PhotonBench - A Camera Simulation Tool

PhotonBench simulates the photoresponse of a digital image sensor, pixel by
pixel, so you can see how camera parameters and noise sources shape the
final image, its signal-to-noise ratio, and (in Spectroscopy mode) a
calculated spectrum. It's a static, client-side web app (no server, no
build step, no data leaves your browser) - see [CHANGELOG.md](CHANGELOG.md)
for version history.

On load, a splash screen shows the PhotonBench wordmark and three buttons -
**Imaging**, **Spectroscopy**, and **SNR Only** - one per tab described
below. Picking one jumps straight into that tab; you can switch between all
three at any time using the tabs in the app header.

## What's being simulated

Each pixel's signal is built up from three independent noise sources, added
in quadrature:

- **Shot noise** - Poisson statistics of photon arrival, thinned by quantum
  efficiency (QE) during photoelectron conversion.
- **Dark current (thermal) noise** - thermally generated electrons, also
  Poisson, whose mean scales with exposure time.
- **Read noise** - Gaussian, additive electronic noise from the readout
  circuitry, independent of exposure time.

A fixed electron-domain offset is added before the signal is clipped to the
sensor's full-well capacity (saturation) and digitized to the selected bit
depth via the sensitivity setting (electrons per ADU). Everything is
computed using **publicly available** specifications from manufacturer
datasheets - it does not reproduce any manufacturer's proprietary
calculator.

The illuminated region is a uniformly lit disc ("spot") of adjustable radius
centered on the sensor; everywhere outside the spot receives zero incident
photons (dark current and read noise only).

### Camera Type

A **Camera Type** selector (CCD, sCMOS, InGaAs) sits pinned above the
Parameters list and loads a per-type default parameter set (quantum
efficiency, dark current, read noise, full well, sensitivity, pixel size,
bit depth). Switching camera type also changes how pixel binning and EM
Gain (CCD only) combine signal and noise - see **Binning** below.

### Sensor size and binning

The sensor's Width (500-5000 px) and Height (1-5000 px, so a single-row
"line-scan" sensor is possible) are adjustable directly in the Camera
Simulator panel's header. Changing either resets binning back to 1x1 and
Spectroscopy's Region of Interest back to full sensor height.

**Binning** combines native pixels into "super pixels" - Horizontal and
Vertical bin factors (1/2/4/8) are set independently in the Parameters
panel. The sensor's field of view never changes with binning: the display
stays at native resolution, with binned super-pixel blocks rendered in
place, and any leftover native pixels (when the sensor size isn't an exact
multiple of the bin factor) drawn unilluminated. Binning rules differ by
camera type - CCD sums charge before readout (shot/dark noise scale by
sqrt(n), read noise is a single draw that doesn't scale), while sCMOS/InGaAs
combine already-digitized per-pixel values (shot/dark/read noise all scale
by sqrt(n)).

**EM Gain** (CCD only) models an electron-multiplying CCD's gain register,
checkbox-gated with its own 1-1000x slider. Signal (photons x QE) is
unchanged by EM Gain; shot noise and dark current noise both pick up the
gain register's excess noise factor (F² = 2, fixed); read noise is divided
by EM Gain outright, with no cap or floor.

## Imaging tab

- **Camera Simulator** - a live, false-color rendering of the full sensor
  frame. Each Play tick generates a new independent noise realization at the
  current parameters (~5 fps; a display setting, not a simulated frame
  rate).
- **Intensity Histogram** - the distribution of pixel ADU values across the
  whole sensor (80 bins), with a Linear/Log y-axis toggle.
- **Line Profile** - pixel intensity across the sensor's middle row (the
  same row marked by the colored line overlaid on the Camera Simulator
  panel).
- **SNR Curve** - analytic signal-to-noise ratio vs. incident photon count
  for a single pixel (log-log), with a red marker at the current Photons
  setting and a shaded band showing noise-fluctuation spread. When EM Gain
  and/or Binning are active, a dashed "Single Pixel SNR" baseline and a
  solid "Modified SNR" curve are both shown. A **Compare** button saves the
  active curve into the Camera Sensitivity Comparison panel.
- **Noise Contributions** - shot, dark, read, and total noise (electrons
  RMS) vs. incident photon count for a single pixel (log-log), with a
  dashed line at the current photon-count setting.
- **Camera Sensitivity Comparison** - up to 5 named, saved SNR curves shown
  side by side, both raw and normalized to a 13 µm reference pixel (for
  comparing cameras under equivalent illumination), with a collapsible,
  color-coded legend supporting per-trace delete.
- **Parameters** - Camera Type selector, then collapsible Experimental
  Parameters (Photons, Exposure Time, Spot Radius) and Camera Parameters
  (Quantum Efficiency, Dark Current, Read Noise, Full Well Depth, Register
  Well Depth [CCD], Offset, Sensitivity, Pixel Size, Bit Depth, Binning, EM
  Gain [CCD]) sections.

The Camera Simulator, Histogram, and Line Profile panels update live while
Play is running. The SNR Curve and Noise Contributions panels are analytic
curves that only recompute when a parameter changes.

## Spectroscopy tab

Reuses the live Camera Simulator panel and adds:

- **Calculated Spectrum** - built by vertically binning the sensor's
  illuminated rows into a single row of ADU values, using the same
  signal/noise model and per-camera-type binning rules as everywhere else
  in the app. A **Pixel/Wavelength** toggle switches the x-axis between raw
  column index and wavelength (nm), computed via a generic, non-proprietary
  Czerny-Turner grating dispersion model; it falls back to Pixel if the
  current Dispersion Model settings describe a grating geometry with no
  physical solution.
- **Region of Interest & Spectroscopy Controls**, in three sections:
  - **ROI & Binning** - **Full Sensor Vertical Bin** (checked by default:
    the whole sensor height feeds the spectrum) or a **Custom ROI** (linked
    Top/Bottom/Height fields - editing Height keeps the ROI's bottom pixel
    fixed and moves the top), plus **Horizontal Binning**, which mirrors
    (and is linked to) the primary Camera Parameters panel's Horizontal Bin
    control.
  - **Dispersion Model** - Focal Length, Center Wavelength, Grating Groove
    Density, Slit Width, and f-number are adjustable (the grating's
    included angle is fixed, not user-exposed). A collapsed-by-default
    dropdown off this section's header shows two live-computed readouts:
    **Wavelength Range** (the wavelength span the sensor's native pixels
    actually cover) and **Resolution** (the standard monochromator
    bandpass: reciprocal linear dispersion x Slit Width). Both show "-" on
    an invalid grating geometry.
  - **SNR vs. ROI Height** - a static curve showing how SNR scales with
    vertical bin height (for a flat-field illuminated vertical bin) across
    the full sensor height range, at the current photon level, camera type,
    and Horizontal Binning, with a red dashed line marking the current
    effective bin height. Has its own **Export** button.

## SNR Only tab

A focused, chart-only view: the SNR Curve and Noise Contributions panels
side by side, with the Camera Sensitivity Comparison panel spanning the
full width below - the same live panels used in Imaging mode, borrowed into
this layout rather than duplicated.

## Buttons and export

- **Play / Pause** (Camera Simulator) - starts or stops the live update
  loop. Switching tabs always pauses Play.
- **Export All** (Camera Simulator, Imaging tab) - pauses the simulation and
  exports everything at once: a PNG of the current sensor frame plus a PNG
  and metadata text file for the Histogram, Line Profile, SNR Curve, and
  Noise Contributions panels.
- **Export** - most panels (Histogram, Line Profile, SNR Curve, Noise
  Contributions, Comparison, and Spectroscopy's SNR vs. ROI Height) have
  their own Export button, downloading just that panel's PNG and a metadata
  text file (CSV data plus a `#`-commented header of every current
  parameter value, so an exported file is self-describing).
- **Reset to Default** (Parameters panel) - restores every slider-backed
  experimental and camera parameter, sensor dimensions, ROI, and axis mode
  to their defaults.

## License

Copyright (C) 2026 Andrew P. Carpenter. Licensed under the GNU Affero
General Public License v3.0 (AGPL-3.0) - see [LICENSE](LICENSE) for the
full text. You're free to use, modify, and redistribute this software,
including running a modified version as a network service, as long as
the corresponding source is made available under the same license. For
commercial licensing outside these terms, contact the author.
