---
paths:
  - "apps/worker/src/**/arthur*.ts"
  - "apps/worker/src/services/overview/**"
---

# Arthur Engine API

Verified against a live instance; fetch `/openapi.json` for ground truth before
assuming any endpoint.

- There is no aggregate or overview endpoint. `POST /api/v1/traces/overview`,
  `.../overview/timeseries` and `POST /api/v1/traces/spans` do not exist. The
  real shape is a row query plus client-side aggregation through
  `GET /api/v1/traces`.
- `task_ids` is required on every trace read; an empty value returns 400. Tasks
  have to be enumerated first.
- Pages are zero-indexed. Starting at `page=1` skips the first page and
  silently returns zero.
- `POST /api/v2/tasks/search` pagination is broken (unique tasks decrease as
  page size grows, and it omits tasks that have traces). Use
  `GET /api/v2/tasks?page_size=N`, which returns every task in one array.
- There is no success-rate field. Compute a pass rate from
  `countTraces(..., { continuous_eval_run_status })`. Where continuous evals
  are not configured, passed and failed are both zero and the surface must
  degrade to unavailable rather than to a zero score.
- Trace rows carry no `model_name`; the model appears only inside `span_name`
  for LLM spans, so cost by model is not derivable.
