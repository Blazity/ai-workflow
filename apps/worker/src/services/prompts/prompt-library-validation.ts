import { z } from "zod";
import type { JsonValue, PromptSlotDefinition } from "@shared/contracts";
import { inspectJsonSchema202012, validateJsonSchemaValue } from "../../workflow-definition/json-schema.js";
import { PromptLibraryStoreError } from "./prompt-library-failures.js";

export const PROMPT_BODY_MAX_LENGTH = 50_000;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const promptSlotDefinitionSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/),
  description: z.string().trim().max(2000),
  schema: z.record(z.string(), jsonValueSchema),
  required: z.boolean().default(true),
  defaultValue: jsonValueSchema.optional(),
}).strict();

export function validatePromptName(name: string): string {
  const parsed = z.string().trim().min(1).max(120).safeParse(name);
  if (!parsed.success) throw new PromptLibraryStoreError(400, "Invalid name");
  return parsed.data;
}

export function validatePromptDescription(description: string | null): string | null {
  if (description === null) return null;
  const parsed = z.string().trim().max(2000).safeParse(description);
  if (!parsed.success) throw new PromptLibraryStoreError(400, "Invalid description");
  return parsed.data.length > 0 ? parsed.data : null;
}

export function validatePromptTags(tags: string[]): string[] {
  const parsed = z.array(z.string().trim().min(1).max(40)).safeParse(tags);
  if (!parsed.success) throw new PromptLibraryStoreError(400, "Invalid tags");
  const deduped = [...new Set(parsed.data)];
  if (deduped.length > 15) throw new PromptLibraryStoreError(400, "Invalid tags");
  return deduped;
}

export function validatePromptBody(body: string): string {
  const parsed = z.string().min(1).max(PROMPT_BODY_MAX_LENGTH).safeParse(body);
  if (!parsed.success) throw new PromptLibraryStoreError(400, "Invalid body");
  return parsed.data;
}

export function validatePromptSlots(value: unknown): PromptSlotDefinition[] {
  const parsed = z.array(promptSlotDefinitionSchema).max(100).safeParse(value);
  if (!parsed.success) throw new PromptLibraryStoreError(400, "Invalid slots");
  const names = new Set<string>();
  for (const slot of parsed.data) {
    if (names.has(slot.name)) {
      throw new PromptLibraryStoreError(400, `Invalid slots: duplicate slot "${slot.name}"`);
    }
    names.add(slot.name);
    const inspected = inspectJsonSchema202012(slot.schema);
    if (!inspected.ok) {
      const issue = inspected.issues[0]!;
      throw new PromptLibraryStoreError(400, `Invalid slots: slot "${slot.name}" schema${issue.path || "/"} ${issue.message}`);
    }
    if (slot.defaultValue !== undefined) {
      const issues = validateJsonSchemaValue(inspected.schema, slot.defaultValue);
      if (issues.length > 0) {
        throw new PromptLibraryStoreError(400, `Invalid slots: slot "${slot.name}" defaultValue${issues[0]!.path || "/"} ${issues[0]!.message}`);
      }
    }
  }
  return structuredClone(parsed.data);
}
