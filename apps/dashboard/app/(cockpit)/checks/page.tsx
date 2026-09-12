import { redirect } from "next/navigation";

// The Repositories page replaced the Repository scripts screen, which had
// already replaced pre-PR checks; this route only forwards anyone who still has
// the oldest link bookmarked.
export default function ChecksPage() {
  redirect("/repositories");
}
