import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_WORKFLOW_COMMENT_MARKER,
  PullRequestUnreadableError,
  reviewFindingMarker,
  reviewHeadMarker,
  reviewLedgerFailureMarker,
  reviewLedgerMarker,
  reviewSummaryMarker,
  type PRReviewPublication,
} from "@integrations/sdk";
import { bitbucketHandleIdentity } from "./checks";
import { fakeBitbucket, FAKE_TOKEN, FULL_HEAD, json, on, type Route } from "./test-support";
import { BitbucketAdapter, patchesByPath } from "./vcs";

const REPO = "/repositories/workspace_name/repo_name";
const PR = `${REPO}/pullrequests/1`;

function adapter(routes: Route[], options: { botLogin?: string } = {}) {
  const { ctx, sent } = fakeBitbucket(routes);
  const vcs = new BitbucketAdapter({
    http: ctx.http,
    token: FAKE_TOKEN,
    workspace: "workspace_name",
    repoPath: "workspace_name/repo_name",
    baseBranch: "main",
    ...(options.botLogin ? { botLogin: options.botLogin } : {}),
    log: ctx.log,
  });
  return { vcs, sent };
}

const writes = (sent: ReadonlyArray<{ method: string; path: string }>) =>
  sent.filter((request) => request.method !== "GET").map((request) => `${request.method} ${request.path}`);

const pullRequest = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  title: "Title of pull request",
  state: "OPEN",
  draft: false,
  author: { nickname: "user_name", uuid: "{u-1}" },
  source: { branch: { name: "branch2" }, commit: { hash: "d3022fc0ca3d" } },
  destination: { branch: { name: "main" }, commit: { hash: "ce5965ddd289" } },
  links: { html: { href: "https://bitbucket.org/workspace_name/repo_name/pull-requests/1" } },
  ...overrides,
});

const headRoutes = (statuses: unknown[] = [], pr = pullRequest()): Route[] => [
  on("GET", PR, () => json(200, pr)),
  on("GET", `${REPO}/commit/d3022fc0ca3d`, () => json(200, { hash: FULL_HEAD })),
  on("GET", `${REPO}/commit/${FULL_HEAD}/statuses?pagelen=100`, () => json(200, { values: statuses })),
];

test("every request carries the token as a Bearer credential, to api.bitbucket.org only", async () => {
  const { vcs, sent } = adapter(headRoutes());
  await vcs.getPRHead(1);
  assert.ok(sent.length > 0);
  for (const request of sent) {
    assert.equal(request.url.origin, "https://api.bitbucket.org");
    assert.equal(request.headers.get("authorization"), `Bearer ${FAKE_TOKEN}`);
  }
});

test("the head is the full commit, in core's states, red with every failed status but the gate's own", async () => {
  const { vcs } = adapter(
    headRoutes([
      { key: "build", name: "Build", state: "FAILED" },
      { key: "aiw-1", name: "AI Workflow / Review", state: "FAILED" },
      { key: "lint", name: "Lint", state: "INPROGRESS" },
    ]),
  );
  const head = await vcs.getPRHead(1);
  assert.equal(head.headSha, FULL_HEAD);
  assert.equal(head.headRef, "branch2");
  assert.equal(head.baseRef, "main");
  assert.equal(head.state, "open");
  assert.equal(head.checks?.state, "red");
  assert.deepEqual(head.checks?.failed.map((check) => check.name), ["Build"]);
  assert.ok(
    bitbucketHandleIdentity.sameHandle(
      head.checks!.failed[0]!.handle,
      structuredClone(head.checks!.failed[0]!.handle),
    ),
  );
});

test("a declined or superseded pull request is closed, a merged one merged", async () => {
  for (const [state, expected] of [
    ["DECLINED", "closed"],
    ["SUPERSEDED", "closed"],
    ["MERGED", "merged"],
  ] as const) {
    const { vcs } = adapter(headRoutes([], pullRequest({ state })));
    assert.equal((await vcs.getPRHead(1)).state, expected);
  }
});

