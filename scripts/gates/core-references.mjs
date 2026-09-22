/**
 * Core names no provider.
 *
 * An integration owns its provider's name: its adapters, its environment
 * variables, its block types, its webhook route. Core asks the generated
 * registry which integrations exist and what they declare, and never writes
 * "github" or "jira" itself. This gate holds that line for the names that have
 * already moved out and for the ones still on their way.
 *
 * It fails on a mention of a watched id in core source that no allowlist row
 * covers, and on a row whose file no longer mentions the id, so the list only
 * ever shrinks. `--prune` removes the rows that went stale, which is what a
 * stage that moves a provider out runs; nothing adds a row but a person, with
 * a reason, because a mode that adds rows is a mode that switches the gate off.
 *
 * What counts as core, what counts as a mention, and why each exclusion is
 * there: scripts/gates/core-references.json, and ADR-010.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  parseOptions,
  printTable,
  readJson,
  repositoryRoot,
  requireAnchor,
  requireScan,
} from "./shared.mjs";

const INVARIANT = "the rule that core names no provider";
const CONFIG = fileURLToPath(new URL("./core-references.json", import.meta.url));
const SOURCE = /\.[cm]?[jt]sx?$/;

function slash(path) {
  return path.split(sep).join("/");
}

/** Attributes whose text only a browser's style engine reads. */
const PRESENTATION_ATTRIBUTES = new Set(["className", "style"]);

function scriptKind(path) {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].some((extension) => path.endsWith(extension))) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Whether a literal's value ends up as the text of a `className` or `style`
 * attribute and nowhere else: passed through parentheses, casts, template
 * pieces, `+`, the branches of a conditional, arrays and object literals, and
 * nothing that compares it. `ease-linear` and `linear-gradient(...)` are CSS,
 * while `kind === "linear"` inside the same attribute is core branching on a
 * name, so the walk stops at the first node that does anything but carry the
 * value along.
 */
function isPresentation(literal) {
  let child = literal;
  for (let parent = literal.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isJsxAttribute(parent)) {
      return ts.isIdentifier(parent.name) && PRESENTATION_ATTRIBUTES.has(parent.name.text);
    }
    const carries =
      ts.isJsxExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTemplateExpression(parent) ||
      ts.isTemplateSpan(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      (ts.isConditionalExpression(parent) && child !== parent.condition) ||
      (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken);
    if (!carries) return false;
  }
  return false;
}

/**
 * What a core file spells, one piece per identifier, string, template or
 * regular expression literal, and piece of JSX text.
 *
 * Comments are prose: a sentence that mentions GitHub is not code that depends
 * on GitHub, and a gate that fires on one is a gate the next stage turns off.
 * The TypeScript parser decides what a comment is, so a `//` inside a URL, a
 * `/*` inside a glob and a slash inside a regular expression stay code.
 * Everything else counts, string literals and identifiers alike, because
 * `"github"`, `GITHUB_TOKEN` and `githubClient` are the same coupling written
 * three ways, and words a person reads on a page are core naming the provider
 * to that person. The one exemption is presentation (`isPresentation`), because
 * a CSS keyword that happens to spell an id is not a dependency on anything.
 */
export function spelledPieces(source, path = "source.ts") {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  // What a file that does not parse spells is a guess, and a gate that guessed
  // could pass a provider name the error recovery happened to drop.
  if (file.parseDiagnostics.length > 0) {
    throw new Error(`${path} does not parse, so what it spells is unproven: ${ts.flattenDiagnosticMessageText(file.parseDiagnostics[0].messageText, " ")}`);
  }
  const pieces = [];
  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
        if (!isPresentation(node)) pieces.push(node.text);
        break;
      case ts.SyntaxKind.Identifier:
      case ts.SyntaxKind.PrivateIdentifier:
      case ts.SyntaxKind.JsxText:
        pieces.push(node.text);
        break;
      case ts.SyntaxKind.RegularExpressionLiteral:
        // An escape is punctuation here: `\bgithub_pat_` spells github, not
        // "bgithub".
        pieces.push(node.text.replace(/\\./gu, " "));
        break;
      default:
        break;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return pieces;
}

/**
 * The words one piece of code is written in, lowercased: split at anything
 * that is not a letter or a digit, and where a lowercase letter or a digit
 * meets a capital (`githubClient`, `GitHub`) or a run of capitals meets a
 * capitalised word (`JSONParser`). Digits stay with the letters before them,
 * so `mem0` is one word.
 */
