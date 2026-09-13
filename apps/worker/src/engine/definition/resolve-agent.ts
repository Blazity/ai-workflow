import type { AgentKind } from "../../sandbox/agents/index.js";
import { isHarnessProfileReference } from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  defaultBuiltinHarnessProfile,
  resolveBuiltinHarnessProfile,
} from "@shared/harness";

export interface ResolvedAgent {
  kind: AgentKind;
  model: string;
}

type AgentProfile = {
  harness: { provider: AgentKind };
  model: { id: string };
};

export function resolveRunHarnessDefaults(
  nodes: readonly { id: string }[],
  runtimes: Readonly<Record<string, { manifest: AgentProfile }>>,
): {
  defaultKind: AgentKind;
  defaultModel: string;
  models: Record<AgentKind, string>;
} {
  const profiles = nodes
    .map((node) => runtimes[node.id]?.manifest)
    .filter((profile): profile is AgentProfile => profile !== undefined);
  const defaultProfile = profiles[0] ?? defaultBuiltinHarnessProfile();
  const firstModelFor = (provider: AgentKind): string =>
    profiles.find((profile) => profile.harness.provider === provider)?.model.id ??
    BUILTIN_HARNESS_PROFILE_MANIFESTS[
      BUILTIN_HARNESS_PROFILE_IDS[provider]
    ].model.id;
  return {
    defaultKind: defaultProfile.harness.provider,
    defaultModel: defaultProfile.model.id,
    models: {
      claude: firstModelFor("claude"),
      codex: firstModelFor("codex"),
    },
  };
}

function resolveProfile(
  params: Record<string, unknown> | undefined,
) {
  const profileReference = params?.harnessProfile;
  if (!isHarnessProfileReference(profileReference)) return null;
  return resolveBuiltinHarnessProfile(profileReference);
}

function resolveKind(
  params: Record<string, unknown> | undefined,
  defaultKind: AgentKind,
  profile = resolveProfile(params),
): AgentKind {
  if (profile !== null) return profile.harness.provider;
  const provider = params?.provider;
  return provider === "claude" || provider === "codex" ? provider : defaultKind;
}

export function resolveBlockAgent(
  params: Record<string, unknown> | undefined,
  defaultKind: AgentKind,
  defaults: { claude: string; codex: string },
): ResolvedAgent {
  const profile = resolveProfile(params);
  const kind = resolveKind(params, defaultKind, profile);
  if (profile !== null) {
    return { kind: profile.harness.provider, model: profile.model.id };
  }
  const rawModel = params?.model;
  const model =
    typeof rawModel === "string" && rawModel.trim().length > 0
      ? rawModel.trim()
      : defaults[kind];
  return { kind, model };
}
