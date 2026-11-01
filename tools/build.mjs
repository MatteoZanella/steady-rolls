/**
 * Build the module's package in dist/: the scripts bundled into one minified file and the styles
 * minified, each with its source map, and the other files Foundry loads copied as they are.
 * With a release tag ("v1.2.3", or "v1.2.3-beta.1" for a prerelease), module.json takes its
 * version and the download URL of its release.
 * Usage: node tools/build.mjs [tag]
 */
import { build } from "esbuild";
import { cp, readFile, rm, writeFile } from "node:fs/promises";

const DIST = "dist";
const COPY = ["templates", "lang", "LICENSE", "NOTICE", "README.md"];

const manifest = JSON.parse(await readFile("module.json", "utf8"));
const tag = process.argv[2];
if ( tag ) {
  const version = tag.replace(/^v/, "");
  if ( !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version) ) throw new Error(`"${tag}" is not a version tag (v1.2.3)`);
  manifest.version = version;
  manifest.download = `${manifest.url}/releases/download/${tag}/module.zip`;
}

await rm(DIST, { recursive: true, force: true });
await build({
  entryPoints: [...manifest.esmodules, ...manifest.styles],
  outdir: DIST,
  outbase: ".",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
  logLevel: "warning"
});
await Promise.all(COPY.map(path => cp(path, `${DIST}/${path}`, { recursive: true })));
await writeFile(`${DIST}/module.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${manifest.id} ${manifest.version} in ${DIST}/`);
