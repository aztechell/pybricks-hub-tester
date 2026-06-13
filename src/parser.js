export const PORT_NAMES = Object.freeze(["A", "B", "C", "D", "E", "F"]);

export const HUB_MODELS = Object.freeze({
  64: {
    id: 64,
    name: "BOOST Move Hub",
    hubClass: "MoveHub",
    ports: ["A", "B", "C", "D"],
    portRows: [["A", "B"], ["C", "D"]]
  },
  65: {
    id: 65,
    name: "City Hub",
    hubClass: "CityHub",
    ports: ["A", "B"],
    portRows: [["A", "B"]]
  },
  128: {
    id: 128,
    name: "Technic Hub",
    hubClass: "TechnicHub",
    ports: ["A", "B", "C", "D"],
    portRows: [["A", "B"], ["C", "D"]]
  },
  129: {
    id: 129,
    name: "Prime Hub",
    hubClass: "PrimeHub",
    ports: ["A", "B", "C", "D", "E", "F"],
    portRows: [["A", "B"], ["C", "D"], ["E", "F"]]
  },
  131: {
    id: 131,
    name: "Essential Hub",
    hubClass: "EssentialHub",
    ports: ["A", "B"],
    portRows: [["A", "B"]]
  }
});

export const UNKNOWN_HUB_MODEL = Object.freeze({
  id: null,
  name: "Unknown Pybricks Hub",
  hubClass: null,
  ports: PORT_NAMES,
  portRows: [["A", "B"], ["C", "D"], ["E", "F"]]
});

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

export const LIVE_DEVICE_PROFILES = Object.freeze({
  37: {
    kind: "color-distance",
    modes: ["reflection", "distance", "ambient", "hsv", "rgb", "color"]
  },
  38: {
    kind: "motor",
    modes: ["angle", "speed"]
  },
  46: {
    kind: "motor",
    modes: ["angle", "speed"]
  },
  47: {
    kind: "motor",
    modes: ["angle", "speed"]
  },
  48: {
    kind: "motor",
    modes: ["angle", "speed"]
  },
  49: {
    kind: "motor",
    modes: ["angle", "speed"]
  },
  61: {
    kind: "color",
    modes: ["reflection", "ambient", "hsv", "rgb", "color"]
  },
  62: {
    kind: "ultrasonic",
    modes: ["distance"]
  },
  63: {
    kind: "force",
    modes: ["force", "pressed"]
  },
  65: {
    kind: "motor",
    modes: ["angle", "speed"]
  },
  75: {
    kind: "motor",
    modes: ["angle", "speed"]
  },
  76: {
    kind: "motor",
    modes: ["angle", "speed"]
  }
});

const LIVE_MODE_ORDER = Object.freeze([
  "angle",
  "speed",
  "force",
  "pressed",
  "distance",
  "reflection",
  "ambient",
  "hsv",
  "rgb",
  "color",
  "error"
]);

const BATTERY_PROFILES = Object.freeze({
  liIon2s: [
    [6400, 0],
    [6800, 10],
    [7000, 20],
    [7200, 35],
    [7400, 55],
    [7600, 70],
    [7800, 82],
    [8000, 92],
    [8400, 100]
  ],
  sixCell: [
    [6000, 0],
    [6600, 10],
    [7200, 35],
    [7800, 55],
    [8400, 75],
    [9000, 90],
    [9600, 100]
  ]
});

export const HUB_CAPABILITY = Object.freeze({
  HAS_REPL: 1 << 0,
  HAS_PORT_VIEW: 1 << 3
});

export function deviceNameForId(deviceId) {
  return DEVICE_NAMES[deviceId] ?? `Unknown #${deviceId}`;
}

export function liveModesForDeviceId(deviceId) {
  return LIVE_DEVICE_PROFILES[deviceId]?.modes ?? [];
}

export function isMotorDeviceId(deviceId) {
  return LIVE_DEVICE_PROFILES[deviceId]?.kind === "motor";
}

