export function buildCommitGuardCheckScript(opts: {
  manifestPath: string;
  ignoredDirs: string[];
}): string {
  const ignoredPattern = opts.ignoredDirs
    .map((dir) => dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .map((dir) => `^.. ${dir}/|^\\?\\? ${dir}/`)
    .join("|");

  return [
    `if [ -f '${opts.manifestPath}' ]; then`,
    "  changes=$(node <<'NODE'",
    "const fs = require('fs');",
    "const cp = require('child_process');",
    `const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(opts.manifestPath)}, 'utf8'));`,
    `const ignored = ${JSON.stringify(opts.ignoredDirs)};`,
    "const changed = [];",
    "for (const repo of manifest.repositories || []) {",
    "  const out = cp.execFileSync('git', ['-C', repo.localPath, 'status', '--porcelain'], { encoding: 'utf8' });",
    "  const lines = out.split('\\n').filter((line) => {",
    "    if (!line.trim()) return false;",
    "    return !ignored.some((dir) => line.startsWith(`?? ${dir}/`) || line.slice(3).startsWith(`${dir}/`));",
    "  });",
    "  if (lines.length) changed.push(`${repo.repoPath}\\n${lines.join('\\n')}`);",
    "}",
    "process.stdout.write(changed.join('\\n'));",
    "NODE",
    "  )",
    "else",
    `  changes=$(git status --porcelain | grep -v -E '${ignoredPattern}' || true)`,
    "fi",
  ].join("\n");
}
