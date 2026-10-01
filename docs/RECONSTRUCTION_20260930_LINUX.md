# Fresh reconstructed validation — 2026-09-30

## What this report covers

The previous ephemeral workspace disappeared after its validation run. This
checkout was recreated from exact commit `5ff451221a8f1d31682bdb9977408af96517480e`.
Known changes were reconstructed from recorded work, **not recovered byte for byte**.
All results below were rerun on this fresh checkout. Receipts are in
`artifacts/reconstruction_20260930_linux/`; old artifacts remain historical.

At the time of this 2026-09-30 run, the work was local on
`fix/jev-naming-linux-validation`, not pushed or merged. For the later publication
checks and their narrower rerun scope, see [PUBLICATION_20261001.md](PUBLICATION_20261001.md).
The GitHub repository rename is separate and has not been claimed complete.
A durable recovery bundle contains the full source, patch, report and receipts.

## Current verified results

Linux x86_64; Node 24.19.0; pnpm 9.15.9; Python 3.12.14.

| Check | Result | Evidence |
|---|---|---|
| All package builds and strict type checks | PASS | `pnpm -r build && pnpm verify` |
| Core | 161 PASS | `typescript_summary.txt` |
| DSH host/entry/approval/audit/doctor | 75 PASS | same |
| MCP unit + real subprocess/SDK contracts | 28 PASS | same |
| TypeSafe/Jev provider contracts | 23 PASS | same; simulated HTTP |
| Local provider contracts | 17 PASS | same |
| Synthetic provider | 5 PASS | same |
| Properties | 17 PASS | same, including 1000 seeded idempotence cases |
| Python full suite with real inference enabled | 70 PASS, zero skips | `python_all_real.txt` |
| Real local service ↔ TypeScript client | 2 PASS, zero skips | `local_e2e.txt`, `local_inference_e2e.json` |
| Real installed launcher mounts off/shadow/TypeSafe provider and rejects bad config | PASS | `host_boot.json` |
| Installed launcher local-enforce + real model readiness/identity | READY | `installed_local_doctor.json` |
| Cloud Jev without key | NOT_READY as required | `doctor_jev_without_key.json` |
| Fresh source-free npm installation, 7 package imports, actual plugin/tool dispatch | PASS | `packaging/smoke.json` |
| npm `.env`/`.gguf` exclusion sentinels and tested archive hashes | PASS | same |
| Source-free wheel lock data/import/help | PASS | `packaging/wheel-smoke.json` |
| Clean wheel environment with all 60 runtime dependencies and real CPU score | PASS | `packaging/wheel-full-inference.json` |
| npm same-build reinstall/uninstall/restore preserves unrelated synthetic state | PASS, version migration remains open | `packaging/lifecycle-smoke.json` |
| Actual installed launcher module HMR, dispose/remount and tool audit | PASS | `hmr_smoke.json` |

The automated suite total is **398 passing cases** (309 TS + 17 properties + 70
Python + 2 local E2E), without counting launcher/packaging smoke checks. This is
engineering coverage, not model-effectiveness certification or all-gates completion.

## Installed model and host facts

- Official npm DSH launcher: `0.1.7-alpha.1`. Its caret-ranged dependencies resolved
  to DSH `0.1.7-rc.2` runtime packages and Cordis `4.0.4`; the exact tree is recorded.
  Workspace host tests use their pinned alpha.1/Cordis4.0.3. Pinning the launcher
  alone does not pin the whole host tree
- SemIf commit: `1f2dea3e25379f9dfc98cb83c324f00ab5deda37`;
  llama-cpp-python `0.3.35`, CPU build with GCC and four build workers
- Model: Qwen3.5-4B Q4_K_M, exactly 3,013,027,808 bytes, SHA-256
  `13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983`
- Fresh local three-question gate: all answered, 6.597 seconds total;
  native-logit probabilities, uncalibrated, zero generated output tokens.
  Earlier host timing exceeded 10 seconds; portable local examples use the bounded
  60-second ceiling. These timings are not latency guarantees
- **TypeSafe Jev cloud** is a different backend. `jev-latest` currently points to
  `jev-1.13.0` per official docs. Cloud wiring and simulated contracts passed; no
  actual cloud inference, paid request, key creation or secret publication occurred

## Reproduced defects and fixes

1. Platform-dependent deep JSON recursion rejection: deterministic 128-container
   bound, with bracket/quote edge regressions
2. Linux Hugging Face snapshot hard-linking produced a dangling model path:
   resolve the cached relative symlink before materializing weights
3. Doctor could report READY without credentials/known launcher and read an old
   mount row: credential/version/latest-config checks now fail readiness accurately
4. Jev naming corrected across packages and entry points, retaining legacy symbols,
   module paths, CLI names, environment names and MCP aliases. Stable audit and
   calibration identifiers were not rewritten
5. Cloud/local providers had unbounded `response.json()` reads and cleared their
   timers after headers. Responses are now limited to 1 MiB and deadlines/cancellation
   remain active through body consumption, including liveness. Oversized/stalled/
   aborted streaming-body regressions prove cancellation at the boundary
