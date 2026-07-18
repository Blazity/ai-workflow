import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const htmlPath = new URL("./index.html", import.meta.url);
const html = await readFile(htmlPath, "utf8");
const supportingSpec = await readFile(
  new URL(
    "../superpowers/specs/2026-07-07-workflow-workspace-design.md",
    import.meta.url,
  ),
  "utf8",
);
const revisionSpec = await readFile(
  new URL(
    "../superpowers/specs/2026-07-17-workflows-revisions-design.md",
    import.meta.url,
  ),
  "utf8",
);

function loadCanvasData() {
  const source = html.match(
    /const GROUPS = \{[\s\S]*?(?=\n\s*\/\* ={10,}\n\s*ENGINE)/,
  )?.[0];

  assert.ok(source, "canvas content data should be extractable from index.html");

  const context = {};
  vm.runInNewContext(
    `${source}\nglobalThis.__canvas = { BLOCKS, FRAMES };`,
    context,
  );
  return context.__canvas;
}

test("draws one canonical remediation board driven by external CI and review events", () => {
  const { BLOCKS, FRAMES } = loadCanvasData();
  const remediationFrames = FRAMES.filter(({ slug }) =>
    ["v4-review-fix", "pr-remediation-events"].includes(slug),
  );
  const frame = remediationFrames[0];

  assert.deepEqual(
    Array.from(remediationFrames, ({ slug }) => slug),
    ["v4-review-fix"],
    "the lifecycle explainer must not duplicate the canonical remediation board",
  );
  assert.equal(BLOCKS["trig.pr-head-updated"], undefined);
  assert.equal(BLOCKS["util.pr-validation"], undefined);
  assert.equal(BLOCKS["vcs.publish-pr-status"], undefined);

  const eventEdges = frame.edges.filter(({ boundary }) => boundary === "event");
  const outsideEventNodeIds = new Set(eventEdges.map(({ to }) => to));
  const explainedWorkflowNodes = frame.nodes.filter(({ id }) => !outsideEventNodeIds.has(id));
  const canonicalTypes = [
    "trig.pr-checks-failed",
    "trig.pr-review",
    "vcs.fetch-context",
    "agent.fix",
    "ws.finalize",
    "vcs.pr-comment",
  ];

  assert.deepEqual(
    Array.from(explainedWorkflowNodes, ({ type }) => type),
    canonicalTypes,
    "the one remediation board should contain the canonical workflow exactly once",
  );
  const edgeContracts = (flow) => {
    const typeById = new Map(flow.nodes.map(({ id, type }) => [id, type]));
    return Array.from(flow.edges)
      .filter(({ boundary }) => boundary !== "event")
      .map(({ from, to, label }) => ({
        from: typeById.get(from),
        to: typeById.get(to),
        ...(label ? { label } : {}),
      }));
  };
  assert.deepEqual(edgeContracts(frame), [
    { from: "trig.pr-checks-failed", to: "vcs.fetch-context" },
    { from: "trig.pr-review", to: "vcs.fetch-context" },
    { from: "vcs.fetch-context", to: "agent.fix" },
    { from: "agent.fix", to: "ws.finalize", label: "status: fixed" },
    { from: "ws.finalize", to: "vcs.pr-comment" },
  ]);
  for (const node of frame.nodes) {
    assert.equal(node.title, undefined, `${node.id} should use its canonical registry title`);
    assert.equal(node.body, undefined, `${node.id} should use its canonical registry preview`);
  }

  const prohibitedTypes = ["ws.prepare", "util.checks", "ctl.loop", "ctl.branch", "hitl.question"];
  const nodeTypes = new Set(frame.nodes.map(({ type }) => type));
  for (const type of prohibitedTypes) assert.equal(nodeTypes.has(type), false);
  const modular = FRAMES.find(({ slug }) => slug === "v2-modular");
  assert.ok(modular?.nodes.some(({ type }) => type === "ws.prepare"));
  assert.equal(eventEdges.length, 1);
  assert.ok(eventEdges.every(({ dashed }) => dashed === true));
  assert.match(eventEdges[0].label, /GitHub Actions/i);
  assert.match(eventEdges[0].label, /fresh remediation run/i);
  const typeById = new Map(frame.nodes.map(({ id, type }) => [id, type]));
  assert.equal(typeById.get(eventEdges[0].from), "ws.finalize");
  assert.equal(typeById.get(eventEdges[0].to), "trig.pr-checks-failed");

  const explanation = frame.notes.map(({ body }) => body).join(" ");
  assert.match(explanation, /GitHub Actions.*source of truth/is);
  assert.match(explanation, /exact head SHA/i);
  assert.match(explanation, /workflow-authored events/i);
  assert.match(explanation, /merge conflict/i);
  assert.match(explanation, /park|destroy/i);
  assert.match(explanation, /default remediation workflow does not start when a PR is opened or updated/i);
  assert.match(explanation, /separately deployed PR-created workflow.*optional standalone Review Agent/i);
  assert.match(explanation, /does not run tests or publish check statuses/i);
  assert.match(explanation, /passing CI starts nothing/i);
  assert.match(explanation, /fresh remediation run/i);
  assert.match(explanation, /downstream.*pending.*terminat/is);
  assert.match(explanation, /Provider CI-completion and reviewer events are normalized/i);
  assert.match(explanation, /exact definition selectors/i);
  assert.match(explanation, /webhook-id.*Idempotency-Key.*event UUID/is);
  assert.match(explanation, /cancelled.*superseded.*ignored/is);
  assert.match(explanation, /successfully pushed repos.*partial/is);

  const frameIndex = FRAMES.indexOf(frame);
  assert.equal(FRAMES[frameIndex - 1]?.slug, "v3-approved-plan");
  assert.equal(FRAMES[frameIndex + 1]?.slug, "v5-merged-ticket");
  assert.equal(FRAMES[frameIndex + 2]?.slug, "decisions");
  assert.match(html, /<kbd>1<\/kbd>–<kbd>8<\/kbd> jump to frame/);
  assert.doesNotMatch(html, /slug: "pr-remediation-events"/);
  assert.match(html, /CI failure granularity/);
});

test("keeps specialized Fix Agent workspace preparation and readiness implicit", () => {
  const { BLOCKS } = loadCanvasData();
  const fix = BLOCKS["agent.fix"];
  const prepare = BLOCKS["ws.prepare"];
  const generic = BLOCKS["agent.generic"];
  const finalize = BLOCKS["ws.finalize"];
  const fetchContext = BLOCKS["vcs.fetch-context"];

  assert.match(fix.input, /target: PrRef \| TicketContext/);
  assert.match(fix.input, /workspace_id\?: string/);
  assert.match(fix.input, /source_head_sha\?: string/);
  assert.match(fix.input, /failures: RemediationItem\[\]/);
  assert.match(fix.output, /workspace_id: string/);
  assert.match(fix.output, /questions\?: string\[\]/);
  assert.match(fix.note, /prepares|resumes|reuses/i);
  assert.match(fix.note, /status.*fixed.*finaliz/is);
  assert.match(prepare.input, /target: PrRef \| TicketContext/);
  assert.match(prepare.note, /optional.*specialized/i);
  assert.match(generic.note, /declared.*classification.*Branch/i);
  assert.match(finalize.note, /does not terminate.*claim.*downstream/is);
  assert.match(fetchContext.output, /remediation_context: RemediationItem\[\]/);

  assert.match(supportingSpec, /Fix Agent.*workspace_id\?/is);
  assert.match(supportingSpec, /status.*fixed.*finaliz/is);
  assert.match(supportingSpec, /Generic Agent.*declared.*classification.*Branch/is);
  assert.match(supportingSpec, /Finalize workspace.*does not terminate.*claim.*downstream/is);
  assert.match(supportingSpec, /Fetch PR context.*remediation_context/is);
});

test("keeps the supporting design spec aligned with external check ownership", () => {
  assert.match(supportingSpec, /Eight frames, auto-positioned/i);
  assert.doesNotMatch(
    supportingSpec,
    /^7\. \*\*PR remediation · driven by CI & review events\*\*/m,
  );
  assert.match(supportingSpec, /Keyboard:.*`1`–`8` fly to frame N/i);
  assert.match(supportingSpec, /Sidebar navigator.*eight frames/i);
  assert.match(supportingSpec, /renders all eight frames/i);
  assert.match(supportingSpec, /GitHub Actions.*authoritative/is);
  assert.match(supportingSpec, /fresh remediation run/i);
  assert.match(supportingSpec, /current runtime (?:has not migrated|still dispatches)/i);
  assert.doesNotMatch(supportingSpec, /V4 subsumes the post-PR gate/i);
  assert.doesNotMatch(
    supportingSpec,
    /PR gates\) become blocks inside workflows/i,
  );
});

