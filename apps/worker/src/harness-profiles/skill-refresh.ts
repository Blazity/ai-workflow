import type { HarnessSkillArtifact } from "@shared/contracts";
import {
  HarnessSkillImportError,
  refreshGitHubSkillArtifactFromRepository,
  type GitHubSkillRepository,
} from "./github-skills.js";
import { refreshLocalSkillArtifactFromRepository } from "./local-skills.js";
import {
  createConnectedHarnessProfileRepository,
  createHarnessProfileRepository,
} from "../db/repositories/harness-profiles.js";

type HarnessProfileRepository = ReturnType<typeof createHarnessProfileRepository>;

export function refreshConnectedHarnessSkillArtifact(
  input: {
    organizationId: string;
    actorId: string;
    artifactHash: string;
    githubRepository: () => GitHubSkillRepository;
  },
): Promise<HarnessSkillArtifact> {
  return refreshHarnessSkillArtifactFromRepository(
    createConnectedHarnessProfileRepository(),
    input,
  );
}

async function refreshHarnessSkillArtifactFromRepository(
  repository: HarnessProfileRepository,
  input: {
    organizationId: string;
    actorId: string;
    artifactHash: string;
    githubRepository: () => GitHubSkillRepository;
  },
): Promise<HarnessSkillArtifact> {
  const existing = await repository.getArtifactByHash({
    organizationId: input.organizationId,
    artifactHash: input.artifactHash,
  });
  if (!existing) {
    throw new HarnessSkillImportError(404, "Skill artifact not found");
  }
  if (existing.sourceKind === "local") {
    return refreshLocalSkillArtifactFromRepository(repository, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      artifactHash: input.artifactHash,
    });
  }
  return refreshGitHubSkillArtifactFromRepository(repository, {
    repository: input.githubRepository(),
    organizationId: input.organizationId,
    actorId: input.actorId,
    artifactHash: input.artifactHash,
  });
}