function wordsOf(piece) {
  return piece
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/**
 * What counts as core spelling a provider id, in one sentence. The gate prints
 * it with every failure, the scaffold with every refusal, and the integration
 * guide quotes it (a test holds the guide to these words), so the rule a
 * person is told is the rule `mentions` applies.
 */
export const MENTION_RULE =
  "Core spells a provider id where a word starts with it, in any case, in a file's path or in one identifier, string, template, regular expression or piece of JSX text; words split at punctuation and at case changes, so GITHUB_TOKEN, githubClient, GitHub, jira-client and mem0ai each spell their id, while the letters sEntry inside scriptsEntry spell nothing. Comments and the text of a className or style attribute are not read.";

/**
 * Whether a word of one piece starts with the id, the id possibly running
 * across consecutive words (`git hub App`) and into the letters that follow
 * (`mem0ai`, `notionhq`, `githubusercontent`): a provider's own package and the
 * names built from it are the most direct coupling there is. A word that
 * merely contains the id (`scriptsEntry` holds `sentry` across its two words
 * only by accident) is not a mention, and a gate that failed on it would
 * refuse an integration over a word core never wrote. Words never join across
 * two pieces, so an identifier and the string beside it cannot spell an id
 * between them.
 */
export function mentions(pieces, id) {
  return pieces.some((piece) => {
    const words = wordsOf(piece);
    for (let start = 0; start < words.length; start += 1) {
      let joined = "";
      for (let end = start; end < words.length; end += 1) {
        joined += words[end];
        if (joined.length >= id.length) {
          if (joined.startsWith(id)) return true;
          break;
        }
      }
    }
    return false;
  });
}

/** What the gate reads as core, derived from the config rather than restated. */
export function describeCore(config) {
  return `Core is ${config.coreRoots.join(", ")}, as git lists them, minus every path matching an \`exclude\` pattern in scripts/gates/core-references.json.`;
}

/**
 * The files under the core roots that a commit could carry: tracked, or new
 * and not ignored, as git lists them. Ignored build output (`.vercel/output`,
 * `.next`, a coverage report) is bundled code that names every provider a
 * build ships, and no allowlist row could ever describe it. Null when the root
 * is not inside a git work tree, which is a gate test's fixture.
 */
function gitListedFiles(root, coreRoots) {
  const inside = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return null;
  const listed = spawnSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...coreRoots],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (listed.status !== 0) {
    throw new Error(`git ls-files could not list the core roots, so ${INVARIANT} is unproven: ${listed.stderr.trim()}`);
  }
  return listed.stdout
    .split("\0")
    .filter(Boolean)
    .map(slash)
    // `--cached` still lists a tracked file deleted in the working tree.
    .filter((path) => existsSync(join(root, path)));
}

/** Every source file this gate reads as core, repository-relative and sorted. */
export function coreFiles(root, config) {
  const excluded = config.exclude.map((pattern) => new RegExp(pattern));
  const isCore = (path) => SOURCE.test(path) && !excluded.some((pattern) => pattern.test(path));
  for (const coreRoot of config.coreRoots) {
    requireAnchor(root, coreRoot, "a core root this gate scans", INVARIANT);
  }
  const listed = gitListedFiles(root, config.coreRoots);
  if (listed) return listed.filter(isCore).sort();

  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (["node_modules", ".next", ".output", ".nitro", ".vercel", "dist"].includes(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && isCore(path)) found.push(path);
    }
  };
  for (const coreRoot of config.coreRoots) {
    const absolute = join(root, coreRoot);
    if (statSync(absolute).isDirectory()) visit(slash(relative(root, absolute)));
  }
  return found.sort();
}

/** Every `<path, id>` in core, whatever the allowlist says about it. A file
 *  whose path spells the id counts as well as one whose code does. */
export function coreMentions(root, config, ids) {
  const pairs = [];
  for (const path of coreFiles(root, config)) {
    const pieces = [path, ...spelledPieces(readFileSync(join(root, path), "utf8"), path)];
    for (const id of ids) if (mentions(pieces, id)) pairs.push({ path, id });
  }
  return pairs;
}

/** One key per `<path, id>`, readable back with JSON.parse. */
function pairKey(path, id) {
  return JSON.stringify([path, id]);
}

/**
 * The mentions no allowlist row covers: what fails this gate once `ids` are
 * watched. The scaffold asks the same question about an id before it writes a
 * package, so the two cannot disagree about what counts.
 */
export function unlistedMentions(root, config, ids) {
  return withoutRows(coreMentions(root, config, ids), allowed(config));
}

function withoutRows(pairs, rows) {
  return pairs.filter(({ path, id }) => !rows.has(pairKey(path, id)));
}

function allowed(config) {
  const map = new Map();
  for (const row of config.allowlist) {
    for (const id of row.ids) {
      for (const path of row.paths) map.set(pairKey(path, id), row);
    }
  }
  return map;
}