6. Fresh npm install exposed a missing adapter root entry, schema reads escaping
   the installed core package, and directory-only packaging allowlists. Corrected
   exports, package-local schema, explicit file patterns and source-free dispatch
   tests cover these. Package and source schema copies are checked for equality
7. Wheel omitted its model lock and assumed checkout-relative data directories.
   The lock is bundled, source equality checked, and wheel service/downloader require
   an explicit writable `--repo-root`, avoiding writes into site-packages

## Acceptance gaps: not hidden by the test count

The historical 74-case matrix recorded 48 PASS / 11 PARTIAL / 14 NOT_RUN / 1 BLOCKED.
This fresh run directly closes POL-02 (idempotence), WIRE-08 (bounded streaming),
and the npm portions of PACK-01 (source-free install/start/call) and PACK-04
(exclusion sentinels). Archive hashes are recorded, but no publishing-time gate
was exercised. Do not infer the remaining gates passed from the suite total.

- HOST-02: no real generative planner-driven host turn; host loop tests use scripted
  planners and probe tools. Local scorer inference is not a planner run
- HOST-06 UI boundary: real approval-service tests use synthetic responders; no
  browser approval-button flow or human approval click was exercised
- HOST-04 / SEC-09: presentation-filter functionality remains deliberately disabled;
  its missing implementation is not a passing test
- HOST-10: actual PTC bridge untested. The resolved rc.2 launcher now contains the
  Node PTC runtime, so the old claim that no implementation is available is stale;
  runtime requires mounted fs/subprocess/sandbox/sandbox-policy/session/timeout
  services and resolved execution authority. Actual confinement and bridge execution
  still need dedicated testing; no disabled sandbox fallback was used
- HOST-12 now PASS for actual installed launcher module HMR: version 1 apply/call,
  disposal, version 2 apply/call, two mounts and exactly two correlated decision/
  execution pairs. No duplicate observer; the planner remains synthetic
- OFF-01/02: no OS-enforced offline run with an external negative control and missing-
  cache variant. Offline flags and literal loopback are insufficient evidence.
  No network/security settings were changed for this run
- PACK-03: real upgrade/rollback preserving unrelated state untested. PACK-02 remains
  limited to doctor checks, and PACK-05 records hashes without a publishing gate.
  Same-build npm reinstall/uninstall/restore preserved a synthetic unrelated plugin,
  session file and config byte for byte; this does not establish A→B release migration
- WIRE-06: no retries by design; callers own backoff. SEC-03 arbitrary-secret
  minimization and LIFE-09 host polling semantics remain partial
- LOCAL-05 and EVAL/SYS groups: no frozen labeled corpus, independent calibration,
  planner baselines, pre-registered statistics or efficacy/security-quality benchmark.
  Model quality and systematic adversarial robustness are **not established**
- Live Jev cloud inference still needs an approved key/call budget. No macOS/Windows
  rerun or public npm/PyPI release was performed

## Operational warning

Observed DSH behavior: a rejected third-party plugin can leave the web host serving
without Jev. A listening port therefore does not prove enforce protection. Use a
fresh per-launch audit, check the mount matches the intended configuration, then
have an external supervisor reject work/stop the host if readiness fails. Doctor
does not supervise processes or establish current liveness from historical logs.

All temporary model/DSH services were terminated; no service is intentionally left
running. Installed binaries/weights remain in the current workspace, but durability
is provided by the source/patch Library bundle, not by promising this machine persists.

Sources: https://github.com/deepseek-ai/deepseek-harness,
https://docs.typesafe.ai/api, https://docs.typesafe.ai/models,
https://github.com/TheoLeeCJ/SemIf/tree/1f2dea3e25379f9dfc98cb83c324f00ab5deda37.

## Additional acceptance probes after the 398-case baseline

- Full Python wheel runtime: a new isolated virtual environment installed the Jev
  wheel and all 60 dependencies from the already-populated package cache. SemIf was
  separately built as a wheel from the approved clean fixed commit and supplied as
  an explicit dependency override preserving its `llamacpp` extra. No editable
  source or existing environment was inherited. `uv pip check` passed. Running
  `scripts/wheel_inference_smoke.py` with `python -I` from `/tmp` proved both modules
  and the bundled lock resolved inside that environment, verified weights, loaded
  the real CPU model and produced a finite normalized two-option diagnostic score
  in 11.146 seconds. Existing approved model/tokenizer assets were explicitly reused.
  This closes full installed-runtime inference, but not a pristine online install
  of the Git dependency or a new cache download. No model-quality claim follows
- `scripts/package_lifecycle_smoke.mjs` uses the exact hashes produced by
  `scripts/package_smoke.mjs`; run the latter first to create its tarballs. It tests
  initial install, same-build reinstall, complete owned-package uninstall and restore,
  checking synthetic unrelated state after every step. There are no distinct
  published A/B releases in this checkout, so genuine version rollback remains open
- `scripts/hmr_smoke.mjs` uses official installed HMR and a temporary wrapper of
  the actual built Jev plugin. It observes disposal/remount and one audited tool
  execution per generation. All spawned hosts terminate in cleanup

These are additional acceptance probes, not an increase to the 398 suite-case count.
