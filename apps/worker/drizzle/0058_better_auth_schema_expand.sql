-- Freeze both identity inputs before preflight. drizzle-kit migrate executes
-- the pending PostgreSQL statements in one transaction, so these locks remain
-- held through trigger installation, backfill, constraints and journal update.
-- Account comes first to match Better Auth's account-then-provider delete path.
-- SHARE ROW EXCLUSIVE still permits reads but blocks legacy identity writes;
-- an incompatible non-transactional runner fails closed on this statement.
LOCK TABLE "public"."account", "public"."sso_provider"
IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
-- Install the immutable-issuer guard before inspecting or backfilling data.
CREATE OR REPLACE FUNCTION "public"."protect_sso_provider_issuer"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
	IF OLD."issuer" IS DISTINCT FROM NEW."issuer"
	THEN
		RAISE EXCEPTION
			'SSO provider issuer cannot change during the Better Auth compatibility window for provider %',
			OLD."provider_id"
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "sso_provider_issuer_guard"
BEFORE UPDATE OF "issuer" ON "public"."sso_provider"
FOR EACH ROW
EXECUTE FUNCTION "public"."protect_sso_provider_issuer"();--> statement-breakpoint
-- Better Auth 1.7 identifies accounts by (issuer, account_id). Resolve every
-- legacy row before changing the table, and fail with the provider IDs an
-- operator must repair instead of inventing an identity boundary.
DO $$
DECLARE
	has_issuer boolean;
	unknown_providers text;
BEGIN
	SELECT EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'account'
			AND column_name = 'issuer'
	) INTO has_issuer;

	IF has_issuer THEN
		EXECUTE $query$
			SELECT string_agg(provider_id, ', ' ORDER BY provider_id)
			FROM (
				SELECT DISTINCT a.provider_id
				FROM account a
				LEFT JOIN sso_provider sp ON sp.provider_id = a.provider_id
				WHERE a.issuer IS NULL
					AND a.provider_id <> 'credential'
					AND sp.provider_id IS NULL
			) unresolved
		$query$ INTO unknown_providers;
	ELSE
		SELECT string_agg(provider_id, ', ' ORDER BY provider_id)
		INTO unknown_providers
		FROM (
			SELECT DISTINCT a.provider_id
			FROM account a
			LEFT JOIN sso_provider sp ON sp.provider_id = a.provider_id
			WHERE a.provider_id <> 'credential'
				AND sp.provider_id IS NULL
		) unresolved;
	END IF;

	IF unknown_providers IS NOT NULL THEN
		RAISE EXCEPTION
			'Better Auth 1.7 issuer preflight failed: unknown account provider(s): %. Add matching sso_provider rows or migrate those identities explicitly.',
			unknown_providers;
	END IF;
END $$;
--> statement-breakpoint
-- The new unique key can collapse legacy rows from distinct provider IDs that
-- point at the same issuer. Detect that before adding either the column or key.
DO $$
DECLARE
	has_issuer boolean;
	collision_groups bigint;
BEGIN
	SELECT EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'account'
			AND column_name = 'issuer'
	) INTO has_issuer;

	IF has_issuer THEN
		EXECUTE $query$
			SELECT count(*)
			FROM (
				SELECT
					coalesce(
						a.issuer,
						CASE
							WHEN a.provider_id = 'credential' THEN 'local:credential'
							ELSE sp.issuer
						END
					) AS resolved_issuer,
					a.account_id
				FROM account a
				LEFT JOIN sso_provider sp ON sp.provider_id = a.provider_id
				GROUP BY 1, 2
				HAVING count(*) > 1
			) collisions
		$query$ INTO collision_groups;
	ELSE
		SELECT count(*)
		INTO collision_groups
		FROM (
			SELECT
				CASE
					WHEN a.provider_id = 'credential' THEN 'local:credential'
					ELSE sp.issuer
				END AS resolved_issuer,
				a.account_id
			FROM account a
			LEFT JOIN sso_provider sp ON sp.provider_id = a.provider_id
			GROUP BY 1, 2
			HAVING count(*) > 1
		) collisions;
	END IF;

	IF collision_groups > 0 THEN
		RAISE EXCEPTION
			'Better Auth 1.7 issuer preflight failed: % (issuer, account_id) collision group(s). Resolve them before retrying.',
			collision_groups;
	END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp,
	"updated_at" timestamp,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauth_resource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text;--> statement-breakpoint
