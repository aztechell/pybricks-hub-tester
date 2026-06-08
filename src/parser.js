export const PORT_NAMES = Object.freeze(["A", "B", "C", "D", "E", "F"]);

export const DEVICE_NAMES = Object.freeze({
  1: "Wedo 2.0 Medium Motor",
  2: "Powered Up Train Motor",
  8: "Powered Up Light",
  34: "Wedo 2.0 Tilt Sensor",
  35: "Wedo 2.0 Infrared Motion Sensor",
  37: "BOOST Color Distance Sensor",
  38: "BOOST Interactive Motor",
  46: "Technic Large Motor",
  47: "Technic Extra Large Motor",
  48: "SPIKE Medium Angular Motor",
  49: "SPIKE Large Angular Motor",
  61: "SPIKE Color Sensor",
  62: "SPIKE Ultrasonic Sensor",
  63: "SPIKE Force Sensor",
  64: "SPIKE 3x3 Color Light Matrix",
  65: "SPIKE Small Angular Motor",
  75: "Technic Medium Angular Motor",
  76: "Technic Large Angular Motor"
});

export const HUB_CAPABILITY = Object.freeze({
  HAS_REPL: 1 << 0,
  HAS_PORT_VIEW: 1 << 3
});

export function deviceNameForId(deviceId) {
  return DEVICE_NAMES[deviceId] ?? `Unknown #${deviceId}`;
}

export function parseSemver(value) {
  const match = String(value ?? "").match(/(\d+)\.(\d+)\.(\d+)/);

  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: String(value)
  };
}

export function compareSemver(a, b) {
  const left = typeof a === "string" ? parseSemver(a) : a;
  const right = typeof b === "string" ? parseSemver(b) : b;

  if (!left || !right) {
    return Number.NaN;
  }

  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }

  return 0;
}

export function supportsWriteStdin(protocolVersion) {
  return compareSemver(protocolVersion, "1.3.0") >= 0;
}

export function usesBuiltinRepl(protocolVersion) {
  return compareSemver(protocolVersion, "1.4.0") >= 0;
}

export function normalizeDataView(value) {
  if (value instanceof DataView) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return new DataView(value.buffer, value.byteOffset, value.byteLength);
  }

  if (value instanceof ArrayBuffer) {
    return new DataView(value);
  }

  throw new TypeError("Expected DataView, Uint8Array, or ArrayBuffer.");
}

export function parseHubCapabilities(value) {
  const view = normalizeDataView(value);

  if (view.byteLength < 10) {
    return {
      maxWriteSize: 20,
      featureFlags: 0,
      maxUserProgramSize: 0,
      numSlots: null
    };
  }

  return {
    maxWriteSize: view.getUint16(0, true),
    featureFlags: view.getUint32(2, true),
    maxUserProgramSize: view.getUint32(6, true),
    numSlots: view.byteLength > 10 ? view.getUint8(10) : null
  };
}

export function parsePnpId(value) {
  const view = normalizeDataView(value);

  if (view.byteLength < 7) {
    return null;
  }

  return {
    vendorIdSource: view.getUint8(0),
    vendorId: view.getUint16(1, true),
    productId: view.getUint16(3, true),
    productVersion: view.getUint16(5, true)
  };
}

export function makeInitialPorts(status = "unavailable") {
  return PORT_NAMES.map((port) => ({ port, status }));
}

export function parseScanOutput(text, nonce) {
  const byPort = new Map();
  const begin = `PBHT_BEGIN:${nonce}`;
  const end = `PBHT_END:${nonce}`;
  let started = false;
  let complete = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line === begin) {
      started = true;
      continue;
    }

    if (line === end) {
      complete = true;
      continue;
    }

    const parts = line.split(":");

    if (parts.length < 5 || parts[0] !== "PBHT_PORT" || parts[1] !== nonce) {
      continue;
    }

    const [, , port, status, ...rest] = parts;
    const value = rest.join(":");

    if (!PORT_NAMES.includes(port)) {
      continue;
    }

    if (status === "empty") {
      byPort.set(port, { port, status: "empty" });
      continue;
    }

    if (status === "device") {
      const deviceId = Number(value);

      byPort.set(port, {
        port,
        status: Number.isFinite(deviceId) ? "device" : "unknown",
        deviceId: Number.isFinite(deviceId) ? deviceId : null,
        deviceName: Number.isFinite(deviceId) ? deviceNameForId(deviceId) : "Unknown"
      });
      continue;
    }

    if (status === "error") {
      byPort.set(port, { port, status: "error", error: value || "OSError" });
    }
  }

  return {
    started,
    complete,
    ports: [...byPort.values()].sort((a, b) => PORT_NAMES.indexOf(a.port) - PORT_NAMES.indexOf(b.port))
  };
}
