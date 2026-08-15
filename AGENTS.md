# Repository instructions

Read `../bharatstudio-requirements/governance/AGENTS.md` before any action. This repository is the sole product/runtime owner for Alerts and its contracts. Keep API/event contracts in `contracts/`; public/client APIs are REST/JSON and OpenAPI. Payment and queue state is append-only and must preserve no-drop delivery semantics. `services/youtube-poller-go` is Phase 2 only.
