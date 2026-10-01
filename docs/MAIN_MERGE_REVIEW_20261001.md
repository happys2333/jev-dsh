# Main-branch review — 2026-10-01

## Scope

The proposed integration takes the complete developer prototype from
`feat/jey-m0-m1` into the previously LICENSE-only `main`. The reviewed starting
feature commit is `7752dddda08ae894e4972acf8726c89ca943be85`, tree
`51c4db9beec01a86eeb042efe724f9378d531731`; the base is
`cfab33b1d3d710f1b6ffdabb031090294a1b8595` (59 commits ahead, none behind).
This review is broader than the earlier incremental naming/publication PR.

## Defects corrected before integration

- The DSH result observer accumulated failed-call budgets and its synchronous
  guard enforced them even in `off` mode or with `toolAssessment: false`.
  Both paths now honor the disabled state. Two real-host-loop regressions failed
  before the fix and pass after it: all four repeated failing tool bodies run,
  no provider call or per-call audit occurs, and a later host denial still wins.
  The explicitly documented deterministic failure guard in enabled `shadow`
  mode is preserved.
- Required Boolean assessment IDs could be answered with schema-valid choice
  outcomes, causing every Boolean threshold to be skipped and enforce to abstain.
  Policy now requires exactly one usable Boolean per required ID. The local
  client also binds responses to the full snapshot, requested unique question
  IDs, answer kinds, choice option domains and ordered score levels.
- Applicable calibration was checked, but policy still compared raw `pYes`.
  It now uses `calibratedPYes` when calibration applies and fails closed when that
  value is missing or invalid. Regressions deliberately separate raw and
  calibrated values so the wrong source cannot pass unnoticed.
- MCP accepted the shared config's `expectedModel` without enforcing it.
  MCP now uses the same identity comparator as DSH before sending decision state;
  requested model, revision, optional weight/tokenizer/quantization pins and
  synthetic identity are checked. Six mismatch cases send no decision request.
- A nonpositive Python queue depth silently created an unlimited queue.
  Constructor and CLI now reject it before model loading. Advertised IPv6
  loopback service binding now uses the correct address family. Malformed
  non-string purposes and integers outside the finite numeric range return
  structured `INVALID_INPUT` instead of uncaught exceptions.

## Fresh checks on the corrected source

- `pnpm -r build && pnpm verify`: PASS; 318 TypeScript tests plus 17 property
  tests, zero skips, including strict type checks for every package
- Python unittest discovery: 68 PASS; six real-inference cases explicitly
  SKIPPED; IPv6 liveness regressions ran without skips
- Fresh source-free npm package smoke: PASS; all seven package imports, shared
  exports, installed schema, actual synthetic tool dispatch and exclusion sentinels
- No-dependency Python wheel build/inspection: PASS; canonical model lock,
  canonical/legacy CLI entries, no model weights, credentials or bytecode
- Actual installed DSH launcher: PASS for boot/composition, 48 host API dispatches
  and module HMR, including the disabled-mode regressions and fail-closed provider
  outages; see [the separate host report](REAL_DSH_VALIDATION_20261001.md) for
  synthetic-input scope and exact receipts
- `git diff --check`: PASS
- Read-only credential-signature scans of tracked source and available local
  historical patches found no private-key, GitHub-token, AWS-key or service-key
  matches. This is not a complete secret or security audit

The automated count is **403 passed, six skipped**. Packaging and actual installed
launcher probes are separate checks, not additional cases in this total. The
historical 398-case real-model baseline was not rerun or added to this count.
GitHub CI must still be checked for the exact published revision.

## Residual limits

The developer-prototype and acceptance limits in
[the reconstruction report](RECONSTRUCTION_20260930_LINUX.md) still apply,
including live cloud/model quality, genuine planner/PTC and human approval flows,
OS-enforced offline validation, cross-platform coverage and release migration.
No npm/PyPI release or production-readiness claim follows from merging source.

One additional core-API limitation remains: simultaneous submissions with the
same `(sessionId, requestId, generation)` can both run before either settles.
Settled duplicates are rejected, but in-flight duplicate admission is not yet
coalesced. Current DSH and MCP adapters mint distinct request IDs; direct callers
must not concurrently reuse the same request identity. No cancellation or
coordinator redesign was included in this bounded repair.

A listening DSH port still does not establish that the plugin mounted. Use a
fresh per-launch journal and matching readiness evidence; an external supervisor
must refuse work when protection is required but absent.
