import type { VcsProviderKind } from "@shared/contracts";
import {
  getConfiguredVcsProviders,
  getVcsBotLoginConfig,
} from "../config/env.js";
import { resolveVcsBotLogin } from "./vcs-bot-identity.js";

/** Resolve the configured automation account used to suppress recursive triggers. */
export function getVcsBotLogin(kind: VcsProviderKind): string | undefined {
  return resolveVcsBotLogin(
    kind,
    getConfiguredVcsProviders().map((provider) => provider.kind),
    getVcsBotLoginConfig(),
  );
}
