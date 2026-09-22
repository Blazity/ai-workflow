<!--
Written from the template: `pnpm run new:integration -- <id>` copied
integrations/_template here with the template's names replaced. Fill in every
section before the integration ships; the guide is
docs/architecture/integrations.md.
-->

# Example

One paragraph: what Example is, and what a deployment gets by connecting it.

## Connecting it

| Field | Variable | Required | What it is |
|---|---|---|---|
| API URL | `EXAMPLE_BASE_URL` | yes | Where the Example API answers. |
| API token | `EXAMPLE_API_TOKEN` | yes | A token for the account this deployment acts as. |

Where an admin finds each value, and which permissions the token needs. An
admin can set the variables on the deployment, or type the values on the
Integrations page, where saving tests them before they are used.

## What connecting it unlocks

- The **Example lookup** block: searches Example for the text bound to its
  `query` input and reports `found` or `nothing_found`.
- The **Overview** tab: the account the token belongs to.
- The **API access** row on the System health page.

## What lives here

| File | What it is |
|---|---|
| `manifest.ts` | Identity, connection fields, capabilities, blocks, pages, health checks. Plain data. |
| `worker.ts` | The connection test, the block, the health probe, what the Overview page reads. |
| `dashboard.tsx` | The Overview page, built on `@integrations/host-ui`. |

## Provider documentation this is written against

| What | Where | Read on |
|---|---|---|
| Authentication | the provider's page | YYYY-MM-DD |
| The calls this package makes, and what each returns | the provider's page | YYYY-MM-DD |
| Rate limits and error codes | the provider's page | YYYY-MM-DD |
