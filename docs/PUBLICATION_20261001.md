# Publication validation — 2026-10-01

## Scope and provenance

The recovery bundle was restored with SHA-256
`68cdf6322e3c71d8fdfc095614c4df6f36adf9299a40682726c38ced1d6b64a0`.
Its patch applied cleanly to the unchanged remote base
`5ff451221a8f1d31682bdb9977408af96517480e` on `feat/jey-m0-m1`.
The proposed branch is `fix/jev-naming-linux-validation`; publication is a draft
pull request, not a merge or an npm/PyPI release. Repository renaming is separate.

The 2026-09-30 reconstruction report and its receipts are historical evidence.
Its `LOCAL_ONLY` status describes that run, not the current branch. Files named
`wheel-before.json`, `config-load-result.json`, and `import-results.json` retain
pre-fix failures; the later smoke receipts document the corrected packages.
The historical 398-case real-model run is **not** claimed as rerun today.

## Fresh checks

Linux x86_64, Node 24.19.0, pnpm 9.15.9, Python 3.12.14.
Receipts are under `artifacts/publication_20261001/`.

- PASS: frozen-lockfile installation, all package builds, strict type checks
- PASS: 309 TypeScript tests and 17 property tests, zero skips
- PASS: 64 Python tests; six real-model tests explicitly SKIPPED
- PASS: seven source-free npm package imports, package-local schema, canonical and
  legacy plugin entry points, actual tool dispatch with a synthetic provider,
  and `.env`/`.gguf` exclusion sentinels
- PASS: no-dependency wheel build, included canonical model lock, no weights,
  credentials or Python bytecode in wheel
- PASS: `git diff --check` and a read-only publish-file audit; generated
  `python/build/` duplicates excluded
- NOT_RUN today: real-model Python inference, two local real-model E2E tests,
  installed launcher/HMR, full wheel runtime inference and lifecycle migration
- NOT_RUN: live Jev cloud inference, paid API requests, macOS/Windows validation,
  release publication, quality benchmark and remaining acceptance gates

The fresh automated count is **390 passed, six skipped**. The two opt-in real-model
E2E cases were not invoked. The original 398-case baseline remains a separately
dated result; these totals must not be added together.

## Additional publication changes

A 5 ms queue-expiry test exposed a scheduling-dependent assumption: the first
request could release its slot slightly before the second request's own deadline,
so the second request legitimately timed out during inference. The test now uses
the existing injected clock to expire queued time deterministically before release.
The production coordinator semantics are unchanged; the full suite was rerun.

Added read-only, SHA-pinned GitHub Actions checks for TypeScript/build/npm packaging
and Python protocol/wheel packaging. They do not require model credentials,
download weights, or call live inference. GitHub execution status is recorded on
the draft PR and must be checked for its exact head commit; this document does not
assert CI passed before a run has completed.

The unresolved acceptance limits and operational readiness warning in
`RECONSTRUCTION_20260930_LINUX.md` still apply.
