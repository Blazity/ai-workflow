Status: draft
Last-verified: 2026-09-21

# Integrations: user journeys, edge cases and the tests that hold them

The scenario catalogue for [the integrations plan](../plans/2026-09-18-integrations.md).
It is written before any code, from the side of the people who use the feature,
and it is the source of the tests: a stage is done when every scenario it owns
is held by a test that a user-visible regression would turn red, or, where no
automated seam can observe it, by recorded production evidence.

## How tests are derived here

These rules exist because a test written by the same agent that wrote the code,
to show that the code does what the code does, proves nothing.

1. **Scenarios come first and from someone else.** This catalogue is the
   contract. At the start of each stage a skeptic, who will not see the
   implementation, adds the scenarios the catalogue missed for that stage
   (the scenario pass of the orchestration process). The executor writes tests
   from the catalogue, never from their own code.
2. **Each scenario is held at the highest seam that can observe it**: the MCP
   tool or HTTP API for what a caller sees, the block contract resolver for
   what the editor and validation agree on, a workflow run for what a person
   waiting on a run sees, the browser for what an admin sees. A test that
   reaches past the seam into internals holds nothing.
3. **Expected values come from an independent source**: the scenario text, a
   provider's recorded payload or documented error, the stored production
   values captured before the change. Never from running the new code and
   copying its output.
4. **Every test is seen failing once**: written before the behaviour exists,
   or proven by breaking the behaviour on purpose and watching the test go red.
   The stage report names how each test was seen failing.
5. **Edge cases are the point.** The happy path of each journey is one row;
   the rest of the rows are what people actually do: the wrong token, the
   double click, the second admin, the preview deployment, the run that was
   already in flight, the webhook that arrives for something disabled.
6. **The "Held by" column is filled during delivery** with the test name, or
   with `prod:` and the evidence (run id, screenshot, MCP transcript) when only
   a real deployment can show it. An empty cell at a stage gate is a failed
   gate. Prior art for this shape: [the repository catalog matrix](./repository-catalog-matrix.md).
7. **Withdrawn rows keep their id**, struck through with the date and reason,
   so references from tickets and stage reports stay valid.

## Who is in these scenarios

| Actor | Who they are |
|---|---|
| Admin | Owner or admin role; may connect, test, switch source, enable, disable, select providers, disconnect |
| Member | Read-only role |
| Author | Admin working in the workflow editor |
| Agent | A client of the product's MCP server building or running workflows; it has no integration management tools (plan decision 15) |
| Waiting person | The ticket author or reviewer whose run is in progress |
| Developer | Someone writing a new integration, internal or in a customer's fork |
| Provider | Jira, GitHub, GitLab, Slack, Arthur, a memory engine: the system on the other side |
| Tenant operator | The person running the Arthur tenant |

## J1. Finding out what can be connected

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-001 | Admin, fresh deployment, nothing connected | Opens Integrations from the sidebar | Every integration the build ships, each Not connected, each saying in one line what it is and what it unlocks; a note saying which capabilities the core ticket-to-PR flow needs (an issue tracker, version control, an agent) | S6 | apps/dashboard/app/(cockpit)/integrations/integrations-screen.test.tsx "a fresh deployment is told what each integration needs and offered Connect", "a build that ships no integrations explains itself instead of showing an empty list" |
| INT-002 | Admin, production, everything in environment variables | Opens Integrations | Each configured integration Connected with the environment named as its source; nothing asks them to act | S2, S6 | apps/worker/src/services/integrations/resolve.test.ts "is Connected when every required variable is set"; prod: local stack with the variables set, "Values come from this deployment's environment variables", and after changing one of them the verification read Tested before these values changed |
| INT-003 | Member | Opens Integrations | Statuses, sources, unlocks and last verified times; no form, no switch, no secret, no button that fails when clicked | S6 | apps/dashboard/app/(cockpit)/integrations/integrations-screen.test.tsx "a member reads every status and is offered no control that would fail", apps/dashboard/app/(cockpit)/integrations/connection-screen.test.tsx "a member sees the state and not one control" |
| INT-004 | Admin on a phone | Opens Integrations | Cards readable and statuses distinguishable without horizontal scrolling | S6 | prod: local stack in a browser at 390x844, the list and the connection screen read without horizontal scrolling (documentElement.scrollWidth equals innerWidth) |
| INT-005 | Admin, an integration whose last test failed | Opens Integrations | The card is visibly failing, with the provider's reason and when it was last checked | S6 | apps/dashboard/app/(cockpit)/integrations/integrations-screen.test.tsx "a failing integration shows the provider's own reason and when it was checked" |
| INT-006 | Agent | `system.capabilities` | Which integrations are connected and enabled and which blocks they make available; no connection field, source detail or secret | S3 | |
| INT-007 | Agent | `system.capabilities` | Exactly the blocks the editor palette shows for the same state | S3 | |

