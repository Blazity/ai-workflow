Status: current
Last-verified: 2026-09-23

# ADR-011: Harness profiles pick from the capability catalog

Decision status: Accepted

Supersedes [ADR-006](./ADR-006-model-catalog.md).

## Context

ADR-006 put one product policy, `recognised`, in front of every model picker:
a picker offers the intersection of what a provider advertises and that list.
The list holds provider API ids (`claude-opus-4-8`, `gpt-5.4`).

That holds for the workflow editor, whose candidates come from the providers'
`/v1/models` listings, which are API ids. It does not hold for harness
profiles. Their candidates come from the capability catalog
(`apps/worker/src/harness-profiles/capability-catalog.ts`), which is what the
provider's CLI reports, and the Claude CLI reports aliases: `default`,
`opus[1m]`, `sonnet`, `haiku`. No alias is an API id, so the intersection was
empty. The profile editor offered no Claude model at all, and the worker's
publish check (`upgradeHarnessDraftToV2`) answered 409 "no longer available"
for any Claude alias a profile carried. The built-in Claude profile read as
`claude-opus-4-8 · unavailable` while runs on it succeeded.

## Decision

A harness profile may carry any model the capability catalog advertises for
its provider and CLI version, and only those. The catalog is the one list for
profiles: the dashboard editor offers its entries in its order, each once, and
the worker's publish path accepts exactly the same set. `recognised` plays no
part in either.

`recognised` and `selectable(providerContract)` stay in
`packages/harness/model-catalog.ts` as the policy over provider API ids, for
the workflow editor's model list, as ADR-006 describes. The predicate behind
them is private to that module, because the harness profile paths were its
only other callers.

A model the catalog does not list stays readable, as before. The editor names
it for what it is: on a built-in profile, the API id the built-in manifest
sets (runs use it, so there is no warning); on a custom profile, a model from
an older catalog that has to be replaced before the next publish.

Unchanged from ADR-006: `packages/harness/model-catalog.ts` owns every product
model id literal, the built-in compatibility manifests live in
`packages/harness`, stored manifests parse any bounded model string, and the
drift gate rejects model literals outside the owner.

## Consequences

- Whatever a provider's CLI newly advertises becomes selectable in a profile
  without a code change. ADR-006 rejected that for pickers. It is accepted here
  for profiles because the CLI is what runs the profile: a model it advertises
  is one it will run, and a second hand-kept list for CLI ids would be a copy
  of the catalog that drifts.
- The workflow editor's API-id list is still gated by `recognised`, so exposing
  a new API id there is still a one-line policy change.
- The two pickers now answer to different lists. They pick different kinds of
  id (a CLI's model names and a provider's API ids), so one list could not
  serve both.

## Options considered

**Add the Claude aliases to `recognised`.** Rejected: the list would then hold
two kinds of id, and every alias a new CLI release adds would sit unselectable
until somebody noticed.

**Map aliases to API ids before the intersection.** Rejected: the mapping is
the CLI's to make and changes with its releases; keeping a copy here is the
drift ADR-006 set out to remove.
