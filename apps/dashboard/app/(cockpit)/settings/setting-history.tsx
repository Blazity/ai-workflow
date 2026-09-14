"use client";

import { useEffect, useState } from "react";
import type { SettingsVersionView } from "@shared/contracts";

import { apiClient } from "@/lib/api/client";
import {
  displaySettingValue,
  formatSettingActor,
  formatSettingTimestamp,
} from "@/lib/settings/format";

type HistoryState =
  | { phase: "loading" }
  | { phase: "loaded"; versions: SettingsVersionView[] }
  | { phase: "failed"; message: string };

/**
 * One key's recorded changes, fetched the first time the drawer is opened.
 *
 * The read is deliberately per key: the settings read already carries the
 * newest change of every key, and pulling fifty rows for thirty keys nobody
 * expanded would be the whole history of the deployment on every page load.
 */
export function SettingHistory({ settingKey }: { settingKey: string }) {
  const [state, setState] = useState<HistoryState>({ phase: "loading" });

  useEffect(() => {
    let live = true;
    setState({ phase: "loading" });
    apiClient.settings
      .history(settingKey)
      .then((result) => {
        if (!live) return;
        setState(
          result.ok
            ? { phase: "loaded", versions: result.data.versions }
            : { phase: "failed", message: result.errorMessage },
        );
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({
          phase: "failed",
          message:
            error instanceof Error ? error.message : "Unable to load the history",
        });
      });
    return () => {
      live = false;
    };
  }, [settingKey]);

  if (state.phase === "loading") {
    return (
      <p className="mt-2 font-body text-[11px] text-neutral-500">
        Loading the history of {settingKey}.
      </p>
    );
  }

  if (state.phase === "failed") {
    return (
      <p className="mt-2 font-body text-[11px] text-fail-fg">{state.message}</p>
    );
  }

  if (state.versions.length === 0) {
    return (
      <p className="mt-2 font-body text-[11px] text-neutral-500">
        Never changed from this dashboard.
      </p>
    );
  }

  return (
    <ul className="mt-2 flex flex-col gap-1 list-none p-0 m-0">
      {state.versions.map((version) => (
        <li
          key={version.id}
          className="rounded-[3px] border border-neutral-200 bg-app-bg px-2 py-[6px] font-body text-[11px] text-neutral-700"
        >
          <span className="font-mono text-[11px] text-neutral-800">
            {displaySettingValue(version.previousValue)} to{" "}
            {displaySettingValue(version.newValue)}
          </span>
          <span className="text-neutral-500">
            {" "}
            {formatSettingActor(version.actor)} on{" "}
            {formatSettingTimestamp(version.createdAt)}
          </span>
          <div className="text-neutral-600">{version.reason}</div>
        </li>
      ))}
    </ul>
  );
}
