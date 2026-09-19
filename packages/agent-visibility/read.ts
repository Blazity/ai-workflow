import type { z } from "zod";
import { AGENT_VISIBILITY_SCHEMA_VERSION } from "./limits";

/**
 * A stored or served record, read.
 *
 * `newer_version` is its own outcome rather than an exception or a generic
 * failure: during a rollout the worker can write a version the dashboard does
 * not know yet, and the honest sentence is "written by a newer version", never
 * "corrupt" and never a guess at what the fields mean.
 */
export type VisibilityRead<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "newer_version"; schemaVersion: number; message: string }
  | { ok: false; reason: "invalid"; message: string };

const MESSAGE_ISSUES_MAX = 5;

/** Parses `value` with one of this package's schemas, reporting a newer
 *  schema version or the first few problems in a sentence a person can read. */
export function readVisibilityRecord<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
): VisibilityRead<z.output<S>> {
  const version =
    typeof value === "object" && value !== null
      ? (value as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (typeof version === "number" && version > AGENT_VISIBILITY_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "newer_version",
      schemaVersion: version,
      message: `This record was written by a newer version of AI Workflow (schema version ${version}); this build reads version ${AGENT_VISIBILITY_SCHEMA_VERSION}.`,
    };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, reason: "invalid", message: describeIssues(parsed.error.issues) };
}

/** `path: message; path: message`, at most five, for errors a person reads. */
export function describeIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string {
  const shown = issues
    .slice(0, MESSAGE_ISSUES_MAX)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`);
  const more = issues.length - shown.length;
  return more > 0 ? `${shown.join("; ")}; and ${more} more` : shown.join("; ");
}
