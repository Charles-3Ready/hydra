# Clean-Room Behavior Specification

## Purpose

Provide a local Windows desktop interface for selecting among Grok CLI
profiles that the user owns or is authorized to use.

## Observable platform contract

- The Grok CLI authenticates through `grok login`.
- The current CLI authentication state is represented by
  `%USERPROFILE%\.grok\auth.json`.
- A profile switch is complete only when the intended JSON payload can be read
  back from that location and matches after structural JSON normalization.
- `/status` in a new Grok TUI session is the user-facing verification command.

## Required behaviors

1. Import valid JSON from the current auth file or a user-selected file.
2. Store imported profiles under `%USERPROFILE%\.grok-hydra`.
3. Identify profiles by normalized content and available email metadata.
4. Switch atomically, retain a local backup, and verify the write.
5. Launch official login and detect a changed auth-file fingerprint.
6. List, rename, and remove local profiles.
7. Display per-profile usage when the service returns a readable response.
8. Report expired credentials as `Re-login`.
9. Keep one profile failure from blocking other profile rows.
10. Provide native Windows packaging and system-tray access.

## Non-goals

- Creating accounts.
- Circumventing authentication, quotas, restrictions, or payment.
- Modifying identity claims.
- Recovering revoked credentials.
- Sending stored credentials to any third party other than the service endpoint
  they were issued for.
