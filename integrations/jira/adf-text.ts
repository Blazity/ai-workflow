/**
 * Jira's rich text (Atlassian Document Format) as the plain text everything
 * downstream reads: the agents' prompts, the acceptance criteria, the
 * repository scan, and the readers of a person's answer in a comment.
 *
 * INLINE NODES MAKE ONE LINE. A paragraph's text runs, mentions, links, emoji,
 * dates and status lozenges are joined as a person reads them, and only a hard
 * break (Shift+Enter) breaks the line. Each text run used to go on a line of
 * its own, so one bold word or one link cut a sentence into four lines.
 *
 * BLOCK NODES MAKE LINES, AND THE SPACING SAYS WHERE A STRUCTURE ENDS.
 * Paragraphs, headings and quotes are joined by one newline. That is how the
 * documents this system writes itself read back unchanged (`postComment` and
 * `createTicket` write one paragraph per line and an empty paragraph for a
 * blank line), and every reader of our own comments depends on it. A heading
 * keeps its level as `#` marks, so a section ends where the next one starts.
 * A list, a table, a code block, a panel, an expand and a rule are set off by a
 * blank line from what is around them, because nothing else in the text says
 * where they end: a description written in Jira's editor has no blank line
 * anywhere, and the criteria under "Acceptance criteria:" ran on into the
 * paragraph after their list and to the end of the description.
 *
 * A BLOCKQUOTE KEEPS ITS MARKER, on every line. Everything downstream that
 * reads a person's words has to tell what they wrote from what they quoted: the
 * repository answer reader drops quoted lines before it decides whether a reply
 * says no (`withoutQuotedText` in `engine/work-scope/answer.ts`), because every
 * sentence this system posts about a repository it left out is built around
 * the word "not". Flattened without the marker, a person clicking Jira's quote
 * button and typing "yes, add it" underneath handed us our own refusal as if it
 * were theirs. "> " is the marker every other channel writes, so one reader
 * knows them all.
 *
 * MARKS: inline code keeps its backticks and struck-out text its `~~`, because
 * both change what the words mean (an identifier; a requirement somebody
 * crossed out). A link keeps its address, which is often the one place a
 * repository or a design is named. Bold, italic, underline and colour carry
 * emphasis only and are dropped.
 *
 * What carries no text is left out: an image, a file, an extension. A comment
 * that is only an image reads as empty, which the answer readers take for no
 * answer (`services/clarifications/answer-authorship.ts`).
 *
 * The node shapes are Atlassian's ADF reference
 * (developer.atlassian.com/cloud/jira/platform/apis/document/structure/) and,
 * for action items, the ADF JSON schema (@atlaskit/adf-schema). A node type
 * this does not know is read through: its content if it has any, nothing if
 * it has none.
 */
export function adfToText(adf: unknown): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  return joinBlocks(blocksOf([adf]));
}

/** One rendered block. `structure` sets it off from its neighbours by a blank
 *  line (see above); a line is joined to its neighbours by one newline. */
interface Block {
  text: string;
  structure: boolean;
}

type Node = {
  type?: unknown;
  text?: unknown;
  attrs?: Record<string, unknown>;
  content?: unknown;
  marks?: unknown;
};

const INLINE_TYPES = new Set([
  "text",
  "hardBreak",
  "mention",
  "emoji",
  "date",
  "status",
  "inlineCard",
  "placeholder",
  "mediaInline",
  "inlineExtension",
]);

const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList", "decisionList"]);

/** Every type `blockOf` renders itself. Named here because some of them carry
 *  no content at all (a rule, a card, an empty paragraph), and without the
 *  name nothing would tell one from an inline node. */
const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  ...LIST_TYPES,
  "codeBlock",
  "table",
  "rule",
  "panel",
  "expand",
  "nestedExpand",
  "blockCard",
  "embedCard",
]);

function asNode(value: unknown): Node | null {
  return value !== null && typeof value === "object" ? (value as Node) : null;
}

function childrenOf(node: Node): unknown[] {
  return Array.isArray(node.content) ? node.content : [];
}

function stringAttr(node: Node, name: string): string {
  const value = node.attrs?.[name];
  return typeof value === "string" ? value : "";
}

