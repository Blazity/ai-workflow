# Provider event freshness fixes

## Goal

Make failed-check dispatch depend on documented webhook fields, authoritative provider state, and an exact deployed workflow version. Preserve Jira transition-echo schema compatibility and normalize previously valid empty review-state arrays.

## Design

GitLab Pipeline Hooks keep their pipeline ID and failed jobs, but do not pretend that the hook contains a source-head SHA. Before acceptance, dispatch reads the merge request once and enriches the event with that authoritative source head while requiring the hook pipeline ID to equal the current head-pipeline ID.

GitHub check events carry stable check-run identity. Failed events are accepted only while the provider reports the same run as the latest run for that exact app and check name on the PR head. Successful completions use that identity to invalidate a matching queued failure, so same-SHA reruns cannot launch remediation after CI is green.

Pending events are partitioned by workflow definition and version. Events within one partition may coalesce, and the newest GitLab pipeline payload is the representative snapshot. No failed-check payload crosses an immutable deployment boundary.

Stored `trigger_pr_review.on: []` values normalize to `["changes_requested"]` during deterministic read upgrade. After the trusted-publication cumulative migration is present, migration `0025` adds only the transition-intent actor/webhook identity columns and matching unique index.

## Verification

Each behavior gets a regression test that fails before production changes. Focused normalizer, dispatch, store, schema-upgrade, adapter, and migration replay tests must pass before the broader worker typecheck/test suite.
