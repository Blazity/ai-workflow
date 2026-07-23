"use client";

import { useState } from "react";

import { readErrorMessage } from "@/lib/api/error-message";
import type {
  HarnessProfileSkillReference,
  HarnessSkillArtifact,
  HarnessSkillDiscoveryResponse,
} from "@shared/contracts";

const buttonClass =
  "appearance-none rounded-[3px] border border-neutral-300 bg-panel px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-coal cursor-pointer disabled:cursor-default disabled:opacity-40";

export function SkillImport({
  disabled,
  onImported,
}: {
  disabled: boolean;
  onImported: (
    skills: HarnessProfileSkillReference[],
    artifacts: HarnessSkillArtifact[],
  ) => void;
}) {
  const [source, setSource] = useState("");
  const [discovery, setDiscovery] =
    useState<HarnessSkillDiscoveryResponse | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<"discover" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function discover() {
    setBusy("discover");
    setError(null);
    setDiscovery(null);
    setSelected([]);
    try {
      const response = await fetch("/api/harness-skills/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: source.trim() }),
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }
      const result = (await response.json()) as HarnessSkillDiscoveryResponse;
      setDiscovery(result);
      setSelected(result.skills.map((skill) => skill.path));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to discover skills",
      );
    } finally {
      setBusy(null);
    }
  }

  async function importSelected() {
    if (!discovery || selected.length === 0) return;
    setBusy("import");
    setError(null);
    try {
      const response = await fetch("/api/harness-skills/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: discovery.source,
          paths: selected,
        }),
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }
      const result = (await response.json()) as {
        artifacts: HarnessSkillArtifact[];
      };
      onImported(
        result.artifacts.map((artifact) => ({
          artifactHash: artifact.artifactHash,
          name: artifact.name,
        })),
        result.artifacts,
      );
      setSource("");
      setDiscovery(null);
      setSelected([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to import skills");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-[3px] border border-dashed border-neutral-300 bg-app-bg p-3">
      <div className="font-body text-[12px] font-semibold text-neutral-900">
        Add skills from GitHub
      </div>
      <p className="mt-1 mb-2 font-body text-[11px] leading-[1.45] text-neutral-600">
        Enter an owner/repository, GitHub URL, or repository path. Discovery
        pins a commit before anything is imported.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          aria-label="GitHub skill source"
          value={source}
          disabled={disabled || busy !== null}
          onChange={(event) => setSource(event.target.value)}
          placeholder="openai/skills or https://github.com/openai/skills"
          className="h-[30px] min-w-0 flex-1 rounded-[3px] border border-neutral-200 bg-white px-2 font-mono text-[11px] text-coal outline-none disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => void discover()}
          disabled={disabled || busy !== null || source.trim() === ""}
          className={buttonClass}
        >
          {busy === "discover" ? "Discovering…" : "Discover"}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-2 rounded-[3px] border border-red-300 bg-red-50 px-2 py-1.5 font-body text-[11px] text-red-700"
        >
          {error}
        </div>
      )}

      {discovery && (
        <div className="mt-3">
          <div className="mb-2 font-mono text-[10px] text-neutral-600">
            {discovery.source.owner}/{discovery.source.repository} @{" "}
            {discovery.source.commitSha.slice(0, 12)}
          </div>
          {discovery.skills.length === 0 ? (
            <div className="font-body text-[11px] text-neutral-500">
              No valid SKILL.md directories were found at this commit.
            </div>
          ) : (
            <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {discovery.skills.map((skill) => {
                const checked = selected.includes(skill.path);
                return (
                  <label
                    key={skill.path}
                    className="flex cursor-pointer items-start gap-2 rounded-[3px] border border-neutral-200 bg-panel px-2 py-1.5"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled || busy !== null}
                      onChange={(event) =>
                        setSelected((previous) =>
                          event.target.checked
                            ? [...previous, skill.path]
                            : previous.filter((path) => path !== skill.path),
                        )
                      }
                      className="mt-0.5 size-3.5 accent-mariner"
                    />
                    <span className="min-w-0">
                      <span className="block font-mono text-[11px] text-coal">
                        {skill.name}
                      </span>
                      <span className="block truncate font-mono text-[9px] text-neutral-500">
                        {skill.path}
                      </span>
                      {skill.description && (
                        <span className="mt-0.5 block font-body text-[10px] text-neutral-600">
                          {skill.description}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {discovery.skills.length > 0 && (
            <button
              type="button"
              onClick={() => void importSelected()}
              disabled={disabled || busy !== null || selected.length === 0}
              className={`${buttonClass} mt-2 border-mariner bg-mariner text-white`}
            >
              {busy === "import"
                ? "Importing…"
                : `Import ${selected.length} selected`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
