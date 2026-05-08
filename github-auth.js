const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const inquirer = require("inquirer");
const { info, warn, success } = require("./tui");

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

function writeStoredAuth(token) {
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

async function githubApi(endpoint, token) {
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

async function validateGithubToken(token) {
  return githubApi("/user", token);
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
  info("Create a GitHub token with pull request and contents access for the target repositories.");
  console.log("Open: https://github.com/settings/tokens");
  console.log("Classic token scopes: repo");
  console.log("Fine-grained token permissions: Pull requests (read/write), Contents (read/write), Metadata (read)");
  warn("Token is stored locally in ~/.terminalutils/github-auth.json if you choose to save it.");
}

async function ensureGithubAuth() {
  const currentToken = getGithubToken();
  if (currentToken) {
    try {
      const user = await validateGithubToken(currentToken);
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

    const token = await promptForToken();
    try {
      const user = await validateGithubToken(token);
      writeStoredAuth(token);
      success(`Authorized as ${user.login}.`);
      return { token, user };
    } catch (authError) {
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

  info(currentUser ? `Authorized as ${currentUser.login}.` : "GitHub authorization is not configured.");

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "GitHub authorization:",
      choices: [
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

module.exports = {
  ensureGithubAuth,
  getGithubToken,
  manageGithubAuth,
  validateGithubToken,
};