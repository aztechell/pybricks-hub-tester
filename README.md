# Pybricks Hub Tester

Browser dashboard for Pybricks hubs. It connects over Web Bluetooth, scans hub ports, shows connected LEGO Powered Up / SPIKE devices, streams live values, and includes a motor DC sweep test.

## Features

- Web Bluetooth connection to Pybricks firmware hubs.
- Hub model, firmware, profile, battery, voltage, current, and IMU readouts.
- Port dashboard for 2, 4, and 6 port hubs.
- Device detection for known Powered Up / SPIKE motors and sensors.
- Live values for motors, force sensor, ultrasonic sensor, color sensor, and color distance sensor.
- Per-port value mode selector, including angle, speed, force, pressed, distance, reflection, ambient, HSV, RGB, and color where supported.
- Motor Test tab with DC step selection, DC to RPM chart, DC to hub-current chart, startup duty, max RPM, peak acceleration, backlash, progress bar, and PNG export.
- Local BLE diagnostic script for debugging Pybricks GATT, REPL, PortView, and port scan behavior outside the browser.

## Compatibility

- Requires a hub running Pybricks firmware.
- Requires a browser with Web Bluetooth support, usually Chrome or Edge.
- Requires a secure context. `localhost` works for local development, GitHub Pages works over HTTPS.
- Port scanning and live values use the Pybricks REPL and interrupt the current hub program.
- Live dashboard keeps a monitor program running on the hub while connected.
- Motor Test drives the selected motor through positive and negative duty cycles. Use it only when the mechanism can move safely.

## Run Locally

```powershell
npm start
```

Open:

```text
http://localhost:4173
```

## GitHub Pages

The app is static and can run from GitHub Pages:

```text
https://aztechell.github.io/pybricks-hub-tester/
```

If the page looks mixed after an update, hard refresh the browser tab. The app also uses static asset version query strings to reduce stale-cache issues.

## Test

```powershell
npm test
node --check src\main.js
node --check src\pybricks.js
node --check src\parser.js
```

## BLE Diagnostics

The browser UI is the main app. For lower-level debugging, use the Python diagnostic script:

```powershell
python scripts\diagnose_hub.py --verbose
python scripts\diagnose_hub.py --port-view --verbose
```

Diagnostic traces are written to `diagnostics/`, which is ignored by Git.

## Notes

- Battery percent is estimated from available hub battery data and voltage curves when the standard battery service does not provide a direct percent.
- Current shown in the dashboard is hub battery current. Motor Test current chart uses hub current delta, not a separate inline motor current sensor.
- Ambient light mode on color sensors is read only when selected, because it changes the sensor illumination behavior.
