import { spawnSync } from "node:child_process";
import inquirer from "inquirer";
import { backgroundCheck, notifyIfUpdateAvailable } from "./update-check";
import { DetectApp } from "./utils/path";
import { bullets, error, header, info, kv, panel, section, success, warn } from "./utils/tui";

const scriptDir = __dirname;

type PortProcess = {
  protocol: "tcp" | "udp";
  state: string;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  pid: number | null;
  processName: string;
};

type PortFilters = {
  query: string;
  protocol: "all" | "tcp" | "udp";
};

function runCapture(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if ((result.error as any)?.code === "ENOENT") {
    return null;
  }

  if (result.status !== 0) {
    return null;
  }

  return result.stdout || "";
}

function parseEndpointPort(endpoint: string) {
  const normalized = endpoint.trim();
  if (!normalized) {
    return { host: "", port: NaN };
  }

  const bracketMatch = normalized.match(/^\[(.+)\]:(\d+)$/);
  if (bracketMatch) {
    return {
      host: bracketMatch[1],
      port: Number.parseInt(bracketMatch[2], 10),
    };
  }

  const tailPortMatch = normalized.match(/^(.*):(\d+)$/);
  if (tailPortMatch) {
    return {
      host: tailPortMatch[1],
      port: Number.parseInt(tailPortMatch[2], 10),
    };
  }

  return { host: normalized, port: NaN };
}

function parseSsOutput(raw: string) {
  const entries: PortProcess[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^(tcp|udp)\S*\s+(\S+)\s+\S+\s+\S+\s+(\S+)\s+(\S+)(?:\s+(.+))?$/i);
    if (!match) {
      continue;
    }

    const proto = match[1].toLowerCase().startsWith("tcp") ? "tcp" : "udp";
    const state = match[2].toUpperCase();
    const local = parseEndpointPort(match[3]);
    const remote = parseEndpointPort(match[4]);
    const users = match[5] || "";

    if (!Number.isFinite(local.port)) {
      continue;
    }

    const pidMatch = users.match(/pid=(\d+)/);
    const procMatch = users.match(/\("([^"]+)"/);
    entries.push({
      protocol: proto,
      state,
      localAddress: local.host || "*",
      localPort: local.port,
      remoteAddress: remote.host || "*",
      pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : null,
      processName: procMatch?.[1] || "unknown",
    });
  }

  return entries;
}

function parseLsofOutput(raw: string) {
  const entries: PortProcess[] = [];

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
    const protocolRaw = columns[7]?.toLowerCase() || "";
    const protocol: "tcp" | "udp" = protocolRaw.includes("udp") ? "udp" : "tcp";
    const endpointColumn = columns.slice(8).join(" ");
    const endpoint = endpointColumn.split("->")[0].trim();
    const local = parseEndpointPort(endpoint);
    if (!Number.isFinite(local.port)) {
      continue;
    }

    const stateMatch = endpointColumn.match(/\(([^)]+)\)/);
    entries.push({
      protocol,
      state: stateMatch?.[1]?.toUpperCase() || "UNKNOWN",
      localAddress: local.host || "*",
      localPort: local.port,
      remoteAddress: "*",
      pid: Number.isFinite(pid) ? pid : null,
      processName,
    });
  }

  return entries;
}

function getOccupiedPorts() {
  if (process.platform === "linux") {
    const ssRaw = runCapture("ss", ["-H", "-lntup"]);
    if (ssRaw) {
      const parsed = parseSsOutput(ssRaw);
      if (parsed.length > 0) {
        return parsed;
      }
    }
  }

  const lsofRaw = runCapture("lsof", ["-nP", "-i", "-sTCP:LISTEN"]);
  if (lsofRaw) {
    const parsed = parseLsofOutput(lsofRaw);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  return [];
}

function applyFilters(entries: PortProcess[], filters: PortFilters) {
  const query = filters.query.trim().toLowerCase();

  return entries.filter((item) => {
    if (filters.protocol !== "all" && item.protocol !== filters.protocol) {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = [
      item.protocol,
      item.state,
      String(item.localPort),
      item.localAddress,
      item.processName,
      item.pid ? String(item.pid) : "",
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  });
}

function sortEntries(entries: PortProcess[]) {
  return [...entries].sort((a, b) => {
    if (a.localPort !== b.localPort) {
      return a.localPort - b.localPort;
    }
    if (a.protocol !== b.protocol) {
      return a.protocol.localeCompare(b.protocol);
    }
    return (a.pid || 0) - (b.pid || 0);
  });
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
      throw new Error((result.stderr || "taskkill failed").trim());
    }
    return;
  }

  process.kill(pid, force ? "SIGKILL" : "SIGTERM");
}

async function maybeKillProcess(entry: PortProcess) {
  if (!entry.pid) {
    warn("No PID found for this socket; cannot terminate process.");
    return;
  }

  const { proceed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "proceed",
      message: `Terminate PID ${entry.pid} (${entry.processName})?`,
      default: false,
    },
  ]);

  if (!proceed) {
    info("Termination canceled.");
    return;
  }

  const { force } = await inquirer.prompt([
    {
      type: "confirm",
      name: "force",
      message: "Use force kill if graceful stop fails?",
      default: false,
    },
  ]);

  try {
    killByPid(entry.pid, force);
    success(`PID ${entry.pid} terminated.`);
  } catch (killError: any) {
    error(killError?.message || "Failed to terminate process.");
  }
}

