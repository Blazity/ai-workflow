// apps/dashboard/app/(cockpit)/trace/page.tsx — Run trace ("/trace")
"use client";

import { useRouter } from "next/navigation";

import { TraceScreen } from "@/components/cockpit/screens/trace";
import { useCockpit } from "@/components/cockpit/context";

export default function TracePage() {
  const router = useRouter();
  const { activeRun } = useCockpit();
  return <TraceScreen run={activeRun} onBack={() => router.push("/runs")} />;
}
