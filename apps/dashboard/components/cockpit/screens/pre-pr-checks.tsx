"use client";

import React, { useState } from "react";
import type {
  PrePrCheckConfigVersion,
  PrePrCheckRepositoryConfig,
  PrePrChecksResponse,
  PrePrCheckSaveResponse,
  RepositoriesResponse,
  RepositoryOption,
} from "@shared/contracts";
import { readErrorMessage } from "@/lib/api/error-message";
import { Listbox } from "@/components/cockpit/listbox";

export function PrePrChecksScreen({
  initial,
  canEdit,
}: {
  initial: PrePrChecksResponse;
  canEdit: boolean;
}) {
  const [repos, setRepos] = useState<PrePrCheckRepositoryConfig[]>(
    structuredClone(initial.current?.config.repositories ?? []),
  );
  const [versions, setVersions] = useState<PrePrCheckConfigVersion[]>(initial.versions);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);

  const savedRepos = versions[0]?.config.repositories ?? [];
  const dirty = JSON.stringify(repos) !== JSON.stringify(savedRepos);
  const valid = repos.every(
    (r) => r.commands.length > 0 && r.commands.every((c) => c.trim().length > 0),
  );

  function applyVersion(version: PrePrCheckConfigVersion) {
    setVersions((prev) => [version, ...prev]);
    setRepos(structuredClone(version.config.repositories));
  }

  async function save() {
    setBusy("save");
    setError(null);
    try {
      const res = await fetch("/api/pre-pr-checks", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { repositories: repos } }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      applyVersion(((await res.json()) as PrePrCheckSaveResponse).version);
    } finally {
      setBusy(null);
    }
  }

  async function restore(version: number) {
    setBusy(`restore-${version}`);
    setError(null);
    try {
      const res = await fetch("/api/pre-pr-checks/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      applyVersion(((await res.json()) as PrePrCheckSaveResponse).version);
      setConfirmRestore(null);
    } finally {
      setBusy(null);
    }
  }

  function updateRepo(index: number, next: PrePrCheckRepositoryConfig) {
    setRepos((prev) => prev.map((r, i) => (i === index ? next : r)));
  }

  return (
    <div className="p-6 max-w-[860px]">
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="font-body text-[18px] font-semibold text-neutral-900">Pre-PR checks</h1>
        {canEdit && (
          <button
            onClick={save}
            disabled={!dirty || !valid || busy !== null}
            className="appearance-none border-none rounded-[3px] px-4 py-2 font-body text-[13px] font-semibold cursor-pointer bg-mariner text-white disabled:opacity-40 disabled:cursor-default"
          >
            {busy === "save" ? "Saving…" : "Save changes"}
          </button>
        )}
      </div>
      <p className="font-body text-[13px] text-neutral-600 mb-4">
        Commands run inside the sandbox for changed repositories after implementation and before
        branch push / PR creation. Failed checks trigger up to 3 agent fix cycles, then block
        publication.
      </p>
      {error && (
        <div className="mb-3 rounded-[3px] border border-red-300 bg-red-50 px-3 py-2 font-body text-[12px] text-red-700">
          {error}
        </div>
      )}
      {!canEdit && (
        <div className="mb-3 rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[12px] text-neutral-600">
          Read-only — ask an admin or owner to change pre-PR checks.
        </div>
      )}

      {repos.length === 0 && (
        <div className="rounded-[3px] border border-dashed border-neutral-300 px-4 py-6 font-body text-[13px] text-neutral-500 mb-3">
          No pre-PR checks configured. The gate is disabled.
        </div>
      )}

      {repos.map((repo, index) => (
        <div key={`${repo.provider}:${repo.repoPath}`} className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3 mb-3">
          <div className="flex items-center justify-between mb-2">
            <div className="font-mono text-[13px] text-neutral-900">
              {repo.repoPath}
              <span className="ml-2 rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-600">
                {repo.provider}
              </span>
            </div>
            {canEdit && (
              <button
                onClick={() => setRepos((prev) => prev.filter((_, i) => i !== index))}
                className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 hover:text-red-600 cursor-pointer"
              >
                Remove
              </button>
            )}
          </div>
          {repo.commands.map((command, ci) => (
            <div key={ci} className="flex items-center gap-2 mb-[6px]">
              <span className="font-mono text-[11px] text-neutral-400 w-4 text-right">{ci + 1}.</span>
              <input
                value={command}
                disabled={!canEdit}
                onChange={(e) =>
                  updateRepo(index, {
                    ...repo,
                    commands: repo.commands.map((c, i) => (i === ci ? e.target.value : c)),
                  })
                }
                placeholder="pnpm test"
                className="flex-1 rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-mono text-[12px] text-neutral-900 disabled:bg-app-bg"
              />
              {canEdit && (
                <button
                  onClick={() =>
                    updateRepo(index, {
                      ...repo,
                      commands: repo.commands.filter((_, i) => i !== ci),
                    })
                  }
                  aria-label="Remove command"
                  className="appearance-none border-none bg-transparent font-mono text-[13px] text-neutral-400 hover:text-red-600 cursor-pointer"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <button
              onClick={() => updateRepo(index, { ...repo, commands: [...repo.commands, ""] })}
              className="appearance-none border-none bg-transparent font-body text-[12px] text-mariner cursor-pointer px-0"
            >
              + Add command
            </button>
          )}
        </div>
      ))}

      {canEdit && (
        <AddRepository
          configured={repos}
          onAdd={(repo) => setRepos((prev) => [...prev, { ...repo, commands: [""] }])}
        />
      )}

      <h2 className="font-body text-[14px] font-semibold text-neutral-900 mt-8 mb-2">History</h2>
      {versions.length === 0 && (
        <div className="font-body text-[12px] text-neutral-500">No versions yet.</div>
      )}
      {versions.map((v) => (
        <div
          key={v.version}
          className="flex items-center gap-3 border-b border-neutral-100 py-2 font-body text-[12px] text-neutral-700"
        >
          <span className="font-mono text-neutral-900">v{v.version}</span>
          <span>{v.createdByLabel}</span>
          <span className="text-neutral-400">{new Date(v.createdAt).toLocaleString()}</span>
          {v.restoredFromVersion !== null && (
            <span className="rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[10px] text-neutral-600">
              restored from v{v.restoredFromVersion}
            </span>
          )}
          {canEdit && v.version !== versions[0]?.version && (
            <span className="ml-auto">
              {confirmRestore === v.version ? (
                <>
                  <button
                    onClick={() => restore(v.version)}
                    disabled={busy !== null}
                    className="appearance-none border-none bg-transparent font-body text-[12px] font-semibold text-red-600 cursor-pointer disabled:opacity-40"
                  >
                    {busy === `restore-${v.version}` ? "Restoring…" : "Confirm restore"}
                  </button>
                  <button
                    onClick={() => setConfirmRestore(null)}
                    className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer ml-2"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmRestore(v.version)}
                  className="appearance-none border-none bg-transparent font-body text-[12px] text-mariner cursor-pointer"
                >
                  Restore
                </button>
              )}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function AddRepository({
  configured,
  onAdd,
}: {
  configured: PrePrCheckRepositoryConfig[];
  onAdd: (repo: { provider: "github" | "gitlab"; repoPath: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<RepositoryOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const [manualProvider, setManualProvider] = useState<"github" | "gitlab">("github");
  const [manualPath, setManualPath] = useState("");

  const isConfigured = (provider: string, repoPath: string) =>
    configured.some((r) => r.provider === provider && r.repoPath === repoPath);

  async function openPicker() {
    setOpen(true);
    if (options || failed) return;
    try {
      const res = await fetch("/api/repositories");
      if (!res.ok) throw new Error("failed");
      setOptions(((await res.json()) as RepositoriesResponse).repositories);
    } catch {
      setFailed(true);
    }
  }

  function addManual() {
    const repoPath = manualPath.trim();
    if (!repoPath || isConfigured(manualProvider, repoPath)) return;
    onAdd({ provider: manualProvider, repoPath });
    setManualPath("");
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        onClick={openPicker}
        className="appearance-none rounded-[3px] border border-neutral-300 bg-panel px-3 py-2 font-body text-[13px] text-neutral-800 cursor-pointer hover:bg-app-bg"
      >
        + Add repository
      </button>
    );
  }

  return (
    <div className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="font-body text-[13px] font-semibold text-neutral-900">Add repository</span>
        <button
          onClick={() => setOpen(false)}
          className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
        >
          Close
        </button>
      </div>
      {options === null && !failed && (
        <div className="font-body text-[12px] text-neutral-500 py-2">Loading repositories…</div>
      )}
      {options && (
        <>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="w-full rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-mono text-[12px] mb-2"
          />
          <div className="max-h-[220px] overflow-y-auto">
            {options
              .filter((o) => !o.archived)
              .filter((o) => o.repoPath.toLowerCase().includes(filter.toLowerCase()))
              .map((o) => {
                const taken = isConfigured(o.provider, o.repoPath);
                return (
                  <button
                    key={`${o.provider}:${o.repoPath}`}
                    disabled={taken}
                    onClick={() => {
                      onAdd({ provider: o.provider, repoPath: o.repoPath });
                      setOpen(false);
                    }}
                    className="w-full appearance-none border-none bg-transparent text-left flex items-center gap-2 px-1 py-[6px] font-mono text-[12px] text-neutral-800 cursor-pointer hover:bg-app-bg rounded-[3px] disabled:opacity-40 disabled:cursor-default"
                  >
                    {o.repoPath}
                    <span className="rounded-[3px] bg-app-bg px-[5px] py-[1px] font-mono text-[10px] uppercase text-neutral-500">
                      {o.provider}
                    </span>
                    {taken && <span className="ml-auto font-body text-[11px] text-neutral-400">added</span>}
                  </button>
                );
              })}
          </div>
        </>
      )}
      {failed && (
        <div className="flex items-center gap-2 pt-1">
          <span className="font-body text-[12px] text-neutral-500">
            Couldn&apos;t list repositories — enter manually:
          </span>
          <div className="w-[120px]">
            <Listbox
              options={[
                { value: "github", label: "github" },
                { value: "gitlab", label: "gitlab" },
              ]}
              value={manualProvider}
              ariaLabel="VCS provider"
              onChange={(v) => setManualProvider(v as "github" | "gitlab")}
            />
          </div>
          <input
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            placeholder="owner/repo"
            className="flex-1 rounded-[3px] border border-neutral-200 bg-white px-2 py-[5px] font-mono text-[12px]"
          />
          <button
            onClick={addManual}
            className="appearance-none rounded-[3px] border border-neutral-300 bg-panel px-2 py-[5px] font-body text-[12px] cursor-pointer"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