export function estimateBatteryPercentFromVoltage(voltageMv, model = null) {
  const voltage = Number(voltageMv);

  if (!Number.isFinite(voltage)) {
    return null;
  }

  const productId = typeof model === "number" ? model : model?.id;
  const curve = productId === 129 || productId === 131 || (!productId && voltage <= 8500)
    ? BATTERY_PROFILES.liIon2s
    : BATTERY_PROFILES.sixCell;

  if (voltage <= curve[0][0]) {
    return 0;
  }

  for (let index = 1; index < curve.length; index += 1) {
    const [rightVoltage, rightPercent] = curve[index];

    if (voltage <= rightVoltage) {
      const [leftVoltage, leftPercent] = curve[index - 1];
      const ratio = (voltage - leftVoltage) / (rightVoltage - leftVoltage);

      return Math.round(leftPercent + ratio * (rightPercent - leftPercent));
    }
  }

  return 100;
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
    vendorIdSourceName: view.getUint8(0) === 1 ? "Bluetooth" : "USB",
    vendorId: view.getUint16(1, true),
    productId: view.getUint16(3, true),
    productVersion: view.getUint16(5, true)
  };
}

export function resolveHubModel(pnpId) {
  if (!pnpId) {
    return UNKNOWN_HUB_MODEL;
  }

  if (pnpId.productId === 129 && pnpId.productVersion === 1) {
    return {
      ...HUB_MODELS[129],
      name: "Inventor Hub",
      hubClass: "InventorHub"
    };
  }

  return HUB_MODELS[pnpId.productId] ?? UNKNOWN_HUB_MODEL;
}

export function makeInitialPorts(status = "unavailable", ports = PORT_NAMES) {
  return ports.map((port) => ({ port, status }));
}

export function parseScanOutput(text, nonce) {
  const byPort = new Map();
  const begin = `PBHT_BEGIN:${nonce}`;
  const end = `PBHT_END:${nonce}`;
  let battery = null;
  let started = false;
  let complete = false;

  for (const rawLine of String(text).split(/[\r\n]+/)) {
    const line = rawLine.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();

    if (line === begin) {
      started = true;
      continue;
    }

    if (line === end) {
      complete = true;
      continue;
    }

    const parts = line.split(":");

    if (parts[0] === "X" && parts[1] === nonce) {
      complete = true;
      continue;
    }

    if (parts.length >= 4 && parts[0] === "B" && parts[1] === nonce) {
      const [, , status, value] = parts;

      if (status === "V") {
        const voltageMv = Number(value);
        battery = Number.isFinite(voltageMv) ? { status: "voltage", voltageMv } : { status: "unknown" };
      } else if (status === "X") {
        battery = { status: "error", error: value || "Error" };
      }

      continue;
    }

    if (parts.length >= 5 && parts[0] === "P" && parts[1] === nonce) {
      const [, , port, status, ...rest] = parts;
      const value = rest.join(":");

      if (!PORT_NAMES.includes(port)) {
        continue;
      }

      if (status === "E") {
        byPort.set(port, { port, status: "empty" });
        continue;
      }

      if (status === "D") {
        const deviceId = Number(value);

        byPort.set(port, {
          port,
          status: Number.isFinite(deviceId) ? "device" : "unknown",
          deviceId: Number.isFinite(deviceId) ? deviceId : null,
          deviceName: Number.isFinite(deviceId) ? deviceNameForId(deviceId) : "Unknown"
        });
        continue;
      }

      if (status === "X") {
        byPort.set(port, { port, status: "error", error: value || "Error" });
      }

      continue;
    }

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
    battery,
    ports: [...byPort.values()].sort((a, b) => PORT_NAMES.indexOf(a.port) - PORT_NAMES.indexOf(b.port))
  };
}

export function parseLiveOutput(text, nonce) {
  const byKey = new Map();
  const imu = {};

  for (const rawLine of String(text).split(/[\r\n]+/)) {
    const line = rawLine.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
    const parts = line.split(":");

    if (parts.length >= 4 && parts[0] === "I" && parts[1] === nonce) {
      const [, , mode, ...rest] = parts;
      const value = rest.join(":");

      if (["voltage", "current", "yaw", "pitch", "roll", "error"].includes(mode)) {
        imu[mode] = value;
      }

      continue;
    }

    if (parts.length < 5 || parts[0] !== "L" || parts[1] !== nonce) {
      continue;
    }

    const [, , port, mode, ...rest] = parts;
    const value = rest.join(":");

    if (!PORT_NAMES.includes(port) || !mode) {
      continue;
    }

    byKey.set(`${port}:${mode}`, {
      port,
      mode,
      status: mode === "error" ? "error" : "value",
      value,
      error: mode === "error" ? value || "Error" : null
    });
  }

  return {
    imu,
    values: [...byKey.values()].sort((a, b) => {
      const portDelta = PORT_NAMES.indexOf(a.port) - PORT_NAMES.indexOf(b.port);

      if (portDelta) {
        return portDelta;
      }

      const aMode = LIVE_MODE_ORDER.includes(a.mode) ? LIVE_MODE_ORDER.indexOf(a.mode) : LIVE_MODE_ORDER.length;
      const bMode = LIVE_MODE_ORDER.includes(b.mode) ? LIVE_MODE_ORDER.indexOf(b.mode) : LIVE_MODE_ORDER.length;

      return aMode - bMode;
    })
  };
}

