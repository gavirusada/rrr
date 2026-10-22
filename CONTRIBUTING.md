# Contributing

Rivet accepts changes that keep the Canon runtime reliable, documented, and
operator-safe.

## Standards

- Keep Canon protocol logic inside `src/canon`.
- Keep HTTP/dashboard behavior inside `src/server`.
- Keep CLI parsing inside `src/config.ts`.
- Do not automate Windows Wi-Fi adapter resets, disables, or reconnects.
- Do not commit APKs, DEX files, native library dumps, camera snapshots, local
  logs, or machine-specific paths.
- Add or update tests for behavior changes.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build:node
```

## Hardware Changes

Camera compatibility changes need hardware evidence:

- camera model
- Wi-Fi mode
- camera IP and PTP/IP port
- Live View resolution
- observed FPS range
- OBS endpoint result
- protocol differences from the Canon EOS Rebel T100 / EOS 4000D path

Document confirmed protocol behavior in `docs/protocol.md` or a dedicated
compatibility document.

## Pull Request Checklist

- Tests pass.
- Typecheck passes.
- Node bundle builds.
- Public docs match the behavior.
- No local artifacts or credentials are included.
