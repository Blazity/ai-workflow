# AWS Self-Hosting Architecture

Self-hosted AWS deployment of ai-workflow. Docker containers on Fargate for agent sandboxes, ElastiCache Redis for run registry, RDS Postgres for workflow state. Target: up to 100 concurrent agents.

## Infrastructure

```
Internet
    |
    v
+--ALB--+  (HTTPS, future dashboard)
|       |
|  +----v------- Private Subnet ----------------------------+
|  |  EC2 (Nitro server, t4g.small)                         |
|  |  - Workflow DevKit runtime (Postgres world)             |
|  |  - In-process cron (60s interval)                       |
|  |  - Launches Fargate tasks via AWS SDK                   |
|  |  - Polls Fargate task status via ECS API                |
|  |  - Reads results from EFS, pushes to GitHub             |
|  |                                                         |
|  |  ECS Fargate Agent Tasks (0-100)                       |
|  |  - Fargate Spot (default), On-Demand (fallback)        |
|  |  - No inbound ports open                               |
|  |  - Custom Docker image from ECR                        |
|  |  -> GitHub (clone only), Anthropic API (via NAT)       |
|  |                                                         |
|  |  RDS Postgres (db.t4g.micro) <-- EC2 only               |
|  |  ElastiCache Redis (cache.t4g.micro) <-- EC2 only       |
|  |  EFS (shared workspace) <-- EC2 + Fargate               |
|  +---------------------------------------------------------+
|       |
|       v (outbound via NAT Gateway)
|  +------------ Public Subnet ----------------------------+
|  |  NAT Gateway (all private subnet outbound internet)    |
|  +--------------------------------------------------------+
```

## AWS Resources

| Resource             | Spec                                                                                             | Purpose                           |
| -------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------- |
| VPC                  | 2 AZs, public + private subnets, IGW                                                             | Network foundation                |
| NAT Gateway          | Single AZ, in public subnet, Elastic IP (see note below)                                         | Private subnet outbound internet  |
| EC2                  | `t4g.small` (2 vCPU, 2GB), private subnet                                                        | Nitro server                      |
| ALB                  | Public-facing, HTTPS, target = EC2                                                               | Future dashboard, health checks   |
| RDS Postgres         | `db.t4g.micro`, private subnet, single-AZ                                                        | Workflow DevKit state             |
| ElastiCache Redis    | `cache.t4g.micro`, private subnet                                                                | Run registry                      |
| ECS Cluster          | Fargate-only, Spot capacity provider (On-Demand fallback)                                        | Agent task orchestration          |
| ECR Repository       | 1 repo                                                                                           | Agent Docker image                |
| ECS Task Definition  | 1 vCPU, 2GB RAM, 30min timeout, `FARGATE_SPOT` capacity provider                                 | Agent container spec              |
| CloudWatch Log Group | 1 log group, 30-day retention                                                                    | Agent container stdout/stderr     |
| IAM Roles            | EC2 instance role (ECS, ECR, CloudWatch Logs, EFS), ECS task execution role, ECS task role (EFS) | Least-privilege access            |
| EFS Filesystem       | General Purpose, mount targets in private subnets (both AZs)                                     | Shared workspace for agent output |
| Security Groups      | EC2->RDS, EC2->Redis, EC2->EFS, Fargate->EFS, ALB->EC2                                           | Network isolation                 |

## Cost Estimate

**Idle (0 agents):** ~$95/month

- EC2 t4g.small: $12 (+ ~$3 EBS gp3 root volume)
- RDS db.t4g.micro: $13
- ElastiCache cache.t4g.micro: $13
- ALB: $16
- NAT Gateway: ~$32 (hourly charge + data processing at $0.045/GB)
- ECR: ~$1
- EFS: ~$0.30 (Infrequent Access, minimal stored data — workspace dirs cleaned after each run)

**Per agent run (Spot):** ~$0.006-$0.04 (varies by duration, 5-30 min at 1 vCPU / 2GB, ~70% Spot discount)

**Per agent run (On-Demand fallback):** ~$0.02-$0.12

**Sustained 100 agents, 8 hours/day (Spot):** ~$300-$550/month in Fargate costs added to the base (assuming 15-20 min average task duration at current us-east-1 Spot rates: ~$0.01262/vCPU-hour + ~$0.001385/GB-hour). On-Demand fallback adds ~3x per task when Spot capacity is unavailable.

