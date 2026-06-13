import { PybricksHubClient } from "./pybricks.js?v=20260613-1";
import {
  estimateBatteryPercentFromVoltage,
  isMotorDeviceId,
  liveModesForDeviceId,
  makeInitialPorts,
  PORT_NAMES
} from "./parser.js?v=20260613-1";

const connectBtn = document.querySelector("#connectBtn");
const refreshBtn = document.querySelector("#refreshBtn");
const disconnectBtn = document.querySelector("#disconnectBtn");
const connectionState = document.querySelector("#connectionState");
const hubTitle = document.querySelector("#hubTitle");
const modelValue = document.querySelector("#modelValue");
const firmwareValue = document.querySelector("#firmwareValue");
const profileValue = document.querySelector("#profileValue");
const batteryValue = document.querySelector("#batteryValue");
const writeSizeValue = document.querySelector("#writeSizeValue");
const scanStamp = document.querySelector("#scanStamp");
const hubScreenText = document.querySelector("#hubScreenText");
const hubThumbPlaceholder = document.querySelector("#hubThumbPlaceholder");
const hubThumbImage = document.querySelector("#hubThumbImage");
const hubDashboard = document.querySelector("#hubDashboard");
const leftPorts = document.querySelector("#leftPorts");
const rightPorts = document.querySelector("#rightPorts");
const portCount = document.querySelector("#portCount");
const messageBox = document.querySelector("#messageBox");
const dashboardStage = document.querySelector(".dashboard-stage");
const hubVoltage = document.querySelector("#hubVoltage");
const hubCurrent = document.querySelector("#hubCurrent");
const imuYaw = document.querySelector("#imuYaw");
const imuPitch = document.querySelector("#imuPitch");
const imuRoll = document.querySelector("#imuRoll");
const tabButtons = [...document.querySelectorAll("[data-tab]")];
const tabPanels = [...document.querySelectorAll("[data-tab-panel]")];
const motorPortSelect = document.querySelector("#motorPortSelect");
const motorStepSelect = document.querySelector("#motorStepSelect");
const runMotorTestBtn = document.querySelector("#runMotorTestBtn");
const downloadMotorChartBtn = document.querySelector("#downloadMotorChartBtn");
const motorTestStatus = document.querySelector("#motorTestStatus");
const motorProgress = document.querySelector("#motorProgress");
const motorProgressPhase = document.querySelector("#motorProgressPhase");
const motorProgressPercent = document.querySelector("#motorProgressPercent");
const motorProgressFill = document.querySelector("#motorProgressFill");
const motorSummary = document.querySelector("#motorSummary");
const motorChart = document.querySelector("#motorChart");
const motorCurrentChart = document.querySelector("#motorCurrentChart");
const portModeMenu = document.querySelector("#portModeMenu");
const hubPortLabels = [...document.querySelectorAll("[data-hub-port]")];

const client = new PybricksHubClient();

const HUB_IMAGE_BASE = "./assets/pybricks-hubs";
const HUB_IMAGE_BY_PRODUCT_ID = Object.freeze({
  64: "hub-move.png",
  65: "hub-city.png",
  128: "hub-technic.png",
  129: "hub-prime.png",
  131: "hub-essential.png"
});

const SENSOR_DEVICE_IDS = new Set([8, 34, 35, 37, 61, 62, 63, 64]);
const COLOR_SENSOR_DEVICE_IDS = new Set([37, 61]);
const LIVE_MODE_LABELS = Object.freeze({
  angle: "Angle",
  speed: "Speed",
  force: "Force",
  pressed: "Pressed",
  distance: "Distance",
  reflection: "Reflection",
  ambient: "Ambient",
  hsv: "HSV",
  rgb: "RGB",
  color: "Color",
  error: "Error"
});
const MOTOR_START_RPM_THRESHOLD = 5;
const MOTOR_SWEEP_SAMPLE_INTERVAL_MS = 260;
const WEB_BLUETOOTH_UNAVAILABLE_MESSAGE =
  "Web Bluetooth is unavailable. Use Chrome or Edge over HTTPS or localhost.";
const BLUETOOTH_ADAPTER_UNAVAILABLE_MESSAGE =
  "Bluetooth adapter is off or unavailable. Turn on Bluetooth and reload.";

const state = {
  connected: false,
  busy: false,
  bluetoothAvailable: true,
  hub: null,
  capabilities: null,
  ports: makeInitialPorts(),
  imu: {
    voltage: null,
    current: null,
    yaw: null,
    pitch: null,
    roll: null
  },
  liveValues: new Map(),
  selectedModeByPort: new Map(),
  openModeMenuPort: "",
  motorTest: {
    data: [],
    metrics: null,
    running: false,
    selectedPort: "",
    step: 10,
    sampleIntervalMs: MOTOR_SWEEP_SAMPLE_INTERVAL_MS,
    progress: {
      phase: "idle",
      percent: 0,
      pointsDone: 0,
      pointsTotal: 0
    }
  },
  message: "",
  error: ""
};

let renderQueued = false;
let liveMonitorRestartPromise = Promise.resolve();

