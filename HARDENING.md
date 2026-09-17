# Project Studios Hardening Notes

## Baseline

Forked from `Angelyeye/dsh-cost-tracker` at upstream commit:

```text
65bfdb57da16f9963ac63d34c6b4098dc3535d17
```

Upstream package version at that point: `1.8.8`.

## Trust boundary

The upstream accounting engine remains in `index.js` and the supporting pricing/sync/view modules while the fork is hardened incrementally. The package entrypoint is `index.safe.js`, not `index.js`.

`index.safe.js` deliberately isolates two upstream integration behaviours:

1. The upstream nav-icon self-patcher cannot discover the DSH installation tree, so it cannot rewrite `@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`.
2. The optional upstream settings-schema surface is suppressed. The hardened fork exposes one small English dashboard instead of maintaining two configuration UIs during the reduction.

## Active browser surface

The browser client is `client.js`, replaced by Project Studios rather than wrapping the upstream UI. It contains only the local-first features currently required:

- today spend;
- month spend;
- all-time spend;
- request count;
- token count;
- DeepSeek balance;
- recent cost records;
- CSV export; and
- current conversation cost in the composer dock.

## Privacy defaults

Cloud sync remains disabled unless a user deliberately supplies a valid endpoint and enables it.

If cloud sync is enabled manually:

- `maskSessionId` defaults to `true`;
- `includePurpose` defaults to `false`;
- the user controls the destination URL and cloud token.

## Local file permissions

The detailed cost record store may contain session identifiers and purpose metadata. The fork writes the atomic replacement file with mode `0600` and creates the containing storage directory with mode `0700` on POSIX systems.

## Update policy

Do not automatically merge upstream changes into the installed fork.

For each upstream update:

1. compare the new upstream commit with the pinned baseline;
2. review changes to pricing, credential handling, networking, storage, browser injection, and DSH file-system access;
3. port only the required changes onto a branch;
4. run the complete fork test suite;
5. record the accepted upstream commit in this file and the integration issue.

## Remaining source-English pass

The runtime Project Studios surface is English. Several retained upstream implementation and historical test files still contain Chinese comments or messages. They are intentionally tracked as a separate mechanical source-conversion pass so translation does not get mixed with accounting logic changes.

The final English-source gate should cover all maintained production modules and maintained tests before this fork is treated as fully independent from upstream.
