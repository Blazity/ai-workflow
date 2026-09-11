/**
 * Where a harness skill comes from: a GitHub repository the tenant configured,
 * or the bundle this deployment ships.
 *
 * The two sources answer the same two questions (what is there, import these),
 * so they live together. The GitHub client is built per call and only when a
 * call needs it: a deployment with no GitHub App configured still reaches its
 * own skills through the local pair, and would answer 503 to every one of them
 * if the client were built up front.
 */
import { getDb } from "../../db/client.js";
import {
  createGitHubSkillRepository,
  discoverGitHubSkills,
  importGitHubSkills,
} from "../../harness-profiles/github-skills.js";
import { createConfiguredGitHubSkillRepository } from "../../harness-profiles/configured-github-skills.js";
import {
  discoverLocalSkills,
  importLocalSkills,
} from "../../harness-profiles/local-skills.js";
import { vcsProviderConfig } from "../settings/index.js";
import type {
  HarnessLocalSkillSelection,
  HarnessSkillImportRequest,
} from "@shared/contracts";

/** The GitHub client this deployment's VCS configuration describes. */
export function configuredGitHubSkillRepository() {
  return createConfiguredGitHubSkillRepository(() => {
    const provider = vcsProviderConfig("github");
    if (provider.kind !== "github") {
      throw new Error("Configured provider is not GitHub");
    }
    return createGitHubSkillRepository(provider.auth);
  });
}

/** What skills a GitHub source holds, at the commit the source resolves to. */
export function discoverGitHubSkillSource(source: string) {
  return discoverGitHubSkills({
    repository: configuredGitHubSkillRepository(),
    source,
  });
}

/** Import the selected paths of an exact GitHub commit as skill artifacts. */
export function importGitHubSkillSelection(input: {
  organizationId: string;
  actorId: string;
  source: HarnessSkillImportRequest["source"];
  paths: HarnessSkillImportRequest["paths"];
}) {
  return importGitHubSkills(getDb(), {
    repository: configuredGitHubSkillRepository(),
    organizationId: input.organizationId,
    actorId: input.actorId,
    request: { source: input.source, paths: input.paths },
  });
}

/** What skills this deployment ships, as discovery reports them. */
export function discoverDeploymentSkills() {
  return discoverLocalSkills();
}

/** Import the selected deployment skills as skill artifacts. */
export function importDeploymentSkills(input: {
  organizationId: string;
  actorId: string;
  skills: HarnessLocalSkillSelection[];
}) {
  return importLocalSkills(getDb(), input);
}