## J2. Connecting an integration

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-010 | Admin, Arthur not connected | Fills engine URL and API key, saves | The connection is tested before it becomes active; Connected; the card lists what was unlocked; the palette has Arthur's block; the sidebar has Arthur's section; health shows Arthur's checks; `system.capabilities` lists Arthur's block | S2, S6, S8 | S2 half: apps/worker/src/services/integrations/authoring.test.ts "is Connected the moment the right token is saved, in one action";S6 half: apps/dashboard/app/(cockpit)/integrations/connection-screen.test.tsx "correcting the URL and leaving the token alone sends the URL and no token"; prod: local stack, a wrong then a right value against a provider that refuses one of them |
| INT-011 | Admin | Saves a wrong token | Failing with the provider's own reason (for example 401 unauthorised); nothing unlocked; the non-secret fields stay filled so one field can be corrected | S2, S6 | apps/worker/src/services/integrations/authoring.test.ts "is told at once that a wrong token was refused", "keeps the non-secret fields filled";S6 half: apps/dashboard/app/(cockpit)/integrations/connection-screen.test.tsx "a wrong token is reported in the provider's own words with the values still on screen" |
| INT-012 | Admin | Saves while the provider is unreachable | A reason that says the provider could not be reached, distinguishable from a rejected credential | S2 | apps/worker/src/services/integrations/authoring.test.ts "is told apart from a provider that answered no" |
| INT-013 | Admin | Leaves a required field empty | Told which field before anything is sent; nothing stored | S6 | apps/dashboard/app/(cockpit)/integrations/connection-screen.test.tsx "an empty required field is named before anything leaves the browser" |
| INT-014 | Admin, deployment without `INTEGRATION_SECRETS_KEY` | Opens a card with a secret field | Secret fields disabled with the name of the variable to set; environment-configured integrations unaffected | S2, S6 | apps/worker/src/services/integrations/authoring.test.ts "a deployment with no secrets key" (both), apps/worker/src/services/integrations/resolve.test.ts "leaves an environment-configured integration untouched";S6 half: apps/dashboard/app/(cockpit)/integrations/connection-screen.test.tsx "a deployment with no secrets key disables the secret field and names the variable"; prod: local stack with the variable removed, the secret input disabled and naming it, the non-secret fields still writable |
| INT-015 | Admin on a preview deployment that reads production's database | Tries to connect or toggle | Write controls disabled with the reason; production's integrations untouched | S2, S6 | apps/worker/src/services/integrations/deployment-writes.test.ts (all), apps/worker/src/services/integrations/authoring.test.ts "a deployment that does not own its database" (all), "a database that cannot say who owns it" (both);S6 half: apps/dashboard/app/(cockpit)/integrations/connection-screen.test.tsx "a deployment that does not own its database offers no write control at all", apps/dashboard/app/api/integrations/handler.test.ts "a deployment refused its write keeps the worker's own sentence"; prod: env_marker flipped, every control gone with both environment names on screen |
| INT-016 | Admin | Double-clicks Save | One stored version and one test | S2 | apps/worker/src/db/repositories/integrations.test.ts "gives two saves racing on a fresh integration one version", "lets the database be the last word on a version number" |
| INT-017 | Two admins | Save the same integration at the same moment | The second is told the integration changed meanwhile and sees the current state; no silent overwrite | S2 | apps/worker/src/services/integrations/authoring.test.ts "refuses a second save whose version moved", apps/worker/src/db/repositories/integrations.test.ts "refuses a save whose expected version moved" |
| INT-018 | Admin | Saves, then closes the tab before the test finishes | The save completes on the server; reopening shows the result | S2 | apps/worker/src/services/integrations/resolve.test.ts "reports a save that failed its test without touching the live status", apps/worker/src/db/repositories/integrations.test.ts "remembers a save whose test failed" |
| INT-019 | Admin, only some of an integration's variables set in the environment | Opens its card | Failing, naming the missing variables, with the option to use stored values instead | S2, S6 | apps/worker/src/services/integrations/resolve.test.ts "is Failing and names the missing variables";S6 half: apps/dashboard/lib/integrations/presentation.test.ts "a partial environment names the variables that are not set" |
| INT-020 | Agent | Looks for a tool to connect, test, disable, disconnect or configure an integration | None exists; a guard test fails if one is added to the MCP catalog | S3 | |
| INT-021 | ~~Agent acting for a member, any write~~ | | Withdrawn 2026-09-18: integration management is dashboard only and MCP covers what workflows can do (plan decision 15) | | |
| INT-022 | Agent | Reads any MCP response after an integration was connected | No connection field, source detail or secret appears in any response | S3 | |
| INT-023 | Anyone | Reads worker logs and run traces after any of the above | No secret value in any line | S2, S8 | apps/worker/src/services/integrations/authoring.test.ts "carry neither the token nor the envelope", "carry no token even when the provider echoed it back", apps/worker/src/services/integrations/resolve.test.ts "carries no secret value and no ciphertext"; S8 half (a key that reaches a sandbox): apps/worker/src/sandbox/agents/tracing.test.ts "puts no connection secret on a command line", integrations/arthur/worker.test.ts "the tracer's key is for its hooks, and never in the agent's own environment", apps/worker/src/sandbox/agents/tracing-adapters.test.ts "records no command that carries the key", "writes the key to the provider's hook file, mode 600, and nowhere the agent reads", apps/worker/src/engine/steps/clarification-snapshot-steps.test.ts "scrubs credentials, snapshots for seven days, and polls until the source stopped" |

