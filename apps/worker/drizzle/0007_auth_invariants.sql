ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_email_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_email_lower_unique" ON "user" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_provider_id_account_id_unique" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
ALTER TABLE "invitation" DROP CONSTRAINT IF EXISTS "invitation_role_check";--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_role_check" CHECK ("role" in ('owner', 'admin', 'member'));--> statement-breakpoint
ALTER TABLE "member" DROP CONSTRAINT IF EXISTS "member_role_check";--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_role_check" CHECK ("role" in ('owner', 'admin', 'member'));
