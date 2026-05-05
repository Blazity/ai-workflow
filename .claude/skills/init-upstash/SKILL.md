---
name: init-upstash
description: Configure the Upstash Redis run registry for Blazebot via the Vercel Marketplace. Verifies the AI_WORKFLOW_KV prefix and the auto-injected env vars. Use for "set up redis", "configure upstash", "install upstash marketplace", "fix run registry".
---

# Initialize Upstash Redis

Walks the user through installing **Upstash for Redis** from the Vercel Marketplace with the env-var prefix set to `AI_WORKFLOW_KV` so Vercel auto-injects the two keys `env.ts` expects:

- `AI_WORKFLOW_KV_REST_API_URL`
- `AI_WORKFLOW_KV_REST_API_TOKEN`

Blazebot uses Redis as a run registry — a small key-value store tracking active workflow runs per ticket, used by reconcile and webhook cancellation.

> If you want full project setup (Jira + VCS + Agent + Slack + Upstash + deploy), invoke `init-env` instead. This skill only handles Upstash.

## Precondition

`.vercel/project.json` must exist. If missing:

```
ERROR: no Vercel project linked. Run `vercel link` first, or invoke `init-env`
for the full first-time setup.
```

Halt.

## Step 1 — Marketplace install

Walk the user through these clicks (Vercel dashboard, dashboard install is faster than CLI):

1. Open https://vercel.com/dashboard → pick the linked project.
2. Click **Storage** in the project sidebar.
3. **Browse Marketplace** → search "Upstash for Redis" → **Open**.
4. **Add to project** → pick the linked project.
5. **Choose plan** — Free tier is fine for getting started.
6. **Connect Project** → on the connection screen, look for **"Environment Variables Prefix"** (or similar wording) and **set it to `AI_WORKFLOW_KV`**. This is the critical step — without the right prefix, Vercel injects keys named `KV_REST_API_URL` etc. which `env.ts` doesn't recognize.
7. Confirm the install. Vercel auto-injects `AI_WORKFLOW_KV_REST_API_URL` and `AI_WORKFLOW_KV_REST_API_TOKEN` for all three environments.

## Step 2 — Confirm the keys landed

Tell the user to confirm in Vercel → Project Settings → Environment Variables that they see:

- `AI_WORKFLOW_KV_REST_API_URL` (value: `https://<id>.upstash.io`)
- `AI_WORKFLOW_KV_REST_API_TOKEN`

If the keys are named differently (e.g. `KV_REST_API_URL` without the `AI_WORKFLOW_KV` prefix), the prefix wasn't set correctly during install. Two recovery paths:

- **Easier:** uninstall the Upstash integration (Storage → Upstash → Disconnect), reinstall with the correct prefix.
- **Manual rename:** rename the env vars in Vercel from `KV_*` to `AI_WORKFLOW_KV_*`. Works but the integration won't keep them in sync if Upstash later rotates the underlying values.

## Step 3 — Done

No paste-template needed — keys are auto-injected by Vercel. The end-of-flow validator (in `init-env`) confirms they made it.

If invoked from `init-env`, return control. If standalone, end.

## Don'ts

- **Don't manually create an Upstash database outside the Marketplace.** You'd lose the auto-injection benefit and have to manage env vars by hand. The Marketplace integration is preferred per Decision 6.
- **Don't change the prefix after install.** Vercel rewrites the env keys on the integration's behalf; if you rename them manually, Upstash's update flow gets confused.
- **Don't try to use Upstash REST URL/token from a non-Vercel deployment.** They work — but you'd be bypassing the Marketplace integration's billing and quota limits.