function formatPortRow(entry: PortProcess) {
  const pid = entry.pid ? String(entry.pid) : "-";
  return `${entry.protocol.toUpperCase().padEnd(3, " ")} :${String(entry.localPort).padEnd(5, " ")} ${entry.processName.padEnd(18, " ")} pid=${pid.padEnd(7, " ")} ${entry.state}`;
}

async function inspectPortEntry(entry: PortProcess) {
  panel("Port details", [
    kv("Protocol", entry.protocol.toUpperCase()),
    kv("Local", `${entry.localAddress}:${entry.localPort}`),
    kv("Remote", entry.remoteAddress),
    kv("State", entry.state),
    kv("Process", entry.processName),
    kv("PID", entry.pid ? String(entry.pid) : "unknown"),
  ]);

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "Port action:",
      choices: [
        { name: "Kill process", value: "kill" },
        { name: "Back", value: "back" },
      ],
    },
  ]);

  if (action === "kill") {
    await maybeKillProcess(entry);
  }
}

async function runPortsMenu() {
  await backgroundCheck(scriptDir);
  notifyIfUpdateAvailable(scriptDir);
  header("TerminalUtils", "Occupied ports monitor");
  panel("Ports", [
    "Inspect occupied ports and mapped processes.",
    "Filter by query/protocol and terminate process by PID.",
    "Tip: some systems require elevated privileges to see all processes.",
  ], { borderColor: "yellow" });

  const filters: PortFilters = {
    query: "",
    protocol: "all",
  };

  while (true) {
    const allEntries = sortEntries(getOccupiedPorts());
    const filtered = applyFilters(allEntries, filters);

    section("Current view", "Active sockets and controls");
    bullets([
      `Total sockets: ${allEntries.length}`,
      `Visible after filter: ${filtered.length}`,
      `Protocol filter: ${filters.protocol.toUpperCase()}`,
      `Search filter: ${filters.query || "none"}`,
      "Mouse support depends on terminal emulator and prompt backend.",
    ]);

    const portChoices = filtered.slice(0, 40).map((entry, index) => ({
      name: formatPortRow(entry),
      value: `entry:${index}`,
    }));

    const choices: { name: string; value: string }[] = [
      ...portChoices,
      { name: "Refresh list", value: "refresh" },
      { name: "Set text filter", value: "set-filter" },
      { name: "Clear text filter", value: "clear-filter" },
      { name: "Set protocol filter", value: "set-protocol" },
      { name: "Back", value: "back" },
    ];

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "Select a port entry or action:",
        pageSize: 18,
        choices,
      },
    ]);

    if (action === "back") {
      return;
    }

    if (action === "refresh") {
      continue;
    }

    if (action === "set-filter") {
      const { query } = await inquirer.prompt([
        {
          type: "input",
          name: "query",
          message: "Filter by port, process, PID, state, or address:",
          default: filters.query,
        },
      ]);
      filters.query = query.trim();
      continue;
    }

    if (action === "clear-filter") {
      filters.query = "";
      continue;
    }

    if (action === "set-protocol") {
      const { protocol } = await inquirer.prompt([
        {
          type: "list",
          name: "protocol",
          message: "Choose protocol filter:",
          choices: [
            { name: "All", value: "all" },
            { name: "TCP", value: "tcp" },
            { name: "UDP", value: "udp" },
          ],
          default: filters.protocol,
        },
      ]);
      filters.protocol = protocol;
      continue;
    }

    const index = Number.parseInt(action.replace("entry:", ""), 10);
    const selected = filtered[index];
    if (!selected) {
      warn("Selected entry is no longer available. Refreshing view.");
      continue;
    }

    await inspectPortEntry(selected);
  }
}

if (DetectApp() === "ports") {
  runPortsMenu().catch((runError) => {
    error(runError.message);
    process.exit(1);
  });
}

export {
  runPortsMenu,
};