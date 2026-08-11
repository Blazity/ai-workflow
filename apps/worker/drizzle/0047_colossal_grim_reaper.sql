CREATE TABLE "trigger_rate_limits" (
	"definition_id" text NOT NULL,
	"node_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "trigger_rate_limits_definition_id_node_id_window_start_pk" PRIMARY KEY("definition_id","node_id","window_start")
);
--> statement-breakpoint
CREATE TABLE "trigger_rejection_counters" (
	"definition_id" text NOT NULL,
	"node_id" text NOT NULL,
	"reason" text NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "trigger_rejection_counters_definition_id_node_id_day_reason_pk" PRIMARY KEY("definition_id","node_id","day","reason")
);
