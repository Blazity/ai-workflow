Status: current
Last-verified: 2026-09-11

# ADR-006: Model catalog

Decision status: Accepted

Source: decision D6 and assumption A6 of
[docs/plans/2026-09-09-architecture-restructure.md](../plans/2026-09-09-architecture-restructure.md).

## Context

Model selection was described as four lists, but the verified repository has
one finite static list, two live provider sources, and one consumer of a live
source:

| Worker manifest and provider contract | Worker capability catalog | Workflow definition models | Dashboard harness picker |
|---|---|---|---|
| No static model IDs. The provider contract owns package, CLI, and protocol versions, while the manifest parser accepts a bounded model string. | No static model IDs. Claude IDs come from pinned CLI initialization and Codex IDs come from paginated `model/list` responses. | Claude: `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`. Codex: `gpt-5.4`, `gpt-5`, `gpt-5-mini`. | No static list. The picker consumes the live capability response for the selected provider and CLI version. |

The comparison matters because a union of live advertisements and the static
fallback would make every newly advertised provider model selectable without a
product decision. Treating the static list as a parser enum would cause the
opposite compatibility failure: stored profiles with old or custom model IDs
would stop loading even though the existing parser accepts them.

The built-in compatibility manifests also carried the default persisted model
IDs in `packages/contracts`. Contracts cannot import another workspace package,
so leaving those values there would either create a second model owner or force
the dependency edge in the wrong direction.

## Decision

`packages/harness/model-catalog.ts` is the only owner of product model IDs. Its
provider-specific `recognised` policy is exactly:

| Provider | Recognised IDs, in policy order |
|---|---|
| Claude | `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5` |
| Codex | `gpt-5.4`, `gpt-5`, `gpt-5-mini` |

The catalog exposes a known-ID predicate for validation and interpretation.
Absence from `recognised` never makes a stored model ID unreadable. Stored
manifests continue to parse any non-empty bounded model string, and historical
upgrade paths preserve such a string without inventing current capabilities.

`selectable(providerContract)` accepts the small pure interface
`{ provider, modelIds }`. It returns the intersection of the provider's live
advertisement and the provider-specific recognised policy. It preserves live
provider order, keeps the first occurrence of each ID, and removes duplicates.
Changing the recognised policy alone does not expose a model that the provider
does not advertise. Exposing another live model requires a deliberate one-line
addition to the provider's policy list.

The workflow editor keeps its established behavior of placing each configured
default before the discovered candidates. The configured default passes through
the same recognised-policy intersection, so an arbitrary configuration override
remains effective for execution but does not become a picker option.

Production runtime defaults are catalog values and are members of recognised.
Environment parsing keeps model overrides optional; consumers apply the
catalog defaults after parsing. Capture tooling, tests, and presentation-only
mock data are not product catalogs and remain explicit drift-gate exclusions.

The value-level built-in compatibility manifests and their reference and
resolution helpers live in `packages/harness`. Their structural manifest and
reference types remain in `packages/contracts`, so the dependency remains
`harness -> contracts`.

## Consequences

- The worker workflow editor and dashboard harness picker use the same ordered
  intersection and cannot expose a newly advertised model by accident.
- A known-ID check is available without narrowing the persisted manifest
  schema, so old and custom stored IDs remain readable but are not selectable.
- Provider discovery remains worker infrastructure. It can spawn CLIs, cache,
  log, and persist without pulling runtime behavior into the pure package.
- Built-in compatibility values move out of contracts, so consumers that need
  those values import `@shared/harness`; consumers that need only shapes keep
  importing `@shared/contracts`.
- A dependency-free drift gate rejects product model literals outside the
  catalog and documents its test, tooling, and presentation-fixture exclusions.

## Options considered

**Reconstruct historical static lists.** Rejected because the verified sources
are dynamic and inventing removed lists would not describe current behavior.

**Use the union for pickers.** Rejected because a provider advertisement would
become a product rollout without a catalog change.

**Reject unknown stored IDs.** Rejected because it breaks readable historical
profiles and conflicts with the existing bounded-string storage contract.

**Keep built-in manifests in contracts.** Rejected because it leaves model IDs
under two owners. Making contracts import harness would invert the allowed
package dependency.
