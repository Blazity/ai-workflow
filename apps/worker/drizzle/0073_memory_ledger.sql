CREATE TABLE "memory_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"run_id" text,
	"actor" text NOT NULL,
	"source" text,
	"store" text,
	"subject" text,
	"kind" text,
	"entry_id" text,
	"entry_key" uuid,
	"text" text,
	"text_hash" text,
	"previous_text" text,
	"previous_text_hash" text,
	"text_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"reason" text,
	"ticket_key" text,
	"pr_ref" text,
	"invocation_key" text,
	"dedupe_key" text,
	"refers_to" bigint,
	"topic" text,
	"area" text,
	"bytes" integer,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"text_blanked_at" timestamp with time zone,
	CONSTRAINT "memory_events_event_check" CHECK ("memory_events"."event" in ('recalled', 'added', 'updated', 'removed', 'duplicate', 'rejected', 'redacted', 'unavailable', 'contradicted', 'confirmed', 'superseded_by_store', 'imported', 'store_changed', 'notebook_saved', 'notebook_withheld', 'notebook_absent', 'notebook_truncated', 'proposed_org', 'promoted', 'kept_local', 'dismissed', 'moved', 'classified', 'reclassified', 'pinned', 'unpinned', 'trust_changed', 'disputed', 'dispute_resolved', 'stale', 'unstale', 'reanchored', 'rederived', 'retired', 'restored', 'proposed', 'proposal_applied', 'proposal_held', 'proposal_dropped', 'reviewed', 'feedback_rejected', 'lookup_rejected', 'lookups', 'collected', 'hooks_unobserved', 'tree_unwritten', 'focus_unmatched', 'sweep_skipped')),
	CONSTRAINT "memory_events_actor_check" CHECK ("memory_events"."actor" in ('run', 'system') or "memory_events"."actor" ~ '^(admin|mcp):.+$'),
	CONSTRAINT "memory_events_source_check" CHECK ("memory_events"."source" in ('distill', 'feedback', 'human', 'seed', 'sweep', 'acceptance', 'system')),
	CONSTRAINT "memory_events_topic_check" CHECK ("memory_events"."topic" in ('setup', 'commands', 'testing', 'ci-deploy', 'structure', 'conventions', 'data', 'integrations', 'domain', 'other')),
	CONSTRAINT "memory_events_kind_check" CHECK ("memory_events"."kind" in ('facts', 'lessons', 'notebook')),
	CONSTRAINT "memory_events_text_hash_check" CHECK ("memory_events"."text_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "memory_events_previous_text_hash_check" CHECK ("memory_events"."previous_text_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "memory_events_text_hashed_check" CHECK (("memory_events"."text" is null or "memory_events"."text_hash" is not null) and ("memory_events"."previous_text" is null or "memory_events"."previous_text_hash" is not null)),
	CONSTRAINT "memory_events_detail_check" CHECK (jsonb_typeof("memory_events"."detail") = 'object'),
	CONSTRAINT "memory_events_bytes_check" CHECK ("memory_events"."bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "memory_entry_state" (
	"entry_key" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"kind" text NOT NULL,
	"text_hash" text NOT NULL,
	"store_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"topic" text NOT NULL,
	"area" text NOT NULL,
	"area_status" text NOT NULL,
	"area_candidates" text[] DEFAULT '{}'::text[] NOT NULL,
	"module" text,
	"anchors" text[] DEFAULT '{}'::text[] NOT NULL,
	"trust" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"status_since" timestamp with time zone DEFAULT now() NOT NULL,
	"open_disputes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"relearned_unseen" integer DEFAULT 0 NOT NULL,
	"origin_run_id" text,
	"origin_ticket" text,
	"last_admitted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_entry_state_kind_check" CHECK ("memory_entry_state"."kind" in ('facts', 'lessons')),
	CONSTRAINT "memory_entry_state_text_hash_check" CHECK ("memory_entry_state"."text_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "memory_entry_state_store_ids_check" CHECK (jsonb_typeof("memory_entry_state"."store_ids") = 'object'),
	CONSTRAINT "memory_entry_state_topic_check" CHECK ("memory_entry_state"."topic" in ('setup', 'commands', 'testing', 'ci-deploy', 'structure', 'conventions', 'data', 'integrations', 'domain', 'other')),
	CONSTRAINT "memory_entry_state_area_status_check" CHECK ("memory_entry_state"."area_status" in ('resolved', 'ambiguous', 'directory_only', 'unresolved')),
	CONSTRAINT "memory_entry_state_area_candidates_check" CHECK (cardinality("memory_entry_state"."area_candidates") <= 8),
	CONSTRAINT "memory_entry_state_anchors_check" CHECK (cardinality("memory_entry_state"."anchors") <= 5),
	CONSTRAINT "memory_entry_state_trust_check" CHECK ("memory_entry_state"."trust" in ('human', 'derived', 'checked', 'learned')),
	CONSTRAINT "memory_entry_state_status_check" CHECK ("memory_entry_state"."status" in ('active', 'disputed', 'stale', 'retired')),
	CONSTRAINT "memory_entry_state_open_disputes_check" CHECK (jsonb_typeof("memory_entry_state"."open_disputes") = 'array'),
	CONSTRAINT "memory_entry_state_relearned_unseen_check" CHECK ("memory_entry_state"."relearned_unseen" >= 0),
	CONSTRAINT "memory_entry_state_version_check" CHECK ("memory_entry_state"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_refers_to_memory_events_id_fk" FOREIGN KEY ("refers_to") REFERENCES "public"."memory_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_events_run_idx" ON "memory_events" USING btree ("run_id","id") WHERE "memory_events"."run_id" is not null;--> statement-breakpoint
CREATE INDEX "memory_events_subject_idx" ON "memory_events" USING btree ("subject","id") WHERE "memory_events"."subject" is not null;--> statement-breakpoint
CREATE INDEX "memory_events_entry_key_idx" ON "memory_events" USING btree ("entry_key","id") WHERE "memory_events"."entry_key" is not null;--> statement-breakpoint
CREATE INDEX "memory_events_text_hash_idx" ON "memory_events" USING btree ("text_hash") WHERE "memory_events"."text_hash" is not null;--> statement-breakpoint
CREATE INDEX "memory_events_text_hashes_idx" ON "memory_events" USING gin ("text_hashes");--> statement-breakpoint
CREATE INDEX "memory_events_pr_ref_idx" ON "memory_events" USING btree ("pr_ref","event","id") WHERE "memory_events"."pr_ref" is not null;--> statement-breakpoint
CREATE INDEX "memory_events_refers_to_idx" ON "memory_events" USING btree ("refers_to","event") WHERE "memory_events"."refers_to" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_events_dedupe_unique" ON "memory_events" USING btree ((coalesce("run_id", '')),"dedupe_key") WHERE "memory_events"."dedupe_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_entry_state_alias_unique" ON "memory_entry_state" USING btree ("subject","kind","text_hash");--> statement-breakpoint
CREATE INDEX "memory_entry_state_text_hash_idx" ON "memory_entry_state" USING btree ("text_hash");