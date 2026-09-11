import { createError, defineEventHandler, getRouterParam } from "h3";
import type { PromptLibraryVersionResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../../services/auth/request-context.js";
import {
  isStorablePromptVersion,
} from "../../../../../../services/prompts/prompt-library-identifiers.js";
import {
  readPromptVersion,
} from "../../../../../../services/prompts/prompt-library-reads.js";
import { parsePromptId } from "../../../prompt-library.get.js";

export default defineEventHandler(
  async (event): Promise<PromptLibraryVersionResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const id = parsePromptId(event);
      const version = Number(getRouterParam(event, "version"));
      if (!isStorablePromptVersion(version)) {
        throw createError({ statusCode: 404, statusMessage: "Unknown version" });
      }

      const row = await readPromptVersion(id, version);
      if (!row) {
        throw createError({ statusCode: 404, statusMessage: "Unknown version" });
      }
      return { version: row };
    } catch (error) {
      toHttpError(error);
    }
  },
);
