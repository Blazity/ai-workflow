ALTER TABLE "work_scope_entries" DROP CONSTRAINT "work_scope_entries_origin_check";--> statement-breakpoint
-- ONLY THE ORIGIN CHECK CHANGES, and no stored rank moves. `origin_rank` is the
-- number persisted beside the origin so the upsert statement itself can refuse
-- a lower origin overwriting a higher one, and it is declared per origin in
-- `WORK_SCOPE_ORIGIN_RANKS` (`packages/contracts/work-scope.ts`), never taken
-- from a position in a list. `delegated` ranks 0, tied with `person`, and every
-- origin that existed before keeps the number its rows already carry. That is
-- what makes this migration safe to run in the build, minutes before the new
-- code serves anything: a re-stamp would have old instances comparing their
-- old numbers against rows stamped with new ones, and a ticket text match from
-- the old code could then overwrite a workflow-owned branch. The one overwrite
-- the tie opens, a delegated write over a person's own entry, is refused in
-- the upsert (`overwriteAllowed` in `apps/worker/src/db/repositories/work-scope.ts`).
-- So `work_scope_entries_origin_rank_check` stays `between 0 and 4`.
ALTER TABLE "work_scope_entries" ADD CONSTRAINT "work_scope_entries_origin_check" CHECK ("work_scope_entries"."origin" in ('person', 'delegated', 'workflow_owned_branch', 'ticket_text', 'trigger_policy', 'inferred'));
