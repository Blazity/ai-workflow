ALTER TABLE "gate_current" ADD COLUMN "gate_status_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "gate_current"
SET "gate_status_refs" = COALESCE(
  (
    SELECT jsonb_agg(jsonb_build_object('provider', 'github', 'id', id))
    FROM unnest("check_run_ids") AS id
  ),
  '[]'::jsonb
);
