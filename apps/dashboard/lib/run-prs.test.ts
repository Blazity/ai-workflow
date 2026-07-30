import { test } from "node:test";
import assert from "node:assert/strict";
import { runPullRequests } from "./run-prs";

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

test("a legacy run without the list keeps its GitHub PR link", () => {
  assert.deepEqual(
    runPullRequests({
      prs: null,
      prUrl: "https://github.com/acme/storefront/pull/91",
      prNumber: 91,
    }),
    [
      {
        provider: "github",
        repoPath: "",
        id: 91,
        url: "https://github.com/acme/storefront/pull/91",
      },
    ],
  );
});

test("a legacy GitLab URL is recognised as a merge request", () => {
  assert.deepEqual(
    runPullRequests({
      prs: null,
      prUrl: "https://gitlab.com/acme/api/-/merge_requests/18",
      prNumber: 18,
    }),
    [
      {
        provider: "gitlab",
        repoPath: "",
        id: 18,
        url: "https://gitlab.com/acme/api/-/merge_requests/18",
      },
    ],
  );
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
