# Protocol Notes

Rivet uses Canon Wi-Fi PTP/IP and Canon EOS Live View operations.

## PTP/IP

The camera accepts two TCP channels on port `15740`:

- command channel
- event channel

The event channel is initialized with the command channel connection number.

## MTP Session

Rivet opens an MTP session over the command channel, then requests device
information before enabling Live View. This confirms the command transport is
ready for Canon EOS operations.

## Canon EOS Live View

Rivet enables Canon Live View with the verified T100 transition:

1. Set remote mode to `1`.
2. Set event mode to `1`.
3. Read EVF mode.
4. Enable EVF mode when disabled.
5. Read EVF output device.
6. Write EVF output device as `currentOutput | 8`.
7. Request Live View data with `GetViewFinderData (0x9153)`.

`0xA102` is treated as a transient object-not-ready state during Live View
startup. Rivet polls Canon events and retries frame retrieval.

## Frame Validation

Only marker-valid JPEG payloads are published to HTTP clients. Malformed Canon
viewfinder payloads are discarded before they reach OBS.

## Verified Output

The Canon EOS Rebel T100 / EOS 4000D produces `480x320` Live View JPEG frames
through this path.
