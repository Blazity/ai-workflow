import { createError, defineEventHandler, readBody } from "h3";
import type {
  PromptLibraryDetailResponse,
  PromptSlotDefinition,
} from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor } from "../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../pre-pr-checks/store.js";
import { createPrompt, serializePromptMeta, serializePromptVersion } from "../../../prompt-library/store.js";
import { toPromptLibraryHttpError } from "./prompt-library.get.js";

interface CreateBody {
  name?: unknown;
  body?: unknown;
  slots?: unknown;
  description?: unknown;
  tags?: unknown;
}

export default defineEventHandler(
  async (event): Promise<PromptLibraryDetailResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const body = (await readBody<CreateBody>(event).catch(() => null)) ?? {};
      if (typeof body.name !== "string") {
        throw createError({ statusCode: 400, statusMessage: "Invalid name" });
      }
      if (typeof body.body !== "string") {
        throw createError({ statusCode: 400, statusMessage: "Invalid body" });
      }
      if (body.slots !== undefined && !Array.isArray(body.slots)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid slots" });
      }
      if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
        throw createError({ statusCode: 400, statusMessage: "Invalid description" });
      }
      if (body.tags !== undefined && !Array.isArray(body.tags)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid tags" });
      }

      const dbHandle = getDb();
      const { prompt, current } = await createPrompt(dbHandle, {
        name: body.name,
        body: body.body,
        slots: body.slots as PromptSlotDefinition[] | undefined,
        description: body.description as string | null | undefined,
        tags: body.tags as string[] | undefined,
        actor: {
          role: actor.role,
          id: actor.userId,
          label: await dashboardUserLabel(dbHandle, actor.userId),
        },
      });

      const version = serializePromptVersion(current);
      return {
        meta: serializePromptMeta(prompt, current.version),
        current: version,
        versions: [version],
      };
    } catch (error) {
      toPromptLibraryHttpError(error);
    }
  },
);
