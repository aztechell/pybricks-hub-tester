import { PybricksHubClient } from "./pybricks.js";
import { liveModesForDeviceId, makeInitialPorts, PORT_NAMES } from "./parser.js";

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
  liveValues: new Map(),
  selectedModeByPort: new Map(),
  message: "",
  error: ""
};

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
  const detail = document.createElement("div");

  element.className = `${portClass(port)} port-tile--row-${rowIndex + 1}`;
  element.title = `${description.label}. ${description.detail}${liveDisplay.mode ? `. ${liveDisplay.mode}` : ""}`;
  element.dataset.port = port.port;
  element.dataset.switchable = liveDisplay.switchable ? "true" : "false";
  if (liveDisplay.switchable) {
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", `${description.label}, ${liveDisplay.text}. Switch mode.`);
  }
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
    liveDisplay.switchable ? "port-detail--switchable" : ""
  ].filter(Boolean).join(" ");
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
  batteryValue.textContent = hub?.batteryText || (Number.isFinite(hub?.batteryLevel) ? `${hub.batteryLevel}%` : "-");
  writeSizeValue.textContent = state.capabilities?.maxWriteSize ? `${state.capabilities.maxWriteSize} bytes` : "-";
  hubScreenText.textContent = state.connected ? "PB" : "--";
  hubThumbPlaceholder.hidden = Boolean(hub);
  hubThumbImage.hidden = !hub;
  if (hub) {
    hubThumbImage.src = hubImageSrc(hub);
  }
  hubThumbImage.alt = "";
  renderPorts();
}

function resetUiAfterDisconnect() {
  state.connected = false;
  state.hub = null;
  state.capabilities = null;
  state.ports = makeInitialPorts("unavailable");
  state.liveValues.clear();
  state.selectedModeByPort.clear();
  scanStamp.textContent = "Not scanned";
  setConnectionState("Disconnected", "idle");
  setBusy(false);
  renderHub();
}

async function refreshPorts() {
  setBusy(true, "Scanning");
  setMessage("");
  state.liveValues.clear();

  try {
    await client.stopLiveMonitor();
    const ports = await client.scanPorts();
    state.ports = mergePorts(ports);
    syncLiveModesForPorts();
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

connectBtn.addEventListener("click", async () => {
  setBusy(true, "Connecting");
  setMessage("");

  try {
    const { info, capabilities } = await client.connect();
    state.connected = true;
    state.hub = info;
    state.capabilities = capabilities;
    state.ports = makeInitialPorts("unavailable", currentPortNames());
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

hubDashboard.addEventListener("click", (event) => {
  const tile = event.target.closest(".port-tile[data-switchable='true']");

  if (!tile) {
    return;
  }

  cyclePortMode(tile.dataset.port);
});

hubDashboard.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  const tile = event.target.closest(".port-tile[data-switchable='true']");

  if (!tile) {
    return;
  }

  event.preventDefault();
  cyclePortMode(tile.dataset.port);
});

client.addEventListener("live", (event) => {
  for (const reading of event.detail.values) {
    if (reading.status === "value") {
      state.liveValues.delete(liveValueKey(reading.port, "error"));
    }

    state.liveValues.set(liveValueKey(reading.port, reading.mode), reading);
  }

  renderHub();
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

renderHub();
