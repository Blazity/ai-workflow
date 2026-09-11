import type { HarnessProfileResolvedVersion, HarnessSkillSource } from "@shared/contracts";
import { HarnessSkillArtifactIntegrityError } from "@shared/skills";
import {
  createConnectedHarnessProfileRepository,
  resolveHarnessProfileVersionRaw,
} from "../db/repositories/harness-profiles.js";
import { verifyHarnessSkillArtifact } from "./skill-validation.js";
import {
  ensureConnectedSystemHarnessProfiles,
  ensureSystemHarnessProfilesOnDb,
} from "./system-seed.js";

type Db = Parameters<typeof resolveHarnessProfileVersionRaw>[0];

function sourceOf(artifact: Awaited<ReturnType<typeof resolveHarnessProfileVersionRaw>> extends infer Raw ? Raw extends { artifacts: Array<infer Artifact> } ? Artifact : never : never): HarnessSkillSource {
  const row = artifact as {
    sourceKind: string;
    localPath: string | null;
    localContentSha256: string | null;
    sourceOwner: string | null;
    sourceRepository: string | null;
    sourcePath: string | null;
    sourceCommitSha: string | null;
  };
  if (row.sourceKind === "local" && row.localPath && row.localContentSha256) {
    return { path: row.localPath, contentSha256: row.localContentSha256 };
  }
  if (row.sourceKind === "github" && row.sourceOwner && row.sourceRepository && row.sourcePath && row.sourceCommitSha) {
    return { owner: row.sourceOwner, repository: row.sourceRepository, path: row.sourcePath, commitSha: row.sourceCommitSha };
  }
  throw new HarnessSkillArtifactIntegrityError("Stored skill artifact source columns are invalid.");
}

export async function resolveVerifiedHarnessProfileVersion(
  db: Db,
  input: { organizationId: string; profileId: string; version: number },
): Promise<HarnessProfileResolvedVersion | null> {
  await ensureSystemHarnessProfilesOnDb(db);
  const raw = await resolveHarnessProfileVersionRaw(db, input);
  return resolveVerifiedHarnessProfileVersionFromRaw(raw);
}

function resolveVerifiedHarnessProfileVersionFromRaw(
  raw: Awaited<ReturnType<typeof resolveHarnessProfileVersionRaw>>,
): HarnessProfileResolvedVersion | null {
  if (!raw) return null;
  try {
    const filesByArtifact = new Map<number, typeof raw.files>();
    for (const file of raw.files) {
      const files = filesByArtifact.get(file.artifactId) ?? [];
      files.push(file);
      filesByArtifact.set(file.artifactId, files);
    }
    const seen = new Set<string>();
    const skillArtifacts = raw.artifacts.map((artifact, index) => {
      if (raw.skillNames[index] !== artifact.name || seen.has(artifact.name)) {
        throw new HarnessSkillArtifactIntegrityError("Published profile skill name does not match its canonical artifact.");
      }
      seen.add(artifact.name);
      const resolved = {
        artifactHash: artifact.artifactHash,
        organizationId: artifact.organizationId,
        name: artifact.name,
        description: artifact.description,
        source: sourceOf(artifact),
        files: (filesByArtifact.get(artifact.id) ?? []).map((file) => ({ path: file.path, mode: file.mode, sizeBytes: file.sizeBytes, sha256: file.sha256, contentBase64: file.contentBase64 })),
        createdAt: artifact.createdAt.toISOString(),
        createdById: artifact.createdById,
      };
      verifyHarnessSkillArtifact(resolved);
      return resolved;
    });
    return { manifest: raw.manifest, manifestHash: raw.manifestHash, skillArtifacts };
  } catch (error) {
    if (error instanceof HarnessSkillArtifactIntegrityError) return null;
    throw error;
  }
}

export async function resolveConnectedVerifiedHarnessProfileVersion(
  input: { organizationId: string; profileId: string; version: number },
): Promise<HarnessProfileResolvedVersion | null> {
  await ensureConnectedSystemHarnessProfiles();
  const repository = createConnectedHarnessProfileRepository();
  const raw = await repository.resolveVersionRaw(input);
  return resolveVerifiedHarnessProfileVersionFromRaw(raw);
}
