import { defineEventHandler, toWebRequest } from "h3";

import { auth } from "../../../../auth-instance.js";

export default defineEventHandler((event) => auth.handler(toWebRequest(event)));