function setActiveTab(tabName) {
  if (tabName !== "dashboard") {
    closeModeMenu(false);
  }

  for (const button of tabButtons) {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle("tab--active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  }

  for (const panel of tabPanels) {
    panel.hidden = panel.dataset.tabPanel !== tabName;
  }
}

function setConnectionState(label, variant = "idle") {
  connectionState.textContent = label;
  connectionState.className = `state-pill state-pill--${variant}`;
}

function setBusy(isBusy, label = "") {
  state.busy = isBusy;
  connectBtn.disabled = isBusy || state.connected || !state.bluetoothAvailable;
  refreshBtn.disabled = isBusy || !state.connected;
  disconnectBtn.disabled = isBusy || !state.connected;

  if (isBusy && label) {
    setConnectionState(label, "busy");
  }
}

function setMessage(message, isError = false) {
  state.message = message;
  state.error = isError ? message : "";
  messageBox.textContent = message;
  messageBox.className = isError ? "message-box message-box--error" : "message-box";
}

function queueRenderHub() {
  if (renderQueued) {
    return;
  }

  renderQueued = true;
  window.requestAnimationFrame(() => {
    renderQueued = false;
    renderHub();
  });
}

function portClass(port) {
  if (port.status === "device") {
    return "port-tile port-tile--device";
  }

  if (port.status === "unknown") {
    return "port-tile port-tile--unknown";
  }

  if (port.status === "error") {
    return "port-tile port-tile--error";
  }

  if (port.status === "unavailable") {
    return "port-tile port-tile--unavailable";
  }

  return "port-tile";
}

function describePort(port) {
  if (port.status === "device") {
    return {
      label: port.deviceName,
      detail: `Device ID ${port.deviceId}`
    };
  }

  if (port.status === "unknown") {
    return {
      label: port.deviceName || "Unknown",
      detail: port.deviceId ? `Device ID ${port.deviceId}` : "No device ID"
    };
  }

  if (port.status === "empty") {
    return {
      label: "Empty",
      detail: "No device"
    };
  }

  if (port.status === "error") {
    return {
      label: "Error",
      detail: port.error || "Read failed"
    };
  }

  return {
    label: "Unavailable",
    detail: "Not scanned"
  };
}

function liveValueKey(port, mode) {
  return `${port}:${mode}`;
}

function liveModesForPort(port) {
  if (port.status !== "device" && port.status !== "unknown") {
    return [];
  }

  return liveModesForDeviceId(port.deviceId);
}

function selectedLiveMode(port) {
  const modes = liveModesForPort(port);
  const selected = state.selectedModeByPort.get(port.port);

  return modes.includes(selected) ? selected : modes[0];
}

function liveModeLabel(mode) {
  return LIVE_MODE_LABELS[mode] ?? String(mode || "").replace(/^\w/, (letter) => letter.toUpperCase());
}

function parseHsvValue(value) {
  const parts = String(value ?? "").split(",").map((part) => Number(part.trim()));

  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  return {
    h: ((parts[0] % 360) + 360) % 360,
    s: Math.max(0, Math.min(100, parts[1])),
    v: Math.max(0, Math.min(100, parts[2]))
  };
}

function hsvToRgb(value) {
  const hsv = parseHsvValue(value);

  if (!hsv) {
    return null;
  }

  const h = hsv.h / 60;
  const s = hsv.s / 100;
  const v = hsv.v / 100;
  const c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 1) {
    r = c;
    g = x;
  } else if (h < 2) {
    r = x;
    g = c;
  } else if (h < 3) {
    g = c;
    b = x;
  } else if (h < 4) {
    g = x;
    b = c;
  } else if (h < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  return [r, g, b].map((channel) => Math.round((channel + m) * 255));
}

function formatLiveValue(reading, port = null) {
  const value = String(reading.value ?? "").trim();

  if (reading.status === "error") {
    return `Error: ${value || "Read failed"}`;
  }

  if (reading.mode === "angle") {
    return `${value}\u00b0`;
  }

  if (reading.mode === "speed") {
    return `${value}\u00b0/s`;
  }

  if (reading.mode === "force") {
    return `${value} N`;
  }

  if (reading.mode === "distance") {
    if (port?.deviceId === 37) {
      return `${value}%`;
    }

    return `${value} cm`;
  }

  if (reading.mode === "reflection") {
    return `${value}%`;
  }

  if (reading.mode === "ambient") {
    return `${value}%`;
  }

  if (reading.mode === "hsv") {
    const hsv = parseHsvValue(value);

    return hsv ? `${Math.round(hsv.h)}, ${Math.round(hsv.s)}, ${Math.round(hsv.v)}` : value || "...";
  }

  if (reading.mode === "rgb") {
    const rgb = hsvToRgb(value);

    return rgb ? rgb.join(", ") : value || "...";
  }

  return value || "...";
}

function liveValueForMode(port, mode) {
  if (mode === "rgb") {
    const hsvReading = state.liveValues.get(liveValueKey(port.port, "hsv"));

    if (hsvReading) {
      return {
        text: formatLiveValue({ ...hsvReading, mode: "rgb" }, port),
        live: true,
        status: "value"
      };
    }
  }

  const reading = state.liveValues.get(liveValueKey(port.port, mode));

  if (reading) {
    return {
      text: formatLiveValue(reading, port),
      live: true,
      status: "value"
    };
  }

  const error = state.liveValues.get(liveValueKey(port.port, "error"));

  if (error) {
    return {
      text: formatLiveValue(error, port),
      live: false,
      status: "error"
    };
  }

  return {
    text: "...",
    live: true,
    status: "pending"
  };
}

function formatImuValue(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const number = Number(value);

  if (Number.isFinite(number)) {
    return String(Math.round(number));
  }

  return "-";
}

function formatVoltageValue(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const voltage = Number(value);

  return Number.isFinite(voltage) ? `${(voltage / 1000).toFixed(2)} V` : "-";
}

function formatCurrentValue(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const current = Number(value);

  return Number.isFinite(current) ? `${Math.round(current)} mA` : "-";
}

function formatBatteryPercent(percent) {
  const value = Number(percent);

  if (!Number.isFinite(value)) {
    return null;
  }

  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function updateHubBatteryFromVoltage(voltageMv) {
  const voltage = Number(voltageMv);

  if (!state.hub || !Number.isFinite(voltage)) {
    return;
  }

  state.hub.batteryVoltageMv = voltage;

  if (Number.isFinite(state.hub.batteryLevel)) {
    state.hub.batteryPercent = state.hub.batteryLevel;
  } else {
    state.hub.batteryPercent = estimateBatteryPercentFromVoltage(voltage, state.hub.model);
  }

  state.hub.batteryText = formatBatteryPercent(state.hub.batteryPercent);
}

function motorPorts() {
  return state.ports.filter((port) => (port.status === "device" || port.status === "unknown") && isMotorDeviceId(port.deviceId));
}

function averageDuplicateDc(points, valueKey) {
  const byDc = new Map();

  for (const point of points) {
    const value = Number(point[valueKey]);

    if (!Number.isFinite(value)) {
      continue;
    }

    const group = byDc.get(point.dc) || [];
    group.push(value);
    byDc.set(point.dc, group);
  }

  return [...byDc.entries()]
    .map(([dc, values]) => ({
      dc,
      value: values.reduce((sum, value) => sum + value, 0) / values.length
    }))
    .sort((a, b) => a.dc - b.dc);
}

function niceCeil(value) {
  const safeValue = Math.max(1, Math.abs(value));
  const power = 10 ** Math.floor(Math.log10(safeValue));

  for (const factor of [1, 2, 5, 10]) {
    const candidate = factor * power;

    if (safeValue <= candidate) {
      return candidate;
    }
  }

  return 10 * power;
}

function niceStep(span) {
  return niceCeil(span / 4);
}

function chartBounds(points, symmetric) {
  if (!points.length) {
    return symmetric ? { min: -100, max: 100 } : { min: 0, max: 100 };
  }

  if (symmetric) {
    const maxAbs = Math.max(100, ...points.map((point) => Math.abs(point.value)));
    const limit = niceCeil(maxAbs);
    return { min: -limit, max: limit };
  }

  let min = Math.min(0, ...points.map((point) => point.value));
  let max = Math.max(0, ...points.map((point) => point.value));

  if (min === max) {
    max = min + 100;
  }

  const span = max - min;
  const padding = Math.max(10, span * 0.08);
  const step = niceStep(span + padding * 2);

  min = Math.floor((min - padding) / step) * step;
  max = Math.ceil((max + padding) / step) * step;

  if (min === max) {
    max = min + step;
  }

  return { min, max };
}

function chartTicks(min, max) {
  const step = niceStep(max - min);
  const ticks = [];
  const start = Math.ceil(min / step) * step;

  for (let value = start; value <= max + step * 0.25; value += step) {
    ticks.push(Math.abs(value) < 1e-9 ? 0 : value);
  }

  if (!ticks.includes(0) && min < 0 && max > 0) {
    ticks.push(0);
  }

  return ticks.sort((a, b) => a - b);
}

function formatChartTick(value) {
  if (Math.abs(value) >= 10 || Number.isInteger(value)) {
    return String(Math.round(value));
  }

  return value.toFixed(1).replace(/\.0$/, "");
}

function formatChartValue(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  if (Math.abs(value) >= 10 || Number.isInteger(value)) {
    return String(Math.round(value));
  }

  return value.toFixed(1).replace(/\.0$/, "");
}

function signedNumber(value, unit = "") {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "-";
  }

  const text = Math.abs(number) >= 10 || Number.isInteger(number)
    ? String(Math.round(number))
    : number.toFixed(1).replace(/\.0$/, "");

  return `${number > 0 ? "+" : ""}${text}${unit}`;
}

function motorStartupDuty(points, sign) {
  return points
    .filter((point) => (sign > 0 ? point.dc > 0 : point.dc < 0))
    .sort((a, b) => Math.abs(a.dc) - Math.abs(b.dc))
    .find((point) => Math.abs(point.value) >= MOTOR_START_RPM_THRESHOLD)?.dc ?? null;
}

function motorMaxRpm(points, sign) {
  const matching = points.filter((point) => (sign > 0 ? point.dc > 0 : point.dc < 0));

  if (!matching.length) {
    return null;
  }

  return matching.reduce((best, point) => (Math.abs(point.value) > Math.abs(best.value) ? point : best)).value;
}

function motorPeakAcceleration(points, sign, sampleIntervalMs) {
  const seconds = Math.max(0.001, (Number(sampleIntervalMs) || MOTOR_SWEEP_SAMPLE_INTERVAL_MS) / 1000);
  let best = null;

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];

    if (!Number.isFinite(previous?.rpm) || !Number.isFinite(current?.rpm)) {
      continue;
    }

    const isForwardRamp = sign > 0 && previous.dc >= 0 && current.dc > previous.dc;
    const isReverseRamp = sign < 0 && previous.dc <= 0 && current.dc < previous.dc;

    if (!isForwardRamp && !isReverseRamp) {
      continue;
    }

    const acceleration = (current.rpm - previous.rpm) / seconds;

    if (!Number.isFinite(acceleration)) {
      continue;
    }

    if (best === null || Math.abs(acceleration) > Math.abs(best)) {
      best = acceleration;
    }
  }

  return best;
}

