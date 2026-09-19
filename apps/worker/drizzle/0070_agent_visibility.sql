CREATE TABLE "agent_briefing_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"captured_count" integer DEFAULT 0 NOT NULL,
	"disabled_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"conflict_count" integer DEFAULT 0 NOT NULL,
	"first_recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_briefing_texts" (
	"sha256" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"bytes" integer NOT NULL,
	"last_referenced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_briefing_texts_sha256_check" CHECK ("agent_briefing_texts"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_briefing_texts_bytes_check" CHECK ("agent_briefing_texts"."bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_briefings" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"activation_scope_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"capture" text NOT NULL,
	"briefing_index" jsonb,
	"content_sha256" text,
	"text_sha256s" text[] NOT NULL,
	"bytes" integer NOT NULL,
	"detail" text,
	"captured_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_briefings_kind_check" CHECK ("agent_briefings"."kind" in ('discovery', 'agent', 'llm')),
	CONSTRAINT "agent_briefings_capture_check" CHECK ("agent_briefings"."capture" in ('captured', 'capture_disabled', 'capture_skipped')),
	CONSTRAINT "agent_briefings_attempt_check" CHECK ("agent_briefings"."attempt" > 0),
	CONSTRAINT "agent_briefings_sequence_check" CHECK ("agent_briefings"."sequence" > 0),
	CONSTRAINT "agent_briefings_captured_index_check" CHECK (("agent_briefings"."capture" = 'captured') = ("agent_briefings"."briefing_index" is not null and "agent_briefings"."content_sha256" is not null))
);
--> statement-breakpoint
CREATE TABLE "clarification_answer_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"clarification_id" text NOT NULL,
	"previous_id" integer NOT NULL,
	"words" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_display" text NOT NULL,
	"surface" text NOT NULL,
	"reading" jsonb,
	"note" text,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "clarification_answer_deliveries_author_kind_check" CHECK ("clarification_answer_deliveries"."author_kind" in ('person', 'several_people')),
	CONSTRAINT "clarification_answer_deliveries_surface_check" CHECK ("clarification_answer_deliveries"."surface" in ('jira', 'dashboard', 'mcp', 'other')),
	CONSTRAINT "clarification_answer_deliveries_count_check" CHECK ("clarification_answer_deliveries"."count" >= 1),
	CONSTRAINT "clarification_answer_deliveries_previous_check" CHECK ("clarification_answer_deliveries"."previous_id" >= 0),
	CONSTRAINT "clarification_answer_deliveries_time_check" CHECK ("clarification_answer_deliveries"."last_at" >= "clarification_answer_deliveries"."first_at")
);
--> statement-breakpoint
ALTER TABLE "clarification_answer_deliveries" ADD CONSTRAINT "clarification_answer_deliveries_clarification_id_clarification_requests_id_fk" FOREIGN KEY ("clarification_id") REFERENCES "public"."clarification_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_briefings_identity_unique" ON "agent_briefings" USING btree ("run_id","node_id","attempt","activation_scope_id","sequence");--> statement-breakpoint
CREATE INDEX "agent_briefings_expires_at_idx" ON "agent_briefings" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_briefings_text_sha256s_idx" ON "agent_briefings" USING gin ("text_sha256s");--> statement-breakpoint
CREATE UNIQUE INDEX "clarification_answer_deliveries_chain_unique" ON "clarification_answer_deliveries" USING btree ("clarification_id","previous_id");--> statement-breakpoint
CREATE INDEX "clarification_answer_deliveries_clarification_idx" ON "clarification_answer_deliveries" USING btree ("clarification_id","id");