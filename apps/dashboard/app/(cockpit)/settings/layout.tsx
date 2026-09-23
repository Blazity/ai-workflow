// apps/dashboard/app/(cockpit)/settings/layout.tsx
//
// The Settings area: deployment settings, System health and Users. Synchronous
// on purpose. A layout that awaited anything would put a Suspense boundary over
// every screen under it, and a boundary that suspends again on a refresh takes
// the client tree with it: the settings forms would empty under a hand on the
// keyboard. The tabs need nothing from the server that the cockpit's context
// does not already carry.
import { SettingsTabs } from "./settings-tabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <SettingsTabs />
      {children}
    </div>
  );
}