function formatDualPercent(positive, negative) {
  const positiveText = Number.isFinite(positive) ? signedNumber(positive, "%") : "-";
  const negativeText = Number.isFinite(negative) ? signedNumber(negative, "%") : "-";

  return `${positiveText} / ${negativeText}`;
}

function formatDualRpm(positive, negative) {
  const positiveText = Number.isFinite(positive) ? `${signedNumber(positive)} rpm` : "-";
  const negativeText = Number.isFinite(negative) ? `${signedNumber(negative)} rpm` : "-";

  return `${positiveText} / ${negativeText}`;
}

function formatDualAcceleration(positive, negative) {
  const positiveText = Number.isFinite(positive) ? `${signedNumber(positive)} rpm/s` : "-";
  const negativeText = Number.isFinite(negative) ? `${signedNumber(negative)} rpm/s` : "-";

  return `${positiveText} / ${negativeText}`;
}

function formatBacklash(backlash) {
  if (!backlash || backlash.status === "not_run") {
    return {
      value: "-",
      detail: "run motor test"
    };
  }

  if (backlash.status === "error") {
    return {
      value: "Error",
      detail: backlash.error || "backlash probe failed"
    };
  }

  if (backlash.status === "not_detected") {
    return {
      value: "Not detected",
      detail: "no load edge"
    };
  }

  const positive = Number.isFinite(backlash.positiveDeg) ? signedNumber(backlash.positiveDeg, "\u00b0") : "-";
  const negative = Number.isFinite(backlash.negativeDeg) ? signedNumber(backlash.negativeDeg, "\u00b0") : "-";

  return {
    value: `${positive} / ${negative}`,
    detail: "forward / reverse"
  };
}

function motorSummaryItems() {
  const points = averageDuplicateDc(state.motorTest.data, "rpm");
  const positiveStartup = motorStartupDuty(points, 1);
  const negativeStartup = motorStartupDuty(points, -1);
  const positiveMaxRpm = motorMaxRpm(points, 1);
  const negativeMaxRpm = motorMaxRpm(points, -1);
  const positivePeakAcceleration = motorPeakAcceleration(state.motorTest.data, 1, state.motorTest.sampleIntervalMs);
  const negativePeakAcceleration = motorPeakAcceleration(state.motorTest.data, -1, state.motorTest.sampleIntervalMs);
  const backlash = formatBacklash(state.motorTest.metrics?.backlash);

  return [
    {
      label: "Startup duty",
      value: formatDualPercent(positiveStartup, negativeStartup),
      detail: `first >= ${MOTOR_START_RPM_THRESHOLD} rpm`
    },
    {
      label: "Max RPM",
      value: formatDualRpm(positiveMaxRpm, negativeMaxRpm),
      detail: "forward / reverse"
    },
    {
      label: "Peak accel",
      value: formatDualAcceleration(positivePeakAcceleration, negativePeakAcceleration),
      detail: `sample ${state.motorTest.sampleIntervalMs} ms`
    },
    {
      label: "Backlash",
      value: backlash.value,
      detail: backlash.detail
    }
  ];
}

function svgElement(name, attributes = {}, text = "") {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);

  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }

  if (text) {
    element.textContent = text;
  }

  return element;
}

