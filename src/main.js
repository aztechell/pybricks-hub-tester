import { PybricksHubClient } from "./pybricks.js";
import { makeInitialPorts, PORT_NAMES } from "./parser.js";

const connectBtn = document.querySelector("#connectBtn");
const refreshBtn = document.querySelector("#refreshBtn");
const disconnectBtn = document.querySelector("#disconnectBtn");
const connectionState = document.querySelector("#connectionState");
const hubTitle = document.querySelector("#hubTitle");
const modelValue = document.querySelector("#modelValue");
const firmwareValue = document.querySelector("#firmwareValue");
const profileValue = document.querySelector("#profileValue");
const writeSizeValue = document.querySelector("#writeSizeValue");
const scanStamp = document.querySelector("#scanStamp");
const hubScreenText = document.querySelector("#hubScreenText");
const leftPorts = document.querySelector("#leftPorts");
const rightPorts = document.querySelector("#rightPorts");
const portList = document.querySelector("#portList");
const portCount = document.querySelector("#portCount");
const messageBox = document.querySelector("#messageBox");

const client = new PybricksHubClient();

const state = {
  connected: false,
  busy: false,
  hub: null,
  capabilities: null,
  ports: makeInitialPorts(),
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

function renderPortTile(port) {
  const description = describePort(port);
  const element = document.createElement("div");
  const socket = document.createElement("div");
  const content = document.createElement("div");
  const name = document.createElement("div");
  const device = document.createElement("div");

  element.className = portClass(port);
  socket.className = "port-socket";
  socket.textContent = port.port;
  name.className = "port-name";
  name.textContent = `Port ${port.port}`;
  device.className = "port-device";
  device.textContent = description.label;
  content.append(name, device);
  element.append(socket, content);
  return element;
}

function renderPortRow(port) {
  const description = describePort(port);
  const element = document.createElement("div");
  const badge = document.createElement("div");
  const content = document.createElement("div");
  const label = document.createElement("strong");
  const detail = document.createElement("span");

  element.className = "port-row";
  badge.className = "port-badge";
  badge.textContent = port.port;
  label.textContent = description.label;
  detail.textContent = description.detail;
  content.append(label, detail);
  element.append(badge, content);
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

function renderPorts() {
  const portsByName = new Map(state.ports.map((port) => [port.port, port]));
  const left = currentHubModel().portRows.map(([port]) => portsByName.get(port)).filter(Boolean);
  const right = currentHubModel().portRows.map(([, port]) => portsByName.get(port)).filter(Boolean);
  const deviceCount = state.ports.filter((port) => port.status === "device" || port.status === "unknown").length;

  leftPorts.replaceChildren(...left.map(renderPortTile));
  rightPorts.replaceChildren(...right.map(renderPortTile));
  portList.replaceChildren(...state.ports.map(renderPortRow));
  portCount.textContent = `${deviceCount} ${deviceCount === 1 ? "device" : "devices"}`;
}

function renderHub() {
  const hub = state.hub;
  hubTitle.textContent = hub?.name || "No hub selected";
  modelValue.textContent = hub?.model?.name || "-";
  firmwareValue.textContent = hub?.firmwareVersion || "-";
  profileValue.textContent = hub?.profileVersion || "-";
  writeSizeValue.textContent = state.capabilities?.maxWriteSize ? `${state.capabilities.maxWriteSize} bytes` : "-";
  hubScreenText.textContent = state.connected ? "PB" : "--";
  renderPorts();
}

function resetUiAfterDisconnect() {
  state.connected = false;
  state.hub = null;
  state.capabilities = null;
  state.ports = makeInitialPorts("unavailable");
  scanStamp.textContent = "Not scanned";
  setConnectionState("Disconnected", "idle");
  setBusy(false);
  renderHub();
}

async function refreshPorts() {
  setBusy(true, "Scanning");
  setMessage("");

  try {
    const ports = await client.scanPorts();
    state.ports = mergePorts(ports);
    scanStamp.textContent = `Scanned ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    setConnectionState("Connected", "ready");
    renderPorts();
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
