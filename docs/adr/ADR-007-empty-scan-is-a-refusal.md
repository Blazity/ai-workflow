Status: current
Last-verified: 2026-09-17

# ADR-007: An empty scan is a refusal

Decision status: Accepted

## Context

A gate proves an invariant over a set: the boundary gate over the modules
dependency-cruiser reports, the database client fence over the production files
under the worker source root, the primitives gate over the dashboard screens.
When that set is empty the gate still runs to completion, finds nothing to
report, and prints the line it prints for a clean tree. Nothing in the output
separates "the invariant holds" from "the gate had nothing to look at".

Three instances, each verified in this repository rather than imagined:

- **A renamed anchor.** The database client fence is a comparison against two
  paths, `apps/worker/src/db/client.ts` and the schema module. Rename either
  and every import of it resolves to something the comparison no longer
  recognizes, so the gate reported `production raw database reachability 0` and
  passed with those imports still standing in the tree it was pointed at
  (`scripts/gates/db-client-fence.mjs`, `requireFenceAnchors`).
- **A missing source root.** The primitives gate walks two dashboard source
  roots. With one of them gone the walk yields nothing for it, and the gate
  printed `ui-primitives PASS: 0 violations`
  (`scripts/gates/ui-primitives.mjs`, `collectFindings`).
- **Nothing missing at all.** A worker tree holding only test files leaves the
  dependency-cruiser report with no module the boundary gate counts as tracked
  source, and it printed `boundaries PASS` over zero modules. Every path that
  gate was told to look at existed (`scripts/gates/boundaries.mjs`,
  `dependencyCounts`).

The third is why this is a rule and not three fixes. The failure needs no
rename and no deletion: it needs only that what a gate scans stops holding what
the gate is about. Every green run in that state is a dated, cited PASS for an
invariant nobody checked, and the evidence rule that a result must be observed
cannot tell the difference, because the observation looks identical either way.

## Decision

An empty set is a refusal, not a pass.

Every gate names two things: the paths it was told to look at, and the
invariant it exists to prove. It refuses with both when a path it depends on is
gone, and again when what it scanned comes back empty. The refusal carries both
halves because a reader told only that something is missing does not know what
went unproven, and a reader told only the invariant does not know what to
restore or where to re-point the gate.

`requireAnchor` and `requireScan` in `scripts/gates/shared.mjs` are the two
shapes that refusal takes: `requireAnchor` for a path the gate was told to look
at, `requireScan` for a count that came back zero. Which paths a given gate
anchors, and which count it measures, belong to that gate's source and are
deliberately not listed here. A list restated in a document is a second copy,
and a second copy drifts (ADR-008).

A passing gate prints how much it scanned. A count is the only counter evidence
a reader has against this failure class: without it, the pass line of a gate
that read nothing and the pass line of a gate that read the whole tree are the
same sentence.

The rule is not confined to `scripts/gates/`. The same failure one level up is
a CI job that reports success without having run its check: with no
`ENGINE_CANARY_TARGET` the behavioural job warned and exited green, so the
aggregator counted a success for a job that had run no behavioural gate at all,
and deleting one repository variable disarmed the gate with nothing red
anywhere. It refuses now. ADR-004 section 5 records the gate itself.

## Consequences

- A gate has a second kind of red. Refusal and violation exit the same way, so
  the reader has to read the message to learn whether the invariant was broken
  or never tested. That is the trade this ADR makes: a red that has to be read
  beats a green that means nothing.
- Every gate owes a refusal case next to its behaviour cases. They live in
  `scripts/ci/gates.test.ts`, one per gate, and a gate added without one has no
  evidence that it fails when it is pointed at nothing.
- A run rooted at a fixture pays for it. A gate invoked with `--root` has to
  find its anchors under that root, so a fixture now declares more than the one
  file the case is about.
- **The rule cannot be applied everywhere, and claiming otherwise would be the
  lie it exists to stop.** Knip reports findings and never the size of what it
  read, so `unused-code` can anchor the workspaces its configuration declares
  and no more: zero findings over a workspace whose file discovery quietly
  collapsed still reads exactly like a clean one. That gate's guarantee is
  weaker than the others' and is written down here as weaker.
- An empty set is sometimes the correct answer, and a gate in that position
  says so by construction rather than by silence. The retired path list starts
  empty by design (ADR-004 section 2), so `no-resurrected-paths` anchors the
  list file and prints how many retired paths it checked instead of refusing on
  a zero count.

## Options considered

**Warn on an empty scan and keep exiting green.** Rejected, and the rejection
is measured rather than argued: that is exactly what the behavioural CI job
did. The warning was printed, the job reported success, the aggregate stayed
green, and nobody noticed for as long as it stood. A warning in a log nobody
opens is indistinguishable from silence.

**Check that the anchor paths exist and stop there.** Rejected by the third
instance above, where no path was missing. Existence proves the gate could
start, not that it read anything, so the two failures need two checks.