function renderMotorChart(
  chart,
  { valueKey, yLabel, valueName, valueUnit, lineColor, symmetric = false, emptyText = "No data" }
) {
  const width = 720;
  const height = 360;
  const margin = {
    top: 22,
    right: 28,
    bottom: 48,
    left: 66
  };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const points = averageDuplicateDc(state.motorTest.data, valueKey);
  const renderSignature = [
    valueKey,
    yLabel,
    lineColor,
    symmetric ? "sym" : "pos",
    points.map((point) => `${point.dc}:${formatChartValue(point.value)}`).join("|")
  ].join(";");

  if (chart.dataset.renderSignature === renderSignature) {
    return;
  }

  const { min: yMin, max: yMax } = chartBounds(points, symmetric);
  const xFor = (dc) => margin.left + ((dc + 100) / 200) * plotWidth;
  const yFor = (value) => margin.top + ((yMax - value) / (yMax - yMin || 1)) * plotHeight;
  const children = [];

  chart.setAttribute("width", String(width));
  chart.setAttribute("height", String(height));
  chart.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  children.push(svgElement("style", {}, `
    .chart-grid{stroke:#e8e8e8;stroke-width:1}
    .chart-axis,.chart-axis-zero{stroke:#b9b9b9;stroke-width:1.4}
    .chart-axis-zero{stroke:#9d9d9d}
    .chart-line{fill:none;stroke:${lineColor};stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
    .chart-point{fill:#fff;stroke:${lineColor};stroke-width:2}
    .chart-point-group{cursor:crosshair;outline:none}
    .chart-point-hit{fill:transparent;stroke:transparent;pointer-events:all}
    .chart-tooltip{opacity:0;pointer-events:none}
    .chart-point-group:hover .chart-tooltip,.chart-point-group:focus .chart-tooltip,.chart-point-group:focus-visible .chart-tooltip{opacity:1}
    .chart-tooltip-box{fill:#fff;stroke:#d0d0d0;stroke-width:1.2}
    .chart-tooltip-title{fill:#2f2f2f;font:700 13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .chart-tooltip-text{fill:#666;font:12px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .chart-tick,.chart-label,.chart-empty{fill:#737373;font:13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .chart-label{font-weight:650}
    .chart-empty{fill:#a7a7a7;font-size:18px}
  `));
  children.push(svgElement("rect", { x: 0, y: 0, width, height, fill: "#ffffff" }));

  for (const dc of [-100, -50, 0, 50, 100]) {
    const x = xFor(dc);
    children.push(svgElement("line", { x1: x, y1: margin.top, x2: x, y2: height - margin.bottom, class: "chart-grid" }));
    children.push(svgElement("text", { x, y: height - 18, class: "chart-tick", "text-anchor": "middle" }, String(dc)));
  }

  for (const value of chartTicks(yMin, yMax)) {
    const y = yFor(value);
    children.push(svgElement("line", { x1: margin.left, y1: y, x2: width - margin.right, y2: y, class: value === 0 ? "chart-axis-zero" : "chart-grid" }));
    children.push(svgElement("text", { x: margin.left - 12, y: y + 4, class: "chart-tick", "text-anchor": "end" }, formatChartTick(value)));
  }

  children.push(svgElement("line", { x1: margin.left, y1: margin.top, x2: margin.left, y2: height - margin.bottom, class: "chart-axis" }));
  children.push(svgElement("line", { x1: margin.left, y1: height - margin.bottom, x2: width - margin.right, y2: height - margin.bottom, class: "chart-axis" }));
  children.push(svgElement("text", { x: width / 2, y: height - 4, class: "chart-label", "text-anchor": "middle" }, "dc (%)"));
  children.push(
    svgElement(
      "text",
      { x: 16, y: height / 2, class: "chart-label", "text-anchor": "middle", transform: `rotate(-90 16 ${height / 2})` },
      yLabel
    )
  );

  if (points.length) {
    const path = points.map((point, index) => `${index ? "L" : "M"} ${xFor(point.dc).toFixed(1)} ${yFor(point.value).toFixed(1)}`).join(" ");
    children.push(svgElement("path", { d: path, class: "chart-line" }));

    for (const point of points) {
      const cx = xFor(point.dc);
      const cy = yFor(point.value);
      const tooltipWidth = 136;
      const tooltipHeight = 52;
      const tooltipX = cx > width - margin.right - tooltipWidth - 8 ? -tooltipWidth - 12 : 12;
      const tooltipY = cy < margin.top + tooltipHeight + 8 ? 12 : -tooltipHeight - 12;
      const group = svgElement("g", {
        class: "chart-point-group",
        tabindex: "0",
        "aria-label": `DC ${point.dc}%, ${valueName} ${formatChartValue(point.value)} ${valueUnit}`.trim()
      });
      const tooltip = svgElement("g", { class: "chart-tooltip", transform: `translate(${cx}, ${cy})` });

      tooltip.append(
        svgElement("rect", { x: tooltipX, y: tooltipY, width: tooltipWidth, height: tooltipHeight, rx: 6, class: "chart-tooltip-box" }),
        svgElement("text", { x: tooltipX + 10, y: tooltipY + 20, class: "chart-tooltip-title" }, `DC: ${point.dc}%`),
        svgElement(
          "text",
          { x: tooltipX + 10, y: tooltipY + 38, class: "chart-tooltip-text" },
          `${valueName}: ${formatChartValue(point.value)} ${valueUnit}`.trim()
        )
      );
      group.append(
        svgElement("circle", { cx, cy, r: 10, class: "chart-point-hit" }),
        svgElement("circle", { cx, cy, r: 3.2, class: "chart-point" }),
        tooltip
      );
      children.push(group);
    }
  } else {
    children.push(svgElement("text", { x: width / 2, y: height / 2, class: "chart-empty", "text-anchor": "middle" }, emptyText));
  }

  chart.replaceChildren(...children);
  chart.dataset.renderSignature = renderSignature;
}

function renderMotorSummary() {
  motorSummary.replaceChildren(
    ...motorSummaryItems().map((item) => {
      const metric = document.createElement("div");
      const label = document.createElement("div");
      const value = document.createElement("div");
      const detail = document.createElement("div");

      metric.className = "motor-metric";
      label.className = "motor-metric__label";
      value.className = "motor-metric__value";
      detail.className = "motor-metric__detail";
      label.textContent = item.label;
      value.textContent = item.value;
      detail.textContent = item.detail;
      metric.title = `${item.label}: ${item.value}. ${item.detail}`;
      metric.append(label, value, detail);

      return metric;
    })
  );
}

