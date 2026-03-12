import Fastify from "fastify";
import { env } from "./env.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  return app;
}

async function main() {
  const app = buildApp();

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Only start the server when run directly, not when imported in tests
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