test("publishes only through Finalize and models the merged ticket transition", () => {
  const { BLOCKS, FRAMES } = loadCanvasData();
  const standard = FRAMES.find(({ slug }) => slug === "v1-standard");
  const approved = FRAMES.find(({ slug }) => slug === "v3-approved-plan");
  const merged = FRAMES.find(({ slug }) => slug === "v5-merged-ticket");

  for (const frame of [standard, approved]) {
    assert.ok(frame);
    const typeById = new Map(frame.nodes.map(({ id, type }) => [id, type]));
    const implementationId = frame.nodes.find(({ type }) => type === "agent.implementation")?.id;
    const finalizeId = frame.nodes.find(({ type }) => type === "ws.finalize")?.id;
    const openPrId = frame.nodes.find(({ type }) => type === "vcs.open-pr")?.id;
    assert.ok(frame.edges.some(({ from, to }) => from === implementationId && to === finalizeId));
    assert.ok(frame.edges.some(({ from, to }) => from === finalizeId && to === openPrId));
    assert.equal(typeById.get(finalizeId), "ws.finalize");
  }

  assert.match(BLOCKS["vcs.open-pr"].input, /publication_attempt_id/);
  assert.doesNotMatch(BLOCKS["vcs.open-pr"].input, /workspace_id/);
  assert.match(BLOCKS["trig.pr-merged"].input, /scope: "workflow_owned" \| "any"/);
  for (const type of [
    "trig.pr-created",
    "trig.pr-checks-failed",
    "trig.pr-review",
    "trig.pr-merged",
  ]) {
    assert.match(BLOCKS[type].input, /scope: "workflow_owned" \| "any"/);
    assert.match(BLOCKS[type].note, /durable branch\/publication correlation/i);
  }
  assert.match(BLOCKS["trig.pr-checks-failed"].note, /any is review-safe/i);
  assert.deepEqual(
    Array.from(merged.nodes, ({ type }) => type),
    ["trig.pr-merged", "tk.status", "util.slack"],
  );
  assert.match(merged.notes[0].body, /transition intent/i);
});

