import type { VcsProviderKind } from "@shared/contracts";
import {
  getConfiguredVcsProviders,
  getVcsBotLoginConfig,
} from "../../infra/vcs-config.js";
import { resolveVcsBotLogin } from "../../adapters/vcs/vcs-bot-identity.js";

/** Resolve the configured automation account used to suppress recursive triggers. */
export function getVcsBotLogin(kind: VcsProviderKind): string | undefined {
  return resolveVcsBotLogin(
    kind,
    getConfiguredVcsProviders().map((provider) => provider.kind),
    getVcsBotLoginConfig(),
  );
}
