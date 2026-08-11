import { defineEventHandler } from "h3";

import { handleMcpPost } from "../mcp/transport.js";

export default defineEventHandler(handleMcpPost);
