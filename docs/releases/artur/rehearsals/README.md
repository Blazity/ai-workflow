# Artur release rehearsals

A rehearsal is one real end-to-end run on our own production instance, at the
exact source commit the release ships, against a repository whose pre-PR checks
have the same shape as the client's: a toolchain setup phase followed by long
running checks. The run must reach the **open pull request** node green.

**Sync Approved Artur Release** refuses to touch `Blazity/ai-workflow-arthur`
until a rehearsal record for the released version exists here and matches the
released commit. Two releases have already gone out over a red source `main`,
one of them broke the client, because snapshot integrity and an approved
release-note pull request were the only gates.

## Order of operations

The order is not free. `targetSourceCommit` is frozen into the release note's
YAML front matter when **Prepare Artur Release** runs, and the synchronization
gate compares the rehearsal against that frozen SHA. A rehearsal recorded
before preparation cannot match it, because merging the rehearsal record itself
moves the tip of `main`. Follow this sequence:

1. Run **Actions → Prepare Artur Release** for the version. It pins
   `targetSourceCommit` into `docs/releases/artur/<version>.md`.
2. Read the pinned SHA out of the front matter of that generated note. That is
   the SHA to rehearse, and nothing else passes the gate.
3. Deploy that exact SHA to our own production and run the rehearsal (below).
4. Commit `docs/releases/artur/rehearsals/<version>.json` with `sourceCommit`
   set to the pinned SHA, and merge it in its own pull request. It cannot ride
   along with the release note: `validate-source` requires the release-note
   pull request to change exactly one file, the note itself.
5. Merge the release-note pull request. That merge starts the synchronization,
   which reads the rehearsal record from `main` and finds both gates satisfied.

**Run preparation once.** Re-running it after other commits land moves the
pinned target, and a rehearsal recorded against the old target no longer
matches, so the synchronization aborts until you rehearse the new SHA.

## Running one

1. Make sure production runs a deployment built from the pinned SHA.
2. Dispatch a workflow on production against a fixture repository with real
   check commands, for example `Blazity/aiw-checks-fixture`. Its checks must
   install a toolchain and then run the real suite. Stub commands such as
   `echo ok` do not count, see the floor below.
3. Watch the run to the **open pull request** node. If it stops earlier, or
   stops on a clarification, there is no rehearsal: fix the cause and run again.
4. Read the duration of the checks phase from the run trace and record the run.

## Recording one

Write `docs/releases/artur/rehearsals/<version>.json`, with every field present
and no extra fields:

```json
{
  "version": "2026.08.8",
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
  "runId": "wrun_01K5NRQ8ABCDEF",
  "runUrl": "https://ai-workflow.blazity.com/runs/wrun_01K5NRQ8ABCDEF",
  "repository": "Blazity/aiw-checks-fixture",
  "checksDurationSec": 1180,
  "outcome": "success",
  "recordedAt": "2026-08-19T10:00:00Z",
  "recordedBy": "someone@blazity.com"
}
```

| Field | Meaning |
| --- | --- |
| `version` | The version being released, matching the file name. |
| `sourceCommit` | 40 lowercase hex characters, the pinned `targetSourceCommit`. |
| `runId` | The production run id, `wrun_...`. |
| `runUrl` | Absolute link to that run, so a reviewer can reopen it. |
| `repository` | `owner/name` of the rehearsed repository. |
| `checksDurationSec` | Whole seconds the checks phase took, from the trace. |
| `outcome` | Exactly `success`, nothing else passes. |
| `recordedAt` | ISO 8601 UTC timestamp, such as `2026-08-19T10:00:00Z`. |
| `recordedBy` | The person who ran the rehearsal and can answer for it. |

To check a record before merging anything:

```bash
pnpm release-notes validate-rehearsal --version <version> --source-commit <target_sha>
```

## Why checks must run at least 300 seconds

Vercel allows 300 seconds per invocation. The client outage came from a check
batch that outlived a single invocation, so a rehearsal that finishes inside
one invocation never reaches the failure mode that actually bit the client. A
run whose checks finished in 12 seconds because they were `echo ok` stubs
proves the pipeline can open a pull request and proves nothing else.

This is not hypothetical. The client configuration "worked" for weeks precisely
because its heaviest repository had no check commands configured at all, so
nothing ever ran long enough to cross the limit until it did.

A rehearsal below the floor is rejected. Do not lower the floor to make a
release pass: give the fixture repository checks that really take longer than
five minutes.

## Worked example of a run that must NOT be recorded

Run `wrun_01M0CGC9GEMEBC3THA2DNBECNJ` on our production reproduced the client
failure. Its `checks` node lived 358631 ms and then died with:

```
Step "step//./src/workflows/agent//runPrePrChecksStep" failed after 0 retries: terminated
```

358 seconds is above the 300 second floor, so duration alone would have let
this through. The run never reached the **open pull request** node, so its
`outcome` is not `success` and the gate rejects it. Duration proves the checks
were long enough to be worth believing; `outcome` proves they actually passed.
Both fields are required, and neither substitutes for the other. Recording this
run with `"outcome": "success"` would be a false statement about production,
and it is exactly the shape of release that broke the client.
