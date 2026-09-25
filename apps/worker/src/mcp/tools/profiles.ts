import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  HarnessProfileStoreError,
  HarnessSkillImportError,
} from "../../services/harness/harness-errors.js";
import type { McpToolDependencies } from "../contracts.js";
import { executeMcpMutation, executeMcpRead } from "../execute-tool.js";
import { hashCanonicalJson } from "../sanitize-result.js";
import { mcpEnvelopeResult, registerCatalogTool } from "../tool-catalog.js";
import {
  announceAuthoringChange,
  announcementLabel,
  refusal,
  storeActor,
} from "./authoring-support.js";

/**
 * Harness profiles over MCP: the dashboard's profile list and detail, its
 * Refresh action on a pinned skill, and its Publish action, each through the
 * same service call the dashboard route makes. The services check the role
 * themselves, so a tool here cannot be the way around a profile rule.
 *
 * Why these four and not the whole editor: a skill edited in this repository
 * reaches no run until every profile pinning it is refreshed and published,
 * and every workflow node pinning that profile names the new version. The
 * last step is already workflows.save_draft and workflows.publish; these are
 * the steps before it.
 */

type SkillPin = { name: string; artifactHash: string };

type ProfileSummary = {
  profileId: string;
  slug: string;
  displayName: string;
  system: boolean;
  readOnly: boolean;
  draftRevision: number;
  publishedVersion: number | null;
  draftSkills: SkillPin[];
};

type ProfileDetail = ProfileSummary & {
  draftSkillSources: Array<{ artifactHash: string; source: unknown }>;
  publishedSkills: SkillPin[] | null;
  usedBy: Array<{
    definitionId: number;
    name: string;
    profileVersions: number[];
    deployed: boolean;
  }>;
};

type RefreshData = {
  profileId: string;
  draftRevision: number;
  skillName: string | null;
  previousArtifactHash: string;
  artifactHash: string;
  changed: boolean;
};

type PublishData = {
  profileId: string;
  version: number;
  changed: boolean;
  skills: SkillPin[];
};

function skillPins(skills: readonly SkillPin[]): SkillPin[] {
  return skills.map((skill) => ({ name: skill.name, artifactHash: skill.artifactHash }));
}

function summaryOf(profile: {
  id: string;
  slug: string;
  system: boolean;
  readOnly: boolean;
  draftRevision: number;
  publishedVersion: number | null;
  draft: { displayName: string; skills: readonly SkillPin[] };
}): ProfileSummary {
  return {
    profileId: profile.id,
    slug: profile.slug,
    displayName: profile.draft.displayName,
    system: profile.system,
    readOnly: profile.readOnly,
    draftRevision: profile.draftRevision,
    publishedVersion: profile.publishedVersion,
    draftSkills: skillPins(profile.draft.skills),
  };
}

/** The profile stores' refusals, mapped onto codes an agent can act on. Each
 *  of these is raised before anything is written (a missing profile, a stale
 *  revision, a built-in profile, a draft that does not validate), so the key
 *  goes back into circulation. Anything else is rethrown as it is and the
 *  wrapper seals the key: an unexpected failure may have written. */
function throwPublicStoreError(error: unknown): never {
  if (error instanceof HarnessProfileStoreError || error instanceof HarnessSkillImportError) {
    if (error.statusCode === 404) throw refusal("NOT_FOUND", error.message);
    if (error.statusCode === 409) throw refusal("CONFLICT", error.message, true);
    if (error.statusCode === 403) throw refusal("FORBIDDEN", error.message);
    if (error.statusCode === 400 || error.statusCode === 422) {
      throw refusal("VALIDATION_FAILED", error.message);
    }
  }
  throw error;
}

function profileActor(deps: McpToolDependencies) {
  return { ...storeActor(deps.actor), organizationId: deps.actor.organizationId };
}

