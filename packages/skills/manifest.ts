import { parse as parseYaml } from "yaml";
import { HarnessSkillArtifactIntegrityError } from "./artifact-error";
import type { SkillValidationError } from "./validation";

const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export interface SkillMetadata {
  name: string;
  description: string;
}

export function parseHarnessSkillMetadata(content: Uint8Array): SkillMetadata {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw invalidManifest("SKILL.md is not valid UTF-8.");
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) {
    throw invalidManifest("SKILL.md requires YAML front matter.");
  }
  let frontMatter: unknown;
  try {
    frontMatter = parseYaml(match[1]!);
  } catch {
    throw invalidManifest("SKILL.md contains malformed YAML.");
  }
  if (
    !frontMatter ||
    typeof frontMatter !== "object" ||
    Array.isArray(frontMatter)
  ) {
    throw invalidManifest("SKILL.md front matter must be an object.");
  }
  const record = frontMatter as Record<string, unknown>;
  if (
    typeof record.name !== "string" ||
    !SKILL_NAME_PATTERN.test(record.name)
  ) {
    throw invalidManifest("SKILL.md has an invalid name.");
  }
  if (
    typeof record.description !== "string" ||
    record.description.trim() !== record.description ||
    record.description.length === 0 ||
    record.description.length > 1_024
  ) {
    throw invalidManifest("SKILL.md has an invalid description.");
  }
  return { name: record.name, description: record.description };
}

function invalidManifest(reason: string): SkillValidationError {
  return new HarnessSkillArtifactIntegrityError(reason, "invalid_manifest");
}