## J3. Using an integration in workflows

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-030 | Author, Arthur connected | Opens the palette | Arthur's blocks grouped under Arthur; core blocks whose capabilities are served | S4, S6 | S6 half: apps/dashboard/components/cockpit/flow-editor/canvas-unavailable-blocks.test.ts "a block grouped under a name this palette was written before still reaches the palette"; prod: the palette offered both demo blocks, one available and one refused by name, and the available one was placed on the canvas from the palette, opened its panel and kept the editor alive. Grouping them under the integration name needs the registry to set `presentation.group`, which is the stage that ships a real integration block |
| INT-031 | Author, Arthur not connected | Opens the palette | No Arthur blocks; the Integrations card says what connecting would add | S6 | apps/dashboard/app/(cockpit)/integrations/integrations-screen.test.tsx "a fresh deployment is told what each integration needs and offered Connect" |
| INT-032 | Author | Connects Arthur in another tab, returns to the editor | The palette shows Arthur's blocks without losing the unsaved canvas | S6 | prod: local stack, two tabs; disabling and re-enabling moved the palette in the editor tab without a reload (a window marker set before the change survived it) |
| INT-033 | Author, a workflow using a block of an integration that is now disconnected | Opens it | The node names the missing integration with a link to its card; the rest of the workflow is editable | S6 | apps/dashboard/components/cockpit/flow-editor/canvas-unavailable-blocks.test.ts (all); prod: the canvas banner and the node badge named the integration with a link to /integrations, and the rest of the workflow stayed editable; walked again with a block placed from the palette, where disabling the integration in another tab moved the banner from 3 to 4 steps and named that block, with no reload |
| INT-034 | Author, same workflow | Publishes | Refused, naming the integration | S4 | |
| INT-035 | Agent | Saves a draft with an unavailable integration's block | The draft is kept and the issue names the integration, the same issue the editor shows | S3, S4 | |
| INT-036 | Author, two issue trackers connected and none selected (later, with Linear) | Opens the palette | Blocks needing the issue tracker are unavailable with "choose the active issue tracker"; nothing picks one silently | S4 | |

