// Engine canary fixture identity: definition ids and the deployed version of
// each, the custom Harness Profile pin, its skill artifact, and one permanent
// ticket per fixture. A fixture change is a reviewed pull request that edits
// this file, not a rewrite of unversioned repository variables invisible to the
// pull request that breaks them.
//
// The deployed version stands in for the graph the canary can no longer read:
// workflows.get_graph rides workflows:write, which the machine credential does
// not hold, so republishing a fixture definition fails the gate until this file
// names the new version. Before bumping a deployedVersion, review the
// republished graph: two nodes (trigger_ticket_ai, generic_agent), one edge
// between them, workspaceMode "none", no update_ticket_status node (the run must
// not move its own ticket), and the profile pin this file expects.
//
// Every ticket lives in the QA project, stays in "Do zrobienia", and carries
// the replay sanitization fixture text in its description
// (replay/canary-contract.ts, createReplayCanaryFixture), so any of them can
// host the replay leg, which rides on the custom fixture's run.

interface EngineCanarySkillSource {
  readonly owner: string;
  readonly repository: string;
  readonly path: string;
  readonly commitSha: string;
}

interface EngineCanaryFixture {
  readonly workflowId: number;
  readonly deployedVersion: number;
  readonly ticketKey: string;
}

interface EngineCanaryCustomProfileFixture extends EngineCanaryFixture {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly skillName: string;
  readonly skillArtifactHash: string;
  readonly skillSource: EngineCanarySkillSource;
}

export interface EngineCanaryFixtures {
  readonly claude: EngineCanaryFixture;
  readonly codex: EngineCanaryFixture;
  readonly custom: EngineCanaryCustomProfileFixture;
}

export const ENGINE_CANARY_FIXTURES: EngineCanaryFixtures = Object.freeze({
  claude: Object.freeze({
    workflowId: 36,
    deployedVersion: 1,
    ticketKey: "AWP-176",
  }),
  codex: Object.freeze({
    workflowId: 37,
    deployedVersion: 1,
    ticketKey: "AWP-179",
  }),
  custom: Object.freeze({
    workflowId: 38,
    deployedVersion: 2,
    ticketKey: "AWP-180",
    profileId: "d92b9c8b-245d-4725-aa6a-d68b9ddd751f",
    profileVersion: 2,
    skillName: "gate-ladder",
    skillArtifactHash:
      "daa5c8a3058ae8c8a323e913c542ae28a31ea151ffa755018d62f75d921339ec",
    skillSource: Object.freeze({
      owner: "Blazity",
      repository: "ai-workflow",
      path: ".claude/skills/gate-ladder",
      commitSha: "2dce571943cdfc3d72650f464201c7103f4642ed",
    }),
  }),
});
