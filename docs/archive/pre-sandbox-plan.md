# Pre-Sandbox Phase Plan

## Goal

Add a configurable pre-sandbox phase to `ai-workflow` that runs before any Vercel Sandbox is provisioned. The phase lets the service execute pluggable server-side steps, such as an AI SDK ticket check, and use their output to either enrich downstream agent prompts or halt before sandbox creation.

## Decisions

- Config lives in the `ai-workflow` service repo.
- The config file is required at the repo root as `pre-sandbox.yaml`.
- Minimal valid config:

```yaml
preSandbox:
  runOn:
    newTicket: true
    existingPr: true
    mergeConflict: true
  steps: []
```

- Missing or invalid config fails the build.
- Step implementations live in `src/pre-sandbox/steps/*.ts`.
- Config references registered step names. Adding a new step requires code changes and redeploy.
- Steps run sequentially.
- Steps run server-side in Workflow step functions, not inside the Vercel Sandbox.
- Steps may use AI SDK and tools.
- Steps may halt sandbox creation.
- Workflow remains responsible for standard Jira and Slack communication.
- Step output can be injected into research, implementation, and review prompts.
- No retries in the first version. Support timeout and failure behavior only.

## Success Criteria

- `pnpm build` fails when `pre-sandbox.yaml` is missing or invalid.
- Config cannot reference an unknown pre-sandbox step.
- A configured pre-sandbox step runs before `provisionSandbox(...)`.
- A halting step prevents sandbox provisioning.
- A halting step can trigger the existing clarification or failure notification path.
- Prompt additions from a step appear only in the selected downstream prompts.
- The showcase AI SDK step can evaluate ticket complexity without repo knowledge.

## Config Shape

Initial config example:

```yaml
preSandbox:
  runOn:
    newTicket: true
    existingPr: true
    mergeConflict: true

  steps:
    - uses: ticket-complexity-check
      name: Ticket Complexity Check
      timeoutMs: 120000
      onFailure: fail
      with:
        input:
          ticket:
            - identifier
            - title
            - description
            - acceptanceCriteria
            - comments
```

### Fields

- `preSandbox.runOn.newTicket`: run when no PR exists yet for the ticket branch.
- `preSandbox.runOn.existingPr`: run when a PR already exists for the ticket branch.
- `preSandbox.runOn.mergeConflict`: run when an existing PR has conflicts.
- `steps[].uses`: registered step id from `src/pre-sandbox/steps/index.ts`.
- `steps[].name`: display name used in logs and prompt sections.
- `steps[].timeoutMs`: maximum duration for the step.
- `steps[].onFailure`: one of `continue`, `fail`, or `move_to_backlog`.
- `steps[].with`: step-specific config passed to the step implementation.

## Runtime Contract

Create shared types in `src/pre-sandbox/types.ts`.

```ts
export type PreSandboxPromptTarget = "research" | "implementation" | "review";

export interface PreSandboxPromptAddition {
  target: PreSandboxPromptTarget[];
  title: string;
  content: string;
}

export type PreSandboxStepResult =
  | {
      status: "continue";
      promptAdditions?: PreSandboxPromptAddition[];
    }
  | {
      status: "halt";
      outcome: "needs_clarification" | "failed";
      message: string;
      questions?: string[];
      promptAdditions?: PreSandboxPromptAddition[];
    };
```

`message` is the human-readable reason used for logs and workflow notifications. It is not a separate control path.

## Step Input Contract

The runner builds a controlled input object and passes only the fields selected by config.

```ts
export interface PreSandboxStepContext {
  ticket: {
    identifier?: string;
    title?: string;
    description?: string;
    acceptanceCriteria?: string;
    comments?: Array<{ author: string; body: string; createdAt?: string }>;
    labels?: string[];
  };
  run: {
    branchName: string;
    isNewTicket: boolean;
    hasExistingPr: boolean;
    hasMergeConflict: boolean;
  };
}
```

For the first version, input field selection only needs to support ticket fields. Additional fields can be added later without changing the step result contract.

## Build-Time Validation

Add:

- `src/pre-sandbox/config.ts`
- `src/pre-sandbox/steps/index.ts`
- `scripts/validate-pre-sandbox-config.ts`

Validation rules:

- `pre-sandbox.yaml` must exist.
- Root key must be `preSandbox`.
- `runOn` booleans must be present.
- `steps` must be an array.
- Each `steps[].uses` must exist in the step registry.
- `timeoutMs`, when present, must be a positive integer.
- `onFailure` must be `continue`, `fail`, or `move_to_backlog`.
- `name`, when present, must be non-empty.

Update `package.json`:

```json
{
  "scripts": {
    "validate:pre-sandbox": "tsx scripts/validate-pre-sandbox-config.ts",
    "build": "pnpm validate:pre-sandbox && rm -rf .nitro/workflow && NODE_OPTIONS=--max-old-space-size=8192 nitro build"
  }
}
```

The repo does not currently include a YAML parser dependency. Add a focused YAML parser dependency, then validate the parsed object with Zod.

## Workflow Integration

Current flow in `src/workflows/agent.ts`:

1. Fetch and validate ticket.
2. Load prompts.
3. Notify started.
4. Resolve branch and PR context.
5. Create branch if needed.
6. Fetch attachments.
7. Ensure Arthur task.
8. Resolve agent kind.
9. Provision sandbox.

New flow:

1. Fetch and validate ticket.
2. Load prompts.
3. Notify started.
4. Resolve branch and PR context.
5. Create branch if needed.
6. Fetch attachments.
7. Run pre-sandbox phase.
8. If halted, use existing workflow communication and terminal handling.
9. Ensure Arthur task.
10. Resolve agent kind.
11. Provision sandbox.

