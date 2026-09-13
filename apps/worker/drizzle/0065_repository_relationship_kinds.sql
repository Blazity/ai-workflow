-- Production held zero relationship rows on 2026-09-13.
-- SELECT
--   (SELECT count(*) FROM repositories r CROSS JOIN LATERAL jsonb_array_elements(r.relationships) e WHERE NOT (e ? 'kind')) AS repositories_legacy,
--   (SELECT count(*) FROM repository_profile_versions p CROSS JOIN LATERAL jsonb_array_elements(p.relationships) e WHERE NOT (e ? 'kind')) AS profile_versions_legacy;

UPDATE repositories
SET relationships = (
  SELECT jsonb_agg(
    CASE WHEN relationship ? 'kind' THEN relationship
    ELSE jsonb_build_object(
      'repositoryId', relationship->'repositoryId',
      'kind', 'related_to',
      'note', left(btrim(regexp_replace(
        regexp_replace(coalesce(relationship->>'label', ''), '[[:cntrl:]]+', ' ', 'g'),
        '[[:space:]]+', ' ', 'g'
      )), 200)
    ) END
  )
  FROM jsonb_array_elements(repositories.relationships) AS relationship
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(repositories.relationships) AS relationship
  WHERE NOT (relationship ? 'kind')
);
--> statement-breakpoint

UPDATE repository_profile_versions
SET relationships = (
  SELECT jsonb_agg(
    CASE WHEN relationship ? 'kind' THEN relationship
    ELSE jsonb_build_object(
      'repositoryId', relationship->'repositoryId',
      'kind', 'related_to',
      'note', left(btrim(regexp_replace(
        regexp_replace(coalesce(relationship->>'label', ''), '[[:cntrl:]]+', ' ', 'g'),
        '[[:space:]]+', ' ', 'g'
      )), 200)
    ) END
  )
  FROM jsonb_array_elements(repository_profile_versions.relationships) AS relationship
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(repository_profile_versions.relationships) AS relationship
  WHERE NOT (relationship ? 'kind')
);
