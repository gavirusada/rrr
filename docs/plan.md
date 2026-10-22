# Camera Controls Long-Term Plan

## Objective

Add safe Canon EOS remote-control diagnostics and, later, operator controls for
exposure-related camera properties while preserving Rivet's current OBS Live
View bridge.

This is not a Live View quality upgrade. The verified T100 / 4000D Wi-Fi Live
View contract remains `480x320` MJPEG. Camera controls can improve exposure,
focus workflow, and operator ergonomics, but they cannot turn the Wi-Fi preview
into the internally recorded Full HD movie stream.

## Current Evidence

- Rivet already opens Canon PTP/IP command and event channels, opens an MTP
  session, requests device info, enables Canon remote/event mode, enables EVF,
  and polls Live View frames.
- `MtpSession` already supports camera-to-host commands and host-to-camera data
  commands, including accepted non-OK Canon responses.
- `LiveViewBootstrap` already uses Canon `SetDevicePropValueEx` (`0x9110`) to
  write EVF and capacity properties.
- The Windows operational path must use `scripts/run-bridge.cmd` so the bundled
  runtime executes under Node.
- External protocol research indicates Canon EOS properties are exposed through
  vendor-specific property codes and event polling:
  - aperture `0xd101`
  - shutter speed `0xd102`
  - ISO `0xd103`
  - white balance `0xd10a`
  - capture destination `0xd11c`
  - Live View output `0xd1b0`
- Canon's Rebel T100 specifications confirm Manual exposure and manual ISO are
  supported in Creative Zone / movie manual exposure modes, but this does not
  prove every value is writable over the camera's Wi-Fi profile.

## Non-Goals

- Do not automate Windows Wi-Fi adapter resets, disables, reconnects, or route
  changes.
- Do not claim support for unsupported Canon bodies.
- Do not expose arbitrary property writes in the dashboard.
- Do not silently change camera settings while streaming.
- Do not attempt to upscale or re-encode the Live View preview as a quality
  fix.

## Design Boundaries

### Canon Runtime

Owns protocol details and camera state.

New files:

- `src/canon/canonProperties.ts`
- `src/canon/canonPropertyEvents.ts`
- `src/canon/canonPropertyMaps.ts`
- `src/canon/canonControlConnection.ts` only if control behavior grows beyond
  the existing Live View connection.

Existing files touched:

- `src/canon/canonEos.ts`
- `src/canon/mtpPackets.ts`
- `src/canon/mtpSession.ts`
- `src/canon/liveViewBootstrap.ts` only if shared property helpers replace the
  existing EVF payload helper.

### CLI / Process Orchestration

Owns explicit diagnostic commands and operator intent.

Existing files touched:

- `src/config.ts`
- `src/main.ts`

Initial CLI should be diagnostic-only:

```text
--camera-props-dump
--camera-props-watch <seconds>
```

Writable control flags come later after hardware evidence:

```text
--set-camera-prop iso=400
--set-camera-prop shutter=1/50
```

### HTTP Surface

Keep the current MJPEG/status server stable.

Do not add a dashboard control panel until the CLI diagnostic path proves which
properties and allowed values the T100 exposes reliably.

Potential later endpoints:

```text
GET  /camera/props.json
POST /camera/props
```

## Implementation Sequence

### Slice 1: Canon Property Payload and Event Parsing

Goal: parse camera property events and build property write payloads without
touching live camera behavior.

Files:

- `src/canon/canonProperties.ts`
- `src/canon/canonPropertyEvents.ts`
- `test/canonProperties.test.ts`
- `test/canonPropertyEvents.test.ts`

Tests first:

- builds a Canon property payload for 32-bit property values
- parses `ValueChanged` event `0xc189`
- parses `AllowedValuesChanged` event `0xc18a`
- parses end marker event `0x00000000`
- rejects malformed/truncated event payloads

Verification:

```bash
bun test
bun run typecheck
bun run build:node
```

### Slice 2: Diagnostic Event Polling CLI

Goal: let the operator collect T100-specific property values and allowed value
lists by turning camera dials or changing settings physically.

Files:

- `src/canon/canonPropertyDiagnostics.ts`
- `src/config.ts`
- `src/main.ts`
- `test/config.test.ts`
- `test/canonPropertyDiagnostics.test.ts`

CLI:

```bash
bun run dev -- --camera-ip 192.168.1.2 --local-address 192.168.1.10 --camera-props-watch 20
```

Runtime rule:

Use `scripts/run-bridge.cmd` or the Node bundle for hardware testing.

Hardware evidence to record outside the repo:

- camera mode dial position
- lens model
- Live View enabled/disabled
- physical setting changed
- emitted property code
- emitted property value
- allowed values list
- response codes and recovery path

### Slice 3: Safe Named Property Writes

Goal: write only named, validated properties after allowed values have been
observed from the camera.

Files:

- `src/canon/canonPropertyMaps.ts`
- `src/canon/canonPropertyWriter.ts`
- `src/config.ts`
- `src/main.ts`
- tests for all new modules

Rules:

- fail fast if no allowed values are known for a property
- reject arbitrary numeric writes from normal operator commands
- only write values contained in the latest allowed-values set
- report Canon response codes explicitly
- avoid retry loops that can leave the camera busy

### Slice 4: Dashboard Controls

Only after CLI writes are hardware-verified.

Add a compact operator panel with current value, allowed values, and explicit
apply actions. No continuous sliders for camera properties; use selects/buttons
to avoid accidental repeated writes.

## Risks

- The T100 / 4000D smartphone Wi-Fi profile may expose fewer controls than EOS
  Utility mode on other Canon bodies.
- Camera mode matters. Manual exposure may be required for shutter and aperture
  writes; some modes may emit empty allowed-values lists.
- Lens capabilities affect aperture values.
- Some write sequences can produce `0x2019` device busy or require camera-side
  recovery.
- Live View and property writes may contend for event polling if implemented as
  independent loops.
- Values discovered on other Canon bodies must not be treated as authoritative
  for the T100 until verified on hardware.

## Quality Gates

Before any feature is called complete:

```bash
bun test
bun run typecheck
bun run build:node
```

Hardware gate:

- Node runtime bridge starts through `scripts/run-bridge.cmd`.
- Current OBS Live View still reaches `streaming`.
- Diagnostic command captures at least one property event from the T100.
- No Wi-Fi adapter manipulation is introduced.

Review gate:

- Canon protocol remains inside `src/canon`.
- HTTP server does not know Canon property packet details.
- CLI validates operator input at boundaries.
- No wildcard imports.
- No dead diagnostic code left outside explicit diagnostic commands.
