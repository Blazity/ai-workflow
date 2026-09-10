import {
  HarnessSkillImportError,
  type GitHubSkillRepository,
} from "./github-skills.js";

export function createConfiguredGitHubSkillRepository(
  repository: () => GitHubSkillRepository,
): GitHubSkillRepository {
  try {
    return repository();
  } catch {
    throw new HarnessSkillImportError(
      503,
      "The organization GitHub App installation is not configured",
    );
  }
}
