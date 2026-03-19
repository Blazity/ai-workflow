import { c as readRawBody, i as defineEventHandler, r as createError, s as getHeader } from "../../_libs/h3+rou3+srvx.mjs";
import { a as eq, i as and } from "../../_libs/drizzle-orm+postgres.mjs";
import { d as tickets, f as createLogger, i as startWorkflowRun, l as parseJiraWebhook, m as env, n as implementTicket, o as appEnv, p as db, r as cancelWorkflowRun, t as reviewFixTicket, u as runAttempts } from "../../_chunks/review-fix.mjs";
import { createHmac, timingSafeEqual } from "node:crypto";
//#region src/lib/jira-signature.ts
function verifyJiraWebhookSignature(rawBody, signature, secret) {
	if (!signature) return false;
	const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
	const provided = signature.replace(/^sha256=/, "");
	if (expected.length !== provided.length) return false;
	return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}
//#endregion
//#region src/lib/webhook-router.ts
const logger$1 = createLogger();
function normalize(value) {
	return value.trim().toLowerCase();
}
async function routeTicketTransition(event) {
	const to = normalize(event.toColumn);
	const from = normalize(event.fromColumn);
	const colAi = normalize(env.COLUMN_AI);
	if (to === colAi) {
		await handleMovedToAi(event);
		return;
	}
	if (from === colAi || isAiRelatedColumn(from)) {
		await handleMovedOutOfAi(event);
		return;
	}
}
function isAiRelatedColumn(col) {
	return [normalize(env.COLUMN_AI), normalize(env.COLUMN_AI_REVIEW)].includes(col);
}
async function handleMovedToAi(event) {
	logger$1.info({
		ticketId: event.ticketId,
		fromColumn: event.fromColumn,
		toColumn: event.toColumn,
		triggeredBy: event.triggeredBy
	}, "webhook_received");
	const ticket = (await db.select().from(tickets).where(and(eq(tickets.externalId, event.ticketId), eq(tickets.source, "jira"))))[0];
	if (!ticket) {
		const [created] = await db.insert(tickets).values({
			externalId: event.ticketId,
			identifier: event.ticketId,
			source: "jira",
			state: event.toColumn,
			workflowState: "queued",
			assignee: event.triggeredBy
		}).onConflictDoNothing({ target: [tickets.externalId, tickets.source] }).returning();
		if (!created) {
			const dup = (await db.select().from(tickets).where(and(eq(tickets.externalId, event.ticketId), eq(tickets.source, "jira"))))[0];
			if (dup?.workflowState === "queued" || dup?.workflowState === "implementing") {
				logger$1.info({
					ticketId: event.ticketId,
					workflowState: dup.workflowState
				}, "duplicate_webhook_ignored");
				return;
			}
			logger$1.info({ ticketId: event.ticketId }, "duplicate_webhook_ignored");
			return;
		}
		await startWorkflowRun({
			ticketRowId: created.id,
			ticketExternalId: event.ticketId,
			type: "implementation",
			workflow: implementTicket,
			workflowArgs: [
				event.ticketId,
				"jira",
				event.triggeredBy
			],
			dedupeId: `impl-${event.ticketId}-${created.id}`
		});
		return;
	}
	if (ticket.workflowState === "clarification_pending") {
		await db.update(tickets).set({
			workflowState: "queued",
			updatedAt: /* @__PURE__ */ new Date()
		}).where(eq(tickets.id, ticket.id));
		await startWorkflowRun({
			ticketRowId: ticket.id,
			ticketExternalId: event.ticketId,
			type: "implementation",
			workflow: implementTicket,
			workflowArgs: [
				event.ticketId,
				"jira",
				event.triggeredBy
			],
			dedupeId: `impl-${event.ticketId}-${ticket.id}`
		});
		return;
	}
	if (ticket.workflowState === "awaiting_review") {
		await db.update(tickets).set({
			workflowState: "queued",
			updatedAt: /* @__PURE__ */ new Date()
		}).where(eq(tickets.id, ticket.id));
		await startWorkflowRun({
			ticketRowId: ticket.id,
			ticketExternalId: event.ticketId,
			type: "review_fix",
			workflow: reviewFixTicket,
			workflowArgs: [
				event.ticketId,
				"jira",
				event.triggeredBy
			],
			dedupeId: `fix-${event.ticketId}-${ticket.id}`
		});
		return;
	}
	if (ticket.workflowState === "queued" || ticket.workflowState === "implementing") {
		logger$1.info({
			ticketId: event.ticketId,
			workflowState: ticket.workflowState
		}, "duplicate_webhook_ignored");
		return;
	}
	if (ticket.workflowState === "failed") {
		await db.update(tickets).set({
			workflowState: "queued",
			updatedAt: /* @__PURE__ */ new Date()
		}).where(eq(tickets.id, ticket.id));
		await startWorkflowRun({
			ticketRowId: ticket.id,
			ticketExternalId: event.ticketId,
			type: "implementation",
			workflow: implementTicket,
			workflowArgs: [
				event.ticketId,
				"jira",
				event.triggeredBy
			],
			dedupeId: `impl-${event.ticketId}-${ticket.id}`
		});
		return;
	}
}
async function handleMovedOutOfAi(event) {
	const ticket = (await db.select().from(tickets).where(and(eq(tickets.externalId, event.ticketId), eq(tickets.source, "jira"))))[0];
	if (!ticket) return;
	const to = normalize(event.toColumn);
	const colAiReview = normalize(env.COLUMN_AI_REVIEW);
	const colBacklog = normalize(env.COLUMN_BACKLOG);
	if (ticket.workflowState === "awaiting_review" && to === colAiReview) {
		logger$1.info({
			ticketId: event.ticketId,
			toColumn: event.toColumn
		}, "self_transition_ignored");
		return;
	}
	if (ticket.workflowState === "clarification_pending" && to === colBacklog) {
		logger$1.info({
			ticketId: event.ticketId,
			toColumn: event.toColumn
		}, "self_transition_ignored");
		return;
	}
	logger$1.info({
		ticketId: event.ticketId,
		fromColumn: event.fromColumn,
		toColumn: event.toColumn
	}, "contradicting_webhook_received");
	if (ticket.currentRunId) {
		const activeRun = (await db.select().from(runAttempts).where(eq(runAttempts.id, ticket.currentRunId)))[0];
		if (activeRun) await cancelWorkflowRun({
			runAttemptId: activeRun.id,
			workflowRunId: activeRun.workflowRunId,
			containerId: activeRun.containerId,
			ticketExternalId: event.ticketId
		});
	}
	await db.update(tickets).set({
		workflowState: "failed",
		state: event.toColumn,
		currentRunId: null,
		updatedAt: /* @__PURE__ */ new Date()
	}).where(eq(tickets.id, ticket.id));
	logger$1.info({
		ticketId: event.ticketId,
		from: ticket.workflowState,
		to: "failed"
	}, "ticket_state_transition");
}
//#endregion
//#region src/routes/webhooks/jira.post.ts
const logger = createLogger();
var jira_post_default = defineEventHandler(async (event) => {
	const rawBodyText = await readRawBody(event, "utf-8");
	if (!rawBodyText) {
		logger.warn({ path: "/webhooks/jira" }, "webhook_validation_failed");
		throw createError({
			statusCode: 401,
			message: "invalid signature"
		});
	}
	const rawSignature = getHeader(event, "x-hub-signature");
	if (!verifyJiraWebhookSignature(Buffer.from(rawBodyText, "utf-8"), rawSignature, appEnv.JIRA_WEBHOOK_SECRET)) {
		logger.warn({ path: "/webhooks/jira" }, "webhook_validation_failed");
		throw createError({
			statusCode: 401,
			message: "invalid signature"
		});
	}
	let body;
	try {
		body = JSON.parse(rawBodyText);
	} catch {
		logger.warn({ path: "/webhooks/jira" }, "webhook_invalid_json");
		throw createError({
			statusCode: 400,
			message: "invalid JSON body"
		});
	}
	const webhookEvent = parseJiraWebhook(body);
	if (webhookEvent) {
		logger.info({
			ticketId: webhookEvent.ticketId,
			type: webhookEvent.type,
			triggeredBy: webhookEvent.triggeredBy
		}, "webhook_received");
		await routeTicketTransition(webhookEvent);
	}
	return { ok: true };
});
//#endregion
export { jira_post_default as default };
