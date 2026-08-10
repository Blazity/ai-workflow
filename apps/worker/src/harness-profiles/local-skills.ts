import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join, posix, relative, resolve } from "node:path";
import type {
  HarnessLocalSkillDiscoveryResponse,
  HarnessLocalSkillSelection,
  HarnessLocalSkillSource,
  HarnessSkillArtifact,
  HarnessSkillArtifactFile,
} from "@shared/contracts";
import {
  HARNESS_SKILL_IMPORT_LIMITS,
  isHarnessGitHubSkillSource,
} from "@shared/contracts";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { harnessSkillArtifacts } from "../db/schema.js";
import {
  HarnessSkillImportError,
  persistHarnessSkillArtifacts,
} from "./github-skills.js";
import {
  hashHarnessSkillArtifact,
  HarnessSkillArtifactIntegrityError,
  parseHarnessSkillMetadata,
} from "./skill-artifact.js";
import { readHarnessSkillArtifactSource } from "./store.js";

/**
 * Skills shipped by the deployment itself live in `skills/` at the repository
 * root, the first container the GitHub importer looks in, so one layout stays
 * legible to both paths. The Nitro `compiled` hook copies that directory into
 * every function bundle, which is why the runtime resolves it against the
 * process working directory the same way the YAML configs are resolved.
 */
const LOCAL_SKILLS_DIRECTORY = "skills";

const SKILL_DOCUMENT = "SKILL.md";

/**
 * The per-skill limits bound one skill, not a directory of them, and this reader
 * holds every skill it finds in memory at once, base64-encoded on top of the raw
 * bytes. Without a budget spanning the whole read, a deployment carrying twenty
 * skills at the 5 MiB ceiling would ask a serverless function for well over
 * 200 MiB before returning anything.
 *
 * The ceiling is deliberately far below what a function could survive, because
 * memory is not the binding constraint: the Nitro hook copies this directory
 * into every function bundle, so each byte here is paid for several times over
 * in deployment size.
 */
const MAX_LOCAL_SKILLS_BYTES = 25 * 1024 * 1024;

export interface LocalSkillArtifact {
  name: string;
  description: string;
  /** `path` is relative to the skills directory, e.g. `review-rules`. */
  source: HarnessLocalSkillSource;
  files: Array<HarnessSkillArtifactFile & { contentBase64: string }>;
}

export interface LocalSkillsRead {
  directoryPresent: boolean;
  skills: LocalSkillArtifact[];
  skipped: LocalSkillSkip[];
}

interface LocalSkillSkip {
  path: string;
  reason: string;
}

/**
 * Thrown when the whole-directory budget runs out. It is separate from the
 * per-skill rejections because it is the one condition that must also stop the
 * read: the budget exists to bound memory, so continuing past it would defeat
 * the check it just failed.
 */
class LocalSkillsBudgetError extends Error {}

/**
 * The two layouts this runs in have different working directories. In a
 * deployed function the bundle carries its own copy of the directory beside the
 * code, so the working directory is the right place to look. In the development
 * tree the working directory is `apps/worker`, while the directory belongs to
 * the repository the tenant deploys, two levels up. Without the second attempt
 * the skills are invisible to `nitro dev` no matter where they are put.
 *
 * When neither exists the bundled path comes back, so a deployment that ships
 * no skills reports the location it would have shipped them in.
 */
export function defaultLocalSkillsDirectory(cwd: string = process.cwd()): string {
  const bundled = resolve(cwd, LOCAL_SKILLS_DIRECTORY);
  if (existsSync(bundled)) return bundled;
  const repositoryRoot = resolve(cwd, "..", "..", LOCAL_SKILLS_DIRECTORY);
  return existsSync(repositoryRoot) ? repositoryRoot : bundled;
}

