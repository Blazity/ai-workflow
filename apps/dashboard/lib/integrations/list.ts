import "server-only";
import { cache } from "react";

import type { IntegrationsListResponse } from "@shared/contracts";

import { authAwareFallback, getJSON } from "@/lib/api/server";

/**
 * The integrations list, read once per request.
 *
 * There is one endpoint and one resolver behind it (ADR-010, "One resolver"),
 * and several things on one page now want its answer: the sidebar reads it in
 * the cockpit layout, an integration's area reads it to know whether the
 * integration is in use, and the Integrations screens read it for their own
 * cards. `cache` makes those one round trip and, more to the point, one answer:
 * a sidebar and a screen that disagreed about the same deployment because they
 * asked a second apart would be a bug nobody could reproduce.
 *
 * Null means the worker did not answer. Every caller degrades rather than
 * failing: 401 still redirects to the login screen and 403 still throws, which
 * is `authAwareFallback`'s job and not this function's.
 */
export const readIntegrationsList = cache(
  async (): Promise<IntegrationsListResponse | null> =>
    getJSON<IntegrationsListResponse>("/api/v1/integrations").catch((error) =>
      authAwareFallback(error, (): IntegrationsListResponse | null => null),
    ),
);
