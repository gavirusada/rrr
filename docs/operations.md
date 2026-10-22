# Operations

## Install

```bash
bun install
```

## Verify

```bash
bun test
bun run typecheck
bun run build:node
```

## Run

```bat
scripts\run-bridge.cmd --camera-ip 192.168.1.2 --local-address <pc-wifi-ip>
```

The wrapper bundles the TypeScript entrypoint with Bun and runs the bundled
Node runtime.

## Dashboard

```text
http://127.0.0.1:8787/
```

The dashboard displays:

- capture state
- FPS
- resolution
- total frames
- average frame size
- snapshot URL
- OBS stream URL

## Status API

```bash
curl http://127.0.0.1:8787/status.json
```

Response shape:

```json
{
  "ok": true,
  "streamUrl": "http://127.0.0.1:8787/live.mjpg",
  "snapshotUrl": "http://127.0.0.1:8787/snapshot.jpg",
  "frame": {
    "status": "streaming",
    "totalFrames": 120,
    "averageFrameBytes": 98000,
    "fps": 12.5,
    "width": 480,
    "height": 320,
    "lastFrameAt": "2026-06-18T12:00:00.000Z",
    "error": null
  }
}
```

## OBS

Create a Browser Source with:

```text
http://127.0.0.1:8787/live.mjpg
```

Recommended source dimensions:

```text
Width: 480
Height: 320
```

Start OBS Virtual Camera after the Browser Source displays the Rivet feed.
