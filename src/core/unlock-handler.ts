import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import inquirer from "inquirer";
import { backgroundCheck, notifyIfUpdateAvailable } from "./update-check";
import { DetectApp } from "./utils/path";
import { bullets, error, header, info, kv, panel, section, success, warn } from "./utils/tui";

const scriptDir = __dirname;

type FileLockProcess = {
  pid: number;
  processName: string;
  user?: string;
};

type UnlockOptions = {
  yes: boolean;
  force: boolean;
};

function runCapture(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return { stdout: "", stderr: "", status: null, missing: true };
  }

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
    missing: false,
  };
}

function parseFlags(): UnlockOptions {
  const args = process.argv.slice(2).map((arg) => arg.toLowerCase());
  return {
    yes: args.includes("-y") || args.includes("--yes"),
    force: args.includes("-f") || args.includes("--force"),
  };
}

function getPathFromArgs() {
  const args = process.argv.slice(2);
  const unlockIndex = args.findIndex((arg) => arg.toLowerCase() === "unlock");
  const positional = unlockIndex >= 0 ? args.slice(unlockIndex + 1) : args;
  const pathArg = positional.find((arg) => !arg.startsWith("-"));
  return pathArg?.trim() || "";
}

function resolveTargetPath(inputPath: string) {
  const expanded = inputPath.startsWith("~")
    ? path.join(process.env.HOME || "", inputPath.slice(1))
    : inputPath;
  const resolved = path.resolve(expanded);

  if (!existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }

  return resolved;
}

function parseLsofOutput(raw: string) {
  const byPid = new Map<number, FileLockProcess>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("COMMAND")) {
      continue;
    }

    const columns = trimmed.split(/\s+/);
    if (columns.length < 9) {
      continue;
    }

    const processName = columns[0];
    const pid = Number.parseInt(columns[1], 10);
    const user = columns[2];
    if (!Number.isFinite(pid)) {
      continue;
    }

    if (!byPid.has(pid)) {
      byPid.set(pid, { pid, processName, user });
    }
  }

  return [...byPid.values()];
}

function parseFuserOutput(raw: string) {
  const byPid = new Map<number, FileLockProcess>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes("USER") || trimmed.includes("PID ACCESS")) {
      continue;
    }

    const match = trimmed.match(/(\S+)\s+(\d+)\s+\S+\s+(.+)$/);
    if (!match) {
      continue;
    }

    const user = match[1];
    const pid = Number.parseInt(match[2], 10);
    const processName = match[3].trim();
    if (!Number.isFinite(pid)) {
      continue;
    }

    if (!byPid.has(pid)) {
      byPid.set(pid, { pid, processName, user });
    }
  }

  return [...byPid.values()];
}

function parseHandleOutput(raw: string, targetPath: string) {
  const byPid = new Map<number, FileLockProcess>();
  const normalizedTarget = targetPath.toLowerCase();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.toLowerCase().includes(normalizedTarget)) {
      continue;
    }

    const pidMatch = trimmed.match(/pid:\s*(\d+)/i);
    if (!pidMatch) {
      continue;
    }

    const pid = Number.parseInt(pidMatch[1], 10);
    const processName = trimmed.split(/\s+/)[0] || "unknown";
    if (!Number.isFinite(pid)) {
      continue;
    }

    if (!byPid.has(pid)) {
      byPid.set(pid, { pid, processName });
    }
  }

  return [...byPid.values()];
}

function findProcessesWithLsof(targetPath: string, recursive: boolean) {
  const args = recursive ? ["-nP", "+D", targetPath] : ["-nP", "--", targetPath];
  const result = runCapture("lsof", args);
  if (result.missing) {
    return { processes: [], permissionDenied: false, toolMissing: true };
  }

  const permissionDenied = /permission denied/i.test(`${result.stdout}\n${result.stderr}`);
  const processes = parseLsofOutput(`${result.stdout}\n${result.stderr}`);
  return { processes, permissionDenied, toolMissing: false };
}

