import {
  HUB_CAPABILITY,
  parseHubCapabilities,
  parsePnpId,
  parseScanOutput,
  parseSemver,
  resolveHubModel,
  supportsWriteStdin,
  usesBuiltinRepl
} from "./parser.js";

const PYBRICKS_SERVICE_UUID = "c5f50001-8280-46da-89f4-6d8051e4aeef";
const PYBRICKS_COMMAND_EVENT_UUID = "c5f50002-8280-46da-89f4-6d8051e4aeef";
const PYBRICKS_HUB_CAPABILITIES_UUID = "c5f50003-8280-46da-89f4-6d8051e4aeef";
const DEVICE_INFORMATION_SERVICE_UUID = "0000180a-0000-1000-8000-00805f9b34fb";
const FIRMWARE_REVISION_UUID = "00002a26-0000-1000-8000-00805f9b34fb";
const SOFTWARE_REVISION_UUID = "00002a28-0000-1000-8000-00805f9b34fb";
const PNP_ID_UUID = "00002a50-0000-1000-8000-00805f9b34fb";

const COMMAND = Object.freeze({
  STOP_USER_PROGRAM: 0,
  START_USER_PROGRAM: 1,
  START_REPL: 2,
  WRITE_STDIN: 6
});

const BUILTIN_PROGRAM = Object.freeze({
  REPL: 0x80
});

const EVENT = Object.freeze({
  STATUS_REPORT: 0,
  WRITE_STDOUT: 1
});

const STATUS = Object.freeze({
  USER_PROGRAM_RUNNING: 1 << 6
});

const SAFE_WRITE_STDIN_PAYLOAD_SIZE = 19;
const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

function dataViewToBytes(view, start = 0) {
  return new Uint8Array(view.buffer.slice(view.byteOffset + start, view.byteOffset + view.byteLength));
}

function textFromDataView(view) {
  return new TextDecoder().decode(dataViewToBytes(view));
}

function makeNonce() {
  const random = new Uint32Array(2);
  window.crypto.getRandomValues(random);
  return `${random[0].toString(16)}${random[1].toString(16)}`;
}

function commandName(command) {
  return (
    Object.entries(COMMAND).find(([, value]) => value === command)?.[0].toLowerCase().replaceAll("_", " ") ??
    `command ${command}`
  );
}

function makePortScanProgram(nonce, ports) {
  const portList = (ports.length ? ports : ["A", "B", "C", "D", "E", "F"]).map((port) => `"${port}"`).join(", ");

  return `
from pybricks.iodevices import PUPDevice
from pybricks.parameters import Port
try:
    from uerrno import ENODEV
except ImportError:
    ENODEV = 19

print("PBHT_BEGIN:${nonce}")
for name in (${portList},):
    try:
        port = getattr(Port, name)
    except AttributeError:
        continue
    try:
        device = PUPDevice(port)
        info = device.info()
        print("PBHT_PORT:${nonce}:%s:device:%s" % (name, info.get("id", "?")))
    except OSError as ex:
        code = ex.args[0] if ex.args else -1
        if code == ENODEV:
            print("PBHT_PORT:${nonce}:%s:empty:" % name)
        else:
            print("PBHT_PORT:${nonce}:%s:error:%s" % (name, code))
    except Exception as ex:
        print("PBHT_PORT:${nonce}:%s:error:%s" % (name, type(ex).__name__))
print("PBHT_END:${nonce}")
`.trim();
}

