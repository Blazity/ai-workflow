import { Queue } from "bullmq";
import type { JobsOptions } from "bullmq";
import { createRedisConnection } from "./redis.js";
import { env } from "./env.js";

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

export interface CancellationJobData {
  ticketId: string;
  containerId: string;
}

export const defaultJobOptions: JobsOptions = {
  attempts: env.JOB_MAX_RETRIES + 1,
  backoff: {
    type: "exponential",
    delay: env.JOB_BACKOFF_MS,
  },
  removeOnComplete: true,
  removeOnFail: true,
};

export const ticketQueue = new Queue<TicketJobData>("ticket", {
  connection: createRedisConnection(),
  defaultJobOptions,
});

export const cancellationQueue = new Queue<CancellationJobData>("cancellation", {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "fixed", delay: 5000 },
    removeOnComplete: true,
    removeOnFail: true,
  },
});

export const maintenanceQueue = new Queue("maintenance", {
  connection: createRedisConnection(),
});
