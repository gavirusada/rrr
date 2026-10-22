# Hardware Setup

Rivet's verified camera target is the Canon EOS Rebel T100 / EOS 4000D.

## Camera State

Use this camera state for Live View capture:

1. Shooting mode: `P`.
2. Live View shooting: enabled.
3. Wi-Fi function: smartphone connection.
4. Connection method: Canon Easy Connection.
5. Camera screen: waiting for the Canon smartphone application.

The camera creates an `EOST100 -*_Canon0A` Wi-Fi network. Connect Windows to
that SSID from the Windows Wi-Fi panel.

## Network Values

Canon Easy Connection normally assigns:

```text
Camera IPv4: 192.168.1.2
PTP/IP port: 15740
```

Find the PC Wi-Fi IPv4 address with:

```bash
bun run dev -- --interfaces
```

Pass the Wi-Fi IPv4 address through `--local-address`:

```bat
scripts\run-bridge.cmd --camera-ip 192.168.1.2 --local-address <pc-wifi-ip>
```

## Pairing Prompt

The camera prompts for confirmation when a new smartphone connection profile is
registered. Saved connection profiles reconnect without showing the confirmation
prompt.

## OBS Target

Use this URL as an OBS Browser Source:

```text
http://127.0.0.1:8787/live.mjpg
```

Open the dashboard during setup:

```text
http://127.0.0.1:8787/
```
