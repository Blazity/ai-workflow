import { redirect } from "next/navigation";

// Repository scripts replaced pre-PR checks; this route only forwards anyone
// who still has the old link bookmarked.
export default function ChecksPage() {
  redirect("/scripts");
}
