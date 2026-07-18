ALTER TABLE "trigger_deliveries" ALTER COLUMN "subject_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger_deliveries" ADD CONSTRAINT "trigger_deliveries_state_check" CHECK ((
        ("trigger_deliveries"."status" = 'received' and "trigger_deliveries"."subject_key" is null and "trigger_deliveries"."result" is null)
        or ("trigger_deliveries"."status" = 'accepted' and "trigger_deliveries"."subject_key" is not null and "trigger_deliveries"."result" is null)
        or ("trigger_deliveries"."status" = 'completed' and "trigger_deliveries"."result" is not null)
      ));