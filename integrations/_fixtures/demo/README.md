# Demo integration

The test and demo integration. It talks to no real provider: it answers from
its own connection values and inputs, so its behaviour is deterministic.

It reaches the registries only when the fixture flag is set at generation
time (`pnpm gen:integrations`), not in a normal build. Nothing in production
may depend on it; it exists for automated tests and for demo deployments that
want a connectable integration without a real provider account.
