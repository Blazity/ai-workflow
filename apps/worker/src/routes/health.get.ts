import { defineEventHandler } from "h3";

// The cluster's module, not its barrel: this route has to answer while the
// deployment is degraded, so it must not depend on every module the system
// cluster re-exports (and through them the engine graph) resolving first.
import { healthResponse } from "../services/system/health-response.js";

export default defineEventHandler(() => healthResponse());
