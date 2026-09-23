# GitHub integration

Provides the `vcs` capability for GitHub repositories. Existing environment
variables remain valid, and an admin can instead store the same values on the
Integrations page.

The package owns App authentication, API access, repository profiles, skill
sources, health checks and webhook normalization. Core chooses it from each
repository's persisted provider id, and `/webhooks/github` keeps the URL and the
signature scheme the App already calls.

Connecting through the dashboard means supplying the App ID, the installation ID
and the private key, which is what the environment supplies today. There is no
App install redirect yet: that needs an App registered against a public callback
URL and is tracked separately. The private key is accepted both as the `.pem`
file GitHub downloads and as its base64 form, and a value that is neither is
refused before the connection is activated rather than mangled and stored.