/**
 * Reads every skill shipped with the deployment. Each immediate subdirectory
 * holding a `SKILL.md` is one skill.
 *
 * A directory that is not a usable skill is reported, never thrown: one
 * malformed entry used to cost the operator every other skill in the
 * deployment, including the healthy ones, and left the only difference between
 * "nothing is here" and "everything was rejected" invisible. Callers that need
 * a specific skill check `skipped` for it and fail on that entry alone.
 *
 * A deployment without the directory has no local skills; that is not an error,
 * but it is distinguishable, because a missing directory and a directory whose
 * entries were all skipped call for opposite fixes.
 */
export async function readLocalSkills(
  directory: string = defaultLocalSkillsDirectory(),
): Promise<LocalSkillsRead> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === "ENOENT") {
      return { directoryPresent: false, skills: [], skipped: [] };
    }
    // The code separates the two realistic causes, a file where the directory
    // should be and a permission problem, which are otherwise indistinguishable
    // from a deployment that simply ships nothing.
    throw new HarnessSkillImportError(
      422,
      `The deployment skills directory "${describeDirectory(directory)}" could not be read (${failure.code ?? "unknown error"})`,
    );
  }

  const skills: LocalSkillArtifact[] = [];
  const skipped: LocalSkillSkip[] = [];
  const pathByName = new Map<string, string>();
  const budget = { spent: 0 };
  const sorted = entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const [index, entry] of sorted.entries()) {
    // A symlink is the only way an entry on disk can stand for content outside
    // the directory; the GitHub importer rejects mode 120000 for the same
    // reason. (Submodules have no equivalent here: the bundle is a plain copy.)
    if (entry.isSymbolicLink()) {
      skipped.push({ path: entry.name, reason: "Entry is a symlink" });
      continue;
    }
    if (!entry.isDirectory()) continue;
    try {
      const skill = await readSkill(directory, entry.name, budget);
      if (skill.skipped) {
        skipped.push({ path: entry.name, reason: skill.reason });
        continue;
      }
      const collision = pathByName.get(skill.artifact.name);
      if (collision !== undefined) {
        // The name comes from the front matter, so it need not match either
        // directory name: without both paths the operator has nowhere to look.
        skipped.push({
          path: entry.name,
          reason: `Skill name "${skill.artifact.name}" is already used by "${collision}"`,
        });
        continue;
      }
      pathByName.set(skill.artifact.name, entry.name);
      skills.push(skill.artifact);
    } catch (error) {
      if (error instanceof LocalSkillsBudgetError) {
        skipped.push({ path: entry.name, reason: error.message });
        for (const remaining of sorted.slice(index + 1)) {
          if (!remaining.isDirectory() || remaining.isSymbolicLink()) continue;
          skipped.push({
            path: remaining.name,
            reason: `Not read: the deployment skills budget was exhausted at "${entry.name}"`,
          });
        }
        break;
      }
      if (!(error instanceof HarnessSkillImportError)) throw error;
      skipped.push({ path: entry.name, reason: error.message });
    }
  }
  return { directoryPresent: true, skills, skipped };
}

/**
 * The build-time gate over the same reader. Without it the first sign of a
 * mistyped name, an out-of-range description or an oversized file is the import
 * dialog after a full deployment cycle, and a directory in the wrong place
 * simply ships nothing without saying so.
 *
 * A skipped entry fails the build rather than warning: every skip means the
 * operator meant to ship a skill and will not get it. A deployment with no
 * directory at all is not a mistake, so it passes with a line saying so.
 */
export async function checkLocalSkills(
  directory: string,
): Promise<{ ok: boolean; message: string }> {
  const read = await readLocalSkills(directory);
  if (!read.directoryPresent) {
    return {
      ok: true,
      message: `No deployment skills directory at ${directory}; none will ship.`,
    };
  }
  if (read.skipped.length > 0) {
    const reasons = read.skipped
      .map((skip) => `  skills/${skip.path}: ${skip.reason}`)
      .join("\n");
    return {
      ok: false,
      message: `${read.skipped.length} entr${read.skipped.length === 1 ? "y" : "ies"} under ${directory} cannot ship as skills:\n${reasons}`,
    };
  }
  return {
    ok: true,
    message: `Validated ${read.skills.length} deployment skill(s) at ${directory}.`,
  };
}

