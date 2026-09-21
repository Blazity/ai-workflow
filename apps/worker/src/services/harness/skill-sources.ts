/**
 * Where a harness skill comes from: a repository the tenant's version-control
 * integration can read, or the bundle this deployment ships.
 *
 * The two sources answer the same two questions (what is there, import these),
 * so they live together. The provider's reader is resolved per call and only
 * when a call needs it: a deployment with no version-control integration
 * connected still reaches its own skills through the local pair, and would
 * answer 503 to every one of them if the reader were resolved up front.
 */
import type { RepositorySkillSource } from "@integrations/sdk";
import {
  discoverRepositorySkills,
  importConnectedRepositorySkills,
} from "../../harness-profiles/repository-skills.js";
import {
  discoverLocalSkills,
  importConnectedLocalSkills,
} from "../../harness-profiles/local-skills.js";
import { HarnessSkillImportError } from "../../harness-profiles/skill-errors.js";
import { resolveRepositorySkillSource } from "../vcs/index.js";
import type {
  HarnessLocalSkillSelection,
  HarnessSkillImportRequest,
} from "@shared/contracts";

/**
 * The repository reader this deployment's connected version-control provider
 * offers, or the 503 an operator can act on.
 *
 * Everything that stops a skill import before a provider call is the same
 * answer to the person looking at the dashboard: nothing here can read a
 * repository right now, and that is a deployment's configuration rather than
 * anything wrong with the request. The resolver's sentence is carried through
 * verbatim, because "GitHub is connected but cannot import skills" and "two
 * providers can and neither claims this URL" need different fixes.
 *
 * `provider` names the artifact's stored source when there is one; a first
 * import arrives as a URL and has none. `resolveRepositorySkillSource` says
 * what it does with each case.
 */
export async function connectedRepositorySkillSource(
  provider?: string,
): Promise<RepositorySkillSource> {
  try {
    return (await resolveRepositorySkillSource(provider)).source;
  } catch (error) {
    throw new HarnessSkillImportError(
      503,
      error instanceof Error
        ? error.message
        : "No connected version control provider can import skills.",
    );
  }
}

/** What skills a repository source holds, at the commit the source resolves to. */
export async function discoverRepositorySkillSource(source: string) {
  return discoverRepositorySkills({
    repository: await connectedRepositorySkillSource(),
    source,
  });
}

/** Import the selected paths of an exact commit as skill artifacts. */
export async function importRepositorySkillSelection(input: {
  organizationId: string;
  actorId: string;
  source: HarnessSkillImportRequest["source"];
  paths: HarnessSkillImportRequest["paths"];
}) {
  return importConnectedRepositorySkills({
    repository: await connectedRepositorySkillSource(),
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
  return importConnectedLocalSkills(input);
}
