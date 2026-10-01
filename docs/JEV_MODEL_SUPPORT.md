# Jev model support

TypeSafe Jev is a cloud structured-decision provider, configured with
`provider.kind: typesafe`. Official API: https://api.typesafe.ai/v1/systemone.
Documentation checked 2026-09-30 lists jev-latest and jev-preview resolving to
jev-1.13.0. Version IDs can be pinned for reproducibility.

The local Qwen3.5-4B Q4_K_M backend is a different, CPU-native-logit provider.
Real local inference does not establish live Jev cloud inference or model quality.
Neither provider replaces DSH's generative planner/chat model.

`config/examples/typesafe-shadow.json` is schema checked and explicitly allows
policy/call/results/chat fields to reach TypeSafe for tool-assessment. These can
include task text, tool arguments, prior outputs and conversation. Review sharing
before using real data; shadow still sends requests. Default egress remains deny.
Credential is a reference to TYPESAFE_API_KEY, never a key in the config itself.
Live cloud requests require separately configured credentials and approved budget.

Production DSH-entry and installed-launcher tests verify cloud-provider wiring and
mounting. HTTP contract responses are simulated, not paid Jev calls. Local real
weights/service/client checks have separate receipts. Response bodies are capped at
1 MiB and the deadline/cancellation remains active through streamed body reading.

Sources: https://docs.typesafe.ai/api and https://docs.typesafe.ai/models.
