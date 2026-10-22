# Camera Compatibility

## Supported

| Body | Wi-Fi mode | Live View | Observed FPS | Status |
|------|-----------|-----------|--------------|--------|
| Canon EOS Rebel T100 / EOS 4000D | Easy Connection (smartphone) | `480x320` MJPEG | 12-16 | Verified |

## Unsupported

All other Canon EOS Wi-Fi bodies are **unverified** until tested against the same
PTP/IP command/event channel path and Canon EOS Live View transition described in
`docs/protocol.md`.

Do not assume compatibility from the Canon marketing name alone. Live View
bootstrapping, EVF property handling, and the `GetViewFinderData (0x9153)` opcode
behavior may differ across bodies.

## Expanding compatibility

Open a `Camera compatibility report` issue with:

- camera model
- Wi-Fi mode
- camera IP and PTP/IP port
- Live View resolution
- observed FPS
- OBS `/live.mjpg` result
- protocol differences from the T100 / 4000D path

Once a body is verified, add a row here and document any protocol delta in
`docs/protocol.md` or a dedicated compatibility note.