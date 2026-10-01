# Real DSH validation — 2026-10-01

## Result and exact scope

**PASS for the exercised host integration.** The final corrected build was loaded
inside the official installed DSH web launcher, using a new isolated `DSH_HOME`.
This is a running launcher and its production ToolRuntime, not a unit-test host
mock. The tools and scorer responses used for successful observation were
synthetic, and calls were driven directly through the host tool API.

Tested source: staged tree `9748d9592f15b90a628de1dc1dead1396b9c3480`, after the
main-merge review fixes and a fresh full build. This identifier predates the
addition of these receipts. The 141-file source/build SHA-256 manifest is
[`source_manifest.json`](../artifacts/real_dsh_20261001/source_manifest.json).
Its canonical manifest digest is
`ab9d73c43adfa340bb407aff116d4d55fd38efcc3eb42a6e8da41fa3785d1374`.
The tested built `jey-plugin.js` digest is
`5bb1071ed498f42be07133917e2bb59fc75ebaa2f99bc7e99e7bf53decd624f7`.

Environment: Linux x86_64, Node `24.19.0`; official npm launcher
`@deepseek-ai/dsh@0.1.7-alpha.1`. Its dependency ranges resolved agent, agent-loop,
tools, approval and base to `0.1.7-rc.2`, and Cordis to `4.0.4`. The launcher pin
does not freeze those transitive packages. No user profile or credential store
was used, and all test hosts were terminated after verification.

## Exercised behavior

| Check | Result |
|---|---|
| Actual launcher overlay composition and built plugin entry | PASS |
| Off, mock-shadow and TypeSafe-shadow plugin mount | PASS; cloud mount only, no inference |
| `enforce` + mock is rejected by Jev itself | PASS; no mount row |
| Off mode, five identical failures | All five tool bodies ran; zero decision/execution rows |
| `toolAssessment: false`, five identical failures | All five tool bodies ran; zero decision/execution rows |
| Shadow deterministic repeated-failure safeguard | First three failing bodies ran; attempts four and five were refused |
| Host deny, cancellation and synchronous guard | Restricted bodies never ran in off, disabled or shadow cases |
| Unload | A previously paused call ran again; no Jev audit row was added; unrelated host guard remained active |
| Reload | Fresh failure budget, same correct three/five behavior, one decision/execution pair per assessed call |
| Missing local credential | Shadow executed with `provider:AUTH`; enforce refused before tool body |
| Unreachable local provider | Shadow executed with `provider:LOCAL_NOT_READY`; enforce refused before tool body |
| Actual DSH module HMR | Version 1 disposed, version 2 mounted; exactly two mounts and two correlated successful call pairs |

The dispatch receipt contains **48 actual host API dispatches**, with **12 named
checks** covering the flows above. Two shadow generations each produced exactly
nine unique decision IDs and nine matching execution rows. HMR adds two more
tool dispatches. This count is separate from the automated package test totals.

Shadow's repeat-failure refusal is intentional: as documented in `STATUS.md`,
shadow leaves model-derived opinions observational while deterministic hard
rules remain active. Disabled mode and disabled assessment are fully inert for
these per-call observations and restrictions.

Evidence: [`host_dispatch.json`](../artifacts/real_dsh_20261001/host_dispatch.json),
[`host_boot.json`](../artifacts/real_dsh_20261001/host_boot.json),
[`hmr.json`](../artifacts/real_dsh_20261001/hmr.json), and
[`sanitized_console.txt`](../artifacts/real_dsh_20261001/sanitized_console.txt).
Console bearer tokens were redacted before writing those files. The unreachable
local-provider probe used only a deliberately fake test marker against a closed
loopback port, never a user credential.

## Operational limitation confirmed again

Rejecting a third-party plugin **does not stop this launcher**. The invalid
`enforce` + mock configuration generated Jev's `ENFORCE_WITH_MOCK` error, left no
mount row, and the web host still served. A listening port is therefore not proof
of Jev protection. Require a fresh per-launch mount matching the intended
configuration and readiness verification before admitting work; an external
supervisor must enforce the failure response.

## Reproduce

From the repository root, after building the exact source under test:

```sh
export PATH="<your-pnpm-directory>:$PATH"
pnpm -r build
CHECK_ROOT="$(mktemp -d /tmp/jev-real-dsh.XXXXXX)"
mkdir -p "$CHECK_ROOT/home/profiles"
printf '%s\n' '{"private":true,"dependencies":{"@deepseek-ai/dsh":"0.1.7-alpha.1"}}' > "$CHECK_ROOT/home/profiles/package.json"
npm install --prefix "$CHECK_ROOT/home/profiles" --cache "$CHECK_ROOT/npm-cache" --no-audit --no-fund
node scripts/host_boot_check.mjs --dsh 0.1.7-alpha.1 --home "$CHECK_ROOT/home" --out "$CHECK_ROOT/host-boot.json"
node artifacts/real_dsh_20261001/host_dispatch_check.mjs "$PWD" "$CHECK_ROOT"
node artifacts/real_dsh_20261001/hmr_check.mjs "$PWD" "$CHECK_ROOT"
```

Both supplied reproducers were rerun successfully after being made relocatable.
They use ephemeral local ports and stop their own host processes. The dispatch
reproducer resets only its own previous audit/result files in `CHECK_ROOT`.
Installing again may resolve different transitive versions; inspect each receipt.

## Not established by this run

- No real generative planner-driven turn or browser approval-button flow
- No live local-model inference: this reconstructed environment had no reusable
  real model weights or runtime; the only GGUF files were tiny test fixtures
- No live TypeSafe cloud inference, paid call, real API key, persistent token or
  model download
- No new claims about model quality, OS-enforced offline behavior, PTC sandbox
  confinement, cross-platform support or genuine release-to-release migration

Two preliminary harness assertions were corrected before the clean passing
rerun: a policy listener initially short-circuited outside Jev, so its calls could
not have Jev audit rows; and missing credentials correctly report `AUTH`, whereas
a configured but unreachable service reports `LOCAL_NOT_READY`. Neither required
a product-code change. The final suite explicitly covers both error conditions.
