Status: draft
Last-verified: 2026-09-18

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

## Who is in these scenarios

| Actor | Who they are |
|---|---|
| Admin | Owner or admin role; may connect, test, switch source, enable, disable, select providers, disconnect |
| Member | Read-only role |
| Author | Admin working in the workflow editor |
| Agent | A client of the product's MCP server, acting for a person with a person-backed token |
| Waiting person | The ticket author or reviewer whose run is in progress |
| Developer | Someone writing a new integration, internal or in a customer's fork |
| Provider | Jira, GitHub, GitLab, Slack, Arthur, a memory engine: the system on the other side |
| Tenant operator | The person running the Arthur tenant |

## J1. Finding out what can be connected

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-001 | Admin, fresh deployment, nothing connected | Opens Settings, Integrations | Every integration the build ships, each Not connected, each saying in one line what it is and what it unlocks; a note saying which capabilities the core ticket-to-PR flow needs (an issue tracker, version control, an agent) | S6 | |
| INT-002 | Admin, production, everything in environment variables | Opens Integrations | Each configured integration Connected with the environment named as its source; nothing asks them to act | S2, S6 | |
| INT-003 | Member | Opens Integrations | Statuses, sources, unlocks and last verified times; no form, no switch, no secret, no button that fails when clicked | S6 | |
| INT-004 | Admin on a phone | Opens Integrations | Cards readable and statuses distinguishable without horizontal scrolling | S6 | |
| INT-005 | Admin, an integration whose last test failed | Opens Integrations | The card is visibly failing, with the provider's reason and when it was last checked | S6 | |
| INT-006 | Agent | `integrations.list` | The same integrations, statuses, sources and unlocks the screen shows, and no secret | S3 | |
| INT-007 | Agent | `system.capabilities` | Exactly the blocks the editor palette shows for the same state | S3 | |

## J2. Connecting an integration

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-010 | Admin, Arthur not connected | Fills engine URL and API key, saves | The connection is tested before it becomes active; Connected; the card lists what was unlocked; the palette has Arthur's block; the sidebar has Arthur's section; health shows Arthur's checks; `arthur.*` tools work | S2, S6, S8 | |
| INT-011 | Admin | Saves a wrong token | Failing with the provider's own reason (for example 401 unauthorised); nothing unlocked; the non-secret fields stay filled so one field can be corrected | S2, S6 | |
| INT-012 | Admin | Saves while the provider is unreachable | A reason that says the provider could not be reached, distinguishable from a rejected credential | S2 | |
| INT-013 | Admin | Leaves a required field empty | Told which field before anything is sent; nothing stored | S6 | |
| INT-014 | Admin, deployment without `INTEGRATION_SECRETS_KEY` | Opens a card with a secret field | Secret fields disabled with the name of the variable to set; environment-configured integrations unaffected | S2, S6 | |
| INT-015 | Admin on a preview deployment that reads production's database | Tries to connect or toggle | Write controls disabled with the reason; production's integrations untouched | S2, S6 | |
| INT-016 | Admin | Double-clicks Save | One stored version and one test | S2 | |
| INT-017 | Two admins | Save the same integration at the same moment | The second is told the integration changed meanwhile and sees the current state; no silent overwrite | S2 | |
| INT-018 | Admin | Saves, then closes the tab before the test finishes | The save completes on the server; reopening shows the result | S2 | |
| INT-019 | Admin, only some of an integration's variables set in the environment | Opens its card | Failing, naming the missing variables, with the option to use stored values instead | S2, S6 | |
| INT-020 | Agent | `integrations.connect` without a person-backed token, or without a reason | Refused, with which of the two is missing | S3 | |
| INT-021 | Agent acting for a member | Any write | Refused | S3 | |
| INT-022 | Agent | `integrations.connect` with a secret, then `integrations.get` | The secret is reported as set, never returned | S3 | |
| INT-023 | Anyone | Reads worker logs and run traces after any of the above | No secret value in any line | S2, S8 | |

## J3. Using an integration in workflows

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-030 | Author, Arthur connected | Opens the palette | Arthur's blocks grouped under Arthur; core blocks whose capabilities are served | S4, S6 | |
| INT-031 | Author, Arthur not connected | Opens the palette | No Arthur blocks; the Integrations card says what connecting would add | S6 | |
| INT-032 | Author | Connects Arthur in another tab, returns to the editor | The palette shows Arthur's blocks without losing the unsaved canvas | S6 | |
| INT-033 | Author, a workflow using a block of an integration that is now disconnected | Opens it | The node names the missing integration with a link to its card; the rest of the workflow is editable | S6 | |
| INT-034 | Author, same workflow | Publishes | Refused, naming the integration | S4 | |
| INT-035 | Agent | Saves a draft with an unavailable integration's block | The draft is kept and the issue names the integration, the same issue the editor shows | S3, S4 | |
| INT-036 | Author, two issue trackers connected and none selected (later, with Linear) | Opens the palette | Blocks needing the issue tracker are unavailable with "choose the active issue tracker"; nothing picks one silently | S4 | |

