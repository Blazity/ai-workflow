-- Makes an already deployed auto-fix workflow say WHAT it fixed.
--
-- The "review-fix-after-pr" template closed every successful run with one fixed
-- sentence, "Automated fix pushed. Please re-review.", so a reviewer returning
-- to the pull request learned nothing: not what was failing, not what changed,
-- not what was verified. The fix agent already reports that (fix_agent output
-- `summary`); it was simply never wired to the comment. The template now binds
-- the comment body to it, but a definition that is already deployed froze a copy
-- of the graph when it was saved and never reads the template again, so without
-- this migration the fix reaches only workflows created from here on.
--
-- Schema version 2 gets no {{variable}} substitution at all
-- (substituteNodePromptParamsForSchema returns v2 nodes unchanged, and
-- v2NonAgentPromptPlaceholderIssue rejects braces in v2 non-agent params), so an
-- input binding is the only mechanism that can carry the summary into the body.
--
-- Guard: a definition JSON carries no authorship marker, so a version is
-- rewritten only when it still has the platform's auto-fix shape AND nobody has
-- customized the two things being changed:
--   * a fix_agent node with id "fix" and a post_pr_comment node with id
--     "comment",
--   * the comment body byte-matching the platform sentence and carrying no body
--     binding yet,
--   * the backbone edges fix -> checks -> finalize -> comment, which is what
--     makes "steps.fix.output.summary" reachable from the comment. A rewired
--     graph would take an unreachable reference and start failing validation,
--     which is the AIW-245 failure mode, so a rewired graph is skipped instead.
-- A customer who edited either the comment body or the wiring keeps their graph
-- byte for byte.
--
-- No audit table, unlike 0051: there the overwritten value was one of several
-- unknown shapes, so the pre-image had to be recorded. Here the guard pins the
-- pre-image exactly (that sentence, and no binding), so an operator reverts by
-- removing inputs.body and restoring the sentence, with nothing to look up.
--
-- Idempotent by construction: after the rewrite the comment node HAS a body
-- binding, so it no longer matches the guard and a second run changes nothing.
--
-- Every stored version is corrected, not just the deployed one, the same way
-- 0051 does it, so a rollback to an earlier version does not walk back into the
-- silent comment. One statement, no explicit transaction (neon-http has none),
-- and every jsonb_array_elements is guarded against a non-array so one malformed
-- row cannot abort the migration.
UPDATE "workflow_definition_versions" AS "v"
SET "definition" = jsonb_set(
  "v"."definition",
  '{nodes}',
  COALESCE((
    SELECT jsonb_agg("rewritten_node" ORDER BY "node_ord")
    FROM (
      SELECT
        CASE
          WHEN "node"->>'id' = 'comment'
           AND "node"->>'type' = 'post_pr_comment'
           AND "node"->'configuration'->>'body' = $aiw_autofix_comment$Automated fix pushed. Please re-review.$aiw_autofix_comment$
           AND "node"->'inputs'->'body' IS NULL
          THEN jsonb_set(
                 "node",
                 '{inputs}',
                 COALESCE("node"->'inputs', '{}'::jsonb)
                   || $aiw_autofix_comment${"body":{"kind":"reference","reference":"steps.fix.output.summary"}}$aiw_autofix_comment$::jsonb
               )
          WHEN "node"->>'id' = 'fix'
           AND "node"->>'type' = 'fix_agent'
           AND jsonb_typeof("node"->'configuration') = 'object'
           AND "node"->'configuration'->>'instructions' = $aiw_autofix_comment$Resolve the fetched pull-request review feedback or failing checks, verify the fix, and commit the resulting changes.$aiw_autofix_comment$
          THEN jsonb_set(
                 "node",
                 '{configuration,instructions}',
                 to_jsonb($aiw_autofix_comment$Resolve the fetched pull-request review feedback or failing checks, verify the fix, and commit the resulting changes. Your summary is posted as a comment on the pull request, so write it for the reviewer: name what was failing, what you changed and where, and how you verified it.$aiw_autofix_comment$::text)
               )
          ELSE "node"
        END AS "rewritten_node",
        "node_ord"
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof("v"."definition"->'nodes') = 'array' THEN "v"."definition"->'nodes' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS "n"("node", "node_ord")
    ) AS "nodes"
  ), "v"."definition"->'nodes')
)
WHERE jsonb_typeof("v"."definition"->'nodes') = 'array'
  AND jsonb_typeof("v"."definition"->'edges') = 'array'
  AND "v"."definition"->'edges' @> '[{"from":"fix","to":"checks"}]'::jsonb
  AND "v"."definition"->'edges' @> '[{"from":"checks","to":"finalize"}]'::jsonb
  AND "v"."definition"->'edges' @> '[{"from":"finalize","to":"comment"}]'::jsonb
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements("v"."definition"->'nodes') AS "n"("node")
    WHERE "node"->>'id' = 'fix' AND "node"->>'type' = 'fix_agent'
  )
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements("v"."definition"->'nodes') AS "n"("node")
    WHERE "node"->>'id' = 'comment'
      AND "node"->>'type' = 'post_pr_comment'
      AND "node"->'configuration'->>'body' = $aiw_autofix_comment$Automated fix pushed. Please re-review.$aiw_autofix_comment$
      AND "node"->'inputs'->'body' IS NULL
  );
