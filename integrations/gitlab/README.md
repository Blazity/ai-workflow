# GitLab integration

Provides the `vcs` capability for GitLab repositories. Existing environment
variables remain valid, and an admin can instead store the same values on the
Integrations page.

The package owns API access, repository profiles, health checks and webhook
normalization. Core chooses it from each repository's persisted provider id.