/**
 * The ids this build ships, asked of the generator rather than kept here, so
 * the gate cannot watch a different set from the one the registry holds.
 * Fixtures are left out on purpose: `demo` is a word core uses about
 * deployments, and a fixture is not a provider core has to stop naming.
 */
function shippedIntegrationIds(root) {
  // Run this repository's generator against whatever root is being scanned,
  // rather than a copy inside it: a fixture root carries no node_modules, and a
  // second copy of the generator would be a second answer to the same question.
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(repositoryRoot, "scripts/gates/generate-integration-registry.ts"),
      "--root",
      root,
      "--print-ids",
    ],
    { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, INTEGRATION_FIXTURES: "" } },
  );
  if (result.status !== 0) {
    throw new Error(
      `the integration registry generator could not list the integrations, so ${INVARIANT} is unproven: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function prune(config, pairs) {
  const live = new Set(pairs.map(({ path, id }) => pairKey(path, id)));
  const pruned = config.allowlist
    // Incidental rows are left alone: they are exempt from the stale check, so
    // pruning them would quietly hand back the noise they exist to absorb.
    .map((row) => (row.incidental === true ? row : {
      ...row,
      paths: row.paths.filter((path) => row.ids.some((id) => live.has(pairKey(path, id)))),
    }))
    .filter((row) => row.paths.length > 0);
  return { ...config, allowlist: pruned };
}

function main() {
  const options = parseOptions(process.argv.slice(2).filter((argument) => argument !== "--prune"), {
    "--root": "root",
    "--config": "config",
  });
  const configPath = options.config ?? CONFIG;
  requireAnchor(options.root, configPath, "the allowlist this gate reads", INVARIANT);
  const config = readJson(configPath);

  const shipped = shippedIntegrationIds(options.root);
  const planned = Object.keys(config.plannedIntegrations);
  const both = shipped.filter((id) => planned.includes(id));
  const ids = [...new Set([...shipped, ...planned])].sort();
  requireScan(ids.length, "integration ids", "the registry and the planned list", INVARIANT);

  const pairs = coreMentions(options.root, config, ids);
  const rows = allowed(config);
  const unlisted = withoutRows(pairs, rows);
  const live = new Set(pairs.map(({ path, id }) => pairKey(path, id)));
  const stale = [...rows.entries()]
    // An incidental row covers a hit that is not the provider at all, such as a
    // CSS keyword or a URL that happens to spell one. Those come and go with
    // ordinary edits, and a stale failure on one would be unfixable noise.
    .filter(([key, row]) => !live.has(key) && row.incidental !== true)
    .map(([key]) => key)
    .map((key) => JSON.parse(key))
    .sort();

  if (process.argv.includes("--prune")) {
    writeFileSync(configPath, `${JSON.stringify(prune(config, pairs), null, 2)}\n`);
    console.log(`pruned ${stale.length} row(s) that no longer name their provider`);
    return;
  }

  console.log("Provider names in core");
  printTable(
    ["id", "stage", "allowlisted", "unlisted"],
    ids.map((id) => [
      id,
      config.plannedIntegrations[id]?.stage ?? "shipped",
      pairs.filter((pair) => pair.id === id).length - unlisted.filter((pair) => pair.id === id).length,
      unlisted.filter((pair) => pair.id === id).length,
    ]),
  );

  for (const id of both) {
    console.log(
      `${id} is both an integration and a planned one. Delete its plannedIntegrations entry and its allowlist rows: the integration owns the name now.`,
    );
  }
  if (unlisted.length > 0) console.log(`${MENTION_RULE} ${describeCore(config)}`);
  for (const { path, id } of unlisted) {
    const stage = config.plannedIntegrations[id]?.stage;
    console.log(
      `${path} names "${id}". ${
        stage
          ? `That name belongs to the ${id} integration, which ${stage} delivers; until then core keeps it only where the allowlist already says so.`
          : `The ${id} integration owns that name: ask @integrations/registry instead of writing it here.`
      } If this file is not about the provider, add it to scripts/gates/core-references.json with the reason.`,
    );
  }
  for (const [path, id] of stale) {
    console.log(
      `${path} no longer names "${id}", so its allowlist row is stale. Run pnpm run gate:core-references -- --prune.`,
    );
  }

  const failed = unlisted.length > 0 || stale.length > 0 || both.length > 0;
  console.log(
    failed
      ? "core-references FAIL"
      : `core-references PASS: ${pairs.length} allowlisted mention(s) of ${ids.length} provider name(s) across ${config.coreRoots.join(", ")}`,
  );
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && slash(process.argv[1]).endsWith("core-references.mjs")) {
  try {
    main();
  } catch (error) {
    console.error(`core-references FAIL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
