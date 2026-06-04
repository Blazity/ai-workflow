// apps/dashboard/app/(cockpit)/layout.tsx
import { CockpitShell } from "./cockpit-shell";

export default function CockpitLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <CockpitShell>{children}</CockpitShell>;
}
