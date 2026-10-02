import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import inquirer from "inquirer";
import { backgroundCheck, notifyIfUpdateAvailable } from "./update-check";
import { DetectApp } from "./utils/path";
import { bullets, error, header, info, kv, panel, section, success, warn } from "./utils/tui";

const scriptDir = __dirname;
const configDir = path.join(os.homedir(), ".config", "terminalutils");
const configFile = path.join(configDir, "migrate.json");

type ServerProfile = {
  host: string;
  user: string;
  port: number;
  key?: string;
};

type FolderEntry = {
  path: string;
  docker: boolean;
};

type MigrateConfig = {
  source?: ServerProfile;
  destination?: ServerProfile;
  folders: FolderEntry[];
  mirror: boolean;
};

type RemoteResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function emptyConfig(): MigrateConfig {
  return { folders: [], mirror: false };
}

function loadConfig(): MigrateConfig {
  if (!fs.existsSync(configFile)) {
    return emptyConfig();
  }

  try {
    const value = JSON.parse(fs.readFileSync(configFile, "utf8"));
    return {
      source: value.source,
      destination: value.destination,
      folders: Array.isArray(value.folders)
        ? value.folders.filter((entry: any) => typeof entry.path === "string")
        : [],
      mirror: value.mirror === true,
    };
  } catch {
    warn(`Could not read ${configFile}; starting with empty migration settings.`);
    return emptyConfig();
  }
}

function saveConfig(config: MigrateConfig) {
  fs.mkdirSync(configDir, { recursive: true });
  const tempFile = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, configFile);
  if (process.platform !== "win32") {
    fs.chmodSync(configFile, 0o600);
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sshTarget(server: ServerProfile) {
  const host = server.host.includes(":") && !server.host.startsWith("[")
    ? `[${server.host}]`
    : server.host;
  return `${server.user}@${host}`;
}

function sshArgs(server: ServerProfile, agentForwarding = false) {
  const args = ["-p", String(server.port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new"];
  if (server.key) {
    args.push("-i", server.key);
  }
  if (agentForwarding) {
    args.unshift("-A");
  }
  return args;
}

function runRemote(server: ServerProfile, command: string, agentForwarding = false): Promise<RemoteResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [
      ...sshArgs(server, agentForwarding),
      sshTarget(server),
      command,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function remoteCommand(args: string[]) {
  return args.map(shellQuote).join(" ");
}

function validateHost(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9.:_%\-]*$/.test(value.trim()) || "Enter a valid hostname or IP address.";
}

function validateUser(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value.trim()) || "Use a valid SSH username.";
}

function validatePort(value: string) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 || "Port must be between 1 and 65535.";
}

async function configureServer(config: MigrateConfig, role: "source" | "destination") {
  const current = config[role];
  const label = role === "source" ? "source" : "destination";
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "host",
      message: `${label} host or IP:`,
      default: current?.host || "",
      validate: validateHost,
    },
    {
      type: "input",
      name: "user",
      message: "SSH user:",
      default: current?.user || "",
      validate: validateUser,
    },
    {
      type: "input",
      name: "port",
      message: "SSH port:",
      default: String(current?.port || 22),
      validate: validatePort,
    },
    {
      type: "input",
      name: "key",
      message: "Private key path for this direct connection (optional):",
      default: current?.key || "",
    },
  ]);

  config[role] = {
    host: answers.host.trim(),
    user: answers.user.trim(),
    port: Number(answers.port),
    key: answers.key.trim() || undefined,
  };
  saveConfig(config);
  success(`${label[0].toUpperCase()}${label.slice(1)} profile saved.`);
}

function requireSource(config: MigrateConfig) {
  if (config.source) {
    return config.source;
  }
  throw new Error("Configure the source server first.");
}

function requireBothServers(config: MigrateConfig) {
  if (!config.source || !config.destination) {
    throw new Error("Configure both source and destination servers first.");
  }
  return { source: config.source, destination: config.destination };
}

