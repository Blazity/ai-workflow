Status: current
Last-verified: 2026-09-09

# Architecture decision records

This directory holds the decisions that outlived the pull request that made
them. An ADR answers three questions for a reader who arrives a year later:
what forced the decision, what was decided, and what the repository now has to
live with. It is not a design document and not a plan: plans live in
`docs/plans/`, measurements live in `docs/research/`.

## Shape

Every ADR is MADR with these sections, in this order:

- **Context.** The forces: what is true in the repository today, with
  `file:line` citations or a link to the research that measured it, and what
  breaks if nothing is decided.
- **Decision.** The rule, stated so a reviewer can apply it without reading
  the rest of the file.
- **Consequences.** What follows: what becomes enforceable, what becomes
  harder, what has to move later and in which stage.
- **Options considered.** Only when real alternatives existed. Each option
  gets the reason it lost. A section listing one option is noise: leave it
  out.

## Header and status

The first two lines of every ADR are the docs header from the documentation
taxonomy:

```
Status: current
Last-verified: YYYY-MM-DD
```

`Status:` takes the docs enum (`current`, `draft`, `superseded-by <path>`) and
describes the document. The MADR decision status is a separate field written
in the body as `Decision status: Accepted` (or `Proposed`, `Rejected`,
`Superseded by ADR-NNN`) and describes the decision. The two never merge: a
`current` document can record a superseded decision, and a superseded document
is still read by whoever is undoing it.

## When to write one

Write an ADR when a decision constrains code structure, tooling, data or
process for longer than one pull request. In practice that means:

- a rule a reviewer will cite against someone else's PR (import tiers, where a
  transaction may live, what a package must expose);
- a tool or gate the repository now depends on, and what happens when it is
  bypassed;
- a data or schema commitment that outlives one release (retiring a schema
  version, one owner for a catalog);
- a process the team is expected to keep (required checks, freezes).

Do not write one for: a bug fix, a refactor with no new rule, a library
version bump, or anything a code comment next to the code says better.

One decision per ADR. A decision that changes later is superseded by a new
ADR, never edited in place: the old file keeps its number, gains
`Decision status: Superseded by ADR-NNN`, and its `Status:` becomes
`superseded-by docs/adr/ADR-NNN-<slug>.md`.

## Numbering

- Files are `ADR-NNN-kebab-slug.md`, `NNN` zero padded to three digits.
- Numbers are assigned in order, never reused and never renumbered, including
  for a rejected or superseded ADR.
- A number may be reserved before the file exists when a planned stage owns
  it. The index below is the reservation list: take the next free number from
  it, and if you claim a reserved number for something else, renumber the
  reservation, not the existing files.

## Index

| ADR | Title | Decision status | State |
|---|---|---|---|
| [ADR-001](./ADR-001-layering-and-packages.md) | Layering and packages | Accepted | Written |
| ADR-002 | Block manifest | Proposed | Planned, written in stage 2 |
| ADR-003 | Definition schema v1 retirement | Proposed | Planned, written in stage 2 |
| [ADR-004](./ADR-004-gates-and-required-ci.md) | Gates and required CI | Accepted | Written |
| ADR-005 | Documentation taxonomy | Proposed | Planned, written in stage 2 |
| ADR-006 | Model catalog | Proposed | Planned, written in stage 8b |

Stage numbers refer to the stage table in
[docs/plans/2026-09-09-architecture-restructure.md](../plans/2026-09-09-architecture-restructure.md).
Stage 2 and stage 8b fill the four planned rows: they replace `Proposed` with
the decision status the ADR lands with and change `State` to `Written`. No
other row moves.
