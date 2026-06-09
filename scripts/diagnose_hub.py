#!/usr/bin/env python
"""Pybricks BLE diagnostic runner.

This script bypasses the browser and talks directly to the Pybricks GATT
service. It is intentionally verbose so we can see whether the hub starts the
built-in REPL and whether WRITE_STDOUT notifications are delivered.
"""

from __future__ import annotations

import argparse
import asyncio
import codecs
import json
import secrets
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    from bleak import BleakClient, BleakScanner
except ImportError as exc:  # pragma: no cover - exercised manually
    raise SystemExit(
        "Missing dependency: bleak. Run .\\.venv\\Scripts\\python.exe -m pip install bleak"
    ) from exc


PYBRICKS_SERVICE_UUID = "c5f50001-8280-46da-89f4-6d8051e4aeef"
PYBRICKS_COMMAND_EVENT_UUID = "c5f50002-8280-46da-89f4-6d8051e4aeef"
PYBRICKS_HUB_CAPABILITIES_UUID = "c5f50003-8280-46da-89f4-6d8051e4aeef"
DEVICE_INFORMATION_SERVICE_UUID = "0000180a-0000-1000-8000-00805f9b34fb"
FIRMWARE_REVISION_UUID = "00002a26-0000-1000-8000-00805f9b34fb"
SOFTWARE_REVISION_UUID = "00002a28-0000-1000-8000-00805f9b34fb"
PNP_ID_UUID = "00002a50-0000-1000-8000-00805f9b34fb"

COMMAND_STOP_USER_PROGRAM = 0
COMMAND_START_USER_PROGRAM = 1
COMMAND_START_REPL = 2
COMMAND_WRITE_STDIN = 6
BUILTIN_REPL = 0x80
BUILTIN_PORT_VIEW = 0x81

EVENT_STATUS_REPORT = 0
EVENT_WRITE_STDOUT = 1
EVENT_WRITE_APP_DATA = 2

STATUS_USER_PROGRAM_RUNNING = 1 << 6
HUB_CAPABILITY_HAS_PORT_VIEW = 1 << 3

HUB_MODELS = {
    64: "BOOST Move Hub",
    65: "City Hub",
    128: "Technic Hub",
    129: "Prime/Inventor Hub",
    131: "Essential Hub",
}


@dataclass
class HubInfo:
    name: str
    firmware: str | None
    profile: str | None
    product_id: int | None
    product_version: int | None
    capabilities: dict[str, Any]

    @property
    def model(self) -> str:
        if self.product_id is None:
            return "Unknown Pybricks Hub"
        return HUB_MODELS.get(self.product_id, f"Unknown product {self.product_id}")


class DiagnosticError(Exception):
    def __init__(self, result: str, message: str):
        super().__init__(message)
        self.result = result


class DiagnosticLogger:
    def __init__(self, root: Path, verbose: bool):
        root.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.jsonl_path = root / f"diagnose-{stamp}.jsonl"
        self.text_path = root / f"diagnose-{stamp}.txt"
        self.verbose = verbose
        self._jsonl = self.jsonl_path.open("w", encoding="utf-8")
        self._text = self.text_path.open("w", encoding="utf-8")

    def close(self) -> None:
        self._jsonl.close()
        self._text.close()

    def log(self, kind: str, message: str, **fields: Any) -> None:
        record = {
            "time": datetime.now().isoformat(timespec="milliseconds"),
            "kind": kind,
            "message": message,
            **fields,
        }
        self._jsonl.write(json.dumps(record, ensure_ascii=True) + "\n")
        self._jsonl.flush()
        line = f"[{record['time']}] {kind}: {message}"
        if fields:
            line += " " + json.dumps(fields, ensure_ascii=True)
        self._text.write(line + "\n")
        self._text.flush()
        if self.verbose or kind in {"result", "error", "hub", "stage"}:
            print(line, flush=True)