test("a pull request this token can never read is unreadable; a refused token is thrown as it came", async () => {
  const missing = adapter([on("GET", PR, () => json(404, { error: { message: "Not found" } }))]);
  await assert.rejects(missing.vcs.getPRHead(1), PullRequestUnreadableError);
  const refused = adapter([on("GET", PR, () => json(401, { error: { message: "Unauthorized" } }))]);
  await assert.rejects(refused.vcs.getPRHead(1), (error: Error) => !(error instanceof PullRequestUnreadableError));
  const scopes = adapter([
    on("GET", PR, () => json(403, { error: { message: "Your credentials lack one or more required privilege scopes." } })),
  ]);
  await assert.rejects(scopes.vcs.getPRHead(1), (error: Error) => !(error instanceof PullRequestUnreadableError));
});

test("opens a pull request from the branch into the base branch", async () => {
  const { vcs, sent } = adapter([
    on("POST", `${REPO}/pullrequests`, () => json(201, pullRequest({ id: 7, links: { html: { href: "https://bitbucket.org/x/7" } } }))),
  ]);
  assert.deepEqual(await vcs.createPR("feature/x", "Add x", "Body"), {
    id: 7,
    url: "https://bitbucket.org/x/7",
    branch: "feature/x",
  });
  assert.deepEqual(JSON.parse(sent[0]!.body), {
    title: "Add x",
    description: "Body",
    source: { branch: { name: "feature/x" } },
    destination: { branch: { name: "main" } },
  });
});

test("finds the open pull request from a branch with a BBQL filter it quotes", async () => {
  const { vcs, sent } = adapter([(request) => (request.path.startsWith(`${REPO}/pullrequests?`) ? json(200, { values: [pullRequest()] }) : undefined)]);
  assert.equal((await vcs.findPR('weird"branch'))?.id, 1);
  assert.equal(
    sent[0]!.url.searchParams.get("q"),
    'source.branch.name="weird\\"branch" AND destination.branch.name="main" AND state="OPEN"',
  );
});