function findProcessesWithFuser(targetPath: string) {
  const result = runCapture("fuser", ["-v", targetPath]);
  if (result.missing) {
    return { processes: [], permissionDenied: false, toolMissing: true };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const permissionDenied = /permission denied|operation not permitted/i.test(combined);
  const processes = parseFuserOutput(combined);
  return { processes, permissionDenied, toolMissing: false };
}

function findProcessesWithHandle(targetPath: string) {
  const result = runCapture("handle", ["-accepteula", "-nobanner", targetPath]);
  if (result.missing) {
    return { processes: [], permissionDenied: false, toolMissing: true };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const permissionDenied = /access is denied|administrator/i.test(combined);
  const processes = parseHandleOutput(combined, targetPath);
  return { processes, permissionDenied, toolMissing: false };
}

function findLockingProcesses(targetPath: string) {
  const isDirectory = statSync(targetPath).isDirectory();
  let permissionDenied = false;
  let toolMissing = false;

  if (process.platform === "win32") {
    const handleResult = findProcessesWithHandle(targetPath);
    permissionDenied = handleResult.permissionDenied;
    toolMissing = handleResult.toolMissing;
    if (handleResult.processes.length > 0) {
      return { processes: handleResult.processes, permissionDenied, toolMissing };
    }
    return { processes: [], permissionDenied, toolMissing };
  }

  if (process.platform === "linux" && isDirectory) {
    const fuserResult = findProcessesWithFuser(targetPath);
    permissionDenied = permissionDenied || fuserResult.permissionDenied;
    if (fuserResult.processes.length > 0) {
      return { processes: fuserResult.processes, permissionDenied, toolMissing: false };
    }
  }

  const lsofResult = findProcessesWithLsof(targetPath, isDirectory);
  permissionDenied = permissionDenied || lsofResult.permissionDenied;
  toolMissing = lsofResult.toolMissing;

  if (lsofResult.processes.length > 0) {
    return { processes: lsofResult.processes, permissionDenied, toolMissing: false };
  }

  if (process.platform === "linux" && !isDirectory) {
    const fuserResult = findProcessesWithFuser(targetPath);
    permissionDenied = permissionDenied || fuserResult.permissionDenied;
    if (fuserResult.processes.length > 0) {
      return { processes: fuserResult.processes, permissionDenied, toolMissing: false };
    }
  }

  return { processes: [], permissionDenied, toolMissing };
}

function suggestElevation(targetPath: string) {
  if (process.platform === "win32") {
    warn("Insufficient privileges to inspect or terminate the process.");
    bullets([
      "Re-run the terminal as Administrator.",
      `Example: unlock "${targetPath}"`,
      "On Windows, install Sysinternals Handle if process lookup fails.",
    ]);
    return;
  }

  warn("Insufficient privileges to inspect or terminate the process.");
  bullets([
    "Re-run with elevated rights (root/admin).",
    `Example: sudo unlock "${targetPath}"`,
    "Some processes owned by other users are visible only to root.",
  ]);
}

function killByPid(pid: number, force: boolean) {
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (force) {
      args.push("/F");
    }
    const result = spawnSync("taskkill", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      const message = (result.stderr || result.stdout || "taskkill failed").trim();
      const err = new Error(message) as Error & { code?: string };
      if (/access is denied/i.test(message)) {
        err.code = "EACCES";
      }
      throw err;
    }
    return;
  }

  process.kill(pid, force ? "SIGKILL" : "SIGTERM");
}

async function resolveInputPath(providedPath?: string) {
  const trimmed = providedPath?.trim() || getPathFromArgs();
  if (trimmed) {
    return resolveTargetPath(trimmed);
  }

  const { inputPath } = await inquirer.prompt([
    {
      type: "input",
      name: "inputPath",
      message: "Path to file or directory to unlock:",
      validate: (value: string) => {
        const candidate = value.trim();
        if (!candidate) {
          return "Path is required.";
        }
        try {
          resolveTargetPath(candidate);
          return true;
        } catch (validationError: any) {
          return validationError?.message || "Invalid path.";
        }
      },
    },
  ]);

  return resolveTargetPath(inputPath);
}

async function confirmKill(processes: FileLockProcess[], options: UnlockOptions) {
  if (options.yes) {
    return true;
  }

  const { proceed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "proceed",
      message: `Terminate ${processes.length} process(es) holding this path?`,
      default: false,
    },
  ]);

  return proceed;
}

