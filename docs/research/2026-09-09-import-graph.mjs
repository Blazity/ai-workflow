// Computes directory-level import graph for apps/worker/src, apps/dashboard/src, apps/shared.
// Usage: node import-graph.mjs <repoRoot>
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const targets = [
  { name: "worker", base: path.join(root, "apps/worker/src") },
  { name: "dashboard", base: path.join(root, "apps/dashboard/src") },
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const importRe = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

for (const t of targets) {
  if (!fs.existsSync(t.base)) continue;
  const files = walk(t.base);
  const edges = new Map(); // "from->to" -> count
  const external = new Map(); // pkg -> count
  const fileCount = new Map();
  const testEdges = new Map();
  for (const f of files) {
    const rel = path.relative(t.base, f);
    const fromDir = rel.includes(path.sep) ? rel.split(path.sep)[0] : "(root)";
    fileCount.set(fromDir, (fileCount.get(fromDir) ?? 0) + 1);
    const isTest = /\.test\.tsx?$/.test(f);
    const src = fs.readFileSync(f, "utf8");
    let m;
    while ((m = importRe.exec(src))) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      if (spec.startsWith(".")) {
        const abs = path.resolve(path.dirname(f), spec);
        const relTo = path.relative(t.base, abs);
        if (relTo.startsWith("..")) {
          const key = `${fromDir}->(outside:${relTo.split(path.sep).slice(0, 3).join("/")})`;
          (isTest ? testEdges : edges).set(key, ((isTest ? testEdges : edges).get(key) ?? 0) + 1);
          continue;
        }
        const toDir = relTo.includes(path.sep) ? relTo.split(path.sep)[0] : "(root)";
        if (toDir === fromDir) continue;
        const key = `${fromDir}->${toDir}`;
        (isTest ? testEdges : edges).set(key, ((isTest ? testEdges : edges).get(key) ?? 0) + 1);
      } else if (spec.startsWith("@shared/") || spec.startsWith("@ai-workflow/") || spec.startsWith("~") || spec.startsWith("@/")) {
        const key = `${fromDir}->${spec.split("/").slice(0, 2).join("/")}`;
        (isTest ? testEdges : edges).set(key, ((isTest ? testEdges : edges).get(key) ?? 0) + 1);
      } else {
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        external.set(pkg, (external.get(pkg) ?? 0) + 1);
      }
    }
  }
  console.log(`\n===== ${t.name} : ${files.length} files =====`);
  console.log("--- files per top-level dir ---");
  for (const [d, c] of [...fileCount].sort((a, b) => b[1] - a[1])) console.log(`${d}: ${c}`);
  console.log("--- non-test import edges (from->to: count), sorted ---");
  for (const [k, c] of [...edges].sort((a, b) => b[1] - a[1])) console.log(`${k}: ${c}`);
  // fan-in / fan-out per dir
  const fanIn = new Map(), fanOut = new Map();
  for (const k of edges.keys()) {
    const [a, b] = k.split("->");
    fanOut.set(a, (fanOut.get(a) ?? 0) + 1);
    fanIn.set(b, (fanIn.get(b) ?? 0) + 1);
  }
  console.log("--- fan-in (how many dirs depend on X) ---");
  for (const [d, c] of [...fanIn].sort((a, b) => b[1] - a[1])) console.log(`${d}: ${c}`);
  console.log("--- fan-out (how many dirs X depends on) ---");
  for (const [d, c] of [...fanOut].sort((a, b) => b[1] - a[1])) console.log(`${d}: ${c}`);
  // cycles (2-cycles)
  console.log("--- 2-cycles (A->B and B->A) ---");
  const seen = new Set();
  for (const k of edges.keys()) {
    const [a, b] = k.split("->");
    if (edges.has(`${b}->${a}`) && !seen.has(`${b}->${a}`)) {
      seen.add(k);
      console.log(`${a} <-> ${b} (${edges.get(k)} / ${edges.get(`${b}->${a}`)})`);
    }
  }
  console.log("--- top external packages ---");
  for (const [p, c] of [...external].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${p}: ${c}`);
}
