import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import inquirer from "inquirer";
import { info, warn, success, panel, kv, section, bullets, step } from "./tui";

const OAUTH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID || "Ov23liMczaz46uIHIsZv";
const OAUTH_SCOPE = "repo";

function getConfigDir() {
  return path.join(os.homedir(), ".terminalutils");
}

function getAuthFilePath() {
  return path.join(getConfigDir(), "github-auth.json");
}

function ensureConfigDir() {
  fs.mkdirSync(getConfigDir(), { recursive: true });
}

function readStoredAuth() {
  const authPath = getAuthFilePath();
  if (!fs.existsSync(authPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.token ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredAuth(token: string) {
  ensureConfigDir();
  const authPath = getAuthFilePath();
  fs.writeFileSync(authPath, `${JSON.stringify({ token }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  try {
    fs.chmodSync(authPath, 0o600);
  } catch {
    // Best effort on non-POSIX platforms.
  }
}

function removeStoredAuth() {
  const authPath = getAuthFilePath();
  if (fs.existsSync(authPath)) {
    fs.rmSync(authPath, { force: true });
  }
}

function getGithubToken() {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }

  if (process.env.GH_TOKEN) {
    return process.env.GH_TOKEN;
  }

  const stored = readStoredAuth();
  return stored?.token || "";
}

async function githubApi(endpoint: string, token: string) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "terminalutils-auth",
    },
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = payload?.message || `GitHub API request failed (${response.status})`;
    throw new Error(message);
  }

  return payload;
}

async function validateGithubToken(token: string) {
  return githubApi("/user", token);
}

async function postOAuthForm(url: string, payload: Record<string, string>) {
  const body = new URLSearchParams(payload);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "terminalutils-auth",
    },
    body,
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = parsed?.error_description || parsed?.error || `OAuth request failed (${response.status})`;
    throw new Error(message);
  }

  return parsed;
}

async function requestDeviceCode() {
  return postOAuthForm("https://github.com/login/device/code", {
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPE,
  });
}

async function pollForDeviceToken(deviceCode: string, intervalSeconds: number) {
  let waitSeconds = intervalSeconds;

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

    const payload = await postOAuthForm("https://github.com/login/oauth/access_token", {
      client_id: OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    if (payload.access_token) {
      return payload;
    }

    if (payload.error === "authorization_pending") {
      continue;
    }

    if (payload.error === "slow_down") {
      waitSeconds += 5;
      continue;
    }

    if (payload.error === "expired_token") {
      throw new Error("Device code expired. Start authorization again.");
    }

    if (payload.error === "access_denied") {
      throw new Error("GitHub authorization was canceled.");
    }

    throw new Error(payload.error_description || payload.error || "GitHub device authorization failed.");
  }
}

async function startDeviceFlow() {
  const device = await requestDeviceCode();
  panel("GitHub OAuth", [
    kv("Open", device.verification_uri),
    kv("Code", device.user_code),
    kv("Scope", OAUTH_SCOPE),
    kv("Client ID", OAUTH_CLIENT_ID),
  ], { borderColor: "cyan" });
  bullets([
    "Open the GitHub device page in any browser.",
    "Enter the code exactly as shown.",
    "Return here after approving access.",
  ]);
  step("Wait for approval", `GitHub checks every ${Number(device.interval || 5)}s`);

  const tokenPayload = await pollForDeviceToken(device.device_code, Number(device.interval || 5));
  const user = await validateGithubToken(tokenPayload.access_token);
  writeStoredAuth(tokenPayload.access_token);
  success(`Authorized as ${user.login} via GitHub OAuth.`);
  return { token: tokenPayload.access_token, user };
}

async function promptForToken() {
  const answers = await inquirer.prompt([
    {
      type: "password",
      name: "token",
      message: "Paste GitHub token (classic or fine-grained):",
      mask: "*",
      validate: (value) => (value.trim().length > 0 ? true : "Token is required."),
    },
  ]);

  return answers.token.trim();
}

function printTokenHelp() {
  section("Authorization help", "Choose OAuth for the smoothest CLI flow");
  panel("Manual token fallback", [
    "Open: https://github.com/settings/tokens",
    "Classic token scopes: repo",
    "Fine-grained permissions: Pull requests read/write, Contents read/write, Metadata read",
    `OAuth app review page: https://github.com/settings/connections/applications/${OAUTH_CLIENT_ID}`,
  ]);
  bullets([
    "If an organization enforces OAuth App restrictions, an org owner must approve this app.",
    "A PAT can still work as fallback when org policy allows it.",
  ]);
  warn("Saved credentials are stored locally in ~/.terminalutils/github-auth.json.");
}

async function ensureGithubAuth() {
  const currentToken = getGithubToken();
  if (currentToken) {
    try {
      const user = await validateGithubToken(currentToken);
      panel("GitHub session", [
        kv("Authorized as", user.login),
        kv("Source", process.env.GITHUB_TOKEN || process.env.GH_TOKEN ? "environment" : "saved session"),
      ], { borderColor: "green" });
      return { token: currentToken, user };
    } catch {
      warn("Saved GitHub token is invalid or expired.");
    }
  }

  while (true) {
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "GitHub authorization is required. Choose an action:",
        choices: [
          { name: "Sign in with GitHub OAuth", value: "oauth" },
          { name: "Paste and save token", value: "save" },
          { name: "Show token setup help", value: "help" },
          { name: "Cancel", value: "cancel" },
        ],
      },
    ]);

    if (action === "cancel") {
      return null;
    }

    if (action === "help") {
      printTokenHelp();
      continue;
    }

    if (action === "oauth") {
      try {
        return await startDeviceFlow();
      } catch (authError: any) {
        warn(authError.message);
        continue;
      }
    }

    const token = await promptForToken();
    try {
      const user = await validateGithubToken(token);
      writeStoredAuth(token);
      success(`Authorized as ${user.login}.`);
      return { token, user };
    } catch (authError: any) {
      warn(`Token validation failed: ${authError.message}`);
    }
  }
}

async function manageGithubAuth() {
  const token = getGithubToken();
  let currentUser = null;

  if (token) {
    try {
      currentUser = await validateGithubToken(token);
    } catch {
      warn("Current GitHub token is invalid or expired.");
    }
  }

  panel("Current auth state", [
    kv("Status", currentUser ? "authorized" : "not configured"),
    kv("User", currentUser?.login || "-"),
    kv("Storage", readStoredAuth() ? "saved locally" : "environment only / none"),
  ]);
  bullets([
    "OAuth device flow avoids manual token copying.",
    "Manual token entry stays available as a fallback.",
  ]);

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "GitHub authorization:",
      choices: [
        { name: "Sign in with GitHub OAuth", value: "oauth" },
        { name: token ? "Replace saved token" : "Add token", value: "save" },
        { name: "Show token setup help", value: "help" },
        { name: "Remove saved token", value: "remove", disabled: !readStoredAuth() },
        { name: "Back", value: "back" },
      ],
    },
  ]);

  if (action === "back") {
    return;
  }

  if (action === "help") {
    printTokenHelp();
    return;
  }

  if (action === "oauth") {
    await startDeviceFlow();
    return;
  }

  if (action === "remove") {
    removeStoredAuth();
    success("Saved GitHub token removed.");
    return;
  }

  const newToken = await promptForToken();
  const user = await validateGithubToken(newToken);
  writeStoredAuth(newToken);
  success(`Authorized as ${user.login}.`);
}

export {
  ensureGithubAuth,
  getGithubToken,
  manageGithubAuth,
  validateGithubToken,
};