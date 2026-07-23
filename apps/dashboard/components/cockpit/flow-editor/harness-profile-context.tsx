"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  HarnessProfileDetailResponse,
  HarnessProfileDto,
  HarnessProfilesResponse,
} from "@shared/contracts";

export type HarnessProfileCatalogStatus = "loading" | "ready" | "error";

export interface HarnessProfileCatalogState {
  status: HarnessProfileCatalogStatus;
  profiles: HarnessProfileDto[];
  details: ReadonlyMap<string, HarnessProfileDetailResponse>;
  detailErrors: ReadonlySet<string>;
  refresh: () => void;
  loadDetail: (profileId: string, requestedVersion?: number) => void;
}

const noop = () => {};
const HarnessProfileCatalogContext =
  createContext<HarnessProfileCatalogState>({
    status: "loading",
    profiles: [],
    details: new Map(),
    detailErrors: new Set(),
    refresh: noop,
    loadDetail: noop,
  });

export function HarnessProfileCatalogProvider({
  children,
  initial,
}: {
  children: React.ReactNode;
  initial?: {
    status: HarnessProfileCatalogStatus;
    profiles: HarnessProfileDto[];
    details?: ReadonlyMap<string, HarnessProfileDetailResponse>;
  };
}) {
  const [status, setStatus] =
    useState<HarnessProfileCatalogStatus>(initial?.status ?? "loading");
  const [profiles, setProfiles] = useState<HarnessProfileDto[]>(
    initial?.profiles ?? [],
  );
  const [details, setDetails] = useState<
    Map<string, HarnessProfileDetailResponse>
  >(new Map(initial?.details));
  const [detailErrors, setDetailErrors] = useState<Set<string>>(new Set());
  const listRequestId = useRef(0);
  const detailRequests = useRef(new Set<string>());

  const loadDetail = useCallback(
    (profileId: string, requestedVersion?: number) => {
      const loaded = details.get(profileId);
      if (
        profileId === "" ||
        (loaded &&
          (requestedVersion === undefined ||
            loaded.versions.some(
              (version) => version.version === requestedVersion,
            )))
      ) {
        return;
      }
      const requestKey = `${profileId}:${requestedVersion ?? "recent"}`;
      if (detailRequests.current.has(requestKey)) return;
      detailRequests.current.add(requestKey);
      const versionQuery =
        requestedVersion === undefined ? "" : `?version=${requestedVersion}`;
      fetch(`/api/harness-profiles/${encodeURIComponent(profileId)}${versionQuery}`, {
        cache: "no-store",
      })
        .then((response) => {
          if (!response.ok) throw new Error(String(response.status));
          return response.json() as Promise<HarnessProfileDetailResponse>;
        })
        .then((detail) => {
          setDetails((current) => new Map(current).set(profileId, detail));
          setDetailErrors((current) => {
            const next = new Set(current);
            next.delete(profileId);
            return next;
          });
        })
        .catch(() => {
          setDetailErrors((current) => new Set(current).add(profileId));
        })
        .finally(() => {
          detailRequests.current.delete(requestKey);
        });
    },
    [details],
  );

  const refresh = useCallback(() => {
    const id = ++listRequestId.current;
    setStatus("loading");
    fetch("/api/harness-profiles", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<HarnessProfilesResponse>;
      })
      .then((result) => {
        if (id !== listRequestId.current) return;
        setProfiles(result.profiles);
        setStatus("ready");
      })
      .catch(() => {
        if (id !== listRequestId.current) return;
        setStatus("error");
      });
  }, []);

  useEffect(() => {
    if (!initial) refresh();
  }, [initial, refresh]);

  return (
    <HarnessProfileCatalogContext.Provider
      value={{
        status,
        profiles,
        details,
        detailErrors,
        refresh,
        loadDetail,
      }}
    >
      {children}
    </HarnessProfileCatalogContext.Provider>
  );
}

export function useHarnessProfileCatalog(): HarnessProfileCatalogState {
  return useContext(HarnessProfileCatalogContext);
}
