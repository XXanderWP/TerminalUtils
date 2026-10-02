import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Entry } from "@napi-rs/keyring";

const SERVICE_NAME = "TerminalUtils";
const GITHUB_TOKEN_ACCOUNT = "github-token";
const STORED_SECRET_MARKER = "@keyring";

function getEntry(account: string) {
  const options = process.platform === "linux"
    ? { linux: { store: "secret-service" as const } }
    : undefined;

  return new Entry(SERVICE_NAME, account, options);
}

export function getSecret(account: string) {
  return getEntry(account).getPassword() || "";
}

export function setSecret(account: string, secret: string) {
  getEntry(account).setPassword(secret);
}

export function deleteSecret(account: string) {
  getEntry(account).deletePassword();
}

export function migrateLegacySecrets(scriptDir: string) {
  const authFile = path.join(os.homedir(), ".terminalutils", "github-auth.json");
  if (fs.existsSync(authFile)) {
    let parsed: { token?: unknown };
    try {
      parsed = JSON.parse(fs.readFileSync(authFile, "utf8"));
    } catch {
      throw new Error("Could not migrate legacy GitHub credentials: the saved auth file is invalid.");
    }

    if (parsed.token !== undefined) {
      if (typeof parsed.token !== "string" || !parsed.token) {
        throw new Error("Could not migrate legacy GitHub credentials: the saved token is invalid.");
      }
      setSecret(GITHUB_TOKEN_ACCOUNT, parsed.token);
      fs.rmSync(authFile, { force: true });
    }
  }

  const serversFile = path.join(scriptDir, "servers.txt");
  if (!fs.existsSync(serversFile)) {
    return;
  }

  const lines = fs.readFileSync(serversFile, "utf8").split(/\r?\n/);
  let changed = false;
  const sanitized = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("|")) {
      return line;
    }

    const [name = "", address = "", password = ""] = trimmed.split("|").map((part) => part.trim());
    if (!name || !address || !password) {
      return line;
    }

    if (password === STORED_SECRET_MARKER) {
      return `${name}|${address}|${STORED_SECRET_MARKER}`;
    }

    setSecret(`ssh:${address}`, password);
    changed = true;
    return `${name}|${address}|${STORED_SECRET_MARKER}`;
  });

  if (changed) {
    const tempFile = `${serversFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, sanitized.join("\n"), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempFile, serversFile);
    if (process.platform !== "win32") {
      fs.chmodSync(serversFile, 0o600);
    }
  }
}

export { GITHUB_TOKEN_ACCOUNT };