-- Freeze OAuth client writes while the rollback columns are reconciled and the
-- dual-write trigger is installed. drizzle-kit migrate runs pending PostgreSQL
-- statements in one transaction, so this lock is held through the backfill and
-- journal update. Reads remain available throughout the expand-stage change.
LOCK TABLE
	"public"."oauth_client",
	"public"."oauth_client_resource",
	"public"."oauth_resource",
	"public"."oauth_access_token",
	"public"."oauth_refresh_token",
	"public"."verification"
IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
-- A 1.6 rollback cannot preserve sender constraints. Abort before installing
-- any bridge if 1.7-only DPoP state already exists. JWT cnf claims have no DB
-- row; the first 1.7 deployment must therefore precede any DPoP-capable release,
-- and an eventual rollback after enabling DPoP must rotate keys or wait out the
-- maximum JWT lifetime.
DO $$
DECLARE
	incompatible_record text;
BEGIN
	SELECT problem
	INTO incompatible_record
	FROM (
		SELECT 'oauth_access_token:' || "id" AS problem
		FROM "public"."oauth_access_token"
		WHERE "confirmation" IS NOT NULL
		UNION ALL
		SELECT 'oauth_client:' || "client_id"
		FROM "public"."oauth_client"
		WHERE "dpop_bound_access_tokens" IS TRUE
			OR "metadata" ->> 'dpop_bound_access_tokens' = 'true'
		UNION ALL
		SELECT 'oauth_refresh_token:' || "id"
		FROM "public"."oauth_refresh_token"
		WHERE "confirmation" IS NOT NULL
		UNION ALL
		SELECT 'oauth_resource:' || "identifier"
		FROM "public"."oauth_resource"
		WHERE "dpop_bound_access_tokens_required" IS TRUE
		UNION ALL
		SELECT 'verification:' || "id"
		FROM "public"."verification"
		WHERE "expires_at" > now()
			AND "value" ~ '"type"[[:space:]]*:[[:space:]]*"authorization_code"'
			AND "value" ~ '"dpop_jkt"[[:space:]]*:'
	) incompatible
	ORDER BY problem
	LIMIT 1;

	IF incompatible_record IS NOT NULL
	THEN
		RAISE EXCEPTION
			'oauth rollback bridge rejected existing sender-constrained state %',
			incompatible_record
			USING ERRCODE = '23514';
	END IF;
END $$;--> statement-breakpoint
-- A database with no OAuth clients may be migrated before the 1.7 resource
-- seed runs. Once clients exist, however, the AIW-330 preparation must already
-- have established one enabled resource and a link for every client.
DO $$
DECLARE
	client_count integer;
	enabled_resource_count integer;
	unlinked_client_id text;
BEGIN
	SELECT count(*)::integer INTO client_count
	FROM "public"."oauth_client";
	SELECT count(*)::integer INTO enabled_resource_count
	FROM "public"."oauth_resource"
	WHERE "disabled" IS FALSE;

	IF client_count = 0 AND enabled_resource_count > 1
	THEN
		RAISE EXCEPTION
			'oauth rollback bridge allows at most one enabled resource before the first client; found %',
			enabled_resource_count
			USING ERRCODE = '23514';
	END IF;

	IF client_count > 0
	THEN
		IF enabled_resource_count <> 1
		THEN
			RAISE EXCEPTION
				'oauth rollback bridge requires exactly one enabled resource for existing clients; found %',
				enabled_resource_count
				USING ERRCODE = '23514';
		END IF;

		SELECT client."client_id"
		INTO unlinked_client_id
		FROM "public"."oauth_client" AS client
		WHERE NOT EXISTS (
			SELECT 1
			FROM "public"."oauth_client_resource" AS link
			INNER JOIN "public"."oauth_resource" AS resource
				ON resource."identifier" = link."resource_id"
			WHERE link."client_id" = client."client_id"
				AND resource."disabled" IS FALSE
		)
		ORDER BY client."client_id"
		LIMIT 1;

		IF unlinked_client_id IS NOT NULL
		THEN
			RAISE EXCEPTION
				'oauth rollback bridge requires an enabled resource link for existing client %',
				unlinked_client_id
				USING ERRCODE = '23514';
		END IF;
	END IF;
