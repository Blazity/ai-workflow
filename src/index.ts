import Fastify from "fastify";
import { env } from "../env.js";
import {
  parseJiraWebhook,
  verifyJiraWebhookSignature,
} from "./webhooks/jira.js";
import { routeTicketTransition } from "./webhooks/router.js";
import { createWorker } from "./worker.js";

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
      return reply.code(401).send({ error: "invalid signature" });
    }

    const event = parseJiraWebhook(request.body);
    if (event) {
      routeTicketTransition(event);
    }
    return { ok: true };
  });

  return app;
}

async function main() {
  const app = buildApp();
  const worker = createWorker();

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async () => {
    const forceTimeout = setTimeout(() => process.exit(1), 30_000);
    forceTimeout.unref();
    await worker.close();
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
