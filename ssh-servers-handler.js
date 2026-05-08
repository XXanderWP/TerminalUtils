const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const inquirer = require("inquirer");
const {
  backgroundCheck,
  notifyIfUpdateAvailable,
} = require("./update-check");
const { header, info, warn, error, success } = require("./tui");

const scriptDir = __dirname;
const serversFile = path.join(scriptDir, "servers.txt");

function ensureServersFile() {
  if (fs.existsSync(serversFile)) {
    return;
  }

  const content = [
    "# Servers file for TerminalUtils",
    "# Format: Display Name|user@host|optional_password",
    "# Lines starting with '#' are ignored.",
    "",
  ].join("\n");

  fs.writeFileSync(serversFile, content, "utf8");
  info(`Created template ${serversFile}`);
}

function loadServers() {
  ensureServersFile();
  const lines = fs.readFileSync(serversFile, "utf8").split(/\r?\n/);
  const servers = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("|")) {
      continue;
    }

    const [name = "", addr = "", password = ""] = trimmed.split("|").map((part) => part.trim());
    if (!name || !addr) {
      continue;
    }

    servers.push({
      name,
      addr,
      password: password || null,
    });
  }

  return servers;
}

function saveServer(server) {
  const line = [server.name, server.addr, server.password || ""].join("|");
  fs.appendFileSync(serversFile, `${line}\n`, "utf8");
}

function extractHost(addr) {
  const normalized = addr.includes("@") ? addr.split("@")[1] : addr;
  return normalized.includes(":") ? normalized.split(":")[0] : normalized;
}

function hasBinary(binary) {
  const check = spawnSync(binary, ["--version"], { stdio: "ignore" });
  return check.status === 0;
}

function probeSsh(addr) {
  const probe = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=yes", addr, "true"],
    { encoding: "utf8" }
  );

  return {
    ok: probe.status === 0,
    stderr: probe.stderr || "",
  };
}

function removeKnownHost(host) {
  const byKeygen = spawnSync("ssh-keygen", ["-R", host], { stdio: "ignore" });
  if (byKeygen.status === 0) {
    success(`Removed known_hosts entry for ${host} via ssh-keygen.`);
    return;
  }

  const knownHosts = path.join(os.homedir(), ".ssh", "known_hosts");
  if (!fs.existsSync(knownHosts)) {
    warn(`No known_hosts file at ${knownHosts}.`);
    return;
  }

  const lines = fs.readFileSync(knownHosts, "utf8").split(/\r?\n/);
  const filtered = lines.filter((line) => !line.includes(host));
  fs.writeFileSync(knownHosts, `${filtered.join("\n")}\n`, "utf8");
  success(`Removed lines containing ${host} from ${knownHosts}.`);
}

function runSsh(server) {
  const platform = process.platform;

  if (server.password) {
    if (platform === "win32" && hasBinary("plink")) {
      spawnSync("plink", [server.addr, "-pw", server.password], { stdio: "inherit" });
      return;
    }

    if (platform !== "win32" && hasBinary("sshpass")) {
      spawnSync("sshpass", ["-p", server.password, "ssh", server.addr], { stdio: "inherit" });
      return;
    }

    warn("Password is set but sshpass/plink was not found; falling back to regular ssh.");
  }

  spawnSync("ssh", [server.addr], { stdio: "inherit" });
}

async function clearKnownHosts() {
  const knownHosts = path.join(os.homedir(), ".ssh", "known_hosts");
  const { proceed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "proceed",
      message: "Clear entire ~/.ssh/known_hosts file?",
      default: false,
    },
  ]);

  if (!proceed) {
    info("Operation canceled.");
    return;
  }

  fs.mkdirSync(path.dirname(knownHosts), { recursive: true });
  fs.writeFileSync(knownHosts, "", "utf8");
  success(`Cleared ${knownHosts}.`);
}

async function addServer() {
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "Display name:",
      validate: (value) => (value.trim().length > 0 ? true : "Display name is required."),
    },
    {
      type: "input",
      name: "host",
      message: "Host or IP:",
      validate: (value) => (value.trim().length > 0 ? true : "Host is required."),
    },
    {
      type: "input",
      name: "user",
      message: "User:",
      validate: (value) => (value.trim().length > 0 ? true : "User is required."),
    },
    {
      type: "password",
      name: "password",
      message: "Password (optional, leave empty for key auth):",
      mask: "*",
    },
  ]);

  saveServer({
    name: answers.name.trim(),
    addr: `${answers.user.trim()}@${answers.host.trim()}`,
    password: answers.password.trim() || null,
  });

  warn("Server password is stored in plain text if provided.");
  success("Server added.");
}

async function runSshServersMenu() {
  await backgroundCheck(scriptDir);
  notifyIfUpdateAvailable(scriptDir);
  header("TerminalUtils", "SSH connection manager");

  while (true) {
    const servers = loadServers();
    const choices = servers.map((server, index) => ({
      name: `${server.name} (${server.addr})`,
      value: `server:${index}`,
    }));

    choices.push(
      { name: "Add server", value: "add" },
      { name: "Clear SSH known_hosts", value: "clear" },
      { name: "Back", value: "back" }
    );

    const { selected } = await inquirer.prompt([
      {
        type: "list",
        name: "selected",
        message: "Select a server action:",
        choices,
      },
    ]);

    if (selected === "back") {
      return;
    }

    if (selected === "add") {
      await addServer();
      continue;
    }

    if (selected === "clear") {
      await clearKnownHosts();
      continue;
    }

    const index = Number.parseInt(selected.replace("server:", ""), 10);
    const server = servers[index];
    if (!server) {
      error("Invalid server selection.");
      continue;
    }

    info(`Connecting to ${server.addr}...`);
    const probe = probeSsh(server.addr);
    if (probe.ok) {
      runSsh(server);
      continue;
    }

    const stderr = probe.stderr.toUpperCase();
    if (
      stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED") ||
      stderr.includes("HOST KEY VERIFICATION FAILED")
    ) {
      const host = extractHost(server.addr);
      warn(`Host key mismatch detected for ${host}.`);
      const { fixHost } = await inquirer.prompt([
        {
          type: "confirm",
          name: "fixHost",
          message: `Remove known_hosts entry for ${host} and retry?`,
          default: false,
        },
      ]);

      if (fixHost) {
        removeKnownHost(host);
        runSsh(server);
      }
      continue;
    }

    error(probe.stderr || "Failed to connect via ssh.");
  }
}

if (require.main === module) {
  runSshServersMenu().catch((runError) => {
    error(runError.message);
    process.exit(1);
  });
}

module.exports = {
  runSshServersMenu,
};
