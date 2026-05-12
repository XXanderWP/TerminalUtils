#!/usr/bin/env node

import path from "node:path";
import { build } from "esbuild";

const projectRoot = process.cwd();
const srcCoreDir = path.join(projectRoot, "src", "core");
const outFile = path.join(projectRoot, "dist", "main.js");

async function run() {
  await build({
    entryPoints: [path.join(srcCoreDir, "util-handler.ts")], // Основной входной файл
    outfile: outFile,
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
