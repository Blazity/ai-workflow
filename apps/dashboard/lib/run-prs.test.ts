import { test } from "node:test";
import assert from "node:assert/strict";
import { pullRequestNaming, runPullRequests, soleVcsProvider } from "./run-prs";

test("a multi-repo run returns every PR/MR in stored order", () => {
  assert.deepEqual(
    runPullRequests({
      prs: [
        {
          provider: "github",
          repoPath: "acme/backend",
          id: 12,
          url: "https://github.com/acme/backend/pull/12",
        },
        {
          provider: "gitlab",
          repoPath: "acme/ops/infra",
          id: 3,
          url: "https://gitlab.com/acme/ops/infra/-/merge_requests/3",
        },
      ],
      prUrl: "https://github.com/acme/backend/pull/12",
      prNumber: 12,
    }),
    [
      {
        provider: "github",
        repoPath: "acme/backend",
        id: 12,
        url: "https://github.com/acme/backend/pull/12",
      },
      {
        provider: "gitlab",
        repoPath: "acme/ops/infra",
        id: 3,
        url: "https://gitlab.com/acme/ops/infra/-/merge_requests/3",
      },
    ],
  );
});

// A legacy row stored no provider, and this build ships more than one, so the
// entry carries none. It used to carry whichever provider core was written
// around, which put a provider's name on a run that may never have touched it.
test("a legacy run without the list keeps its PR link and claims no provider", () => {
  assert.deepEqual(
    runPullRequests({
      prs: null,
      prUrl: "https://github.com/acme/storefront/pull/91",
      prNumber: 91,
    }),
    [
      {
        provider: "",
        repoPath: "",
        id: 91,
        url: "https://github.com/acme/storefront/pull/91",
      },
    ],
  );
});

test("a legacy merge request URL keeps its link and is still read as an MR", () => {
  assert.deepEqual(
    runPullRequests({
      prs: null,
      prUrl: "https://gitlab.com/acme/api/-/merge_requests/18",
      prNumber: 18,
    }),
    [
      {
        provider: "",
        repoPath: "",
        id: 18,
        url: "https://gitlab.com/acme/api/-/merge_requests/18",
      },
    ],
  );
  // The noun a person reads comes from the link the row did store, matched
  // against the shape each provider declares, so losing the guessed provider
  // did not turn this link into a pull request.
  const [legacy] = runPullRequests({
    prs: null,
    prUrl: "https://gitlab.com/acme/api/-/merge_requests/18",
    prNumber: 18,
  });
  assert.deepEqual(pullRequestNaming(legacy!), { noun: "MR", reference: "!18" });
});

test("a deployment with one version control provider attributes a legacy row to it", () => {
  // The only deployment where the answer is knowable: one provider connected
  // means every row that predates the field came from it.
  assert.equal(soleVcsProvider(["forgejo"]), "forgejo");
  assert.equal(soleVcsProvider(["github", "gitlab"]), "");
  assert.equal(soleVcsProvider([]), "");
});

test("a run that opened nothing renders no links", () => {
  assert.deepEqual(runPullRequests({ prs: null, prUrl: null, prNumber: null }), []);
  assert.deepEqual(runPullRequests({ prs: [], prUrl: null, prNumber: null }), []);
});

test("a run with only half a legacy ref is not rendered as a broken link", () => {
  assert.deepEqual(
    runPullRequests({ prs: null, prUrl: "https://github.com/a/b/pull/4", prNumber: null }),
    [],
  );
});

test("a change request is named in its provider's own words", () => {
  // On GitLab `#51` names issue 51; the merge request is `!51`. The words come
  // from each provider's manifest, so core names no provider.
  assert.deepEqual(
    pullRequestNaming({
      provider: "gitlab",
      id: 51,
      url: "https://gitlab.example/acme/app/-/merge_requests/51",
    }),
    { noun: "MR", reference: "!51" },
  );
  assert.deepEqual(
    pullRequestNaming({ provider: "github", id: 12, url: "https://github.com/acme/app/pull/12" }),
    { noun: "PR", reference: "#12" },
  );
});

test("a change request no provider claims reads as a pull request", () => {
  assert.deepEqual(
    pullRequestNaming({ provider: "", id: 7, url: "https://code.example/acme/app/changes/7" }),
    { noun: "PR", reference: "#7" },
  );
});

test("the most specific link shape wins over a shorter one it happens to contain", () => {
  // A GitLab project called `pull` carries GitHub's `/pull/` in its path.
  const manifests = [
    { id: "hub", repositories: { changeRequest: { noun: "PR", referencePrefix: "#", linkSegment: "/pull/" } } },
    { id: "lab", repositories: { changeRequest: { noun: "MR", referencePrefix: "!", linkSegment: "/-/merge_requests/" } } },
  ] as unknown as Parameters<typeof pullRequestNaming>[1];
  assert.deepEqual(
    pullRequestNaming(
      { provider: "", id: 3, url: "https://lab.example/acme/pull/-/merge_requests/3" },
      manifests,
    ),
    { noun: "MR", reference: "!3" },
  );
});
