"use client";

import { useEffect, useState } from "react";

import { AIWF_DATA } from "@/lib/data/mock";
import { useTweaks } from "@/lib/use-tweaks";
import type { Run } from "@/lib/types";

import {
  CockpitCtx,
  TWEAK_DEFAULTS,
  type Tweaks,
} from "@/components/cockpit/context";
import { CkSidebar, CkTopbar } from "@/components/cockpit/chrome";
import { CkActivityDrawer } from "@/components/cockpit/activity-drawer";
import {
  TweaksPanel,
  TweakSection,
  TweakRadio,
  TweakToggle,
  TweakColor,
} from "@/components/cockpit/tweaks-panel";

import { OverviewScreen } from "@/components/cockpit/screens/overview";
import { RunsScreen } from "@/components/cockpit/screens/runs";
import { TraceScreen } from "@/components/cockpit/screens/trace";
import { PromptsScreen } from "@/components/cockpit/screens/prompts";
import { EvalsScreen } from "@/components/cockpit/screens/evals";
import { CostScreen } from "@/components/cockpit/screens/cost";
import { PreSandboxScreen } from "@/components/cockpit/screens/presandbox";
import { PostPRReviewScreen } from "@/components/cockpit/screens/postpr";

const VALID_SCREENS = [
  "overview",
  "runs",
  "trace",
  "prompts",
  "evals",
  "cost",
  "presandbox",
  "postpr",
] as const;

export default function CockpitApp() {
  const [t, setTweak] = useTweaks<Tweaks>(TWEAK_DEFAULTS);

  // Screen routing is synced to the URL hash, mirroring the prototype.
  const [screen, setScreen] = useState<string>("overview");
  const [activeRun, setActiveRun] = useState<Run>(AIWF_DATA.RUNS[0]);
  const [persona, setPersona] = useState("swe");
  const [range, setRange] = useState("24h");
  const [env, setEnv] = useState("prod");
  const [activityOpen, setActivityOpen] = useState<boolean>(
    !!t.activityDrawerOpen,
  );

  // Read the initial screen from the hash after mount (avoids SSR/client mismatch).
  useEffect(() => {
    const initial = window.location.hash ? window.location.hash.slice(1) : "";
    if ((VALID_SCREENS as readonly string[]).includes(initial)) {
      setScreen(initial);
    }
  }, []);

  useEffect(() => {
    setActivityOpen(!!t.activityDrawerOpen);
  }, [t.activityDrawerOpen]);

  useEffect(() => {
    window.location.hash = screen;
  }, [screen]);

  const openRun = (r: Run) => {
    setActiveRun(r);
    setScreen("trace");
  };

  return (
    <CockpitCtx.Provider value={{ t, setTweak, persona, range, env }}>
      <div
        style={{
          height: "100vh",
          width: "100vw",
          display: "flex",
          overflow: "hidden",
          background: "#F2F4F6",
          position: "relative",
        }}
      >
        <CkSidebar active={screen} onNav={setScreen} />
        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <CkTopbar
            persona={persona}
            setPersona={setPersona}
            range={range}
            setRange={setRange}
            env={env}
            setEnv={setEnv}
            activityOpen={activityOpen}
            onToggleActivity={() => setActivityOpen((v) => !v)}
          />
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {screen === "overview" && <OverviewScreen onOpenRun={openRun} />}
            {screen === "runs" && <RunsScreen onOpenRun={openRun} />}
            {screen === "trace" && (
              <TraceScreen run={activeRun} onBack={() => setScreen("runs")} />
            )}
            {screen === "prompts" && <PromptsScreen />}
            {screen === "evals" && <EvalsScreen />}
            {screen === "cost" && <CostScreen />}
            {screen === "presandbox" && <PreSandboxScreen />}
            {screen === "postpr" && <PostPRReviewScreen />}
          </div>
        </main>

        <CkActivityDrawer
          open={activityOpen}
          onClose={() => setActivityOpen(false)}
        />

        <TweaksPanel title="Cockpit tweaks">
          <TweakSection label="Layout" />
          <TweakRadio
            label="Density"
            value={t.density}
            options={["compact", "comfy"]}
            onChange={(v) => setTweak("density", v as Tweaks["density"])}
          />
          <TweakToggle
            label="Editorial hero on Overview"
            value={t.showEditorialHero}
            onChange={(v) => setTweak("showEditorialHero", v)}
          />
          <TweakToggle
            label="Streaming run in lists"
            value={t.showStreamingRun}
            onChange={(v) => setTweak("showStreamingRun", v)}
          />
          <TweakToggle
            label="Activity drawer open"
            value={t.activityDrawerOpen}
            onChange={(v) => setTweak("activityDrawerOpen", v)}
          />
          <TweakSection label="Brand" />
          <TweakColor
            label="Accent"
            value={t.accentColor}
            options={["#3C43E7", "#FD6027", "#181B20", "#8FC548"]}
            onChange={(v) => setTweak("accentColor", v)}
          />
        </TweaksPanel>
      </div>
    </CockpitCtx.Provider>
  );
}