test("records the verified clarification model and execution budgets", () => {
  const { BLOCKS, FRAMES } = loadCanvasData();
  const guarantees = FRAMES.find(({ slug }) => slug === "guarantees");
  const decisions = FRAMES.find(({ slug }) => slug === "decisions");
  const guaranteeText = guarantees.items.map(({ head, body }) => `${head} ${body}`).join(" ");
  const decisionText = decisions.items.map(({ head, body }) => `${head} ${body}`).join(" ");

  assert.match(BLOCKS["agent.planning"].note, /snapshot-backed pinned successor/i);
  assert.match(BLOCKS["agent.planning"].note, /Vercel.*probe.*passed/is);
  assert.doesNotMatch(guaranteeText, /ships only after.*probe passes/is);
  assert.doesNotMatch(decisionText, /gated on.*probe/is);
  assert.doesNotMatch(guaranteeText, /same instance or starts a pinned successor/i);
  assert.doesNotMatch(decisionText, /choose true suspension versus a pinned successor/i);
  assert.match(guaranteeText, /maxDurationMs/);
  assert.match(guaranteeText, /maxTokens/);
  assert.match(guaranteeText, /maxCostUsd/);
  assert.match(guaranteeText, /one phase may overrun/i);
  assert.match(guaranteeText, /fail closed/i);
});

test("keeps the authoritative block catalog aligned with the implemented registry", () => {
  const { BLOCKS, FRAMES } = loadCanvasData();
  const registry = FRAMES.find(({ slug }) => slug === "registry");

  assert.equal(Object.keys(BLOCKS).length, 28);
  assert.equal(registry.badge, "9 groups · 28 blocks");
  assert.ok(BLOCKS["util.pre-pr-checks"]);
  assert.equal(BLOCKS["arthur.trace"], undefined);
  assert.match(BLOCKS["util.pre-pr-checks"].note, /pre-PR gate/i);
  assert.match(BLOCKS["ws.finalize"].note, /does not open PRs/i);
  assert.match(BLOCKS["vcs.open-pr"].note, /does not push workspace changes/i);
});

test("records that an accepted plan approval cannot be revoked", () => {
  const { BLOCKS } = loadCanvasData();
  assert.match(BLOCKS["trig.plan-approved"].note, /final/i);
  assert.match(BLOCKS["trig.plan-approved"].note, /cannot be revoked/i);
});

test("states the actionable review events each provider can actually deliver", () => {
  const { BLOCKS, FRAMES } = loadCanvasData();
  const reviewTrigger = BLOCKS["trig.pr-review"];
  const decisions = FRAMES.find(({ slug }) => slug === "decisions");
  const decisionText = decisions.items
    .map(({ head, body }) => `${head} ${body}`)
    .join(" ");

  assert.match(reviewTrigger.note, /GitHub.*changes requested.*comments/is);
  assert.match(reviewTrigger.note, /GitLab.*comments only/is);
  assert.match(reviewTrigger.note, /does not emit a reliable.*changes.requested.*webhook/is);
  assert.match(decisionText, /GitLab.*changes.requested.*unavailable/is);
  assert.match(revisionSpec, /GitLab.*comments only/is);
  assert.match(revisionSpec, /rejects.*GitLab.*changes_requested/is);
  assert.doesNotMatch(revisionSpec, /GitLab merge-request reviewer state.*normalized/is);
});