## J4. Turning an integration off and on (the kill switch)

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-040 | Admin, Slack posting somewhere it should not | Disables Slack | Before confirming, the impact: published workflows that depend on it and runs in flight; after: Slack's blocks leave the palette, its section and tools report disabled, health shows Disabled, configuration kept | S2, S6 | |
| INT-041 | Waiting person, run in flight that will send a Slack message | Admin disables Slack before that step | The run fails at that step with `integration_unavailable`, reason `disabled`, naming Slack, visible in the run view and in the ticket comment | S4, S9 | |
| INT-042 | Waiting person, run whose Slack step has already started | Admin disables Slack | The step that already started finishes; the next use fails as INT-041 | S4 | |
| INT-043 | Admin | Disables an environment-configured integration | Works exactly as for stored values; the environment is not touched | S2 | |
| INT-044 | Admin | Disables the active issue tracker | The impact names ticket dispatch stopping; on confirm, a ticket moved into the AI column starts no run and the event is recorded as ignored with the reason, visible on the health page | S2, S12 | |
| INT-045 | Waiting person, the disabled integration is the issue tracker itself | Their run fails | The failure is visible in the run view and through MCP, and reaches them through messaging if that is connected, since the ticket comment cannot be posted | S4, S12 | |
| INT-046 | Admin | Re-enables | Everything returns with the kept configuration; runs that failed stay failed and can be started again | S2, S6 | |
| INT-047 | Agent | `integrations.set_enabled` false | The same impact report the screen shows is available before the change (preview) and the change needs a reason | S3 | |
| INT-048 | Admin | Disables Arthur while an agent session is being traced | The session already running keeps its tracer until the sandbox ends; the next agent start has no tracer and the run records that tracing was off | S8 | |

## J5. Changing a connection (rotation, source, reconfiguration)

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-050 | Admin, stored source | Enters a new token, saves | Tested first; on success active at once; runs in flight use the new token at their next use | S2 | |
| INT-051 | Admin | Enters a new token that fails the test | The previous working connection stays active, the card says the new values failed and why; saving the failing values anyway is a separate, explicit action | S2, S6 | |
| INT-052 | Admin, editing a card with a secret already set | Changes only the URL | The stored secret is kept; clearing a secret is its own explicit action | S2, S6 | |
| INT-053 | Admin, environment is the source | Prepares stored values and tests them | Stored values are tested while the environment stays active; nothing changes for runs | S2, S6 | |
| INT-054 | Admin, same | Switches the source to stored | One action, no redeploy; the card says environment values are present but not used | S2, S6 | |
| INT-055 | Admin | Switches the source to environment while the environment is incomplete | Refused, naming the missing variables | S2 | |
| INT-056 | Admin | Changes the Jira site URL | Before confirming, runs in flight are counted and told they will fail; afterwards they fail at their next use with reason `reconfigured`, never mixing the old site with the new token | S2, S4 | |
| INT-057 | Admin, preview and production share a database with different secrets keys | Production reads a value stored under another key | Failing, "stored under another key, enter it again"; no crash, other integrations unaffected | S2 | |

## J6. Choosing the provider of a capability (memory engines, trackers)

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-060 | Admin, fresh deployment | Opens memory on the Integrations screen | Built-in memory is the active provider, with no fields to fill | S13 | |
| INT-061 | Admin, an external memory engine connected | Selects it as active memory | Told that existing memory is not copied between engines; the next run reads and writes the new engine; runs in flight keep the engine they started with | S13, S15 | |
| INT-062 | Admin | Switches memory back to built-in | Built-in memory is exactly as it was before the switch | S13, S15 | |
| INT-063 | Waiting person, active external memory engine down | Run starts | The run continues without memory and the run view says memory was unavailable and why; health shows the engine failing. Memory is the one capability that degrades instead of failing, because it enriches a run and does not gate it | S13 | |
| INT-064 | Admin | Disables the integration that is the active memory engine | Told memory falls back to nothing until another provider is selected; built-in is offered | S13 | |
| INT-065 | Agent | `integrations.select_provider` for memory | Same rules and warnings as the screen, with a reason | S3, S13 | |

## J7. Disconnecting

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-070 | Admin, stored source | Disconnects Slack | Impact shown first; afterwards stored values and every stored secret, in every past version, are gone; the audit keeps who and when | S2, S6 | |
| INT-071 | Admin, environment source | Looks for Disconnect | Not offered; told the connection lives in the deployment's environment and that Disable is available | S6 | |
| INT-072 | Author, after INT-070 | Opens workflows that used Slack | Each names Slack as missing (INT-033) | S6 | |

## J8. An integration's own screens

| ID | Who, in what state | Does | Must see or must happen | Stage | Held by |
|---|---|---|---|---|---|
| INT-080 | Admin, Arthur connected | Opens the sidebar | Core groups, a separator, then Arthur with Evals; never Arthur among core items | S7, S8 | |
| INT-081 | Member, Arthur connected | Opens Arthur, Evals | Reads the page; no settings controls | S7, S8 | |
| INT-082 | Anyone with a bookmark to Arthur's page, Arthur disabled | Opens it | A page saying Arthur is disabled with a link to its card, not a 404 and not an empty chart | S7 | |
| INT-083 | Agent | `arthur.evals_summary` | The numbers the page shows | S8 | |
| INT-084 | Admin on a phone | Opens Arthur, Evals | Styled like the rest of the product and usable at phone width | S7, S8 | |

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
| INT-101 | Waiting person | Token rotated during their run | The run continues | S2, S4 | |
| INT-102 | Waiting person | Provider outage during their run | A typed provider failure naming the integration, distinct from `integration_unavailable` | S4 | |
| INT-103 | Waiting person, workflow with Arthur's injection check | A flagged prompt | The run stops at the check with a typed verdict; never `skipped` | S8 | |
| INT-104 | Waiting person, parked run (waiting for a clarification) across a deploy that moved a step | Answers the clarification | Either the run resumes, or it was cancelled before the deploy with a comment telling them to start again; never silence | S8 to S12, R1 | |

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
