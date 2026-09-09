Status: current
Last-verified: 2026-09-09

# ADR-005: Documentation taxonomy

Decision status: Accepted

Source: decision D9 and assumptions A7, A9 and A10 of
[docs/plans/2026-09-09-architecture-restructure.md](../plans/2026-09-09-architecture-restructure.md).
Measurements cited below come from
[docs/research/2026-09-09-architecture-audit.md](../research/2026-09-09-architecture-audit.md),
section 7, and from
[docs/research/2026-09-09-agent-navigable-codebase.md](../research/2026-09-09-agent-navigable-codebase.md)
for what Claude Code and the agents.md convention actually load; they are not
re-measured here.

## Context

The repository held 153 documents and no way to tell which of them were true.
Audit section 7 measured the split: a handful of current sources of truth, and
the rest journals (32 plans, 55 superpowers files across three trees, 11 QA
session reports, 8 testing documents, 2 assumption ledgers, an inert
`learnings.md`), plus four documents referenced by nothing at all.

Six contradictions were found, and the important property of all six is that a
reader could not detect them from inside the document. A file said
"Status: APPLIED" while another file described the same subject as live; the
setup guide and a setup skill disagreed about GitLab project ids; the workflow
definition document described schema v1 while the product ran v2; the README
claimed capabilities the roadmap listed as planned.

The reachability problem compounds it. Rationale documents were found by `ls`,
never by a link: the README linked none of them, `AGENTS.md` linked only the
gate document, and `docs/SPEC.md` was reachable from neither. The audit's
summary is the requirement: a new agent needs about six documents to add a
feature safely, and two of the six will mislead it.

Agent loading is a separate constraint with its own hard rules. Claude Code
reads `CLAUDE.md`, not `AGENTS.md`; files above the working directory load at
launch and files in subdirectories load on demand; `.claude/rules/*.md` with
`paths:` frontmatter load when a matching file is read. This repository also
runs Codex sessions, and the agents.md convention is nearest-file-wins. So the
same instruction has to exist under two names without being written twice, and
`learnings.md` matched no loaded path at all, which is why 56 KB of hard-won
gotchas were loaded by nothing.

## Decision

### 1. One index, six groups

`docs/index.md` is the only list of current documents. The groups are the
directories: `architecture/`, `adr/`, `product/`, `runbooks/`, `research/`,
`archive/`. Procedures with steps (the gate ladder, a release) are skills, not
documents. `SETUP.md` is the fact reference; the `init-*` skills link to its
sections and never restate a constraint, so a constraint has one home.

### 2. Every document declares its own status

Every Markdown file outside `archive/` and `research/` starts with exactly two
lines:

```
Status: current
Last-verified: YYYY-MM-DD
```

`Status` takes a fixed enum: `current`, `draft`, or `superseded-by <path>`.
`current` means a reader today needs this document to build, operate or decide.
`Last-verified` is the date someone last checked the document against the code
or the plan, not the date it was edited.

Two conventions follow from the enum being closed. A document that records what
happened on a date is a journal: it moves to `archive/` rather than being
deleted, so its history and its links survive (A7). A historical plan that is
kept in place for provenance carries `superseded-by docs/index.md`, because the
index, not the plan, is what says which document is current.

Published artifacts that begin with YAML frontmatter are not repository
documents and carry no header: customer-facing release notes under
`docs/releases/artur/` and `SKILL.md` manifests have their own required first
lines and their own consumers.

### 3. The gate enforces currency, not just presence

`scripts/gates/docs-status.mjs` fails when a checked document has no header or
an invalid one, when a `current` document was last verified more than 90 days
ago, and when a `current` document is not reachable within two Markdown link
hops from `README.md` or `AGENTS.md`, where `docs/index.md` counts as the first
hop. Reachability alone is not enough: a linked document that is two years
stale is worse than an unlinked one, because being linked is read as a claim of
currency.

The checked set is every Markdown file under `docs/` outside `archive/` and
`research/`, every file under `apps/<app>/docs/`, each `apps/<app>/AGENTS.md`,
and `README.md`, `AGENTS.md`, `SETUP.md` and `CONTEXT.md` at the repository
root. A document the gate does not check is a document that can rot while the
gate stays green, so the set is written down here.

### 4. Root `AGENTS.md` is a routing table

`AGENTS.md` is under 200 lines and answers one question: which document to open
for the work at hand. It carries the evidence rules that bind every edit, and,
verbatim, the four gotchas that break production if an agent does not know
them: `neon-http` has no transactions, WDK discovers steps by file content, the
worker build runs migrations, and the invocation ceiling. Those four stay in
the root file rather than in a rule, because the failure mode is not reading
the wrong file, it is writing code without ever having loaded the fact.

### 5. Per-app instructions, bridged

`apps/worker/AGENTS.md` and `apps/dashboard/AGENTS.md` hold what is true of
that app: how to run it, how to test it, its directory map with the tier each
directory belongs to, and its own gotchas. Each is bridged by a one-line
`CLAUDE.md` containing `@AGENTS.md`, so Codex reads the nearest `AGENTS.md`,
Claude Code reads `CLAUDE.md`, and neither file is written twice. Because
subdirectory memory loads on demand, an agent working in one app pays for that
app only.

### 6. Path-scoped rules replace the learnings file

`.claude/rules/*.md`, each with `paths:` frontmatter naming the globs it
applies to and one topic per file, carry the path-scoped gotchas mined from
`.claude/learnings.md` (A10). The original file is archived. Rules are
Claude-only and load when a matching file is read, which is the mechanism the
old file never had.

## Consequences

- The docs gate can fail a pull request that adds a document nobody links, or
  that lets a `current` document go stale for a quarter. Keeping a document
  alive is now work with a deadline, which is the point.
- Ninety days is a maintenance load by design. The escape hatch is honest
  rather than silent: re-verify and restamp, mark the document
  `superseded-by`, or archive it.
- Archiving is not deletion, so every link into a journal keeps resolving after
  the path change, and the six contradictions are closed by moving the losing
  document into `archive/` rather than by quietly editing it.
- The taxonomy is enforced only for documents. Release notes, skill manifests
  and generated artifacts stay outside it, and the gate has to keep skipping
  them by rule rather than by a list of names.
- Two files now describe the same app for two agents. The bridge keeps them
  identical; a future editor who writes into `CLAUDE.md` instead of
  `AGENTS.md` breaks that, and only review catches it.

## Options considered

**A link check without a status header.** This is the shape most repositories
use, and it was the first draft of this decision. The skeptic pass killed it:
it proves reachability, which the audit shows is not the failure mode here. All
six contradictions were between documents that were linked and read.

**One `CLAUDE.md` per app, no `AGENTS.md`.** Rejected because this repository
runs Codex sessions too, and Codex does not read `CLAUDE.md`. The reverse, one
`AGENTS.md` and no bridge, fails for Claude Code by the same argument.

**Keep `learnings.md` and import it from `CLAUDE.md`.** Rejected: an import
loads at launch and therefore costs context in every session regardless of what
is being edited, which is exactly what path-scoped rules avoid.
