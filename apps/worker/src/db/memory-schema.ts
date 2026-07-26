import { index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Agent memory documents kept out of the customer repository.
 *
 * Keyed by (subject_key, doc_path): subject_key is the canonical identity of a
 * run's subject (ticket or PR), and doc_path leaves room for future documents
 * (per-repo scope, lessons) without another migration. The neon-http driver has
 * no transaction support, so every write here must be a single SQL statement.
 */
export const agentMemoryDocuments = pgTable(
  "agent_memory_documents",
  {
    subjectKey: text("subject_key").notNull(),
    docPath: text("doc_path").notNull(),
    ticketKey: text("ticket_key"),
    content: text("content").notNull(),
    bytes: integer("bytes").notNull(),
    sourceRunId: text("source_run_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.subjectKey, t.docPath] }),
    index("agent_memory_documents_ticket_key_idx").on(t.ticketKey),
    index("agent_memory_documents_updated_at_idx").on(t.updatedAt),
  ],
);
