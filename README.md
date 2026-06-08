# Pybricks Hub Tester

Minimal browser app for connecting to a Pybricks hub over Web Bluetooth and showing attached devices on hub ports.

## Run

```powershell
npm start
```

Open `http://localhost:4173` in Chrome, Edge, or Chromium.

## Test

```powershell
npm test
```

## Notes

- The hub must already run Pybricks firmware.
- Port scanning starts the Pybricks REPL and interrupts the current hub program.
- Web Bluetooth requires a user click and a secure context; `localhost` works.
