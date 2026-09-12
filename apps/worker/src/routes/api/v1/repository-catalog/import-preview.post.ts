import { createError, defineEventHandler, readBody } from "h3";
import {
  parseRequestBody,
  repositoryCatalogImportPreviewRequestSchema,
  type RepositoryCatalogImportPreviewResponse,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import { previewRepositoryImport } from "../../../../services/repository-catalog/index.js";

/**
 * What the installation exposes, and what the catalog already holds.
 *
 * Open to every dashboard role, like the rest of the catalog's reads: seeing
 * which repositories exist is not a privilege, and a member who cannot see the
 * list cannot read a run either. The write is the commit beside this file, and
 * that one asks for the role.
 */
export default defineEventHandler(
  async (event): Promise<RepositoryCatalogImportPreviewResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const parsed = parseRequestBody(
        repositoryCatalogImportPreviewRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return await previewRepositoryImport();
    } catch (error) {
      toHttpError(error);
    }
  },
);