## J4. Turning an integration off and on (the kill switch)

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-040 | Admin, Slack posting somewhere it should not | Disables Slack | Before confirming, the impact: published workflows that depend on it and runs in flight; after: Slack's blocks leave the palette, its section and tools report disabled, health shows Disabled, configuration kept | S2, S6 | S2 half (configuration kept): apps/worker/src/db/repositories/integrations.test.ts "keeps the stored values so re-enabling finds them";S6 half: apps/dashboard/app/(cockpit)/integrations/connection-screen.test.tsx "turning the integration off asks first, and says what it costs" |
| INT-041 | Waiting person, run in flight that will send a Slack message | Admin disables Slack before that step | The run fails at that step with `integration_unavailable`, reason `disabled`, naming Slack, visible in the run view and in the ticket comment | S4, S9 | |
| INT-042 | Waiting person, run whose Slack step has already started | Admin disables Slack | The step that already started finishes; the next use fails as INT-041 | S4 | |
| INT-043 | Admin | Disables an environment-configured integration | Works exactly as for stored values; the environment is not touched | S2 | apps/worker/src/services/integrations/resolve.test.ts "shows Disabled over an environment connection", apps/worker/src/db/repositories/integrations.test.ts "works for an integration that was never saved from the dashboard" |
| INT-044 | Admin | Disables the active issue tracker | The impact names ticket dispatch stopping; on confirm, a ticket moved into the AI column starts no run and the event is recorded as ignored with the reason, visible on the health page | S2, S12 | S2 half (disable is live): apps/worker/src/services/integrations/authoring.test.ts "changes the answer within one process" |
| INT-045 | Waiting person, the disabled integration is the issue tracker itself | Their run fails | The failure is visible in the run view and through MCP, and reaches them through messaging if that is connected, since the ticket comment cannot be posted | S4, S12 | |
| INT-046 | Admin | Re-enables | Everything returns with the kept configuration; runs that failed stay failed and can be started again | S2, S6 | apps/worker/src/db/repositories/integrations.test.ts "keeps the stored values so re-enabling finds them", apps/worker/src/services/integrations/resolve.test.ts "shows Disabled over stored values";S6 half: prod: re-enabling returned the block to the palette with its stored values untouched |
| INT-047 | ~~Agent, `integrations.set_enabled`~~ | | Withdrawn 2026-09-18: integration management is dashboard only and MCP covers what workflows can do (plan decision 15); the impact preview lives on the screen (INT-040) | | |
| INT-048 | Admin | Disables Arthur while an agent session is being traced | The session already running keeps its tracer until the sandbox ends; the next agent start has no tracer and the run records that tracing was off | S8 | integrations/arthur/worker.test.ts "no task means no tracing, rather than tracing into nothing"; apps/worker/src/sandbox/agents/tracing.test.ts "leaves a provider whose install failed out"; a sandbox already running keeps the tracer it was configured with, which no test can observe: prod evidence in the S8 report |