function renderMotorCharts() {
  renderMotorChart(motorChart, {
    valueKey: "rpm",
    yLabel: "rpm",
    valueName: "RPM",
    valueUnit: "rpm",
    lineColor: "#2d83b7",
    symmetric: true,
    emptyText: "No RPM data"
  });
  renderMotorChart(motorCurrentChart, {
    valueKey: "currentMa",
    yLabel: "mA",
    valueName: "Current",
    valueUnit: "mA",
    lineColor: "#d1192e",
    symmetric: false,
    emptyText: "No current data"
  });
}

function progressPhaseLabel(phase) {
  return {
    idle: "Idle",
    preparing: "Preparing",
    sweeping: "Sweeping",
    backlash: "Backlash",
    complete: "Complete",
    "timed-out": "Timed out",
    error: "Error"
  }[phase] ?? "Running";
}

function setMotorProgress(progress) {
  state.motorTest.progress = {
    ...state.motorTest.progress,
    ...progress,
    percent: Math.max(0, Math.min(100, Math.round(Number(progress.percent) || 0)))
  };
}

function renderMotorProgress() {
  const progress = state.motorTest.progress;
  const isVisible = state.motorTest.running || progress.phase !== "idle";

  motorProgress.hidden = !isVisible;

  if (!isVisible) {
    return;
  }

  motorProgressPhase.textContent = progressPhaseLabel(progress.phase);
  motorProgressPercent.textContent = `${progress.percent}%`;
  motorProgressFill.style.width = `${progress.percent}%`;
  motorProgress.setAttribute("aria-valuemin", "0");
  motorProgress.setAttribute("aria-valuemax", "100");
  motorProgress.setAttribute("aria-valuenow", String(progress.percent));
  motorProgress.setAttribute("role", "progressbar");
}

function renderMotorTest() {
  const motors = motorPorts();
  const previous = state.motorTest.selectedPort || motorPortSelect.value;

  motorPortSelect.replaceChildren(
    ...motors.map((port) => {
      const option = document.createElement("option");
      option.value = port.port;
      option.textContent = `${port.port} - ${port.deviceName || `ID ${port.deviceId}`}`;
      return option;
    })
  );

  if (motors.some((port) => port.port === previous)) {
    motorPortSelect.value = previous;
  } else if (motors.length) {
    motorPortSelect.value = motors[0].port;
  }

  state.motorTest.selectedPort = motorPortSelect.value || "";
  motorStepSelect.value = String(state.motorTest.step);
  motorPortSelect.disabled = state.busy || state.motorTest.running || !motors.length;
  motorStepSelect.disabled = state.busy || state.motorTest.running;
  runMotorTestBtn.disabled = state.busy || state.motorTest.running || !state.connected || !state.motorTest.selectedPort;
  downloadMotorChartBtn.disabled = !state.motorTest.data.length;

  if (state.motorTest.running) {
    motorTestStatus.textContent = `${progressPhaseLabel(state.motorTest.progress.phase)} ${state.motorTest.progress.percent}%`;
  } else if (!state.connected) {
    motorTestStatus.textContent = "Disconnected";
  } else if (state.motorTest.progress.phase === "timed-out") {
    motorTestStatus.textContent = "Timed out";
  } else if (state.motorTest.progress.phase === "error") {
    motorTestStatus.textContent = "Error";
  } else if (!motors.length) {
    motorTestStatus.textContent = "No motor selected";
  } else if (state.motorTest.data.length) {
    motorTestStatus.textContent = `${state.motorTest.data.length} samples`;
  } else {
    motorTestStatus.textContent = "Ready";
  }

  renderMotorProgress();
  renderMotorSummary();
  renderMotorCharts();
}

async function downloadMotorChartPng() {
  if (!state.motorTest.data.length) {
    return;
  }

  const charts = [motorChart, motorCurrentChart];
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = 720 * charts.length * scale;
  canvas.height = 360 * scale;
  const context = canvas.getContext("2d");
  const images = await Promise.all(
    charts.map((chart) => {
      const svgText = new XMLSerializer().serializeToString(chart);
      const svgBlob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(svgBlob);
      const image = new Image();

      return new Promise((resolve, reject) => {
        image.onload = () => {
          URL.revokeObjectURL(url);
          resolve(image);
        };
        image.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error("Could not render chart image."));
        };
        image.src = url;
      });
    })
  );

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  images.forEach((image, index) => {
    context.drawImage(image, index * 720 * scale, 0, 720 * scale, 360 * scale);
  });

  const pngUrl = canvas.toDataURL("image/png");
  const link = document.createElement("a");
  const port = state.motorTest.selectedPort || "motor";
  link.href = pngUrl;
  link.download = `motor-dc-rpm-current-${port}.png`;
  link.click();
}

function liveDisplayForPort(port, description) {
  const modes = liveModesForPort(port);

  if (!modes.length) {
    return {
      text: port.deviceId ? `ID ${port.deviceId}` : description.detail,
      live: false,
      switchable: false,
      mode: null
    };
  }

  const mode = selectedLiveMode(port);
  const value = liveValueForMode(port, mode);

  return {
    text: value.text,
    label: liveModeLabel(mode),
    live: value.live,
    switchable: modes.length > 1,
    mode,
    status: value.status
  };
}

function iconClass(port) {
  if (port.status === "empty" || port.status === "unavailable") {
    return "device-icon device-icon--empty";
  }

  if ((port.status === "device" || port.status === "unknown") && SENSOR_DEVICE_IDS.has(port.deviceId)) {
    return "device-icon device-icon--sensor";
  }

  return "device-icon device-icon--motor";
}

function renderPortTile(port, rowIndex = 0) {
  const description = describePort(port);
  const liveDisplay = liveDisplayForPort(port, description);
  const element = document.createElement("div");
  const icon = document.createElement("div");
  const iconCore = document.createElement("span");
  const content = document.createElement("div");
  const device = document.createElement("div");
  const detail = document.createElement(liveDisplay.switchable ? "button" : "div");

  element.className = `${portClass(port)} port-tile--row-${rowIndex + 1}`;
  element.title = `${description.label}. ${description.detail}${liveDisplay.mode ? `. ${liveDisplay.mode}` : ""}`;
  element.dataset.port = port.port;
  icon.className = iconClass(port);
  icon.setAttribute("aria-hidden", "true");
  iconCore.className = "device-icon__core";
  icon.append(iconCore);
  content.className = "port-content";
  device.className = "port-device";
  device.textContent = description.label;
  detail.className = [
    "port-detail",
    liveDisplay.live ? "port-detail--live" : "",
    liveDisplay.mode ? "port-mode-display" : "",
    liveDisplay.switchable ? "port-mode-button" : ""
  ].filter(Boolean).join(" ");
  if (liveDisplay.switchable) {
    detail.type = "button";
    detail.dataset.port = port.port;
    detail.dataset.modeTrigger = port.port;
    detail.title = `Switch ${description.label} mode`;
    detail.setAttribute("aria-haspopup", "menu");
    detail.setAttribute("aria-expanded", String(state.openModeMenuPort === port.port));
    detail.setAttribute("aria-label", `Switch ${description.label} mode. ${liveDisplay.label}: ${liveDisplay.text}.`);
  }
  if (liveDisplay.mode) {
    const modeLabel = document.createElement("span");
    const modeValue = document.createElement("span");

    modeLabel.className = "port-mode-label";
    modeLabel.textContent = `${liveDisplay.label}:`;
    modeValue.className = "port-mode-value";
    modeValue.textContent = liveDisplay.text;
    detail.append(modeLabel, modeValue);
  } else {
    detail.textContent = liveDisplay.text;
  }
  content.append(device, detail);
  element.append(icon, content);
  return element;
}