test("pushes files as one commit on the branch, paths led by a slash so none reads as metadata", async () => {
  const { vcs, sent } = adapter([on("POST", `${REPO}/src`, () => new Response(null, { status: 201 }))]);
  await vcs.push("feature/x", [
    { path: "message", content: "a file called message" },
    { path: "src/a.ts", content: "export {};\n" },
  ], { message: "Implement" });
  const form = new URLSearchParams(sent[0]!.body);
  assert.equal(sent[0]!.headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.equal(form.get("message"), "Implement");
  assert.equal(form.get("branch"), "feature/x");
  assert.equal(form.get("/message"), "a file called message");
  assert.equal(form.get("/src/a.ts"), "export {};\n");
});

test("refuses a merge-commit push rather than drop its second parent", async () => {
  const { vcs, sent } = adapter([]);
  await assert.rejects(
    vcs.push("b", [{ path: "a", content: "" }], { mergeParentSha: "abc" }),
    (error: Error) => error.name === "FatalError",
  );
  assert.equal(sent.length, 0);
});

test("creates a branch from the base commit, and says existing for one that is already there", async () => {
  const base = on("GET", `${REPO}/refs/branches/main`, () => json(200, { target: { hash: FULL_HEAD } }));
  const fresh = adapter([base, on("POST", `${REPO}/refs/branches`, () => json(201, { name: "ai/x" }))]);
  assert.equal(await fresh.vcs.createBranchIfMissing("ai/x", "main"), "created");
  assert.deepEqual(JSON.parse(fresh.sent.at(-1)!.body), { name: "ai/x", target: { hash: FULL_HEAD } });

  const taken = adapter([
    base,
    on("POST", `${REPO}/refs/branches`, () => json(400, { error: { message: "BRANCH_ALREADY_EXISTS" } })),
    on("GET", `${REPO}/refs/branches/ai/x`, () => json(200, { target: { hash: "f".repeat(40) } })),
  ]);
  assert.equal(await taken.vcs.createBranchIfMissing("ai/x", "main"), "existing");
  assert.deepEqual(writes(taken.sent), [`POST ${REPO}/refs/branches`]);
});

test("seeds an empty repository's base branch, and refuses a base branch a non-empty one lacks", async () => {
  let seeded = false;
  const empty = adapter([
    on("GET", `${REPO}/refs/branches/main`, () =>
      seeded ? json(200, { target: { hash: FULL_HEAD } }) : json(404, { error: { message: "not found" } }),
    ),
    on("GET", `${REPO}/refs/branches?pagelen=1`, () => json(200, { values: [] })),
    on("POST", `${REPO}/src`, () => {
      seeded = true;
      return new Response(null, { status: 201 });
    }),
    on("POST", `${REPO}/refs/branches`, () => json(201, {})),
  ]);
  assert.equal(await empty.vcs.createBranchIfMissing("ai/x", "main"), "created");
  assert.equal(new URLSearchParams(empty.sent.find((r) => r.path === `${REPO}/src`)!.body).get("branch"), "main");

  const elsewhere = adapter([
    on("GET", `${REPO}/refs/branches/main`, () => json(404, {})),
    on("GET", `${REPO}/refs/branches?pagelen=1`, () => json(200, { values: [{ name: "develop" }] })),
  ]);
  await assert.rejects(elsewhere.vcs.createBranchIfMissing("ai/x", "main"), /has no branch main/u);
  assert.deepEqual(writes(elsewhere.sent), []);
});

test("resetting an owned branch deletes and recreates it, past a delete that already landed", async () => {
  const { vcs, sent } = adapter([
    on("GET", `${REPO}/refs/branches/main`, () => json(200, { target: { hash: FULL_HEAD } })),
    on("DELETE", `${REPO}/refs/branches/ai/x`, () => json(404, {})),
    on("POST", `${REPO}/refs/branches`, () => json(201, {})),
  ]);
  await vcs.resetOwnedBranch("ai/x", "main");
  assert.deepEqual(writes(sent), [`DELETE ${REPO}/refs/branches/ai/x`, `POST ${REPO}/refs/branches`]);
});

test("a branch Bitbucket reports missing is null; any other failure is not taken for missing", async () => {
  const missing = adapter([on("GET", `${REPO}/refs/branches/x`, () => json(404, {}))]);
  assert.equal(await missing.vcs.getBranchShaIfExists("x"), null);
  const failing = adapter([on("GET", `${REPO}/refs/branches/x`, () => json(500, {}))]);
  await assert.rejects(failing.vcs.getBranchShaIfExists("x"));
});

const comment = (id: number, fields: Record<string, unknown>) => ({
  id,
  content: { raw: "" },
  user: { nickname: "reviewer", display_name: "Reviewer", uuid: "{reviewer}", type: "user" },
  created_on: `2026-11-10T10:0${id}:00+00:00`,
  ...fields,
});
const BOT = { display_name: "ai-workflow-token", uuid: "{bot}", type: "user" };

test("review threads are top-level comments with their replies, unresolved only, the bot known by its configured name", async () => {
  const { vcs } = adapter(
    [
      on("GET", `${PR}/comments?pagelen=100`, () =>
        json(200, {
          values: [
            comment(1, { content: { raw: "Rename this" }, inline: { path: "a.ts", to: 3 } }),
            comment(2, { content: { raw: `Done.\n\n${reviewLedgerMarker("1")}` }, user: BOT, parent: { id: 1 } }),
            comment(3, { content: { raw: "Resolved already" }, resolution: { type: "comment_resolution" } }),
            comment(4, { content: { raw: "Why?" } }),
            comment(5, { content: { raw: "draft" }, pending: true }),
            // Our own failure note, standing alone: bookkeeping, never a thread to answer.
            comment(6, { content: { raw: `The round failed.

${reviewLedgerFailureMarker("run-1")}` }, user: BOT }),
          ],
        }),
      ),
      on("GET", "/user", () => json(403, { error: { message: "scopes" } })),
    ],
    { botLogin: "ai-workflow-token" },
  );
  const feed = await vcs.listReviewThreads(1);
  assert.deepEqual(
    feed.threads.map((thread) => [thread.alias, thread.threadId, thread.source, thread.awaitingHuman, thread.filePath ?? null]),
    [
      ["T1", "4", "human", false, null],
      ["T2", "1", "human", true, "a.ts"],
    ],
  );
  assert.equal(feed.threads[1]!.line, 3);
  assert.deepEqual(feed.threads[1]!.notes.map((note) => note.isLedgerReply), [false, true]);
});

test("settling replies under the thread and resolves it; a reply already there is not posted twice", async () => {
  const thread = { threadId: "4", alias: "T1", source: "human" as const, resolvable: true };
  const settled = adapter(
    [
      on("GET", `${PR}/comments?pagelen=100`, () => json(200, { values: [comment(4, { content: { raw: "Why?" } })] })),
      on("GET", "/user", () => json(200, { uuid: "{bot}" })),
      on("POST", `${PR}/comments`, () => json(201, { id: 9 })),
      on("POST", `${PR}/comments/4/resolve`, () => json(200, {})),
    ],
  );
  const result = await settled.vcs.settleReviewThread({
    prId: 1,
    thread,
    body: `Because.\n\n${reviewLedgerMarker("4")}`,
    resolve: true,
    snapshotAt: "2026-11-10T11:00:00Z",
  });
  assert.equal(result.action, "replied_and_resolved");
  assert.deepEqual(writes(settled.sent), [`POST ${PR}/comments`, `POST ${PR}/comments/4/resolve`]);
  assert.deepEqual(JSON.parse(settled.sent.find((r) => r.method === "POST")!.body).parent, { id: 4 });

  const again = adapter([
    on("GET", `${PR}/comments?pagelen=100`, () =>
      json(200, {
        values: [
          comment(4, { content: { raw: "Why?" } }),
          comment(5, { content: { raw: `Because.\n\n${reviewLedgerMarker("4")}` }, user: BOT, parent: { id: 4 } }),
        ],
      }),
    ),
    on("GET", "/user", () => json(200, { uuid: "{bot}" })),
  ]);
  const repeat = await again.vcs.settleReviewThread({
    prId: 1,
    thread,
    body: "x",
    resolve: true,
    snapshotAt: "2026-11-10T11:00:00Z",
  });
  assert.equal(repeat.action, "skipped_existing_reply");
  assert.deepEqual(writes(again.sent), []);
});

const publication = (overrides: Partial<PRReviewPublication> = {}): PRReviewPublication => ({
  idempotencyKey: "round-1",
  commentFindingDigests: ["d1"],
  headSha: FULL_HEAD,
  decision: "request_changes",
  summary: "One finding.",
  comments: [{ path: "a.ts", body: "Off by one.", startLine: 2, endLine: 4 }],
  ...overrides,
});

test("a review posts each new finding inline with its marker, one summary, and the decision", async () => {
  const { vcs, sent } = adapter([
    on("GET", `${PR}/comments?pagelen=100`, () => json(200, { values: [] })),
    ...headRoutes(),
    on("POST", `${PR}/comments`, (request) =>
      json(201, { id: JSON.parse(request.body).inline ? 11 : 12 }),
    ),
    on("DELETE", `${PR}/approve`, () => new Response(null, { status: 204 })),
    on("POST", `${PR}/request-changes`, () => json(200, {})),
  ]);
  const result = await vcs.publishPRReview(1, publication());
  assert.deepEqual(result, { id: "12", commentIds: ["11"] });
  const posted = sent.filter((r) => r.method === "POST" && r.path === `${PR}/comments`).map((r) => JSON.parse(r.body));
  assert.deepEqual(posted[0]!.inline, { path: "a.ts", to: 4, start_to: 2 });
  assert.ok(posted[0]!.content.raw.includes(reviewFindingMarker("d1")));
  assert.ok(posted[1]!.content.raw.includes(reviewHeadMarker(FULL_HEAD)));
  assert.ok(posted[1]!.content.raw.includes(AI_WORKFLOW_COMMENT_MARKER));
  assert.deepEqual(writes(sent).slice(-2), [`DELETE ${PR}/approve`, `POST ${PR}/request-changes`]);
});

test("a review of a head already published posts nothing new", async () => {
  const summary = comment(12, {
    user: BOT,
    content: { raw: `One finding.\n\n${reviewSummaryMarker("round-1")}\n\n${reviewHeadMarker(FULL_HEAD)}` },
  });
  const { vcs, sent } = adapter([
    on("GET", `${PR}/comments?pagelen=100`, () => json(200, { values: [summary] })),
    on("DELETE", `${PR}/approve`, () => new Response(null, { status: 204 })),
    on("POST", `${PR}/request-changes`, () => json(200, {})),
  ]);
  const result = await vcs.publishPRReview(1, publication());
  assert.equal(result.id, "12");
  assert.ok(!writes(sent).some((write) => write.endsWith("/comments")));
});

test("a review of a head that moved is refused", async () => {
  const { vcs } = adapter([
    on("GET", `${PR}/comments?pagelen=100`, () => json(200, { values: [] })),
    ...headRoutes(),
  ]);
  await assert.rejects(vcs.publishPRReview(1, publication({ headSha: "0".repeat(40) })), /no longer matches/u);
});

test("a gate status is a build status under one stable key, updated in Bitbucket's states", async () => {
  const { vcs, sent } = adapter([
    on("POST", `${REPO}/commit/${FULL_HEAD}/statuses/build`, () => json(201, {})),
  ]);
  const ref = await vcs.createGateStatus("AI Workflow / Review", FULL_HEAD);
  await vcs.updateGateStatus(ref, { status: "completed", conclusion: "failure", summary: "x".repeat(400) });
  const [created, updated] = sent.map((request) => JSON.parse(request.body));
  assert.equal(created.state, "INPROGRESS");
  assert.equal(created.key, updated.key);
  assert.match(created.key, /^aiw-[0-9a-f]{32}$/u);
  assert.equal(updated.state, "FAILED");
  assert.equal(updated.description.length, 255);
  assert.equal(created.url, `https://bitbucket.org/workspace_name/repo_name/commits/${FULL_HEAD}`);
});

test("gate details replace the commit's Code Insights report and its annotations, 100 a request", async () => {
  const report = (key: string) => `${REPO}/commit/${FULL_HEAD}/reports/${key}`;
  const { vcs, sent } = adapter([
    on("POST", `${REPO}/commit/${FULL_HEAD}/statuses/build`, () => json(201, {})),
    (request) => (request.path.includes("/reports/") ? json(200, {}) : undefined),
  ]);
  const ref = await vcs.createGateStatus("AI Workflow / Review", FULL_HEAD);
  const key = JSON.parse(sent[0]!.body).key as string;
  await vcs.updateGateStatusDetails(ref, {
    status: "completed",
    conclusion: "success",
    details: "All good",
    annotations: Array.from({ length: 150 }, (_, index) => ({
      path: "a.ts",
      startLine: index + 1,
      endLine: index + 1,
      annotationLevel: "warning" as const,
      message: `note ${index}`,
    })),
  });
  assert.deepEqual(writes(sent).slice(2), [
    `DELETE ${report(key)}`,
    `PUT ${report(key)}`,
    `POST ${report(key)}/annotations`,
    `POST ${report(key)}/annotations`,
  ]);
  const put = JSON.parse(sent.find((r) => r.method === "PUT")!.body);
  assert.equal(put.result, "PASSED");
  assert.equal(put.details, "All good");
  const chunks = sent.filter((r) => r.path.endsWith("/annotations")).map((r) => JSON.parse(r.body));
  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 50]);
  assert.equal(chunks[1][49].external_id, `${key}-150`);
  assert.equal(chunks[0][0].severity, "MEDIUM");
});

