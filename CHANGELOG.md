# Changelog

All notable changes to the Project Studios fork are recorded here.

The original upstream repository contains the pre-fork release history. This fork began from upstream commit `65bfdb57da16f9963ac63d34c6b4098dc3535d17` at upstream version `1.8.8`.

## 1.8.8-ps.2 - 2026-09-17

### Added

- New Zealand dollar display for dashboard spend, DeepSeek balance, recent records, and current-conversation cost.
- A cached daily CNY→NZD reference-rate lookup using Frankfurter's public exchange-rate API.
- Safe fallback to the original CNY display when a fresh or cached FX rate is unavailable.

### Accounting behavior

- CNY remains the canonical stored and calculated currency. Historical records are not rewritten when exchange rates move.
- NZD conversion happens only in the browser display layer.
- The last valid rate is cached locally for 24 hours; an older cached rate may be used if the rate service is temporarily unavailable and is labelled as cached in the dashboard note.
- The FX request contains only the currency pair and sends no cost records, session identifiers, project metadata, or DeepSeek credentials.

## 1.8.8-ps.1 - 2026-09-17

### Added

- Project Studios package identity: `@shaunpalmer/dsh-cost-tracker`.
- Hardened host wrapper (`index.safe.js`).
- Project Studios hardening documentation and regression checks.

### Security and privacy

- Prevent the upstream nav-icon routine from locating and modifying installed DSH UI files when this fork is loaded through its package entrypoint.
- Keep cloud sync disabled by default.
- Hash session identifiers by default if cloud sync is deliberately enabled.
- Require explicit opt-in before project/purpose metadata is uploaded.
- Write local cost records with owner-only file permissions and create their storage directory as owner-only on POSIX systems.

### Changed

- Replaced the large upstream browser client with a compact English `client.js`.
- The primary README now documents the hardened fork in English.
- The optional upstream settings-schema surface is suppressed by the hardened wrapper to avoid duplicate configuration surfaces while the fork is reduced.

### Preserved

- Upstream pricing, accounting, persistence format, token normalization, cloud engine, and host API logic remain based on the audited upstream `1.8.8` baseline unless explicitly changed above.
