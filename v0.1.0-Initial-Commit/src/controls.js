// controls.js
// Builds the Box 6 parameter controls: each parameter gets a slider PLUS a
// synced number input (per the user's request), grouped into "Experimental
// Parameters" and "Camera Parameters". Several parameters span many orders
// of magnitude (e.g. Dark Current 0.0001 - 5,000,000; Full Well 1,000 -
// 200,000,000), so those use a log-scale slider internally: the <input
// type=range> itself moves linearly over an internal 0-1000 scale, which is
// mapped exponentially to the real value. Parameters with a small dynamic
// range (QE, Offset, Spot Radius) use a plain linear slider.

const SLIDER_STEPS = 1000;

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function formatNumber(v) {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1000 || abs < 0.001) return v.toExponential(3);
  // Trim to a reasonable number of significant digits without trailing zeros.
  return parseFloat(v.toPrecision(6)).toString();
}

/**
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.label
 * @param {number} opts.min
 * @param {number} opts.max
 * @param {number} opts.value
 * @param {"linear"|"log"} [opts.scale="linear"]
 * @param {number} [opts.step]  linear-scale step (ignored for log scale)
 * @param {string} [opts.unit]
 * @param {(value: number) => void} opts.onChange
 * @returns {{element: HTMLElement, getValue: () => number, setValue: (v:number)=>void}}
 */
function createParamControl(opts) {
  const { id, label, min, max, value, scale = "linear", step, unit = "", onChange } = opts;

  const wrapper = document.createElement("div");
  wrapper.className = "param-control";

  const labelEl = document.createElement("label");
  labelEl.setAttribute("for", id + "-slider");
  labelEl.textContent = unit ? `${label} (${unit})` : label;

  const row = document.createElement("div");
  row.className = "param-row";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.id = id + "-slider";
  slider.className = "param-slider";

  const numberInput = document.createElement("input");
  numberInput.type = "number";
  numberInput.id = id + "-number";
  numberInput.className = "param-number";

  const logMin = scale === "log" ? Math.log10(min) : null;
  const logMax = scale === "log" ? Math.log10(max) : null;

  function valueToSliderPos(v) {
    if (scale === "log") {
      const t = (Math.log10(clamp(v, min, max)) - logMin) / (logMax - logMin);
      return Math.round(t * SLIDER_STEPS);
    }
    return v;
  }

  function sliderPosToValue(pos) {
    if (scale === "log") {
      const t = pos / SLIDER_STEPS;
      return Math.pow(10, logMin + t * (logMax - logMin));
    }
    return pos;
  }

  if (scale === "log") {
    slider.min = "0";
    slider.max = String(SLIDER_STEPS);
    slider.step = "1";
  } else {
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step ?? (max - min) / 1000);
  }

  let currentValue = clamp(value, min, max);
  slider.value = String(valueToSliderPos(currentValue));
  numberInput.value = formatNumber(currentValue);
  numberInput.min = String(min);
  numberInput.max = String(max);

  function setValue(v, { fromExternal = true } = {}) {
    currentValue = clamp(v, min, max);
    slider.value = String(valueToSliderPos(currentValue));
    numberInput.value = formatNumber(currentValue);
    if (!fromExternal) onChange(currentValue);
  }

  slider.addEventListener("input", () => {
    currentValue = clamp(sliderPosToValue(Number(slider.value)), min, max);
    numberInput.value = formatNumber(currentValue);
    onChange(currentValue);
  });

  numberInput.addEventListener("change", () => {
    const v = clamp(Number(numberInput.value), min, max);
    currentValue = v;
    numberInput.value = formatNumber(v);
    slider.value = String(valueToSliderPos(v));
    onChange(v);
  });

  row.appendChild(slider);
  row.appendChild(numberInput);
  wrapper.appendChild(labelEl);
  wrapper.appendChild(row);

  return {
    element: wrapper,
    getValue: () => currentValue,
    setValue: (v) => setValue(v, { fromExternal: true }),
  };
}

/**
 * A plain <select> control for Bit Depth (discrete options only).
 */
function createSelectControl(opts) {
  const { id, label, options, value, onChange } = opts;

  const wrapper = document.createElement("div");
  wrapper.className = "param-control";

  const labelEl = document.createElement("label");
  labelEl.setAttribute("for", id + "-select");
  labelEl.textContent = label;

  const select = document.createElement("select");
  select.id = id + "-select";
  select.className = "param-select";
  for (const opt of options) {
    const optionEl = document.createElement("option");
    optionEl.value = String(opt);
    optionEl.textContent = String(opt);
    if (opt === value) optionEl.selected = true;
    select.appendChild(optionEl);
  }

  select.addEventListener("change", () => onChange(Number(select.value)));

  wrapper.appendChild(labelEl);
  wrapper.appendChild(select);

  return {
    element: wrapper,
    getValue: () => Number(select.value),
    setValue: (v) => {
      select.value = String(v);
    },
  };
}

window.CameraControls = { createParamControl, createSelectControl };