type ReadSkillResult =
  | { skipped: true; reason: string }
  | { skipped: false; artifact: LocalSkillArtifact };

async function readSkill(
  directory: string,
  path: string,
  budget: { spent: number },
): Promise<ReadSkillResult> {
  assertSafePath(path, path);
  const root = join(directory, path);
  const document = await lstatOrNull(join(root, SKILL_DOCUMENT));
  if (document === null) {
    return { skipped: true, reason: await describeMissingDocument(root) };
  }
  // Not a plain file means a symlink standing in for one, which would otherwise
  // vanish from the listing without a word.
  if (!document.isFile()) {
    return {
      skipped: true,
      reason: `${SKILL_DOCUMENT} is not a regular file`,
    };
  }
  // No mode check here, deliberately. A GitHub blob carries its mode as data,
  // so the importer can trust it; a file inside a deployed function bundle does
  // not. The bundle is repacked on the way to the runtime and every file arrives
  // executable, whatever the repository recorded, which rejected a skill that
  // git stores as 0644 and that the build-time check had already accepted from
  // the source tree. Mode is therefore not observable on this path (see
  // `readSkillFiles`), so it cannot be a reason to refuse a skill either.

  const files = await readSkillFiles(root, path, budget);
  const metadata = parseSkillMetadata(
    Buffer.from(
      files.find((file) => file.path === SKILL_DOCUMENT)!.contentBase64,
      "base64",
    ),
    path,
  );
  return {
    skipped: false,
    artifact: {
      name: metadata.name,
      description: metadata.description,
      source: { path, contentSha256: hashSkillContent(files) },
      files,
    },
  };
}

/**
 * A skill one level too deep is the mistake this distinguishes: the directory
 * looks empty to the reader while the operator can plainly see a SKILL.md
 * inside it.
 */
async function describeMissingDocument(root: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return `No ${SKILL_DOCUMENT}`;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = await lstatOrNull(join(root, entry.name, SKILL_DOCUMENT));
    if (nested !== null) {
      return `No ${SKILL_DOCUMENT} here, but "${entry.name}/${SKILL_DOCUMENT}" exists: a skill must sit one level under the skills directory`;
    }
  }
  return `No ${SKILL_DOCUMENT}`;
}

function describeDirectory(directory: string): string {
  const relativePath = relative(process.cwd(), directory);
  return relativePath === "" || relativePath.startsWith("..")
    ? directory
    : relativePath;
}

/**
 * Discovery for the local variant takes no coordinate to point at: the source
 * is this deployment. Each entry carries the identity an import of it would
 * mint, so a caller holding a pinned hash can tell whether the deployment has
 * moved underneath it.
 */
export async function discoverLocalSkills(
  directory?: string,
): Promise<HarnessLocalSkillDiscoveryResponse> {
  const read = await readLocalSkills(directory);
  return {
    directoryPresent: read.directoryPresent,
    skills: read.skills.map((skill) => ({
      name: skill.name,
      path: skill.source.path,
      description: skill.description,
      artifactHash: hashHarnessSkillArtifact(skill),
    })),
    skipped: read.skipped,
  };
}

/**
 * Imports the selected deployment skills into the same artifact table the
 * GitHub importer writes to, through the same write.
 *
 * The selection repeats the hash discovery reported, which is this variant's
 * answer to the exact-commit check on the GitHub side. The bundle is fixed for
 * the life of one deployment, but a promotion between the two requests is
 * ordinary, and without the check it would import bytes the operator never saw.
 */