END $$;--> statement-breakpoint
-- Keep the rollback window to one enabled resource even when two sessions race.
-- The trigger below retains a descriptive error for ordinary writes; this index
-- is the final concurrency-safe invariant enforced by PostgreSQL itself.
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_resource_single_enabled_rollback_idx"
ON "public"."oauth_resource" ((TRUE))
WHERE "disabled" IS FALSE;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."sync_oauth_client_rollback_fields"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	method_changed boolean;
	application_changed boolean;
	public_changed boolean;
	type_changed boolean;
	modern_changed boolean;
	legacy_changed boolean;
	type_application text;
BEGIN
	-- Keep the rollback window deliberately smaller than the 1.7 schema. Better
	-- Auth 1.6 cannot authenticate private_key_jwt (or extension) clients.
	IF NEW."token_endpoint_auth_method" IS NOT NULL
		AND NEW."token_endpoint_auth_method" NOT IN (
			'none', 'client_secret_basic', 'client_secret_post'
		)
	THEN
		RAISE EXCEPTION
			'oauth_client rollback bridge rejected client %: unsupported token_endpoint_auth_method %',
			NEW."client_id", NEW."token_endpoint_auth_method"
			USING ERRCODE = '23514';
	END IF;

	IF NEW."application_type" IS NOT NULL
		AND NEW."application_type" NOT IN ('web', 'native')
	THEN
		RAISE EXCEPTION
			'oauth_client rollback bridge rejected client %: unsupported application_type %',
			NEW."client_id", NEW."application_type"
			USING ERRCODE = '23514';
	END IF;

	IF NEW."type" IS NOT NULL
		AND NEW."type" NOT IN ('native', 'user-agent-based', 'web')
	THEN
		RAISE EXCEPTION
			'oauth_client rollback bridge rejected client %: unsupported legacy type %',
			NEW."client_id", NEW."type"
			USING ERRCODE = '23514';
	END IF;

	IF NEW."dpop_bound_access_tokens" IS TRUE
		OR NEW."metadata" ->> 'dpop_bound_access_tokens' = 'true'
	THEN
		RAISE EXCEPTION
			'oauth_client rollback bridge rejected client %: DPoP-bound clients are unsupported by Better Auth 1.6',
			NEW."client_id"
			USING ERRCODE = '23514';
	END IF;

	-- A legacy type without its public classification is not reversible. The
	-- valid 1.6 pairs are public native/user-agent, confidential web, or NULL.
	IF NEW."public" IS NULL AND NEW."type" IS NOT NULL
	THEN
		RAISE EXCEPTION
			'oauth_client rollback bridge rejected client %: legacy type % has no public classification',
			NEW."client_id", NEW."type"
			USING ERRCODE = '23514';
	END IF;

	IF NEW."public" IS TRUE AND NEW."type" = 'web'
	THEN
		RAISE EXCEPTION
			'oauth_client rollback bridge rejected client %: public legacy client cannot have type web',
			NEW."client_id"
			USING ERRCODE = '23514';
	END IF;

	IF NEW."public" IS FALSE
		AND NEW."type" IN ('native', 'user-agent-based')
	THEN
		RAISE EXCEPTION
			'oauth_client rollback bridge rejected client %: confidential legacy client cannot have type %',
			NEW."client_id", NEW."type"
			USING ERRCODE = '23514';
	END IF;

	IF TG_OP = 'INSERT'
	THEN
		method_changed := NEW."token_endpoint_auth_method" IS NOT NULL;
		application_changed := NEW."application_type" IS NOT NULL;
		public_changed := NEW."public" IS NOT NULL;
		type_changed := NEW."type" IS NOT NULL;
	ELSE
		method_changed := OLD."token_endpoint_auth_method"
			IS DISTINCT FROM NEW."token_endpoint_auth_method";
		application_changed := OLD."application_type"
			IS DISTINCT FROM NEW."application_type";
		public_changed := OLD."public" IS DISTINCT FROM NEW."public";
		type_changed := OLD."type" IS DISTINCT FROM NEW."type";
	END IF;

	modern_changed := method_changed OR application_changed;
	legacy_changed := public_changed OR type_changed;

	-- A 1.7-only write is authoritative for both legacy fields. NULL method is
	-- intentionally not interpreted as a confidential method: 1.6's exact
	-- secret method cannot be reconstructed. Ambiguous web stays unclassified.
	IF modern_changed AND NOT legacy_changed
	THEN
		IF NEW."token_endpoint_auth_method" IS NULL
		THEN
			IF NEW."application_type" = 'native'
			THEN
				RAISE EXCEPTION
					'oauth_client rollback bridge rejected client %: native client has no unambiguous public authentication method',
					NEW."client_id"
					USING ERRCODE = '23514';
			END IF;

			NEW."public" := NULL;
			NEW."type" := NULL;
		ELSIF NEW."token_endpoint_auth_method" = 'none'
		THEN
			NEW."public" := TRUE;
			NEW."type" := CASE NEW."application_type"
				WHEN 'native' THEN 'native'
				WHEN 'web' THEN 'user-agent-based'
				ELSE NULL
			END;
		ELSE
			IF NEW."application_type" = 'native'
			THEN
				RAISE EXCEPTION
					'oauth_client rollback bridge rejected client %: confidential native clients cannot roll back to Better Auth 1.6',
					NEW."client_id"
					USING ERRCODE = '23514';
			END IF;

			NEW."public" := FALSE;
			NEW."type" := CASE NEW."application_type"
				WHEN 'web' THEN 'web'
				ELSE NULL
			END;
		END IF;

		RETURN NEW;
	END IF;

	-- A 1.6-only write is authoritative for the modern application type. Public
	-- is enough to derive method=none. Confidential never selects a secret
	-- method: preserve an explicit supported method, otherwise leave it NULL.
	IF legacy_changed AND NOT modern_changed
	THEN
		IF NEW."public" IS TRUE
		THEN
			NEW."token_endpoint_auth_method" := 'none';
			NEW."application_type" := CASE NEW."type"
				WHEN 'native' THEN 'native'
				WHEN 'user-agent-based' THEN 'web'
				ELSE NULL
			END;
		ELSIF NEW."public" IS FALSE
		THEN
			IF NEW."token_endpoint_auth_method" NOT IN (
				'client_secret_basic', 'client_secret_post'
			)
			THEN
				NEW."token_endpoint_auth_method" := NULL;
			END IF;

			NEW."application_type" := CASE NEW."type"
				WHEN 'web' THEN 'web'
				ELSE NULL
			END;
		ELSE
			NEW."token_endpoint_auth_method" := NULL;
			NEW."application_type" := NULL;
		END IF;

		RETURN NEW;
	END IF;

	-- Both-family writes and the migration's no-change backfill reconcile only
	-- missing information. Contradictory classifications or application kinds
	-- fail closed instead of silently choosing a writer.
	IF NEW."token_endpoint_auth_method" = 'none' AND NEW."public" IS FALSE
	THEN
		RAISE EXCEPTION
			'oauth_client rollback bridge rejected client %: method none contradicts public=false',
			NEW."client_id"
			USING ERRCODE = '23514';
	END IF;

	IF NEW."token_endpoint_auth_method" IN (
		'client_secret_basic', 'client_secret_post'
	) AND NEW."public" IS TRUE
	THEN
		RAISE EXCEPTION
			'oauth_client rollback bridge rejected client %: confidential method % contradicts public=true',
			NEW."client_id", NEW."token_endpoint_auth_method"
			USING ERRCODE = '23514';
	END IF;

	IF NEW."token_endpoint_auth_method" = 'none' OR NEW."public" IS TRUE
	THEN
		NEW."token_endpoint_auth_method" := 'none';
		NEW."public" := TRUE;

		type_application := CASE NEW."type"
			WHEN 'native' THEN 'native'
			WHEN 'user-agent-based' THEN 'web'
			ELSE NULL
		END;

		IF NEW."application_type" IS NOT NULL
			AND type_application IS NOT NULL
			AND NEW."application_type" <> type_application
		THEN
			RAISE EXCEPTION
				'oauth_client rollback bridge rejected client %: application_type % contradicts legacy type %',
				NEW."client_id", NEW."application_type", NEW."type"
				USING ERRCODE = '23514';
		END IF;

		IF NEW."application_type" IS NULL
		THEN
			NEW."application_type" := type_application;
		ELSIF NEW."type" IS NULL
		THEN
			NEW."type" := CASE NEW."application_type"
				WHEN 'native' THEN 'native'
				WHEN 'web' THEN 'user-agent-based'
				ELSE NULL
			END;
		END IF;
	ELSIF NEW."token_endpoint_auth_method" IN (
		'client_secret_basic', 'client_secret_post'
	) OR NEW."public" IS FALSE
	THEN
		IF NEW."application_type" = 'native'
			OR NEW."type" IN ('native', 'user-agent-based')
		THEN
			RAISE EXCEPTION
				'oauth_client rollback bridge rejected client %: confidential native clients cannot roll back to Better Auth 1.6',
				NEW."client_id"
				USING ERRCODE = '23514';
		END IF;

		NEW."public" := FALSE;
		IF NEW."application_type" = 'web' OR NEW."type" = 'web'
		THEN
			NEW."application_type" := 'web';
			NEW."type" := 'web';
		ELSE
			NEW."application_type" := NULL;
			NEW."type" := NULL;
		END IF;
	ELSE
		-- With no classification, 1.7 defaults a native client to a secret
		-- method that 1.6 cannot safely represent. Web remains intentionally
		-- ambiguous and all legacy classification stays NULL.
		IF NEW."application_type" = 'native'
		THEN
			RAISE EXCEPTION
				'oauth_client rollback bridge rejected client %: native client has no unambiguous public authentication method',
				NEW."client_id"
				USING ERRCODE = '23514';
		END IF;

		NEW."public" := NULL;
		NEW."type" := NULL;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "oauth_client_rollback_bridge" ON "public"."oauth_client";--> statement-breakpoint
