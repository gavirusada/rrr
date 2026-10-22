# Rivet

Rivet is an open-source Canon EOS Wi-Fi Live View bridge for OBS.

It connects to a Canon camera over PTP/IP, receives Canon Live View JPEG frames,
and exposes a local MJPEG stream that OBS can ingest as a Browser Source. Rivet
does not install a Windows webcam driver and does not depend on Canon EOS
Webcam Utility Pro.

## Quick Start

1. Put the Canon camera in Wi-Fi smartphone connection mode.
2. Connect Windows to the camera Wi-Fi network.
3. List local IPv4 interfaces:

```bash
bun run dev -- --interfaces
```

4. Start Rivet with the camera IP and the PC Wi-Fi IPv4 address:

```bat
scripts\run-bridge.cmd --camera-ip 192.168.1.2 --local-address <pc-wifi-ip>
```

5. Add this URL to OBS as a Browser Source:

```text
http://127.0.0.1:8787/live.mjpg
```

6. Open the local dashboard:

```text
http://127.0.0.1:8787/
```

## Supported Hardware

Rivet's canonical hardware target is the Canon EOS Rebel T100 / EOS 4000D.

Verified output:

- Transport: Canon Wi-Fi Easy Connection.
- Protocol: PTP/IP command and event channels.
- Live View output: `480x320` MJPEG.
- Observed throughput: 12-16 FPS on the verified Wi-Fi link.
- OBS endpoint: `http://127.0.0.1:8787/live.mjpg`.

## Commands

```bash
bun install
bun test
bun run typecheck
bun run build:node
bun run dev -- --help
bun run dev -- --interfaces
bun run dev -- --discover --local-address 192.168.1.10
bun run dev -- --describe --local-address 192.168.1.10
bun run dev -- --camera-ip 192.168.1.45 --probe-only
bun run dev -- --camera-ip 192.168.1.2 --local-address 192.168.1.10 --mtp-smoke
bun run dev -- --camera-ip 192.168.1.2 --local-address 192.168.1.10 --serve-mjpeg
scripts\run-bridge.cmd --camera-ip 192.168.1.2 --local-address 192.168.1.10
```

## OBS

```text
http://127.0.0.1:8787/live.mjpg
```

OBS is not required during startup. Rivet starts its local HTTP server first,
then connects to the camera in the background. Add the MJPEG URL as a Browser
Source after the dashboard is available.

Recommended OBS settings:

- Source type: Browser Source.
- Width: `480`.
- Height: `320`.
- Scaling: use OBS output scaling for your final canvas.
- Virtual Camera: start from OBS after the browser source is visible.

## HTTP Surface

```text
GET /              Local operator dashboard
GET /health        Health check
GET /status.json   Capture status, FPS, resolution, and frame counters
GET /snapshot.jpg  Latest JPEG frame
GET /live.mjpg     MJPEG stream for OBS
```

## Windows Wi-Fi Safety

Rivet never disables, resets, or toggles Windows Wi-Fi adapters. Operators
select the Canon SSID from the Windows Wi-Fi panel and pass the resulting local
Wi-Fi IPv4 address through `--local-address`.

## Recovery Behavior

If the camera drops Wi-Fi or closes a Canon socket, Rivet keeps the HTTP server
running and retries the Canon connection without changing Windows networking.
The dashboard reports `starting`, `streaming`, `stalled`, `failed`, or
`stopped`.

## Documentation

- [Architecture](docs/architecture.md)
- [Hardware Setup](docs/hardware.md)
- [Operations](docs/operations.md)
- [Protocol Notes](docs/protocol.md)
- [Release Readiness](docs/release-readiness.md)
- [Troubleshooting](docs/troubleshooting.md)

## Project Status

Rivet is hardware-verified on the Canon EOS Rebel T100 / EOS 4000D. Other Canon
EOS Wi-Fi bodies are outside the compatibility contract until they are tested
against the same protocol path.

## Independence

Rivet is an independent open-source project. It is not affiliated with,
endorsed by, or sponsored by Canon Inc. Canon and EOS are trademarks of their
respective owners.

## License

MIT.
