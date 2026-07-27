"use client";

import { useEffect, useMemo, useState } from "react";

import { readErrorMessage } from "@/lib/api/error-message";
import type {
  HarnessProfileSkillReference,
  HarnessSkillArtifact,
  HarnessSkillDiscoveryResponse,
} from "@shared/contracts";

const primaryButtonClass =
  "appearance-none rounded-[3px] border border-mariner bg-mariner px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-white cursor-pointer disabled:cursor-default disabled:opacity-40";
const secondaryButtonClass =
  "appearance-none rounded-[3px] border border-neutral-300 bg-panel px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-coal cursor-pointer disabled:cursor-default disabled:opacity-40";

export function SkillImport({
  open,
  disabled,
  onClose,
  onImported,
}: {
  open: boolean;
  disabled: boolean;
  onClose: () => void;
  onImported: (
    skills: HarnessProfileSkillReference[],
    artifacts: HarnessSkillArtifact[],
  ) => void;
}) {
  const [source, setSource] = useState("");
  const [discovery, setDiscovery] =
    useState<HarnessSkillDiscoveryResponse | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [step, setStep] = useState<"source" | "discover" | "review">("source");
  const [busy, setBusy] = useState<"discover" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && busy === null) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose, open]);

  const visibleSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!discovery || query === "") return discovery?.skills ?? [];
    return discovery.skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) ||
        skill.path.toLowerCase().includes(query) ||
        skill.description?.toLowerCase().includes(query),
    );
  }, [discovery, search]);

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
      setStep("discover");
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
      setSearch("");
      setStep("source");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to import skills");
    } finally {
      setBusy(null);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[120] bg-coal/20" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-import-title"
        onMouseDown={(event) => event.stopPropagation()}
        className="absolute inset-y-0 right-0 flex w-full max-w-[620px] flex-col border-l border-neutral-200 bg-panel shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
          <div>
            <h2
              id="skill-import-title"
              className="m-0 font-display text-[20px] font-semibold text-coal"
            >
              Add skills from GitHub
            </h2>
            <p className="mt-1 mb-0 font-body text-[11px] text-neutral-500">
              Discover skills first, then pin the selected files to one exact
              commit.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close GitHub skill import"
            onClick={onClose}
            disabled={busy !== null}
            className="appearance-none border-none bg-transparent p-2 font-body text-[20px] text-neutral-500 cursor-pointer"
          >
            ×
          </button>
        </header>

        <div className="grid grid-cols-3 border-b border-neutral-200 px-5 py-3">
          {[
            ["source", "1. Source"],
            ["discover", "2. Discover"],
            ["review", "3. Review"],
          ].map(([id, label], index) => {
            const order = ["source", "discover", "review"];
            const activeIndex = order.indexOf(step);
            return (
              <div
                key={id}
                className={`border-b-2 pb-2 font-mono text-[9px] uppercase tracking-[0.06em] ${
                  index <= activeIndex
                    ? "border-mariner text-mariner"
                    : "border-neutral-200 text-neutral-400"
                }`}
              >
                {label}
              </div>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div>
            <label
              htmlFor="github-skill-source"
              className="font-body text-[12px] font-semibold text-coal"
            >
              Source repository
            </label>
            <p className="mt-1 mb-2 font-body text-[10px] text-neutral-500">
              Enter owner/repository, a full GitHub URL, or a direct path to a
              skill.
            </p>
            <div className="flex gap-2">
              <input
                id="github-skill-source"
                value={source}
                disabled={disabled || busy !== null}
                onChange={(event) => {
                  setSource(event.target.value);
                  if (step !== "source") {
                    setDiscovery(null);
                    setSelected([]);
                    setStep("source");
                  }
                }}
                placeholder="vercel-labs/agent-skills"
                className="h-[36px] min-w-0 flex-1 rounded-[3px] border border-neutral-200 bg-white px-3 font-mono text-[11px] text-coal outline-none focus:border-mariner"
              />
              <button
                type="button"
                onClick={() => void discover()}
                disabled={disabled || busy !== null || source.trim() === ""}
                className={secondaryButtonClass}
              >
                {busy === "discover" ? "Discovering…" : "Discover"}
              </button>
            </div>
            <div className="mt-2 rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[10px] text-neutral-600">
              Uses the organization GitHub App with read-only repository
              access. Nothing is written back to GitHub.
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="mt-4 rounded-[3px] border border-red-300 bg-red-50 px-3 py-2 font-body text-[11px] text-red-700"
            >
              {error}
            </div>
          )}

          {discovery && (
            <div className="mt-6">
              <div className="grid grid-cols-2 rounded-[3px] border border-neutral-200 bg-app-bg p-3">
                <div>
                  <div className="font-body text-[9px] text-neutral-500">
                    Repository
                  </div>
                  <div className="font-mono text-[10px] text-coal">
                    {discovery.source.owner}/{discovery.source.repository}
                  </div>
                </div>
                <div>
                  <div className="font-body text-[9px] text-neutral-500">
                    Resolved commit
                  </div>
                  <div className="truncate font-mono text-[10px] text-mariner">
                    {discovery.source.commitSha}
                  </div>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between gap-3">
                <span className="font-body text-[11px] text-neutral-600">
                  {discovery.skills.length}{" "}
                  {discovery.skills.length === 1 ? "skill" : "skills"} found
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setSelected(
                      selected.length === discovery.skills.length
                        ? []
                        : discovery.skills.map((skill) => skill.path),
                    )
                  }
                  className="appearance-none border-none bg-transparent p-0 font-body text-[10px] font-semibold text-mariner cursor-pointer"
                >
                  {selected.length === discovery.skills.length
                    ? "Clear all"
                    : "Select all"}
                </button>
              </div>

              <input
                aria-label="Search discovered skills"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search discovered skills…"
                className="mt-2 h-[34px] w-full rounded-[3px] border border-neutral-200 bg-white px-3 font-body text-[11px] outline-none focus:border-mariner"
              />

              {discovery.skills.length === 0 ? (
                <div className="mt-3 rounded-[3px] border border-dashed border-neutral-300 px-3 py-8 text-center font-body text-[11px] text-neutral-500">
                  No valid SKILL.md packages were found at this commit.
                </div>
              ) : (
                <div className="mt-2 overflow-hidden rounded-[3px] border border-neutral-200">
                  {visibleSkills.map((skill) => {
                    const checked = selected.includes(skill.path);
                    return (
                      <label
                        key={skill.path}
                        className={`flex cursor-pointer items-start gap-3 border-b border-neutral-100 px-3 py-3 last:border-b-0 ${
                          checked ? "bg-mariner-50" : "bg-panel"
                        }`}
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
                          <span className="block font-mono text-[11px] font-semibold text-coal">
                            {skill.name}
                          </span>
                          {skill.description && (
                            <span className="mt-0.5 block font-body text-[10px] text-neutral-600">
                              {skill.description}
                            </span>
                          )}
                          <span className="mt-1 block truncate font-mono text-[9px] text-neutral-500">
                            {skill.path || "repository root"}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}

              <div className="mt-4 rounded-[3px] border border-neutral-200 bg-app-bg p-3">
                <div className="font-body text-[11px] font-semibold text-coal">
                  Safety and validation
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {[
                    "No symlinks",
                    "No path traversal",
                    "No submodules",
                    "Valid SKILL.md metadata",
                    "Artifact size limits",
                    "Exact commit pin",
                  ].map((label) => (
                    <div
                      key={label}
                      className="font-body text-[10px] text-green-700"
                    >
                      ✓ {label}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === "review" && discovery && (
            <div className="mt-5 rounded-[3px] border border-mariner-200 bg-mariner-50 p-3">
              <div className="font-body text-[12px] font-semibold text-coal">
                Ready to add {selected.length}{" "}
                {selected.length === 1 ? "skill" : "skills"} to this draft
              </div>
              <p className="mt-1 mb-0 font-body text-[10px] text-neutral-600">
                The selected files will be stored as immutable artifacts at{" "}
                {discovery.source.commitSha.slice(0, 12)}. They take effect only
                after you save and publish the profile.
              </p>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-neutral-200 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy !== null}
            className={secondaryButtonClass}
          >
            Cancel
          </button>
          {step !== "review" ? (
            <button
              type="button"
              onClick={() => setStep("review")}
              disabled={!discovery || selected.length === 0 || busy !== null}
              className={primaryButtonClass}
            >
              Review {selected.length || ""}{" "}
              {selected.length === 1 ? "skill" : "skills"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void importSelected()}
              disabled={selected.length === 0 || busy !== null}
              className={primaryButtonClass}
            >
              {busy === "import"
                ? "Adding…"
                : `Add ${selected.length} to draft`}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