UPDATE "account" AS account_row
SET "issuer" = CASE
	WHEN account_row."provider_id" = 'credential' THEN 'local:credential'
	ELSE (
		SELECT provider."issuer"
		FROM "sso_provider" AS provider
		WHERE provider."provider_id" = account_row."provider_id"
	)
END
WHERE account_row."issuer" IS NULL;--> statement-breakpoint
-- Temporary expand-phase bridge: Better Auth 1.6.30 does not send issuer.
-- Keep old writers valid for credential and configured SSO identities, while
-- rejecting an unknown provider rather than synthesizing the wrong issuer.
CREATE OR REPLACE FUNCTION "public"."set_account_issuer_for_legacy_writer"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
	IF NEW."issuer" IS NOT NULL THEN
		RETURN NEW;
	END IF;

	IF NEW."provider_id" = 'credential' THEN
		NEW."issuer" := 'local:credential';
	ELSE
		SELECT provider."issuer"
		INTO NEW."issuer"
		FROM "public"."sso_provider" AS provider
		WHERE provider."provider_id" = NEW."provider_id";
	END IF;

	IF NEW."issuer" IS NULL THEN
		RAISE EXCEPTION
			'Better Auth account writer supplied no issuer for unknown provider %',
			NEW."provider_id"
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "account_issuer_legacy_writer" ON "account";--> statement-breakpoint
CREATE TRIGGER "account_issuer_legacy_writer"
BEFORE INSERT ON "account"
FOR EACH ROW
EXECUTE FUNCTION "public"."set_account_issuer_for_legacy_writer"();--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jwks" ADD COLUMN IF NOT EXISTS "alg" text;--> statement-breakpoint
ALTER TABLE "jwks" ADD COLUMN IF NOT EXISTS "crv" text;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "authorization_code_id" text;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "revoked" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "confirmation" jsonb;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "client_discovery_id" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "client_credentials_scopes" text[] DEFAULT '{}'::text[];--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "backchannel_logout_uri" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "backchannel_logout_session_required" boolean;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "application_type" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "jwks" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "jwks_uri" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "dpop_bound_access_tokens" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD COLUMN IF NOT EXISTS "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "authorization_code_id" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "rotated_at" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "rotation_replay_response" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "rotation_replay_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "confirmation" jsonb;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'oauth_client_resource_client_id_oauth_client_client_id_fk'
			AND conrelid = 'oauth_client_resource'::regclass
	) THEN
		ALTER TABLE "oauth_client_resource"
			ADD CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fk"
			FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'oauth_client_resource_resource_id_oauth_resource_identifier_fk'
			AND conrelid = 'oauth_client_resource'::regclass
	) THEN
		ALTER TABLE "oauth_client_resource"
			ADD CONSTRAINT "oauth_client_resource_resource_id_oauth_resource_identifier_fk"
			FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resource"("identifier")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthClientResource_clientId_idx" ON "oauth_client_resource" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthClientResource_resourceId_idx" ON "oauth_client_resource" USING btree ("resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauthClientResource_clientId_resourceId_uidx" ON "oauth_client_resource" USING btree ("client_id","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_accountId_uidx" ON "account" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthAccessToken_authorizationCodeId_idx" ON "oauth_access_token" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_authorizationCodeId_idx" ON "oauth_refresh_token" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" USING btree ("identifier");
