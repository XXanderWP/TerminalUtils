import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import inquirer from "inquirer";
import chalk from "chalk";
import { backgroundCheck, notifyIfUpdateAvailable } from "./update-check";
import { DetectApp } from "./utils/path";
import { error, header, info, success, warn } from "./utils/tui";

const scriptDir = __dirname;

type DiskEntry = {
  name: string;
  path: string;
  kind: "directory" | "file";
  size: number;
  children: DiskEntry[];
  parent: DiskEntry | null;
};

function allocatedSize(stats: fs.Stats) {
  return typeof stats.blocks === "number" ? stats.blocks * 512 : stats.size;
}

function getLinuxMountPoints() {
  if (process.platform !== "linux") {
    return [];
  }

  try {
    const mountInfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
    return mountInfo.split(/\r?\n/).flatMap((line) => {
      const fields = line.split(" - ")[0]?.split(" ");
      const mountPoint = fields?.[4];
      if (!mountPoint) {
        return [];
      }
      return [mountPoint.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))];
    });
  } catch {
    return [];
  }
}

function isInside(parentPath: string, candidatePath: string) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function scanDirectory(
  directoryPath: string,
  name: string,
  parent: DiskEntry | null,
  ignoredMountPoints: Set<string>,
  rootPath: string,
  progress: { scanned: number }
): Promise<DiskEntry> {
  const stats = await fs.promises.lstat(directoryPath);
  const entry: DiskEntry = {
    name,
    path: directoryPath,
    kind: stats.isDirectory() ? "directory" : "file",
    size: allocatedSize(stats),
    children: [],
    parent,
  };

  if (!stats.isDirectory()) {
    progress.scanned += 1;
    if (progress.scanned % 2000 === 0) {
      process.stdout.write(`\rScanning ${progress.scanned.toLocaleString()} entries...`);
    }
    return entry;
  }

  let children: fs.Dirent[];
  try {
    children = await fs.promises.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return entry;
  }

  for (const child of children) {
    const childPath = path.join(directoryPath, child.name);
    if (ignoredMountPoints.has(childPath) && childPath !== rootPath) {
      continue;
    }

    try {
      const childStats = await fs.promises.lstat(childPath);
      if (childStats.isSymbolicLink()) {
        const size = allocatedSize(childStats);
        entry.size += size;
        entry.children.push({
          name: child.name,
          path: childPath,
          kind: "file",
          size,
          children: [],
          parent: entry,
        });
        progress.scanned += 1;
        continue;
      }

      const scannedChild = await scanDirectory(childPath, child.name, entry, ignoredMountPoints, rootPath, progress);
      entry.children.push(scannedChild);
      entry.size += scannedChild.size;
    } catch {
      progress.scanned += 1;
    }
  }

  sortChildren(entry);
  return entry;
}

function sortChildren(entry: DiskEntry) {
  entry.children.sort((left, right) => right.size - left.size || left.name.localeCompare(right.name));
}

function formatSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

function truncate(value: string, width: number) {
  if (value.length <= width) {
    return value;
  }
  return width > 1 ? `${value.slice(0, width - 1)}…` : value.slice(0, width);
}

function drawDiskBrowser(current: DiskEntry, selectedIndex: number, statusMessage: string) {
  const terminalRows = process.stdout.rows || 24;
  const terminalColumns = process.stdout.columns || 80;
  const pageSize = Math.max(1, terminalRows - 8);
  const start = Math.max(0, Math.min(selectedIndex - pageSize + 1, current.children.length - pageSize));
  const visibleEntries = current.children.slice(start, start + pageSize);
  const barWidth = Math.max(5, Math.min(16, terminalColumns - 58));
  const nameWidth = Math.max(8, terminalColumns - barWidth - 34);
  const parentSize = Math.max(1, current.size);

  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(`${chalk.bold.cyan("Disk usage")}  ${chalk.dim(current.path)}\n`);
  process.stdout.write(`${formatSize(current.size)} total  |  ${current.children.length} entries\n\n`);

  if (visibleEntries.length === 0) {
    process.stdout.write(chalk.dim("  (empty directory)\n"));
  }

  visibleEntries.forEach((entry, offset) => {
    const index = start + offset;
    const marker = entry.kind === "directory" ? "[D]" : "[F]";
    const name = truncate(entry.name, nameWidth);
    const relativeSize = entry.size / parentSize;
    const filledBars = Math.round(relativeSize * barWidth);
    const bar = chalk.green("█".repeat(filledBars)) + chalk.dim("░".repeat(barWidth - filledBars));
    const percentage = `${(relativeSize * 100).toFixed(1)}%`;
    const row = `${marker} ${name.padEnd(nameWidth)} ${bar} ${percentage.padStart(6)} ${formatSize(entry.size).padStart(9)}`;
    process.stdout.write(index === selectedIndex ? chalk.black.bgCyan(` ${row} `) + "\n" : ` ${row}\n`);
  });

  process.stdout.write("\n↑/↓ select  Enter open  Backspace/← parent  r rescan  d delete  q quit\n");
  if (statusMessage) {
    process.stdout.write(`${statusMessage}\n`);
  }
}

