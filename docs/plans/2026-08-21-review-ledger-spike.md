# Review ledger spike: three facts before freezing the contract

Date: 2026-08-21

## Questions

- Q-A: Does replying to a plain (non-thread) GitLab MR note turn it into a resolvable thread?
- Q-B: Can we list GitHub PR review threads with ids and isResolved, reply into a thread, and resolve/unresolve it?
- Q-C: Does `trigger_pr_review` have a per-PR attempt/round limit field like `trigger_pr_checks_failed`'s `maxFixAttemptsPerPr`, and is the enforcement of that field trigger-type specific?

---

## Q-A: GitLab individual notes (project filipmaszota3/ai-workflow-integration-test, MR !11)

**Answer: yes, replying to an individual note turns it into a resolvable thread.**

Commands and trimmed responses:

```
$ glab api "projects/filipmaszota3%2Fai-workflow-integration-test/merge_requests/11/discussions?per_page=100"
# discussion for note 3714803578, before reply:
discussion_id: b5d5f955887ed21bc74e7118dee478d00b928a41
individual_note: True
note_id: 3714803578 resolvable: False resolved: None
```

```
$ glab api -X POST ".../merge_requests/11/discussions/b5d5f955887ed21bc74e7118dee478d00b928a41/notes" \
    -f body='Spike: ledger reply test. <!-- ai-workflow:ledger-spike -->'
# response:
id: 3715665039
resolvable: True
resolved: False
type: DiscussionNote
```

```
$ glab api ".../merge_requests/11/discussions?per_page=100"   # re-fetch
discussion_id: b5d5f955887ed21bc74e7118dee478d00b928a41
individual_note: False          # <- flipped from True to False
 note_id: 3714803578 resolvable: True resolved: False   # <- flipped from resolvable:False
 note_id: 3715665039 resolvable: True resolved: False
```

```
$ glab api -X PUT ".../discussions/b5d5f955887ed21bc74e7118dee478d00b928a41?resolved=true"
note_id: 3714803578 resolved: True resolved_by: filipmaszota3
note_id: 3715665039 resolved: True resolved_by: filipmaszota3

$ glab api -X PUT ".../discussions/b5d5f955887ed21bc74e7118dee478d00b928a41?resolved=false"   # restore
note_id: 3714803578 resolved: False
note_id: 3715665039 resolved: False
```

State was restored to unresolved after the test. `individual_note` stays `False` permanently (a reply is a one-way transition to a real discussion), the reply itself is what remains in the thread history.

---

## Q-B: GitHub review threads (repo Blazity/aiw-checks-fixture)

**Answer, per operation:**
- List threads with ids + isResolved: yes
- Reply into a thread: yes
- Resolve a thread: yes
- Unresolve a thread: yes

Exact calls that worked:

List (GraphQL), before any thread existed on PR #6:
```
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ id reviewThreads(first:10){ nodes{ id isResolved isOutdated path line comments(first:3){ nodes{ id databaseId author{login} body } } } } } } }' -f o=Blazity -f r=aiw-checks-fixture -F n=6
# -> reviewThreads.nodes: []
```