CREATE TRIGGER "oauth_client_rollback_bridge"
BEFORE INSERT OR UPDATE OF
	"token_endpoint_auth_method", "application_type", "public", "type",
	"dpop_bound_access_tokens", "metadata"
ON "public"."oauth_client"
FOR EACH ROW
EXECUTE FUNCTION "public"."sync_oauth_client_rollback_fields"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reject_oauth_rollback_dpop_state"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	row_data jsonb;
	record_identifier text;
	verification_value text;
BEGIN
	row_data := to_jsonb(NEW);
	record_identifier := COALESCE(
		row_data ->> 'id',
		row_data ->> 'identifier',
		row_data ->> 'client_id',
		'unknown'
	);

	IF TG_TABLE_NAME = 'oauth_resource'
		AND row_data ->> 'dpop_bound_access_tokens_required' = 'true'
	THEN
		RAISE EXCEPTION
			'oauth rollback bridge rejected DPoP resource %', record_identifier
			USING ERRCODE = '23514';
	END IF;

	IF TG_TABLE_NAME IN ('oauth_access_token', 'oauth_refresh_token')
		AND row_data ->> 'confirmation' IS NOT NULL
	THEN
		RAISE EXCEPTION
			'oauth rollback bridge rejected sender-constrained token %', record_identifier
			USING ERRCODE = '23514';
	END IF;

	IF TG_TABLE_NAME = 'verification'
	THEN
		verification_value := row_data ->> 'value';
		IF verification_value ~ '"type"[[:space:]]*:[[:space:]]*"authorization_code"'
			AND verification_value ~ '"dpop_jkt"[[:space:]]*:'
		THEN
			RAISE EXCEPTION
				'oauth rollback bridge rejected DPoP authorization code %', record_identifier
				USING ERRCODE = '23514';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "oauth_resource_rollback_dpop_guard" ON "public"."oauth_resource";--> statement-breakpoint
