import { createError, defineEventHandler, readBody, setResponseHeader } from "h3";
import type { JsonSchemaAuthoringInspectionResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../lib/auth/request-context.js";
import { inspectAuthoredJsonSchema } from "../../../../workflow-definition/json-schema-authoring.js";

export default defineEventHandler(
  async (event): Promise<JsonSchemaAuthoringInspectionResponse | undefined> => {
    try {
      setResponseHeader(event, "Cache-Control", "private, no-store");
      await requireDashboardActor(event);
      const body = (await readBody<{ source?: unknown }>(event).catch(() => null)) ?? {};
      if (typeof body.source !== "string") {
        throw createError({
          statusCode: 400,
          statusMessage: "source must be a JSON Schema string",
        });
      }
      return inspectAuthoredJsonSchema(body.source);
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      toHttpError(error);
    }
  },
);
