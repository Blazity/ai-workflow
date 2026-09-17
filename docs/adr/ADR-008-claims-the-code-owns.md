Status: current
Last-verified: 2026-09-17

# ADR-008: Claims the code owns

Decision status: Accepted

## Context

`SETUP.md` tells the person configuring a deployment which changes select the
behavioural PR gate, and it did that by listing the paths. The list was a copy:
`CANARY_PREFIXES` in `scripts/ci/engine-canary-scope.ts` holds the real one,
seventeen entries each carrying the reason it is there. The copy had fallen
seven prefixes behind, which is the number
`scripts/ci/engine-canary-docs.test.ts` records: "the source gained seven
prefixes and the prose had no way to notice". Nobody noticed because nothing
could. The two halves are never read side by side, and each is internally
consistent.

The drift is not symmetrical, and that shapes the fix. A prefix the source
selects and the document omits tells a reader their change will skip the canary
when it will not. A prefix deleted from the source while the document still
names it is the reverse lie and the worse one: the document goes on promising
cover that no longer exists, and a reader has no way to see it go.

A second instance in the same delivery has the same shape without a document in
it. The root `test:packages` and `test:packages:zod4` scripts selected
`./packages/*` with `--if-present`, which hands a package that owns no such
script the meaning "passed", so a run that read as seven packages proved two.

## Decision

A document that restates a list, a rule or a behaviour the code owns is a
second copy, and second copies drift silently because nothing ever shows the
two halves disagreeing.

So such a document does one of two things, and never neither:

1. **Name the code as the authority instead of copying it.** Point at the file
   that owns the list, say what it is, and let the reader open it.
2. **Keep the copy and bind it with a test**, when a reader genuinely needs the
   answer in the place they are reading. A setup guide somebody follows by hand
   is the case this exists for: a pointer costs them a file to open in the
   middle of a procedure.

A binding test checks both directions, because the two failures above are two
different assertions. `scripts/ci/engine-canary-docs.test.ts` is the worked
example: one test fails when the source selects on a prefix the section does
not name, the other fails when the section names a worker source path that no
longer selects the canary. The second test has to declare its own boundary,
since the section names paths that are deliberately not prefixes, and declaring
that boundary is part of the price.

The test pins no wording. The prose may say whatever it likes as long as the
facts it states are the facts the code holds. And a test that reads a document
refuses rather than passes when it cannot find what it came to read: a renamed
heading yielding an empty section would otherwise turn every assertion under it
into a pass (ADR-007).

**The boundary.** This binds a document that restates something the code owns:
a list, an enum, a set of paths, a rule with cases. It does not bind prose that
explains why a thing is the way it is, and it does not turn every document into
a fixture. Context, rationale, and the sentence that tells a reader what to care
about carry no second copy of anything, so there is nothing for them to drift
from.

## Consequences

- Writing the binding test is when the drift is found, not a later audit. It
  also costs the prose its hedges, which is a gain: "its runners under
  `apps/worker/e2e/`" is not a claim a test can read, so it became the two
  directories that are actually prefixes, and the section had to say that
  exactly three directories out of the wider `apps/worker/src/services/` tree
  select the canary rather than gesturing at the tree. Both corrections were
  hiding under the hedge.
- A bound document fails `pnpm run test:ci`, which the `source-checks` job runs
  on every pull request, so a code change that moves the underlying list turns
  that pull request red rather than misleading a reader a month later. The
  author then picks which half was wrong: update the document, or put the code
  back.
- The binding runs over a named section, not the whole file. A test that read
  the whole document would let a coincidental mention anywhere satisfy it.
- The rule reaches past documents to anything that restates a set. The root
  test scripts now name the packages they run, and
  `scripts/ci/verify-changed.test.ts` holds each named list equal to the set of
  packages that own that script, so adding a package to a run is a deliberate
  edit and leaving one out is a failing test rather than a silent opt out.
- Not every copy earns a test, and the ones that do not are the ones that
  become option 1. That is the intended pressure: a copy that would be
  expensive to bind is a copy that should have been a pointer.

## Options considered

**Forbid the copy outright and always point at the code.** Rejected for the
reader it abandons. Somebody configuring a deployment is following a procedure,
and "open `scripts/ci/engine-canary-scope.ts` and read the array" in the middle
of one is a worse document, which is how the copy came to be written in the
first place. The rule has to survive that reader rather than wish them away.

**Generate the section from the source at build time.** Rejected. It removes
the drift and the prose with it: a generated list cannot say which three
directories out of a larger tree are on it and why, which is the part of that
section a reader actually needs. A test permits prose that a generator cannot.
