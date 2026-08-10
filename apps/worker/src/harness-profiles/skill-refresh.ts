import type { HarnessSkillArtifact } from "@shared/contracts";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { harnessSkillArtifacts } from "../db/schema.js";
import {
  HarnessSkillImportError,
  refreshGitHubSkillArtifact,
  type GitHubSkillRepository,
} from "./github-skills.js";
import { refreshLocalSkillArtifact } from "./local-skills.js";

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
  const [existing] = await db
    .select({ sourceKind: harnessSkillArtifacts.sourceKind })
    .from(harnessSkillArtifacts)
    .where(
      and(
        eq(harnessSkillArtifacts.organizationId, input.organizationId),
        eq(harnessSkillArtifacts.artifactHash, input.artifactHash),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new HarnessSkillImportError(404, "Skill artifact not found");
  }
  if (existing.sourceKind === "local") {
    return refreshLocalSkillArtifact(db, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      artifactHash: input.artifactHash,
    });
  }
  return refreshGitHubSkillArtifact(db, {
    repository: input.githubRepository(),
    organizationId: input.organizationId,
    actorId: input.actorId,
    artifactHash: input.artifactHash,
  });
}