test("check results are the head's build statuses", async () => {
  const { vcs } = adapter(headRoutes([{ key: "b", name: "Build", state: "SUCCESSFUL" }, { key: "s", state: "STOPPED" }]));
  assert.deepEqual(await vcs.getCheckRunResults(1), [
    { name: "Build", status: "completed", conclusion: "success" },
    { name: "s", status: "completed", conclusion: "cancelled" },
  ]);
});

test("changed files come from the diffstat, each with its hunks from the diff", async () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "index 1..2 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "",
  ].join("\n");
  const { vcs } = adapter([
    on("GET", `${PR}/diffstat?pagelen=100`, () =>
      json(200, {
        values: [
          { status: "modified", lines_added: 1, lines_removed: 1, old: { path: "a.ts" }, new: { path: "a.ts" } },
          { status: "removed", lines_added: 0, lines_removed: 1, old: { path: "gone.txt" }, new: null },
        ],
      }),
    ),
    on("GET", `${PR}/diff`, () => new Response(diff, { status: 200, headers: { "content-type": "text/plain" } })),
  ]);
  assert.deepEqual(await vcs.listPRFiles(1), [
    { path: "a.ts", additions: 1, deletions: 1, changeType: "modified", patch: "@@ -1 +1 @@\n-old\n+new" },
    { path: "gone.txt", additions: 0, deletions: 1, changeType: "removed", patch: "@@ -1 +0,0 @@\n-bye" },
  ]);
  assert.equal(patchesByPath("diff --git a/bin b/bin\nBinary files differ\n").size, 0);
});

