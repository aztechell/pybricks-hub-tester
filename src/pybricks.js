import {
  estimateBatteryPercentFromVoltage,
  HUB_CAPABILITY,
  liveModesForDeviceId,
  parseHubCapabilities,
  parseLiveOutput,
  parseMotorSweepOutput,
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
const BATTERY_SERVICE_UUID = "0000180f-0000-1000-8000-00805f9b34fb";
const BATTERY_LEVEL_UUID = "00002a19-0000-1000-8000-00805f9b34fb";

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

const SAFE_STDIN_WRITE = Object.freeze({
  chunkSize: 8,
  chunkDelay: 80,
  allowPartialOnTimeout: true
});

const ADAPTIVE_SCAN_WRITE = Object.freeze({
  chunkSize: 64,
  minChunkSize: 8,
  chunkDelay: 10,
  maxChunkDelay: 80,
  adaptive: true,
  allowPartialOnTimeout: false
});

const LIVE_MONITOR_WRITE = Object.freeze({
  chunkSize: 64,
  minChunkSize: 8,
  chunkDelay: 10,
  maxChunkDelay: 80,
  adaptive: true,
  allowPartialOnTimeout: false
});

const LIVE_MONITOR_INTERVAL_MS = 350;
const MOTOR_SWEEP_SETTLE_MS = 260;
const MOTOR_BACKLASH_TAKEUP_MS = 360;
const MOTOR_BACKLASH_SAMPLE_MS = 20;
const MOTOR_BACKLASH_SAMPLES = 60;
const MOTOR_BACKLASH_DUTY = 28;
const MOTOR_BACKLASH_LOAD_THRESHOLD_MNM = 5;

const MOTOR_DEVICE_IDS = Object.freeze([38, 46, 47, 48, 49, 65, 75, 76]);

const LIVE_DEVICE_CLASS_BY_ID = Object.freeze({
  37: "ColorDistanceSensor",
  61: "ColorSensor",
  62: "UltrasonicSensor",
  63: "ForceSensor"
});

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dataViewToBytes(view, start = 0) {
  return new Uint8Array(view.buffer.slice(view.byteOffset + start, view.byteOffset + view.byteLength));
}

function textFromDataView(view) {
  return new TextDecoder().decode(dataViewToBytes(view));
}

function formatBatteryPercent(percent) {
  return Number.isFinite(percent) ? `${clamp(Math.round(percent), 0, 100)}%` : null;
}

function makeNonce() {
  const random = new Uint16Array(1);
  window.crypto.getRandomValues(random);
  return random[0].toString(36);
}

function commandName(command) {
  return (
    Object.entries(COMMAND).find(([, value]) => value === command)?.[0].toLowerCase().replaceAll("_", " ") ??
    `command ${command}`
  );
}

function makeAdaptiveWritePlan(maxWriteSize) {
  const maxPayloadSize = Math.max(1, (maxWriteSize || 20) - 1);
  const floorChunkSize = Math.min(ADAPTIVE_SCAN_WRITE.minChunkSize, maxPayloadSize);
  const upperChunkSize = clamp(Math.min(ADAPTIVE_SCAN_WRITE.chunkSize, maxPayloadSize), floorChunkSize, maxPayloadSize);
  const minChunkSize = Math.min(ADAPTIVE_SCAN_WRITE.minChunkSize, upperChunkSize);
  const ratioDelay = (chunkSize) => {
    const span = Math.max(1, upperChunkSize - minChunkSize);
    const ratio = (upperChunkSize - chunkSize) / span;
    return Math.round(ADAPTIVE_SCAN_WRITE.chunkDelay + ratio * (ADAPTIVE_SCAN_WRITE.maxChunkDelay - ADAPTIVE_SCAN_WRITE.chunkDelay));
  };
  const sizes = [
    upperChunkSize,
    Math.round(upperChunkSize * 0.75),
    Math.round(upperChunkSize * 0.5),
    Math.round(upperChunkSize * 0.33),
    minChunkSize
  ];
  const uniqueSizes = [...new Set(sizes.map((size) => clamp(size, minChunkSize, upperChunkSize)))].sort((a, b) => b - a);

  return uniqueSizes.map((chunkSize, index) => ({
    ...ADAPTIVE_SCAN_WRITE,
    name: `adaptive ${chunkSize}b/${ratioDelay(chunkSize)}ms`,
    chunkSize,
    chunkDelay: ratioDelay(chunkSize),
    allowPartialOnTimeout: index === uniqueSizes.length - 1
  }));
}

function makePortScanProgram(nonce, ports, hubClass) {
  const portList = (ports.length ? ports : ["A", "B", "C", "D", "E", "F"]).map((port) => `"${port}"`).join(", ");
  const batteryCode = hubClass
    ? `from pybricks.hubs import ${hubClass} as H
try:h=H();print("B:${nonce}:V:%s"%h.battery.voltage())
except Exception as e:print("B:${nonce}:X:%s"%type(e).__name__)`
    : `print("B:${nonce}:X:UnknownHub")`;

  return `
${batteryCode}
from pybricks.iodevices import PUPDevice as D
from pybricks.parameters import Port as P
for n in (${portList},):
    try:i=D(getattr(P,n)).info()["id"];print("P:${nonce}:%s:D:%s"%(n,i))
    except OSError:print("P:${nonce}:%s:E:"%n)
    except Exception as e:print("P:${nonce}:%s:X:%s"%(n,type(e).__name__))
print("X:${nonce}")
`.trim();
}

function makePythonTuple(items) {
  if (items.length === 1) {
    return `(${items[0]},)`;
  }

  return `(${items.join(",")})`;
}

function makeLiveMonitorProgram(nonce, ports, hubClass) {
  const livePorts = ports.filter((port) => liveModesForDeviceId(port.deviceId).length);

  if (!livePorts.length && !hubClass) {
    return null;
  }

  const portRows = makePythonTuple(livePorts.map((port) => `("${port.port}",${port.deviceId})`));
  const motorIds = makePythonTuple(MOTOR_DEVICE_IDS.map(String));
  const importNames = new Set();

  for (const port of livePorts) {
    if (MOTOR_DEVICE_IDS.includes(port.deviceId)) {
      importNames.add("Motor");
      continue;
    }

    const className = LIVE_DEVICE_CLASS_BY_ID[port.deviceId];

    if (className) {
      importNames.add(className);
    }
  }

  const pupdeviceImport = importNames.size ? `from pybricks.pupdevices import ${[...importNames].join(",")}` : "";
  const hubImport = hubClass ? `from pybricks.hubs import ${hubClass} as Hub` : "Hub=None";

  return `
N="${nonce}"
R=${portRows}
M=${motorIds}
H=None
BR=True
IR=True
O=[]
def flush():
    global O
    if O:
        print("\\n".join(O))
        O=[]
def emit(p,m,v):
    O.append("L:%s:%s:%s:%s"%(N,p,m,v))
def im(m,v):
    O.append("I:%s:%s:%s"%(N,m,v))
def hs(c):
    return "%s,%s,%s"%(round(c.h),round(c.s),round(c.v))
try:
    from pybricks.parameters import Port
    ${pupdeviceImport}
    ${hubImport}
    from pybricks.tools import wait
except Exception as e:
    for n,i in R:
        emit(n,"error",type(e).__name__)
    im("error",type(e).__name__)
    flush()
    raise
try:
    if Hub:
        H=Hub()
except Exception as e:
    im("error",type(e).__name__)
def make(i,p):
    if i in M:return Motor(p,reset_angle=False)
    if i==63:return ForceSensor(p)
    if i==62:return UltrasonicSensor(p)
    if i==61:return ColorSensor(p)
    if i==37:return ColorDistanceSensor(p)
    return None
D=[]
for n,i in R:
    try:
        d=make(i,getattr(Port,n))
        if d:D.append((n,i,d))
    except Exception as e:
        emit(n,"error",type(e).__name__)
flush()
while True:
    O=[]
    if H:
        if BR:
            try:
                im("voltage",H.battery.voltage())
                im("current",H.battery.current())
            except Exception:
                BR=False
        if IR:
            try:
                p,r=H.imu.tilt()
                im("yaw",round(H.imu.heading()))
                im("pitch",round(p))
                im("roll",round(r))
            except Exception as e:
                im("error",type(e).__name__)
                IR=False
    for n,i,d in D:
        try:
            if i in M:
                emit(n,"angle",d.angle());emit(n,"speed",d.speed())
            elif i==63:
                emit(n,"force","%.1f"%d.force());emit(n,"pressed",1 if d.pressed() else 0)
            elif i==62:
                emit(n,"distance",d.distance()//10)
            elif i in (37,61):
                try:emit(n,"reflection",d.reflection())
                except Exception:pass
                try:emit(n,"ambient",d.ambient())
                except Exception:pass
                try:emit(n,"hsv",hs(d.hsv()))
                except Exception:pass
                try:emit(n,"color",str(d.color()).split(".")[-1])
                except Exception as e:emit(n,"error",type(e).__name__)
        except Exception as e:
            emit(n,"error",type(e).__name__)
    flush()
    wait(${LIVE_MONITOR_INTERVAL_MS})
`.trim();
}

function makeMotorSweepProgram(nonce, port, step, hubClass) {
  const hubImport = hubClass ? `from pybricks.hubs import ${hubClass} as Hub` : "Hub=None";

  return `
from pybricks.parameters import Port
from pybricks.pupdevices import Motor
from pybricks.tools import wait
${hubImport}
N="${nonce}"
S=${step}
H=None
IDLE=0
def cur():
    if not H:return ("","")
    try:
        c=H.battery.current()
        return (c,c-IDLE)
    except Exception:
        return ("","")
try:
    if Hub:
        H=Hub()
        IDLE=H.battery.current()
except Exception:
    H=None
m=Motor(getattr(Port,"${port}"),reset_angle=False)
seq=[0]+list(range(S,101,S))+[0]+list(range(-S,-101,-S))+[0]
def bl(v):
    try:
        m.dc(v*${MOTOR_BACKLASH_DUTY})
        wait(${MOTOR_BACKLASH_TAKEUP_MS})
        m.brake()
        wait(120)
        a0=m.angle()
        m.dc(-v*${MOTOR_BACKLASH_DUTY})
        for _ in range(${MOTOR_BACKLASH_SAMPLES}):
            wait(${MOTOR_BACKLASH_SAMPLE_MS})
            a=abs(m.angle()-a0)
            try:l=abs(m.load())
            except Exception:l=0
            if a>=1 and l>=${MOTOR_BACKLASH_LOAD_THRESHOLD_MNM}:
                m.brake()
                wait(80)
                return a
        m.brake()
        wait(80)
        return "N"
    except Exception as e:
        try:m.brake()
        except Exception:pass
        return "X"+type(e).__name__
try:
    for d in seq:
        try:
            m.dc(d)
            wait(${MOTOR_SWEEP_SETTLE_MS})
            c,mc=cur()
            print("MT:%s:%s:%s:%s:%s"%(N,d,m.speed(100),c,mc))
        except Exception as e:
            print("ME:%s:%s"%(N,type(e).__name__))
            break
    print("MB:%s:%s:%s"%(N,bl(1),bl(-1)))
finally:
    m.stop()
    print("MX:%s"%N)
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
    this.statusReportCount = 0;
    this.runningProgramId = 0;
    this.selectedSlot = 0;
    this.eventTrace = [];
    this.stdoutDecoder = new TextDecoder();
    this.liveNonce = null;
    this.liveBuffer = "";
    this.liveRunning = false;
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
      optionalServices: [DEVICE_INFORMATION_SERVICE_UUID, BATTERY_SERVICE_UUID]
    });

    this.device.addEventListener("gattserverdisconnected", this.#handleDisconnected);
    this.server = await this.device.gatt.connect();

    const pybricksService = await this.server.getPrimaryService(PYBRICKS_SERVICE_UUID);
    this.commandEventCharacteristic = await pybricksService.getCharacteristic(PYBRICKS_COMMAND_EVENT_UUID);
    this.commandEventCharacteristic.addEventListener("characteristicvaluechanged", this.#handleNotification);

    // Matches Pybricks Code's reconnect workaround: Chromium can keep a stale
    // notification state where descriptor writes are skipped and events never fire.
    try {
      await this.commandEventCharacteristic.stopNotifications();
    } catch {
      // It is fine if notifications were not active yet.
    }

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
    await this.stopLiveMonitor().catch(() => {});

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

  async startLiveMonitor(ports) {
    if (!this.connected) {
      throw new Error("Hub is not connected.");
    }

    const supportedPorts = ports.filter((port) => liveModesForDeviceId(port.deviceId).length);

    await this.stopLiveMonitor().catch(() => {});

    const nonce = makeNonce();
    const code = makeLiveMonitorProgram(nonce, supportedPorts, this.info?.model?.hubClass);

    if (!code) {
      return false;
    }

    try {
      await this.#startFreshRepl();
      this.liveNonce = nonce;
      this.liveBuffer = "";
      this.liveRunning = true;
      this.stdout = "";
      await this.writeStdin(
        `\x05${code.replace(/\n/g, "\r\n")}\r\n\x04`,
        `send live monitor (${supportedPorts.length} ports)`,
        LIVE_MONITOR_WRITE
      );

      this.dispatchEvent(
        new CustomEvent("live-started", {
          detail: {
            nonce,
            ports: supportedPorts.map((port) => port.port)
          }
        })
      );

      return true;
    } catch (error) {
      this.liveNonce = null;
      this.liveBuffer = "";
      this.liveRunning = false;
      await this.writeCommand(COMMAND.STOP_USER_PROGRAM, undefined, "stop live monitor after start failure").catch(() => {});
      throw error;
    }
  }

  async stopLiveMonitor() {
    const wasLive = Boolean(this.liveNonce || this.liveRunning);

    this.liveNonce = null;
    this.liveBuffer = "";
    this.liveRunning = false;

    if (!wasLive || !this.connected) {
      return false;
    }

    await this.writeStdin("\x03", "interrupt live monitor", SAFE_STDIN_WRITE).catch(() => {});
    await this.writeCommand(COMMAND.STOP_USER_PROGRAM, undefined, "stop live monitor").catch(() => {});
    await this.#waitForProgramRunning(false, 3000);
    this.stdout = "";
    this.stdoutDecoder = new TextDecoder();
    return true;
  }

  async scanPorts() {
    if (!this.connected) {
      throw new Error("Hub is not connected.");
    }

    if (this.liveNonce || this.liveRunning) {
      await this.stopLiveMonitor();
    }

    if (!supportsWriteStdin(this.info?.profileVersion)) {
      throw new Error("Pybricks profile 1.3.0 or newer is required for stdin scanning.");
    }

    if (this.capabilities.featureFlags && !(this.capabilities.featureFlags & HUB_CAPABILITY.HAS_REPL)) {
      throw new Error("This hub does not report REPL support.");
    }

    const scanPorts = this.info?.model?.ports ?? ["A", "B", "C", "D", "E", "F"];
    const writeModes = makeAdaptiveWritePlan(this.capabilities.maxWriteSize);
    let lastScanError = null;

    for (const mode of writeModes) {
      const nonce = makeNonce();
      const code = makePortScanProgram(nonce, scanPorts, this.info?.model?.hubClass);
      const rawCommand = `${code}\x04`;
      const pasteCommand = `\x05${code.replace(/\n/g, "\r\n")}\r\n\x04`;

      try {
        await this.#startFreshRepl();
      } catch (error) {
        throw error;
      }

      this.stdout = "";
      await this.writeStdin("\x03\r", "wake friendly REPL");
      await this.#waitForStdout((text) => text.includes(">>>") || text.includes("KeyboardInterrupt"), 3000);
      this.stdout = "";
      await this.writeStdin(`print("R:${nonce}")\r`, "send friendly REPL probe");
      const didFriendlyProbeStdout = await this.#waitForStdout((text) => text.includes(`R:${nonce}`), 5000);

      if (didFriendlyProbeStdout) {
        try {
          return await this.#runScanCommand(
            pasteCommand,
            `send paste scan code (${mode.name})`,
            nonce,
            scanPorts,
            mode
          );
        } catch (error) {
          lastScanError = error;
          if (mode === writeModes.at(-1)) {
            throw error;
          }
        } finally {
          await this.writeCommand(COMMAND.STOP_USER_PROGRAM, undefined, "stop REPL after scan").catch(() => {});
        }

        continue;
      }

      const friendlyProbeOutput = this.#stdoutPreview();
      this.stdout = "";
      await this.writeStdin("\x03\x03\x01", "enter raw REPL");
      const didEnterRawRepl = await this.#waitForStdout((text) => text.includes("raw REPL"), 3000);
      let rawProbeOutput = "";

      if (didEnterRawRepl) {
        const rawProbe = `print("R:${nonce}")\x04`;
        this.stdout = "";
        await this.writeStdin(rawProbe, "send raw REPL probe");
        const didRawProbeStdout = await this.#waitForStdout((text) => text.includes(`R:${nonce}`), 5000);

        if (didRawProbeStdout) {
          try {
            return await this.#runScanCommand(
              rawCommand,
              `send raw scan code (${mode.name})`,
              nonce,
              scanPorts,
              mode
            );
          } catch (error) {
            lastScanError = error;
            if (mode === writeModes.at(-1)) {
              throw error;
            }
          } finally {
            await this.writeStdin("\x02", "exit raw REPL").catch(() => {});
            await this.writeCommand(COMMAND.STOP_USER_PROGRAM, undefined, "stop REPL after scan").catch(() => {});
          }

          continue;
        }

        rawProbeOutput = this.#stdoutPreview();
        await this.writeStdin("\x02", "exit raw REPL").catch(() => {});
      }

      await this.writeCommand(COMMAND.STOP_USER_PROGRAM, undefined, "stop REPL after probe failure").catch(() => {});
      throw new Error(
        `REPL probe did not return stdout. Friendly output: ${friendlyProbeOutput || "none"}. Raw output: ${
          rawProbeOutput || "none"
        }. Events: ${this.#eventTracePreview()}`
      );
    }

    throw lastScanError || new Error("Port scan failed.");
  }

  async runMotorDcSweep({ port, step }) {
    if (!this.connected) {
      throw new Error("Hub is not connected.");
    }

    if (!supportsWriteStdin(this.info?.profileVersion)) {
      throw new Error("Pybricks profile 1.3.0 or newer is required for motor testing.");
    }

    if (!["A", "B", "C", "D", "E", "F"].includes(port)) {
      throw new Error("Select a motor port.");
    }

    if (![1, 5, 10].includes(step)) {
      throw new Error("Select a DC step of 1, 5, or 10.");
    }

    await this.stopLiveMonitor().catch(() => {});

    const nonce = makeNonce();
    const code = makeMotorSweepProgram(nonce, port, step, this.info?.model?.hubClass);
    const pointCount = 3 + Math.floor(100 / step) * 2;
    const backlashTimeoutMs =
      2 * (MOTOR_BACKLASH_TAKEUP_MS + 200 + MOTOR_BACKLASH_SAMPLES * MOTOR_BACKLASH_SAMPLE_MS);
    const timeoutMs = Math.max(15000, pointCount * (MOTOR_SWEEP_SETTLE_MS + 120) + backlashTimeoutMs + 8000);
    const command = `\x05${code.replace(/\n/g, "\r\n")}\r\n\x04`;

    try {
      await this.#startFreshRepl();
      this.stdout = "";
      const resultPromise = this.#waitForMotorSweep(nonce, timeoutMs);
      await this.writeStdin(command, `send motor sweep (${port}, ${step}%)`, LIVE_MONITOR_WRITE);
      return await resultPromise;
    } finally {
      await this.writeCommand(COMMAND.STOP_USER_PROGRAM, undefined, "stop motor test").catch(() => {});
      this.stdout = "";
      this.stdoutDecoder = new TextDecoder();
    }
  }

  async writeStdin(text, context = "send stdin", options = SAFE_STDIN_WRITE) {
    const bytes = new TextEncoder().encode(text);
    const requestedChunkSize = options.chunkSize ?? SAFE_STDIN_WRITE.chunkSize;
    const requestedDelay = options.chunkDelay ?? SAFE_STDIN_WRITE.chunkDelay;
    const minChunkSize = options.minChunkSize ?? requestedChunkSize;
    const maxChunkDelay = options.maxChunkDelay ?? requestedDelay;
    const maxPayloadSize = Math.max(
      1,
      Math.min(requestedChunkSize, this.capabilities.maxWriteSize - 1 || requestedChunkSize)
    );
    let chunkSize = maxPayloadSize;
    let chunkDelay = requestedDelay;
    let offset = 0;

    while (offset < bytes.length) {
      const end = Math.min(offset + chunkSize, bytes.length);

      try {
        await this.writeCommand(COMMAND.WRITE_STDIN, bytes.slice(offset, end), `${context} (${end}/${bytes.length})`);
        offset = end;
      } catch (error) {
        if (!options.adaptive || chunkSize <= minChunkSize) {
          throw error;
        }

        chunkSize = Math.max(minChunkSize, Math.floor(chunkSize / 2));
        chunkDelay = Math.min(maxChunkDelay, Math.max(chunkDelay + 15, Math.round(chunkDelay * 1.6)));
        await sleep(chunkDelay);
        continue;
      }

      if (chunkDelay > 0) {
        await sleep(chunkDelay);
      }
    }
  }

  async writeCommand(command, payload = new Uint8Array(), context = commandName(command)) {
    if (!this.commandEventCharacteristic) {
      throw new Error("Command characteristic is not ready.");
    }

    const message = new Uint8Array(1 + payload.length);
    message[0] = command;
    message.set(payload, 1);

    const maxAttempts = command === COMMAND.WRITE_STDIN ? 3 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if ("writeValueWithResponse" in this.commandEventCharacteristic) {
          await this.commandEventCharacteristic.writeValueWithResponse(message);
          return;
        }

        await this.commandEventCharacteristic.writeValue(message);
        return;
      } catch (error) {
        lastError = error;

        if (attempt < maxAttempts) {
          await sleep(180 * attempt);
          continue;
        }
      }
    }

    throw new Error(`${context}: ${lastError?.message || String(lastError)}`);
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

  async #startFreshRepl() {
    this.stdout = "";
    this.stdoutDecoder = new TextDecoder();
    await this.writeCommand(COMMAND.STOP_USER_PROGRAM, undefined, "stop current program");
    await this.#waitForProgramRunning(false, 3000);
    await this.#startRepl();

    if (!(await this.#waitForReplRunning(5000))) {
      throw new Error(`REPL did not start. ${this.#statusPreview()}`);
    }
  }

  async #readHubInfo() {
    const defaults = {
      name: this.device?.name || "Pybricks Hub",
      firmwareVersion: "-",
      profileVersion: "-",
      batteryLevel: null,
      batteryPercent: null,
      batteryVoltageMv: null,
      batteryText: null,
      pnpId: null
    };

    try {
      const service = await this.server.getPrimaryService(DEVICE_INFORMATION_SERVICE_UUID);
      const batteryLevelPromise = this.#readBatteryLevel().catch(() => defaults.batteryLevel);
      const [firmwareVersion, profileVersion, pnpId] = await Promise.all([
        this.#readTextCharacteristic(service, FIRMWARE_REVISION_UUID).catch(() => defaults.firmwareVersion),
        this.#readTextCharacteristic(service, SOFTWARE_REVISION_UUID).catch(() => defaults.profileVersion),
        this.#readDataCharacteristic(service, PNP_ID_UUID).then(parsePnpId).catch(() => defaults.pnpId)
      ]);
      const batteryLevel = await batteryLevelPromise;

      return {
        ...defaults,
        firmwareVersion,
        profileVersion,
        batteryLevel,
        batteryPercent: Number.isFinite(batteryLevel) ? batteryLevel : null,
        batteryText: formatBatteryPercent(batteryLevel),
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

  async #readBatteryLevel() {
    const service = await this.server.getPrimaryService(BATTERY_SERVICE_UUID);
    const value = await this.#readDataCharacteristic(service, BATTERY_LEVEL_UUID);
    const level = value.byteLength ? value.getUint8(0) : null;

    return Number.isFinite(level) ? Math.max(0, Math.min(100, level)) : null;
  }

  async #runScanCommand(command, context, nonce, expectedPorts, writeOptions) {
    this.stdout = "";
    const controller = new AbortController();
    const resultPromise = this.#waitForScan(nonce, 20000, expectedPorts, controller.signal, {
      allowPartialOnTimeout: writeOptions.allowPartialOnTimeout !== false
    });

    try {
      await this.writeStdin(command, context, writeOptions);
      return await resultPromise;
    } catch (error) {
      controller.abort();
      await resultPromise.catch(() => {});
      throw error;
    }
  }

  #waitForScan(nonce, timeoutMs, expectedPorts = [], signal = null, options = {}) {
    const allowPartialOnTimeout = options.allowPartialOnTimeout ?? true;
    const hasExpectedPorts = (ports) =>
      expectedPorts.length > 0 && expectedPorts.every((port) => ports.some((result) => result.port === port));

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Port scan cancelled."));
        return;
      }

      const timeoutId = window.setTimeout(() => {
        cleanup();
        const partial = parseScanOutput(this.stdout, nonce);
        this.#applyScanMetadata(partial);

        if (partial.ports.length && allowPartialOnTimeout) {
          resolve(partial.ports);
          return;
        }

        const output = this.#stdoutPreview();
        reject(
          new Error(
            output
              ? `Timed out waiting for port scan output. Last hub output: ${output}`
              : "Timed out waiting for port scan output. REPL did not return stdout."
          )
        );
      }, timeoutMs);

      const onStdout = () => {
        const result = parseScanOutput(this.stdout, nonce);

        if (result.complete || hasExpectedPorts(result.ports)) {
          cleanup();
          this.#applyScanMetadata(result);
          if (!result.ports.length) {
            reject(new Error(`Port scan completed without port rows. Last hub output: ${this.#stdoutPreview()}`));
            return;
          }
          resolve(result.ports);
        }
      };

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        this.removeEventListener("stdout", onStdout);
        signal?.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        cleanup();
        reject(new Error("Port scan cancelled."));
      };

      this.addEventListener("stdout", onStdout);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #waitForMotorSweep(nonce, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        const result = parseMotorSweepOutput(this.stdout, nonce);

        if (result.points.length) {
          resolve(result);
          return;
        }

        reject(new Error(`Timed out waiting for motor test output. Last hub output: ${this.#stdoutPreview() || "none"}`));
      }, timeoutMs);

      const onStdout = () => {
        const result = parseMotorSweepOutput(this.stdout, nonce);

        if (!result.complete) {
          return;
        }

        cleanup();

        if (result.error) {
          reject(new Error(`Motor test failed: ${result.error}`));
          return;
        }

        if (!result.points.length) {
          reject(new Error(`Motor test completed without data. Last hub output: ${this.#stdoutPreview() || "none"}`));
          return;
        }

        resolve(result);
      };

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        this.removeEventListener("stdout", onStdout);
      };

      this.addEventListener("stdout", onStdout);
    });
  }

  #applyScanMetadata(result) {
    if (!this.info || result.battery?.status !== "voltage") {
      return;
    }

    this.info.batteryVoltageMv = result.battery.voltageMv;
    this.info.batteryPercent = Number.isFinite(this.info.batteryLevel)
      ? this.info.batteryLevel
      : estimateBatteryPercentFromVoltage(result.battery.voltageMv, this.info.model);
    this.info.batteryText = formatBatteryPercent(this.info.batteryPercent);
  }

  #waitForStdout(predicate, timeoutMs) {
    if (predicate(this.stdout)) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const onStdout = () => {
        if (predicate(this.stdout)) {
          cleanup();
          resolve(true);
        }
      };

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        this.removeEventListener("stdout", onStdout);
      };

      this.addEventListener("stdout", onStdout);
    });
  }

  #stdoutPreview() {
    return this.stdout.replace(/\s+/g, " ").trim().slice(-180);
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

  #waitForReplRunning(timeoutMs) {
    const protocol = parseSemver(this.info?.profileVersion);
    const shouldReportBuiltinRepl = usesBuiltinRepl(protocol);
    const isReplRunning = () =>
      this.#isUserProgramRunning() && (!shouldReportBuiltinRepl || this.runningProgramId === BUILTIN_PROGRAM.REPL);

    if (this.hasStatusReport && isReplRunning()) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const onStatus = () => {
        if (isReplRunning()) {
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
    this.#recordEventTrace(view);

    if (eventType === EVENT.STATUS_REPORT && view.byteLength >= 5) {
      this.statusFlags = view.getUint32(1, true);
      this.hasStatusReport = true;
      this.statusReportCount += 1;
      this.runningProgramId = view.byteLength > 5 ? view.getUint8(5) : 0;
      this.selectedSlot = view.byteLength > 6 ? view.getUint8(6) : 0;
      this.dispatchEvent(
        new CustomEvent("status", {
          detail: {
            flags: this.statusFlags,
            userProgramRunning: Boolean(this.statusFlags & STATUS.USER_PROGRAM_RUNNING),
            runningProgramId: this.runningProgramId,
            selectedSlot: this.selectedSlot
          }
        })
      );
      return;
    }

    if (eventType === EVENT.WRITE_STDOUT && view.byteLength > 1) {
      const text = this.stdoutDecoder.decode(dataViewToBytes(view, 1), { stream: true });
      this.stdout += text;
      this.dispatchEvent(new CustomEvent("stdout", { detail: text }));
      this.#handleLiveStdout(text);

      if (this.liveNonce && this.stdout.length > 12000) {
        this.stdout = this.stdout.slice(-6000);
      }
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
    this.statusReportCount = 0;
    this.runningProgramId = 0;
    this.selectedSlot = 0;
    this.eventTrace = [];
    this.liveNonce = null;
    this.liveBuffer = "";
    this.liveRunning = false;
  }

  #statusPreview() {
    if (!this.hasStatusReport) {
      return "No status report received from notifications.";
    }

    return `Status reports: ${this.statusReportCount}, flags: 0x${this.statusFlags.toString(
      16
    )}, runningProgramId: ${this.runningProgramId}, selectedSlot: ${this.selectedSlot}.`;
  }

  #recordEventTrace(view) {
    const bytes = dataViewToBytes(view, 0);
    const hex = [...bytes.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
    this.eventTrace.push(`t=${view.getUint8(0)} len=${view.byteLength} [${hex}]`);

    if (this.eventTrace.length > 12) {
      this.eventTrace.shift();
    }
  }

  #eventTracePreview() {
    return this.eventTrace.length ? this.eventTrace.join(" | ") : "none";
  }

  #handleLiveStdout(text) {
    if (!this.liveNonce || !text) {
      return;
    }

    this.liveBuffer += text;

    const lastLineBreak = Math.max(this.liveBuffer.lastIndexOf("\n"), this.liveBuffer.lastIndexOf("\r"));

    if (lastLineBreak < 0) {
      if (this.liveBuffer.length > 1200) {
        this.liveBuffer = this.liveBuffer.slice(-600);
      }
      return;
    }

    const completed = this.liveBuffer.slice(0, lastLineBreak + 1);
    this.liveBuffer = this.liveBuffer.slice(lastLineBreak + 1);

    const result = parseLiveOutput(completed, this.liveNonce);

    if (!result.values.length && !Object.keys(result.imu).length) {
      return;
    }

    this.dispatchEvent(
      new CustomEvent("live", {
        detail: {
          nonce: this.liveNonce,
          imu: result.imu,
          values: result.values
        }
      })
    );
  }
}
