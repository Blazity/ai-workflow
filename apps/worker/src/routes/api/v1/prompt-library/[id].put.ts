import { createError, defineEventHandler, readBody } from "h3";
import type { PromptLibrarySaveResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor } from "../../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../../pre-pr-checks/store.js";
import {
  getPrompt,
  savePromptVersion,
  serializePromptMeta,
  serializePromptVersion,
} from "../../../../prompt-library/store.js";
import { parsePromptId, toPromptLibraryHttpError } from "../prompt-library.get.js";

export default defineEventHandler(
  async (event): Promise<PromptLibrarySaveResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parsePromptId(event);
      const body = (await readBody<{ body?: unknown }>(event).catch(() => null)) ?? {};
      if (typeof body.body !== "string") {
        throw createError({ statusCode: 400, statusMessage: "Invalid body" });
      }

      const dbHandle = getDb();
      const { version, changed } = await savePromptVersion(dbHandle, {
        promptId: id,
        body: body.body,
        actor: {
          role: actor.role,
          id: actor.userId,
          label: await dashboardUserLabel(dbHandle, actor.userId),
        },
      });
      const row = await getPrompt(dbHandle, id);
      return {
        meta: serializePromptMeta(row!, version.version),
        version: serializePromptVersion(version),
        changed,
      };
    } catch (error) {
      toPromptLibraryHttpError(error);
    }
  },
);
