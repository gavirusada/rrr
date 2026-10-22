# Security

Rivet is a local camera bridge. It opens a local HTTP server and connects to a
camera on the operator-selected Wi-Fi network.

## Supported Surface

- Local HTTP server bound to `127.0.0.1` by default.
- Canon PTP/IP connection to the configured camera IP and port.
- Local IPv4 interface listing.

## Reporting

Report security issues privately to the project maintainer before public
disclosure.

Include:

- affected version or commit
- operating system
- command used to start Rivet
- reachable network interfaces
- impact and reproduction steps

## Safety Rules

Rivet does not manage Wi-Fi credentials and does not automate Windows adapter
state. Do not add code that disables, resets, reconnects, or rewrites network
profiles without a separate reviewed design.

Do not commit:

- camera Wi-Fi passwords
- Windows network profiles
- local logs with IP addresses or machine names
- APK, DEX, or native library dumps
- captured frames from private environments