export function parseMotorSweepOutput(text, nonce) {
  const points = [];
  const metrics = {
    backlash: {
      positiveDeg: null,
      negativeDeg: null,
      status: "not_run",
      error: null
    }
  };
  let complete = false;
  let error = null;

  const parseBacklashValue = (value) => {
    if (value === "N" || value === "") {
      return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  for (const rawLine of String(text).split(/[\r\n]+/)) {
    const line = rawLine.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
    const parts = line.split(":");

    if (parts.length >= 2 && parts[0] === "MX" && parts[1] === nonce) {
      complete = true;
      continue;
    }

    if (parts.length >= 3 && parts[0] === "ME" && parts[1] === nonce) {
      error = parts.slice(2).join(":") || "Motor test failed";
      continue;
    }

    if (parts.length >= 4 && parts[0] === "MB" && parts[1] === nonce) {
      const positiveRaw = parts[2] ?? "";
      const negativeRaw = parts[3] ?? "";
      const positiveError = positiveRaw.startsWith("X") ? positiveRaw.slice(1) || "Error" : null;
      const negativeError = negativeRaw.startsWith("X") ? negativeRaw.slice(1) || "Error" : null;
      const positiveDeg = positiveError ? null : parseBacklashValue(positiveRaw);
      const negativeDeg = negativeError ? null : parseBacklashValue(negativeRaw);

      metrics.backlash = {
        positiveDeg,
        negativeDeg,
        status: positiveError || negativeError
          ? "error"
          : Number.isFinite(positiveDeg) || Number.isFinite(negativeDeg)
            ? "ok"
            : "not_detected",
        error: positiveError || negativeError
      };
      continue;
    }

    if (parts.length < 4 || parts[0] !== "MT" || parts[1] !== nonce) {
      continue;
    }

    const dc = Number(parts[2]);
    const speedDegPerSecond = Number(parts[3]);
    const hubCurrentMa = Number(parts[4]);
    const currentMa = Number(parts[5]);

    if (!Number.isFinite(dc) || !Number.isFinite(speedDegPerSecond)) {
      continue;
    }

    const point = {
      dc,
      speedDegPerSecond,
      rpm: speedDegPerSecond / 6
    };

    if (Number.isFinite(hubCurrentMa)) {
      point.hubCurrentMa = hubCurrentMa;
    }

    if (Number.isFinite(currentMa)) {
      point.currentMa = currentMa;
    }

    points.push(point);
  }

  return {
    complete,
    error,
    points,
    metrics
  };
}

export function parseMotorSweepProgress(text, nonce, pointsTotal = 0) {
  const result = parseMotorSweepOutput(text, nonce);
  const safePointsTotal = Math.max(0, Number(pointsTotal) || 0);
  const pointsDone = safePointsTotal ? Math.min(result.points.length, safePointsTotal) : result.points.length;
  const hasBacklash = result.metrics.backlash.status !== "not_run";
  let phase = "sweeping";
  let percent = safePointsTotal ? Math.round((pointsDone / safePointsTotal) * 90) : 0;

  if (result.error) {
    phase = "error";
    percent = Math.max(percent, 0);
  } else if (result.complete) {
    phase = "complete";
    percent = 100;
  } else if (hasBacklash || (safePointsTotal > 0 && pointsDone >= safePointsTotal)) {
    phase = "backlash";
    percent = 95;
  } else {
    percent = Math.max(5, percent);
  }

  return {
    phase,
    percent: Math.max(0, Math.min(100, percent)),
    pointsDone,
    pointsTotal: safePointsTotal,
    complete: result.complete,
    error: result.error,
    partialResult: result
  };
}
