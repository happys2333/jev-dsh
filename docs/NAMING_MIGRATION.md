# Naming correction: jev-dsh

The product is Jev and unpublished workspace packages use `jev-*`. Run a fresh
`pnpm install --frozen-lockfile` and build after updating workspace imports.

Canonical DSH module: `packages/adapter-dsh/src/jev-plugin.ts` (built
`dist/src/jev-plugin.js`). The previous `jey-plugin` module, jeyPlugin/mountJey and
JeyConfig exports remain compatible; prefer jevPlugin/mountJev/JevConfig.

MCP lists jev_check/jev_choose/jev_rank, accepting their jey_* predecessors.
Both jev-mcp and jey-mcp CLI names work. createJevServer is the new factory alias.
Python retains old jey-local-* CLI names alongside jev-local-*.

JEV_AUDIT_PATH, JEV_AUDIT_KEY, JEV_CONFIG, JEV_MODEL_LOCK and JEV_LOCAL_* service
configuration variables take precedence over their JEY_* predecessors. Existing
configuration tokenRef strings still select the variable explicitly named there.
An explicit --token-env selection is never silently substituted.

Historic artifacts/handoff files, audit reasons and calibration/template identities
are preserved. Changing product spelling must not alter prior policy bindings.