/**
 * Inline when it is a node the reference calls inline, a bare text run (the
 * type is sometimes left out), or an unknown node with nothing inside it, which
 * renders as nothing wherever it sits. A block this renders is a block even
 * when it is empty: an empty paragraph is the blank line our own documents
 * write.
 */
function isInline(value: unknown): boolean {
  if (typeof value === "string") return true;
  const node = asNode(value);
  // Not a node at all (null, a number): read inline, where it renders nothing.
  if (!node) return true;
  if (typeof node.type === "string") {
    if (INLINE_TYPES.has(node.type)) return true;
    if (BLOCK_TYPES.has(node.type)) return false;
  }
  if (typeof node.text === "string") return true;
  return !Array.isArray(node.content);
}

/**
 * Sibling nodes as blocks, with each run of inline siblings made one line. A
 * run that renders to nothing (an image inside its media wrapper, an
 * extension) is no line at all, so an image between two paragraphs does not
 * put a blank line between them. An empty paragraph still is one.
 */
function blocksOf(nodes: unknown[]): Block[] {
  const blocks: Block[] = [];
  let run: unknown[] = [];
  const flush = () => {
    const text = inlineText(run);
    if (text !== "") blocks.push({ text, structure: false });
    run = [];
  };
  for (const value of nodes) {
    if (isInline(value)) {
      run.push(value);
      continue;
    }
    flush();
    blocks.push(...blockOf(value as Node));
  }
  flush();
  return blocks;
}

function joinBlocks(blocks: Block[]): string {
  let text = "";
  blocks.forEach((block, index) => {
    if (index > 0) {
      const before = blocks[index - 1]!;
      // A blank line that is already there (an empty paragraph) is not doubled.
      const spaced = (before.structure || block.structure) && before.text !== "" && block.text !== "";
      text += spaced ? "\n\n" : "\n";
    }
    text += block.text;
  });
  return text;
}

/** Blocks inside a list item or a table cell, which never carry blank lines:
 *  one would end the list for whoever reads it. */
function joinTight(blocks: Block[]): string {
  return blocks
    .map((block) => block.text)
    .filter((text) => text !== "")
    .join("\n");
}

function structure(text: string): Block[] {
  return text === "" ? [] : [{ text, structure: true }];
}

function blockOf(node: Node): Block[] {
  const children = childrenOf(node);
  switch (node.type) {
    case "paragraph":
      return [{ text: inlineText(children), structure: false }];
    case "heading": {
      const text = inlineText(children);
      const level = Number(node.attrs?.level);
      const marks = "#".repeat(Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1);
      return [{ text: text.trim() === "" ? "" : `${marks} ${text}`, structure: false }];
    }
    case "blockquote":
      return [
        {
          text: joinBlocks(blocksOf(children))
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
          structure: false,
        },
      ];
    case "bulletList":
    case "orderedList":
    case "taskList":
    case "decisionList":
      return structure(listText(node));
    case "codeBlock": {
      const code = children
        .map((child) => {
          const text = asNode(child)?.text;
          return typeof text === "string" ? text : "";
        })
        .join("");
      return structure(`\`\`\`${stringAttr(node, "language")}\n${code}\n\`\`\``);
    }
    case "table":
      return structure(tableText(node));
    case "rule":
      return structure("---");
    case "panel":
      return structure(joinBlocks(blocksOf(children)));
    case "expand":
    case "nestedExpand": {
      const title = stringAttr(node, "title");
      const body = joinBlocks(blocksOf(children));
      return structure([title, body].filter((part) => part !== "").join("\n"));
    }
    case "blockCard":
    case "embedCard": {
      const url = cardUrl(node);
      return url === "" ? [] : [{ text: url, structure: false }];
    }
    default:
      // A node this does not know, or one whose only job is to hold others
      // (the doc itself, a media group, a bodied extension): its content, as
      // if it stood where the node stands.
      return blocksOf(children);
  }
}

