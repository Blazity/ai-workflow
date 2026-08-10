import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LOCAL_SOURCE_NOTE,
  LocalSkillDiscovery,
  SkillImport,
  SkillReplacementNotice,
} from "./skill-import";
import type { HarnessLocalSkillDiscoveryResponse } from "@shared/contracts";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function localDiscovery(discovery: HarnessLocalSkillDiscoveryResponse) {
  return renderToStaticMarkup(
    <LocalSkillDiscovery
      discovery={discovery}
      selected={[]}
      disabled={false}
      onToggle={() => undefined}
    />,
  );
}

test("GitHub skill import opens as the approved three-step exact-pin drawer", () => {
  const html = renderToStaticMarkup(
    <SkillImport
      open
      disabled={false}
      pinned={[]}
      onClose={() => undefined}
      onImported={() => undefined}
    />,
  );

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /1\. Source/);
  assert.match(html, /2\. Discover/);
  assert.match(html, /3\. Review/);
  assert.match(html, /owner\/repository/);
  assert.match(html, /organization GitHub App/);
  assert.match(html, /exact commit/);
});

test("the drawer offers both skill sources", () => {
  const html = renderToStaticMarkup(
    <SkillImport
      open
      disabled={false}
      pinned={[]}
      onClose={() => undefined}
      onImported={() => undefined}
    />,
  );
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /GitHub repository/);
  assert.match(html, /This deployment/);
});

test("the local source note describes freezing, not a self-updating skill", () => {
  assert.match(
    LOCAL_SOURCE_NOTE,
    /an imported skill is frozen at the contents it had/,
  );
  assert.match(
    LOCAL_SOURCE_NOTE,
    /use Refresh on the skill and publish the profile again/,
  );
  assert.doesNotMatch(LOCAL_SOURCE_NOTE, /change with the next deployment/);
});

test("a deployment with no directory reads differently from one that skipped everything", () => {
  const absent = localDiscovery({
    directoryPresent: false,
    skills: [],
    skipped: [],
  });
  const allSkipped = localDiscovery({
    directoryPresent: true,
    skills: [],
    skipped: [
      { path: "review", reason: "SKILL.md is missing" },
      { path: "triage", reason: "Description is longer than 1024 characters" },
    ],
  });

  assert.notEqual(absent, allSkipped);
  assert.match(absent, /carries no skills\/ directory/);
  assert.match(absent, /skills\/\n {2}review-checklist\/\n {4}SKILL\.md/);
  assert.match(absent, /name: review-checklist/);
  assert.match(absent, /description: House rules/);
  assert.doesNotMatch(absent, /none of its entries can be offered/);
  assert.match(allSkipped, /none of its entries can be offered/);
  assert.doesNotMatch(allSkipped, /carries no skills\/ directory/);
  assert.match(allSkipped, /Skipped 2 directories/);
  assert.match(allSkipped, /SKILL\.md is missing/);
  assert.match(allSkipped, /Description is longer than 1024 characters/);
});

test("offerable deployment skills are listed with their directory", () => {
  const html = localDiscovery({
    directoryPresent: true,
    skills: [
      {
        name: "review-checklist",
        path: "review-checklist",
        description: "House review rules",
        artifactHash: "a".repeat(64),
      },
    ],
    skipped: [{ path: "draft", reason: "SKILL.md is missing" }],
  });

  assert.match(html, /review-checklist/);
  assert.match(html, /House review rules/);
  assert.match(html, /skills\/review-checklist/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /Skipped 1 directory/);
  assert.doesNotMatch(html, /carries no skills\/ directory/);
  assert.doesNotMatch(html, /none of its entries can be offered/);
});

test("a deployment skill taking over a GitHub name says whose pin it takes", () => {
  const pinned = [
    {
      name: "review-checklist",
      artifactHash: "a".repeat(64),
      sourceLabel: "blazity/ai-workflow @ cccccccccccc",
    },
  ];

  const collides = renderToStaticMarkup(
    <SkillReplacementNotice
      incoming={[{ name: "review-checklist", artifactHash: "b".repeat(64) }]}
      pinned={pinned}
    />,
  );
  const distinct = renderToStaticMarkup(
    <SkillReplacementNotice
      incoming={[{ name: "release-notes", artifactHash: "b".repeat(64) }]}
      pinned={pinned}
    />,
  );
  const identical = renderToStaticMarkup(
    <SkillReplacementNotice
      incoming={[{ name: "review-checklist", artifactHash: "a".repeat(64) }]}
      pinned={pinned}
    />,
  );

  assert.match(collides, /Replaces 1 pinned skill/);
  assert.match(collides, /review-checklist/);
  assert.match(collides, /takes over the pin held by/);
  assert.match(collides, /blazity\/ai-workflow @ cccccccccccc/);
  assert.match(collides, /name in their SKILL\.md/);
  assert.equal(distinct, "");
  assert.equal(identical, "");
});

test("a replaced pin with no source on record still names what happens", () => {
  const html = renderToStaticMarkup(
    <SkillReplacementNotice
      incoming={[{ name: "review-checklist" }]}
      pinned={[
        {
          name: "review-checklist",
          artifactHash: "a".repeat(64),
          sourceLabel: null,
        },
      ]}
    />,
  );

  assert.match(html, /takes over the pin held by a source no longer on record/);
});

test("closed GitHub skill import renders nothing", () => {
  const html = renderToStaticMarkup(
    <SkillImport
      open={false}
      disabled={false}
      pinned={[]}
      onClose={() => undefined}
      onImported={() => undefined}
    />,
  );
  assert.equal(html, "");
});