CREATE TRIGGER "oauth_resource_rollback_dpop_guard"
BEFORE INSERT OR UPDATE OF "dpop_bound_access_tokens_required"
ON "public"."oauth_resource"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_oauth_rollback_dpop_state"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "oauth_access_token_rollback_dpop_guard" ON "public"."oauth_access_token";--> statement-breakpoint
CREATE TRIGGER "oauth_access_token_rollback_dpop_guard"
BEFORE INSERT OR UPDATE OF "confirmation"
ON "public"."oauth_access_token"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_oauth_rollback_dpop_state"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "oauth_refresh_token_rollback_dpop_guard" ON "public"."oauth_refresh_token";--> statement-breakpoint
CREATE TRIGGER "oauth_refresh_token_rollback_dpop_guard"
BEFORE INSERT OR UPDATE OF "confirmation"
ON "public"."oauth_refresh_token"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_oauth_rollback_dpop_state"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "verification_rollback_dpop_guard" ON "public"."verification";--> statement-breakpoint
CREATE TRIGGER "verification_rollback_dpop_guard"
BEFORE INSERT OR UPDATE OF "value"
ON "public"."verification"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_oauth_rollback_dpop_state"();--> statement-breakpoint
-- Better Auth 1.6 does not know oauth_client_resource. During an emergency
-- rollback, link every newly created 1.6 client to the single enabled resource
-- in the same INSERT statement. On a fresh database the resource may not exist
-- until the 1.7 seed runs; that first enabled resource links any clients that
-- were created in the meantime.
CREATE OR REPLACE FUNCTION "public"."link_oauth_client_rollback_resource"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	enabled_resources text[];
BEGIN
	-- Serialize both sides of the client/resource bootstrap. The fixed key is
	-- scoped to this rollback bridge and is held until the writer commits.
	PERFORM pg_catalog.pg_advisory_xact_lock(1095321395, 825504049);

	SELECT array_agg(resource."identifier" ORDER BY resource."identifier")
	INTO enabled_resources
	FROM "public"."oauth_resource" AS resource
	WHERE resource."disabled" IS FALSE;

	IF COALESCE(cardinality(enabled_resources), 0) = 0
	THEN
		RETURN NEW;
	END IF;

	IF cardinality(enabled_resources) <> 1
	THEN
		RAISE EXCEPTION
			'oauth rollback bridge requires exactly one enabled resource for new client %',
			NEW."client_id"
			USING ERRCODE = '23514';
	END IF;

	INSERT INTO "public"."oauth_client_resource" (
		"id", "client_id", "resource_id", "created_at"
	) VALUES (
		'rollback:' || md5(NEW."client_id" || ':' || enabled_resources[1]),
		NEW."client_id", enabled_resources[1], now()
	)
	ON CONFLICT ("client_id", "resource_id") DO NOTHING;

	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "oauth_client_rollback_resource_link" ON "public"."oauth_client";--> statement-breakpoint
