/**
 * What a node of one block type takes as `configuration`, as JSON Schema, so an
 * agent authoring a graph over MCP reads the keys instead of guessing them.
 *
 * Converted from the one schema the save validates against
 * (`blockParamsSchemas`, composed in `engine/definition`), never restated, so
 * the description and the rule cannot drift apart. It describes SHAPE: a
 * refinement a schema cannot state (a cron that must parse, a reference that
 * must resolve) is still the save's to refuse, by name.
 *
 * Two zods, because the deployed bundle resolves zod 4 and the tests run zod 3
 * (`.claude/rules/zod-bundle.md`), and each converts its own schemas:
 *
 * - zod 4 has `z.toJSONSchema`. It is asked for the INPUT side (what a caller
 *   sends, before defaults and transforms) and to render what JSON Schema
 *   cannot express as "anything" rather than throw, because a `z.custom` check
 *   is exactly the kind of rule this leaves to the save.
 * - zod 3 has no converter of its own; the AI SDK's `zodSchema` carries one and
 *   is already how this worker turns a zod 3 schema into JSON Schema.
 */
import { z } from "zod";

type JsonSchemaObject = Record<string, unknown>;

type Zod4JsonSchema = (
  schema: unknown,
  options: { io: "input"; unrepresentable: "any" },
) => JsonSchemaObject;

/** Said when neither converter can describe a schema, so the field is never
 *  absent and never a lie about what is accepted. */
const UNDESCRIBED: JsonSchemaObject = {
  type: "object",
  description:
    "This block's configuration could not be described as JSON Schema here; workflows.save_draft names every key it refuses.",
};

function isZod4Schema(schema: unknown): boolean {
  return typeof schema === "object" && schema !== null && "_zod" in schema;
}

async function converted(schema: unknown): Promise<JsonSchemaObject> {
  if (isZod4Schema(schema)) {
    const toJSONSchema = (z as unknown as { toJSONSchema?: Zod4JsonSchema }).toJSONSchema;
    if (!toJSONSchema) return UNDESCRIBED;
    return toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  }
  const { zodSchema } = await import("ai");
  return zodSchema(schema as never).jsonSchema as JsonSchemaObject;
}

/**
 * The configuration schema of one block type, always an object schema.
 *
 * `$schema` is dropped: the two converters name different drafts for the same
 * shape, and which one a test or production happened to run is not something a
 * caller should read into. A union of shapes (Transform's operations) is kept
 * as the union and marked an object at the top, which it always is.
 */
export async function blockConfigurationSchema(paramsSchema: unknown): Promise<JsonSchemaObject> {
  if (paramsSchema === undefined || paramsSchema === null) return UNDESCRIBED;
  let schema: JsonSchemaObject;
  try {
    schema = await converted(paramsSchema);
  } catch {
    return UNDESCRIBED;
  }
  if (typeof schema !== "object" || schema === null) return UNDESCRIBED;
  const shape: JsonSchemaObject = { ...schema };
  delete shape.$schema;
  return shape.type === undefined ? { type: "object", ...shape } : shape;
}
