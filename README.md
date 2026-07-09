# Grok Hydra

An independent, unofficial Windows desktop profile manager for the Grok CLI.
Grok Hydra helps developers select among personal, work, client, or testing
profiles they own or are authorized to use.

## Features

- Official `grok login` integration with automatic local profile import
- Manual import from the current or a selected `auth.json`
- Verified, atomic profile switching with a local backup
- Active-profile detection from the live Grok auth file
- Profile rename and removal
- Per-profile usage display with isolated error states
- Clear `Re-login` status for expired credentials
- Native Windows dashboard and system tray
- Local-only credential storage under `~/.grok-hydra`
- Optimized multi-resolution Windows icon

## Verify a switch

Start a new Grok session after switching and run:

```text
/status
```

The account shown by Grok should match the active profile in Grok Hydra.

## Build

Requirements: Node.js 18+, pnpm, Rust, and Visual Studio Build Tools 2022 with
Desktop development with C++.

```powershell
pnpm install
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build
```

Installers are written to `src-tauri/target/release/bundle/`.

## Security and intended use

Auth files contain sensitive credentials. They remain on the local machine
unless the user explicitly moves them. Never commit or share auth files.

Use Grok Hydra only with profiles you own or are authorized to access. It does
not create accounts, bypass authentication, alter service limits, or recover
revoked credentials. Users remain responsible for the terms and policies
applicable to their accounts.

## Independence

This implementation was written from a behavior specification and generated
from a fresh Tauri scaffold. It does not contain source code or history from
the earlier unlicensed prototype or its upstream repository. See
[`CLEAN_ROOM_SPEC.md`](CLEAN_ROOM_SPEC.md).

Grok Hydra is not affiliated with, endorsed by, or sponsored by xAI. "Grok"
and related marks belong to their respective owners.

## License

[MIT](LICENSE)
