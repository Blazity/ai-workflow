-- One spelling for a pull request's subject key, and for a ticket's.
--
-- `pr:<provider>:<path>#<n>` kept the caller's spelling of the path, so the
-- same pull request reached through a webhook (`Blazity/x`) and through a pasted
-- URL (`blazity/x`) had two subjects. The builder now cases the path down
-- (`prSubjectKey`, @shared/contracts); this rewrites what was stored before it.
-- Ticket keys a person typed in another case (`ticket:jira:awp-281`, written by
-- a work scope edit onto an empty twin of `ticket:jira:AWP-281`) are merged into
-- the record runs read, in the same pass and by the same rule
-- (`canonicalSubjectKey`).
--
-- Every multi-row change is one statement (production runs neon-http, which has
-- no transactions), and every statement is safe to run again: a second run finds
-- nothing left to respell.
--
-- NOT REWRITTEN, on purpose:
--   * a key that holds a live lock (a row in active_runs), in every table. A run
--     in flight reads and releases its rows by the key its journal carries, so
--     its lock, pending question, pending delivery and records keep that spelling
--     until it ends. active_runs and active_run_sandboxes are never touched.
--   * agent_memory_documents: memory is being rebuilt separately.
--   * a pending row whose canonical key already has a pending row, or which is
--     not the oldest mover to it (one pending row per subject is a unique index).
--     Those keep their spelling rather than being closed on a person's behalf.
--
-- The respelling rule, and the one place it is spelled in SQL. A function only
-- for the length of this migration; dropped at the end.
CREATE OR REPLACE FUNCTION aiw_0073_respelled_subject_key(stored_key text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT canonical
  FROM (
    SELECT CASE
      WHEN stored_key LIKE 'pr:%:%' THEN
        'pr:' || split_part(stored_key, ':', 2) || ':'
          || lower(substr(stored_key, length(split_part(stored_key, ':', 2)) + 5))
      WHEN stored_key LIKE 'ticket:%:%' THEN
        'ticket:' || lower(btrim(split_part(stored_key, ':', 2))) || ':'
          || upper(btrim(substr(stored_key, length(split_part(stored_key, ':', 2)) + 9)))
    END AS canonical
  ) respelled
  WHERE canonical IS NOT NULL
    AND canonical <> stored_key
    AND NOT EXISTS (SELECT 1 FROM active_runs live WHERE live.subject_key = stored_key)
$$;
--> statement-breakpoint

-- Run history: indexed, not unique.
UPDATE workflow_runs
SET subject_key = aiw_0073_respelled_subject_key(subject_key)
WHERE aiw_0073_respelled_subject_key(subject_key) IS NOT NULL;
--> statement-breakpoint

UPDATE manual_dispatch_requests
SET subject_key = aiw_0073_respelled_subject_key(subject_key)
WHERE aiw_0073_respelled_subject_key(subject_key) IS NOT NULL;
--> statement-breakpoint

UPDATE workflow_run_external_checks
SET subject_key = aiw_0073_respelled_subject_key(subject_key)
WHERE aiw_0073_respelled_subject_key(subject_key) IS NOT NULL;
--> statement-breakpoint

-- Provider deliveries: a settled row always moves; a pending one moves only
-- onto a key no other pending row will hold.
WITH mover AS (
  SELECT provider, delivery_id, pending, created_at,
         aiw_0073_respelled_subject_key(subject_key) AS canonical
  FROM trigger_deliveries
  WHERE aiw_0073_respelled_subject_key(subject_key) IS NOT NULL
), ranked AS (
  SELECT mover.*,
         row_number() OVER (
           PARTITION BY canonical, pending ORDER BY created_at, provider, delivery_id
         ) AS pending_rank
  FROM mover
)
UPDATE trigger_deliveries inbox
SET subject_key = ranked.canonical
FROM ranked
WHERE inbox.provider = ranked.provider
  AND inbox.delivery_id = ranked.delivery_id
  AND (
    NOT ranked.pending
    OR (
      ranked.pending_rank = 1
      AND NOT EXISTS (
        SELECT 1 FROM trigger_deliveries held
        WHERE held.subject_key = ranked.canonical AND held.pending
      )
    )
  );
--> statement-breakpoint

-- Questions: the same rule for the one pending question per subject. The ticket
-- key of a pull request run without a ticket is its subject key, and moves with
-- the same rule.
WITH mover AS (
  SELECT id, status, asked_at,
         aiw_0073_respelled_subject_key(subject_key) AS canonical_subject,
         aiw_0073_respelled_subject_key(ticket_key) AS canonical_ticket
  FROM clarification_requests
  WHERE aiw_0073_respelled_subject_key(subject_key) IS NOT NULL
     OR (ticket_key LIKE 'pr:%' AND aiw_0073_respelled_subject_key(ticket_key) IS NOT NULL)
), ranked AS (
  SELECT mover.*,
         row_number() OVER (
           PARTITION BY canonical_subject, status = 'pending' ORDER BY asked_at, id
         ) AS pending_rank
  FROM mover
)
UPDATE clarification_requests question
SET subject_key = CASE
      WHEN ranked.canonical_subject IS NOT NULL AND (
        question.status <> 'pending'
        OR (
          ranked.pending_rank = 1
          AND NOT EXISTS (
            SELECT 1 FROM clarification_requests held
            WHERE held.subject_key = ranked.canonical_subject AND held.status = 'pending'
          )
        )
      ) THEN ranked.canonical_subject
      ELSE question.subject_key
    END,
    ticket_key = CASE
      WHEN question.ticket_key LIKE 'pr:%' THEN coalesce(ranked.canonical_ticket, question.ticket_key)
      ELSE question.ticket_key
    END
FROM ranked
WHERE question.id = ranked.id;
--> statement-breakpoint

-- Plan approvals keyed by a pull request run's ticket key: one pending per key.
WITH mover AS (
  SELECT id, status, requested_at,
         aiw_0073_respelled_subject_key(ticket_key) AS canonical
  FROM approval_requests
  WHERE ticket_key LIKE 'pr:%' AND aiw_0073_respelled_subject_key(ticket_key) IS NOT NULL
), ranked AS (
  SELECT mover.*,
         row_number() OVER (
           PARTITION BY canonical, status = 'pending' ORDER BY requested_at, id
         ) AS pending_rank
  FROM mover
)
UPDATE approval_requests approval
SET ticket_key = ranked.canonical
FROM ranked
WHERE approval.id = ranked.id
  AND (
    ranked.status <> 'pending'
    OR (
      ranked.pending_rank = 1
      AND NOT EXISTS (
        SELECT 1 FROM approval_requests held
        WHERE held.ticket_key = ranked.canonical AND held.status = 'pending'
      )
    )
  );
--> statement-breakpoint

-- The Slack thread of a pull request run without a ticket, keyed by its ticket
-- key (primary key): moves unless the canonical key already has a thread.
UPDATE thread_parents thread
SET ticket_key = aiw_0073_respelled_subject_key(thread.ticket_key)
WHERE thread.ticket_key LIKE 'pr:%'
  AND aiw_0073_respelled_subject_key(thread.ticket_key) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM thread_parents held
    WHERE held.ticket_key = aiw_0073_respelled_subject_key(thread.ticket_key)
  )
  AND NOT EXISTS (
    SELECT 1 FROM thread_parents earlier
    WHERE earlier.ticket_key LIKE 'pr:%'
      AND earlier.ticket_key < thread.ticket_key
      AND aiw_0073_respelled_subject_key(earlier.ticket_key)
        = aiw_0073_respelled_subject_key(thread.ticket_key)
  );
