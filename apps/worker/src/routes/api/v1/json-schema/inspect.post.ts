import { createError, defineEventHandler, readBody, setResponseHeader } from "h3";
import {
  jsonSchemaInspectRequestSchema,
  parseRequestBody,
  type JsonSchemaAuthoringInspectionResponse,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import {
  inspectJsonSchemaSource,
} from "../../../../services/json-schema/schema-inspection.js";

export default defineEventHandler(
  async (event): Promise<JsonSchemaAuthoringInspectionResponse | undefined> => {
    try {
      setResponseHeader(event, "Cache-Control", "private, no-store");
      await requireDashboardActor(event);
      const parsed = parseRequestBody(
        jsonSchemaInspectRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return inspectJsonSchemaSource(parsed.value.source);
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      toHttpError(error);
    }
  },
);
