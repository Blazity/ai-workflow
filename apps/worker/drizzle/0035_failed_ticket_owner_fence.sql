-- Failed-ticket markers suppress future pickup, so their write and cancellation
-- paths must linearize on the same active_runs row. These functions use
-- separate PL/pgSQL commands deliberately: at READ COMMITTED, cancellation's
-- DELETE receives a fresh snapshot after an UPDATE that may have waited for a
-- concurrent marker writer.
--
-- Pods deployed before the cancellation protocol migration update only state
-- and updated_at when cancellation begins. Normalize that exact rolling-update
-- shape below the application boundary. The -1 marker opens reconciliation but
-- still leaves the old pod's direct DELETE fail-closed until a current
-- reconciler records the observed ticket mutation version.
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
		AND NEW."ticket_cancellation_reconciled_version" IS NULL THEN
		NEW."ticket_cancellation_reconciled_version" := -1;
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

CREATE OR REPLACE FUNCTION "mark_failed_ticket_if_active"(
	"p_ticket_key" text,
	"p_run_id" text,
	"p_error" text,
	"p_failed_at" text,
	"p_subject_key" text,
	"p_owner_token" text,
	"p_owner_run_id" text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
	"v_subject_key" text;
BEGIN
	SELECT active."subject_key"
	INTO "v_subject_key"
	FROM "active_runs" AS active
	WHERE active."subject_key" = "p_subject_key"
		AND active."ticket_key" = "p_ticket_key"
		AND active."owner_token" = "p_owner_token"
		AND active."run_id" = "p_owner_run_id"
		AND "p_run_id" = "p_owner_run_id"
		AND active."state" = 'bound'
	FOR UPDATE;

	IF NOT FOUND THEN
		RETURN false;
	END IF;

	INSERT INTO "failed_tickets" ("ticket_key", "run_id", "error", "failed_at")
	VALUES ("p_ticket_key", "p_run_id", "p_error", "p_failed_at")
	ON CONFLICT ("ticket_key") DO UPDATE
	SET
		"run_id" = EXCLUDED."run_id",
		"error" = EXCLUDED."error",
		"failed_at" = EXCLUDED."failed_at";

	RETURN true;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "begin_active_run_cancellation"(
	"p_subject_key" text,
	"p_owner_token" text,
	"p_run_id" text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
	"v_ticket_key" text;
	"v_run_id" text;
BEGIN
	UPDATE "active_runs" AS active
	SET
		"state" = 'cancelling',
		"ticket_cancellation_reconciled_version" = -1,
		"updated_at" = now()
	WHERE active."subject_key" = "p_subject_key"
		AND active."owner_token" = "p_owner_token"
		AND active."run_id" IS NOT DISTINCT FROM "p_run_id"
		AND active."state" IN ('reserved', 'bound', 'parking', 'parked', 'cancelling')
	RETURNING active."ticket_key", active."run_id"
	INTO "v_ticket_key", "v_run_id";

	IF NOT FOUND THEN
		RETURN false;
	END IF;

	IF "v_ticket_key" IS NOT NULL AND "v_run_id" IS NOT NULL THEN
		DELETE FROM "failed_tickets"
		WHERE "ticket_key" = "v_ticket_key"
			AND "run_id" = "v_run_id";
	END IF;

	RETURN true;
END;
$$;--> statement-breakpoint

-- Rolling-deployment fence: older pods still execute the legacy two-argument
-- application upsert. Validate and lock its active row below the application
-- boundary so a stale old workflow cannot recreate a marker after cancellation.
CREATE OR REPLACE FUNCTION "guard_failed_ticket_active_run"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	"v_subject_key" text;
BEGIN
	SELECT active."subject_key"
	INTO "v_subject_key"
	FROM "active_runs" AS active
	WHERE active."ticket_key" = NEW."ticket_key"
		AND active."run_id" = NEW."run_id"
		AND active."state" = 'bound'
	FOR UPDATE;

	IF NOT FOUND THEN
		RETURN NULL;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "failed_ticket_active_run_guard_trigger"
BEFORE INSERT OR UPDATE ON "failed_tickets"
FOR EACH ROW
EXECUTE FUNCTION "guard_failed_ticket_active_run"();--> statement-breakpoint

-- Older pods also use a direct UPDATE to begin cancellation. Run the matching
-- marker cleanup below that boundary so both old and new cancellation paths
-- clear an insert that committed while their active-row update was waiting.
CREATE OR REPLACE FUNCTION "clear_failed_ticket_on_cancellation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."state" = 'cancelling'
		AND NEW."ticket_key" IS NOT NULL
		AND NEW."run_id" IS NOT NULL
	THEN
		DELETE FROM "failed_tickets"
		WHERE "ticket_key" = NEW."ticket_key"
			AND "run_id" = NEW."run_id";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "active_run_cancellation_failed_ticket_cleanup_trigger"
AFTER INSERT OR UPDATE OF "state" ON "active_runs"
FOR EACH ROW
WHEN (NEW."state" = 'cancelling')
EXECUTE FUNCTION "clear_failed_ticket_on_cancellation"();--> statement-breakpoint

-- Repair markers already stranded by a cancellation before this migration.
DELETE FROM "failed_tickets" AS failed
USING "active_runs" AS active
WHERE active."state" = 'cancelling'
	AND active."ticket_key" = failed."ticket_key"
	AND active."run_id" = failed."run_id";
