import { Worker } from "bullmq";
import type { CancellationJobData } from "@blazebot/shared";
import {
  createRedisConnection,
  maintenanceQueue,
  createLogger,
} from "@blazebot/shared";
import { workerEnv } from "./env.js";
import { createWorker } from "./worker.js";
import { cleanupOrphanContainers, teardownContainer } from "./sandbox/manager.js";
import { runMaintenancePoll } from "./poller.js";

const logger = createLogger();

async function main() {
  await cleanupOrphanContainers();

  const worker = createWorker();

  // Dedicated cancellation worker on a separate queue so teardowns
  // run immediately without waiting for long-running jobs to finish.
  const cancellationWorker = new Worker<CancellationJobData>(
    "cancellation",
    async (job) => {
      await teardownContainer(job.data.containerId);
      logger.info(
        { ticketId: job.data.ticketId, containerId: job.data.containerId },
        "container_teardown",
      );
    },
    { connection: createRedisConnection(), concurrency: 2 },
  );

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
    await cancellationWorker.close();
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
