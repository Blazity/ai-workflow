# Workflow Repository Access Design

## Goal

Show every repository visible to a configured VCS provider in the workflow
editor while preserving `AGENT_ALLOWED_REPOS` as the default runtime boundary.
A deployed workflow may extend that boundary only by explicitly pinning an exact
provider and repository path.

## Access Model

Repository visibility and runtime authorization are separate concerns:

1. **Provider visibility** is the complete repository catalog returned by the
   configured GitHub App or GitLab token.
2. **Global access** is the repository set named by `AGENT_ALLOWED_REPOS`.
3. **Workflow access** is the exact repository set pinned in the deployed
   workflow version.
4. **Provider scope** narrows which configured providers a workflow may use. It
   never grants repository access by itself.

A run may use a repository when:

```text
provider is enabled for the workflow
AND
(
  repository is globally allowed
  OR
  exact provider + repository path is pinned in the deployed workflow version
)
```

An absent or empty repository pin does not extend global access. An absent
provider scope means every configured provider is enabled.

Repository matching remains case-insensitive for paths and exact for the
provider. A GitHub pin cannot authorize a GitLab repository with the same path.

## Security Boundary

The workflow exception is derived only from the immutable deployed definition
captured for a run. Editing or saving a draft does not grant access. Existing
guards before reads, workspace publication, branch mutation, comments, pushes,
PRs, and MRs remain in place; they evaluate global access plus the run's pinned
scope instead of bypassing `AGENT_ALLOWED_REPOS`.

Webhook and manual-dispatch admission must not treat a provider-only scope as an
exception. A repository outside the global allowlist is admitted only when an
eligible deployed workflow explicitly pins that provider and repository path.
The normal trigger rules still decide whether that workflow runs.

Automatic repository discovery and selection use:

- every globally allowed repository from enabled providers; plus
- every explicitly pinned repository in the deployed workflow.

They never use other catalog entries merely because those entries are visible
in the dashboard.

## Repository Catalog API

Provider adapters return their complete accessible repository listings without
applying `AGENT_ALLOWED_REPOS`. Runtime callers explicitly apply the runtime
authorization policy after listing.

`RepositoriesResponse` additionally reports the configured provider states so
the dashboard does not infer connectivity from repository presence:

```ts
interface RepositoryProviderStatus {
  provider: "github" | "gitlab";
  status: "ready" | "not_connected" | "error";
  error?: string;
}

interface RepositoriesResponse {
  repositories: RepositoryOption[];
  providers: RepositoryProviderStatus[];
}
```

The dashboard catalog endpoint returns repositories from every successfully
configured provider. A provider with no credentials is reported as
`not_connected`; a configured provider whose listing failed is reported as
`error`. Repository count is not used as a connectivity signal: a configured
provider may legitimately return zero repositories and still report `ready`.

The existing 60-second dashboard cache stores both repositories and provider
states.

## Provider UX

The modal renders GitHub and GitLab as scope controls:

- Every configured provider is visually active by default for an absent or
  empty provider scope.
- An unconfigured provider is inactive, disabled, and labeled
  `Not connected`.
- At least one configured provider must remain active.
- Deactivating a provider immediately hides its repository rows.
- Deactivating a provider removes that provider's pinned repositories from the
  modal draft.
- Cancel restores the saved scope because all edits remain local to the modal.
- Apply persists the narrowed provider scope and remaining pins.
- When all configured providers are active, normalization omits the provider
  array so existing "all configured providers" semantics and forward
  compatibility remain intact.

If no provider is configured, both controls are disabled, the catalog remains
empty, and Apply cannot manufacture a provider scope.

## Repository UX

The repository list is filtered first by active providers and then by the text
query. It includes repositories outside `AGENT_ALLOWED_REPOS`; selecting one is
the explicit action that grants the workflow-specific exception after the
workflow is deployed.

Previously saved pins that are no longer returned by the provider remain
visible and preserved unless their provider is deactivated or the user removes
them. Archived repositories keep the existing non-selectable behavior.

## Compatibility

Existing deployed workflows retain their meaning:

- no provider scope means all configured providers;
- no repository pins means global allowlist only;
- existing pins authorize those exact repositories for their workflow;
- `AGENT_ALLOWED_REPOS` unset continues to mean every provider-visible
  repository is globally allowed.

No database migration is required because the existing
`WorkflowRepositoryScope` shape is sufficient.

## Error Handling

- A configured provider whose listing fails remains configured but the catalog
  reports a provider-specific failure rather than presenting it as disconnected.
- Runtime selection continues to fail closed when a failed provider could
  affect the run.
- A pin does not hide provider authentication or repository-not-found errors.
  It authorizes an attempt; the provider still enforces actual access.
- Direct mutation attempts without a run scope or eligible deployed workflow
  continue to require global allowlist membership.

## Testing

Tests must prove:

1. Catalog adapters and the dashboard endpoint return repositories outside
   `AGENT_ALLOWED_REPOS`.
2. Provider configuration state is returned independently of repository count.
3. Automatic selection still excludes repositories outside the global
   allowlist.
4. An exact deployed pin includes and authorizes an otherwise disallowed
   repository.
5. Provider-only scope does not extend repository access.
6. Provider and path matching cannot cross-authorize another provider.
7. Webhook, manual dispatch, sandbox reads/writes, comments, pushes, and PR/MR
   creation reject an unlisted, unpinned repository.
8. The same paths accept an exact repository pin from the immutable run scope.
9. All configured providers appear active by default in the modal.
10. Unconfigured providers are disabled and labeled `Not connected`.
11. Deactivating a provider filters its catalog rows and removes its draft pins.
12. The last configured provider cannot be deactivated.
13. Cancel discards provider filtering and automatic draft-pin removal.
