import { resolve } from "node:path";
import { checkLocalSkills } from "../src/harness-profiles/local-skills.js";

// The same expression the Nitro `compiled` hook copies from, spelled out rather
// than resolved: validating any other directory would pass a build that ships
// something else.
const directory = resolve(process.cwd(), "..", "..", "skills");
const result = await checkLocalSkills(directory);

if (result.ok) {
  console.log(result.message);
} else {
  console.error(result.message);
  process.exit(1);
}
