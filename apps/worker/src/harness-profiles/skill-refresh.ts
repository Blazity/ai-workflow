import type { HarnessSkillArtifact } from "@shared/contracts";
import type { Db } from "../db/types.js";
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

/**
 * Refreshing a pinned skill, whichever source it came from. Both variants mint
 * a new artifact from the current bytes and leave the caller to repoint the
 * pin, so the operator sees one button with one meaning.
 *
 * The GitHub client is built lazily, and that is the point: a deployment with
 * no GitHub App configured can still refresh its own skills, while building the
 * client up front would answer 503 to every refresh it makes.
 */
export async function refreshHarnessSkillArtifact(
  db: Db,
  input: {
    organizationId: string;
    actorId: string;
    artifactHash: string;
    githubRepository: () => GitHubSkillRepository;
  },
): Promise<HarnessSkillArtifact> {
  return refreshHarnessSkillArtifactFromRepository(
    createHarnessProfileRepository(db),
    input,
  );
}

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

export async function refreshHarnessSkillArtifactFromRepository(
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