async function killProcesses(processes: FileLockProcess[], targetPath: string, options: UnlockOptions) {
  let hadPermissionError = false;

  for (const entry of processes) {
    try {
      killByPid(entry.pid, options.force);
      success(`PID ${entry.pid} (${entry.processName}) terminated.`);
    } catch (killError: any) {
      const code = killError?.code;
      const message = killError?.message || "Failed to terminate process.";
      if (code === "EPERM" || code === "EACCES" || /access is denied|operation not permitted/i.test(message)) {
        hadPermissionError = true;
        error(`PID ${entry.pid}: ${message}`);
      } else {
        error(`PID ${entry.pid}: ${message}`);
      }
    }
  }

  if (hadPermissionError) {
    suggestElevation(targetPath);
    return;
  }

  const remaining = findLockingProcesses(targetPath).processes;
  if (remaining.length === 0) {
    success("Path is no longer held by tracked processes.");
  } else {
    warn(`${remaining.length} process(es) still appear to hold this path.`);
    suggestElevation(targetPath);
  }
}

async function runUnlock(providedPath?: string) {
  const options = parseFlags();
  await backgroundCheck(scriptDir);
  notifyIfUpdateAvailable(scriptDir);
  header("TerminalUtils", "Unlock file or directory");
  panel("Unlock", [
    "Find processes that keep a file or folder open and terminate them.",
    "Pass a path as an argument or enter it in the prompt.",
    "Use -y to skip confirmation and -f for force kill.",
  ], { borderColor: "yellow" });

  const targetPath = await resolveInputPath(providedPath);
  section("Target", "Resolved path");
  bullets([targetPath]);

  const { processes, permissionDenied, toolMissing } = findLockingProcesses(targetPath);

  if (toolMissing && process.platform === "win32") {
    warn("Process lookup tool is not available.");
    bullets([
      "Install Sysinternals Handle and add it to PATH.",
      "Download: https://learn.microsoft.com/sysinternals/downloads/handle",
      "Then re-run unlock as Administrator.",
    ]);
    return;
  }

  if (toolMissing && processes.length === 0) {
    error("Required tools not found. Install lsof (and optionally fuser on Linux).");
    return;
  }

  if (permissionDenied && processes.length === 0) {
    warn("Could not inspect all processes for this path.");
    suggestElevation(targetPath);
    return;
  }

  if (processes.length === 0) {
    info("No processes currently hold this path.");
    return;
  }

  section("Locking processes", `${processes.length} found`);
  for (const entry of processes) {
    console.log(
      kv(
        `PID ${entry.pid}`,
        `${entry.processName}${entry.user ? ` (${entry.user})` : ""}`
      )
    );
  }

  if (permissionDenied) {
    warn("Some processes may be hidden due to insufficient privileges.");
  }

  const proceed = await confirmKill(processes, options);
  if (!proceed) {
    info("Termination canceled.");
    return;
  }

  if (!options.force && !options.yes) {
    const { force } = await inquirer.prompt([
      {
        type: "confirm",
        name: "force",
        message: "Use force kill (SIGKILL / taskkill /F)?",
        default: false,
      },
    ]);
    options.force = force;
  }

  await killProcesses(processes, targetPath, options);
}

if (DetectApp() === "unlock") {
  runUnlock().catch((runError) => {
    error(runError.message);
    process.exit(1);
  });
}

export {
  runUnlock,
};
