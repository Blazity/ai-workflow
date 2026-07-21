/* ───── Unified line diff (LCS-based, no external dep) ───── */
export type DiffLine = { type: "add" | "del" | "ctx"; text: string };

/** Longest-common-subsequence line diff. O(n·m) — fine for prompt-sized bodies. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i++] });
    } else {
      out.push({ type: "add", text: b[j++] });
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

export const DIFF_LINE_STYLE: Record<DiffLine["type"], { bg: string; fg: string; sign: string }> = {
  add: { bg: "#EAF7E0", fg: "#2E5512", sign: "+" },
  del: { bg: "#FCE8E8", fg: "#B42318", sign: "-" },
  ctx: { bg: "transparent", fg: "#5F666F", sign: " " },
};

export function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = diffLines(oldText, newText);
  return (
    <div className="font-mono text-[11px] leading-[1.55]">
      {lines.map((l, idx) => {
        const c = DIFF_LINE_STYLE[l.type];
        return (
          <div key={idx} className="flex gap-2 px-3" style={{ background: c.bg, color: c.fg }}>
            <span className="select-none text-neutral-400">{c.sign}</span>
            <span className="whitespace-pre-wrap break-words flex-1 min-w-0">{l.text || " "}</span>
          </div>
        );
      })}
    </div>
  );
}
