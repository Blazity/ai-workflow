-- Widens harness_skill_artifacts so it can also hold a skill read from the
-- `skills/` directory of the deployment's own repository, next to the
-- GitHub-imported skills it holds today.
--
-- A local skill has no owner, no repository and no commit to point at (its
-- version is the digest of its contents), so the four GitHub columns stop being
-- NOT NULL and two local ones join them: "local_path" and
-- "local_content_sha256", mirroring HarnessLocalSkillSource in
-- apps/shared/contracts/harness-profiles.ts.
--
-- The variant marker lives in "source_kind", a column, and deliberately NOT
-- inside the source object that the artifact hash covers: that object is
-- serialized whole into the hash, so a discriminator inside it would rehash
-- every artifact already stored and unpin every profile that pins one.
--
-- Every existing row is a GitHub import (the four columns were NOT NULL until
-- now), so DEFAULT 'github' both backfills them and keeps the one existing
-- writer working: the import path in apps/worker/src/harness-profiles/
-- github-skills.ts inserts through raw SQL that does not name this column yet.
-- The default cannot mislabel a local artifact, because a row that takes it
-- while leaving the GitHub columns empty is rejected by the shape check below.
--
-- Nullable columns alone would let a half-filled row through, so
-- "harness_skill_artifacts_source_shape_check" makes one unrepresentable: a
-- 'github' row must carry all four GitHub columns and neither local one, a
-- 'local' row exactly the reverse.
--
-- "harness_skill_artifacts_source_idx" stays exactly as it is, with no local
-- counterpart: nothing queries artifacts by source (every read goes through the
-- org+hash unique index or the primary key), so a second index over the local
-- columns would add write cost and serve no reader.
--
-- Rolling back is safe only while no local artifact exists. Restoring NOT NULL
-- on the four GitHub columns fails on the first local row, and dropping the
-- local columns would leave any profile version pinning a local artifact
-- pointing at a row whose source can no longer be described. Delete the local
-- rows, and unpin them from profile versions, before reverting.
ALTER TABLE "harness_skill_artifacts" ALTER COLUMN "source_owner" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "harness_skill_artifacts" ALTER COLUMN "source_repository" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "harness_skill_artifacts" ALTER COLUMN "source_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "harness_skill_artifacts" ALTER COLUMN "source_commit_sha" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "harness_skill_artifacts" ADD COLUMN "source_kind" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "harness_skill_artifacts" ADD COLUMN "local_path" text;--> statement-breakpoint
ALTER TABLE "harness_skill_artifacts" ADD COLUMN "local_content_sha256" text;--> statement-breakpoint
ALTER TABLE "harness_skill_artifacts" ADD CONSTRAINT "harness_skill_artifacts_source_kind_check" CHECK ("harness_skill_artifacts"."source_kind" in ('github', 'local'));--> statement-breakpoint
ALTER TABLE "harness_skill_artifacts" ADD CONSTRAINT "harness_skill_artifacts_source_shape_check" CHECK ((
        "harness_skill_artifacts"."source_kind" <> 'github'
        or (
          "harness_skill_artifacts"."source_owner" is not null
          and "harness_skill_artifacts"."source_repository" is not null
          and "harness_skill_artifacts"."source_path" is not null
          and "harness_skill_artifacts"."source_commit_sha" is not null
          and "harness_skill_artifacts"."local_path" is null
          and "harness_skill_artifacts"."local_content_sha256" is null
        )
      ) and (
        "harness_skill_artifacts"."source_kind" <> 'local'
        or (
          "harness_skill_artifacts"."local_path" is not null
          and "harness_skill_artifacts"."local_content_sha256" is not null
          and "harness_skill_artifacts"."source_owner" is null
          and "harness_skill_artifacts"."source_repository" is null
          and "harness_skill_artifacts"."source_path" is null
          and "harness_skill_artifacts"."source_commit_sha" is null
        )
      ));