function mergePorts(scannedPorts) {
  const scannedByName = new Map(scannedPorts.map((port) => [port.port, port]));
  return currentPortNames().map((port) => scannedByName.get(port) ?? { port, status: "unavailable" });
}

function currentHubModel() {
  return state.hub?.model ?? {
    name: "Unknown Pybricks Hub",
    ports: PORT_NAMES,
    portRows: [["A", "B"], ["C", "D"], ["E", "F"]]
  };
}

function currentPortNames() {
  return currentHubModel().ports;
}

function syncLiveModesForPorts() {
  const activePorts = new Set(state.ports.map((port) => port.port));

  for (const port of state.ports) {
    const modes = liveModesForPort(port);
    const selected = state.selectedModeByPort.get(port.port);

    if (!modes.length) {
      state.selectedModeByPort.delete(port.port);
      continue;
    }

    if (!modes.includes(selected)) {
      state.selectedModeByPort.set(port.port, modes[0]);
    }
  }

  for (const port of [...state.selectedModeByPort.keys()]) {
    if (!activePorts.has(port)) {
      state.selectedModeByPort.delete(port);
    }
  }

  for (const key of [...state.liveValues.keys()]) {
    const [port] = key.split(":");

    if (!activePorts.has(port)) {
      state.liveValues.delete(key);
    }
  }
}

function liveMonitorSelectedModesByPort() {
  const selectedModesByPort = {};

  for (const port of state.ports) {
    const selected = selectedLiveMode(port);

    if (selected) {
      selectedModesByPort[port.port] = selected;
    }
  }

  return selectedModesByPort;
}

function liveMonitorOptions() {
  return {
    selectedModesByPort: liveMonitorSelectedModesByPort()
  };
}

function clearLiveValuesForPort(portName) {
  for (const key of [...state.liveValues.keys()]) {
    if (key.startsWith(`${portName}:`)) {
      state.liveValues.delete(key);
    }
  }
}

function shouldRestartLiveMonitorForModeChange(port, previousMode, nextMode) {
  return (
    state.connected &&
    !state.busy &&
    COLOR_SENSOR_DEVICE_IDS.has(port.deviceId) &&
    previousMode !== nextMode &&
    (previousMode === "ambient" || nextMode === "ambient")
  );
}

function restartLiveMonitorForSelectedModes() {
  if (!state.connected || state.busy) {
    return Promise.resolve(false);
  }

  liveMonitorRestartPromise = liveMonitorRestartPromise
    .catch(() => {})
    .then(async () => {
      if (!state.connected || state.busy) {
        return false;
      }

      await client.startLiveMonitor(state.ports, liveMonitorOptions());
      return true;
    })
    .catch((error) => {
      setMessage(error.message || String(error), true);
      return false;
    });

  return liveMonitorRestartPromise;
}

function portByName(portName) {
  return state.ports.find((item) => item.port === portName);
}

function closeModeMenu(shouldRender = true) {
  if (!state.openModeMenuPort) {
    portModeMenu.hidden = true;
    return;
  }

  state.openModeMenuPort = "";
  portModeMenu.hidden = true;
  portModeMenu.replaceChildren();
  portModeMenu.dataset.menuSignature = "";
  portModeMenu.dataset.port = "";

  if (shouldRender) {
    renderHub();
  }
}

function updateModeMenuValues(port, modes) {
  for (const mode of modes) {
    const valueNode = portModeMenu.querySelector(`[data-mode-value="${mode}"]`);

    if (valueNode) {
      valueNode.textContent = liveValueForMode(port, mode).text;
    }
  }
}

function positionModeMenu(portName) {
  const trigger = document.querySelector(`[data-mode-trigger="${portName}"]`);

  if (!trigger || portModeMenu.hidden) {
    portModeMenu.hidden = true;
    return;
  }

  const container = portModeMenu.offsetParent || dashboardStage;
  const containerRect = container.getBoundingClientRect();
  const triggerRect = trigger.getBoundingClientRect();
  const maxWidth = Math.max(96, containerRect.width - 24);
  const menuWidth = Math.min(220, maxWidth);

  portModeMenu.style.width = `${menuWidth}px`;

  const menuRect = portModeMenu.getBoundingClientRect();
  const minLeft = 12;
  const maxLeft = Math.max(minLeft, containerRect.width - menuWidth - 12);
  const minTop = 12;
  const maxTop = Math.max(minTop, containerRect.height - menuRect.height - 12);
  let left = triggerRect.left - containerRect.left;
  let top = triggerRect.bottom - containerRect.top + 8;

  if (triggerRect.left > containerRect.left + containerRect.width / 2) {
    left = triggerRect.right - containerRect.left - menuWidth;
  }

  if (top > maxTop) {
    top = triggerRect.top - containerRect.top - menuRect.height - 8;
  }

  portModeMenu.style.left = `${Math.max(minLeft, Math.min(maxLeft, left))}px`;
  portModeMenu.style.top = `${Math.max(minTop, Math.min(maxTop, top))}px`;
}

