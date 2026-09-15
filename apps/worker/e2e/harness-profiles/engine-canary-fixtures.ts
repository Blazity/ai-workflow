// Engine canary fixture identity: definition ids, the custom Harness Profile
// pin, its skill artifact, and one ticket per fixture. A fixture change is now
// a reviewed pull request that edits this file, not a rewrite of unversioned
// repository variables invisible to the pull request that breaks them.
//
// Stage 3 of lanes/plan-engine-canary-gate-refactor.md pins one permanent
// ticket per fixture in the QA project; only AWP-176 exists today, so all
// three fixtures share it until the owner opens the other two.

export interface EngineCanarySkillSource {
  readonly owner: string;
  readonly repository: string;
  readonly path: string;
  readonly commitSha: string;
}

export interface EngineCanaryFixture {
  readonly workflowId: number;
  readonly ticketKey: string;
}

export interface EngineCanaryCustomProfileFixture extends EngineCanaryFixture {
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
    ticketKey: "AWP-176",
  }),
  codex: Object.freeze({
    workflowId: 37,
    ticketKey: "AWP-176",
  }),
  custom: Object.freeze({
    workflowId: 38,
    ticketKey: "AWP-176",
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
