import { parse as parseYaml } from "yaml";
import { SkillValidationError } from "./validation";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface SkillLockEntry {
  source: string;
  sourceType: string;
  computedHash: string;
}

export interface SkillLockFile {
  version: 1;
  skills: Record<string, SkillLockEntry>;
}

export function parseSkillLockFile(input: string | unknown): SkillLockFile {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      parseYaml(input, { uniqueKeys: true });
      value = JSON.parse(input) as unknown;
    } catch {
      throw invalidLock("Skill lock file is not valid JSON with unique names.");
    }
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.skills)) {
    throw invalidLock("Skill lock file requires version 1 and a skills object.");
  }
  const skills: Record<string, SkillLockEntry> = {};
  for (const [name, entry] of Object.entries(value.skills)) {
    if (name.length === 0 || !isRecord(entry)) {
      throw invalidLock("Skill lock file contains an invalid skill entry.");
    }
    if (
      Object.keys(entry).some(
        (key) => !["source", "sourceType", "computedHash"].includes(key),
      )
    ) {
      throw invalidLock(`Skill lock entry "${name}" is invalid.`);
    }
    if (
      typeof entry.source !== "string" ||
      entry.source.length === 0 ||
      typeof entry.sourceType !== "string" ||
      entry.sourceType.length === 0 ||
      typeof entry.computedHash !== "string" ||
      !SHA256_PATTERN.test(entry.computedHash)
    ) {
      throw invalidLock(`Skill lock entry "${name}" is invalid.`);
    }
    skills[name] = {
      source: entry.source,
      sourceType: entry.sourceType,
      computedHash: entry.computedHash,
    };
  }
  return { version: 1, skills };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidLock(reason: string): SkillValidationError {
  return new SkillValidationError("invalid_lock_file", reason);
}
