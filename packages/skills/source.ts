import type {
  HarnessResolvedSkillArtifact,
  HarnessSkillSource,
} from "@shared/contracts";
import type { SkillMetadata } from "./manifest";

export const SKILL_SOURCE_KINDS = ["github", "local"] as const;
export type SkillSourceKind = (typeof SKILL_SOURCE_KINDS)[number];

export interface DiscoveredSkill<TSnapshot> extends SkillMetadata {
  path: string;
  snapshot: TSnapshot;
  artifactHash?: string;
}

export interface SkillArtifactInput {
  name: string;
  description: string;
  source: HarnessSkillSource;
  files: HarnessResolvedSkillArtifact["files"];
  artifactHash: string;
}

export interface SkillSource<TDiscoverInput, TSnapshot, TReadContext> {
  readonly kind: SkillSourceKind;
  discover(
    input: TDiscoverInput,
  ): Promise<readonly DiscoveredSkill<TSnapshot>[]>;
  read(
    snapshot: TSnapshot,
    context: TReadContext,
  ): Promise<SkillArtifactInput>;
}

export function isGitHubSkillSource(
  source: HarnessSkillSource,
): source is Extract<HarnessSkillSource, { commitSha: string }> {
  return "commitSha" in source;
}
