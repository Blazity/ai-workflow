import { defineEventHandler } from "h3";
import { getDb } from "../db/client.js";
import { deploymentIdentity } from "../services/system/deployment-identity.js";

export default defineEventHandler(async () => {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    ...(await deploymentIdentity(getDb)),
  };
});
