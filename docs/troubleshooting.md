# Troubleshooting

## Dashboard Shows `starting`

Rivet has started its HTTP server and is waiting for the Canon connection or
the first Live View frame.

Check:

- Windows is connected to the Canon `EOST100 -*_Canon0A` SSID.
- The camera is in smartphone connection mode.
- The camera screen is waiting for the Canon smartphone application.
- `--local-address` matches the PC Wi-Fi IPv4 address.

## Dashboard Shows `stalled`

Rivet has a previous frame, but no fresh frame arrived within the stall window.

Check:

- Camera battery level.
- Camera sleep settings.
- Wi-Fi signal strength.
- Whether the camera returned to a menu or pairing screen.

## Snapshot Returns 503

`/snapshot.jpg` returns `503` until Rivet has received its first valid frame.
The dashboard and OBS URL remain available while camera connection retries
continue.

## OBS Shows a Blank Source

Open the dashboard first. If the dashboard is `streaming`, remove and re-add the
OBS Browser Source with:

```text
http://127.0.0.1:8787/live.mjpg
```

Use source dimensions:

```text
Width: 480
Height: 320
```

## Windows Stops Listing Wi-Fi Networks

Do not reset Wi-Fi adapters from scripts or command-line diagnostics. Select
the Canon SSID from the Windows Wi-Fi panel. If Windows stops listing networks,
restart Windows and reconnect from the Wi-Fi panel.

## Local Address Is Not Available

Run:

```bash
bun run dev -- --interfaces
```

Use the IPv4 address assigned to the active Wi-Fi interface as
`--local-address`.
