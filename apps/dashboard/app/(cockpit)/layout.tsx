// apps/dashboard/app/(cockpit)/layout.tsx
import { CockpitShell } from "./cockpit-shell";
import { requireSession } from "@/lib/auth/session";

export default async function CockpitLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  return <CockpitShell session={session}>{children}</CockpitShell>;
}
