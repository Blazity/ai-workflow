CREATE TABLE "dispatch_capacity_notices" (
	"subject_key" text PRIMARY KEY NOT NULL,
	"ticket_key" text NOT NULL,
	"queued_since" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone
);
