---
name: new-integration
description: Add a new integration (plugin) for a third-party provider to AI Workflow, from scaffold to merged pull request, proven with package tests and conformance. Use for "add an integration", "new integration", "new plugin", "connect <provider>", "integrate Linear", "write a Sentry integration", or any request to make a provider usable in workflows.
---

# New integration

The procedure lives in the guide's
[Start here](../../../docs/architecture/integrations.md#start-here). This
skill walks it in order, says what to show a human at each checkpoint, and
names the points where you stop and ask. It restates no rule: when a step
says "see", open that section and read it whole.

## Read first

1. [Start here](../../../docs/architecture/integrations.md#start-here), all
   of it, then [What an integration is](../../../docs/architecture/integrations.md#what-an-integration-is)
   and [Capabilities](../../../docs/architecture/integrations.md#capabilities).
2. The section of the guide for each thing your integration contributes
   (capability, blocks, webhook, pages), when you reach it.
3. The provider's current documentation, through `ctx7`, as
   [Before you write a line](../../../docs/architecture/integrations.md#before-you-write-a-line-read-the-current-documentation)
   says. Never from memory.
4. The shipped package the capability table points at for your case, and
   `integrations/_template`.

## Procedure

Record the branch and the full start SHA before editing (root `AGENTS.md`,
"Evidence"). Run heavy commands one at a time.

1. **Decide.** Fill the
   [decision checklist](../../../docs/architecture/integrations.md#1-decide-before-you-scaffold)
   from the request and the provider's documentation.
   *Checkpoint:* post the filled checklist (id, what it contributes,
   fields with secret or not, settings, connection test call, health checks,
   webhook yes or no, documentation pages read with dates) and wait for the
   human's yes. The id and the connection fields are permanent once shipped.
2. **Scaffold, install, register, check.** Steps 1 to 5 of
   [From scaffold to merged](../../../docs/architecture/integrations.md#2-from-scaffold-to-merged).
   *Checkpoint:* every command there passes on the untouched scaffold. If one
   fails before you edited anything, stop and report it: that is a defect in
   the template or the scaffold, not yours to work around.
3. **Make it yours**, in the order the guide gives: manifest, worker, tests,
   README. After each file, rerun the package's typecheck, tests and
   conformance. Write each test so it fails when the rule it names breaks,
   and see it fail once.
4. **Review yourself** against the
   [review checklist](../../../docs/architecture/integrations.md#3-review-checklist),
   every box, and run its commands.
   *Checkpoint:* paste the commands and their observed outcomes.
5. **Prove it locally** as
   [Prove it](../../../docs/architecture/integrations.md#4-prove-it) says.
   The production half is an operator's, after the merge: write its steps
   into the pull request for them, and do not attempt it.
6. **Open the pull request** with what the checklist asks it to say.

## Stop and ask a human when

- **No capability fits.** The provider needs a capability that does not exist
  (none of the ones in the guide's table) or the reserved `agent_tools`. A new
  capability is a core design change, not an integration.
- **The SDK would change.** Any edit under `integrations/sdk`: a new field on a
  port, the context or the manifest. It must be additive and recorded in the
  change log of `docs/adr/ADR-010-integrations.md`, and a human decides it.
- **Core would change.** Any edit under `apps/` or `packages/` other than the
  test-mock case the review checklist names for the first provider of a
  capability. Core never names a provider.
- **Something shipped would be renamed.** An integration id, a block type, a
  status variant, a connection field's key, `env`, `default` or `identity`.
  That is a migration or a drain, never an edit.
- **A migration or a database write** of any kind. Integrations have no
  database.
- **The scaffold refuses the id** because core spells it: the fix may be an
  allowlist row or another id, and which is right is a human's call.
- **You need a credential.** A test account's key for a live call that settles
  what the documentation leaves open. Never use a production key or one of
  this product's deployments.
- **The provider cannot fit the model**: it needs an OAuth install flow or a
  rotating refresh token, or its own events should start workflows (see
  [What an integration cannot do](../../../docs/architecture/integrations.md#what-an-integration-cannot-do)).
- **Anything on a deployment**: setting variables, connecting, deploying a
  branch, pressing Test on production. Those are an operator's, after the
  merge.

## Never

Every row of
[Things you may not do](../../../docs/architecture/integrations.md#things-you-may-not-do-and-what-happens-if-you-do)
binds you. The ones agents break most: `"use step"` or `"use workflow"` in
the package, a Node module or global in `manifest.ts`, reading
`process.env`, a zod feature zod 4 changed, a webhook test signed by the
function it tests, deploying an unmerged branch, and em or en dashes
anywhere. Do not run the full worker suite locally; CI runs it.
