#!/usr/bin/env node

import path from "node:path";
import { readdir } from "node:fs/promises";
import { build } from "esbuild";

const projectRoot = process.cwd();
const srcCoreDir = path.join(projectRoot, "src", "core");
const outDir = path.join(projectRoot, "dist");

async function collectTypeScriptEntries(dir) {
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries = [];

  for (const dirent of dirents) {
    const fullPath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      const nested = await collectTypeScriptEntries(fullPath);
      entries.push(...nested);
      continue;
    }

    if (dirent.isFile() && dirent.name.endsWith(".ts")) {
      entries.push(fullPath);
    }
  }

  return entries;
}

async function run() {
  const entryPoints = await collectTypeScriptEntries(srcCoreDir);

  if (entryPoints.length === 0) {
    throw new Error("No TypeScript entry points found in src/core.");
  }

  await build({
    entryPoints,
    outdir: outDir,
    outbase: srcCoreDir,
    platform: "node",
    format: "cjs",
    target: "node18",
    bundle: true,
    sourcemap: false,
    minify: false,
    logLevel: "info",
  });
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
