CREATE TABLE "system_health_observation_counters" (
	"integration_id" text NOT NULL,
	"check_id" text NOT NULL,
	"scope" text DEFAULT 'deployment' NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_health_observation_counters_pk" PRIMARY KEY("integration_id","check_id","scope","window_start","outcome","reason")
);
