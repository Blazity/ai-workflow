import { test } from "node:test";
import assert from "node:assert/strict";
import { primaryPullRequestLabel, runPullRequests, soleVcsProvider } from "./run-prs";

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
  // The noun a person reads comes from the URL the row did store, so losing the
  // guessed provider did not turn this link into a pull request.
  assert.equal(
    primaryPullRequestLabel({
      prs: null,
      prUrl: "https://gitlab.com/acme/api/-/merge_requests/18",
      prNumber: 18,
    }),
    "MR !18",
  );
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

test("the primary reference uses the provider's noun and punctuation", () => {
  assert.equal(
    primaryPullRequestLabel({
      prs: [{
        provider: "gitlab",
        repoPath: "acme/app",
        id: 51,
        url: "https://gitlab.example/acme/app/-/merge_requests/51",
      }],
      prUrl: "https://gitlab.example/acme/app/-/merge_requests/51",
      prNumber: 51,
    }),
    "MR !51",
  );
});
