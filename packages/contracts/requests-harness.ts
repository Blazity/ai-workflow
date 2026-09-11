/**
 * Runtime request schemas for the harness HTTP surface.
 *
 * One schema per JSON body the worker accepts. Each mirrors exactly what its
 * handler used to check by hand, including the message it answered with, so
 * moving the check here changes where the refusal is decided and not what a
 * client sees.
 */
import { z } from "zod";
import { objectOrEmpty } from "./request-parsing";

/**
 * The handlers tested shape with `typeof`, so NaN passed as a revision and an
 * array passed as a source both got through to the store, which is where the
 * real refusal lives. `z.number()` would reject NaN and `z.object()` would
 * reject an array, so the checks below are written as the predicates the
 * handlers actually used.
 */
function shapedAs<T>(
  accepts: (value: unknown) => boolean,
  message: string,
): z.ZodType<T> {
  return z.custom<T>(accepts, { message });
}

const REVISION_REQUIRED = "expectedRevision is required";

/** POST /api/v1/harness-profiles */
export const harnessProfileCreateRequestSchema = objectOrEmpty(
  z.object({
    slug: z.unknown().optional(),
    draft: shapedAs<unknown>(
      (value) => value !== undefined,
      "Profile draft is required",
    ),
  }),
);
export type HarnessProfileCreateRequest = z.infer<
  typeof harnessProfileCreateRequestSchema
>;

/** PATCH /api/v1/harness-profiles/[id] */
export const harnessProfileDraftUpdateRequestSchema = objectOrEmpty(
  z.object({
    expectedRevision: shapedAs<number>(
      (value) => typeof value === "number",
      "Draft and expectedRevision are required",
    ),
    draft: shapedAs<unknown>(
      (value) => value !== undefined,
      "Draft and expectedRevision are required",
    ),
  }),
);
export type HarnessProfileDraftUpdateRequest = z.infer<
  typeof harnessProfileDraftUpdateRequestSchema
>;

/** POST /api/v1/harness-profiles/[id]/archive and .../publish */
export const harnessProfileRevisionRequestSchema = objectOrEmpty(
  z.object({
    expectedRevision: shapedAs<number>(
      (value) => typeof value === "number",
      REVISION_REQUIRED,
    ),
  }),
);
export type HarnessProfileRevisionRequest = z.infer<
  typeof harnessProfileRevisionRequestSchema
>;

/**
 * POST /api/v1/harness-profiles/[id]/remove and .../unarchive.
 *
 * Preserved as it was: neither handler checked the revision at all, it read
 * whatever the body carried and let the store answer 400 for anything unusable.
 */
export const harnessProfileUncheckedRevisionRequestSchema = objectOrEmpty(
  z.object({
    expectedRevision: z.unknown().optional(),
  }),
);
export type HarnessProfileUncheckedRevisionRequest = z.infer<
  typeof harnessProfileUncheckedRevisionRequestSchema
>;

/** POST /api/v1/harness-profiles/[id]/fork */
export const harnessProfileForkRequestSchema = objectOrEmpty(
  z.object({
    expectedRevision: shapedAs<number>(
      (value) => typeof value === "number",
      REVISION_REQUIRED,
    ),
    slug: z.unknown().optional(),
  }),
);
export type HarnessProfileForkRequest = z.infer<
  typeof harnessProfileForkRequestSchema
>;

/** POST /api/v1/harness-profiles/[id]/restore */
export const harnessProfileVersionRestoreRequestSchema = objectOrEmpty(
  z.object({
    version: shapedAs<number>(
      (value) => typeof value === "number",
      "version and expectedRevision are required",
    ),
    expectedRevision: shapedAs<number>(
      (value) => typeof value === "number",
      "version and expectedRevision are required",
    ),
  }),
);
export type HarnessProfileVersionRestoreRequest = z.infer<
  typeof harnessProfileVersionRestoreRequestSchema
>;

/** POST /api/v1/harness-profiles/[id]/skills/refresh */
export const harnessProfileSkillRefreshRequestSchema = objectOrEmpty(
  z.object({
    expectedRevision: shapedAs<number>(
      (value) => typeof value === "number",
      "artifactHash and expectedRevision are required",
    ),
    artifactHash: shapedAs<string>(
      (value) => typeof value === "string",
      "artifactHash and expectedRevision are required",
    ),
  }),
);
export type HarnessProfileSkillRefreshRequest = z.infer<
  typeof harnessProfileSkillRefreshRequestSchema
>;

/** POST /api/v1/harness-skills/discover */
export const harnessSkillDiscoverBodySchema = objectOrEmpty(
  z.object({
    source: shapedAs<string>(
      (value) => typeof value === "string",
      "GitHub skill source is required",
    ),
  }),
);
export type HarnessSkillDiscoverBody = z.infer<
  typeof harnessSkillDiscoverBodySchema
>;

const SKILL_IMPORT_REQUIRED = "Exact source and selected paths are required";

/** POST /api/v1/harness-skills/import */
export const harnessSkillImportBodySchema = objectOrEmpty(
  z.object({
    source: shapedAs<Record<string, unknown>>(
      (value) => Boolean(value) && typeof value === "object",
      SKILL_IMPORT_REQUIRED,
    ),
    paths: shapedAs<unknown[]>(
      (value) => Array.isArray(value),
      SKILL_IMPORT_REQUIRED,
    ),
  }),
);
export type HarnessSkillImportBody = z.infer<
  typeof harnessSkillImportBodySchema
>;

/** POST /api/v1/harness-skills/local */
export const harnessLocalSkillImportBodySchema = objectOrEmpty(
  z.object({
    skills: shapedAs<unknown[]>(
      (value) => Array.isArray(value),
      "Selected skills are required",
    ),
  }),
);
export type HarnessLocalSkillImportBody = z.infer<
  typeof harnessLocalSkillImportBodySchema
>;
