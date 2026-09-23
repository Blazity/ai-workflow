# Demo integration

The test integration. It talks to no real provider: it answers from its own
connection values and inputs, so its behaviour is deterministic.

It reaches a registry only when a developer generates one locally with the
fixture flag (`INTEGRATION_FIXTURES=1 pnpm run gen:integrations`). No
deployment sets that flag and neither does CI, so no build ships it. Tests that
need it call the generator with `includeFixtures` directly, and the registry's
conformance suite checks it on every run. Nothing in production may depend on
it.
