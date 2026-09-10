/**
 * Runtime request schemas for the workflow definition itself: its metadata, its
 * draft, its deployment and the candidate graphs it is asked about.
 *
 * One schema per JSON body the worker accepts. Each mirrors exactly what its
 * handler used to check by hand, including the message it answered with, so
 * moving the check here changes where the refusal is decided and not what a
 * client sees.
 */
import { z } from "zod";
import type { WorkflowDefinitionLayoutInput } from "./domain";
import { integerField } from "./request-fields";

/** A revision counter the client echoes back for a compare-and-set. Zero is a
 *  definition that has never been written, so the floor is 0, not 1. */
function revisionField(message: string) {
  return integerField(message, 0);
}

/** A version number, which is 1-based: 0 never names a stored version. */
function versionField(message: string) {
  return integerField(message, 1);
}

/** Where a new definition's first draft comes from. */
export type WorkflowDefinitionCreateSource =
  | { kind: "default" }
  | { kind: "template"; templateId: string }
  | { kind: "duplicate"; definitionId: number };

const createSourceShapes = z.union([
  z.object({ kind: z.literal("default") }),
  z.object({ kind: z.literal("template"), templateId: z.string().min(1) }),
  z.object({
    kind: z.literal("duplicate"),
    definitionId: z.number().int().positive(),
  }),
]);

/**
 * Any shape that is not one of those three, including a template id that is
 * empty or a definition id that is not a positive integer, is one refusal with
 * one message. The shapes are checked through a single predicate rather than as
 * a union field, because a union reports whichever option got furthest and the
 * handler this replaces reported the same sentence whatever was wrong.
 */
export const workflowDefinitionCreateSourceSchema = z.custom<WorkflowDefinitionCreateSource>(
  (value) => createSourceShapes.safeParse(value).success,
  { message: "Invalid source" },
);

/** POST /api/v1/workflow-definitions */
export const workflowDefinitionCreateRequestSchema = z.object({
  name: z
    .string({ required_error: "Invalid name", invalid_type_error: "Invalid name" })
    .trim()
    .min(1, "Invalid name"),
  source: workflowDefinitionCreateSourceSchema,
});
export type WorkflowDefinitionCreateRequest = z.infer<
  typeof workflowDefinitionCreateRequestSchema
>;

/** PATCH /api/v1/workflow-definitions/:id. Both fields are optional: the
 *  handler applied only what it was given, and a body with neither is a no-op
 *  update rather than a refusal. */
export const workflowDefinitionMetaPatchRequestSchema = z.object({
  name: z
    .string({ invalid_type_error: "Invalid name" })
    .trim()
    .min(1, "Invalid name")
    .optional(),
  enabled: z.boolean({ invalid_type_error: "Invalid enabled" }).optional(),
});
export type WorkflowDefinitionMetaPatchRequest = z.infer<
  typeof workflowDefinitionMetaPatchRequestSchema
>;

/**
 * PUT /api/v1/workflow-definitions/:id.
 *
 * `definition` stays unknown here on purpose: the graph itself is checked by
 * the worker's own v2 schema, which is the only thing that can tell a retired
 * v1 definition from a malformed v2 one, and the handler runs that check first.
 */
export const workflowDefinitionDraftSaveRequestSchema = z.object({
  definition: z.unknown(),
  expectedDraftRevision: revisionField("Invalid draft revision"),
});
export type WorkflowDefinitionDraftSaveRequest = z.infer<
  typeof workflowDefinitionDraftSaveRequestSchema
>;

/** POST /api/v1/workflow-definitions/:id/deploy */
export const workflowDefinitionDeployRequestSchema = z.object({
  expectedDraftRevision: revisionField("Invalid draft revision"),
  expectedDeployedVersion: versionField("Invalid deployed version").nullable(),
});
export type WorkflowDefinitionDeployRequest = z.infer<
  typeof workflowDefinitionDeployRequestSchema
>;

/** POST /api/v1/workflow-definitions/:id/rollback and .../restore, which take
 *  the same body and run the same store operation. */
export const workflowDefinitionRollbackRequestSchema = z.object({
  version: versionField("Invalid version"),
  expectedDeployedVersion: versionField("Invalid deployed version").nullable(),
});
export type WorkflowDefinitionRollbackRequest = z.infer<
  typeof workflowDefinitionRollbackRequestSchema
>;

/**
 * PATCH /api/v1/workflow-definitions/:id/layout.
 *
 * The layout is only checked for being a non-null object, which is what the
 * handler checked and therefore also accepts an array. Its fields are the
 * store's business, so the whole value is forwarded rather than reshaped.
 */
export const workflowDefinitionLayoutPatchRequestSchema = z.object({
  layout: z.custom<WorkflowDefinitionLayoutInput>(
    (value) => Boolean(value) && typeof value === "object",
    { message: "Invalid workflow layout" },
  ),
  expectedLayoutRevision: revisionField("Invalid layout revision"),
});
export type WorkflowDefinitionLayoutPatchRequest = z.infer<
  typeof workflowDefinitionLayoutPatchRequestSchema
>;

/** POST /api/v1/workflow-definitions/:id/validate and .../catalog. Neither
 *  handler checked the candidate here: the worker's v2 schema does that, and
 *  validate deliberately reports an unparseable candidate as a validation
 *  result rather than as a bad request. */
export const workflowDefinitionCandidateRequestSchema = z.object({
  definition: z.unknown(),
});
export type WorkflowDefinitionCandidateRequest = z.infer<
  typeof workflowDefinitionCandidateRequestSchema
>;

/** POST /api/v1/workflow-definitions/:id/prompt-preview. A block id carrying
 *  surrounding whitespace is refused rather than trimmed: it names a node in a
 *  graph the client already holds, so it is a client bug, not a typo. */
export const workflowDefinitionPromptPreviewRequestSchema = z.object({
  blockId: z
    .string({
      required_error: "Invalid block id",
      invalid_type_error: "Invalid block id",
    })
    .min(1, "Invalid block id")
    .refine((value) => value.trim() === value, { message: "Invalid block id" }),
  definition: z.unknown(),
});
export type WorkflowDefinitionPromptPreviewRequest = z.infer<
  typeof workflowDefinitionPromptPreviewRequestSchema
>;
