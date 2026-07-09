# Hydra

This is the independent implementation of Hydra. Do not copy source,
assets, configuration, or tests from `../grok-switcher` or
`Lampese/codex-switcher`.

## Boundaries

- Implement from documented platform behavior and this project's own
  `CLEAN_ROOM_SPEC.md`.
- Authentication must use the official `grok login` command.
- Store credentials locally and never log or commit auth contents.
- Do not describe the project as a quota or restriction bypass.
- Keep the project distributable under the MIT license.

## Build

```powershell
pnpm install
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build
```

Follow the root workspace `AGENTS.md` and `HANDOFF.md` protocol.
