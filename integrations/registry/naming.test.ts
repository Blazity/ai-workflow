// How a change request and a capability are named, read off the manifests and
// the SDK's table rather than written in core.
import assert from "node:assert/strict";
import test from "node:test";

import type { IntegrationManifest } from "@integrations/sdk";

import { capabilityLabel, changeRequestNaming } from "./index";

/** Two made-up providers, so the rule is driven by declarations and not by
 *  whichever two this build happens to ship. */
const HUB = {
  id: "hub",
  repositories: { changeRequest: { noun: "PR", referencePrefix: "#", linkSegment: "/pull/" } },
} as unknown as IntegrationManifest;
const LAB = {
  id: "lab",
  repositories: {
    changeRequest: { noun: "MR", referencePrefix: "!", linkSegment: "/-/merge_requests/" },
  },
} as unknown as IntegrationManifest;
const NO_LINK_SHAPE = {
  id: "forge",
  repositories: { changeRequest: { noun: "CR", referencePrefix: "~" } },
} as unknown as IntegrationManifest;

test("a change request is named in its provider's own words", () => {
  // On GitLab `#51` names issue 51; the merge request is `!51`. The words come
  // from each shipped provider's manifest, so core names no provider.
  assert.deepEqual(
    changeRequestNaming({
      provider: "gitlab",
      id: 51,
      url: "https://gitlab.example/acme/app/-/merge_requests/51",
    }),
    { noun: "MR", reference: "!51" },
  );
  assert.deepEqual(
    changeRequestNaming({ provider: "github", id: 12, url: "https://github.com/acme/app/pull/12" }),
    { noun: "PR", reference: "#12" },
  );
});

test("a row that recorded no provider is named by the link it stored", () => {
  assert.deepEqual(
    changeRequestNaming({ provider: "", id: 18, url: "https://gitlab.com/acme/api/-/merge_requests/18" }),
    { noun: "MR", reference: "!18" },
  );
});

test("a change request no provider claims reads as a pull request", () => {
  assert.deepEqual(
    changeRequestNaming({ provider: "", id: 7, url: "https://code.example/acme/app/changes/7" }),
    { noun: "PR", reference: "#7" },
  );
});

test("the most specific link shape wins over a shorter one it happens to contain", () => {
  // A GitLab project called `pull` carries GitHub's `/pull/` in its path.
  assert.deepEqual(
    changeRequestNaming(
      { provider: "", id: 3, url: "https://lab.example/acme/pull/-/merge_requests/3" },
      [HUB, LAB],
    ),
    { noun: "MR", reference: "!3" },
  );
});

test("a row whose provider this build no longer ships is still named by its link", () => {
  // The provider was recorded, then removed from the build. Reading only the
  // recorded id would turn a merge request into `PR #9`.
  assert.deepEqual(
    changeRequestNaming(
      { provider: "retired", id: 9, url: "https://lab.example/acme/app/-/merge_requests/9" },
      [HUB, LAB],
    ),
    { noun: "MR", reference: "!9" },
  );
});

test("a provider with no link shape of its own names what it records and nothing else", () => {
  assert.deepEqual(
    changeRequestNaming({ provider: "forge", id: 4, url: "https://forge.example/acme/app/4" }, [
      NO_LINK_SHAPE,
      HUB,
    ]),
    { noun: "CR", reference: "~4" },
  );
  assert.deepEqual(
    changeRequestNaming({ provider: "", id: 4, url: "https://forge.example/acme/app/4" }, [
      NO_LINK_SHAPE,
      HUB,
    ]),
    { noun: "PR", reference: "#4" },
  );
});

test("a capability is named from the SDK's table, and an unknown one is not guessed", () => {
  assert.equal(capabilityLabel("vcs"), "Version control");
  assert.equal(capabilityLabel("issue_tracker"), "Issue tracker");
  assert.equal(capabilityLabel("pagers"), null);
  assert.equal(capabilityLabel("toString"), null);
});
