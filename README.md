# PhotonBench - A Camera Simulation Tool

This tool simulates the photoresponse of a digital image sensor, pixel by
pixel, so you can see how camera parameters and noise sources shape the
final image.

**View the live site → https://a-carpenter.github.io/PhotonBench**


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
depth via the gain setting (electrons per ADU).

The illuminated region is a uniformly lit disc ("spot") of adjustable radius
centered on the sensor; everywhere outside the spot receives zero incident
photons (dark current and read noise only).

## The six panels

1. **Camera Simulator** - a live, false-color rendering of the full sensor
   frame. Each click of Play generates a new independent noise realization
   at the current parameters.
2. **Intensity Histogram** - the distribution of pixel values across the
   whole sensor, updating alongside Panel 1.
3. **Line Profile** - pixel intensity across the sensor's middle row,
   updating alongside Panel 1.
4. **SNR Curve** - signal-to-noise ratio vs. incident photon count for a
   single pixel (log-log). The red marker shows the SNR at the current
   parameter settings; the shaded band shows +/-1 SNR.
5. **Noise Contributions** - shot, dark, read, and total noise (electrons
   RMS) vs. incident photon count for a single pixel (log-log). The dashed
   vertical line marks the current photon-count setting.
6. **Parameters** - Experimental parameters (incident photons, exposure
   time, spot radius) and Camera parameters (quantum efficiency, dark
   current, read noise, full well capacity, offset, gain, bit depth).

Panels 1-3 update live while Play is running. Panels 4-5 are analytic
curves that only recompute when a parameter changes.

## Buttons

- **Play / Pause** (Panel 1) - starts or stops the live update loop.
- **Export All** (Panel 1) - pauses the simulation and exports everything at
  once: a PNG of the current sensor frame plus a PNG and metadata text file
  for each of Panels 2-5 (histogram, line profile, SNR curve, noise curve).
- **Export** (Panels 2-5) - each of these panels has its own Export button
  that downloads just that panel's PNG and metadata text file, so you can
  grab a single plot without exporting the whole set.
- **Reset to Default** (Panel 6) - restores every experimental and camera
  parameter to its default value.

## License

Copyright (C) 2026 Andrew P. Carpenter. Licensed under the GNU Affero
General Public License v3.0 (AGPL-3.0) - see [LICENSE](LICENSE) for the
full text. You're free to use, modify, and redistribute this software,
including running a modified version as a network service, as long as
the corresponding source is made available under the same license. For
commercial licensing outside these terms, contact the author.
