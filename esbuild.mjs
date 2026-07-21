import { build } from "esbuild";
import { cp, readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf-8"));
const define = { __APP_VERSION__: JSON.stringify(pkg.version) };

// Node CLI — deps stay external (installed via npm), ESM output.
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
  logLevel: "info",
  define,
});

// Browser bundles — App Bridge + panel fully inlined so the published
// package works offline without a browser-side node_modules.
for (const [entry, outfile] of [
  ["src/web/host-page.ts", "dist/web/host-page.js"],
  ["src/web/sandbox-page.ts", "dist/web/sandbox.js"],
]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    sourcemap: false,
    logLevel: "info",
    define,
  });
}

await cp("src/web/host-page.html", "dist/web/host-page.html");
await cp("src/web/sandbox.html", "dist/web/sandbox.html");
console.log("build complete");