CREATE TRIGGER "oauth_client_rollback_resource_link"
AFTER INSERT
ON "public"."oauth_client"
FOR EACH ROW
EXECUTE FUNCTION "public"."link_oauth_client_rollback_resource"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."guard_oauth_resource_rollback_single_enabled"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	existing_identifier text;
BEGIN
	IF NEW."disabled" IS DISTINCT FROM FALSE
	THEN
		RETURN NEW;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(1095321395, 825504049);

	IF TG_OP = 'UPDATE' AND OLD."disabled" IS FALSE
	THEN
		RETURN NEW;
	END IF;

	SELECT resource."identifier"
	INTO existing_identifier
	FROM "public"."oauth_resource" AS resource
	WHERE resource."disabled" IS FALSE
	ORDER BY resource."identifier"
	LIMIT 1;

	IF existing_identifier IS NOT NULL
	THEN
		RAISE EXCEPTION
			'oauth rollback bridge requires exactly one enabled resource after resource %; existing %',
			NEW."identifier", existing_identifier
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "oauth_resource_rollback_single_enabled_guard" ON "public"."oauth_resource";--> statement-breakpoint
CREATE TRIGGER "oauth_resource_rollback_single_enabled_guard"
BEFORE INSERT OR UPDATE OF "disabled"
ON "public"."oauth_resource"
FOR EACH ROW
EXECUTE FUNCTION "public"."guard_oauth_resource_rollback_single_enabled"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."link_oauth_resource_rollback_clients"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	enabled_resources text[];
BEGIN
	IF NEW."disabled" IS DISTINCT FROM FALSE
	THEN
		RETURN NEW;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(1095321395, 825504049);

	SELECT array_agg(resource."identifier" ORDER BY resource."identifier")
	INTO enabled_resources
	FROM "public"."oauth_resource" AS resource
	WHERE resource."disabled" IS FALSE;

	IF cardinality(enabled_resources) <> 1
	THEN
		RAISE EXCEPTION
			'oauth rollback bridge requires exactly one enabled resource after resource %; found %',
			NEW."identifier", COALESCE(cardinality(enabled_resources), 0)
			USING ERRCODE = '23514';
	END IF;

	INSERT INTO "public"."oauth_client_resource" (
		"id", "client_id", "resource_id", "created_at"
	)
	SELECT
		'rollback:' || md5(client."client_id" || ':' || enabled_resources[1]),
		client."client_id", enabled_resources[1], now()
	FROM "public"."oauth_client" AS client
	ON CONFLICT ("client_id", "resource_id") DO NOTHING;

	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "oauth_resource_rollback_client_links" ON "public"."oauth_resource";--> statement-breakpoint
