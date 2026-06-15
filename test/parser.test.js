import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deviceNameForId,
  estimateBatteryPercentFromVoltage,
  liveModesForDeviceId,
  makeInitialPorts,
  motorDistanceToDegrees,
  parseHubCapabilities,
  parseLiveOutput,
  parseMotorControlOutput,
  parseMotorSweepProgress,
  parseMotorSweepOutput,
  parsePnpId,
  parseScanOutput,
  parseSemver,
  resolveHubModel,
  supportsWriteStdin,
  usesBuiltinRepl
} from "../src/parser.js";

describe("parser", () => {
  it("parses Pybricks scan output for a nonce", () => {
    const output = [
      ">>> exec('echo text that should be ignored')",
      "PBHT_BEGIN:abc123",
      "PBHT_PORT:abc123:A:device:48",
      "PBHT_PORT:abc123:B:empty:",
      "PBHT_PORT:abc123:C:error:19",
      "PBHT_PORT:other:D:device:49",
      "PBHT_END:abc123"
    ].join("\r\n");

    const result = parseScanOutput(output, "abc123");

    assert.equal(result.started, true);
    assert.equal(result.complete, true);
    assert.deepEqual(result.ports, [
      {
        port: "A",
        status: "device",
        deviceId: 48,
        deviceName: "SPIKE Medium Angular Motor"
      },
      {
        port: "B",
        status: "empty"
      },
      {
        port: "C",
        status: "error",
        error: "19"
      }
    ]);
  });

  it("maps unknown device IDs without dropping them", () => {
    assert.equal(deviceNameForId(999), "Unknown #999");
  });

  it("parses compact raw REPL scan output", () => {
    const output = ["raw REPL; CTRL-B to exit", "P:n7:A:D:48", "P:n7:B:E:", "P:n7:C:X:ValueError", "X:n7"].join("\n");

    const result = parseScanOutput(output, "n7");

    assert.equal(result.complete, true);
    assert.deepEqual(result.ports, [
      {
        port: "A",
        status: "device",
        deviceId: 48,
        deviceName: "SPIKE Medium Angular Motor"
      },
      {
        port: "B",
        status: "empty"
      },
      {
        port: "C",
        status: "error",
        error: "ValueError"
      }
    ]);
  });

  it("keeps compact port rows even before the terminator arrives", () => {
    const output = [
      '("P:f72:%s:D:%s"%(n,i))',
      "=== except OSError:print(\"P:f72:%s:E:\"%n)",
      "B:f72:V:8123",
      "P:f72:A:E:",
      "P:f72:B:E:"
    ].join("\r\n");

    const result = parseScanOutput(output, "f72");

    assert.equal(result.complete, false);
    assert.deepEqual(result.battery, {
      status: "voltage",
      voltageMv: 8123
    });
    assert.deepEqual(result.ports, [
      {
        port: "A",
        status: "empty"
      },
      {
        port: "B",
        status: "empty"
      }
    ]);
  });

  it("checks profile support", () => {
    assert.equal(supportsWriteStdin("1.2.0"), false);
    assert.equal(supportsWriteStdin("1.3.0"), true);
    assert.equal(usesBuiltinRepl("1.3.0"), false);
    assert.equal(usesBuiltinRepl("1.4.0"), true);
    assert.deepEqual(parseSemver("1.5.0b2"), {
      major: 1,
      minor: 5,
      patch: 0,
      raw: "1.5.0b2"
    });
  });

  it("parses little-endian hub capability data", () => {
    const data = new Uint8Array([
      0x84, 0x00,
      0x09, 0x00, 0x00, 0x00,
      0x00, 0x04, 0x00, 0x00,
      0x05
    ]);

    assert.deepEqual(parseHubCapabilities(data), {
      maxWriteSize: 132,
      featureFlags: 9,
      maxUserProgramSize: 1024,
      numSlots: 5
    });
  });

  it("parses PnP ID data", () => {
    const data = new Uint8Array([0x01, 0x97, 0x03, 0x41, 0x00, 0x02, 0x00]);

    assert.deepEqual(parsePnpId(data), {
      vendorIdSource: 1,
      vendorIdSourceName: "Bluetooth",
      vendorId: 919,
      productId: 65,
      productVersion: 2
    });
  });

  it("resolves hub models and real ports from PnP product IDs", () => {
    assert.deepEqual(resolveHubModel({ productId: 128 }).ports, ["A", "B", "C", "D"]);
    assert.deepEqual(resolveHubModel({ productId: 128 }).portRows, [["A", "B"], ["C", "D"]]);
    assert.equal(resolveHubModel({ productId: 129, productVersion: 1 }).name, "Inventor Hub");
    assert.deepEqual(makeInitialPorts("unavailable", resolveHubModel({ productId: 65 }).ports), [
      { port: "A", status: "unavailable" },
      { port: "B", status: "unavailable" }
    ]);
  });

  it("parses live monitor values for a nonce", () => {
    const output = [
      "I:live1:voltage:7790",
      "I:live1:current:-120",
      "I:live1:yaw:-39",
      "I:live1:pitch:0",
      "I:live1:roll:2",
      "L:live1:B:angle:350",
      "L:other:A:angle:999",
      "L:live1:A:force:0.5",
      "L:live1:B:speed:12",
      "L:live1:C:color:BLUE",
      "L:live1:C:distance:70",
      "L:live1:C:hsv:240,80,70",
      "L:live1:C:ambient:14",
      "L:live1:C:reflection:55"
    ].join("\n");

    const result = parseLiveOutput(output, "live1");

    assert.deepEqual(result.imu, {
      voltage: "7790",
      current: "-120",
      yaw: "-39",
      pitch: "0",
      roll: "2"
    });
    assert.deepEqual(result.values, [
      {
        port: "A",
        mode: "force",
        status: "value",
        value: "0.5",
        error: null
      },
      {
        port: "B",
        mode: "angle",
        status: "value",
        value: "350",
        error: null
      },
      {
        port: "B",
        mode: "speed",
        status: "value",
        value: "12",
        error: null
      },
      {
        port: "C",
        mode: "distance",
        status: "value",
        value: "70",
        error: null
      },
      {
        port: "C",
        mode: "reflection",
        status: "value",
        value: "55",
        error: null
      },
      {
        port: "C",
        mode: "ambient",
        status: "value",
        value: "14",
        error: null
      },
      {
        port: "C",
        mode: "hsv",
        status: "value",
        value: "240,80,70",
        error: null
      },
      {
        port: "C",
        mode: "color",
        status: "value",
        value: "BLUE",
        error: null
      }
    ]);
  });

  it("keeps the latest live value per port and mode", () => {
    const output = ["L:n:A:angle:100", "L:n:A:speed:4", "L:n:A:angle:105"].join("\n");

    assert.deepEqual(parseLiveOutput(output, "n").values, [
      {
        port: "A",
        mode: "angle",
        status: "value",
        value: "105",
        error: null
      },
      {
        port: "A",
        mode: "speed",
        status: "value",
        value: "4",
        error: null
      }
    ]);
  });

  it("parses live monitor errors", () => {
    assert.deepEqual(parseLiveOutput("L:n:D:error:OSError", "n").values, [
      {
        port: "D",
        mode: "error",
        status: "error",
        value: "OSError",
        error: "OSError"
      }
    ]);
  });

  it("estimates battery percent from voltage by hub profile", () => {
    assert.equal(estimateBatteryPercentFromVoltage(7800, { id: 129 }), 82);
    assert.equal(estimateBatteryPercentFromVoltage(8400, { id: 129 }), 100);
    assert.equal(estimateBatteryPercentFromVoltage(7800, { id: 128 }), 55);
    assert.equal(estimateBatteryPercentFromVoltage(Number.NaN, { id: 129 }), null);
  });

  it("parses motor dc sweep output", () => {
    const output = [
      "MT:m1:0:0:100:0",
      "MT:m1:50:720:430:330",
      "MT:other:100:999:999:999",
      "MT:m1:-50:-600:410:310",
      "MB:m1:2.5:N",
      "MX:m1"
    ].join("\n");

    assert.deepEqual(parseMotorSweepOutput(output, "m1"), {
      complete: true,
      error: null,
      points: [
        {
          dc: 0,
          speedDegPerSecond: 0,
          rpm: 0,
          hubCurrentMa: 100,
          currentMa: 0
        },
        {
          dc: 50,
          speedDegPerSecond: 720,
          rpm: 120,
          hubCurrentMa: 430,
          currentMa: 330
        },
        {
          dc: -50,
          speedDegPerSecond: -600,
          rpm: -100,
          hubCurrentMa: 410,
          currentMa: 310
        }
      ],
      metrics: {
        backlash: {
          positiveDeg: 2.5,
          negativeDeg: null,
          status: "ok",
          error: null
        }
      }
    });
  });

  it("keeps old motor dc sweep rows without current data", () => {
    assert.deepEqual(parseMotorSweepOutput("MT:m1:50:720\nMX:m1", "m1"), {
      complete: true,
      error: null,
      points: [
        {
          dc: 50,
          speedDegPerSecond: 720,
          rpm: 120
        }
      ],
      metrics: {
        backlash: {
          positiveDeg: null,
          negativeDeg: null,
          status: "not_run",
          error: null
        }
      }
    });
  });

  it("parses motor dc sweep errors", () => {
    assert.deepEqual(parseMotorSweepOutput("ME:m1:OSError\nMX:m1", "m1"), {
      complete: true,
      error: "OSError",
      points: [],
      metrics: {
        backlash: {
          positiveDeg: null,
          negativeDeg: null,
          status: "not_run",
          error: null
        }
      }
    });
  });

  it("parses motor backlash probe errors", () => {
    assert.deepEqual(parseMotorSweepOutput("MB:m1:XOSError:N\nMX:m1", "m1").metrics, {
      backlash: {
        positiveDeg: null,
        negativeDeg: null,
        status: "error",
        error: "OSError"
      }
    });
  });

  it("exposes color distance sensor distance mode", () => {
    assert.deepEqual(liveModesForDeviceId(37), ["reflection", "distance", "ambient", "hsv", "rgb", "color"]);
  });

  it("parses motor sweep progress", () => {
    assert.deepEqual(parseMotorSweepProgress("MT:m1:0:0\nMT:m1:10:60", "m1", 4), {
      phase: "sweeping",
      percent: 45,
      pointsDone: 2,
      pointsTotal: 4,
      complete: false,
      error: null,
      partialResult: {
        complete: false,
        error: null,
        points: [
          {
            dc: 0,
            speedDegPerSecond: 0,
            rpm: 0
          },
          {
            dc: 10,
            speedDegPerSecond: 60,
            rpm: 10
          }
        ],
        metrics: {
          backlash: {
            positiveDeg: null,
            negativeDeg: null,
            status: "not_run",
            error: null
          }
        }
      }
    });
    assert.equal(parseMotorSweepProgress("MT:m1:0:0\nMT:m1:10:60\nMB:m1:N:N", "m1", 4).phase, "backlash");
    assert.equal(parseMotorSweepProgress("MT:m1:0:0\nMX:m1", "m1", 4).percent, 100);
  });

  it("does not treat partial motor sweep output as complete", () => {
    const output = "MT:m1:0:0\nMT:m1:10:60";
    const result = parseMotorSweepOutput(output, "m1");

    assert.equal(result.complete, false);
    assert.equal(parseMotorSweepProgress(output, "m1", 2).phase, "backlash");
  });

  it("parses motor control success output", () => {
    assert.deepEqual(parseMotorControlOutput("MC:c1:OK:90:0:0", "c1"), {
      complete: true,
      status: "ok",
      error: null,
      angle: 90,
      speed: 0,
      stalled: false
    });
  });

  it("parses motor control error output", () => {
    assert.deepEqual(parseMotorControlOutput("MC:c1:ERR:OSError", "c1"), {
      complete: true,
      status: "error",
      error: "OSError",
      angle: null,
      speed: null,
      stalled: null
    });
  });

  it("ignores motor control output for another nonce", () => {
    assert.deepEqual(parseMotorControlOutput("MC:other:OK:90:0:0", "c1"), {
      complete: false,
      status: null,
      error: null,
      angle: null,
      speed: null,
      stalled: null
    });
  });

  it("converts wheel travel to motor degrees", () => {
    const circumferenceMm = Math.PI * 56;

    assert.ok(Math.abs(motorDistanceToDegrees({
      distance: circumferenceMm / 10,
      distanceUnit: "cm",
      wheelDiameterMm: 56,
      gearRatio: 1
    }) - 360) < 0.000001);
    assert.ok(Math.abs(motorDistanceToDegrees({
      distance: circumferenceMm,
      distanceUnit: "mm",
      wheelDiameterMm: 56,
      gearRatio: 3
    }) - 1080) < 0.000001);
  });
});
