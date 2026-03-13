import { Queue } from "bullmq";
import { createRedisConnection } from "./redis.js";

export type TicketJobData =
  | {
      type: "implementation";
      ticketId: string;
      source: "jira" | "linear";
      triggeredBy: string;
    }
  | {
      type: "review_fix";
      ticketId: string;
      source: "jira" | "linear";
      triggeredBy: string;
    };

export const ticketQueue = new Queue<TicketJobData>("ticket", {
  connection: createRedisConnection(),
});
