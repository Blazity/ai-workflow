import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Only needed by `drizzle-kit migrate`; `generate` works without it.
    url: process.env.DATABASE_URL ?? "",
  },
});