## J5. Changing a connection (rotation, source, reconfiguration)

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-050 | Admin, stored source | Enters a new token, saves | Tested first; on success active at once; runs in flight use the new token at their next use | S2 | S2 half: apps/worker/src/services/integrations/authoring.test.ts "is Connected the moment the right token is saved, in one action"; the run half is S4 |
| INT-051 | Admin | Enters a new token that fails the test | The previous working connection stays active, the card says the new values failed and why; saving the failing values anyway is a separate, explicit action | S2, S6 | apps/worker/src/services/integrations/authoring.test.ts "leaves the working connection in use and says why the new ones failed"; the "save anyway" half of this row is NOT implemented and will not be: an override that activates a failed version takes the working connection down (ADR-010, "there is no save it anyway");S6 half: apps/dashboard/lib/integrations/presentation.test.ts "a refused credential leaves the working connection in place and says so" |
| INT-052 | Admin, editing a card with a secret already set | Changes only the URL | The stored secret is kept; clearing a secret is its own explicit action | S2, S6 | apps/worker/src/services/integrations/authoring.test.ts "keeps the stored secret when only the URL changes", "clears a secret only when that is what was asked for";S6 half: apps/dashboard/lib/integrations/presentation.test.ts "correcting a URL sends the URL and no secret at all", "erasing a secret is its own instruction and never an empty value" |
| INT-053 | Admin, environment is the source | Prepares stored values and tests them | Stored values are tested while the environment stays active; nothing changes for runs | S2, S6 | apps/worker/src/services/integrations/resolve.test.ts "leaves the status to the environment and reports the stored values as ready", apps/worker/src/services/integrations/authoring.test.ts "leaves a deployment configured through its environment alone until asked", apps/worker/src/db/repositories/integrations.test.ts "leaves the source alone";S6 half: apps/dashboard/app/(cockpit)/integrations/connection-screen.test.tsx "stored values can be prepared while the environment is still the source" |
| INT-054 | Admin, same | Switches the source to stored | One action, no redeploy; the card says environment values are present but not used | S2, S6 | apps/worker/src/db/repositories/integrations.test.ts "is one action that changes no value";S6 half: apps/dashboard/app/(cockpit)/integrations/connection-screen.test.tsx "stored values can be prepared while the environment is still the source" |
| INT-055 | Admin | Switches the source to environment while the environment is incomplete | Refused, naming the missing variables | S2 | apps/worker/src/services/integrations/authoring.test.ts "is refused when the environment does not configure the integration", "names what is missing" |
| INT-056 | Admin | Changes the Jira site URL | Before confirming, enabled definitions are named from their deployed graphs and runs in flight are counted and told they will fail; a definition that reaches Jira only as the active provider of a core capability is included. If either read fails, that fact says unknown and the save button says its impact is unknown, never zero. Afterwards affected runs fail at their next use with reason `reconfigured`, never mixing the old site with the new token | S2, S4, S9 | S2 half (what counts as a change): apps/worker/src/services/integrations/resolve.test.ts "treats a changed site as a reconfiguration" and the table around it; S9: apps/worker/src/services/integrations/impact.test.ts "lists a definition that reaches the integration only through the core send message block", apps/dashboard/app/(cockpit)/integrations/connection-screen.test.tsx "saving a fingerprint change names the enabled definition and the runs that would stop", "a failed impact read says unknown and the destructive save button says so"; the run half is S4 |
| INT-057 | Admin, preview and production share a database with different secrets keys | Production reads a value stored under another key | Failing, "stored under another key, enter it again"; no crash, other integrations unaffected | S2 | apps/worker/src/services/integrations/resolve.test.ts "reads a value stored under another key as Failing", apps/worker/src/infra/secrets-crypto.test.ts "reports a foreign key by its id", "refuses a ciphertext whose slot was rewritten in the database", apps/worker/src/services/integrations/connection-values.test.ts "refuses with the reason an admin can act on" |
| INT-058 | Two admins, or two tabs, on the same connection | Both save, the second one after the first landed | The second save is refused, and the screen shows what is stored now next to what was typed, field by field, before offering Save again; saving again never writes back a value the other admin changed. While the second admin is still typing, nothing on their page is silently replaced and nothing they typed is lost: they are told the rest of the page is no longer current | S2, S6 | S2 half: apps/worker/src/services/integrations/authoring.test.ts (expectedVersion); S6 half: apps/dashboard/app/(cockpit)/integrations/connection-screen.test.tsx "a second tab is told somebody else saved, and keeps what was typed", "a conflict that cannot be read back says so instead of offering a blind save", "a change in another tab while the admin is typing keeps what was typed", apps/dashboard/lib/integrations/presentation.test.ts "a conflict names the field that differs, with both values, and leaves the rest alone"; prod: two tabs on the local stack, tab B kept its field, its save carried the stale version, the refusal named the one field that differed, and saving again stored A's URL and B's channel together |
| INT-059 | Admin, nothing configured on this deployment | Presses Test what is in use | Told there is nothing to test and what to fill in or set; nothing is sent, and no verification is recorded for a question nobody was asked | S6 | apps/dashboard/app/(cockpit)/integrations/connection-screen.test.tsx "testing what is in use is refused while nothing is configured", apps/dashboard/lib/integrations/presentation.test.ts "testing what is in use is refused while nothing is configured, and names why"; prod: local stack, the button answered without a request |

## J6. Choosing the provider of a capability (memory engines, trackers)

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-060 | Admin, fresh deployment | Opens memory on the Integrations screen | Built-in memory is the active provider, with no fields to fill | S13 | |
| INT-061 | Admin, an external memory engine connected | Selects it as active memory | Told that existing memory is not copied between engines; the next run reads and writes the new engine; runs in flight keep the engine they started with | S13, S15 | |
| INT-062 | Admin | Switches memory back to built-in | Built-in memory is exactly as it was before the switch | S13, S15 | |
| INT-063 | Waiting person, active external memory engine down | Run starts | The run continues without memory and the run view says memory was unavailable and why; health shows the engine failing. Memory is the one capability that degrades instead of failing, because it enriches a run and does not gate it | S13 | |
| INT-064 | Admin | Disables the integration that is the active memory engine | Told memory falls back to nothing until another provider is selected; built-in is offered | S13 | |
| INT-065 | ~~Agent, `integrations.select_provider`~~ | | Withdrawn 2026-09-18: integration management is dashboard only and MCP covers what workflows can do (plan decision 15) | | |