function renderModeMenu() {
  const portName = state.openModeMenuPort;

  if (!portName) {
    portModeMenu.hidden = true;
    return;
  }

  const port = portByName(portName);
  const modes = port ? liveModesForPort(port) : [];

  if (!port || modes.length < 2) {
    closeModeMenu(false);
    return;
  }

  const selected = selectedLiveMode(port);
  const signature = `${portName}:${selected}:${modes.join("|")}`;

  portModeMenu.hidden = false;
  portModeMenu.dataset.port = portName;
  portModeMenu.setAttribute("role", "menu");
  portModeMenu.setAttribute("aria-label", `Display mode for port ${portName}`);

  if (portModeMenu.dataset.menuSignature !== signature) {
    portModeMenu.replaceChildren(
      ...modes.map((mode) => {
        const item = document.createElement("button");
        const check = document.createElement("span");
        const label = document.createElement("span");
        const value = document.createElement("span");
        const isSelected = mode === selected;

        item.type = "button";
        item.className = "port-mode-menu__item";
        item.dataset.port = portName;
        item.dataset.mode = mode;
        item.setAttribute("role", "menuitemradio");
        item.setAttribute("aria-checked", String(isSelected));
        check.className = "port-mode-menu__check";
        check.textContent = isSelected ? "\u2713" : "";
        label.className = "port-mode-menu__label";
        label.textContent = liveModeLabel(mode);
        value.className = "port-mode-menu__value";
        value.dataset.modeValue = mode;
        value.textContent = liveValueForMode(port, mode).text;
        item.append(check, label, value);

        return item;
      })
    );
    portModeMenu.dataset.menuSignature = signature;
  } else {
    updateModeMenuValues(port, modes);
  }

  positionModeMenu(portName);
}

function selectPortMode(portName, mode) {
  const port = portByName(portName);
  const modes = port ? liveModesForPort(port) : [];

  if (!modes.includes(mode)) {
    closeModeMenu();
    return;
  }

  const previousMode = selectedLiveMode(port);
  const shouldRestart = shouldRestartLiveMonitorForModeChange(port, previousMode, mode);

  state.selectedModeByPort.set(portName, mode);

  if (shouldRestart) {
    clearLiveValuesForPort(portName);
  }

  closeModeMenu(false);
  renderHub();

  if (shouldRestart) {
    restartLiveMonitorForSelectedModes();
  }
}

function toggleModeMenu(portName) {
  const port = state.ports.find((item) => item.port === portName);
  const modes = port ? liveModesForPort(port) : [];

  if (modes.length < 2) {
    closeModeMenu();
    return;
  }

  state.openModeMenuPort = state.openModeMenuPort === portName ? "" : portName;
  renderHub();
}

function hubImageSrc(hub) {
  const model = hub?.model;

  if (model?.name === "Inventor Hub") {
    return `${HUB_IMAGE_BASE}/hub-inventor.png`;
  }

  const fileName = HUB_IMAGE_BY_PRODUCT_ID[model?.id] || "hub-prime.png";
  return `${HUB_IMAGE_BASE}/${fileName}`;
}

function renderPorts() {
  const portsByName = new Map(state.ports.map((port) => [port.port, port]));
  const left = currentHubModel().portRows.map(([port]) => portsByName.get(port)).filter(Boolean);
  const right = currentHubModel().portRows.map(([, port]) => portsByName.get(port)).filter(Boolean);
  const deviceCount = state.ports.filter((port) => port.status === "device" || port.status === "unknown").length;
  const activePorts = new Set(currentPortNames());

  hubDashboard.dataset.portCount = String(currentPortNames().length);
  hubPortLabels.forEach((label) => {
    label.hidden = !activePorts.has(label.dataset.hubPort);
  });
  leftPorts.replaceChildren(...left.map(renderPortTile));
  rightPorts.replaceChildren(...right.map(renderPortTile));
  portCount.textContent = `${deviceCount} ${deviceCount === 1 ? "device" : "devices"}`;
}

function renderHub() {
  const hub = state.hub;
  hubTitle.textContent = hub?.name || "No hub selected";
  modelValue.textContent = hub?.model?.name || "-";
  firmwareValue.textContent = hub?.firmwareVersion || "-";
  profileValue.textContent = hub?.profileVersion || "-";
  batteryValue.textContent = hub?.batteryText || formatBatteryPercent(hub?.batteryLevel) || "-";
  writeSizeValue.textContent = state.capabilities?.maxWriteSize ? `${state.capabilities.maxWriteSize} bytes` : "-";
  hubVoltage.textContent = formatVoltageValue(state.imu.voltage ?? hub?.batteryVoltageMv);
  hubCurrent.textContent = formatCurrentValue(state.imu.current);
  imuYaw.textContent = formatImuValue(state.imu.yaw);
  imuPitch.textContent = formatImuValue(state.imu.pitch);
  imuRoll.textContent = formatImuValue(state.imu.roll);
  hubScreenText.textContent = state.connected ? "PB" : "--";
  hubThumbPlaceholder.hidden = Boolean(hub);
  hubThumbImage.hidden = !hub;
  if (hub) {
    hubThumbImage.src = hubImageSrc(hub);
  }
  hubThumbImage.alt = "";
  renderPorts();
  renderMotorTest();
  renderModeMenu();
}

function resetUiAfterDisconnect() {
  state.connected = false;
  state.hub = null;
  state.capabilities = null;
  state.ports = makeInitialPorts("unavailable");
  state.imu = {
    voltage: null,
    current: null,
    yaw: null,
    pitch: null,
    roll: null
  };
  state.liveValues.clear();
  state.selectedModeByPort.clear();
  state.openModeMenuPort = "";
  state.motorTest.data = [];
  state.motorTest.metrics = null;
  state.motorTest.selectedPort = "";
  state.motorTest.sampleIntervalMs = MOTOR_SWEEP_SAMPLE_INTERVAL_MS;
  setMotorProgress({
    phase: "idle",
    percent: 0,
    pointsDone: 0,
    pointsTotal: 0
  });
  scanStamp.textContent = "Not scanned";
  setConnectionState("Disconnected", "idle");
  setBusy(false);
  renderHub();
}