function listText(node: Node): string {
  const ordered = node.type === "orderedList";
  const start = Number(node.attrs?.order);
  let number = ordered && Number.isInteger(start) && start >= 0 ? start : 1;
  const lines: string[] = [];
  for (const value of childrenOf(node)) {
    const item = asNode(value);
    if (!item) continue;
    if (typeof item.type === "string" && LIST_TYPES.has(item.type)) {
      // An action item list nests its sublists directly, not inside an item.
      lines.push(...indent(listText(item), "  "));
      continue;
    }
    const marker = ordered
      ? `${number++}. `
      : item.type === "taskItem"
        ? item.attrs?.state === "DONE"
          ? "- [x] "
          : "- [ ] "
        : "- ";
    const body = joinTight(blocksOf(childrenOf(item)));
    const [first = "", ...rest] = body.split("\n");
    lines.push(`${marker}${first}`, ...indent(rest.join("\n"), " ".repeat(marker.length)));
  }
  return lines.join("\n");
}

function indent(text: string, by: string): string[] {
  if (text === "") return [];
  return text.split("\n").map((line) => (line === "" ? line : `${by}${line}`));
}

/** A row per line, as a Markdown table: a cell's own lines are joined with a
 *  space, and a `|` inside it is escaped so it cannot start a new cell. */
function tableText(node: Node): string {
  const rows = childrenOf(node)
    .map(asNode)
    .filter((row): row is Node => row !== null)
    .map((row) =>
      childrenOf(row)
        .map(asNode)
        .filter((cell): cell is Node => cell !== null),
    )
    .filter((cells) => cells.length > 0);
  const lines: string[] = [];
  rows.forEach((cells, index) => {
    const texts = cells.map((cell) =>
      joinTight(blocksOf(childrenOf(cell)))
        .replace(/\s*\n\s*/g, " ")
        .replace(/\|/g, "\\|")
        .trim(),
    );
    lines.push(`| ${texts.join(" | ")} |`);
    if (index === 0 && cells.every((cell) => cell.type === "tableHeader")) {
      lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
    }
  });
  return lines.join("\n");
}

function inlineText(nodes: unknown[]): string {
  return nodes.map(inlineOf).join("");
}

function inlineOf(value: unknown): string {
  if (typeof value === "string") return value;
  const node = asNode(value);
  if (!node) return "";
  switch (node.type) {
    case "hardBreak":
      return "\n";
    case "mention": {
      // The text carries the "@"; a mention written through the API may have
      // only the account id.
      const text = stringAttr(node, "text");
      const id = stringAttr(node, "id");
      return text !== "" ? text : id !== "" ? `@${id}` : "";
    }
    case "emoji":
      return stringAttr(node, "text") || stringAttr(node, "shortName");
    case "date":
      return dateText(stringAttr(node, "timestamp"));
    case "status":
      return stringAttr(node, "text");
    case "inlineCard":
      return cardUrl(node);
    case "placeholder":
    case "mediaInline":
    case "inlineExtension":
      // A placeholder is the editor's hint, not anybody's words; the others
      // carry a file or an app's content, not text.
      return "";
    default:
      if (typeof node.text === "string") return withMarks(node.text, node.marks);
      return inlineText(childrenOf(node));
  }
}

function withMarks(text: string, marks: unknown): string {
  const list = (Array.isArray(marks) ? marks : []).map(asNode).filter((mark): mark is Node => mark !== null);
  const has = (type: string) => list.some((mark) => mark.type === type);
  let rendered = text;
  if (has("code")) rendered = `\`${rendered}\``;
  if (has("strike")) rendered = `~~${rendered}~~`;
  const link = list.find((mark) => mark.type === "link");
  const href = link ? stringAttr(link, "href") : "";
  if (href !== "" && href !== text) rendered = `[${rendered}](${href})`;
  return rendered;
}

/** A card's address: `url`, or the one inside its JSON-LD `data`. */
function cardUrl(node: Node): string {
  const url = stringAttr(node, "url");
  if (url !== "") return url;
  const data = node.attrs?.data;
  const inner = data !== null && typeof data === "object" ? (data as { url?: unknown }).url : undefined;
  return typeof inner === "string" ? inner : "";
}

/**
 * A date node's day, in UTC, as Jira shows a date without a time. The
 * reference calls the timestamp Unix time, and the editor writes milliseconds,
 * so a value below 10^11 (the year 5138 in seconds) is read as seconds. Text
 * that is not a number is passed through rather than dropped.
 */
function dateText(timestamp: string): string {
  const value = Number(timestamp);
  if (timestamp.trim() === "" || !Number.isFinite(value)) return timestamp;
  const date = new Date(Math.abs(value) < 1e11 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? timestamp : date.toISOString().slice(0, 10);
}