export class PybricksHubClient extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.commandEventCharacteristic = null;
    this.capabilities = {
      maxWriteSize: 20,
      featureFlags: 0,
      maxUserProgramSize: 0,
      numSlots: null
    };
    this.info = null;
    this.stdout = "";
    this.statusFlags = 0;
    this.hasStatusReport = false;
    this.stdoutDecoder = new TextDecoder();
  }

  get connected() {
    return Boolean(this.device?.gatt?.connected && this.commandEventCharacteristic);
  }

  async connect() {
    if (!("bluetooth" in navigator)) {
      throw new Error("Web Bluetooth is not available in this browser.");
    }

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [PYBRICKS_SERVICE_UUID] }],
      optionalServices: [DEVICE_INFORMATION_SERVICE_UUID]
    });

    this.device.addEventListener("gattserverdisconnected", this.#handleDisconnected);
    this.server = await this.device.gatt.connect();

    const pybricksService = await this.server.getPrimaryService(PYBRICKS_SERVICE_UUID);
    this.commandEventCharacteristic = await pybricksService.getCharacteristic(PYBRICKS_COMMAND_EVENT_UUID);
    this.commandEventCharacteristic.addEventListener("characteristicvaluechanged", this.#handleNotification);
    await this.commandEventCharacteristic.startNotifications();

    try {
      const capabilitiesCharacteristic = await pybricksService.getCharacteristic(PYBRICKS_HUB_CAPABILITIES_UUID);
      this.capabilities = parseHubCapabilities(await capabilitiesCharacteristic.readValue());
    } catch {
      this.capabilities = {
        maxWriteSize: 20,
        featureFlags: 0,
        maxUserProgramSize: 0,
        numSlots: null
      };
    }

    this.info = await this.#readHubInfo();

    this.dispatchEvent(
      new CustomEvent("connected", {
        detail: {
          info: this.info,
          capabilities: this.capabilities
        }
      })
    );

    return {
      info: this.info,
      capabilities: this.capabilities
    };
  }

  async disconnect() {
    if (this.commandEventCharacteristic) {
      try {
        await this.commandEventCharacteristic.stopNotifications();
      } catch {
        // The hub may already be gone.
      }
    }

    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }

    this.#resetConnection();
  }

  async scanPorts() {
    if (!this.connected) {
      throw new Error("Hub is not connected.");
    }

    if (!supportsWriteStdin(this.info?.profileVersion)) {
      throw new Error("Pybricks profile 1.3.0 or newer is required for stdin scanning.");
    }

    if (this.capabilities.featureFlags && !(this.capabilities.featureFlags & HUB_CAPABILITY.HAS_REPL)) {
      throw new Error("This hub does not report REPL support.");
    }

    const nonce = makeNonce();
    const code = makePortScanProgram(nonce, this.info?.model?.ports ?? ["A", "B", "C", "D", "E", "F"]);
    const command = `exec(${JSON.stringify(code)})\r\n`;

    this.stdout = "";
    this.stdoutDecoder = new TextDecoder();
    await this.writeCommand(COMMAND.STOP_USER_PROGRAM, undefined, "stop current program");
    await this.#waitForProgramRunning(false, 3000);
    await this.#startRepl();
    await this.#waitForProgramRunning(true, 1500);
    await sleep(200);
    this.stdout = "";

    const resultPromise = this.#waitForScan(nonce, 10000);
    await this.writeStdin(command);
    return resultPromise;
  }

  async writeStdin(text) {
    const bytes = new TextEncoder().encode(text);
    const maxPayloadSize = Math.max(
      1,
      Math.min(SAFE_WRITE_STDIN_PAYLOAD_SIZE, this.capabilities.maxWriteSize - 1 || SAFE_WRITE_STDIN_PAYLOAD_SIZE)
    );

    for (let offset = 0; offset < bytes.length; offset += maxPayloadSize) {
      await this.writeCommand(COMMAND.WRITE_STDIN, bytes.slice(offset, offset + maxPayloadSize), "send scan code");
    }
  }

  async writeCommand(command, payload = new Uint8Array(), context = commandName(command)) {
    if (!this.commandEventCharacteristic) {
      throw new Error("Command characteristic is not ready.");
    }

    const message = new Uint8Array(1 + payload.length);
    message[0] = command;
    message.set(payload, 1);

    try {
      if ("writeValueWithResponse" in this.commandEventCharacteristic) {
        await this.commandEventCharacteristic.writeValueWithResponse(message);
        return;
      }

      await this.commandEventCharacteristic.writeValue(message);
    } catch (error) {
      throw new Error(`${context}: ${error.message || String(error)}`);
    }
  }

  async #startRepl() {
    const protocol = parseSemver(this.info?.profileVersion);

    if (!protocol) {
      throw new Error("Could not read Pybricks profile version.");
    }

    if (usesBuiltinRepl(protocol)) {
      await this.writeCommand(COMMAND.START_USER_PROGRAM, new Uint8Array([BUILTIN_PROGRAM.REPL]), "start REPL");
      return;
    }

    await this.writeCommand(COMMAND.START_REPL, undefined, "start REPL");
  }

  async #readHubInfo() {
    const defaults = {
      name: this.device?.name || "Pybricks Hub",
      firmwareVersion: "-",
      profileVersion: "-",
      pnpId: null
    };

    try {
      const service = await this.server.getPrimaryService(DEVICE_INFORMATION_SERVICE_UUID);
      const [firmwareVersion, profileVersion, pnpId] = await Promise.all([
        this.#readTextCharacteristic(service, FIRMWARE_REVISION_UUID).catch(() => defaults.firmwareVersion),
        this.#readTextCharacteristic(service, SOFTWARE_REVISION_UUID).catch(() => defaults.profileVersion),
        this.#readDataCharacteristic(service, PNP_ID_UUID).then(parsePnpId).catch(() => defaults.pnpId)
      ]);

      return {
        ...defaults,
        firmwareVersion,
        profileVersion,
        pnpId,
        model: resolveHubModel(pnpId)
      };
    } catch {
      return {
        ...defaults,
        model: resolveHubModel(defaults.pnpId)
      };
    }
  }

  async #readTextCharacteristic(service, uuid) {
    const characteristic = await service.getCharacteristic(uuid);
    return textFromDataView(await characteristic.readValue());
  }

  async #readDataCharacteristic(service, uuid) {
    const characteristic = await service.getCharacteristic(uuid);
    return characteristic.readValue();
  }

  #waitForScan(nonce, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for port scan output."));
      }, timeoutMs);

      const onStdout = () => {
        const result = parseScanOutput(this.stdout, nonce);

        if (result.complete) {
          cleanup();
          resolve(result.ports);
        }
      };

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        this.removeEventListener("stdout", onStdout);
      };

      this.addEventListener("stdout", onStdout);
    });
  }

  #isUserProgramRunning() {
    return Boolean(this.statusFlags & STATUS.USER_PROGRAM_RUNNING);
  }

  #waitForProgramRunning(expected, timeoutMs) {
    if (this.hasStatusReport && this.#isUserProgramRunning() === expected) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const onStatus = () => {
        if (this.#isUserProgramRunning() === expected) {
          cleanup();
          resolve(true);
        }
      };

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        this.removeEventListener("status", onStatus);
      };

      this.addEventListener("status", onStatus);
    });
  }

  #handleNotification = (event) => {
    const view = event.target.value;
    const eventType = view.getUint8(0);

    if (eventType === EVENT.STATUS_REPORT && view.byteLength >= 5) {
      this.statusFlags = view.getUint32(1, true);
      this.hasStatusReport = true;
      this.dispatchEvent(
        new CustomEvent("status", {
          detail: {
            flags: this.statusFlags,
            userProgramRunning: Boolean(this.statusFlags & STATUS.USER_PROGRAM_RUNNING)
          }
        })
      );
      return;
    }

    if (eventType === EVENT.WRITE_STDOUT && view.byteLength > 1) {
      const text = this.stdoutDecoder.decode(dataViewToBytes(view, 1), { stream: true });
      this.stdout += text;
      this.dispatchEvent(new CustomEvent("stdout", { detail: text }));
    }
  };

  #handleDisconnected = () => {
    this.#resetConnection();
    this.dispatchEvent(new Event("disconnected"));
  };

  #resetConnection() {
    if (this.commandEventCharacteristic) {
      this.commandEventCharacteristic.removeEventListener("characteristicvaluechanged", this.#handleNotification);
    }

    if (this.device) {
      this.device.removeEventListener("gattserverdisconnected", this.#handleDisconnected);
    }

    this.commandEventCharacteristic = null;
    this.server = null;
    this.device = null;
    this.info = null;
    this.stdout = "";
    this.stdoutDecoder = new TextDecoder();
    this.statusFlags = 0;
    this.hasStatusReport = false;
  }
}