CREATE TRIGGER "oauth_resource_rollback_client_links"
AFTER INSERT OR UPDATE OF "disabled"
ON "public"."oauth_resource"
FOR EACH ROW
EXECUTE FUNCTION "public"."link_oauth_resource_rollback_clients"();--> statement-breakpoint
-- Existing audience-less access tokens remain unchanged so the application can
-- recognize the finite 1.6 drain set. Every token written after this migration,
-- including one written during a rollback to 1.6, is instead bound to the
-- client's single enabled resource. This prevents a new 1.7 opaque token from
-- being mistaken for a pre-switch legacy token merely because the request
-- omitted RFC 8707 `resource`.
CREATE OR REPLACE FUNCTION "public"."bind_oauth_token_rollback_resource"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	enabled_resources text[];
	resolved_reference_id text;
BEGIN
	SELECT client."reference_id"
	INTO resolved_reference_id
	FROM "public"."oauth_client" AS client
	WHERE client."client_id" = NEW."client_id"
		AND client."disabled" IS FALSE;

	IF resolved_reference_id IS NULL
	THEN
		RAISE EXCEPTION
			'oauth rollback bridge requires an enabled referenced client % for token %',
			NEW."client_id", NEW."id"
			USING ERRCODE = '23514';
	END IF;

	SELECT array_agg(link."resource_id" ORDER BY link."resource_id")
	INTO enabled_resources
	FROM "public"."oauth_client_resource" AS link
	INNER JOIN "public"."oauth_resource" AS resource
		ON resource."identifier" = link."resource_id"
	WHERE link."client_id" = NEW."client_id"
		AND resource."disabled" IS FALSE;

	IF COALESCE(cardinality(enabled_resources), 0) <> 1
	THEN
		RAISE EXCEPTION
			'oauth rollback bridge requires exactly one enabled resource for client % token %',
			NEW."client_id", NEW."id"
			USING ERRCODE = '23514';
	END IF;

	IF NEW."resources" IS NULL OR cardinality(NEW."resources") = 0
	THEN
		NEW."resources" := enabled_resources;
	ELSIF NEW."resources" IS DISTINCT FROM enabled_resources
	THEN
		RAISE EXCEPTION
			'oauth rollback bridge rejected noncanonical token resource for client % token %',
			NEW."client_id", NEW."id"
			USING ERRCODE = '23514';
	END IF;

	IF NEW."reference_id" IS NULL
	THEN
		NEW."reference_id" := resolved_reference_id;
	ELSIF NEW."reference_id" IS DISTINCT FROM resolved_reference_id
	THEN
		RAISE EXCEPTION
			'oauth rollback bridge rejected token reference for client % token %',
			NEW."client_id", NEW."id"
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "oauth_access_token_rollback_resource_guard" ON "public"."oauth_access_token";--> statement-breakpoint
CREATE TRIGGER "oauth_access_token_rollback_resource_guard"
BEFORE INSERT OR UPDATE OF "client_id", "reference_id", "resources"
ON "public"."oauth_access_token"
FOR EACH ROW
EXECUTE FUNCTION "public"."bind_oauth_token_rollback_resource"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "oauth_refresh_token_rollback_resource_guard" ON "public"."oauth_refresh_token";--> statement-breakpoint
CREATE TRIGGER "oauth_refresh_token_rollback_resource_guard"
BEFORE INSERT OR UPDATE OF "client_id", "reference_id", "resources"
ON "public"."oauth_refresh_token"
FOR EACH ROW
EXECUTE FUNCTION "public"."bind_oauth_token_rollback_resource"();--> statement-breakpoint
-- Fire the same normalization path for every pre-existing row. Any invalid row
-- aborts this transaction with its client_id; no partial backfill or trigger
-- installation can escape. Replaying the migration is a data no-op.
UPDATE "public"."oauth_client"
SET "token_endpoint_auth_method" = "token_endpoint_auth_method";
