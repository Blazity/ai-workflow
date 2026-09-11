import { resolveModelDefaults } from "@shared/harness";
import { env as parsedEnv } from "../../infra/vcs-config.js";

const modelDefaults = resolveModelDefaults({
  claude: parsedEnv.CLAUDE_MODEL,
  codex: parsedEnv.CODEX_MODEL,
});

export const env = {
  ...parsedEnv,
  CLAUDE_MODEL: modelDefaults.claude,
  CODEX_MODEL: modelDefaults.codex,
};