export async function importLocalSkills(
  db: Db,
  input: {
    organizationId: string;
    actorId: string;
    skills: HarnessLocalSkillSelection[];
    directory?: string;
  },
): Promise<HarnessSkillArtifact[]> {
  const selections = validateSelections(input.skills);
  const read = await readLocalSkills(input.directory);
  const available = new Map(
    read.skills.map((skill) => [skill.source.path, skill]),
  );
  const skipped = new Map(read.skipped.map((skip) => [skip.path, skip.reason]));
  const artifacts = selections.map((selection) => {
    const skill = available.get(selection.path);
    if (!skill) {
      // Only the selected entry's own failure is fatal here; the rest of the
      // directory being unusable is discovery's problem to report, not this
      // import's problem to refuse over.
      const reason = skipped.get(selection.path);
      throw new HarnessSkillImportError(
        400,
        reason === undefined
          ? `Selected path "${selection.path}" is not a deployment skill`
          : `Skill "${selection.path}" cannot be imported: ${reason}`,
      );
    }
    const artifactHash = hashHarnessSkillArtifact(skill);
    if (artifactHash !== selection.artifactHash) {
      throw new HarnessSkillImportError(
        409,
        `Skill "${selection.path}" changed since the list was loaded, which means the deployment was replaced. Reload the deployment skills and select again.`,
      );
    }
    return { ...skill, artifactHash };
  });
  return persistHarnessSkillArtifacts(db, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    artifacts,
  });
}

/**
 * Refreshes a deployment skill from the directory the running deployment
 * carries. Pinning is by hash, so a redeploy on its own changes nothing a
 * profile can see: this is the step that turns new bytes into a new artifact,
 * and the caller then repoints the pin at it.
 */
export async function refreshLocalSkillArtifact(
  db: Db,
  input: {
    organizationId: string;
    actorId: string;
    artifactHash: string;
    directory?: string;
  },
): Promise<HarnessSkillArtifact> {
  const [existing] = await db
    .select()
    .from(harnessSkillArtifacts)
    .where(
      and(
        eq(harnessSkillArtifacts.organizationId, input.organizationId),
        eq(harnessSkillArtifacts.artifactHash, input.artifactHash),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new HarnessSkillImportError(404, "Skill artifact not found");
  }
  let source;
  try {
    source = readHarnessSkillArtifactSource(existing);
  } catch (error) {
    if (!(error instanceof HarnessSkillArtifactIntegrityError)) throw error;
    throw new HarnessSkillImportError(400, "Skill artifact source is unreadable");
  }
  if (isHarnessGitHubSkillSource(source)) {
    throw new HarnessSkillImportError(
      400,
      "Only a deployment skill can be refreshed from the deployment",
    );
  }

  const read = await readLocalSkills(input.directory);
  const skill = read.skills.find(
    (candidate) => candidate.source.path === source.path,
  );
  if (!skill) {
    const reason = read.skipped.find((skip) => skip.path === source.path);
    throw new HarnessSkillImportError(
      404,
      reason === undefined
        ? `Skill "${source.path}" is no longer part of this deployment. Restore it under skills/ and redeploy, or replace the pin with a skill this deployment ships.`
        : `Skill "${source.path}" cannot be read from this deployment: ${reason.reason}`,
    );
  }
  const [artifact] = await persistHarnessSkillArtifacts(db, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    artifacts: [{ ...skill, artifactHash: hashHarnessSkillArtifact(skill) }],
  });
  return artifact!;
}

function validateSelections(
  selections: HarnessLocalSkillSelection[],
): HarnessLocalSkillSelection[] {
  if (
    !Array.isArray(selections) ||
    selections.length < 1 ||
    selections.length > 100
  ) {
    throw new HarnessSkillImportError(
      400,
      "Select between one and 100 skills",
    );
  }
  for (const selection of selections) {
    if (
      selection === null ||
      typeof selection !== "object" ||
      typeof selection.path !== "string" ||
      typeof selection.artifactHash !== "string"
    ) {
      throw new HarnessSkillImportError(
        400,
        "Each selected skill needs the path and artifactHash reported by discovery",
      );
    }
  }
  const paths = selections.map((selection) => selection.path);
  if (new Set(paths).size !== paths.length) {
    throw new HarnessSkillImportError(400, "Selected skill path is duplicated");
  }
  // Nothing normalizes these: they are matched against the directory names the
  // reader found on disk, so anything else simply misses and answers 400.
  return selections;
}