--> statement-breakpoint

-- Branches a pull request run without a ticket published, keyed by its ticket
-- key with the repository (primary key): the same rule.
UPDATE workflow_owned_branches branch
SET ticket_key = aiw_0073_respelled_subject_key(branch.ticket_key)
WHERE branch.ticket_key LIKE 'pr:%'
  AND aiw_0073_respelled_subject_key(branch.ticket_key) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM workflow_owned_branches held
    WHERE held.ticket_key = aiw_0073_respelled_subject_key(branch.ticket_key)
      AND held.provider = branch.provider
      AND held.repo_path = branch.repo_path
  )
  AND NOT EXISTS (
    SELECT 1 FROM workflow_owned_branches earlier
    WHERE earlier.ticket_key LIKE 'pr:%'
      AND earlier.ticket_key < branch.ticket_key
      AND earlier.provider = branch.provider
      AND earlier.repo_path = branch.repo_path
      AND aiw_0073_respelled_subject_key(earlier.ticket_key)
        = aiw_0073_respelled_subject_key(branch.ticket_key)
  );
--> statement-breakpoint

-- Work scope records: every spelling of one subject becomes one record.
--   version: the sum, because every applied write moved one record by one, so
--     the merged record has seen all of them and any version a caller read
--     before the merge is stale.
--   entries, one per repository: the strongest origin (lowest rank), a person
--     over a delegated decision at the same rank, then the latest decision, then
--     the row already under the canonical key. Exactly the entry the write path
--     would have kept had both decisions landed on one record.
-- One statement: entries reference their record, and the foreign key is checked
-- when the statement ends, by which time both sides have moved.
WITH mover AS (
  SELECT subject_key, aiw_0073_respelled_subject_key(subject_key) AS canonical
  FROM work_scopes
  WHERE aiw_0073_respelled_subject_key(subject_key) IS NOT NULL
), member AS (
  SELECT subject_key, canonical FROM mover
  UNION ALL
  SELECT scope.subject_key, scope.subject_key
  FROM work_scopes scope
  WHERE scope.subject_key IN (SELECT canonical FROM mover)
), merged_scope AS (
  INSERT INTO work_scopes (subject_key, version, updated_at)
  SELECT member.canonical, sum(scope.version)::integer, max(scope.updated_at)
  FROM member JOIN work_scopes scope ON scope.subject_key = member.subject_key
  GROUP BY member.canonical
  ON CONFLICT (subject_key) DO UPDATE
    SET version = excluded.version, updated_at = excluded.updated_at
  RETURNING subject_key
), ranked_entry AS (
  SELECT member.canonical, entry.*,
         row_number() OVER (
           PARTITION BY member.canonical, entry.repository_key
           ORDER BY entry.origin_rank,
                    (entry.origin = 'person') DESC,
                    entry.decided_at DESC,
                    (entry.subject_key = member.canonical) DESC
         ) AS strength
  FROM member JOIN work_scope_entries entry ON entry.subject_key = member.subject_key
), merged_entry AS (
  INSERT INTO work_scope_entries (
    subject_key, repository_key, state, unavailable_reason, origin, origin_rank,
    rationale, decided_by, decided_at
  )
  SELECT canonical, repository_key, state, unavailable_reason, origin, origin_rank,
         rationale, decided_by, decided_at
  FROM ranked_entry
  WHERE strength = 1
  ON CONFLICT (subject_key, repository_key) DO UPDATE SET
    state = excluded.state,
    unavailable_reason = excluded.unavailable_reason,
    origin = excluded.origin,
    origin_rank = excluded.origin_rank,
    rationale = excluded.rationale,
    decided_by = excluded.decided_by,
    decided_at = excluded.decided_at
  RETURNING subject_key
), moved_entry AS (
  DELETE FROM work_scope_entries entry
  USING mover
  WHERE entry.subject_key = mover.subject_key
  RETURNING entry.subject_key
)
DELETE FROM work_scopes scope
USING mover
WHERE scope.subject_key = mover.subject_key;
--> statement-breakpoint

