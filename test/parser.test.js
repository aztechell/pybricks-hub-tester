import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deviceNameForId,
  makeInitialPorts,
  parseHubCapabilities,
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
});
