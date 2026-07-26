CREATE TABLE "agent_memory_documents" (
	"subject_key" text NOT NULL,
	"doc_path" text NOT NULL,
	"ticket_key" text,
	"content" text NOT NULL,
	"bytes" integer NOT NULL,
	"source_run_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_documents_subject_key_doc_path_pk" PRIMARY KEY("subject_key","doc_path")
);
--> statement-breakpoint
CREATE INDEX "agent_memory_documents_ticket_key_idx" ON "agent_memory_documents" USING btree ("ticket_key");--> statement-breakpoint
CREATE INDEX "agent_memory_documents_updated_at_idx" ON "agent_memory_documents" USING btree ("updated_at");