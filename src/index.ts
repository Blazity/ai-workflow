import Fastify from "fastify";
import { Worker } from "bullmq";
import { env } from "./env.js";
import {
  parseJiraWebhook,
  verifyJiraWebhookSignature,
} from "./webhooks/jira.js";
import { routeTicketTransition } from "./webhooks/router.js";
import { createWorker } from "./worker.js";
import { cleanupOrphanContainers } from "./sandbox/manager.js";
import { createLogger } from "./logger.js";
import { maintenanceQueue } from "./queue.js";
import { createRedisConnection } from "./redis.js";
import { runMaintenancePoll } from "./poller.js";

const logger = createLogger();

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export function buildApp() {
  const app = Fastify({ logger: true });

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      try {
        done(null, JSON.parse((body as Buffer).toString()));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.post("/webhooks/jira", async (request, reply) => {
    if (!request.rawBody) {
      logger.warn({ path: "/webhooks/jira" }, "webhook_validation_failed");
      return reply.code(401).send({ error: "invalid signature" });
    }
    const rawSignature = request.headers["x-hub-signature"];
    const signature = Array.isArray(rawSignature)
      ? rawSignature[0]
      : rawSignature;
    const valid = verifyJiraWebhookSignature(
      request.rawBody,
      signature,
      env.JIRA_WEBHOOK_SECRET,
    );
    if (!valid) {
      logger.warn({ path: "/webhooks/jira" }, "webhook_validation_failed");
      return reply.code(401).send({ error: "invalid signature" });
    }

    const event = parseJiraWebhook(request.body);
    if (event) {
      logger.info(
        { ticketId: event.ticketId, type: event.type, triggeredBy: event.triggeredBy },
        "webhook_received",
      );
      await routeTicketTransition(event);
    }
    return { ok: true };
  });

  return app;
}

export async function main() {
  await cleanupOrphanContainers();

  const app = buildApp();
  const worker = createWorker();

  const maintenanceWorker = new Worker(
    "maintenance",
    async () => { await runMaintenancePoll(); },
    { connection: createRedisConnection(), concurrency: 1 },
  );

  await maintenanceQueue.add(
    "poll",
    {},
    { repeat: { every: env.POLL_INTERVAL_MS } },
  );
  logger.info({ intervalMs: env.POLL_INTERVAL_MS }, "maintenance_poll_scheduled");

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    logger.info({ port: env.PORT }, "server_started");
  } catch (err) {
    logger.error(err, "server_start_failed");
    process.exit(1);
  }

  const shutdown = async () => {
    logger.info("shutdown_initiated");
    const forceTimeout = setTimeout(() => process.exit(1), 30_000);
    forceTimeout.unref();
    await worker.close();
    await maintenanceWorker.close();
    clearTimeout(forceTimeout);
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
