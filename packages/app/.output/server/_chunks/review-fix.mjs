import { i as __toESM } from "../_runtime.mjs";
import { I as _enum, L as number, R as string, z as FatalError } from "../_libs/@workflow/core+[...].mjs";
import { t as require_dist } from "../_libs/@slack/web-api+[...].mjs";
import { a as eq, c as pgTable, d as text, f as integer, l as uuid, m as unique, n as index, p as pgEnum, r as src_default, t as drizzle, u as timestamp } from "../_libs/drizzle-orm+postgres.mjs";
import { n as createEnv, t as createEnv$1 } from "../_libs/t3-oss__env-core.mjs";
import { i as stringType, n as enumType, r as objectType, t as arrayType } from "../_libs/zod.mjs";
import { t as require_pino } from "../_libs/pino+[...].mjs";
import { t as Octokit } from "../_libs/octokit__rest.mjs";
import { t as require_docker } from "../_libs/dockerode+[...].mjs";
import { join, resolve } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
//#region ../shared/dist/env.js
const env = createEnv({
	server: {
		DATABASE_URL: stringType().url(),
		NODE_ENV: enumType([
			"development",
			"production",
			"test"
		]).default("development"),
		COLUMN_AI: stringType().default("AI"),
		COLUMN_AI_REVIEW: stringType().default("AI Review"),
		COLUMN_BACKLOG: stringType().default("Backlog"),
		ISSUE_TRACKER_KIND: enumType(["jira", "linear"]).default("jira"),
		MESSAGING_KIND: enumType(["slack"]).default("slack"),
		SLACK_BOT_TOKEN: stringType().min(1).optional(),
		SLACK_DEFAULT_CHANNEL: stringType().min(1).optional(),
		VCS_KIND: enumType(["github"]).default("github")
	},
	runtimeEnv: process.env
});
const db = drizzle({ client: src_default(env.DATABASE_URL) });
//#endregion
//#region ../shared/dist/logger.js
var import_pino = /* @__PURE__ */ __toESM(require_pino(), 1);
function createLogger() {
	return (0, import_pino.default)({
		level: process.env.LOG_LEVEL ?? "info",
		formatters: { level(label) {
			return { level: label };
		} }
	});
}
//#endregion
//#region ../shared/dist/schema.js
const ticketSourceEnum = pgEnum("ticket_source", ["jira", "linear"]);
const workflowStateEnum = pgEnum("workflow_state", [
	"queued",
	"implementing",
	"clarification_pending",
	"awaiting_review",
	"fixing_feedback",
	"completed",
	"failed"
]);
const runStatusEnum = pgEnum("run_status", [
	"pending",
	"preparing_sandbox",
	"running",
	"succeeded",
	"failed",
	"timed_out",
	"clarification_needed"
]);
const runTypeEnum = pgEnum("run_type", [
	"implementation",
	"review_fix",
	"conflict_resolution"
]);
const tickets = pgTable("tickets", {
	id: uuid("id").defaultRandom().primaryKey(),
	externalId: text("external_id").notNull(),
	identifier: text("identifier").notNull(),
	source: ticketSourceEnum("source").notNull(),
	state: text("state"),
	workflowState: workflowStateEnum("workflow_state").notNull().default("queued"),
	assignee: text("assignee"),
	branchName: text("branch_name"),
	prId: text("pr_id"),
	currentRunId: uuid("current_run_id"),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [unique("tickets_external_id_source_unique").on(t.externalId, t.source)]);
const runAttempts = pgTable("run_attempts", {
	id: uuid("id").defaultRandom().primaryKey(),
	ticketId: uuid("ticket_id").notNull().references(() => tickets.id),
	attemptNumber: integer("attempt_number").notNull().default(1),
	type: runTypeEnum("type").notNull(),
	status: runStatusEnum("status").notNull().default("pending"),
	containerId: text("container_id"),
	branchName: text("branch_name"),
	startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
	finishedAt: timestamp("finished_at", { withTimezone: true }),
	error: text("error")
}, (t) => [index("run_attempts_ticket_id_idx").on(t.ticketId)]);
//#endregion
//#region ../shared/dist/adapters/jira-webhook-parser.js
const changelogItemSchema = objectType({
	field: stringType(),
	fieldtype: stringType(),
	fromString: stringType().nullable().transform((v) => v ?? ""),
	toString: stringType()
});
const jiraWebhookSchema = objectType({
	user: objectType({
		accountId: stringType(),
		displayName: stringType()
	}),
	issue: objectType({ key: stringType() }),
	changelog: objectType({ items: arrayType(changelogItemSchema) })
});
function parseJiraWebhook(body) {
	const parsed = jiraWebhookSchema.safeParse(body);
	if (!parsed.success) return null;
	const { user, issue, changelog } = parsed.data;
	const statusChange = changelog.items.find((item) => item.field === "status");
	if (!statusChange) return null;
	return {
		type: "ticket_moved",
		ticketId: issue.key,
		fromColumn: statusChange.fromString,
		toColumn: statusChange.toString,
		triggeredBy: user.displayName,
		triggeredByAccountId: user.accountId
	};
}
//#endregion
//#region ../shared/dist/adapters/jira-client.js
var JiraClient = class {
	baseUrl;
	authHeader;
	constructor(baseUrl, email, apiToken) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
	}
	async request(path, options = {}) {
		const res = await fetch(`${this.baseUrl}${path}`, {
			...options,
			headers: {
				"Content-Type": "application/json",
				Authorization: this.authHeader,
				...options.headers
			}
		});
		if (!res.ok && res.status !== 204) throw new Error(`Jira API error: ${res.status}`);
		return res;
	}
	async fetchTicket(id) {
		const data = await (await this.request(`/rest/api/3/issue/${id}?fields=summary,description,comment,labels,status`)).json();
		return {
			externalId: data.key,
			identifier: data.key,
			title: data.fields.summary,
			description: this.extractText(data.fields.description),
			acceptanceCriteria: null,
			comments: (data.fields.comment?.comments ?? []).map((c) => ({
				author: c.author.displayName,
				body: typeof c.body === "string" ? c.body : this.extractText(c.body),
				createdAt: new Date(c.created)
			})),
			labels: data.fields.labels ?? [],
			trackerStatus: data.fields.status?.name ?? ""
		};
	}
	async moveTicket(id, column) {
		const transition = (await (await this.request(`/rest/api/3/issue/${id}/transitions`, { method: "GET" })).json()).transitions.find((t) => t.name.toLowerCase() === column.toLowerCase());
		if (!transition) throw new Error(`No transition found matching '${column}'`);
		await this.request(`/rest/api/3/issue/${id}/transitions`, {
			method: "POST",
			body: JSON.stringify({ transition: { id: transition.id } })
		});
	}
	async postComment(id, comment) {
		await this.request(`/rest/api/3/issue/${id}/comment`, {
			method: "POST",
			body: JSON.stringify({ body: {
				type: "doc",
				version: 1,
				content: [{
					type: "paragraph",
					content: [{
						type: "text",
						text: comment
					}]
				}]
			} })
		});
	}
	async searchTickets(jql) {
		return ((await (await this.request("/rest/api/3/search/jql", {
			method: "POST",
			body: JSON.stringify({
				jql,
				fields: ["key"],
				maxResults: 50
			})
		})).json()).issues ?? []).map((issue) => issue.key);
	}
	parseWebhook(req) {
		return parseJiraWebhook(req);
	}
	extractText(adf) {
		if (typeof adf === "string") return adf;
		if (!adf || typeof adf !== "object") return "";
		const node = adf;
		if (!node.content) return "";
		return node.content.map((child) => {
			const c = child;
			if (c.text) return c.text;
			if (c.content) return this.extractText(child);
			return "";
		}).join("");
	}
};
//#endregion
//#region ../shared/dist/adapters/github-client.js
var GitHubClient = class {
	octokit;
	constructor(token) {
		this.octokit = new Octokit({ auth: token });
	}
	async createBranch(repoOwner, repoName, branchName, baseBranch) {
		let refSha;
		try {
			const { data: ref } = await this.octokit.git.getRef({
				owner: repoOwner,
				repo: repoName,
				ref: `heads/${baseBranch}`
			});
			refSha = ref.object.sha;
		} catch (err) {
			if (err.status !== 409) throw err;
			try {
				const { data } = await this.octokit.repos.createOrUpdateFileContents({
					owner: repoOwner,
					repo: repoName,
					path: "README.md",
					message: "Initial commit",
					content: Buffer.from(`# ${repoName}\n`).toString("base64")
				});
				refSha = data.commit.sha;
			} catch (initErr) {
				throw new Error(`Failed to initialize empty repository ${repoOwner}/${repoName}: ${initErr.message}`);
			}
		}
		try {
			await this.octokit.git.createRef({
				owner: repoOwner,
				repo: repoName,
				ref: `refs/heads/${branchName}`,
				sha: refSha
			});
		} catch (err) {
			if (err.status === 422) return;
			throw err;
		}
	}
	async createPR(repoOwner, repoName, title, body, head, base) {
		try {
			const { data } = await this.octokit.pulls.create({
				owner: repoOwner,
				repo: repoName,
				title,
				body,
				head,
				base
			});
			return {
				number: data.number,
				url: data.html_url
			};
		} catch (err) {
			if (err.status === 422) {
				const { data: prs } = await this.octokit.pulls.list({
					owner: repoOwner,
					repo: repoName,
					head: `${repoOwner}:${head}`,
					base,
					state: "open",
					per_page: 1
				});
				if (prs.length > 0) {
					await this.octokit.pulls.update({
						owner: repoOwner,
						repo: repoName,
						pull_number: prs[0].number,
						title,
						body
					});
					return {
						number: prs[0].number,
						url: prs[0].html_url
					};
				}
			}
			throw err;
		}
	}
	async getPRComments(repoOwner, repoName, prNumber) {
		const [reviewComments, issueComments, reviews] = await Promise.all([
			this.octokit.pulls.listReviewComments({
				owner: repoOwner,
				repo: repoName,
				pull_number: prNumber
			}),
			this.octokit.issues.listComments({
				owner: repoOwner,
				repo: repoName,
				issue_number: prNumber
			}),
			this.octokit.pulls.listReviews({
				owner: repoOwner,
				repo: repoName,
				pull_number: prNumber
			})
		]);
		const inline = reviewComments.data.map((c) => ({
			author: c.user?.login ?? "unknown",
			body: c.body,
			path: c.path ?? null,
			line: c.line ?? null,
			fromApprovedReview: c.reactions?.["+1"] != null && c.reactions["+1"] > 0
		}));
		const general = issueComments.data.filter((c) => c.body).map((c) => ({
			author: c.user?.login ?? "unknown",
			body: c.body,
			path: null,
			line: null,
			fromApprovedReview: false
		}));
		const reviewBodies = reviews.data.filter((r) => r.body).map((r) => ({
			author: r.user?.login ?? "unknown",
			body: r.body,
			path: null,
			line: null,
			fromApprovedReview: r.state === "APPROVED"
		}));
		return [
			...inline,
			...general,
			...reviewBodies
		];
	}
	async getPRConflictStatus(repoOwner, repoName, prNumber) {
		const { data } = await this.octokit.pulls.get({
			owner: repoOwner,
			repo: repoName,
			pull_number: prNumber
		});
		return data.mergeable === false;
	}
	async getFileContent(repoOwner, repoName, path, ref) {
		try {
			const { data } = await this.octokit.repos.getContent({
				owner: repoOwner,
				repo: repoName,
				path,
				ref
			});
			if ("content" in data && data.type === "file") return Buffer.from(data.content, "base64").toString("utf-8");
			return null;
		} catch (err) {
			if (err.status === 404) return null;
			throw err;
		}
	}
};
//#endregion
//#region ../shared/dist/adapters/noop-messaging.js
var NoopMessagingAdapter = class {
	async notify(_userId, _message) {}
	async ping(_userId, _message) {}
};
//#endregion
//#region ../shared/dist/adapters/slack-messaging.js
var import_dist = require_dist();
const logger$4 = createLogger();
var SlackMessagingAdapter = class {
	client;
	defaultChannel;
	constructor(token, defaultChannel) {
		this.client = new import_dist.WebClient(token);
		this.defaultChannel = defaultChannel;
	}
	async notify(_userId, message) {
		try {
			await this.client.chat.postMessage({
				channel: this.defaultChannel,
				text: message
			});
			logger$4.info({ channel: this.defaultChannel }, "slack_notification_sent");
		} catch (err) {
			logger$4.warn({
				error: err instanceof Error ? err.message : "Unknown error",
				channel: this.defaultChannel
			}, "slack_notification_failed");
		}
	}
	async ping(_userId, message) {
		try {
			await this.client.chat.postMessage({
				channel: this.defaultChannel,
				text: message
			});
			logger$4.info({ channel: this.defaultChannel }, "slack_ping_sent");
		} catch (err) {
			logger$4.warn({
				error: err instanceof Error ? err.message : "Unknown error",
				channel: this.defaultChannel
			}, "slack_ping_failed");
		}
	}
};
//#endregion
//#region ../shared/dist/adapters/messaging-factory.js
const logger$3 = createLogger();
function createMessagingAdapter(kind, slackBotToken, slackDefaultChannel) {
	if (kind === "slack") {
		if (!slackBotToken) {
			logger$3.warn("SLACK_BOT_TOKEN not set — notifications disabled");
			return new NoopMessagingAdapter();
		}
		if (!slackDefaultChannel) {
			logger$3.warn("SLACK_DEFAULT_CHANNEL not set — notifications disabled");
			return new NoopMessagingAdapter();
		}
		return new SlackMessagingAdapter(slackBotToken, slackDefaultChannel);
	}
	return new NoopMessagingAdapter();
}
//#endregion
//#region src/env.ts
const appEnv = createEnv$1({
	server: {
		JIRA_WEBHOOK_SECRET: string().min(1),
		PORT: string().default("3000").transform((v) => parseInt(v, 10)).pipe(number().int().positive()),
		MAX_CONCURRENT_AGENTS: string().default("3").transform((v) => parseInt(v, 10)).pipe(number().int().positive()),
		JIRA_BASE_URL: string().url().optional(),
		JIRA_USER_EMAIL: string().email().optional(),
		JIRA_API_TOKEN: string().min(1).optional(),
		JIRA_PROJECT_KEY: string().min(1),
		GITHUB_TOKEN: string().min(1).optional(),
		GITHUB_REPO_OWNER: string().min(1).optional(),
		GITHUB_REPO_NAME: string().min(1).optional(),
		GITHUB_BASE_BRANCH: string().default("main"),
		CLAUDE_CODE_OAUTH_TOKEN: string().min(1),
		CLAUDE_MODEL: string().default("claude-opus-4-6"),
		DOCKER_IMAGE: string().default("blazebot-sandbox"),
		SANDBOX_MEMORY_MB: string().default("4096").transform((v) => parseInt(v, 10)).pipe(number().int().positive()),
		DEVELOPER_MODE: _enum(["true", "false"]).default("false").transform((v) => v === "true"),
		JOB_TIMEOUT_MS: string().default("600000").transform((v) => parseInt(v, 10)).pipe(number().int().positive()),
		POLL_INTERVAL_MS: string().default("300000").transform((v) => parseInt(v, 10)).pipe(number().int().positive()),
		STUCK_JOB_THRESHOLD_MS: string().optional().transform((v) => v ? parseInt(v, 10) : void 0).pipe(number().int().positive().optional())
	},
	runtimeEnv: process.env
});
const docker = new (/* @__PURE__ */ __toESM(require_docker(), 1)).default();
const logger$2 = createLogger();
async function teardownContainer(containerId) {
	logger$2.info({ containerId }, "container_teardown_requested");
	try {
		await docker.getContainer(containerId).kill();
	} catch {}
	try {
		await docker.getContainer(containerId).remove({ force: true });
	} catch {}
}
/**
* Push the feature branch from inside a stopped container.
* Restarts the container with a push-only command, then stops it.
* Must be called before teardownContainer / container removal.
*/
async function pushBranchFromContainer(containerId, branchName) {
	const container = docker.getContainer(containerId);
	try {
		const commitResult = await container.commit({
			repo: "blazebot-push-tmp",
			tag: "latest"
		});
		const pushContainer = await docker.createContainer({
			Image: commitResult.Id ?? "blazebot-push-tmp:latest",
			Entrypoint: ["/bin/bash", "-c"],
			Cmd: [`cd /workspace/repo && /usr/bin/git push origin HEAD:${branchName} 2>&1`],
			User: "blazebot"
		});
		try {
			await pushContainer.start();
			const waitResult = await pushContainer.wait();
			const pushLogs = await readAllContainerLogs(pushContainer);
			const output = sanitizeForLog(pushLogs.stdout + pushLogs.stderr);
			if (waitResult.StatusCode !== 0) {
				logger$2.warn({
					containerId,
					branchName,
					exitCode: waitResult.StatusCode,
					output
				}, "branch_push_failed");
				return {
					pushed: false,
					output
				};
			} else {
				logger$2.info({
					containerId,
					branchName,
					output
				}, "branch_pushed");
				return {
					pushed: true,
					output
				};
			}
		} finally {
			try {
				await pushContainer.remove({ force: true });
			} catch {}
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger$2.warn({
			containerId,
			branchName,
			error: msg
		}, "branch_push_failed");
		return {
			pushed: false,
			output: msg
		};
	}
}
async function runSandbox(options) {
	const tmpDir = await mkdtemp(join(tmpdir(), "blazebot-"));
	await writeFile(join(tmpDir, "requirements.md"), options.requirementsMd);
	let container = null;
	try {
		container = await docker.createContainer({
			Image: options.image,
			Labels: {
				blazebot: "true",
				"blazebot.branch": options.branchName
			},
			Env: [
				`BLAZEBOT_BRANCH=${options.branchName}`,
				`GITHUB_TOKEN=${options.githubToken}`,
				`REPO_URL=${options.repoUrl}`,
				`CLAUDE_CODE_OAUTH_TOKEN=${options.oauthToken}`,
				`CLAUDE_MODEL=${options.model}`,
				`DEVELOPER_MODE=${options.developerMode}`
			],
			HostConfig: {
				Memory: options.memoryLimitMb * 1024 * 1024,
				Binds: [`${tmpDir}:/inject:ro`]
			}
		});
		const startTime = Date.now();
		await container.start();
		logger$2.info({
			containerId: container.id,
			image: options.image,
			branchName: options.branchName
		}, "container_started");
		const waitPromise = container.wait();
		const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(/* @__PURE__ */ new Error("Sandbox timeout exceeded")), options.timeoutMs));
		let exitCode;
		try {
			exitCode = (await Promise.race([waitPromise, timeoutPromise])).StatusCode;
			logger$2.info({
				containerId: container.id,
				exitCode,
				durationMs: Date.now() - startTime
			}, "container_exited");
		} catch {
			logger$2.warn({
				containerId: container?.id,
				timeoutMs: options.timeoutMs
			}, "container_timeout");
			if (container) try {
				await container.kill();
			} catch {}
			return {
				exitCode: -1,
				status: "failed",
				error: "Sandbox timeout exceeded",
				containerId: container?.id
			};
		}
		return await readResult(container, exitCode);
	} catch (err) {
		return {
			exitCode: -1,
			status: "failed",
			error: err instanceof Error ? err.message : "Unknown error",
			containerId: container?.id
		};
	} finally {
		await rm(tmpDir, {
			recursive: true,
			force: true
		});
	}
}
async function cleanupOrphanContainers() {
	try {
		const containers = await docker.listContainers({
			all: true,
			filters: { label: ["blazebot=true"] }
		});
		if (containers.length === 0) {
			logger$2.info("orphan_cleanup_none_found");
			return;
		}
		logger$2.info({ count: containers.length }, "orphan_cleanup_started");
		for (const containerInfo of containers) try {
			await teardownContainer(containerInfo.Id);
			logger$2.info({ containerId: containerInfo.Id }, "orphan_container_removed");
		} catch {
			logger$2.warn({ containerId: containerInfo.Id }, "orphan_container_removal_failed");
		}
		logger$2.info({ removed: containers.length }, "orphan_cleanup_complete");
	} catch (err) {
		logger$2.warn({ error: err instanceof Error ? err.message : "Unknown error" }, "orphan_cleanup_failed");
	}
}
function sanitizeForLog(text) {
	return text.slice(-1e3);
}
/**
* Read all container logs (both stdout and stderr) in a single call,
* then demux the multiplexed stream into separate strings.
*/
async function readAllContainerLogs(container) {
	try {
		const raw = await container.logs({
			stdout: true,
			stderr: true,
			follow: false
		});
		return demuxDockerStream(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "binary"));
	} catch {
		return {
			stdout: "",
			stderr: ""
		};
	}
}
/**
* Docker multiplexed streams have an 8-byte header per frame:
*   byte 0: stream type (0=stdin, 1=stdout, 2=stderr)
*   bytes 4-7: payload length (big-endian uint32)
* We separate frames into stdout and stderr.
* If the buffer doesn't look multiplexed, return everything as stdout.
*/
function demuxDockerStream(buf) {
	if (buf.length < 8) return {
		stdout: buf.toString("utf-8"),
		stderr: ""
	};
	const firstByte = buf[0];
	if (firstByte !== 0 && firstByte !== 1 && firstByte !== 2) return {
		stdout: buf.toString("utf-8"),
		stderr: ""
	};
	const stdoutChunks = [];
	const stderrChunks = [];
	let offset = 0;
	while (offset + 8 <= buf.length) {
		const type = buf[offset];
		if (type !== 0 && type !== 1 && type !== 2) break;
		const len = buf.readUInt32BE(offset + 4);
		if (offset + 8 + len > buf.length) break;
		const text = buf.subarray(offset + 8, offset + 8 + len).toString("utf-8");
		if (type === 1) stdoutChunks.push(text);
		if (type === 2) stderrChunks.push(text);
		offset += 8 + len;
	}
	if (stdoutChunks.length === 0 && stderrChunks.length === 0) return {
		stdout: buf.toString("utf-8"),
		stderr: ""
	};
	return {
		stdout: stdoutChunks.join(""),
		stderr: stderrChunks.join("")
	};
}
/**
* Claude Code with `--output-format json --json-schema <schema>` returns an envelope:
*   { "type": "result", "subtype": "success", "result": "...", "structured_output": { ... } }
* Our agent schema lives in `structured_output`. If `--json-schema` was not honoured
* (older Claude Code, or schema error) we fall back to parsing the envelope `result` field.
*/
function parseAgentOutput(stdout) {
	const lines = stdout.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line.startsWith("{")) continue;
		try {
			const envelope = JSON.parse(line);
			if (envelope.structured_output && typeof envelope.structured_output.result === "string") return envelope.structured_output;
			if (envelope.result && typeof envelope.result === "string" && [
				"implemented",
				"clarification_needed",
				"failed"
			].includes(envelope.result)) return envelope;
		} catch {
			continue;
		}
	}
	return null;
}
async function readResult(container, exitCode) {
	const containerId = container.id;
	const { stdout, stderr } = await readAllContainerLogs(container);
	const output = parseAgentOutput(stdout);
	if (!output) {
		const diagnostic = sanitizeForLog(stderr || stdout) || "(no output captured)";
		logger$2.error({
			containerId,
			exitCode,
			diagnostic
		}, "container_no_structured_output");
		return {
			exitCode,
			status: "failed",
			error: `Agent did not return valid structured JSON output. Container output: ${diagnostic.slice(-500)}`,
			containerId
		};
	}
	switch (output.result) {
		case "implemented": return {
			exitCode,
			status: "complete",
			summary: output.summary ?? "",
			containerId
		};
		case "clarification_needed": return {
			exitCode,
			status: "clarification_needed",
			questions: output.questions ?? [],
			containerId
		};
		default: return {
			exitCode,
			status: "failed",
			error: output.error ?? `Agent returned result: ${output.result}`,
			containerId
		};
	}
}
//#endregion
//#region src/lib/adapters.ts
const PROMPTS_DIR = resolve(process.cwd(), "prompts");
function createAdapters() {
	return {
		jira: new JiraClient(appEnv.JIRA_BASE_URL, appEnv.JIRA_USER_EMAIL, appEnv.JIRA_API_TOKEN),
		github: new GitHubClient(appEnv.GITHUB_TOKEN),
		messaging: createMessagingAdapter(env.MESSAGING_KIND, env.SLACK_BOT_TOKEN, env.SLACK_DEFAULT_CHANNEL)
	};
}
async function readPromptFile(filename) {
	const promptPath = resolve(PROMPTS_DIR, filename);
	try {
		return await readFile(promptPath, "utf-8");
	} catch (err) {
		if (err.code === "ENOENT") throw new Error(`Prompt file not found at ${promptPath}. Ensure the prompts/ directory contains ${filename}.`);
		throw err;
	}
}
//#endregion
//#region src/context.ts
function assembleImplementationContext(ticket, promptFileContent) {
	const lines = [
		"# Requirements",
		"",
		"## Ticket",
		ticket.title,
		"",
		"## Description",
		ticket.description
	];
	if (ticket.acceptanceCriteria) lines.push("", "## Acceptance Criteria", ticket.acceptanceCriteria);
	if (ticket.comments.length > 0) {
		lines.push("", "## Comments");
		for (const comment of ticket.comments) lines.push("", `**${comment.author}** (${comment.createdAt.toISOString()}):`, comment.body);
	}
	lines.push("", "---", promptFileContent);
	return lines.join("\n");
}
function assembleFixingFeedbackContext(ticket, prComments, hasConflicts, promptFileContent) {
	const lines = [
		"# Requirements",
		"",
		"## Ticket",
		ticket.title,
		"",
		"## Description",
		ticket.description
	];
	if (ticket.acceptanceCriteria) lines.push("", "## Acceptance Criteria", ticket.acceptanceCriteria);
	if (ticket.comments.length > 0) {
		lines.push("", "## Comments");
		for (const comment of ticket.comments) lines.push("", `**${comment.author}** (${comment.createdAt.toISOString()}):`, comment.body);
	}
	if (prComments.length > 0) {
		const liked = prComments.filter((c) => c.fromApprovedReview);
		const other = prComments.filter((c) => !c.fromApprovedReview);
		const needsSubheadings = liked.length > 0 && other.length > 0;
		lines.push("", "## PR Review Feedback");
		const formatComment = (c) => {
			const location = c.path ? ` (\`${c.path}${c.line ? `:${c.line}` : ""}\`)` : "";
			lines.push("", `**${c.author}**${location}:`, c.body);
		};
		if (needsSubheadings) {
			lines.push("", "### Liked Comments");
			liked.forEach(formatComment);
			lines.push("", "### Other Comments");
			other.forEach(formatComment);
		} else prComments.forEach(formatComment);
	}
	if (hasConflicts) lines.push("", "## Merge Conflicts", "This PR has merge conflicts with the target branch. Merge the target branch and resolve all conflicts before addressing review feedback.");
	lines.push("", "---", promptFileContent);
	return lines.join("\n");
}
//#endregion
//#region src/workflows/implementation.ts
const logger$1 = createLogger();
function normalize$1(value) {
	return value.trim().toLowerCase();
}
async function implementTicket(ticketId, source, triggeredBy) {
	throw new Error("You attempted to execute workflow implementTicket function directly. To start a workflow, use start(implementTicket) from workflow/api");
}
implementTicket.workflowId = "workflow//./src/workflows/implementation//implementTicket";
async function fetchAndValidateTicket(ticketId) {
	const { jira } = createAdapters();
	const ticket = await jira.fetchTicket(ticketId);
	const colAi = normalize$1(env.COLUMN_AI);
	if (normalize$1(ticket.trackerStatus) !== colAi) {
		logger$1.info({
			ticketId,
			trackerStatus: ticket.trackerStatus
		}, "stale_job_skipped");
		return null;
	}
	return ticket;
}
fetchAndValidateTicket.stepId = "step//./src/workflows/implementation//fetchAndValidateTicket";
async function setupBranch(ticketId, branchName) {
	const { github } = createAdapters();
	const owner = appEnv.GITHUB_REPO_OWNER;
	const repo = appEnv.GITHUB_REPO_NAME;
	const baseBranch = appEnv.GITHUB_BASE_BRANCH;
	await github.createBranch(owner, repo, branchName, baseBranch);
	await db.update(tickets).set({
		workflowState: "implementing",
		updatedAt: /* @__PURE__ */ new Date()
	}).where(eq(tickets.externalId, ticketId));
	logger$1.info({
		ticketId,
		from: "queued",
		to: "implementing"
	}, "ticket_state_transition");
}
setupBranch.stepId = "step//./src/workflows/implementation//setupBranch";
async function createRun(ticketId, branchName) {
	const ticketRow = (await db.select().from(tickets).where(eq(tickets.externalId, ticketId)))[0];
	const [run] = await db.insert(runAttempts).values({
		ticketId: ticketRow.id,
		type: "implementation",
		status: "running",
		branchName
	}).returning();
	await db.update(tickets).set({
		currentRunId: run.id,
		updatedAt: /* @__PURE__ */ new Date()
	}).where(eq(tickets.externalId, ticketId));
	logger$1.info({
		ticketId,
		runId: run.id,
		type: "implementation",
		branchName
	}, "job_started");
	return run;
}
createRun.stepId = "step//./src/workflows/implementation//createRun";
async function executeSandbox(ticketId, branchName, ticket) {
	const requirementsMd = assembleImplementationContext(ticket, await readPromptFile("implement.md"));
	const startTime = Date.now();
	const result = await runSandbox({
		image: appEnv.DOCKER_IMAGE,
		branchName,
		requirementsMd,
		githubToken: appEnv.GITHUB_TOKEN,
		repoUrl: `${appEnv.GITHUB_REPO_OWNER}/${appEnv.GITHUB_REPO_NAME}`,
		oauthToken: appEnv.CLAUDE_CODE_OAUTH_TOKEN,
		model: appEnv.CLAUDE_MODEL,
		timeoutMs: appEnv.JOB_TIMEOUT_MS,
		memoryLimitMb: appEnv.SANDBOX_MEMORY_MB,
		developerMode: appEnv.DEVELOPER_MODE
	});
	const durationMs = Date.now() - startTime;
	logger$1.info({
		ticketId,
		exitCode: result.exitCode,
		containerId: result.containerId,
		durationMs
	}, "agent_exited");
	return result;
}
executeSandbox.stepId = "step//./src/workflows/implementation//executeSandbox";
async function recordContainerId$1(runId, containerId) {
	await db.update(runAttempts).set({ containerId }).where(eq(runAttempts.id, runId));
}
recordContainerId$1.stepId = "step//./src/workflows/implementation//recordContainerId";
async function pushAndTeardown$1(containerId, branchName) {
	try {
		return await pushBranchFromContainer(containerId, branchName);
	} finally {
		await teardownContainer(containerId);
	}
}
pushAndTeardown$1.stepId = "step//./src/workflows/implementation//pushAndTeardown";
async function teardownStep$1(containerId) {
	await teardownContainer(containerId);
}
teardownStep$1.stepId = "step//./src/workflows/implementation//teardownStep";
async function createPullRequest(ticketId, title, branchName, summary) {
	const { github } = createAdapters();
	const owner = appEnv.GITHUB_REPO_OWNER;
	const repo = appEnv.GITHUB_REPO_NAME;
	const baseBranch = appEnv.GITHUB_BASE_BRANCH;
	let pr;
	try {
		pr = await github.createPR(owner, repo, `[${ticketId}] ${title}`, summary, branchName, baseBranch);
	} catch (prErr) {
		const ghErr = prErr;
		logger$1.error({
			status: ghErr.status,
			message: ghErr.message,
			responseData: ghErr.response?.data,
			branchName
		}, "pr_creation_failed");
		if (ghErr.status === 422 && JSON.stringify(ghErr.response?.data ?? "").includes("No commits between")) {
			const { FatalError } = await import("../_libs/_2.mjs");
			throw new FatalError(`No commits on branch ${branchName} — agent completed without committing code`);
		}
		throw prErr;
	}
	logger$1.info({
		ticketId,
		prNumber: pr.number,
		prUrl: pr.url
	}, "pr_created");
	return pr;
}
createPullRequest.stepId = "step//./src/workflows/implementation//createPullRequest";
async function finalizeSuccess(ticketId, runId, branchName, pr, triggeredBy, identifier) {
	const { jira, messaging } = createAdapters();
	await db.update(tickets).set({
		workflowState: "awaiting_review",
		prId: String(pr.number),
		branchName,
		currentRunId: null,
		updatedAt: /* @__PURE__ */ new Date()
	}).where(eq(tickets.externalId, ticketId));
	await db.update(runAttempts).set({
		status: "succeeded",
		finishedAt: /* @__PURE__ */ new Date()
	}).where(eq(runAttempts.id, runId));
	logger$1.info({
		ticketId,
		from: "implementing",
		to: "awaiting_review"
	}, "ticket_state_transition");
	await jira.moveTicket(ticketId, env.COLUMN_AI_REVIEW);
	await messaging.notify(triggeredBy, `Task ${identifier} PR ready for review: ${pr.url}`);
}
finalizeSuccess.stepId = "step//./src/workflows/implementation//finalizeSuccess";
async function finalizeClarification(ticketId, runId, branchName, questions, triggeredBy, identifier) {
	const { jira, messaging } = createAdapters();
	await jira.postComment(ticketId, questions.join("\n\n"));
	logger$1.info({ ticketId }, "clarification_requested");
	await db.update(tickets).set({
		workflowState: "clarification_pending",
		branchName,
		currentRunId: null,
		updatedAt: /* @__PURE__ */ new Date()
	}).where(eq(tickets.externalId, ticketId));
	await db.update(runAttempts).set({
		status: "clarification_needed",
		finishedAt: /* @__PURE__ */ new Date()
	}).where(eq(runAttempts.id, runId));
	logger$1.info({
		ticketId,
		from: "implementing",
		to: "clarification_pending"
	}, "ticket_state_transition");
	await jira.moveTicket(ticketId, env.COLUMN_BACKLOG);
	await messaging.notify(triggeredBy, `Task ${identifier} needs clarification`);
}
finalizeClarification.stepId = "step//./src/workflows/implementation//finalizeClarification";
async function finalizeFailure(ticketId, runId, error) {
	logger$1.error({
		ticketId,
		error
	}, "agent_failed");
	await db.update(runAttempts).set({
		status: "failed",
		error,
		finishedAt: /* @__PURE__ */ new Date()
	}).where(eq(runAttempts.id, runId));
	await db.update(tickets).set({
		workflowState: "failed",
		currentRunId: null,
		updatedAt: /* @__PURE__ */ new Date()
	}).where(eq(tickets.externalId, ticketId));
	logger$1.info({
		ticketId,
		from: "implementing",
		to: "failed"
	}, "ticket_state_transition");
}
finalizeFailure.stepId = "step//./src/workflows/implementation//finalizeFailure";
//#endregion
//#region src/workflows/review-fix.ts
const logger = createLogger();
function normalize(value) {
	return value.trim().toLowerCase();
}
async function reviewFixTicket(ticketId, source, triggeredBy) {
	throw new Error("You attempted to execute workflow reviewFixTicket function directly. To start a workflow, use start(reviewFixTicket) from workflow/api");
}
reviewFixTicket.workflowId = "workflow//./src/workflows/review-fix//reviewFixTicket";
async function validateReviewFix(ticketId) {
	const { jira } = createAdapters();
	const ticket = await jira.fetchTicket(ticketId);
	const colAi = normalize(env.COLUMN_AI);
	if (normalize(ticket.trackerStatus) !== colAi) {
		logger.info({
			ticketId,
			trackerStatus: ticket.trackerStatus
		}, "stale_job_skipped");
		return null;
	}
	const ticketRow = (await db.select().from(tickets).where(eq(tickets.externalId, ticketId)))[0];
	if (!ticketRow.prId || !ticketRow.branchName) throw new FatalError(`review_fix requires prId and branchName for ${ticketId}`);
	return {
		branchName: ticketRow.branchName,
		prNumber: parseInt(ticketRow.prId, 10),
		ticketRowId: ticketRow.id
	};
}
validateReviewFix.stepId = "step//./src/workflows/review-fix//validateReviewFix";
async function createFixRun(ticketId, ticketRowId, branchName, prNumber) {
	await db.update(tickets).set({
		workflowState: "fixing_feedback",
		updatedAt: /* @__PURE__ */ new Date()
	}).where(eq(tickets.externalId, ticketId));
	const [run] = await db.insert(runAttempts).values({
		ticketId: ticketRowId,
		type: "review_fix",
		status: "running",
		branchName
	}).returning();
	await db.update(tickets).set({
		currentRunId: run.id,
		updatedAt: /* @__PURE__ */ new Date()
	}).where(eq(tickets.externalId, ticketId));
	logger.info({
		ticketId,
		runId: run.id,
		type: "review_fix",
		branchName,
		prNumber
	}, "job_started");
	return run;
}
createFixRun.stepId = "step//./src/workflows/review-fix//createFixRun";
async function executeFixSandbox(ticketId, branchName, prNumber) {
	const { jira, github } = createAdapters();
	const owner = appEnv.GITHUB_REPO_OWNER;
	const repo = appEnv.GITHUB_REPO_NAME;
	const ticket = await jira.fetchTicket(ticketId);
	const promptContent = await readPromptFile("review-fix.md");
	const [prComments, hasConflicts] = await Promise.all([github.getPRComments(owner, repo, prNumber), github.getPRConflictStatus(owner, repo, prNumber)]);
	const requirementsMd = assembleFixingFeedbackContext(ticket, prComments, hasConflicts, promptContent);
	const result = await runSandbox({
		image: appEnv.DOCKER_IMAGE,
		branchName,
		requirementsMd,
		githubToken: appEnv.GITHUB_TOKEN,
		repoUrl: `${owner}/${repo}`,
		oauthToken: appEnv.CLAUDE_CODE_OAUTH_TOKEN,
		model: appEnv.CLAUDE_MODEL,
		timeoutMs: appEnv.JOB_TIMEOUT_MS,
		memoryLimitMb: appEnv.SANDBOX_MEMORY_MB,
		developerMode: appEnv.DEVELOPER_MODE
	});
	logger.info({
		ticketId,
		exitCode: result.exitCode,
		containerId: result.containerId
	}, "agent_exited");
	return result;
}
executeFixSandbox.stepId = "step//./src/workflows/review-fix//executeFixSandbox";
async function recordContainerId(runId, containerId) {
	await db.update(runAttempts).set({ containerId }).where(eq(runAttempts.id, runId));
}
recordContainerId.stepId = "step//./src/workflows/review-fix//recordContainerId";
async function pushAndTeardown(containerId, branchName) {
	try {
		await pushBranchFromContainer(containerId, branchName);
	} finally {
		await teardownContainer(containerId);
	}
}
pushAndTeardown.stepId = "step//./src/workflows/review-fix//pushAndTeardown";
async function teardownStep(containerId) {
	await teardownContainer(containerId);
}
teardownStep.stepId = "step//./src/workflows/review-fix//teardownStep";
async function finalizeFixSuccess(ticketId, runId, triggeredBy) {
	const { jira, messaging } = createAdapters();
	const ticket = await jira.fetchTicket(ticketId);
	await db.update(tickets).set({
		workflowState: "awaiting_review",
		currentRunId: null,
		updatedAt: /* @__PURE__ */ new Date()
	}).where(eq(tickets.externalId, ticketId));
	await db.update(runAttempts).set({
		status: "succeeded",
		finishedAt: /* @__PURE__ */ new Date()
	}).where(eq(runAttempts.id, runId));
	await jira.moveTicket(ticketId, env.COLUMN_AI_REVIEW);
	await messaging.notify(triggeredBy, `Task ${ticket.identifier} fixes applied, ready for re-review`);
}
finalizeFixSuccess.stepId = "step//./src/workflows/review-fix//finalizeFixSuccess";
async function finalizeFixFailure(ticketId, runId, error) {
	await db.update(runAttempts).set({
		status: "failed",
		error,
		finishedAt: /* @__PURE__ */ new Date()
	}).where(eq(runAttempts.id, runId));
	await db.update(tickets).set({
		workflowState: "failed",
		currentRunId: null,
		updatedAt: /* @__PURE__ */ new Date()
	}).where(eq(tickets.externalId, ticketId));
}
finalizeFixFailure.stepId = "step//./src/workflows/review-fix//finalizeFixFailure";
//#endregion
export { appEnv as a, parseJiraWebhook as c, createLogger as d, db as f, teardownContainer as i, runAttempts as l, implementTicket as n, createMessagingAdapter as o, env as p, cleanupOrphanContainers as r, JiraClient as s, reviewFixTicket as t, tickets as u };
