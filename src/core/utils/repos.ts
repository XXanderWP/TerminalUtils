import fs from "node:fs";
import path from "node:path";

function loadRepoOptions(scriptDir = __dirname) {
  const jsonPath = path.join(scriptDir, "repos.json");
  if (!fs.existsSync(jsonPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRepoOptions(options: any[], scriptDir = __dirname) {
  const jsonPath = path.join(scriptDir, "repos.json");
  fs.writeFileSync(jsonPath, `${JSON.stringify(options, null, 2)}\n`, "utf8");
}

export {
  loadRepoOptions,
  saveRepoOptions,
};