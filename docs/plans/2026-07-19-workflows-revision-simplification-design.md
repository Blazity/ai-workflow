# Workflows revision simplification design

## Goal

Reduce PR #120 to a reviewable revision of the merged Workflows MVP, targeting fewer than 60,000 added lines including generated Drizzle metadata, tests, and documentation.

The revision keeps the agreed product behavior while removing durability protocols, compatibility machinery, and duplicated coverage that were not product requirements.

## Scope

Keep:

- authoritative block input, output, and availability contracts;
- explicit typed bindings;
- draft, validation, deployment, rollback, version pinning, and layout-only editing;
- editor auto-validation, unavailable reasons, proxy error preservation, deletion affordances, and clipping;
- automatic workspace initialization for specialized agents and canonical Fix outputs;
- preservation of unpublished and conflicted work across clarification;
- authenticated, filtered, current-head provider events;
- separate internal subject identity and optional real ticket identity;
- one active run per subject until terminal completion, with one coalesced pending event;
- clean-tree, exact-head, force-with-lease publication;
- supported GitLab review comments;
- merged PR/MR triggers and self-safe ticket movement;
- configurable duration, token, and cost budgets.

Human-authored pull requests use `scope: "any"` only for review-safe workflows. They may be read, checked, reviewed, and commented on, but they cannot enter Fix, Finalize, Open PR/MR, ticket mutation, or other branch-mutating paths. Mutation requires exact `workflow_owned` correlation. Supporting `scope: "any"` does not enable a default automatic review workflow.

## Simplified persistence

Replace migrations `0020` through `0035` with one migration from `0019`.

- Reuse `workflow_definition_versions` for saved semantic revisions, deployment snapshots, history, and rollback.
- Add only the deployed-version pointer and independently versioned layout state required by definitions.
- Generalize active-run identity to a subject while retaining the existing run identifier as owner.
- Represent delivery deduplication and one pending semantic event with one compact trigger inbox rather than separate delivery, reservation, and pending protocols.
- Preserve clarification through a durable Workflow hook and compact sandbox snapshot metadata after verifying deployed hook retention and expiry.
- Store exact published head and target branch on existing workflow-owned branch state; do not add publication-ledger tables.
- Distinguish Jira self-echoes by exact workflow actor identity; treat missing, different, or unverifiable actors as human input.
- Keep structured budget failure only if existing run telemetry cannot express it without ambiguity.

Do not add deployment history, publication attempt, cancellation fence, or label mutation tables. Do not add active-run counters, reconciliation versions, PostgreSQL functions, or triggers.

## Runtime boundaries

- Definition validation and runtime binding resolution share one parser and contract source.
- The active claim is acquired once and released only during terminal cleanup.
- Finalize performs direct publication preflight and push; Open PR/MR consumes finalized metadata and never pushes.
- Clarification suspends and resumes the same durable workflow where the installed Workflow SDK supports it; it does not create a successor ownership state machine.
- Provider webhook handling authenticates first, normalizes once, rechecks the current PR/MR head, and records one retry-stable semantic event.
- Workflow-owned PRs retain real ticket context. Review-only human PRs never synthesize a Jira key.

## Removed scope

- mutation or implementation takeover of arbitrary human-authored PRs;
- a default post-PR review workflow or a decision about the legacy post-PR gate;
- durable polling for provider deliveries that never arrived;
- detailed cross-provider partial-publication journaling;
- label mutation fencing and multi-stage cancellation reconciliation;
- an unwired run-cancellation API;
- permanent compatibility with intermediate versions of this unmerged branch;
- custom CI serialization that exists only to support excessive database suites.

## Verification

Keep tests at the canonical boundary:

- contract and graph validation;
- definition save/deploy/rollback/pinning;
- editor state and real interaction wiring;
- provider authentication, filtering, current-head checks, deduplication, and GitHub/GitLab parity;
- one active-run concurrency winner and one pending successor;
- clarification suspend/resume with preserved workspace state;
- exact-head and force-with-lease publication;
- merged-ticket self-echo suppression;
- budget boundary behavior;
- one migration replay/backfill/integrity suite.

Remove prose-regex tests, copied executor contract tables, forwarding wrappers, source scans, intermediate migration-chain assertions, and repeated state permutations at multiple layers.

## Diff budget

Deleting fifteen redundant Drizzle snapshots should remove roughly 47,700 additions. Consolidating duplicated tests and planning documents should remove another 9,000 to 14,000. Runtime simplification provides additional margin. The final PR must remain below 60,000 additions without sacrificing the retained behavioral invariants.
