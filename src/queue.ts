import { Queue } from "bullmq";
import { createRedisConnection } from "./redis.js";

export type TicketJobData = {
  ticketId: string;
};
// Will evolve into a discriminated union per job type in future phases
// (e.g., review-fix may need pullRequestId, clarify may need questionIds)

export const ticketQueue = new Queue<TicketJobData>("ticket", {
  connection: createRedisConnection(),
});
