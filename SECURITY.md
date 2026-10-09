# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue or pull request for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with it. We will confirm that we received the report and keep you updated while we work on a fix.

## Supported versions

Fixes land on `main` and ship in the next release. Deployments update by deploying a newer `main` or the latest release.

## What is in scope

- The worker (`apps/worker`): webhook verification, authentication and OAuth for the MCP server, the API, and how runs reach repositories and secrets.
- The dashboard (`apps/dashboard`).
- The integration packages under `integrations/`.

Each deployment runs on its operator's own Vercel and Neon accounts, so the operator is responsible for those accounts, their credentials and which repositories they connect.
