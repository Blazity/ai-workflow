/**
 * `pnpm run new:integration -- <id> [--name "Display Name"]`
 *
 * Copies `integrations/_template` to `integrations/<id>` with the template's
 * names replaced, so what it writes passes the registry generator, the
 * typecheck and the conformance check before anybody edits a line of it. The
 * guide that takes it from there is docs/architecture/integrations.md.
 *
 * It refuses, before writing anything, every id that would pass here and fail
 * later: one the generator cannot register, one the SDK reserves, one an
 * integration already has, and one core source already spells, which the
 * core-reference gate would fail on the first run with no way out for the
 * author but renaming.
 *
 * It installs nothing and regenerates nothing. It prints the commands that do,
 * because both change files outside the new package (the lockfile and the
 * generated registries) and the person running it should see that happen.
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { coreMentions } from "./core-references.mjs";
import { INTEGRATION_ID } from "./generate-integration-registry/types.js";

export interface NewIntegrationOptions {
  /** The repository root: where the template, the SDK and core source are read from. */
  readonly root: string;
  readonly id: string;
  /** What the card, the palette and the sidebar call it. Defaults to the id, capitalised. */
  readonly name?: string;
  /** Where to write. Defaults to `<root>/integrations/<id>`; tests write elsewhere. */
  readonly target?: string;
}

export interface NewIntegrationResult {
  readonly directory: string;
  readonly name: string;
  /** Every file written, relative to `directory`, sorted. */
  readonly files: string[];
}

/**
 * A name goes into a string literal in the manifest and a Markdown heading, so
 * it is held to characters that are safe in both rather than escaped: a name
 * that needs escaping is one nobody will recognise in a sidebar either.
 */
const DISPLAY_NAME = /^[A-Za-z0-9][A-Za-z0-9 .&+-]{0,39}$/u;

/** How many of the files core spells an id in are named in the refusal. */
const MENTIONS_SHOWN = 5;

function refuse(sentence: string): never {
  throw new Error(sentence);
}

async function reservedIds(root: string): Promise<readonly string[]> {
  // The SDK's own list, read from its source at run time rather than copied,
  // so an id reserved later is refused here the day it is reserved.
  const sdk = (await import(pathToFileURL(join(root, "integrations/sdk/index.ts")).href)) as {
    RESERVED_INTEGRATION_IDS: readonly string[];
  };
  return sdk.RESERVED_INTEGRATION_IDS;
}

function templateFiles(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(directory, path));
    }
  };
  walk(directory);
  return found.sort();
}

/**
 * The template's names, and what each becomes. Anchored so that prose keeps
 * its words: `example.com` in a docs URL and "for example" in a comment are
 * not names of the template.
 */
function renames(id: string, name: string): Array<[RegExp, string]> {
  return [
    [/@integrations\/example\b/gu, `@integrations/${id}`],
    [/"example"/gu, `"${id}"`],
    [/\bexample_/gu, `${id}_`],
    [/\bEXAMPLE_/gu, `${id.toUpperCase()}_`],
    [/\bExample\b/gu, name],
  ];
}

const LEFTOVER = /@integrations\/example\b|"example"|\bexample_|\bEXAMPLE_|\bExample\b/u;

export async function createIntegration(options: NewIntegrationOptions): Promise<NewIntegrationResult> {
  const root = resolve(options.root);
  const id = options.id;
  if (!INTEGRATION_ID.test(id)) {
    refuse(
      `"${id}" cannot be an integration id: it must be 3 to 32 lowercase letters and digits, starting with a letter. ` +
        "It names the package, the webhook URL and the screen, and it prefixes every block type, so it has no separator of its own.",
    );
  }
  if ((await reservedIds(root)).includes(id)) {
    refuse(
      `"${id}" is a word core already uses (RESERVED_INTEGRATION_IDS in @integrations/sdk), so conformance would refuse it. Pick another id.`,
    );
  }
  const existing = join(root, "integrations", id);
  const target = resolve(options.target ?? existing);
  for (const directory of new Set([existing, target])) {
    if (existsSync(directory)) {
      refuse(`${relative(root, directory)} already exists. Pick another id, or edit that package instead.`);
    }
  }

  const config = JSON.parse(
    readFileSync(join(root, "scripts/gates/core-references.json"), "utf8"),
  ) as Parameters<typeof coreMentions>[1];
  const spelled = coreMentions(root, config, [id]).map((pair: { path: string }) => pair.path);
  if (spelled.length > 0) {
    const shown = spelled.slice(0, MENTIONS_SHOWN).map((path: string) => `  ${path}`).join("\n");
    const more = spelled.length > MENTIONS_SHOWN ? `\n  and ${spelled.length - MENTIONS_SHOWN} more` : "";
    refuse(
      `core already spells "${id}" in ${spelled.length} file${spelled.length === 1 ? "" : "s"}:\n${shown}${more}\n` +
        "The core-reference gate reads every such spelling in core as core naming your integration, and would fail your first run on each of them. " +
        "Pick an id core does not contain, for example the provider's name with a suffix.",
    );
  }

  const name = options.name ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
  if (!DISPLAY_NAME.test(name)) {
    refuse(
      `"${name}" cannot be the display name: use letters, digits, spaces and . & + -, at most 40 characters, starting with a letter or a digit.`,
    );
  }

  const template = join(root, "integrations/_template");
  const files = templateFiles(template);
  try {
    for (const file of files) {
      cpSync(join(template, file), join(target, file));
    }
    for (const file of files) {
      const path = join(target, file);
      let text = readFileSync(path, "utf8");
      for (const [pattern, replacement] of renames(id, name)) text = text.replace(pattern, replacement);
      if (file === "package.json") {
        const packageJson = JSON.parse(text) as Record<string, unknown>;
        packageJson.description = `${name}: one line on what this integration connects.`;
        text = `${JSON.stringify(packageJson, null, 2)}\n`;
      }
      if (LEFTOVER.test(text)) {
        refuse(`${file} still carries a name of the template after the rename. The template grew a name this script does not know; add it to renames().`);
      }
      writeFileSync(path, text);
    }
  } catch (error) {
    // Half a package is worse than none: the generator refuses a directory
    // under integrations/ that is not a whole integration.
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
  return { directory: target, name, files };
}

function argumentValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const root = resolve(argumentValue(args, "--root") ?? resolve(import.meta.dirname, "../.."));
  const name = argumentValue(args, "--name");
  const flagValues = new Set([argumentValue(args, "--root"), name]);
  const id = args.find((arg) => !arg.startsWith("--") && !flagValues.has(arg));
  if (!id) {
    console.error('Usage: pnpm run new:integration -- <id> [--name "Display Name"]');
    process.exitCode = 1;
    return;
  }
  try {
    const result = await createIntegration({ root, id, ...(name === undefined ? {} : { name }) });
    const at = relative(root, result.directory);
    console.log(`Created ${at} (${result.name}) from integrations/_template:`);
    for (const file of result.files) console.log(`  ${at}/${file}`);
    console.log(
      [
        "",
        "Next, from the repository root:",
        "  pnpm install",
        "  pnpm run gen:integrations",
        `  pnpm --filter @integrations/${id} run typecheck`,
        "  pnpm --filter @integrations/registry run test",
        "  pnpm --dir apps/worker exec vitest run src/services/integrations/connection-shape.test.ts -u",
        "",
        "Then docs/architecture/integrations.md, from \"Make it yours\".",
      ].join("\n"),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, "new-integration.ts")) {
  await main();
}