## Agent Container

### Docker Image (ECR)

Base: `node:24-slim`

Pre-installed at build time:

- git
- Claude Code (`@anthropic-ai/claude-code` globally)
- Claude Code skills (superpowers, requesting-code-review, frontend-design)
- `.claude.json` with onboarding skipped

Estimated image size: ~500MB.

Rebuild the image when Claude Code or skills are updated. Skills installation (`npx skills add`) must work at build time without auth tokens — verify in CI. Tag images with commit SHA for traceability. Add an ECR lifecycle policy to retain only the last 10 images.

### Container Lifecycle

Each agent run is one Fargate task. Configuration (branch, requirements, model) passed as ECS task environment variables at launch time. Secrets (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_TOKEN`) are stored in AWS Secrets Manager and injected via `secrets`/`valueFrom` in the task definition — never as plaintext `environment` entries.

The container only runs Claude Code — it does not push to GitHub, move Jira tickets, or communicate results. The Nitro server handles all of that after the container finishes.

```
ECS RunTask (launched by Nitro)
    |
    v
1. mkdir -p /workspace/$RUN_ID && cd /workspace/$RUN_ID
2. Git clone branch (shallow, depth=1)
3. Configure git identity
4. Merge base branch (if review-fix)
5. Save pre-agent SHA to /workspace/$RUN_ID/.pre-agent-sha
6. Write requirements.md to /workspace/$RUN_ID/requirements.md
7. Run Claude Code (--print --json-schema)
8. Run commit guard (end hook — commit any uncommitted changes)
9. Exit (Fargate auto-stops, task enters STOPPED)
   (workspace persists on EFS for Nitro to read)
```

### Orchestration Flow (Nitro workflow using WDK)

The Nitro server uses the Workflow DevKit's `sleep()` to poll Fargate task status without wasting compute:

```
1. provisionAndStartAgent()
   - ECS RunTask -> launches Fargate container
   - Returns taskArn

2. Poll loop (workflow suspends between checks):
   while status == "running":
     sleep("30s")
     status = ECS describeTasks(taskArn)
     if stopCode == "SpotInterruption": retry step

3. collectResults()
   - Read agent stdout from CloudWatch Logs (or ECS API)
   - Parse structured JSON output (same as current parseAgentOutput)
   - Read pre-agent SHA from /workspace/$RUN_ID/.pre-agent-sha
   - Run `git diff --name-only $baseSha HEAD` against the EFS repo clone
   - Read each changed file from the EFS working tree (replaces sandbox.readFileToBuffer)
   - Post-agent cleanup (Nitro-side, on EFS): remove .claude/, requirements.md,
     and force-commit any uncommitted changes against the EFS working tree
   - Return { path, content }[] to the workflow (same shape as current extractChanges)
   - Cleanup: rm -rf /workspace/$RUN_ID/

4. pushChanges()
   - Push files via GitHub API (same VCSAdapter as today)

5. createPullRequest(), moveTicket(), notifySlack()
   - All handled by Nitro, same as today
```

This preserves the exact same pattern as the current Vercel Sandbox flow: the workflow orchestrates everything, the container just runs the agent.

## EFS Shared Workspace

### How It Works

One EFS filesystem shared between EC2 (Nitro) and all Fargate agent tasks. Each task writes to an isolated directory keyed by run ID:

```
EFS filesystem (fs-xxxxx), mounted at /workspace
└── /workspace/
    ├── run-abc123/       ← Agent task 1 (clones, works, exits)
    ├── run-def456/       ← Agent task 2
    ├── run-ghi789/       ← Spot-interrupted task (partial work still readable)
    └── ...
```

- **Fargate tasks** mount EFS at `/workspace` via the ECS task definition volume configuration.
- **EC2 (Nitro)** mounts the same EFS via standard NFS mount.
- Writes are visible immediately across both — no sync, copy, or upload step.
- Nitro reads the agent's git working tree directly from `/workspace/$RUN_ID/` after the task stops.
- Nitro deletes the directory after extracting results and pushing to GitHub.

### ECS Task Definition Volume Config

```json
{
  "volumes": [
    {
      "name": "workspace",
      "efsVolumeConfiguration": {
        "fileSystemId": "fs-xxxxx",
        "transitEncryptionEnabled": true
      }
    }
  ],
  "containerDefinitions": [
    {
      "mountPoints": [
        {
          "sourceVolume": "workspace",
          "containerPath": "/workspace"
        }
      ]
    }
  ]
}
```

### Spot Interruption + EFS

When a Spot task is interrupted, the EFS directory still contains whatever the agent wrote up to that point. Nitro can inspect the partial state and decide:

- If commits exist → salvageable (push partial work or retry from that point)
- If no useful commits → retry the full step with a clean directory

## Networking

### Outbound Access

| Component      | Outbound to                                                                     |
| -------------- | ------------------------------------------------------------------------------- |
| EC2 (Nitro)    | RDS, ElastiCache, EFS, ECS API, CloudWatch Logs, GitHub, Jira, Slack, Anthropic |
| Fargate Agents | EFS, GitHub (clone), Anthropic API                                              |

All compute (EC2 and Fargate) lives in private subnets and reaches the internet via the NAT Gateway in the public subnet.

**NAT single-AZ risk:** The NAT Gateway runs in one AZ only. If that AZ goes down, all outbound internet access stops (no GitHub clones, no Anthropic API calls). This is an accepted cost tradeoff — a second NAT adds ~$32/month. For production deployments requiring higher availability, add a second NAT Gateway in the other AZ with per-AZ route tables.

### Inbound Access

| Component      | Inbound from               |
| -------------- | -------------------------- |
| EC2            | ALB only                   |
| RDS            | EC2 only                   |
| ElastiCache    | EC2 only                   |
| ALB            | Internet                   |
| Fargate Agents | Nothing (no inbound ports) |

### Security Groups

| SG           | Inbound Rules                          |
| ------------ | -------------------------------------- |
| `sg-alb`     | 443 from 0.0.0.0/0                     |
| `sg-ec2`     | 3000 from sg-alb                       |
| `sg-rds`     | 5432 from sg-ec2                       |
| `sg-redis`   | 6379 from sg-ec2                       |
| `sg-efs`     | 2049 from sg-ec2, 2049 from sg-fargate |
| `sg-fargate` | No inbound rules                       |

## Spot Instance Strategy

### Capacity Provider Configuration

The ECS cluster uses a mixed capacity provider strategy:

| Capacity Provider | Weight | Base |
| ----------------- | ------ | ---- |
| `FARGATE_SPOT`    | 4      | 0    |
| `FARGATE`         | 1      | 0    |

This routes ~80% of tasks to Spot, with On-Demand as automatic fallback when Spot capacity is unavailable. No base count is needed since agent tasks are fully elastic.

### Spot Interruption Handling

Fargate Spot tasks receive a 2-minute warning before termination via the task metadata endpoint. Agent containers are stateless and expendable — interruption handling is simple:

1. **No in-container handling needed.** The container runs Claude Code and exits. If interrupted, the Fargate task transitions to `STOPPED` with `stopCode: SpotInterruption` (machine-parseable enum; `stoppedReason` provides the human-readable message).
2. **Nitro detects the interruption** during its poll loop (`describeTasks` returns `stopCode`).
3. **Nitro retries the workflow step** — up to `SPOT_MAX_RETRIES` attempts (default: 3). After exhausting retries, the task is dispatched as On-Demand (`FARGATE` capacity provider) as a final attempt.
4. **EFS state is checked before retry** — if the interrupted task left usable commits in `/workspace/$RUN_ID/`, Nitro can salvage them instead of retrying from scratch.
5. **Git state is safe** — the agent hasn't pushed anything (Nitro handles pushing). A clean retry starts fresh from the same branch in a new directory.

No SIGTERM handler, checkpoint logic, or graceful shutdown is required in the agent container.

### When Spot Is Unavailable

If `FARGATE_SPOT` capacity is exhausted in the region, ECS automatically falls back to `FARGATE` (On-Demand) based on the capacity provider weights. No manual intervention needed. The only impact is cost (~3x per task).

Tasks should be spread across both AZ subnets (via `ECS_SUBNETS`) to maximize Spot capacity availability, since Spot pools are per-AZ.

### `SPOT_ENABLED` Toggle

When `SPOT_ENABLED=true` (default), the `RunTask` call uses the mixed capacity provider strategy (`FARGATE_SPOT` weight 4, `FARGATE` weight 1).

When `SPOT_ENABLED=false`, the `RunTask` call uses `[{capacityProvider: "FARGATE", weight: 1}]` exclusively — all tasks run On-Demand. Use this to disable Spot during debugging or if Spot interruptions become disruptive in a particular region.

## Scaling

- Concurrency control via `MAX_CONCURRENT_AGENTS` env var (default: 100).
- Before dispatching, Nitro checks active Fargate task count via ECS `listTasks(status=RUNNING)`.
- Fargate has a default task limit of 100 per cluster (can be raised via AWS support ticket).
- Each agent task is independent — no shared state between agents.
- ENI limits: Fargate `awsvpc` mode assigns one ENI per task. 100 concurrent tasks across 2 AZs = ~50 ENIs per subnet. Use /24 subnets (254 IPs) or larger to avoid exhaustion.
- EFS throughput: General Purpose mode baseline is 50 KiB/s per GiB stored. With minimal stored data, baseline throughput is low. At 100 concurrent agents doing git clones, consider Elastic Throughput mode or Provisioned Throughput if I/O becomes a bottleneck.

## Cron / Polling

In-process scheduler inside a Nitro plugin fires every 60 seconds, calling the poll handler internally. No external cron service needed.

Implementation: a Nitro plugin that starts a recurring 60-second timer on boot, invoking the poll handler directly in-process (not via HTTP). The `verifyCronAuth` / `CRON_SECRET` check is bypassed for internal calls. The `/cron/poll` HTTP route can remain for manual triggers (protected by a shared secret or ALB-only access).

The poll handler discovers tickets in the AI column, dispatches new workflows, and reconciles stale runs.

## Workflow DevKit

WDK's self-hosted Postgres world drives durable workflow orchestration:

- The Nitro plugin boots the Postgres world on startup.
- Nitro uses `preset: "node-server"` with the `workflow/nitro` module.
- RDS Postgres stores workflow state (runs, steps, replay log).

## Required Code Changes

### Run Registry: Upstash REST → ElastiCache TCP

The current run registry adapter (`src/adapters/run-registry/upstash.ts`) uses `@upstash/redis` which speaks HTTP/REST (`AI_WORKFLOW_KV_REST_API_URL`, `AI_WORKFLOW_KV_REST_API_TOKEN`). ElastiCache Redis is TCP-only (port 6379) and does not expose a REST API.

A new `RunRegistryAdapter` implementation is required using a TCP-based Redis client (`ioredis` or `redis`). It must implement the same `RunRegistryAdapter` interface (get, set, delete, list active runs). The env var is `REDIS_URL` (e.g., `redis://xxxxx.cache.amazonaws.com:6379`).

The adapter selection should be driven by config — e.g., `RUN_REGISTRY_KIND=elasticache` alongside the existing `upstash` option.

### Sandbox → ECS Adapter

The current sandbox adapter (`src/adapters/sandbox/`) uses `@vercel/sandbox` for agent execution. This must be replaced with an ECS adapter that:

- **`provisionAndStartAgent()`** — calls `ECS.RunTask()` with the task definition, subnets, security group, capacity provider strategy, and env var overrides. Returns a `taskArn`.
- **`pollTaskStatus(taskArn)`** — calls `ECS.DescribeTasks()` to check task state and detect Spot interruptions (`stopCode: SpotInterruption`).
- **`getActiveSandboxCount()`** — currently calls `Sandbox.list()`. Must be replaced with `ECS.ListTasks({ cluster, desiredStatus: "RUNNING" })` and return the count. Used by `src/lib/dispatch.ts` for concurrency gating.
- **`collectResults(runId)`** — reads agent output from the EFS workspace (`/workspace/$RUN_ID/`) instead of `sandbox.readFileToBuffer()`. Runs `git diff` against the pre-agent SHA to identify changed files.

The adapter selection should be driven by config — e.g., `SANDBOX_KIND=ecs` alongside the existing `vercel` option.

## Deployment

```
Developer pushes to main
    |
    v
CI (GitHub Actions)
    |-- Build agent Docker image -> push to ECR (tagged with commit SHA)
    |-- Build Nitro server (nitro build with preset: "node-server")
    |-- rsync/SCP build output to EC2
    +-- Restart Nitro process (systemd reload)
```

Agent containers are immutable — new tasks always pull the latest image tag.

## Environment Variables

| Variable                                          | Purpose                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `REDIS_URL`                                       | ElastiCache Redis connection string                                  |
| `AWS_REGION`                                      | AWS region for ECS/ECR calls                                         |
| `ECS_CLUSTER`                                     | ECS cluster name                                                     |
| `ECS_TASK_DEFINITION`                             | Task definition ARN for agent containers                             |
| `ECS_SUBNETS`                                     | Comma-separated private subnet IDs for agent tasks                   |
| `ECS_SECURITY_GROUP`                              | Security group ID for agent tasks                                    |
| `ECR_IMAGE_URI`                                   | Full ECR image URI for agent container                               |
| `WORKFLOW_POSTGRES_URL`                           | RDS Postgres connection string                                       |
| `ISSUE_TRACKER_KIND`, `JIRA_*`                    | Jira connection                                                      |
| `VCS_KIND`, `GITHUB_*`                            | GitHub connection                                                    |
| `CHAT_SDK_*`                                      | Slack messaging                                                      |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`  | Claude Code auth (via Secrets Manager `valueFrom`)                   |
| `CLAUDE_MODEL`                                    | Model selection                                                      |
| `COMMIT_AUTHOR`, `COMMIT_EMAIL`                   | Git identity for agent commits                                       |
| `MAX_CONCURRENT_AGENTS`                           | Concurrency limit (default: 100)                                     |
| `SPOT_ENABLED`                                    | Use Fargate Spot (default: true). `false` = On-Demand only           |
| `SPOT_MAX_RETRIES`                                | Max Spot interruption retries before On-Demand fallback (default: 3) |
| `EFS_FILESYSTEM_ID`                               | EFS filesystem ID for shared workspace                               |
| `JOB_TIMEOUT_MS`                                  | Per-agent timeout (default: 1,800,000ms / 30min)                     |
| `COLUMN_AI`, `COLUMN_AI_REVIEW`, `COLUMN_BACKLOG` | Jira column names                                                    |

## Operations

### Monitoring

| Alarm                  | Metric                                                  | Threshold                                        |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| Agent failure rate     | ECS task `stoppedReason != EssentialContainerExited(0)` | >20% of tasks in 15min window                    |
| Task count near limit  | ECS `listTasks(RUNNING)` count                          | >80 (of 100 limit)                               |
| EC2 health             | ALB target health check                                 | Unhealthy for >2 min                             |
| RDS connections        | `DatabaseConnections`                                   | >80% of max                                      |
| ElastiCache memory     | `BytesUsedForCache` / `MaxMemory`                       | >80%                                             |
| EFS burst credits      | `BurstCreditBalance`                                    | <1 TiB (approaching zero)                        |
| Spot interruption rate | `SpotInterruption` stop codes / total tasks             | Informational (triggers alert if >50% in 1 hour) |

All alarms go to an SNS topic for Slack/PagerDuty notification.

### EC2 Single Point of Failure

The Nitro server runs on a single EC2 instance. To handle instance failures:

- Place EC2 in an Auto Scaling Group with `min=1, max=1, desired=1` and an EC2 health check. ASG automatically replaces the instance if it fails.
- WDK's durable replay log in Postgres means in-flight workflows resume from their last completed step after restart — no work is lost.
- Running Fargate tasks continue executing during EC2 downtime. Their results accumulate on EFS and are collected when Nitro restarts.
- Orphaned EFS directories (from runs where Nitro crashed before cleanup) are handled by a daily cleanup sweep: scan `/workspace/` for directories older than 2 hours, cross-reference against `ECS.listTasks(RUNNING)` to exclude active runs, and remove the rest.

### Backups

- RDS: automated daily snapshots with 7-day retention (default). This is the only stateful component that matters — it contains the WDK replay log.
- ElastiCache: no backup needed — the run registry is reconstructable from RDS workflow state.
- EFS: no backup needed — workspace directories are ephemeral.