class PybricksDiagnostic:
    def __init__(self, args: argparse.Namespace, logger: DiagnosticLogger):
        self.args = args
        self.log = logger
        self.client: BleakClient | None = None
        self.info: HubInfo | None = None
        self.max_write_size = 20
        self.stdout_decoder = codecs.getincrementaldecoder("utf-8")()
        self.stdout_text = ""
        self.app_data_events: list[bytes] = []
        self.events: list[dict[str, Any]] = []
        self.status_flags = 0
        self.status_report_count = 0
        self.running_program_id = 0
        self.selected_slot = 0

    async def run(self) -> str:
        devices = await self.find_devices()
        last_error = None

        for index, device in enumerate(devices, start=1):
            name = self.device_name(device) or "Pybricks Hub"
            address = self.device_address(device)
            self.log.log(
                "stage",
                f"Connecting to {name}",
                address=address,
                candidate=f"{index}/{len(devices)}",
            )

            try:
                async with BleakClient(device, timeout=self.args.connect_timeout) as client:
                    self.client = client
                    self.info = await self.read_hub_info(name)
                    self.print_hub_info(self.info)
                    await self.subscribe_notifications()
                    if self.args.port_view:
                        return await self.run_port_view_diagnostics()
                    return await self.run_repl_diagnostics()
            except DiagnosticError:
                raise
            except Exception as exc:
                last_error = exc
                self.log.log("probe", "candidate did not expose Pybricks GATT", address=address, error=str(exc))
            finally:
                self.client = None

        detail = f" Last error: {last_error}" if last_error else ""
        raise DiagnosticError("no hub", f"No matching Pybricks hub found.{detail}")

    async def find_devices(self) -> list[Any]:
        if self.args.address:
            self.log.log("stage", f"Looking up BLE address {self.args.address}")
            device = await BleakScanner.find_device_by_address(self.args.address, timeout=self.args.timeout)
            if device:
                return [device]

            self.log.log("scan", "address not seen during scan; trying direct address", address=self.args.address)
            return [self.args.address]

        self.log.log("stage", f"Scanning for Pybricks hubs for {self.args.timeout}s")
        devices = []

        try:
            discovered = await BleakScanner.discover(timeout=self.args.timeout, return_adv=True)
            for device, adv in discovered.values():
                devices.append((device, adv))
        except TypeError:
            for device in await BleakScanner.discover(timeout=self.args.timeout):
                devices.append((device, None))

        matches = []
        probe_candidates = []
        for device, adv in devices:
            name = device.name or getattr(adv, "local_name", None) or ""
            service_uuids = [str(uuid).lower() for uuid in getattr(adv, "service_uuids", [])] if adv else []
            service_data = {
                str(uuid).lower(): bytes(value).hex(" ")
                for uuid, value in (getattr(adv, "service_data", {}) or {}).items()
            }
            manufacturer_data = {
                str(company_id): bytes(value).hex(" ")
                for company_id, value in (getattr(adv, "manufacturer_data", {}) or {}).items()
            }
            has_service = PYBRICKS_SERVICE_UUID in service_uuids
            name_matches = not self.args.name or self.args.name.lower() in name.lower()

            self.log.log(
                "scan",
                name or "(unnamed)",
                address=device.address,
                has_pybricks_service=has_service,
                services=service_uuids,
                service_data=service_data,
                manufacturer_data=manufacturer_data,
            )

            if name_matches and (has_service or self.args.name):
                matches.append(device)

            likely_name = any(token in name.lower() for token in ("pybricks", "technic", "lego", "hub"))
            has_advertising_data = bool(name or service_uuids or service_data or manufacturer_data)
            if self.args.probe_candidates:
                if has_service:
                    rank = 0
                elif likely_name:
                    rank = 1
                elif has_advertising_data:
                    rank = 2
                else:
                    rank = 3
                probe_candidates.append((rank, device))

        if matches:
            return matches

        if self.args.probe_candidates and probe_candidates:
            deduped = {}
            for rank, device in sorted(probe_candidates, key=lambda item: item[0]):
                deduped.setdefault(device.address, (rank, device))
            ordered = [device for _, device in deduped.values()]
            self.log.log("stage", f"Probing {len(ordered)} BLE candidates without Pybricks advertising")
            return ordered

        if not matches:
            raise DiagnosticError(
                "no hub",
                "No matching Pybricks hub found. Try --name, --address, or --probe-candidates.",
            )

        return matches

    @staticmethod
    def device_name(device: Any) -> str | None:
        return getattr(device, "name", None) if not isinstance(device, str) else None

    @staticmethod
    def device_address(device: Any) -> str:
        return getattr(device, "address", None) or str(device)

    async def read_hub_info(self, fallback_name: str) -> HubInfo:
        assert self.client
        firmware = await self.read_text(FIRMWARE_REVISION_UUID)
        profile = await self.read_text(SOFTWARE_REVISION_UUID)
        product_id = None
        product_version = None
        pnp = await self.read_bytes(PNP_ID_UUID)

        if pnp and len(pnp) >= 7:
            product_id = int.from_bytes(pnp[3:5], "little")
            product_version = int.from_bytes(pnp[5:7], "little")

        capabilities = {}
        caps = await self.read_bytes(PYBRICKS_HUB_CAPABILITIES_UUID)
        if caps and len(caps) >= 10:
            self.max_write_size = int.from_bytes(caps[0:2], "little")
            capabilities = {
                "max_write_size": self.max_write_size,
                "flags": int.from_bytes(caps[2:6], "little"),
                "max_user_program_size": int.from_bytes(caps[6:10], "little"),
                "num_slots": caps[10] if len(caps) > 10 else None,
            }
        else:
            capabilities = {"max_write_size": self.max_write_size}

        return HubInfo(fallback_name, firmware, profile, product_id, product_version, capabilities)

    async def read_text(self, uuid: str) -> str | None:
        data = await self.read_bytes(uuid)
        return data.decode("utf-8", errors="replace") if data else None

    async def read_bytes(self, uuid: str) -> bytes | None:
        assert self.client
        try:
            data = bytes(await self.client.read_gatt_char(uuid))
            self.log.log("read", uuid, hex=data.hex(" "))
            return data
        except Exception as exc:
            self.log.log("read", f"{uuid} failed", error=str(exc))
            return None

    def print_hub_info(self, info: HubInfo) -> None:
        self.log.log(
            "hub",
            info.model,
            name=info.name,
            firmware=info.firmware,
            profile=info.profile,
            product_id=info.product_id,
            product_version=info.product_version,
            capabilities=info.capabilities,
        )

    async def subscribe_notifications(self) -> None:
        assert self.client
        try:
            await self.client.stop_notify(PYBRICKS_COMMAND_EVENT_UUID)
            self.log.log("notify", "stop_notify before start_notify succeeded")
        except Exception as exc:
            self.log.log("notify", "stop_notify before start_notify ignored", error=str(exc))

        await self.client.start_notify(PYBRICKS_COMMAND_EVENT_UUID, self.handle_notification)
        self.log.log("notify", "start_notify succeeded")

    def handle_notification(self, _sender: Any, data: bytearray) -> None:
        payload = bytes(data)
        if not payload:
            return

        event_type = payload[0]
        record: dict[str, Any] = {
            "event_type": event_type,
            "length": len(payload),
            "hex": payload.hex(" "),
        }

        if event_type == EVENT_STATUS_REPORT and len(payload) >= 5:
            self.status_flags = int.from_bytes(payload[1:5], "little")
            self.status_report_count += 1
            self.running_program_id = payload[5] if len(payload) > 5 else 0
            self.selected_slot = payload[6] if len(payload) > 6 else 0
            record.update(
                flags=self.status_flags,
                user_program_running=bool(self.status_flags & STATUS_USER_PROGRAM_RUNNING),
                running_program_id=self.running_program_id,
                selected_slot=self.selected_slot,
            )
            message = "status"
        elif event_type == EVENT_WRITE_STDOUT:
            text = self.stdout_decoder.decode(payload[1:], final=False)
            self.stdout_text += text
            record.update(text=text)
            message = "stdout"
        elif event_type == EVENT_WRITE_APP_DATA:
            self.app_data_events.append(payload[1:])
            record.update(app_data_hex=payload[1:].hex(" "))
            message = "appdata"
        else:
            message = "unknown"

        self.events.append(record)
        if len(self.events) > 100:
            self.events.pop(0)

        self.log.log("event", message, **record)

    async def run_repl_diagnostics(self) -> str:
        await self.write_command(COMMAND_STOP_USER_PROGRAM, context="STOP_USER_PROGRAM")
        await self.wait_for(lambda: not self.user_program_running(), 3)

        await self.start_repl()

        did_start = await self.wait_for(
            lambda: self.user_program_running() and self.running_program_id == BUILTIN_REPL,
            8,
        )
        if not did_start:
            raise DiagnosticError("REPL not started", self.status_summary())

        self.log.log("stage", "REPL status reached runningProgramId=128", status=self.status_summary())

        if await self.friendly_probe():
            ports = await self.scan_ports_friendly()
            self.log.log("result", "ports detected", ports=ports, mode="friendly")
            return "ports detected"

        if await self.raw_probe():
            ports = await self.scan_ports_raw()
            self.log.log("result", "ports detected", ports=ports, mode="raw")
            return "ports detected"

        raise DiagnosticError(
            "stdout missing",
            f"No WRITE_STDOUT event after friendly or raw probe. {self.status_summary()}",
        )

    async def run_port_view_diagnostics(self) -> str:
        if not self.profile_at_least(self.info.profile or "0.0.0", "1.4.0"):
            raise DiagnosticError(
                "portview_unsupported",
                f"Pybricks profile {self.info.profile!r} does not support builtin PortView.",
            )

        flags = int(self.info.capabilities.get("flags", 0)) if self.info else 0
        if not flags & HUB_CAPABILITY_HAS_PORT_VIEW:
            raise DiagnosticError(
                "portview_unsupported",
                f"Hub capabilities do not report HAS_PORT_VIEW. capabilities={self.info.capabilities if self.info else None}",
            )

        self.clear_stdout()
        self.app_data_events.clear()

        try:
            await self.write_command(COMMAND_STOP_USER_PROGRAM, context="STOP_USER_PROGRAM before PortView")
            await self.wait_for(lambda: not self.user_program_running(), 3)

            await self.write_command(
                COMMAND_START_USER_PROGRAM,
                bytes([BUILTIN_PORT_VIEW]),
                context="START_USER_PROGRAM PortView",
            )

            did_start = await self.wait_for(
                lambda: self.user_program_running() and self.running_program_id == BUILTIN_PORT_VIEW,
                self.args.timeout,
            )
            if not did_start:
                if "Port View Placeholder" in self.stdout_text:
                    self.log.log(
                        "result",
                        "portview_placeholder",
                        stdout=self.stdout_preview(),
                        status=self.status_summary(),
                    )
                    return "portview_placeholder"
                raise DiagnosticError("portview_unsupported", f"PortView did not start. {self.status_summary()}")

            self.log.log(
                "stage",
                "PortView status reached runningProgramId=129",
                status=self.status_summary(),
            )
            await self.collect_port_view_events()

            if self.app_data_events:
                self.log.log(
                    "result",
                    "portview_appdata_seen",
                    appdata_count=len(self.app_data_events),
                    first_appdata_hex=self.app_data_events[0].hex(" "),
                    status=self.status_summary(),
                )
                return "portview_appdata_seen"

            if "Port View Placeholder" in self.stdout_text:
                self.log.log(
                    "result",
                    "portview_placeholder",
                    stdout=self.stdout_preview(),
                    status=self.status_summary(),
                )
                return "portview_placeholder"

            self.log.log(
                "result",
                "portview_no_appdata",
                stdout=self.stdout_preview() or "none",
                status=self.status_summary(),
            )
            return "portview_no_appdata"
        finally:
            try:
                await self.write_command(COMMAND_STOP_USER_PROGRAM, context="STOP_USER_PROGRAM after PortView")
                await self.wait_for(lambda: not self.user_program_running(), 3)
            except Exception as exc:
                self.log.log("error", "failed to stop PortView", error=str(exc), status=self.status_summary())

    async def collect_port_view_events(self) -> None:
        deadline = time.monotonic() + self.args.timeout
        last_count = -1

        while time.monotonic() < deadline:
            if len(self.app_data_events) != last_count:
                last_count = len(self.app_data_events)
                self.log.log(
                    "stage",
                    "collecting PortView events",
                    appdata_count=len(self.app_data_events),
                    stdout=self.stdout_preview() or "none",
                )

            await asyncio.sleep(0.05)

    async def start_repl(self) -> None:
        profile = self.info.profile if self.info else None
        if profile and self.profile_at_least(profile, "1.4.0"):
            await self.write_command(
                COMMAND_START_USER_PROGRAM,
                bytes([BUILTIN_REPL]),
                context="START_USER_PROGRAM REPL",
            )
        else:
            await self.write_command(COMMAND_START_REPL, context="START_REPL")

    async def friendly_probe(self) -> bool:
        nonce = self.nonce()
        self.clear_stdout()
        await self.write_stdin("\x03\r", "friendly wake")
        await self.wait_for(lambda: ">>>" in self.stdout_text or "KeyboardInterrupt" in self.stdout_text, 3)
        self.clear_stdout()
        await self.write_stdin(f'print("R:{nonce}")\r', "friendly probe")
        ok = await self.wait_for(lambda: f"R:{nonce}" in self.stdout_text, 5)
        self.log.log("stage", "friendly probe done", ok=ok, stdout=self.stdout_preview())
        return ok

    async def raw_probe(self) -> bool:
        nonce = self.nonce()
        self.clear_stdout()
        await self.write_stdin("\x03\x03\x01", "raw enter")
        entered = await self.wait_for(lambda: "raw REPL" in self.stdout_text, 3)
        self.log.log("stage", "raw enter done", ok=entered, stdout=self.stdout_preview())

        if not entered:
            return False

        self.clear_stdout()
        await self.write_stdin(f'print("R:{nonce}")\x04', "raw probe")
        ok = await self.wait_for(lambda: f"R:{nonce}" in self.stdout_text, 5)
        self.log.log("stage", "raw probe done", ok=ok, stdout=self.stdout_preview())
        await self.write_stdin("\x02", "raw exit")
        return ok

    async def scan_ports_friendly(self) -> list[dict[str, str]]:
        nonce = self.nonce()
        code = self.make_port_scan_code(nonce)
        self.clear_stdout()
        await self.write_stdin("\x05" + code.replace("\n", "\r\n") + "\r\n\x04", "friendly paste scan")
        if not await self.wait_for(lambda: f"X:{nonce}" in self.stdout_text, self.args.timeout):
            raise DiagnosticError("port scan timeout", f"Friendly scan did not finish. stdout={self.stdout_preview()!r}")
        return self.parse_ports(nonce)

    async def scan_ports_raw(self) -> list[dict[str, str]]:
        nonce = self.nonce()
        code = self.make_port_scan_code(nonce)
        self.clear_stdout()
        await self.write_stdin(code + "\x04", "raw scan")
        if not await self.wait_for(lambda: f"X:{nonce}" in self.stdout_text, self.args.timeout):
            raise DiagnosticError("port scan timeout", f"Raw scan did not finish. stdout={self.stdout_preview()!r}")
        await self.write_stdin("\x02", "raw exit")
        return self.parse_ports(nonce)

    def make_port_scan_code(self, nonce: str) -> str:
        port_list = ", ".join(f'"{port}"' for port in self.args.ports)
        hub_class = self.hub_class_name()
        battery_code = (
            f"""from pybricks.hubs import {hub_class} as H
try:h=H();print("B:{nonce}:V:%s"%h.battery.voltage())
except Exception as e:print("B:{nonce}:X:%s"%type(e).__name__)"""
            if hub_class
            else f"""print("B:{nonce}:X:UnknownHub")"""
        )
        return f"""{battery_code}
from pybricks.iodevices import PUPDevice as D
from pybricks.parameters import Port as P
for n in ({port_list},):
    try:i=D(getattr(P,n)).info()["id"];print("P:{nonce}:%s:D:%s"%(n,i))
    except OSError:print("P:{nonce}:%s:E:"%n)
    except Exception as e:print("P:{nonce}:%s:X:%s"%(n,type(e).__name__))
print("X:{nonce}")"""

    def hub_class_name(self) -> str | None:
        product_id = self.info.product_id if self.info else None
        product_version = self.info.product_version if self.info else None

        if product_id == 64:
            return "MoveHub"
        if product_id == 65:
            return "CityHub"
        if product_id == 128:
            return "TechnicHub"
        if product_id == 129:
            return "InventorHub" if product_version == 1 else "PrimeHub"
        if product_id == 131:
            return "EssentialHub"

        return None

    def parse_ports(self, nonce: str) -> list[dict[str, str]]:
        ports = []
        for raw_line in self.stdout_text.splitlines():
            line = "".join(ch for ch in raw_line if ch >= " " or ch in "\t").strip()
            parts = line.split(":")
            if len(parts) >= 4 and parts[0] == "B" and parts[1] == nonce:
                self.log.log("battery", line, status=parts[2], value=parts[3])
                continue
            if len(parts) < 5 or parts[0] != "P" or parts[1] != nonce:
                continue
            _, _, port, status, value = parts[:5]
            ports.append({"port": port, "status": status, "value": value})
        return ports

    async def write_stdin(self, text: str | bytes, context: str) -> None:
        data = text.encode("utf-8") if isinstance(text, str) else text
        chunk_size = min(self.args.chunk_size, max(1, self.max_write_size - 1))

        for offset in range(0, len(data), chunk_size):
            end = min(offset + chunk_size, len(data))
            await self.write_command(
                COMMAND_WRITE_STDIN,
                data[offset:end],
                context=f"{context} ({end}/{len(data)})",
            )
            await asyncio.sleep(self.args.chunk_delay / 1000)

    async def write_command(self, command: int, payload: bytes = b"", context: str = "command") -> None:
        assert self.client
        data = bytes([command]) + payload

        for attempt in range(1, self.args.retries + 1):
            try:
                self.log.log("write", context, command=command, length=len(data), hex=data.hex(" "))
                await self.client.write_gatt_char(PYBRICKS_COMMAND_EVENT_UUID, data, response=True)
                return
            except Exception as exc:
                self.log.log("error", f"{context} failed", attempt=attempt, error=str(exc))
                if attempt == self.args.retries:
                    raise DiagnosticError("GATT write failed", f"{context}: {exc}") from exc
                await asyncio.sleep(0.2 * attempt)

    async def wait_for(self, predicate, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            await asyncio.sleep(0.05)
        return predicate()

    def user_program_running(self) -> bool:
        return bool(self.status_flags & STATUS_USER_PROGRAM_RUNNING)

    def clear_stdout(self) -> None:
        self.stdout_text = ""
        self.stdout_decoder = codecs.getincrementaldecoder("utf-8")()

    def stdout_preview(self) -> str:
        return " ".join(self.stdout_text.split())[-240:]

    def status_summary(self) -> str:
        return (
            f"statusReports={self.status_report_count}, flags=0x{self.status_flags:x}, "
            f"runningProgramId={self.running_program_id}, selectedSlot={self.selected_slot}, "
            f"events={len(self.events)}"
        )

    @staticmethod
    def nonce() -> str:
        return secrets.token_hex(2)

    @staticmethod
    def profile_at_least(value: str, minimum: str) -> bool:
        def parts(text: str) -> tuple[int, int, int]:
            nums = []
            for part in text.split(".")[:3]:
                digits = "".join(ch for ch in part if ch.isdigit())
                nums.append(int(digits or "0"))
            while len(nums) < 3:
                nums.append(0)
            return nums[0], nums[1], nums[2]

        return parts(value) >= parts(minimum)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Diagnose a Pybricks hub over BLE.")
    parser.add_argument("--name", help="Hub name substring to match, e.g. 'Technic hub'.")
    parser.add_argument("--address", help="BLE address to connect directly, e.g. 'AA:BB:CC:DD:EE:FF'.")
    parser.add_argument("--timeout", type=float, default=20, help="Scan and operation timeout in seconds.")
    parser.add_argument("--ports", nargs="+", default=["A", "B", "C", "D", "E", "F"], help="Ports to scan.")
    parser.add_argument("--chunk-size", type=int, default=8, help="WRITE_STDIN payload chunk size.")
    parser.add_argument("--chunk-delay", type=int, default=80, help="Delay between stdin chunks in milliseconds.")
    parser.add_argument("--connect-timeout", type=float, default=8, help="Timeout for each BLE connection attempt.")
    parser.add_argument("--retries", type=int, default=3, help="Retries for each GATT write.")
    parser.add_argument(
        "--port-view",
        action="store_true",
        help="Start builtin PortView (0x81) and collect status/stdout/appdata notifications.",
    )
    parser.add_argument(
        "--probe-candidates",
        action="store_true",
        help="Connect to BLE scan candidates when Pybricks service UUID is not advertised.",
    )
    parser.add_argument("--verbose", action="store_true", help="Print all events and writes.")
    return parser.parse_args()


async def async_main() -> int:
    args = parse_args()
    logger = DiagnosticLogger(Path("diagnostics"), args.verbose)

    try:
        result = await PybricksDiagnostic(args, logger).run()
        logger.log("result", result)
        return 0
    except DiagnosticError as exc:
        logger.log("result", exc.result, error=str(exc))
        return 2
    except Exception as exc:  # pragma: no cover - manual diagnostics
        logger.log("error", "unexpected failure", error=repr(exc))
        return 1
    finally:
        print(f"Logs: {logger.text_path} and {logger.jsonl_path}", flush=True)
        logger.close()


def main() -> int:
    if sys.platform != "win32":
        print("This script was built for the current Windows BLE debugging session.", flush=True)
    return asyncio.run(async_main())


if __name__ == "__main__":
    raise SystemExit(main())
