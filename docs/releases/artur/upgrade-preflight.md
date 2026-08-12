# Upgrade preflight: carried schemas frozen at authoring time

Run this against the tenant database **before** synchronising a release that
changes a block's output schema. It takes seconds and needs no downtime.

## What it catches

A Loop's carried value stores the source block's JSON Schema **by value**, at the
moment the author picked the source. Nothing revisits that copy afterwards. When
a later release changes the shipped schema, every deployed definition keeps the
old copy, and the two disagree at validation time.

The failure mode is the reason this check exists: the tenant changes nothing,
upgrades, and their working workflow stops validating. The editor reports the
carried value as invalid against a schema they never chose and cannot see.

Known instance: the review finding severity enum moved from
`["critical", "suggestion"]` to `["Blocker", "High", "Medium", "Nit"]`. Tracked
as AIW-245; this document is the operational half, not the engine fix.

## The query

```sql
with expected_schema_fields(schema_path, expected_value) as (
  values (
    array['properties', 'findings', 'items', 'properties', 'severity', 'enum']::text[],
    '["Blocker", "High", "Medium", "Nit"]'::jsonb
  )
)
select
  d.id,
  d.name,
  d.enabled,
  d.archived_at,
  d.deployed_version,
  c->>'name'                 as carried_value,
  c->'binding'->>'reference' as source,
  array_to_string(e.schema_path, '.') as schema_field,
  c->'schema' #> e.schema_path        as frozen_value,
  e.expected_value
from workflow_definitions d
join workflow_definition_versions v
  on v.definition_id = d.id and v.version = d.deployed_version
cross join lateral jsonb_array_elements(v.definition->'nodes') n
cross join lateral jsonb_array_elements(coalesce(n->'configuration'->'carry', '[]'::jsonb)) c
cross join expected_schema_fields e
where n->>'type' = 'loop'
  and c->'schema' #> e.schema_path is not null
  and c->'schema' #> e.schema_path <> e.expected_value
order by d.archived_at nulls first, d.enabled desc, d.id;
```

Zero rows means no deployed definition carries a stale severity enum. Rows are
listed enabled-first, because an enabled definition breaks on its next run while
a disabled one breaks whenever somebody enables it.

The query reads the **deployed** version, not the draft. A draft repaired but
not redeployed still fails, which is the point.

## The repair

Per row, in the editor:

1. Open the definition, select the Loop node.
2. Open the carried value named in `carried_value`.
3. Reselect the same source output named in `source`. Reselecting is what
   replaces the frozen copy; editing anything else does not.
4. Deploy.

Verified on production on 2026-08-10 against a definition carrying the stale
enum in three places: after transplanting the current schema and redeploying,
deployment returned 200 with no validation issues, and the query above returned
zero rows.

## Scope note

The severity enum is the only instance measured so far. Any future schema
change to a block that can feed a Loop carry has the same shape. Add one row to
`expected_schema_fields` for each changed field, pairing its exact `schema_path`
with that field's expected deployed JSON value. Changing a path without its
matching expected value would compare unrelated fields and produce incorrect
results.
