import { createError, defineEventHandler, getRouterParam } from "h3";
import type { PromptLibraryVersionResponse } from "@shared/contracts";
import { getDb } from "../../../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../../../lib/auth/request-context.js";
import { getPromptVersion, serializePromptVersion } from "../../../../../../prompt-library/store.js";
import { parsePromptId } from "../../../prompt-library.get.js";

export default defineEventHandler(
  async (event): Promise<PromptLibraryVersionResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const id = parsePromptId(event);
      const version = Number(getRouterParam(event, "version"));
      // Postgres version columns are int4; a value past its max would overflow
      // the query and surface as a 500, so treat it as an unknown version.
      if (!Number.isInteger(version) || version <= 0 || version > 2147483647) {
        throw createError({ statusCode: 404, statusMessage: "Unknown version" });
      }

      // Reads a version even for an archived prompt.
      const row = await getPromptVersion(getDb(), id, version);
      if (!row) {
        throw createError({ statusCode: 404, statusMessage: "Unknown version" });
      }
      return { version: serializePromptVersion(row) };
    } catch (error) {
      toHttpError(error);
    }
  },
);
