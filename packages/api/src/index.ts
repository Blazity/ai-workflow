import Fastify from "fastify";
import { env, createLogger, parseJiraWebhook } from "@blazebot/shared";
import { apiEnv } from "./env.js";
import { verifyJiraWebhookSignature } from "./webhooks/jira.js";
import { routeTicketTransition } from "./webhooks/router.js";

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
      apiEnv.JIRA_WEBHOOK_SECRET,
    );
    if (!valid) {
      logger.warn({ path: "/webhooks/jira" }, "webhook_validation_failed");
      return reply.code(401).send({ error: "invalid signature" });
    }

    const event = parseJiraWebhook(request.body);
    if (event) {
      logger.info(
        {
          ticketId: event.ticketId,
          type: event.type,
          triggeredBy: event.triggeredBy,
        },
        "webhook_received",
      );
      await routeTicketTransition(event);
    }
    return { ok: true };
  });

  return app;
}

async function main() {
  const app = buildApp();

  try {
    await app.listen({ port: apiEnv.PORT, host: "0.0.0.0" });
    logger.info({ port: apiEnv.PORT }, "server_started");
  } catch (err) {
    logger.error(err, "server_start_failed");
    process.exit(1);
  }

  const shutdown = async () => {
    logger.info("shutdown_initiated");
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
