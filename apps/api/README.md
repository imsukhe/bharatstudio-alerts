# Alerts Creator API

The API is the TypeScript control plane for BharatStudio Alerts. It is the
only owner of request-serving authentication, channel authorization and the
REST/JSON client contract.

The current implementation is the L03 foundation only. It exposes health and
readiness probes; domain routes remain absent until the final OpenAPI contract,
L02 security evidence and the corresponding acceptance tests are wired in.

Never add direct browser-to-database access, provider secrets, raw webhook
bodies, YouTube scopes or Enterprise routes here.