async function rescan(entry: DiskEntry, rootPath: string, ignoredMountPoints: Set<string>) {
  const parent = entry.parent;
  const progress = { scanned: 0 };
  const updated = await scanDirectory(entry.path, entry.name, parent, ignoredMountPoints, rootPath, progress);
  if (parent) {
    const difference = updated.size - entry.size;
    parent.size += difference;
    sortChildren(parent);
    const index = parent.children.indexOf(entry);
    if (index >= 0) {
      parent.children[index] = updated;
    }
  }
  return updated;
}

async function deleteEntry(entry: DiskEntry) {
  const { confirmed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmed",
      message: `Permanently delete ${entry.path} (${formatSize(entry.size)})?`,
      default: false,
    },
  ]);

  if (!confirmed) {
    return false;
  }

  await fs.promises.rm(entry.path, { recursive: true, force: false });
  const parent = entry.parent;
  if (parent) {
    parent.children = parent.children.filter((child) => child !== entry);
    for (let ancestor: DiskEntry | null = parent; ancestor; ancestor = ancestor.parent) {
      ancestor.size -= entry.size;
    }
  }
  return true;
}

async function runDiskBrowser(root: DiskEntry, ignoredMountPoints: Set<string>) {
  let current = root;
  let selectedIndex = 0;
  let statusMessage = "";
  let busy = false;

  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("Disk browser requires an interactive terminal.");
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise<void>((resolve, reject) => {
    const finish = (failure?: Error) => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[2J\x1b[H");
      if (failure) {
        reject(failure);
      } else {
        resolve();
      }
    };

    const redraw = () => drawDiskBrowser(current, selectedIndex, statusMessage);

    const onKeypress = async (_input: string, key: readline.Key) => {
      if (busy) {
        return;
      }

      statusMessage = "";
      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        finish();
        return;
      }
      if (key.name === "up") {
        selectedIndex = Math.max(0, selectedIndex - 1);
      } else if (key.name === "down") {
        selectedIndex = Math.min(Math.max(0, current.children.length - 1), selectedIndex + 1);
      } else if (key.name === "backspace" || key.name === "left") {
        if (current.parent) {
          const previous = current;
          current = current.parent;
          selectedIndex = Math.max(0, current.children.findIndex((child) => child.path === previous.path));
        }
      } else if (key.name === "return") {
        const selected = current.children[selectedIndex];
        if (selected?.kind === "directory") {
          current = selected;
          selectedIndex = 0;
        }
      } else if (key.name === "r") {
        busy = true;
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\x1b[2J\x1b[HRescanning current directory...\n");
        try {
          current = await rescan(current, root.path, ignoredMountPoints);
          selectedIndex = Math.min(selectedIndex, Math.max(0, current.children.length - 1));
          statusMessage = "Current directory rescanned.";
        } catch (rescanError: any) {
          statusMessage = `Rescan failed: ${rescanError.message}`;
        }
        process.stdin.setRawMode(true);
        process.stdin.resume();
        busy = false;
      } else if (key.name === "d") {
        const selected = current.children[selectedIndex];
        if (selected) {
          busy = true;
          process.stdin.setRawMode(false);
          process.stdin.pause();
          try {
            const removed = await deleteEntry(selected);
            if (removed) {
              success(`Deleted ${selected.name}; sizes updated.`);
              selectedIndex = Math.min(selectedIndex, Math.max(0, current.children.length - 1));
            } else {
              info("Deletion canceled.");
            }
          } catch (deleteError: any) {
            warn(`Could not delete entry: ${deleteError.message}`);
          }
          process.stdin.setRawMode(true);
          process.stdin.resume();
          busy = false;
        }
      }

      redraw();
    };

    process.stdin.on("keypress", onKeypress);
    redraw();
  });
}

async function runDiskUsage() {
  await backgroundCheck(scriptDir);
  notifyIfUpdateAvailable(scriptDir);
  header("TerminalUtils", "Disk usage analyzer");

  const { rootPath: requestedPath } = await inquirer.prompt([
    {
      type: "input",
      name: "rootPath",
      message: "Directory to scan:",
      default: process.cwd(),
      validate: async (value: string) => {
        try {
          return (await fs.promises.stat(path.resolve(value))).isDirectory() || "Select a directory.";
        } catch {
          return "Directory does not exist or cannot be accessed.";
        }
      },
    },
  ]);

  let ignoreMounts = false;
  if (process.platform === "linux") {
    const answer = await inquirer.prompt([
      {
        type: "confirm",
        name: "ignoreMounts",
        message: "Ignore other mounted filesystems under this directory?",
        default: true,
      },
    ]);
    ignoreMounts = answer.ignoreMounts;
  }

  const rootPath = await fs.promises.realpath(path.resolve(requestedPath));
  const ignoredMountPoints = new Set(
    ignoreMounts
      ? getLinuxMountPoints().filter((mountPoint) => mountPoint !== rootPath && isInside(rootPath, mountPoint))
      : []
  );
  const progress = { scanned: 0 };
  process.stdout.write("Scanning directory tree...\n");
  const root = await scanDirectory(rootPath, path.basename(rootPath) || rootPath, null, ignoredMountPoints, rootPath, progress);
  process.stdout.write(`\rScanned ${progress.scanned.toLocaleString()} entries.\n`);
  await runDiskBrowser(root, ignoredMountPoints);
}

if (DetectApp() === "disk-usage") {
  runDiskUsage().catch((runError: any) => {
    error(runError.message || "Disk usage scan failed.");
    process.exit(1);
  });
}

export { runDiskUsage };