/**
 * The local variant has no commit to name a version after, so the version is
 * the content: for every file, sorted by path, the path and the SHA-256 of its
 * bytes, joined line by line and hashed once more. Location and deployment
 * identity stay out of it, so two deployments carrying byte-identical skills
 * mint the same artifact identity, and renaming or editing any file changes it.
 */
function hashSkillContent(files: LocalSkillArtifact["files"]): string {
  const digest = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    digest.update(`${file.path} ${file.sha256}\n`);
  }
  return digest.digest("hex");
}

async function readSkillFiles(
  root: string,
  skillPath: string,
  budget: { spent: number },
): Promise<LocalSkillArtifact["files"]> {
  const files: LocalSkillArtifact["files"] = [];
  let totalBytes = 0;

  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      assertSafePath(relativePath, skillPath);
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new HarnessSkillImportError(
          400,
          `Skill "${skillPath}" contains a symlink`,
        );
      }
      if (entry.isDirectory()) {
        await walk(absolute, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new HarnessSkillImportError(
          400,
          `Skill "${skillPath}" contains an unsupported file`,
        );
      }
      if (files.length + 1 > HARNESS_SKILL_IMPORT_LIMITS.maxFiles) {
        throw new HarnessSkillImportError(
          413,
          `Skill exceeds ${HARNESS_SKILL_IMPORT_LIMITS.maxFiles} files`,
        );
      }
      const stats = await stat(absolute);
      // Checked before the read so an oversized file never reaches memory.
      if (
        !Number.isSafeInteger(stats.size) ||
        stats.size > HARNESS_SKILL_IMPORT_LIMITS.maxFileBytes
      ) {
        throw new HarnessSkillImportError(
          413,
          `File "${relativePath}" is too large`,
        );
      }
      totalBytes += stats.size;
      if (totalBytes > HARNESS_SKILL_IMPORT_LIMITS.maxSkillBytes) {
        throw new HarnessSkillImportError(
          413,
          "Skill exceeds the 5 MiB size limit",
        );
      }
      // Spent before the read, like the per-file check above, so the budget
      // bounds what reaches memory rather than recording what already did.
      budget.spent += stats.size;
      if (budget.spent > MAX_LOCAL_SKILLS_BYTES) {
        // Names the skill the budget ran out on, because the budget is spent in
        // directory order: the skill that trips it is the one that happened to
        // come later, not the one that is oversized.
        throw new LocalSkillsBudgetError(
          `Not read: skill "${skillPath}" exhausted the 25 MiB deployment skills budget`,
        );
      }
      const content = await readFile(absolute);
      files.push({
        path: relativePath,
        // Fixed, not read from disk. The deployment bundle does not carry the
        // mode the repository recorded: everything arrives executable once the
        // function has been repacked, so reading it here would make an artifact
        // whose identity depends on the packer rather than on the skill, and
        // would differ from the same bytes imported from GitHub for no reason a
        // reader could see. The cost is that a deployment skill cannot ship an
        // executable file; a skill that needs one belongs in a GitHub source.
        mode: 0o644,
        sizeBytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        contentBase64: content.toString("base64"),
      });
    }
  }

  await walk(root, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertSafePath(path: string, skillPath: string): void {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    posix.normalize(path) !== path ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new HarnessSkillImportError(
      400,
      `Skill "${skillPath}" contains an unsafe file path`,
    );
  }
}

function parseSkillMetadata(
  content: Buffer,
  skillPath: string,
): { name: string; description: string } {
  try {
    return parseHarnessSkillMetadata(content);
  } catch (error) {
    if (!(error instanceof HarnessSkillArtifactIntegrityError)) throw error;
    throw new HarnessSkillImportError(
      400,
      `Skill "${skillPath}": ${error.message.replace(/\.$/, "")}`,
    );
  }
}