-- The decision trail is append-only history: every row joins its subject.
UPDATE work_scope_trail
SET subject_key = aiw_0073_respelled_subject_key(subject_key)
WHERE aiw_0073_respelled_subject_key(subject_key) IS NOT NULL;
--> statement-breakpoint

-- One auto-fix budget per pull request: spellings of one repository are summed,
-- because each counted dispatches admitted for the same pull request.
WITH member AS (
  SELECT definition_id, node_id, provider, repo_path, pr_number,
         lower(repo_path) AS canonical, attempts, updated_at
  FROM pr_autofix_attempts budget
  WHERE EXISTS (
    SELECT 1 FROM pr_autofix_attempts spelled
    WHERE spelled.definition_id = budget.definition_id
      AND spelled.node_id = budget.node_id
      AND spelled.provider = budget.provider
      AND spelled.pr_number = budget.pr_number
      AND lower(spelled.repo_path) = lower(budget.repo_path)
      AND spelled.repo_path <> lower(spelled.repo_path)
  )
), merged AS (
  INSERT INTO pr_autofix_attempts (
    definition_id, node_id, provider, repo_path, pr_number, attempts, updated_at
  )
  SELECT definition_id, node_id, provider, canonical, pr_number, sum(attempts)::integer,
         max(updated_at)
  FROM member
  GROUP BY definition_id, node_id, provider, canonical, pr_number
  ON CONFLICT ON CONSTRAINT pr_autofix_attempts_pk DO UPDATE
    SET attempts = excluded.attempts, updated_at = excluded.updated_at
  RETURNING definition_id
)
DELETE FROM pr_autofix_attempts budget
USING member
WHERE budget.definition_id = member.definition_id
  AND budget.node_id = member.node_id
  AND budget.provider = member.provider
  AND budget.repo_path = member.repo_path
  AND budget.pr_number = member.pr_number
  AND member.repo_path <> member.canonical;
--> statement-breakpoint

-- The review publication ledger: one head is one review, found by the
-- repository cased down. A row whose respelling would duplicate a row already
-- there (same pull request, head and content) keeps its spelling: both reviews
-- were posted, and the published one of the pair is the one a probe finds.
WITH mover AS (
  SELECT id, provider, lower(repository) AS canonical, pr_number, head_sha,
         content_hash, state, created_at
  FROM workflow_pr_review_publications
  WHERE repository <> lower(repository)
), ranked AS (
  SELECT mover.*,
         row_number() OVER (
           PARTITION BY provider, canonical, pr_number, head_sha, content_hash
           ORDER BY (state = 'published') DESC, created_at, id
         ) AS rank
  FROM mover
)
UPDATE workflow_pr_review_publications publication
SET repository = ranked.canonical
FROM ranked
WHERE publication.id = ranked.id
  AND ranked.rank = 1
  AND NOT EXISTS (
    SELECT 1 FROM workflow_pr_review_publications held
    WHERE held.provider = ranked.provider
      AND held.repository = ranked.canonical
      AND held.pr_number = ranked.pr_number
      AND held.head_sha = ranked.head_sha
      AND held.content_hash = ranked.content_hash
  );
--> statement-breakpoint

DROP FUNCTION aiw_0073_respelled_subject_key(text);
