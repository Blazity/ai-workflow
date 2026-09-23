import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { attributionsOf, DEFAULT_REPOSITORY, parseChangelog, planBullets, type ChangelogEntry } from "./collate.ts";
import {
  listTags,
  pullRequestAuthors,
  runCommand,
  traceEntries,
  UNRELEASED_DIR,
  type CommandRunner,
} from "./history.ts";
import { parseChangelogSection, renderReleaseBody, type ReleaseNotes } from "./notes.ts";
import { previousVersion } from "./version.ts";

/**
 * The release job: once a collation's section is on main, tag the main
 * commit that collation read and publish the GitHub Release. It is idempotent,
 * so every trigger (the push that lands the section, the daily schedule, a
 * manual dispatch) may run it: a version that already has its release is left
 * alone, and a tag without a release gets its release.
 */

export interface PublishPlan {
  version: string;
  /** The main commit the collation read; the tag points here. */
  target: string;
  body: string;
  /** "create" tags and releases; "release-only" the tag exists already; "done" nothing is left. */
  action: "create" | "release-only" | "done";
}

/** The newest release section of CHANGELOG.md, if the file has one at the top. */
export function newestRelease(changelog: string): ReleaseNotes | undefined {
  const newest = parseChangelog(changelog).sections[0];
  return newest ? parseChangelogSection([newest.heading, ...newest.lines]) : undefined;
}

export async function planPublish(options: {
  root: string;
  repository: string;
  run?: CommandRunner;
  log?: (message: string) => void;
}): Promise<PublishPlan | undefined> {
  const run = options.run ?? runCommand;
  const log = options.log ?? ((message: string) => console.error(message));
  const git = async (...args: string[]) => (await run("git", args, options.root)).trim();

  const notes = newestRelease(await readFile(resolve(options.root, "CHANGELOG.md"), "utf8"));
  if (!notes) return undefined;
  const { version } = notes;

  const tags = await listTags(options.root, run);
  let released = false;
  if (tags.includes(version)) {
    try {
      await run("gh", ["release", "view", version, "--repo", options.repository, "--json", "tagName"], options.root);
      released = true;
    } catch {
      log(`changelog: ${version} is tagged but has no GitHub Release yet`);
    }
  }

  // The commit that wrote the heading is the collation commit; its first
  // parent is the main commit the collation read, and the entries it
  // deleted are exactly the ones this release collected.
  const collation = await git("log", "-1", "--format=%H", "-S", `## ${version} (`, "--", "CHANGELOG.md");
  if (!collation) throw new Error(`publish: no commit wrote the ${version} heading into CHANGELOG.md`);
  const target = await git("rev-parse", `${collation}^1`);
  const fileNames = (await git("diff", "--name-only", "--diff-filter=D", target, collation, "--", `${UNRELEASED_DIR}/`))
    .split("\n")
    .filter((path) => path.endsWith(".md"))
    .map((path) => path.slice(UNRELEASED_DIR.length + 1));
  const entries: ChangelogEntry[] = await Promise.all(
    fileNames.map(async (fileName) => ({
      content: await git("show", `${target}:${UNRELEASED_DIR}/${fileName}`),
      fileName,
    })),
  );

  const bullets = planBullets(entries, await traceEntries({ fileNames, ref: target, root: options.root, run }));
  const pulls = bullets.flatMap((bullet) => (bullet.pullRequest === undefined ? [] : [bullet.pullRequest]));
  const attributions = attributionsOf(
    bullets,
    await pullRequestAuthors({ log, numbers: pulls, repository: options.repository, root: options.root, run }),
  );
  const unattributed = notes.areas.flatMap((area) => area.bullets).filter((bullet) => !attributions.has(bullet));
  if (unattributed.length > 0) log(`changelog: ${unattributed.length} bullet(s) of ${version} carry no pull request link`);

  const body = renderReleaseBody(notes, {
    attributions,
    previousVersion: previousVersion(version, tags),
    repository: options.repository,
  });
  return { action: released ? "done" : tags.includes(version) ? "release-only" : "create", body, target, version };
}

export async function publish(plan: PublishPlan, options: { root: string; repository: string; run?: CommandRunner }): Promise<void> {
  if (plan.action === "done") return;
  const run = options.run ?? runCommand;
  const dir = await mkdtemp(join(tmpdir(), "release-notes-"));
  try {
    const notesFile = join(dir, "body.md");
    await writeFile(notesFile, plan.body);
    const args = ["release", "create", plan.version, "--repo", options.repository, "--title", plan.version, "--notes-file", notesFile];
    if (plan.action === "create") args.push("--target", plan.target);
    await run("gh", args, options.root);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const index = argv.indexOf("--root");
  const root = resolve(index === -1 ? resolve(import.meta.dirname, "../..") : argv[index + 1]);
  const repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
  const dryRun = argv.includes("--dry-run");

  const plan = await planPublish({ repository, root });
  if (!plan) {
    console.log("changelog: CHANGELOG.md has no release section at the top, nothing to publish");
    return;
  }
  if (plan.action === "done") {
    console.log(`changelog: ${plan.version} is already released, nothing to do`);
    return;
  }
  if (dryRun) {
    console.log(`changelog: would ${plan.action === "create" ? "tag" : "release the existing tag"} ${plan.version} at ${plan.target}\n`);
    console.log(plan.body);
    console.log("changelog: dry run, nothing was tagged or released");
    return;
  }
  await publish(plan, { repository, root });
  console.log(`changelog: released ${plan.version} at ${plan.target}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
