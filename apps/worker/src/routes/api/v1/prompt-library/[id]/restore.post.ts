import { createError, defineEventHandler, readBody } from "h3";
import type { PromptLibrarySaveResponse } from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import { requireDashboardActor } from "../../../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../../../pre-pr-checks/store.js";
import {
  getPrompt,
  restorePromptVersion,
  serializePromptMeta,
  serializePromptVersion,
} from "../../../../../prompt-library/store.js";
import { parsePromptId, toPromptLibraryHttpError } from "../../prompt-library.get.js";

export default defineEventHandler(
  async (event): Promise<PromptLibrarySaveResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parsePromptId(event);
      const body = (await readBody<{ version?: unknown }>(event).catch(() => null)) ?? {};
      // Reject values outside the int4 range the version column stores (either
      // sign overflows the query into a 500 instead of a clean 400); versions
      // start at 1, so everything below that is invalid anyway.
      if (
        typeof body.version !== "number" ||
        !Number.isInteger(body.version) ||
        body.version < 1 ||
        body.version > 2147483647
      ) {
        throw createError({ statusCode: 400, statusMessage: "Invalid version" });
      }

      const dbHandle = getDb();
      const restored = await restorePromptVersion(dbHandle, {
        promptId: id,
        version: body.version,
        actor: {
          role: actor.role,
          id: actor.userId,
          label: await dashboardUserLabel(dbHandle, actor.userId),
        },
      });
      const row = await getPrompt(dbHandle, id);
      return {
        meta: serializePromptMeta(row!, restored.version),
        version: serializePromptVersion(restored),
        changed: true,
      };
    } catch (error) {
      toPromptLibraryHttpError(error);
    }
  },
);