async function remoteComposeFile(server: ServerProfile, folderPath: string) {
  const candidates = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  const checks = candidates.map((name) => `if [ -f ${shellQuote(`${folderPath}/${name}`)} ]; then printf '%s' ${shellQuote(name)}; exit 0; fi`);
  const result = await runRemote(server, `${checks.join("; ")}; exit 1`);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function addFolder(config: MigrateConfig) {
  let source: ServerProfile;
  try {
    source = requireSource(config);
  } catch (addError: any) {
    error(addError.message);
    return;
  }

  const { folderPath } = await inquirer.prompt([
    {
      type: "input",
      name: "folderPath",
      message: "Absolute folder path on the source server:",
      validate: (value: string) => {
        if (!value.trim().startsWith("/")) {
          return "Use an absolute POSIX path, such as /srv/app.";
        }
        if (value.trim().replace(/\/+$/, "") === "") {
          return "The filesystem root cannot be transferred as a folder.";
        }
        return true;
      },
    },
  ]);
  const normalizedPath = folderPath.trim().replace(/\/+$/, "");
  const exists = await runRemote(source, `test -d ${shellQuote(normalizedPath)}`);
  if (exists.code !== 0) {
    error(`Directory not found or source is unreachable: ${normalizedPath}`);
    if (exists.stderr.trim()) info(exists.stderr.trim().split(/\r?\n/).slice(-3).join("\n"));
    return;
  }

  const composeFile = await remoteComposeFile(source, normalizedPath);
  let docker = false;
  if (composeFile) {
    const answer = await inquirer.prompt([
      {
        type: "confirm",
        name: "docker",
        message: `Found ${composeFile}. Stop it on source and start it on destination after transfer?`,
        default: true,
      },
    ]);
    docker = answer.docker;
  }

  config.folders.push({ path: normalizedPath, docker });
  saveConfig(config);
  success(`Added ${normalizedPath}.`);
}

async function removeFolder(config: MigrateConfig) {
  if (config.folders.length === 0) {
    info("No folders are configured.");
    return;
  }

  const { selected } = await inquirer.prompt([
    {
      type: "list",
      name: "selected",
      message: "Select a folder to remove:",
      choices: config.folders.map((folder, index) => ({ name: folder.path, value: index })),
    },
  ]);
  const [removed] = config.folders.splice(selected, 1);
  saveConfig(config);
  success(`Removed ${removed.path}.`);
}

async function toggleFolderDocker(config: MigrateConfig) {
  if (config.folders.length === 0) {
    info("No folders are configured.");
    return;
  }

  const { selected } = await inquirer.prompt([
    {
      type: "list",
      name: "selected",
      message: "Toggle Docker Compose handling:",
      choices: config.folders.map((folder, index) => ({
        name: `${folder.path}  ·  Docker ${folder.docker ? "on" : "off"}`,
        value: index,
      })),
    },
  ]);
  config.folders[selected].docker = !config.folders[selected].docker;
  saveConfig(config);
  success(`Docker handling ${config.folders[selected].docker ? "enabled" : "disabled"} for ${config.folders[selected].path}.`);
}

async function testConnections(config: MigrateConfig) {
  let servers: { source: ServerProfile; destination: ServerProfile };
  try {
    servers = requireBothServers(config);
  } catch (testError: any) {
    error(testError.message);
    return;
  }

  section("Connection checks");
  const checks: Array<{ label: string; run: () => Promise<RemoteResult> }> = [
    { label: "This machine → source", run: () => runRemote(servers.source, "printf ok") },
    { label: "This machine → destination", run: () => runRemote(servers.destination, "printf ok") },
    {
      label: "Source → destination through forwarded agent",
      run: () => {
        const args = ["ssh", "-p", String(servers.destination.port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", sshTarget(servers.destination), "printf", "ok"];
        return runRemote(servers.source, remoteCommand(args), true);
      },
    },
    { label: "rsync available on source", run: () => runRemote(servers.source, "command -v rsync >/dev/null") },
    { label: "rsync available on destination", run: () => runRemote(servers.destination, "command -v rsync >/dev/null") },
  ];

  for (const check of checks) {
    try {
      const result = await check.run();
      if (result.code === 0) {
        success(check.label);
      } else {
        error(`${check.label}: ${result.stderr.trim().split(/\r?\n/).slice(-1)[0] || `exit code ${result.code}`}`);
      }
    } catch (checkError: any) {
      error(`${check.label}: ${checkError.message}`);
    }
  }
}

function renderProgress(percent: number, detail: string) {
  const bounded = Math.max(0, Math.min(percent, 100));
  const width = 28;
  const filled = Math.round((bounded / 100) * width);
  const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
  process.stdout.write(`\r[${bar}] ${String(bounded).padStart(3)}%  ${detail.slice(0, 36).padEnd(36)}`);
}

async function runRsync(source: ServerProfile, destination: ServerProfile, folder: FolderEntry, mirror: boolean) {
  const normalizedPath = folder.path.replace(/\/+$/, "") || "/";
  const remoteShell = [
    "ssh",
    "-p", String(destination.port),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=accept-new",
  ].join(" ");
  const args = ["rsync", "-az", "--info=progress2", "--human-readable", "--protect-args", "-e", remoteShell];
  if (mirror) args.push("--delete");
  args.push("--", `${normalizedPath}/`, `${sshTarget(destination)}:${normalizedPath}/`);
  const command = remoteCommand(args);

  return new Promise<number>((resolve, reject) => {
    const child = spawn("ssh", [
      ...sshArgs(source, true),
      sshTarget(source),
      command,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let pending = "";
    let stderr = "";
    let lastDetail = "starting rsync";
    let latestPercent = 0;

    const consume = (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/[\r\n]+/);
      pending = lines.pop() || "";
      for (const line of lines) {
        const percent = line.match(/(\d{1,3})%/);
        if (percent) {
          latestPercent = Number(percent[1]);
          lastDetail = line.trim().replace(/\s+/g, " ");
          renderProgress(latestPercent, lastDetail);
        }
      }
    };

    child.stdout.setEncoding("utf8").on("data", consume);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      consume(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      process.stdout.write("\n");
      if ((code ?? 1) !== 0 && stderr.trim()) {
        info(stderr.trim().split(/\r?\n/).slice(-6).join("\n"));
      }
      if ((code ?? 1) === 0) {
        renderProgress(100, lastDetail || "complete");
        process.stdout.write("\n");
      }
      resolve(code ?? 1);
    });
  });
}

async function composeAction(server: ServerProfile, folderPath: string, composeFile: string, action: "stop" | "up -d") {
  const command = `cd ${shellQuote(folderPath)} && docker compose -f ${shellQuote(composeFile)} ${action}`;
  return runRemote(server, command);
}

async function transfer(config: MigrateConfig) {
  let servers: { source: ServerProfile; destination: ServerProfile };
  try {
    servers = requireBothServers(config);
  } catch (transferError: any) {
    error(transferError.message);
    return;
  }
  if (config.folders.length === 0) {
    info("Add at least one folder before starting a transfer.");
    return;
  }

  panel("Transfer plan", [
    kv("From", `${sshTarget(servers.source)}:${servers.source.port}`),
    kv("To", `${sshTarget(servers.destination)}:${servers.destination.port}`),
    kv("Folders", String(config.folders.length)),
    kv("Mirror", config.mirror ? "on (destination-only files will be deleted)" : "off"),
  ]);
  bullets([
    "Files travel directly from source to destination; they are not stored locally.",
    "The source server must be able to authenticate to destination through your forwarded ssh-agent.",
  ]);

  const { proceed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "proceed",
      message: config.mirror
        ? "Start transfer? Mirror mode can permanently delete files on destination."
        : "Start transfer now?",
      default: false,
    },
  ]);
  if (!proceed) {
    info("Transfer canceled.");
    return;
  }

  let failed: string[] = [];
  for (const [index, folder] of config.folders.entries()) {
    console.log(`\n[${index + 1}/${config.folders.length}] ${folder.path}`);
    let composeFile = "";

    if (folder.docker) {
      composeFile = await remoteComposeFile(servers.source, folder.path);
      if (!composeFile) {
        error(`No Docker Compose file found in ${folder.path}; skipping this folder.`);
        failed.push(folder.path);
        continue;
      }
      const stopped = await composeAction(servers.source, folder.path, composeFile, "stop");
      if (stopped.code !== 0) {
        error(`Could not stop source containers for ${folder.path}.`);
        if (stopped.stderr.trim()) info(stopped.stderr.trim().split(/\r?\n/).slice(-4).join("\n"));
        failed.push(folder.path);
        continue;
      }
      info("Source containers stopped.");
    }

    const parentDir = path.posix.dirname(folder.path);
    const destinationDir = await runRemote(servers.destination, `mkdir -p -- ${shellQuote(parentDir)}`);
    if (destinationDir.code !== 0) {
      error(`Could not prepare destination for ${folder.path}.`);
      failed.push(folder.path);
      if (folder.docker && composeFile) {
        const resumed = await composeAction(servers.source, folder.path, composeFile, "up -d");
        if (resumed.code !== 0) error(`Could not restart source containers for ${folder.path}.`);
      }
      continue;
    }

    try {
      const result = await runRsync(servers.source, servers.destination, folder, config.mirror);
      if (result !== 0) {
        error(`rsync failed for ${folder.path} (exit ${result}).`);
        failed.push(folder.path);
        if (folder.docker && composeFile) {
          const resumed = await composeAction(servers.source, folder.path, composeFile, "up -d");
          if (resumed.code !== 0) error(`Could not restart source containers for ${folder.path}.`);
        }
        continue;
      }
      success(`Transferred ${folder.path}.`);
    } catch (transferError: any) {
      error(`Transfer failed for ${folder.path}: ${transferError.message}`);
      failed.push(folder.path);
      if (folder.docker && composeFile) {
        const resumed = await composeAction(servers.source, folder.path, composeFile, "up -d");
        if (resumed.code !== 0) error(`Could not restart source containers for ${folder.path}.`);
      }
      continue;
    }

    if (folder.docker && composeFile) {
      const started = await composeAction(servers.destination, folder.path, composeFile, "up -d");
      if (started.code !== 0) {
        error(`Files transferred, but destination containers failed to start for ${folder.path}.`);
        if (started.stderr.trim()) info(started.stderr.trim().split(/\r?\n/).slice(-4).join("\n"));
        failed.push(folder.path);
      } else {
        success("Destination containers started.");
      }
    }
  }

  if (failed.length === 0) {
    success(`All ${config.folders.length} folder(s) transferred.`);
  } else {
    warn(`Transfer completed with ${failed.length} failed folder(s): ${failed.join(", ")}`);
  }
}

async function runMigrateMenu() {
  await backgroundCheck(scriptDir);
  notifyIfUpdateAvailable(scriptDir);
  header("TerminalUtils", "Server-to-server migration");

  while (true) {
    const config = loadConfig();
    panel("Migration setup", [
      kv("Source", config.source ? `${sshTarget(config.source)}:${config.source.port}` : "not configured"),
      kv("Destination", config.destination ? `${sshTarget(config.destination)}:${config.destination.port}` : "not configured"),
      kv("Folders", String(config.folders.length)),
      kv("Mirror", config.mirror ? "on" : "off"),
      kv("Settings", configFile),
    ]);
    section("Migration actions", "Configure endpoints, test access, then transfer");

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "Choose an action:",
        choices: [
          { name: "Configure source server", value: "source" },
          { name: "Configure destination server", value: "destination" },
          { name: "Add folder from source", value: "add-folder" },
          { name: "Remove folder", value: "remove-folder" },
          { name: "Toggle Docker handling for a folder", value: "docker" },
          { name: `Toggle mirror mode (--delete): ${config.mirror ? "on" : "off"}`, value: "mirror" },
          { name: "Test connections and rsync", value: "test" },
          { name: "Start transfer", value: "transfer" },
          { name: "Back", value: "back" },
        ],
      },
    ]);

    if (action === "back") return;
    if (action === "source" || action === "destination") {
      await configureServer(config, action);
    } else if (action === "add-folder") {
      await addFolder(config);
    } else if (action === "remove-folder") {
      await removeFolder(config);
    } else if (action === "docker") {
      await toggleFolderDocker(config);
    } else if (action === "mirror") {
      config.mirror = !config.mirror;
      saveConfig(config);
      if (config.mirror) warn("Mirror mode enabled: destination-only files will be deleted during transfer.");
      else success("Mirror mode disabled.");
    } else if (action === "test") {
      await testConnections(config);
    } else if (action === "transfer") {
      await transfer(config);
    }
  }
}

if (DetectApp() === "migrate") {
  runMigrateMenu().catch((runError: any) => {
    error(runError.message || String(runError));
    process.exit(1);
  });
}

export { runMigrateMenu };