import type { PromptReferenceLoader } from "@shared/prompts";
import type { Db } from "../db/client.js";
import {
  findPromptBySlug,
  getCurrentPromptVersion,
  getPrompt,
  getPromptVersion,
} from "./store.js";

/** Maps a prompt token target and selector onto the concrete stored version. */
export function createPromptReferenceLoader(db: Db): PromptReferenceLoader {
  const INT4_MAX = 2147483647;
  return async (target, requestedVersion) => {
    const label = target.slug ?? `#${target.legacyPromptId}`;
    if (target.legacyPromptId !== undefined && target.legacyPromptId > INT4_MAX) {
      throw new Error(`Prompt ${label} does not exist`);
    }
    if (requestedVersion !== "latest" && requestedVersion > INT4_MAX) {
      throw new Error(`Prompt ${label} does not have version ${requestedVersion}`);
    }
    const prompt = target.slug !== undefined
      ? await findPromptBySlug(db, target.slug)
      : await getPrompt(db, target.legacyPromptId!);
    if (!prompt) throw new Error(`Prompt ${label} does not exist`);
    if (requestedVersion === "latest" && prompt.archivedAt !== null) {
      throw new Error(
        `Prompt ${label} (${prompt.name}) is archived and cannot follow latest`,
      );
    }
    const version = requestedVersion === "latest"
      ? await getCurrentPromptVersion(db, prompt.id)
      : await getPromptVersion(db, prompt.id, requestedVersion);
    if (!version) {
      const versionLabel = requestedVersion === "latest"
        ? "a current version"
        : `version ${requestedVersion}`;
      throw new Error(
        `Prompt ${label} (${prompt.name}) does not have ${versionLabel}`,
      );
    }
    return {
      promptId: prompt.id,
      promptName: prompt.name,
      requestedVersion,
      resolvedVersion: version.version,
      body: version.body,
      slots: structuredClone(version.slots),
    };
  };
}