async function refreshPorts() {
  setBusy(true, "Scanning");
  setMessage("");
  closeModeMenu(false);
  state.imu = {
    voltage: null,
    current: null,
    yaw: null,
    pitch: null,
    roll: null
  };
  state.liveValues.clear();

  try {
    await client.stopLiveMonitor();
    const ports = await client.scanPorts();
    state.ports = mergePorts(ports);
    syncLiveModesForPorts();
    renderMotorTest();
    scanStamp.textContent = `Scanned ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    setConnectionState("Connected", "ready");
    renderHub();
    await client.startLiveMonitor(state.ports, liveMonitorOptions());
  } catch (error) {
    setConnectionState("Connected", "ready");
    setMessage(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

async function runMotorTest() {
  const port = motorPortSelect.value;
  const step = Number(motorStepSelect.value);

  if (!port) {
    setMessage("Select a motor port.", true);
    return;
  }

  state.motorTest.running = true;
  state.motorTest.selectedPort = port;
  state.motorTest.step = step;
  state.motorTest.data = [];
  state.motorTest.metrics = null;
  state.motorTest.sampleIntervalMs = MOTOR_SWEEP_SAMPLE_INTERVAL_MS;
  setMotorProgress({
    phase: "preparing",
    percent: 0,
    pointsDone: 0,
    pointsTotal: 0
  });
  setBusy(true, "Motor test");
  setMessage("");
  renderMotorTest();

  try {
    const result = await client.runMotorDcSweep({ port, step });
    state.motorTest.data = result.points;
    state.motorTest.metrics = result.metrics;
    state.motorTest.sampleIntervalMs = result.sampleIntervalMs || MOTOR_SWEEP_SAMPLE_INTERVAL_MS;
    setMotorProgress({
      phase: "complete",
      percent: 100,
      pointsDone: state.motorTest.progress.pointsDone,
      pointsTotal: state.motorTest.progress.pointsTotal
    });
    setConnectionState("Connected", "ready");
    renderMotorTest();
    await client.startLiveMonitor(state.ports, liveMonitorOptions()).catch(() => {});
  } catch (error) {
    if (error.partialResult?.points?.length) {
      state.motorTest.data = error.partialResult.points;
      state.motorTest.metrics = error.partialResult.metrics;
      state.motorTest.sampleIntervalMs = error.partialResult.sampleIntervalMs || MOTOR_SWEEP_SAMPLE_INTERVAL_MS;
    }

    setMotorProgress(error.progress || {
      phase: error.message?.includes("timed out") ? "timed-out" : "error",
      percent: state.motorTest.progress.percent,
      pointsDone: state.motorTest.progress.pointsDone,
      pointsTotal: state.motorTest.progress.pointsTotal
    });
    setConnectionState("Connected", "ready");
    setMessage(error.message || String(error), true);
    await client.startLiveMonitor(state.ports, liveMonitorOptions()).catch(() => {});
  } finally {
    state.motorTest.running = false;
    setBusy(false);
    renderHub();
  }
}

connectBtn.addEventListener("click", async () => {
  setBusy(true, "Connecting");
  setMessage("");
  closeModeMenu(false);

  try {
    const { info, capabilities } = await client.connect();
    state.connected = true;
    state.hub = info;
    state.capabilities = capabilities;
    state.ports = makeInitialPorts("unavailable", currentPortNames());
    state.imu = {
      voltage: null,
      current: null,
      yaw: null,
      pitch: null,
      roll: null
    };
    state.liveValues.clear();
    syncLiveModesForPorts();
    setConnectionState("Connected", "ready");
    renderHub();
    await refreshPorts();
  } catch (error) {
    state.connected = false;
    setConnectionState("Error", "error");
    setMessage(error.message || String(error), true);
  } finally {
    setBusy(false);
    renderHub();
  }
});

refreshBtn.addEventListener("click", refreshPorts);

disconnectBtn.addEventListener("click", async () => {
  setBusy(true, "Disconnecting");
  await client.disconnect();
  resetUiAfterDisconnect();
});

for (const button of tabButtons) {
  button.addEventListener("click", () => {
    setActiveTab(button.dataset.tab);
  });
}

motorPortSelect.addEventListener("change", () => {
  state.motorTest.selectedPort = motorPortSelect.value;
  renderMotorTest();
});

motorStepSelect.addEventListener("change", () => {
  state.motorTest.step = Number(motorStepSelect.value);
  renderMotorTest();
});

runMotorTestBtn.addEventListener("click", runMotorTest);
downloadMotorChartBtn.addEventListener("click", () => {
  downloadMotorChartPng().catch((error) => {
    setMessage(error.message || String(error), true);
  });
});

hubDashboard.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest(".port-mode-button");

  if (!button) {
    return;
  }

  toggleModeMenu(button.dataset.port);
});

portModeMenu.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const item = target?.closest(".port-mode-menu__item");

  if (!item) {
    return;
  }

  selectPortMode(item.dataset.port, item.dataset.mode);
});

document.addEventListener("pointerdown", (event) => {
  if (!state.openModeMenuPort) {
    return;
  }

  const target = event.target instanceof Element ? event.target : null;

  if (target?.closest(".port-mode-menu") || target?.closest(".port-mode-button")) {
    return;
  }

  closeModeMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.openModeMenuPort) {
    closeModeMenu();
  }
});

window.addEventListener("resize", () => {
  renderModeMenu();
});

client.addEventListener("live", (event) => {
  const imu = event.detail.imu || {};

  if ("voltage" in imu) {
    state.imu.voltage = imu.voltage;
    updateHubBatteryFromVoltage(imu.voltage);
  }

  if ("current" in imu) {
    state.imu.current = imu.current;
  }

  if ("yaw" in imu) {
    state.imu.yaw = imu.yaw;
  }

  if ("pitch" in imu) {
    state.imu.pitch = imu.pitch;
  }

  if ("roll" in imu) {
    state.imu.roll = imu.roll;
  }

  for (const reading of event.detail.values) {
    if (reading.status === "value") {
      state.liveValues.delete(liveValueKey(reading.port, "error"));
    }

    state.liveValues.set(liveValueKey(reading.port, reading.mode), reading);
  }

  queueRenderHub();
});

client.addEventListener("motor-progress", (event) => {
  setMotorProgress(event.detail);
  renderMotorTest();
});

client.addEventListener("disconnected", () => {
  resetUiAfterDisconnect();
  setMessage("Hub disconnected.");
});

async function updateBluetoothAvailability() {
  if (!("bluetooth" in navigator)) {
    state.bluetoothAvailable = false;
    setConnectionState("Unavailable", "error");
    setMessage(WEB_BLUETOOTH_UNAVAILABLE_MESSAGE, true);
    setBusy(state.busy);
    return;
  }

  if (!("getAvailability" in navigator.bluetooth)) {
    state.bluetoothAvailable = true;
    setBusy(state.busy);
    return;
  }

  try {
    const isAvailable = await navigator.bluetooth.getAvailability();
    state.bluetoothAvailable = isAvailable;

    if (!isAvailable) {
      setConnectionState("Unavailable", "error");
      setMessage(BLUETOOTH_ADAPTER_UNAVAILABLE_MESSAGE, true);
    } else if (!state.connected && state.error === BLUETOOTH_ADAPTER_UNAVAILABLE_MESSAGE) {
      setConnectionState("Disconnected", "idle");
      setMessage("");
    }
  } catch {
    state.bluetoothAvailable = true;
  }

  setBusy(state.busy);
}

if ("bluetooth" in navigator && "addEventListener" in navigator.bluetooth) {
  navigator.bluetooth.addEventListener("availabilitychanged", () => {
    updateBluetoothAvailability();
  });
}

setActiveTab("dashboard");
renderHub();
updateBluetoothAvailability();
