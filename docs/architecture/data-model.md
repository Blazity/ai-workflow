Status: current
Last-verified: 2026-09-11

# Worker data model

The stable `db/schema.ts` barrel exposes 62 `pgTable` declarations. Production
worker source has zero executable `.transaction(` calls; tests and test support
are excluded from that production-only check.

Of those declarations, 45 live in the 13 domain modules under `db/schema/`.
The other 17 remain in five pre-existing single-purpose files beside the
barrel: `auth-schema.ts` has 13, while `approvals-schema.ts`,
`clarifications-schema.ts`, `email-delivery-schema.ts`, and `memory-schema.ts`
have one each. The barrel re-exports all 18 modules. Mutually dependent tables
share a module, and cross-domain foreign keys import their owning module
directly so initialization order remains explicit.

| TypeScript export | SQL table | Domain | Owner | Principal callers |
|---|---|---|---|---|
| mcpIdempotencyKeys | mcp_idempotency_keys | mcp | residual | MCP services |
| mcpAuditEvents | mcp_audit_events | mcp | residual | MCP services |
| mcpRateLimitWindows | mcp_rate_limit_windows | mcp | residual | MCP services |
| activeRuns | active_runs | runs | active-runs repository | run lifecycle |
| activeRunSandboxes | active_run_sandboxes | runs | active-runs repository | run lifecycle |
| triggerDeliveries | trigger_deliveries | triggers | residual | trigger services |
| manualDispatchRequests | manual_dispatch_requests | dispatch | manual-dispatch repository | manual dispatch |
| failedTickets | failed_tickets | runs | active-runs repository | run lifecycle |
| dispatchCapacityQueue | dispatch_capacity_queue | dispatch | residual | dispatch services |
| threadParents | thread_parents | runs | active-runs repository | run lifecycle |
| gateLocks | gate_locks | post-pr | residual | post-pr gate |
| gateDedupe | gate_dedupe | post-pr | residual | post-pr gate |
| gateCurrent | gate_current | post-pr | residual | post-pr gate |
| envMarker | env_marker | system | residual | startup |
| workflowRuns | workflow_runs | runs | runs repository | overview, lifecycle |
| workflowRunExternalChecks | workflow_run_external_checks | runs | residual | run analysis |
| workflowPrReviewPublications | workflow_pr_review_publications | runs | residual | publication |
| workflowPrReviewPublicationComments | workflow_pr_review_publication_comments | runs | residual | publication |
| workflowRunObservations | workflow_run_observations | observability | residual | run observability |
| workflowBlockAttempts | workflow_block_attempts | runs | residual | engine |
| workflowOwnedBranches | workflow_owned_branches | runs | runs repository | VCS services |
| prePrCheckConfigVersions | pre_pr_check_config_versions | pre-pr | residual | pre-pr checks |
| workflowDefinitionVersions | workflow_definition_versions | definitions | definitions repository | definition services |
| carrySchemaResyncAudit | carry_schema_resync_audit | definitions | definitions repository | definition services |
| workflowDefinitions | workflow_definitions | definitions | definitions repository | definition services |
| workflowDefinitionTriggers | workflow_definition_triggers | definitions | definitions repository | trigger services |
| webhookTriggerEndpoints | webhook_trigger_endpoints | webhooks | residual | webhook services |
| webhookTriggerDeliveries | webhook_trigger_deliveries | webhooks | residual | webhook services |
| webhookTriggerRateLimits | webhook_trigger_rate_limits | webhooks | residual | webhook services |
| webhookTriggerRejectionCounters | webhook_trigger_rejection_counters | webhooks | residual | webhook services |
| systemHealthObservationCounters | system_health_observation_counters | system | residual | health services |
| systemHealthScans | system_health_scans | system | residual | health services |
| triggerRateLimits | trigger_rate_limits | triggers | residual | trigger services |
| triggerRejectionCounters | trigger_rejection_counters | triggers | residual | trigger services |
| prAutofixAttempts | pr_autofix_attempts | pre-pr | residual | pre-pr checks |
| workflowSchedules | workflow_schedules | schedules | definitions repository | schedule services |
| scheduleOccurrences | schedule_occurrences | schedules | definitions repository | schedule services |
| promptLibrary | prompt_library | prompts | prompts repository | prompt library |
| promptLibraryVersions | prompt_library_versions | prompts | prompts repository | prompt library |
| harnessProfileVersions | harness_profile_versions | harness | harness-profiles repository | harness profiles |
| harnessProfiles | harness_profiles | harness | harness-profiles repository | harness profiles |
| harnessCapabilityCatalogs | harness_capability_catalogs | harness | harness-profiles repository | harness profiles |
| harnessSkillArtifacts | harness_skill_artifacts | harness | harness-profiles repository | harness profiles |
| harnessSkillArtifactFiles | harness_skill_artifact_files | harness | harness-profiles repository | harness profiles |
| harnessProfileVersionSkills | harness_profile_version_skills | harness | harness-profiles repository | harness profiles |
| user | user | auth | auth repository | Better Auth |
| organization | organization | auth | auth repository | auth services |
| session | session | auth | auth repository | Better Auth |
| member | member | auth | auth repository | auth services |
| invitation | invitation | auth | auth repository | invite services |
| ssoProvider | sso_provider | auth | auth repository | auth services |
| account | account | auth | auth repository | Better Auth |
| jwks | jwks | auth | auth repository | Better Auth |
| verification | verification | auth | auth repository | Better Auth |
| oauthClient | oauth_client | auth | auth repository | Better Auth |
| oauthRefreshToken | oauth_refresh_token | auth | auth repository | Better Auth |
| oauthAccessToken | oauth_access_token | auth | auth repository | Better Auth |
| oauthConsent | oauth_consent | auth | auth repository | Better Auth |
| approvalRequests | approval_requests | approvals | approvals repository | approval services |
| clarificationRequests | clarification_requests | clarifications | clarifications repository | clarification services |
| inviteEmailDelivery | invite_email_delivery | auth | auth repository | invite services |
| agentMemoryDocuments | agent_memory_documents | memory | residual | memory engine |
