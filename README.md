# Hydra

Many Heads. One Command.

Hydra is an independent, unofficial Windows desktop profile manager for the
Grok CLI. Keep personal, work, client, and testing heads on one machine, switch
between them cleanly, and spend less time re-logging when tokens go stale.

<p align="center">
  <img src="docs/social/post/hydra-hero-16x9.png" alt="Hydra — Many Heads. One Command." width="900" />
</p>

## Features

- **Strengthened silent token renewal** — auto-refresh keeps stored profiles
  ready so you re-login less when sessions go stale
- Official `grok login` with automatic local profile import
- Manual import from the current or a selected `auth.json`
- Verified, atomic profile switching with a local backup
- Active-profile detection from the live Grok auth file
- Fuel-style weekly usage meters (green remaining, red used) per profile
- Auth health chips: ready / renewing / re-login required
- Frameless night-first console UI with icon theme toggle and hide-to-tray
- Local-only credential storage under `~/.hydra`
- System tray open / quit; multi-resolution Windows icon

<p align="center">
  <img src="docs/social/post/hydra-features-16x9.png" alt="What Hydra does now" width="900" />
</p>

<p align="center">
  <img src="docs/social/post/hydra-app-night.png" alt="Hydra night dashboard" width="720" />
</p>

## Verify a switch

Start a new Grok session after switching and run:

```text
/status
```

The account shown by Grok should match the active profile in Hydra.

## Install (Windows)

Download the latest release from
[GitHub Releases](https://github.com/Charles-3Ready/hydra/releases):

- `Hydra_1.1.0_x64-setup.exe` — NSIS installer (recommended)
- `Hydra_1.1.0_x64_en-US.msi` — MSI

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

Use Hydra only with profiles you own or are authorized to access. It does
not create accounts, bypass authentication, alter service limits, or recover
revoked credentials. Users remain responsible for the terms and policies
applicable to their accounts.

## Independence

This implementation was written from a behavior specification and generated
from a fresh Tauri scaffold. It does not contain source code or history from
the earlier unlicensed prototype or its upstream repository. See
[`CLEAN_ROOM_SPEC.md`](CLEAN_ROOM_SPEC.md).

Hydra is not affiliated with, endorsed by, or sponsored by xAI. "Grok"
and related marks belong to their respective owners.

## Support

Hydra is free and open source (MIT). If it helps you manage Grok CLI profiles and you want to tip:

[![Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/3readyproto)

Or open [ko-fi.com/3readyproto](https://ko-fi.com/3readyproto). Optional.

## License

[MIT](LICENSE)

---

**Charles-3Ready** · [Ko-fi](https://ko-fi.com/3readyproto)
