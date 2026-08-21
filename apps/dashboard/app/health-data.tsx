import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { HealthScreen } from "@/components/cockpit/screens/health";

/** Renders the screen only; the scan itself runs solely on the Scan button. */
export async function HealthData() {
  const session = await requireSession();
  if (!session.canManageUsers) redirect("/");
  return <HealthScreen />;
}
