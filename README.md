# DSH Cost Tracker - Project Studios Fork

A hardened, English-first fork of `Angelyeye/dsh-cost-tracker` for DeepSeek Harness (DSH).

This fork keeps the upstream accounting and pricing engine while narrowing the active UI and integration surface for a local-first installation.

## What this fork changes

- Uses the package identity `@shaunpalmer/dsh-cost-tracker`.
- Loads through `index.safe.js`, which prevents the upstream nav-icon routine from modifying installed DSH UI files.
- Replaces the upstream browser UI with a compact English `client.js`.
- Presents today, month, all-time spend, requests, tokens, balance, recent records, CSV export, and current conversation cost.
- Displays money primarily in New Zealand dollars while preserving the original CNY amount alongside it when an exchange rate is available.
- Keeps cloud sync disabled by default.
- Hashes session IDs by default if cloud sync is manually enabled.
- Does not upload project/purpose metadata unless explicitly opted in.
- Writes local records, sync state, and device identity with owner-only permissions on POSIX systems where supported.
- Pins the audited upstream baseline to commit `65bfdb57da16f9963ac63d34c6b4098dc3535d17`.

## English status

The active Project Studios browser surface and hardened sync/runtime surfaces are English-first and protected by regression checks. Some retained upstream implementation and historical test source still contains Chinese comments or test labels; this is preserved source/provenance rather than a second active UI.

## Installation target

The intended installation is the `web` DSH profile from this GitHub repository rather than the upstream npm package.

```bash
dsh plugin --profile web add github:shaunpalmer/dsh-cost-tracker
```

Do not install this fork alongside the upstream package. Both use the stable DSH loader ID `dsh-cost-tracker` so duplicate host routes and UI slots cannot be registered intentionally.

For the audited install, pin the exact Project Studios revision after the Harness smoke test rather than following a moving branch.

## Local data

Detailed cost records are stored under the DSH storage directory, normally:

```text
~/.dsh/storages/cost-tracker-records.json
```

The Project Studios storage layer writes replacement files with owner-only permissions (`0600`) and creates storage directories as owner-only (`0700`) where POSIX modes are supported.

## Currency display

DeepSeek pricing and stored cost records remain in CNY. The Project Studios browser client does not rewrite historical values into NZD.

For display only, the client requests the public CNY→NZD reference rate from Frankfurter and caches the last valid rate in browser local storage for 24 hours. Dashboard totals, balance, recent records and the conversation cost then show NZD as the primary value with the canonical CNY value alongside it.

If the reference-rate request fails, a valid older cached rate can be used. If no valid rate is available, the UI safely falls back to CNY and the accounting engine continues normally.

The FX request contains only the currency pair. Cost records, session identifiers, project metadata and DeepSeek credentials are not sent to the rate service.

## Cloud sync

Cloud sync is optional and remains disabled by default. If it is deliberately enabled, review the destination URL and token first. The hardened defaults hash session IDs and leave project/purpose metadata out of uploads unless explicitly enabled.

## Development and CI

Run the complete repository suite with:

```bash
npm test
```

The suite covers storage, pricing, configuration, recomputation, cloud-read behavior, cloud-view behavior, sync, view normalization, Project Studios package identity, English active surfaces, privacy defaults, DSH-core isolation, owner-only persistence expectations, and NZD-display fallback invariants.

Verified branch state on 17 September 2026:

- branch: `project-studios/english-hardening`;
- CI run #9: green;
- Node test runtime: `22.23.2`;
- latest verified branch head before the NZD display work: `917efb303faf139ed990825542470abf28bed527`.

One cross-repository end-to-end test is intentionally skipped in GitHub Actions when the sibling `dsh-cost-cloud` repository is not checked out. All in-repository tests pass. Current runner warnings are from GitHub Actions' Node runtime transition and Node's `punycode` deprecation, not failing plugin assertions.

## Update policy

Do not auto-follow upstream `main`.

For upstream updates: compare against the pinned baseline, review pricing/network/storage/browser-injection changes, cherry-pick or port only the required change, run the complete suite, and record the accepted upstream SHA in `HARDENING.md` and the integration issue.

## Rollback

Before replacing an installed revision, record the currently working commit SHA.

If a new revision fails the Harness smoke test:

1. remove or replace the new plugin revision from the `web` profile;
2. reinstall the last known-good pinned SHA;
3. restart DSH;
4. confirm the dashboard and conversation composer recover;
5. do not merge the failed revision into `main`.

The local cost data files are separate from the Git revision and should not be deleted during a normal code rollback.

## Merge gate

`project-studios/english-hardening` is not merged into `main` merely because CI is green. Merge only after the pinned revision has been installed into the Harness and the smoke test confirms:

- plugin loads without modifying DSH host files;
- dashboard totals render correctly;
- live conversation cost works;
- CSV export works;
- cloud sync remains off unless explicitly enabled; and
- the DSH UI remains healthy after restart/reload.

After that verification, merge the hardening branch into `main` and record the resulting audited release SHA.

## Upstream

Original project: `Angelyeye/dsh-cost-tracker`.

Upstream version at fork baseline: `1.8.8`.

Detailed upstream English documentation is retained in `README.en.md`.

## Licence

MIT. The original licence and attribution remain in `LICENSE`.
