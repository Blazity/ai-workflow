CREATE INDEX "workflow_runs_prs_gin_idx" ON "workflow_runs" USING gin ("prs" jsonb_path_ops);
