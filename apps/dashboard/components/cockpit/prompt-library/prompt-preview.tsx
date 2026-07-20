import { parseMarkdownBlocks, type InlineNode, type MarkdownBlock } from "@/lib/prompt-library/markdown";

/** Render a run of inline nodes: text (optionally bold), inline code, and
 *  {{variable}} tokens (mariner when known, warn when unknown). */
function InlineRun({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.type === "code") {
          return (
            <code
              key={i}
              className="rounded-[3px] border border-neutral-200 bg-off-white px-1 py-0.5 font-mono text-[11.5px] text-coal"
            >
              {n.value}
            </code>
          );
        }
        if (n.type === "var") {
          return (
            <mark
              key={i}
              className={`rounded-[2px] px-0.5 font-semibold ${
                n.known ? "bg-mariner-100 text-mariner" : "bg-[#FFF4CC] text-[#7A5A00]"
              }`}
            >
              {`{{${n.name}}}`}
            </mark>
          );
        }
        return (
          <span key={i} className={n.bold ? "font-semibold text-neutral-900" : undefined}>
            {n.value}
          </span>
        );
      })}
    </>
  );
}

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.type) {
    case "heading": {
      const Tag = `h${block.level}` as "h1" | "h2" | "h3";
      return (
        <Tag
          className="text-balance text-neutral-900"
        >
          <InlineRun nodes={block.inline} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className="whitespace-pre-wrap break-words text-pretty text-neutral-800">
          <InlineRun nodes={block.inline} />
        </p>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          className={`flex flex-col gap-1 pl-5 text-neutral-800 marker:text-[#8a8ef1] ${
            block.ordered ? "list-decimal" : "list-disc"
          }`}
        >
          {block.items.map((item, i) => (
            <li key={i} className="break-words pl-0.5">
              <InlineRun nodes={item} />
            </li>
          ))}
        </Tag>
      );
    }
    case "code":
      return (
        <pre className="m-0 overflow-x-auto rounded-[4px] border border-neutral-200 bg-off-white p-2.5 font-mono text-[11.5px] leading-[1.6] text-coal">
          <code>{block.value}</code>
        </pre>
      );
  }
}

/** Read-only markdown render of a prompt body: headings, lists, fenced code, and
 *  inline bold/code, with {{variable}} tokens highlighted. Not a full CommonMark
 *  renderer — just the subset prompts use. */
export function PromptPreview({ body, maxHeightClass }: { body: string; maxHeightClass?: string }) {
  const blocks = parseMarkdownBlocks(body);
  const content = (
    <div className="ck-markdown-preview">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );

  if (maxHeightClass) {
    return <div className={`${maxHeightClass} overflow-y-auto`}>{content}</div>;
  }
  return content;
}
