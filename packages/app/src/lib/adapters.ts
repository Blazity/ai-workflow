import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  env,
  JiraClient,
  GitHubClient,
  createMessagingAdapter,
} from "@blazebot/shared";
import { appEnv } from "../env.js";

const PROMPTS_DIR = resolve(process.cwd(), "prompts");

export function createAdapters() {
  const jira = new JiraClient(
    appEnv.JIRA_BASE_URL!,
    appEnv.JIRA_USER_EMAIL!,
    appEnv.JIRA_API_TOKEN!,
  );
  const github = new GitHubClient(appEnv.GITHUB_TOKEN!);
  const messaging = createMessagingAdapter(
    env.MESSAGING_KIND,
    env.SLACK_BOT_TOKEN,
    env.SLACK_DEFAULT_CHANNEL,
  );
  return { jira, github, messaging };
}

export async function readPromptFile(filename: string): Promise<string> {
  const promptPath = resolve(PROMPTS_DIR, filename);
  try {
    return await readFile(promptPath, "utf-8");
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      throw new Error(
        `Prompt file not found at ${promptPath}. Ensure the prompts/ directory contains ${filename}.`,
      );
    }
    throw err;
  }
}
