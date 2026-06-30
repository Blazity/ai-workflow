DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM (
			SELECT lower("email") AS normalized_email
			FROM "user"
			GROUP BY lower("email")
			HAVING count(*) > 1
		) duplicates
	) THEN
		RAISE EXCEPTION 'auth invariant preflight failed: duplicate lowercased user emails';
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM (
			SELECT "provider_id", "account_id"
			FROM "account"
			GROUP BY "provider_id", "account_id"
			HAVING count(*) > 1
		) duplicates
	) THEN
		RAISE EXCEPTION 'auth invariant preflight failed: duplicate account provider/account pairs';
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "invitation"
		WHERE "role" NOT IN ('owner', 'admin', 'member')
	) THEN
		RAISE EXCEPTION 'auth invariant preflight failed: invalid invitation roles';
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "member"
		WHERE "role" NOT IN ('owner', 'admin', 'member')
	) THEN
		RAISE EXCEPTION 'auth invariant preflight failed: invalid member roles';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_email_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_email_lower_unique" ON "user" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_provider_id_account_id_unique" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
ALTER TABLE "invitation" DROP CONSTRAINT IF EXISTS "invitation_role_check";--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_role_check" CHECK ("role" in ('owner', 'admin', 'member'));--> statement-breakpoint
ALTER TABLE "member" DROP CONSTRAINT IF EXISTS "member_role_check";--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_role_check" CHECK ("role" in ('owner', 'admin', 'member'));