test("conflicts are the pull request's file conflicts", async () => {
  const { vcs } = adapter([on("GET", `${PR}/conflicts`, () => json(200, { values: [{ path: "a.ts" }] }))]);
  assert.equal(await vcs.getPRConflictStatus(1), true);
});

test("lists every repository of the workspace across pages, and never follows a link off the API", async () => {
  const { vcs } = adapter([
    on("GET", "/repositories/workspace_name?pagelen=100", () =>
      json(200, {
        values: [{ full_name: "workspace_name/a", is_private: true, mainbranch: { name: "main" }, workspace: { slug: "workspace_name" } }],
        next: "https://api.bitbucket.org/2.0/repositories/workspace_name?pagelen=100&page=2",
      }),
    ),
    on("GET", "/repositories/workspace_name?pagelen=100&page=2", () =>
      json(200, { values: [{ full_name: "workspace_name/b", is_private: false, description: "B" }] }),
    ),
  ]);
  const repositories = await vcs.listRepositories();
  assert.deepEqual(
    repositories.map((repository) => [repository.provider, repository.repoPath, repository.defaultBranch, repository.private]),
    [
      ["bitbucket", "workspace_name/a", "main", true],
      ["bitbucket", "workspace_name/b", "", false],
    ],
  );
  const hostile = adapter([
    on("GET", "/repositories/workspace_name?pagelen=100", () =>
      json(200, { values: [], next: "https://evil.example/steal" }),
    ),
  ]);
  await assert.rejects(hostile.vcs.listRepositories(), /outside/u);
  assert.equal(hostile.sent.length, 1);
});

test("reads a pull request link on bitbucket.org and nothing else", () => {
  const { vcs } = adapter([]);
  assert.deepEqual(vcs.parsePullRequestUrl(new URL("https://bitbucket.org/ws/repo/pull-requests/12/diff")), {
    repoPath: "ws/repo",
    prNumber: 12,
  });
  assert.equal(vcs.parsePullRequestUrl(new URL("https://bitbucket.org/ws/repo/src/main")), null);
  assert.equal(vcs.parsePullRequestUrl(new URL("https://gitlab.example/ws/repo/pull-requests/12")), null);
});

test("git authenticates as x-token-auth with the access token", async () => {
  const { vcs } = adapter([]);
  const credentials = await vcs.sandboxCredentials();
  assert.equal(credentials.host, "https://bitbucket.org");
  assert.equal(credentials.authUser, "x-token-auth");
  assert.equal(credentials.token, FAKE_TOKEN);
});
