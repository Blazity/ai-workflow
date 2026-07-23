import { getVcsProviderConfig } from "../../env.js";
import {
  createGitHubSkillRepository,
  HarnessSkillImportError,
  type GitHubSkillRepository,
} from "./github-skills.js";

export function createConfiguredGitHubSkillRepository(): GitHubSkillRepository {
  try {
    const provider = getVcsProviderConfig("github");
    if (provider.kind !== "github") {
      throw new Error("Configured provider is not GitHub");
    }
    return createGitHubSkillRepository(provider.auth);
  } catch {
    throw new HarnessSkillImportError(
      503,
      "The organization GitHub App installation is not configured",
    );
  }
}
