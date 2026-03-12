import { Worker, Job } from "bullmq";
import { createRedisConnection } from "./redis.js";
import type { TicketJobData } from "./queue.js";

export function createWorker(): Worker<TicketJobData> {
  return new Worker<TicketJobData>(
    "ticket",
    async (job: Job<TicketJobData>) => {
      console.log(`Processing job ${job.name} with data:`, job.data);
    },
    { connection: createRedisConnection() },
  );
}
