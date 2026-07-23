# Manual workflow dispatch from trigger blocks

Date: 2026-07-23
Status: Implemented
Jira: [AIW-173](https://blazity.atlassian.net/browse/AIW-173)
Parent: [AIW-118](https://blazity.atlassian.net/browse/AIW-118)

## Product behavior

Owners and admins can manually dispatch an exact deployed workflow from the
small circular play button beside a deployed trigger block.

- The button is outside the trigger's upper-right corner and never sits on a
  connector.
- It appears only when the canvas node ID and type match the selected
  definition's deployed snapshot.
- Draft-only triggers do not expose the control.
- Disabled definitions remain manually runnable when they have a deployment.
- The modal always names the pinned deployed version and states that draft
  changes are excluded.

Ticket triggers accept a Jira key. Pull-request triggers accept an authoritative
GitHub PR or GitLab MR URL. The preflight shows the resolved subject, exact
deployed version, ordered operations, actor, eligibility, and blockers before
the dispatch action is enabled.

## Ticket dispatch

Ticket dispatch uses the same subject and global-capacity ownership rules as
automatic dispatch. A previous automatic failed-ticket marker does not prevent
an explicit retry.

Execution order:

1. reserve the ticket subject within global capacity;
2. revalidate the ticket and deployed-version guard;
3. idempotently move the ticket to the configured AI column under the reserved
   owner;
4. start the immutable pinned workflow version;
5. bind the winning Workflow candidate and acknowledge the durable request.

Tickets already in AI skip the provider transition. Manual ticket runs retain
normal AI-column cancellation semantics.

## Pull-request dispatch

Manual PR/MR dispatch supports these deployed triggers:

- PR/MR created: the provider says it is currently open;
- checks failed: the current head has an eligible, non-gate failure from a
  trusted producer;
- review: the latest eligible non-bot review matches the configured states;
- merged: the provider says it is currently merged.

The worker accepts only configured provider hosts, re-fetches authoritative
state, enforces provider selection, repository access/allowlisting, trigger
scope, bot filtering, and workflow-owned correlation. It does not synthesize a
webhook delivery and does not write to `trigger_deliveries`.

A workflow-owned PR may correlate through its linked Jira ticket for subject
ownership, but Jira status is never changed and cannot cancel the manual PR
run.

## API and authorization

The dashboard session exposes `canDispatchWorkflows`; the worker grants it only
to owners and admins and rechecks the same policy on both endpoints:

```text
POST /api/v1/workflow-definitions/:id/triggers/:nodeId/manual-dispatch/preflight
POST /api/v1/workflow-definitions/:id/triggers/:nodeId/manual-dispatch
```

The dashboard provides same-origin proxies at the equivalent
`/api/workflow-definitions/...` paths.

Shared contracts use a discriminated Jira-ticket or PR/MR input, a preflight
response, a client-generated request ID with the expected deployed version,
and a `started` or `recovering` result.

## Durability and recovery

`manual_dispatch_requests` records:

- request and actor identity;
- immutable definition/version foreign key;
- trigger node/type;
- normalized input snapshot and subject;
- owner token and run ID;
- safe error information;
- timestamps and the states `pending`, `reserved`, `prepared`,
  `candidate_started`, `started`, and `failed`.

The request ID is idempotent. Repeating the same request returns its stored
result; reusing it for different normalized input conflicts.

Cron recovery runs before generic stale-reservation cleanup. It retries the
exact immutable version after a crash, a proven-or-ambiguous Jira transition,
or a lost Workflow start response. Duplicate candidates are safe because only
one can bind the reserved owner, and the winner acknowledges the request from
inside the Workflow.

Run registry kinds distinguish `manual_ticket` and `manual_pr_trigger`.

## Verification

Coverage includes:

- owner/admin authorization and member rejection;
- ticket reservation/transition/start ordering;
- tickets already in AI, approvals, active subjects, capacity, transition
  failures, lost starts, duplicate request IDs, and deployment changes;
- recovery and winner acknowledgment;
- GitHub/GitLab URL parsing and authoritative created/check/review/merged
  semantics;
- bot, gate-check, provider, repository, and workflow-owned filtering;
- linked-Jira independence for manual PR runs;
- dashboard proxying, deployed-trigger button visibility/placement,
  draft-exclusion copy, modal variants, blockers, and recovery/success states;
- migration shape, worker/dashboard typechecks, complete test suites, and
  production builds.
