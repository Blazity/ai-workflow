import { defineEventHandler } from "h3";
import type { PromptLibraryUsageResponse } from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../../lib/auth/request-context.js";
import { findPromptUsage, findPromptUsageInPrompts } from "../../../../../prompt-library/store.js";
import { parsePromptId } from "../../prompt-library.get.js";

export default defineEventHandler(async (event): Promise<PromptLibraryUsageResponse | undefined> => {
  try {
    await requireDashboardActor(event);
    const id = parsePromptId(event);
    const db = getDb();
    const [rows, prompts] = await Promise.all([
      findPromptUsage(db, id),
      findPromptUsageInPrompts(db, id),
    ]);
    return { rows, prompts };
  } catch (error) {
    toHttpError(error);
  }
});
