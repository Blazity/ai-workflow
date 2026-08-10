"use client";

import { useEffect, useMemo, useState } from "react";

import { readErrorMessage } from "@/lib/api/error-message";
import type {
  HarnessLocalSkillDiscoveryResponse,
  HarnessProfileSkillReference,
  HarnessSkillArtifact,
  HarnessSkillDiscoveryResponse,
} from "@shared/contracts";

const primaryButtonClass =
  "appearance-none rounded-[3px] border border-mariner bg-mariner px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-white cursor-pointer disabled:cursor-default disabled:opacity-40";
const secondaryButtonClass =
  "appearance-none rounded-[3px] border border-neutral-300 bg-panel px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-coal cursor-pointer disabled:cursor-default disabled:opacity-40";

type SkillSourceKind = "github" | "local";

/**
 * Says what the deployment source does and, as importantly, what it does not:
 * an imported artifact is content-addressed and the pin is a hash, so a later
 * deployment cannot change what an agent receives.
 */
export const LOCAL_SOURCE_NOTE =
  "Read from the deployment bundle. No GitHub App installation and no cross-organization access are involved. This list comes from the bundle of the deployment you are using now, while an imported skill is frozen at the contents it had: after a redeploy, use Refresh on the skill and publish the profile again.";

/**
 * The deployment-local list, split out from the drawer so the three states it
 * has to tell apart can be rendered without the drawer's fetch: no directory
 * at all, a directory whose every entry was rejected, and offerable skills.
 */
