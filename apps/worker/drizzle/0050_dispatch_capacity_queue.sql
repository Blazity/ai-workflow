CREATE TABLE "dispatch_capacity_queue" (
	"ticket_key" text PRIMARY KEY NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone
);
