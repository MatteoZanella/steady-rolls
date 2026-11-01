/**
 * Print a version's section of CHANGELOG.md, for its release notes: "## [1.2.3]", or for a
 * prerelease without a section of its own, "## [Unreleased]". Fails when the section is missing
 * or empty, so no release goes out without notes.
 * Usage: node tools/changelog.mjs v1.2.3
 */
import { readFile } from "node:fs/promises";

const version = (process.argv[2] ?? "").replace(/^v/, "");
const sections = {};
for ( const section of (await readFile("CHANGELOG.md", "utf8")).split(/^## /m).slice(1) ) {
  const [heading, ...body] = section.split("\n");
  const name = /^\[(.+?)\]/.exec(heading)?.[1];
  if ( name ) sections[name] = body.join("\n").trim();
}
const notes = sections[version] || (version.includes("-") ? sections.Unreleased : "");
if ( !notes ) {
  console.error(`CHANGELOG.md has no notes for ${version}: add a "## [${version}]" section.`);
  process.exit(1);
}
console.log(notes);
