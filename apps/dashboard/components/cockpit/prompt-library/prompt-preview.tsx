import { segmentTemplate } from "@/lib/prompt-library/variables";

/** Read-only render of a prompt body with {{variable}} tokens highlighted.
 *  Known tokens use the mariner accent; unknown tokens use the warn palette. */
export function PromptPreview({ body, maxHeightClass }: { body: string; maxHeightClass?: string }) {
  const content = (
    <div className="font-mono text-[11px] leading-[1.55] whitespace-pre-wrap break-words">
      {segmentTemplate(body).map((seg, i) =>
        seg.kind === "text" ? (
          seg.text
        ) : (
          <mark
            key={i}
            className={
              seg.known
                ? "bg-mariner-100 text-mariner font-semibold rounded-[2px] px-0.5"
                : "bg-[#FFF4CC] text-[#7A5A00] font-semibold rounded-[2px] px-0.5"
            }
          >
            {`{{${seg.name}}}`}
          </mark>
        ),
      )}
    </div>
  );

  if (maxHeightClass) {
    return <div className={`${maxHeightClass} overflow-y-auto`}>{content}</div>;
  }
  return content;
}
