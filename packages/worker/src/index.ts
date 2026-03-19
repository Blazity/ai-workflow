import { Worker } from "bullmq";
import {
  createRedisConnection,
  maintenanceQueue,
  createLogger,
} from "@blazebot/shared";
import { workerEnv } from "./env.js";
import { createWorker } from "./worker.js";
import { cleanupOrphanContainers } from "./sandbox/manager.js";
import { runMaintenancePoll } from "./poller.js";

const logger = createLogger();

async function main() {
  await cleanupOrphanContainers();

  const worker = createWorker();

  const maintenanceWorker = new Worker(
    "maintenance",
    async () => {
      await runMaintenancePoll();
    },
    { connection: createRedisConnection(), concurrency: 1 },
  );

  await maintenanceQueue.add(
    "poll",
    {},
    { repeat: { every: workerEnv.POLL_INTERVAL_MS } },
  );
  logger.info(
    { intervalMs: workerEnv.POLL_INTERVAL_MS },
    "maintenance_poll_scheduled",
  );

  logger.info("worker_started");

  const shutdown = async () => {
    logger.info("shutdown_initiated");
    const forceTimeout = setTimeout(() => process.exit(1), 30_000);
    forceTimeout.unref();
    await worker.close();
    await maintenanceWorker.close();
    clearTimeout(forceTimeout);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
