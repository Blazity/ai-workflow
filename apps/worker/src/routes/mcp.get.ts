import { defineEventHandler } from "h3";

import { handleMcpMethodNotAllowed } from "../mcp/transport.js";

export default defineEventHandler(handleMcpMethodNotAllowed);
