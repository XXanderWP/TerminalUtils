import fs from "node:fs";
import { spawnSync } from "node:child_process";
import inquirer from "inquirer";
import { backgroundCheck, notifyIfUpdateAvailable } from "./update-check";
import { header, info, warn, success, error, panel, kv, section, bullets, step } from "./utils/tui";
import { DetectApp } from "./utils/path";

const scriptDir = __dirname;

function commandExists(command: string) {
  const check = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return check.status === 0;
}

function runCommand(command: string, args: string[], options: { capture?: boolean } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: process.platform === "win32",
  });

  if ((result.error as any)?.code === "ENOENT") {
    throw new Error(`${command} not found in PATH.`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr || `${command} ${args.join(" ")} failed.`;
    throw new Error(stderr.trim());
  }

  return result.stdout || "";
}

function ensureGitReady() {
  if (!commandExists("git")) {
    throw new Error("git not found in PATH.");
  }

  const status = runCommand("git", ["status", "--porcelain"], { capture: true }).trim();
  if (status.length > 0) {
    throw new Error("Git working tree has uncommitted changes.");
  }
}

function bumpSemver(version: string, bumpType: "patch" | "minor" | "major") {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Invalid semantic version: ${version}`);
  }

  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);

  if (bumpType === "patch") {
    return `${major}.${minor}.${patch + 1}`;
  }

  if (bumpType === "minor") {
    return `${major}.${minor + 1}.0`;
  }

  if (bumpType === "major") {
    return `${major + 1}.0.0`;
  }

  throw new Error(`Unsupported bump type: ${bumpType}`);
}

function gitCommitAndTag(version: string, filesToAdd: string[]) {
  runCommand("git", ["add", ...filesToAdd]);
  runCommand("git", ["commit", "-m", `v${version}`]);
  runCommand("git", ["tag", `v${version}`]);
  success(`Created commit and tag for v${version}.`);
}

function updatePyprojectVersion(newVersion: string) {
  const pyprojectPath = "pyproject.toml";
  const content = fs.readFileSync(pyprojectPath, "utf8");

  let updated = content.replace(
    /(^\[project\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
    `$1${newVersion}$2`
  );

  if (updated === content) {
    updated = content.replace(
      /(^\[tool\.poetry\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
      `$1${newVersion}$2`
    );
  }

  if (updated === content) {
    throw new Error("Failed to update version in pyproject.toml.");
  }

  fs.writeFileSync(pyprojectPath, updated, "utf8");
}

function readPyprojectVersion() {
  const content = fs.readFileSync("pyproject.toml", "utf8");
  const projectMatch = content.match(/\[project\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (projectMatch?.[1]) {
    return projectMatch[1];
  }

  const poetryMatch = content.match(/\[tool\.poetry\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (poetryMatch?.[1]) {
    return poetryMatch[1];
  }

  throw new Error("Could not find version in pyproject.toml.");
}

function runPythonProjectBump(bumpType: "patch" | "minor" | "major") {
  ensureGitReady();
  const current = readPyprojectVersion();
  const next = bumpSemver(current, bumpType);
  info(`Current version: ${current}`);
  info(`New version: ${next}`);

  updatePyprojectVersion(next);
  gitCommitAndTag(next, ["pyproject.toml"]);
}

function runVersionFileBump(bumpType: "patch" | "minor" | "major") {
  ensureGitReady();
  const current = fs.readFileSync("VERSION", "utf8").trim();
  const next = bumpSemver(current, bumpType);
  info(`Current version: ${current}`);
  info(`New version: ${next}`);

  fs.writeFileSync("VERSION", `${next}\n`, "utf8");
  gitCommitAndTag(next, ["VERSION"]);
}

function runNpmVersionBump(bumpType: "patch" | "minor" | "major") {
  if (!commandExists("npm")) {
    throw new Error("npm not found in PATH.");
  }

  runCommand("npm", ["version", bumpType]);
}

async function runNewVersionMenu() {
  await backgroundCheck(scriptDir);
  notifyIfUpdateAvailable(scriptDir);
  header("TerminalUtils", "Version bump utility");
  panel("Release flow", [
    "Choose the project manifest to update.",
    "A clean git tree is required for pyproject.toml and VERSION flows.",
    "Version bumps create commit and tag where applicable.",
  ]);

  const hasPackageJson = fs.existsSync("package.json");
  const hasPyproject = fs.existsSync("pyproject.toml");
  const hasVersionFile = fs.existsSync("VERSION");

  if (!hasPackageJson && !hasPyproject && !hasVersionFile) {
    throw new Error("No package.json, pyproject.toml, or VERSION file found.");
  }

  section("Detected manifests", "Only available release targets are shown");
  bullets([
    `package.json: ${hasPackageJson ? "available" : "missing"}`,
    `pyproject.toml: ${hasPyproject ? "available" : "missing"}`,
    `VERSION: ${hasVersionFile ? "available" : "missing"}`,
  ]);

  const projectChoices = [];
  if (hasPackageJson) {
    projectChoices.push({ name: "Node.js (package.json)", value: "npm" });
  }
  if (hasPyproject) {
    projectChoices.push({ name: "Python (pyproject.toml)", value: "python" });
  }
  if (hasVersionFile) {
    projectChoices.push({ name: "Plain VERSION file", value: "version_file" });
  }
  projectChoices.push({ name: "Exit", value: "exit" });

  let projectType = projectChoices[0].value;
  if (projectChoices.length > 2) {
    const projectAnswer = await inquirer.prompt([
      {
        type: "list",
        name: "projectType",
        message: "Select project type:",
        choices: projectChoices,
      },
    ]);
    projectType = projectAnswer.projectType;
  }

  if (projectType === "exit") {
    info("Exiting.");
    return;
  }

  const bumpAnswer = await inquirer.prompt([
    {
      type: "list",
      name: "bumpType",
      message: "Select version bump type:",
      choices: [
        { name: "Patch (0.0.X)", value: "patch" },
        { name: "Minor (0.X.0)", value: "minor" },
        { name: "Major (X.0.0)", value: "major" },
        { name: "Exit", value: "exit" },
      ],
    },
  ]);

  if (bumpAnswer.bumpType === "exit") {
    info("Exiting.");
    return;
  }

  panel("Selected change", [
    kv("Project", projectType),
    kv("Bump", bumpAnswer.bumpType),
  ]);

  if (projectType === "npm") {
    step("Run npm version", bumpAnswer.bumpType);
    runNpmVersionBump(bumpAnswer.bumpType);
    success("npm version completed.");
    return;
  }

  if (projectType === "python") {
    step("Update pyproject.toml", bumpAnswer.bumpType);
    runPythonProjectBump(bumpAnswer.bumpType);
    return;
  }

  step("Update VERSION file", bumpAnswer.bumpType);
  runVersionFileBump(bumpAnswer.bumpType);
}

if (DetectApp() === "version") {
  runNewVersionMenu().catch((runError) => {
    error(runError.message);
    process.exit(1);
  });
}

export {
  runNewVersionMenu,
};