export function LocalSkillDiscovery({
  discovery,
  selected,
  disabled,
  onToggle,
}: {
  discovery: HarnessLocalSkillDiscoveryResponse;
  selected: string[];
  disabled: boolean;
  onToggle: (path: string, checked: boolean) => void;
}) {
  return (
    <div className="mt-6">
      {!discovery.directoryPresent ? (
        <div className="rounded-[3px] border border-dashed border-neutral-300 px-3 py-6 font-body text-[11px] text-neutral-500">
          <p className="m-0">
            This deployment carries no skills/ directory. Add one at the root of
            the repository this deployment is built from, then redeploy. Each
            skill is one directory holding a SKILL.md:
          </p>
          <pre className="mt-3 mb-0 overflow-x-auto rounded-[3px] border border-neutral-200 bg-app-bg p-3 font-mono text-[10px] leading-[1.5] text-coal">
{`skills/
  review-checklist/
    SKILL.md
    references/api.md

# skills/review-checklist/SKILL.md
---
name: review-checklist
description: House rules the reviewer applies to every pull request.
---
Markdown the agent reads once the skill is loaded.`}
          </pre>
          <p className="mt-3 mb-0">
            The name is lowercase letters, digits and hyphens; the description
            is 1 to 1024 characters. SETUP.md carries the full contract.
          </p>
        </div>
      ) : discovery.skills.length === 0 ? (
        <div className="rounded-[3px] border border-amber-300 bg-amber-50 px-3 py-4 font-body text-[11px] text-amber-800">
          The skills/ directory is present, but none of its entries can be
          offered.
          {discovery.skipped.length > 0
            ? " Fix the reasons below in the repository, then redeploy."
            : " It holds no skill directories."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-[3px] border border-neutral-200">
          {discovery.skills.map((skill) => {
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
                  disabled={disabled}
                  onChange={(event) =>
                    onToggle(skill.path, event.target.checked)
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
                    skills/{skill.path}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}

      {discovery.skipped.length > 0 && (
        <div className="mt-4 rounded-[3px] border border-neutral-200 bg-app-bg p-3">
          <div className="font-body text-[11px] font-semibold text-coal">
            Skipped {discovery.skipped.length}{" "}
            {discovery.skipped.length === 1 ? "directory" : "directories"}
          </div>
          <div className="mt-2 flex flex-col gap-1">
            {discovery.skipped.map((skip) => (
              <div key={skip.path} className="font-body text-[10px]">
                <span className="font-mono text-neutral-700">
                  skills/{skip.path}
                </span>{" "}
                <span className="text-neutral-600">{skip.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A skill the draft already pins, labelled by the editor that owns labelling. */
export interface PinnedSkillSummary {
  name: string;
  artifactHash: string;
  sourceLabel: string | null;
}

/**
 * Merging into the draft drops every pinned skill sharing the incoming name,
 * which is how a re-import from a newer commit lands and is the intent there.
 * With a second source that same rule swaps a GitHub pin for a deployment one,
 * and the name comes from front matter, so it need not match the directory
 * holding it. Say so before the import instead of hiding it.
 */
export function SkillReplacementNotice({
  incoming,
  pinned,
}: {
  incoming: Array<{ name: string; artifactHash?: string }>;
  pinned: PinnedSkillSummary[];
}) {
  const replaced = incoming.flatMap((skill) => {
    const match = pinned.find(
      (candidate) =>
        candidate.name === skill.name &&
        candidate.artifactHash !== skill.artifactHash,
    );
    return match ? [{ name: skill.name, previous: match }] : [];
  });
  if (replaced.length === 0) return null;
  return (
    <div className="mt-3 rounded-[3px] border border-amber-300 bg-amber-50 px-3 py-2 font-body text-[11px] text-amber-800">
      <div className="font-semibold">
        Replaces {replaced.length} pinned{" "}
        {replaced.length === 1 ? "skill" : "skills"}
      </div>
      <div className="mt-1 flex flex-col gap-1">
        {replaced.map((entry) => (
          <div key={entry.name} className="font-body text-[10px]">
            <span className="font-mono">{entry.name}</span> takes over the pin
            held by{" "}
            {entry.previous.sourceLabel ?? "a source no longer on record"}.
          </div>
        ))}
      </div>
      <div className="mt-1 font-body text-[10px]">
        Skills are matched by the name in their SKILL.md, which need not match
        the directory holding it. The replaced pin leaves the draft as soon as
        you add this selection.
      </div>
    </div>
  );
}

export function SkillImport({
  open,
  disabled,
  pinned,
  onClose,
  onImported,
}: {
  open: boolean;
  disabled: boolean;
  pinned: PinnedSkillSummary[];
  onClose: () => void;
  onImported: (
    skills: HarnessProfileSkillReference[],
    artifacts: HarnessSkillArtifact[],
  ) => void;
}) {
  const [sourceKind, setSourceKind] = useState<SkillSourceKind>("github");
  const [source, setSource] = useState("");
  const [discovery, setDiscovery] =
    useState<HarnessSkillDiscoveryResponse | null>(null);
  const [localDiscovery, setLocalDiscovery] =
    useState<HarnessLocalSkillDiscoveryResponse | null>(null);
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

  // Re-read on every opening rather than caching: a redeploy between two
  // openings swaps the bytes on disk, and a stale list would offer hashes the
  // import then rejects.
  useEffect(() => {
    if (!open || sourceKind !== "local") return;
    let cancelled = false;
    setBusy("discover");
    setError(null);
    setLocalDiscovery(null);
    setSelected([]);
    void fetch("/api/harness-skills/local", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readErrorMessage(response));
        return (await response.json()) as HarnessLocalSkillDiscoveryResponse;
      })
      .then((result) => {
        if (cancelled) return;
        setLocalDiscovery(result);
        setSelected(result.skills.map((skill) => skill.path));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to read deployment skills",
        );
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sourceKind]);

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

  function switchSource(next: SkillSourceKind) {
    if (next === sourceKind) return;
    setSourceKind(next);
    setDiscovery(null);
    setLocalDiscovery(null);
    setSelected([]);
    setSearch("");
    setError(null);
    setStep(next === "local" ? "discover" : "source");
  }

  function toggleSelected(path: string, checked: boolean) {
    setSelected((previous) =>
      checked
        ? [...previous, path]
        : previous.filter((candidate) => candidate !== path),
    );
  }

  function applyImported(artifacts: HarnessSkillArtifact[]) {
    onImported(
      artifacts.map((artifact) => ({
        artifactHash: artifact.artifactHash,
        name: artifact.name,
      })),
      artifacts,
    );
    setSource("");
    setDiscovery(null);
    setLocalDiscovery(null);
    setSelected([]);
    setSearch("");
    setStep(sourceKind === "local" ? "discover" : "source");
  }

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
    if (selected.length === 0) return;
    const request =
      sourceKind === "local"
        ? localDiscovery && {
            url: "/api/harness-skills/local",
            body: {
              skills: localDiscovery.skills
                .filter((skill) => selected.includes(skill.path))
                .map((skill) => ({
                  path: skill.path,
                  artifactHash: skill.artifactHash,
                })),
            },
          }
        : discovery && {
            url: "/api/harness-skills/import",
            body: { source: discovery.source, paths: selected },
          };
    if (!request) return;
    setBusy("import");
    setError(null);
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }
      const result = (await response.json()) as {
        artifacts: HarnessSkillArtifact[];
      };
      applyImported(result.artifacts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to import skills");
    } finally {
      setBusy(null);
    }
  }

  if (!open) return null;

  const selectedSkills: Array<{ name: string; artifactHash?: string }> =
    sourceKind === "local"
      ? (localDiscovery?.skills ?? []).filter((skill) =>
          selected.includes(skill.path),
        )
      : (discovery?.skills ?? []).filter((skill) =>
          selected.includes(skill.path),
        );

  const steps: Array<[string, string]> =
    sourceKind === "local"
      ? [
          ["discover", "1. Discover"],
          ["review", "2. Review"],
        ]
      : [
          ["source", "1. Source"],
          ["discover", "2. Discover"],
          ["review", "3. Review"],
        ];

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
              Add skills
            </h2>
            <p className="mt-1 mb-0 font-body text-[11px] text-neutral-500">
              {sourceKind === "local"
                ? "Take skills from the skills/ directory this deployment ships."
                : "Discover skills first, then pin the selected files to one exact commit."}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close skill import"
            onClick={onClose}
            disabled={busy !== null}
            className="appearance-none border-none bg-transparent p-2 font-body text-[20px] text-neutral-500 cursor-pointer"
          >
            ×
          </button>
        </header>

        <div
          role="radiogroup"
          aria-label="Skill source"
          className="flex gap-2 border-b border-neutral-200 px-5 py-3"
        >
          {(
            [
              ["github", "GitHub repository"],
              ["local", "This deployment"],
            ] as Array<[SkillSourceKind, string]>
          ).map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={sourceKind === kind}
              onClick={() => switchSource(kind)}
              disabled={busy !== null}
              className={`appearance-none rounded-[3px] border px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] cursor-pointer disabled:cursor-default disabled:opacity-40 ${
                sourceKind === kind
                  ? "border-mariner bg-mariner-50 text-mariner"
                  : "border-neutral-300 bg-panel text-neutral-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          className={`grid border-b border-neutral-200 px-5 py-3 ${
            sourceKind === "local" ? "grid-cols-2" : "grid-cols-3"
          }`}
        >
          {steps.map(([id, label], index) => {
            const activeIndex = steps.findIndex(
              ([candidate]) => candidate === step,
            );
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
          {sourceKind === "local" ? (
            <div className="rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[10px] text-neutral-600">
              {LOCAL_SOURCE_NOTE}
            </div>
          ) : (
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
          )}

          {error && (
            <div
              role="alert"
              className="mt-4 rounded-[3px] border border-red-300 bg-red-50 px-3 py-2 font-body text-[11px] text-red-700"
            >
              {error}
            </div>
          )}

          {sourceKind === "local" && localDiscovery && (
            <LocalSkillDiscovery
              discovery={localDiscovery}
              selected={selected}
              disabled={disabled || busy !== null}
              onToggle={toggleSelected}
            />
          )}

          {sourceKind === "github" && discovery && (
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
                            toggleSelected(skill.path, event.target.checked)
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

          {step === "review" && (
            <>
              <div className="mt-5 rounded-[3px] border border-mariner-200 bg-mariner-50 p-3">
                <div className="font-body text-[12px] font-semibold text-coal">
                  Ready to add {selected.length}{" "}
                  {selected.length === 1 ? "skill" : "skills"} to this draft
                </div>
                <p className="mt-1 mb-0 font-body text-[10px] text-neutral-600">
                  {sourceKind === "local"
                    ? "The selected directories will be stored as immutable artifacts of their current contents. They take effect only after you save and publish the profile."
                    : `The selected files will be stored as immutable artifacts at ${discovery?.source.commitSha.slice(0, 12) ?? ""}. They take effect only after you save and publish the profile.`}
                </p>
              </div>
              <SkillReplacementNotice
                incoming={selectedSkills}
                pinned={pinned}
              />
            </>
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
              disabled={selected.length === 0 || busy !== null}
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