## J7. Disconnecting

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-070 | Admin, stored source | Disconnects Slack | Enabled definitions using Slack are named from deployed graphs and the runs in flight that would stop are counted before confirmation; an unreadable impact says unknown. Afterwards stored values and every stored secret, in every past version, are gone; the audit keeps who and when | S2, S6, S9 | apps/worker/src/db/repositories/integrations.test.ts "empties the values and every secret in every past version", "keeps who saved each version and when", apps/worker/src/services/integrations/authoring.test.ts "hands the connection back to the environment"; S6 half: apps/dashboard/app/(cockpit)/integrations/connection-screen.test.tsx "disconnecting names what is erased and what happens to this deployment afterwards"; S9 impact: apps/worker/src/services/integrations/impact.test.ts "lists a real enabled definition by name and counts its runs" and the INT-056 dashboard tests |
| INT-071 | Admin, environment source | Looks for Disconnect | Not offered; told the connection lives in the deployment's environment and that Disable is available | S6 | apps/dashboard/app/(cockpit)/integrations/connection-screen.test.tsx "an integration whose values live in the environment is not offered Disconnect" |
| INT-072 | Author, after INT-070 | Opens workflows that used Slack | Each names Slack as missing (INT-033) | S6 | apps/dashboard/components/cockpit/flow-editor/canvas-unavailable-blocks.test.ts "an unavailable block is named with the engine's own sentence" |

## J8. An integration's own screens

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-080 | Admin, Arthur connected | Opens the sidebar | Core groups, a separator, the Integrations page, then Arthur, whose area has Evals and Connection as tabs; never Arthur among core items, never Integrations inside Settings | S7, S8 | prod: the S8 report's production steps (the sidebar is S7's, the section and its tabs arrive from Arthur's manifest) |
| INT-081 | Member, Arthur connected | Opens Arthur, Evals | Reads the page; no settings controls | S7, S8 | prod: the S8 report's production steps |
| INT-082 | Anyone with a bookmark to Arthur's page, Arthur disabled | Opens it | A page saying Arthur is disabled with a link to its card, not a 404 and not an empty chart | S7 | |
| INT-083 | ~~Agent, `arthur.evals_summary`~~ | | Withdrawn 2026-09-18: integration management is dashboard only and MCP covers what workflows can do (plan decision 15); whether read-only integration data may come back is an open question to Jakub | | |
| INT-084 | Admin on a phone | Opens Arthur, Evals | Styled like the rest of the product and usable at phone width | S7, S8 | prod: the S8 report's production steps |

## J9. Health

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-090 | Admin | Runs a health scan | Core checks as today, then one section per integration with its own checks | S5 | |
| INT-091 | Admin, provider degraded | Runs a health scan | That integration's section is red with the provider's reason; runs are not blocked by health, they fail at use with the provider named | S5 | |
| INT-092 | Admin, an integration with nothing configured | Runs a health scan | Shown as Not connected, visually apart from failing ones | S5 | |
| INT-093 | Admin, partial environment | Runs a health scan | Failing, naming the missing variables | S5 | |