The pre-sandbox phase should run after PR context is known, because `runOn` depends on whether the branch already has a PR and whether it has conflicts. It should run before Arthur task creation and before sandbox provisioning.

## Prompt Injection

Extend context assembly functions in `src/sandbox/context.ts` to accept pre-sandbox prompt additions.

Research prompt section format:

```md
## Pre-Sandbox: Ticket Complexity Check

This information was produced before sandbox creation.

<step output>
```

Apply the same section format to implementation and review prompts when selected by step output.

Suggested API changes:

```ts
interface ResearchPlanContextInput {
  // existing fields
  preSandboxAdditions?: PreSandboxPromptAddition[];
}

interface ImplementationContextInput {
  // existing fields
  preSandboxAdditions?: PreSandboxPromptAddition[];
}

interface ReviewContextInput {
  // existing fields
  preSandboxAdditions?: PreSandboxPromptAddition[];
}
```

The runner groups additions by target:

```ts
{
  research: [...],
  implementation: [...],
  review: [...]
}
```

## Failure And Halt Behavior

Step execution failure:

- `onFailure: continue`: log the failure, continue to the next step, do not inject output.
- `onFailure: fail`: halt workflow as failed, unregister run, move ticket to Backlog, notify through existing `failed` event.
- `onFailure: move_to_backlog`: same terminal ticket movement as failure, but keep the message oriented around pre-sandbox rejection.

Step returns `halt`:

- `outcome: needs_clarification`: unregister run, post clarification questions, move ticket to Backlog, notify through existing `needs_clarification` event.
- `outcome: failed`: unregister run, move ticket to Backlog, notify through existing `failed` event.

The workflow should own Jira and Slack communication so behavior stays consistent with research, implementation, and review phases.

## Showcase Step

Add `src/pre-sandbox/steps/ticket-complexity-check.ts`.

Purpose:

- Use AI SDK to review only the ticket text.
- Decide whether the ticket is small enough and clear enough to send into sandbox execution.
- No repo access.
- No internal docs access.

Expected behavior:

- Continue when the ticket is clear enough.
- Halt with `needs_clarification` when the ticket is too broad, too vague, or missing essential acceptance criteria.
- Return prompt additions for `research` and `implementation` when continuing.

Example output when continuing:

```ts
{
  status: "continue",
  promptAdditions: [
    {
      target: ["research", "implementation"],
      title: "Ticket Complexity Check",
      content: "The ticket looks implementable without additional clarification. Main risk: acceptance criteria do not mention empty states."
    }
  ]
}
```

Example output when halting:

```ts
{
  status: "halt",
  outcome: "needs_clarification",
  message: "Ticket is too broad to implement safely without repo knowledge.",
  questions: [
    "Which user journey is in scope for the first implementation?",
    "What acceptance criteria define completion?"
  ]
}
```

## Implementation Steps

1. Add `pre-sandbox.yaml`
   - Create the required root config file.
   - Start with an empty `steps` array or the showcase `ticket-complexity-check` disabled until its env requirements are settled.
   - Verify with config parser tests.

2. Add config schema and loader
   - Parse YAML.
   - Validate with Zod.
   - Validate step ids against registry.
   - Verify invalid config cases in unit tests.

3. Add build validation script
   - Add `scripts/validate-pre-sandbox-config.ts`.
   - Add `validate:pre-sandbox` script.
   - Run it before `nitro build`.
   - Verify missing file and unknown step fail.

4. Add step registry
   - Add `src/pre-sandbox/steps/index.ts`.
   - Export a typed registry keyed by `uses`.
   - Verify registry ids match config validation.

5. Add runner
   - Add `src/pre-sandbox/runner.ts`.
   - Apply `runOn` conditions.
   - Execute steps sequentially.
   - Enforce timeout.
   - Normalize prompt additions by target.
   - Verify continue, halt, timeout, and failure behavior.

6. Add prompt injection
   - Update `src/sandbox/context.ts`.
   - Add tests in `src/sandbox/context.test.ts`.
   - Verify additions appear in selected prompts only.

7. Add showcase AI SDK step
   - Add `ticket-complexity-check`.
   - Use structured AI output.
   - Keep tools limited to ticket communication decisions for the first version.
   - Mock AI SDK in tests.

8. Wire into `agentWorkflow`
   - Run after PR context and attachments are available.
   - Halt before Arthur task creation and sandbox provisioning.
   - Pass grouped prompt additions into research, implementation, and review context assembly.
   - Verify halted pre-sandbox path never calls `provisionSandbox`.

## Test Plan

Unit tests:

- Config loader accepts the minimal file.
- Config loader rejects missing `preSandbox`.
- Config loader rejects unknown `uses`.
- Config loader rejects invalid `onFailure`.
- Runner skips based on `runOn`.
- Runner executes steps sequentially.
- Runner groups prompt additions by target.
- Runner halts on `needs_clarification`.
- Runner handles `onFailure: continue`.
- Runner handles `onFailure: fail`.
- Prompt assembly includes pre-sandbox blocks in selected phases only.

Workflow-level tests:

- Continuing pre-sandbox run reaches sandbox provisioning.
- Halting pre-sandbox run unregisters the run, moves the ticket to Backlog, and sends the standard notification.
- Halting pre-sandbox run does not provision a sandbox.

Build validation:

- `pnpm validate:pre-sandbox` passes with valid config.
- `pnpm validate:pre-sandbox` fails with missing file.
- `pnpm validate:pre-sandbox` fails with unknown step id.

## Deferred

- Parallel step groups.
- Retries.
- HTTP/plugin step loading.
- Target repo supplied config.
- Rich input selection beyond ticket fields.
- Persisting pre-sandbox artifacts outside workflow state.
- Internal docs/resource fetching steps.
