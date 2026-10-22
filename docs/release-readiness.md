# Release Readiness

Rivet reaches public release through staged evidence. The project is not ready
for npm until it is boring to operate locally.

## Local Publicable

Local publicable means the repository can be shared with another technical user
who has the same supported camera class and can run Rivet from source without
private context.

Required gates:

- Source checkout, install, test, typecheck, and build work from a clean clone.
- README Quick Start is sufficient for first run.
- Hardware setup docs cover the complete camera and Windows Wi-Fi flow.
- Dashboard exposes enough state to diagnose setup without reading logs.
- OBS setup works through the documented Browser Source URL.
- No private paths, credentials, dumps, snapshots, or local logs exist in the
  repository.
- License, security, contributing, architecture, operations, protocol, and
  troubleshooting docs are present.
- Tests cover CLI parsing, Canon packet/session behavior, Live View bootstrap,
  frame sharing, reconnection, and HTTP projections.

## Dogfood Evidence

Before public source release, collect real-use evidence from repeated sessions.

Minimum evidence:

- 10 startup sessions from a cold camera state.
- 5 OBS sessions of at least 30 minutes.
- 3 intentional Wi-Fi drops followed by successful reconnection.
- 3 camera sleep or battery-interruption recoveries.
- 3 video-call trials through OBS Virtual Camera.
- one clean Windows restart followed by successful setup using only the docs.

Record:

- camera model
- Windows version
- Wi-Fi adapter
- camera SSID mode
- camera IP
- PC Wi-Fi IPv4
- average FPS
- observed resolution
- failure state and recovery path

Keep raw logs and screenshots out of the repository. Commit only distilled
protocol or operation conclusions.

## Source Release Gate

Rivet can be made public on GitHub when local-publicable gates pass and dogfood
evidence shows the operator flow is repeatable.

Required before public GitHub:

- GitHub Actions CI for install, tests, typecheck, and build.
- `CHANGELOG.md` with the first release notes.
- `docs/compatibility.md` listing supported and unsupported camera bodies.
- sanitized issue templates for bug reports and camera compatibility reports.
- clear statement that the Canon EOS Rebel T100 / EOS 4000D is the supported
  hardware contract.

## Package Release Gate

npm publication is a separate release stage.

Required before npm:

- package name changed to `@sequelcore/rivet`.
- `bin` entry exposes the `rivet` command.
- package output is defined through `files`.
- npm package installs and runs from a temporary directory.
- release scripts build, test, version, tag, and publish.
- published CLI has no dependency on repository-only scripts.

The npm package should be public npm, aligned with Kiln's `@kilnai/*` packages,
not GitHub Packages.

## Org Ownership Judgment

Rivet is hosted under the `sequelcore` GitHub organization and reserved as
`@sequelcore/rivet` on npm because the npm org is already provisioned. This is a
convenience decision, not a thesis decision.

Rivet is a Canon EOS Wi-Fi Live View bridge for OBS. It is not part of the
Sequel product stack (Kiln, Mortar, Vigil) and does not advance the company
engineering thesis described in `infra/docs/strategy/public-project-promotion-and-social-automation.md`.

Revisit before the package release stage:

- If Rivet stays a personal project, move the source repository to Ricardo's
  personal GitHub account and keep `@sequelcore/rivet` only as an npm name
  reservation.
- If Rivet becomes a Sequel-supported tool, promote it in the public-project
  promotion doc and keep it under `sequelcore`.

Do not let the convenient npm reservation silently commit Sequel to owning a
project outside its thesis. Revisit at package release time, not later.
