import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import AdmZip from "adm-zip";
import inquirer from "inquirer";
import { info, warn, success, error } from "./tui";

const OWNER = "XXanderWP";
const REPO = "TerminalUtils";
const CACHE_NAME = ".update_cache.json";
const FLAG_NAME = ".update_available.json";

function getLocalVersion(scriptDir = __dirname) {
  const packagePath = path.join(scriptDir, "package.json");
  if (!fs.existsSync(packagePath)) {
    return null;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}

function parseVersion(version: string | null) {
  if (!version) {
    return [];
  }

  return version
    .replace(/^[vV]/, "")
    .split(".")
    .map((segment) => Number.parseInt(segment, 10))
    .filter((n) => Number.isFinite(n));
}

function compareVersions(a: string | null, b: string | null) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const max = Math.max(left.length, right.length);

  for (let i = 0; i < max; i += 1) {
    const lv = left[i] || 0;
    const rv = right[i] || 0;
    if (lv > rv) {
      return 1;
    }
    if (lv < rv) {
      return -1;
    }
  }

  return 0;
}

async function fetchLatestRelease(owner = OWNER, repo = REPO) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "terminalutils-update-check",
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch release: ${response.status}`);
  }

  const data = await response.json();
  return {
    tag: data.tag_name,
    zipballUrl: data.zipball_url,
  };
}

function readCache(scriptDir = __dirname) {
  const cachePath = path.join(scriptDir, CACHE_NAME);
  if (!fs.existsSync(cachePath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, any>, scriptDir = __dirname) {
  const cachePath = path.join(scriptDir, CACHE_NAME);
  fs.writeFileSync(cachePath, JSON.stringify(cache), "utf8");
}

function writeFlag(latest: string, local: string, scriptDir = __dirname) {
  const flagPath = path.join(scriptDir, FLAG_NAME);
  fs.writeFileSync(
    flagPath,
    JSON.stringify({ latest, local, timestamp: Date.now() / 1000 }),
    "utf8"
  );
}

function readFlag(scriptDir = __dirname) {
  const flagPath = path.join(scriptDir, FLAG_NAME);
  if (!fs.existsSync(flagPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(flagPath, "utf8"));
  } catch {
    return null;
  }
}

function removeFlag(scriptDir = __dirname) {
  const flagPath = path.join(scriptDir, FLAG_NAME);
  if (fs.existsSync(flagPath)) {
    fs.rmSync(flagPath, { force: true });
  }
}

function notifyIfUpdateAvailable(scriptDir = __dirname) {
  const flag = readFlag(scriptDir);
  if (flag?.latest) {
    warn(
      `Update available (${flag.latest}). Open the main utility and choose \"Check for updates\".`
    );
  }
}

function copyRecursive(src: string, dest: string) {
  if (!fs.existsSync(src)) {
    return;
  }

  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (entry === ".git" || entry === ".github") {
        continue;
      }
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }

  const skip = ["install.sh", "install.ps1", "install.psh"];
  if (skip.includes(path.basename(src))) {
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

async function downloadFile(url: string, outPath: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "terminalutils-update-check",
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(outPath, Buffer.from(arrayBuffer));
}

async function downloadAndApplyUpdate(zipUrl: string, destDir = __dirname) {
  if (!zipUrl) {
    error("No zip URL for release.");
    return false;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "terminalutils-update-"));
  const zipPath = path.join(tmpRoot, "release.zip");
  const extractPath = path.join(tmpRoot, "extract");

  try {
    info("Downloading update package...");
    await downloadFile(zipUrl, zipPath);

    info("Extracting update package...");
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);

    const entries = fs
      .readdirSync(extractPath)
      .map((name) => path.join(extractPath, name))
      .filter((entry) => fs.statSync(entry).isDirectory());
    const top = entries.length > 0 ? entries[0] : extractPath;

    for (const name of fs.readdirSync(top)) {
      copyRecursive(path.join(top, name), path.join(destDir, name));
    }

    try {
      execSync("chmod +x *.sh *.js *.ps1", {
        cwd: destDir,
        stdio: "ignore",
      });
    } catch {
      // Ignore chmod errors.
    }

    success("Update applied. Restart the utility.");
    return true;
  } catch (updateError: any) {
    error(`Update failed: ${updateError.message}`);
    return false;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function resolveLatest(scriptDir = __dirname) {
  const cache = readCache(scriptDir);
  const now = Date.now() / 1000;
  const lastChecked = Number(cache.last_checked || 0);
  if (now - lastChecked < 300 && cache.latest_tag && cache.latest_zip) {
    return {
      tag: cache.latest_tag,
      zipballUrl: cache.latest_zip,
    };
  }

  const latest = await fetchLatestRelease();
  writeCache(
    {
      last_checked: now,
      latest_tag: latest.tag,
      latest_zip: latest.zipballUrl,
    },
    scriptDir
  );
  return latest;
}

async function backgroundCheck(scriptDir = __dirname) {
  try {
    const latest = await resolveLatest(scriptDir);
    const localVersion = getLocalVersion(scriptDir);

    if (!localVersion || !latest?.tag) {
      return;
    }

    if (compareVersions(latest.tag, localVersion) > 0) {
      writeFlag(latest.tag, localVersion, scriptDir);
    } else {
      removeFlag(scriptDir);
    }
  } catch {
    // Silent in background mode.
  }
}

async function interactiveCheck(scriptDir = __dirname) {
  try {
    const latest = await resolveLatest(scriptDir);
    const localVersion = getLocalVersion(scriptDir);

    if (!localVersion) {
      warn("Local version not found in package.json.");
      return;
    }

    if (!latest?.tag) {
      warn("No releases found on GitHub.");
      return;
    }

    const cmp = compareVersions(latest.tag, localVersion);
    if (cmp > 0) {
      warn(`Update available: ${latest.tag} (local: ${localVersion}).`);
      writeFlag(latest.tag, localVersion, scriptDir);
      const { applyNow } = await inquirer.prompt([
        {
          type: "confirm",
          name: "applyNow",
          message: `Download and apply ${latest.tag} now?`,
          default: false,
        },
      ]);

      if (!applyNow) {
        info("Update skipped.");
        return;
      }

      const updated = await downloadAndApplyUpdate(latest.zipballUrl, scriptDir);
      if (updated) {
        removeFlag(scriptDir);
      }
      return;
    }

    if (cmp === 0) {
      success(`You are up to date (version ${localVersion}).`);
      removeFlag(scriptDir);
      return;
    }

    info(`Local version (${localVersion}) is newer than latest release (${latest.tag}).`);
    removeFlag(scriptDir);
  } catch (checkError: any) {
    error(`Could not check updates: ${checkError.message}`);
  }
}

export {
  backgroundCheck,
  interactiveCheck,
  notifyIfUpdateAvailable,
  compareVersions,
  getLocalVersion,
};
