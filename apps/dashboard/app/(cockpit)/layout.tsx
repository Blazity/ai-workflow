// apps/dashboard/app/(cockpit)/layout.tsx
import { CockpitShell } from "./cockpit-shell";
import { requireSession } from "@/lib/auth/session";

export default async function CockpitLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireSession();
  return <CockpitShell>{children}</CockpitShell>;
}
