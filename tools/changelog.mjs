/**
 * Print a release's notes: its version's section of CHANGELOG.md ("## [1.2.3]", or for a
 * prerelease without a section of its own, "## [Unreleased]"), then the manifest URL that installs
 * this release. Fails when the section is missing or empty, so no release goes out without notes.
 * Usage: node tools/changelog.mjs v1.2.3
 */
import { readFile } from "node:fs/promises";

const tag = process.argv[2] ?? "";
const version = tag.replace(/^v/, "");
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
const { url } = JSON.parse(await readFile("module.json", "utf8"));
console.log(`${notes}

### Installation

To install this release rather than the latest, use this manifest URL in Foundry (Add-on Modules → Install Module):

\`${url}/releases/download/${tag}/module.json\`

`);
