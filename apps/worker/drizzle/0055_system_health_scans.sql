CREATE TABLE "system_health_scans" (
	"scope" text PRIMARY KEY DEFAULT 'deployment' NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"report" jsonb NOT NULL
);