Create a thread (REST, since PR #6 had none yet):
```
gh api -X POST repos/Blazity/aiw-checks-fixture/pulls/6/comments \
  -f body='Spike: ledger thread test <!-- ai-workflow:ledger-spike -->' \
  -f commit_id=89dee24c5a92e437e5f538faca75b5f378f6c2af \
  -f path=genai-engine/ui/src/scoring.ts -F line=20 -f side=RIGHT
# -> id: 3829443872, node_id: PRRC_kwDOT9NmS87kQK0g
```

List again (GraphQL), thread now present:
```
{"data":{"repository":{"pullRequest":{"id":"PR_kwDOT9NmS88AAAABAgvevA",
  "reviewThreads":{"nodes":[{
    "id":"PRRT_kwDOT9NmS86bHySX","isResolved":false,"isOutdated":false,
    "path":"genai-engine/ui/src/scoring.ts","line":20,
    "comments":{"nodes":[{"id":"PRRC_kwDOT9NmS87kQK0g","databaseId":3829443872,
      "author":{"login":"outof-place"},
      "body":"Spike: ledger thread test <!-- ai-workflow:ledger-spike -->"}]}
  }]}}}}
```

The REST comment's `node_id` (`PRRC_kwDOT9NmS87kQK0g`) is NOT the thread id (`PRRT_kwDOT9NmS86bHySX`). The mapping: the REST comment's `node_id` shows up as `thread.comments.nodes[].id` inside the GraphQL thread object; `thread.id` (the `PRRT_...` prefix) is a distinct node that only GraphQL exposes.

Resolve / unresolve (GraphQL mutations, both worked):
```
gh api graphql -f query='mutation($t:ID!){ resolveReviewThread(input:{threadId:$t}){ thread{ id isResolved } } }' -f t=PRRT_kwDOT9NmS86bHySX
# -> {"data":{"resolveReviewThread":{"thread":{"id":"PRRT_kwDOT9NmS86bHySX","isResolved":true}}}}

gh api graphql -f query='mutation($t:ID!){ unresolveReviewThread(input:{threadId:$t}){ thread{ id isResolved } } }' -f t=PRRT_kwDOT9NmS86bHySX
# -> {"data":{"unresolveReviewThread":{"thread":{"id":"PRRT_kwDOT9NmS86bHySX","isResolved":false}}}}
```

Reply into the thread (REST, addressed to the original comment's databaseId, not the thread id):
```
gh api -X POST repos/Blazity/aiw-checks-fixture/pulls/6/comments/3829443872/replies \
  -f body='Spike: reply <!-- ai-workflow:ledger-spike -->'
# -> id: 3829445445, node_id: PRRC_kwDOT9NmS87kQLNF, in_reply_to_id: 3829443872
```

Thread was left `isResolved: false` (its original state) after the test. The spike comment and its reply remain on PR #6 (boundaries said not to delete anything).

---

## Q-C: code, `maxFixAttemptsPerPr` (read-only, no changes made)

**Answer: no, `trigger_pr_review` has no per-PR attempt/round limit field, and yes, the enforcement of `maxFixAttemptsPerPr` is hardcoded to the `trigger_pr_checks_failed` trigger type only.**

- `trigger_pr_checks_failed` (`apps/worker/src/workflow-definition/block-registry.ts:414`) has `defaults.maxFixAttemptsPerPr: 2` at `block-registry.ts:428`.
- `trigger_pr_review` (`apps/worker/src/workflow-definition/block-registry.ts:470`) has `defaults: { providers: ["github"], on: ["changes_requested"], scope: "workflow_owned" }` (`block-registry.ts:477-481`), no attempt or round limit field anywhere in that block (ends at `block-registry.ts:516`).
- Backing schema confirms the same asymmetry: `maxFixAttemptsPerPr` is defined twice in `apps/worker/src/workflow-definition/schema.ts:170` and `schema.ts:648`, both scoped to the checks-failed trigger's schema, never to the PR-review trigger's schema.
- Enforcement lives in `apps/worker/src/lib/dispatch-trigger.ts`:
  - `maxFixAttemptsPerPr()` helper reads and clamps the authored value, `dispatch-trigger.ts:499-507`.
  - `restrictivePrAutofixCap()` resolves the tightest cap across sibling nodes of one trigger type, `dispatch-trigger.ts:483-492`.
  - `prAutofixCapReached()` is the actual gate, and it opens with an explicit type check: `if (accepted.triggerType !== "trigger_pr_checks_failed") return false;` at `dispatch-trigger.ts:524`. Any other trigger type, including `trigger_pr_review`, short-circuits to "no cap reached" before the pinned definition is even loaded.
- `apps/worker/src/lib/trigger-events.ts` has zero references to `maxFixAttemptsPerPr` or the autofix cap (`grep -n "maxFixAttemptsPerPr\|PrAutofixCap\|autofix" apps/worker/src/lib/trigger-events.ts` returned nothing): that file plays no role in this enforcement path.

---

## Consequences for the contract

- A "work item per open thread" model can rely on GitLab discussion ids and GitHub thread node ids (`PRRT_...`) as stable ledger keys, but the two providers need different id shapes: GitLab exposes one flat discussion id per thread already, GitHub requires pairing a REST comment databaseId (for replying) with a separate GraphQL thread node id (for resolving), so the ledger's provider adapter needs to store both per work item on GitHub.
- Individual (non-thread) GitLab notes cannot be treated as already-resolvable work items until the bot's first reply lands: the ledger should either post the reply first and only then check `resolvable`, or model "individual note" as a distinct work-item state that becomes resolvable after the first bot turn.
- The ledger cannot reuse `maxFixAttemptsPerPr` as a generic per-PR round budget for review-thread work items: today it is wired exclusively to `trigger_pr_checks_failed`. If the ledger wants a round cap for `trigger_pr_review`-driven fixes too, that requires either a new field on `trigger_pr_review`'s defaults/schema or generalizing `prAutofixCapReached` beyond its current single-trigger-type gate.