export function registerProfileTools(server: McpServer, deps: McpToolDependencies): void {
  registerCatalogTool(server, "profiles.list", async () => {
    const envelope = await executeMcpRead({
      deps,
      toolName: "profiles.list",
      targetRefs: [],
      operation: async (): Promise<{ profiles: ProfileSummary[] }> => {
        const profiles = await deps.services.listHarnessProfiles(deps.actor.organizationId);
        return { profiles: profiles.map(summaryOf) };
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "profiles.get", async (input) => {
    const envelope = await executeMcpRead({
      deps,
      toolName: "profiles.get",
      targetRefs: [input.profileId],
      operation: async (): Promise<ProfileDetail> => {
        const detail = await deps.services.readHarnessProfileDetail({
          organizationId: deps.actor.organizationId,
          profileId: input.profileId,
          // A service actor has no dashboard role; it only ever reads here, and
          // the detail read uses the role for nothing but the canManage flags
          // this tool does not return.
          actorRole: deps.actor.role === "service" ? "member" : deps.actor.role,
          requestedVersion: undefined,
        });
        if (!detail) throw refusal("NOT_FOUND", "Profile not found");
        return {
          ...summaryOf(detail.profile),
          draftSkillSources: detail.skillSources,
          publishedSkills: detail.published ? skillPins(detail.published.manifest.skills) : null,
          usedBy: detail.usage.map((usage) => ({
            definitionId: usage.definitionId,
            name: usage.name,
            profileVersions: usage.versions,
            deployed: usage.deployed,
          })),
        };
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "profiles.refresh_skill", async (input) => {
    const envelope = await executeMcpMutation({
      deps,
      toolName: "profiles.refresh_skill",
      targetRefs: [input.profileId, String(input.expectedRevision), input.artifactHash],
      idempotencyKey: input.idempotencyKey,
      payloadHash: `sha256:${hashCanonicalJson({
        profileId: input.profileId,
        expectedRevision: input.expectedRevision,
        artifactHash: input.artifactHash,
      })}`,
      operation: async (): Promise<RefreshData> => {
        const actor = profileActor(deps);
        let refreshed: Awaited<ReturnType<typeof deps.services.refreshHarnessProfileSkill>>;
        try {
          refreshed = await deps.services.refreshHarnessProfileSkill({
            profileId: input.profileId,
            expectedRevision: input.expectedRevision,
            artifactHash: input.artifactHash,
            actor,
          });
        } catch (error) {
          throwPublicStoreError(error);
        }
        const pin = refreshed.profile.draft.skills.find(
          (skill) => skill.artifactHash === refreshed.artifact.artifactHash,
        );
        return {
          profileId: refreshed.profile.id,
          draftRevision: refreshed.profile.draftRevision,
          skillName: pin?.name ?? null,
          previousArtifactHash: input.artifactHash,
          artifactHash: refreshed.artifact.artifactHash,
          changed: refreshed.changed,
        };
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "profiles.publish", async (input) => {
    const envelope = await executeMcpMutation({
      deps,
      toolName: "profiles.publish",
      targetRefs: [input.profileId, String(input.expectedRevision)],
      idempotencyKey: input.idempotencyKey,
      payloadHash: `sha256:${hashCanonicalJson({
        profileId: input.profileId,
        expectedRevision: input.expectedRevision,
      })}`,
      operation: async (): Promise<PublishData> => {
        const actor = profileActor(deps);
        let published: Awaited<ReturnType<typeof deps.services.publishHarnessProfileDraft>>;
        try {
          published = await deps.services.publishHarnessProfileDraft({
            profileId: input.profileId,
            expectedRevision: input.expectedRevision,
            actor,
          });
        } catch (error) {
          throwPublicStoreError(error);
        }
        // Announced from inside the operation, so a replay of the same key
        // answers from the stored response without telling the channel twice,
        // and only a version that was really minted is announced.
        if (published.changed) {
          await announceAuthoringChange(
            deps,
            `published harness profile "${announcementLabel(published.profile.slug)}" as version ${published.version.version}. No workflow uses it until a workflow's graph names that version and is published.`,
          );
        }
        return {
          profileId: published.profile.id,
          version: published.version.version,
          changed: published.changed,
          skills: skillPins(published.version.manifest.skills),
        };
      },
    });
    return mcpEnvelopeResult(envelope);
  });
}
