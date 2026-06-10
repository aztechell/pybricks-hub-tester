import { PybricksHubClient } from "./pybricks.js";
import {
  estimateBatteryPercentFromVoltage,
  isMotorDeviceId,
  liveModesForDeviceId,
  makeInitialPorts,
  PORT_NAMES
} from "./parser.js";

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
const motorChart = document.querySelector("#motorChart");
const motorCurrentChart = document.querySelector("#motorCurrentChart");
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

const state = {
  connected: false,
  busy: false,
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
  motorTest: {
    data: [],
    running: false,
    selectedPort: "",
    step: 10
  },
  message: "",
  error: ""
};

let renderQueued = false;

function setActiveTab(tabName) {
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
  connectBtn.disabled = isBusy || state.connected;
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

function formatLiveValue(reading) {
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
    return `${value} cm`;
  }

  if (reading.mode === "reflection") {
    return `${value}%`;
  }

  return value || "...";
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

function renderMotorChart(chart, { valueKey, yLabel, lineColor, symmetric = false, emptyText = "No data" }) {
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
      children.push(svgElement("circle", { cx: xFor(point.dc), cy: yFor(point.value), r: 3.2, class: "chart-point" }));
    }
  } else {
    children.push(svgElement("text", { x: width / 2, y: height / 2, class: "chart-empty", "text-anchor": "middle" }, emptyText));
  }

  chart.replaceChildren(...children);
}

function renderMotorCharts() {
  renderMotorChart(motorChart, {
    valueKey: "rpm",
    yLabel: "rpm",
    lineColor: "#2d83b7",
    symmetric: true,
    emptyText: "No RPM data"
  });
  renderMotorChart(motorCurrentChart, {
    valueKey: "currentMa",
    yLabel: "mA",
    lineColor: "#d1192e",
    symmetric: false,
    emptyText: "No current data"
  });
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
    motorTestStatus.textContent = "Running";
  } else if (!state.connected) {
    motorTestStatus.textContent = "Disconnected";
  } else if (!motors.length) {
    motorTestStatus.textContent = "No motor selected";
  } else if (state.motorTest.data.length) {
    motorTestStatus.textContent = `${state.motorTest.data.length} samples`;
  } else {
    motorTestStatus.textContent = "Ready";
  }

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
  const reading = state.liveValues.get(liveValueKey(port.port, mode));
  const error = state.liveValues.get(liveValueKey(port.port, "error"));

  if (reading) {
    return {
      text: formatLiveValue(reading),
      live: true,
      switchable: modes.length > 1,
      mode
    };
  }

  if (error) {
    return {
      text: formatLiveValue(error),
      live: false,
      switchable: modes.length > 1,
      mode: "error"
    };
  }

  return {
    text: "...",
    live: true,
    switchable: modes.length > 1,
    mode
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
    liveDisplay.switchable ? "port-mode-button" : ""
  ].filter(Boolean).join(" ");
  if (liveDisplay.switchable) {
    detail.type = "button";
    detail.dataset.port = port.port;
    detail.title = `Switch ${description.label} mode`;
    detail.setAttribute("aria-label", `Switch ${description.label} mode. Current value ${liveDisplay.text}.`);
  }
  detail.textContent = liveDisplay.text;
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

function cyclePortMode(portName) {
  const port = state.ports.find((item) => item.port === portName);
  const modes = port ? liveModesForPort(port) : [];

  if (modes.length < 2) {
    return;
  }

  const current = selectedLiveMode(port);
  const next = modes[(modes.indexOf(current) + 1) % modes.length];
  state.selectedModeByPort.set(portName, next);
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
  state.motorTest.data = [];
  state.motorTest.selectedPort = "";
  scanStamp.textContent = "Not scanned";
  setConnectionState("Disconnected", "idle");
  setBusy(false);
  renderHub();
}

async function refreshPorts() {
  setBusy(true, "Scanning");
  setMessage("");
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
    await client.startLiveMonitor(state.ports);
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
  setBusy(true, "Motor test");
  setMessage("");
  renderMotorTest();

  try {
    const points = await client.runMotorDcSweep({ port, step });
    state.motorTest.data = points;
    setConnectionState("Connected", "ready");
    renderMotorTest();
    await client.startLiveMonitor(state.ports).catch(() => {});
  } catch (error) {
    setConnectionState("Connected", "ready");
    setMessage(error.message || String(error), true);
    await client.startLiveMonitor(state.ports).catch(() => {});
  } finally {
    state.motorTest.running = false;
    setBusy(false);
    renderHub();
  }
}

connectBtn.addEventListener("click", async () => {
  setBusy(true, "Connecting");
  setMessage("");

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
  const button = event.target.closest(".port-mode-button");

  if (!button) {
    return;
  }

  cyclePortMode(button.dataset.port);
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

client.addEventListener("disconnected", () => {
  resetUiAfterDisconnect();
  setMessage("Hub disconnected.");
});

if (!("bluetooth" in navigator)) {
  setConnectionState("Unavailable", "error");
  connectBtn.disabled = true;
  setMessage("Web Bluetooth is not available in this browser.", true);
}

setActiveTab("dashboard");
renderHub();
