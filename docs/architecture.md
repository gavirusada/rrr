# Architecture

Rivet is a local bridge between a Canon EOS Wi-Fi camera and OBS.

The runtime is split into explicit boundaries:

- `src/canon`: Canon PTP/IP transport, MTP session control, EOS Live View
  bootstrap, frame polling, and reconnection.
- `src/network`: local IPv4 interface discovery.
- `src/server`: local HTTP dashboard, status endpoint, snapshots, and MJPEG
  streaming.
- `src/config.ts`: CLI argument parsing and validation.
- `src/main.ts`: process orchestration.

## Frame Contract

The server depends on the `FrameSource` port. Canon-specific code owns camera
state and frame production; HTTP code owns projection to local operator and OBS
surfaces.

```ts
interface FrameSource {
  latestFrame(): VideoFrame | null;
  frames(signal: AbortSignal): AsyncIterable<VideoFrame>;
}
```

This keeps Canon protocol concerns out of the HTTP server and keeps OBS-specific
behavior out of the Canon runtime.

## Capture Lifecycle

1. Open the PTP/IP command channel.
2. Open the PTP/IP event channel with the command connection number.
3. Open an MTP session over the command channel.
4. Request device information.
5. Enable Canon remote mode and event mode.
6. Enable Canon EVF output device `8`.
7. Poll Canon events and request Live View data.
8. Publish marker-valid JPEG frames through the shared frame source.

The local HTTP server starts before the Canon handshake completes. This gives
OBS and the dashboard a stable URL while the camera connects or reconnects in
the background.

## Runtime Ownership

`SharedFrameSource` starts one camera capture loop and shares its latest frame
with all HTTP clients. OBS, dashboard preview, and snapshot requests never start
independent camera polling loops.

`ReconnectingFrameSource` owns recovery after Canon connection failures. It
retries camera connection attempts without manipulating Windows networking.

## Build Model

Bun is used for package management, tests, typechecking, and bundling. The
bundled runtime executes under Node because Node TCP sockets behave reliably
with the verified Windows Wi-Fi routing setup.