## J10. People waiting on runs

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-100 | Waiting person | A run starts for a workflow whose integration is disconnected | The run fails at start with `integration_unavailable`, reason `disconnected`, the integration named in the run view and the ticket comment | S4 | |
| INT-101 | Waiting person | Token rotated during their run | The run continues | S2, S4 | S2 half: apps/worker/src/services/integrations/resolve.test.ts "follows a rotated secret: the fingerprint does not move"; the run half is S4 |
| INT-102 | Waiting person | Provider outage during their run | A typed provider failure naming the integration, distinct from `integration_unavailable` | S4 | |
| INT-103 | Waiting person, workflow with Arthur's injection check | A flagged prompt | The run stops at the check with a typed verdict; never `skipped` | S8 | integrations/arthur/worker.test.ts "a clean prompt with a rule evaluated is ok, and a failed rule is flagged", "a validation that evaluated no rule is flagged, never ok", "no task on the engine refuses rather than reporting content clean", "nothing bound to screen is a refusal, not a clean verdict"; the verdict has no `skipped` variant left to report (integrations/arthur/manifest.ts statusVariants); unbound content screens the run's own description and comments, and refuses on a subject core composed: apps/worker/src/engine/blocks/integration-block.test.ts "fills an unbound input from the ticket exactly as the block declared", "refuses, naming the input and the fields, when the subject holds none of them", "refuses rather than screening a subject core composed, and asks no provider"; a verdict the graph does not act on cannot be published: apps/worker/src/engine/definition/integration-screen-publish.test.ts "refuses to publish a graph where the next node is not a decision, naming it and the way out", "refuses a Branch whose two answers reach the same nodes, in those terms", "refuses under a trigger whose runs carry no ticket, naming the input and the trigger" |
| INT-104 | Waiting person, parked run (waiting for a clarification) across a deploy that moved a step | Answers the clarification | Either the run resumes, or it was cancelled before the deploy with a comment telling them to start again; never silence | S8 to S12, R1 | S8 half: the drain is total (ADR-010, "The drain for this stage is total"): every running, awaiting or parked run on production and demo is finished or cancelled with a Jira comment before the merge, because the removed ensure-task step sits in every run that reached a sandbox; the guard tests apps/worker/src/engine/workflow-import-boundary.test.ts and step-registration-coverage.test.ts hold the rest |

## J11. Events from providers

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-110 | Provider | Sends an event to the URL registered today (`/webhooks/jira`, `/github`, `/gitlab`, `/slack`) | The same dispatch as before the change | S9 to S12 | |
| INT-111 | Provider | Sends an event for a disabled integration | Accepted so the provider does not retry or disable the webhook, dispatched nowhere, recorded as ignored with the reason | S9 | |
| INT-112 | Provider | Sends an event with a bad signature | Refused and recorded, as today | S9 to S12 | |
| INT-113 | Anyone | Sends an event to an id no integration has | Not found | S9 | |
| INT-114 | Provider, the poller | Finds a ticket in the AI column while Jira is disabled | No run; recorded as ignored with the reason | S12 | |

## J12. Writing a new integration

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-120 | Developer, first time | Runs the scaffold, fills the manifest, regenerates | A new card on the Integrations screen with the connect form from the manifest, without touching any file outside the new package | S1, S14 | |
| INT-121 | Developer | Imports a worker module from the integration | The boundaries gate fails, naming the import and pointing at the context | S1 | |
| INT-122 | Developer | Writes a provider id into core code | The core-reference gate fails, naming the line | S1 | |
| INT-123 | Developer | Forgets the health check, README or logo | Conformance fails, naming what is missing | S1 | |
| INT-124 | Developer | Uses a zod feature that behaves differently under zod 4 | Conformance fails locally, before Vercel does | S1 | |
| INT-125 | Developer | Imports a Node module into `manifest` | A gate fails with the reason (the workflow bundle cannot hold it) | S1 | |
| INT-126 | Developer | Picks an id another integration already uses | Generation fails, naming both | S1 | |
| INT-127 | Developer | Needs a block that waits for a person or loops | The guide tells them it cannot be one integration block and shows the capability route | S14 | |
| INT-128 | Developer | Writes a version control integration (Bitbucket) | Repositories with that provider import and run; nothing in the database refuses the provider | S10 | |
| INT-129 | Maintainer | Removes an integration package from the build while a deployment has its row | The card disappears, the row is ignored, workflows that used its blocks report an unknown integration; nothing crashes | S1, S4 | |
| INT-130 | Developer with only the guide and the SDK | Writes a memory engine integration | Succeeds; every question they needed answered elsewhere becomes a guide fix | S15 | |

## J13. The Arthur tenant

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-140 | Tenant operator | Receives the release | Warned in advance with the date; integrations show the environment as source and Connected; nothing to configure | R1 | |
| INT-141 | Tenant operator | Has runs parked before the release | Listed and drained with a comment on each ticket; none silently stranded | R1 | |
| INT-142 | Tenant operator | Runs one real ticket after the release | Completes end to end | R1 | |
