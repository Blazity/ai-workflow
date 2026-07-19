ALTER TABLE "active_runs" ADD COLUMN "ticket_cancellation_reconciled_version" integer;--> statement-breakpoint

-- A cancellation already in progress when this migration lands has no durable
-- proof that its human destination was captured. Keep it distinct from the
-- current protocol's -1 (opened, awaiting reconciliation) marker so new pods
-- cannot silently bless and release an indeterminate legacy cancellation.
UPDATE "active_runs"
SET "ticket_cancellation_reconciled_version" = -2
WHERE "ticket_key" IS NOT NULL
	AND "state" = 'cancelling';--> statement-breakpoint

CREATE OR REPLACE FUNCTION "guard_ticket_cancellation_protocol"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW."ticket_key" IS NOT NULL
			AND NEW."state" = 'cancelling'
			AND NEW."ticket_cancellation_reconciled_version" IS DISTINCT FROM -1 THEN
			RAISE EXCEPTION 'ticket cancellation protocol marker is required';
		END IF;
		RETURN NEW;
	END IF;

	IF TG_OP = 'UPDATE'
		AND OLD."ticket_cancellation_reconciled_version" = -2
		AND NEW."ticket_cancellation_reconciled_version" IS DISTINCT FROM -2 THEN
		RAISE EXCEPTION 'legacy cancellation requires manual reconciliation';
	END IF;

	IF TG_OP = 'UPDATE'
		AND OLD."state" IS DISTINCT FROM 'cancelling'
		AND NEW."state" = 'cancelling'
		AND NEW."ticket_key" IS NOT NULL
		AND NEW."ticket_cancellation_reconciled_version" IS DISTINCT FROM -1 THEN
		RAISE EXCEPTION 'ticket cancellation protocol marker is required';
	END IF;

	IF TG_OP = 'DELETE'
		AND OLD."ticket_key" IS NOT NULL
		AND OLD."state" = 'cancelling'
		AND OLD."ticket_cancellation_reconciled_version"
			IS DISTINCT FROM OLD."ticket_mutation_version" THEN
		RAISE EXCEPTION 'ticket cancellation has not been reconciled';
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "active_run_ticket_cancellation_protocol_guard_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "active_runs"
FOR EACH ROW
EXECUTE FUNCTION "guard_ticket_cancellation_protocol"();
