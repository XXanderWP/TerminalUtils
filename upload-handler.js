const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const inquirer = require("inquirer");
const {
  backgroundCheck,
  notifyIfUpdateAvailable,
} = require("./update-check");
const { ensureGithubAuth } = require("./github-auth");
const { loadRepoOptions, saveRepoOptions } = require("./repos");
const { header, info, warn, success, error } = require("./tui");

const scriptDir = __dirname;

function runGit(args) {
  const output = execSync(`git ${args.join(" ")}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return output.trim();
}

function getGitRemoteUrl() {
  try {
    return runGit(["config", "--get", "remote.origin.url"]);
  } catch {
    return "";
  }
}

function parseRemoteToSlug(url) {
  if (!url) {
    return null;
  }

  const trimmed = url.trim();
  if (trimmed.startsWith("git@")) {
    const parts = trimmed.split(":");
    if (parts.length > 1) {
      return parts[1].replace(/\.git$/, "");
    }
    return null;
  }

  const marker = "github.com/";
  if (trimmed.includes(marker)) {
    return trimmed.split(marker)[1].replace(/\.git$/, "");
  }

  return null;
}

function formatRepo(item) {
  const name = item.name || item.repo;
  const firstPair = Array.isArray(item.pairs) && item.pairs[0] ? item.pairs[0] : null;
  const pairPart = firstPair ? `${firstPair.head} -> ${firstPair.base}` : "no pairs";
  return `${name} (${pairPart}) [${item.repo}]`;
}

async function githubApi(method, endpoint, token, body) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "terminalutils-upload-handler",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = payload?.message || `GitHub API request failed (${response.status})`;
    throw new Error(message);
  }

  return payload;
}

function inferPairsFromRemoteBranches() {
  try {
    const raw = runGit(["ls-remote", "--heads", "origin"]);
    const branches = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.includes("refs/heads/")) {
        continue;
      }
      branches.push(line.split("refs/heads/")[1]);
    }

    const unique = [...new Set(branches)];
    const commonBases = ["main", "master", "develop", "beta", "staging", "release"];
    const pairs = [];

    for (const head of unique) {
      for (const base of commonBases) {
        if (head !== base && unique.includes(base)) {
          pairs.push({ head, base });
        }
      }
      if (pairs.length >= 30) {
        break;
      }
    }

    if (pairs.length > 0) {
      return pairs;
    }
  } catch {
    // Fallback below.
  }

  return [
    { head: "develop", base: "main" },
    { head: "beta", base: "main" },
    { head: "develop", base: "beta" },
  ];
}

async function maybeAddDetectedRepo(repoOptions, remoteSlug) {
  if (!remoteSlug) {
    return repoOptions;
  }

  const exists = repoOptions.some((item) => item.repo === remoteSlug);
  if (exists) {
    return repoOptions;
  }

  const { addRepo } = await inquirer.prompt([
    {
      type: "confirm",
      name: "addRepo",
      message: `Detected ${remoteSlug}, add it to repos.json with inferred branch pairs?`,
      default: false,
    },
  ]);

  if (!addRepo) {
    return repoOptions;
  }

  const newEntry = {
    name: remoteSlug.split("/").slice(-1)[0],
    repo: remoteSlug,
    pairs: inferPairsFromRemoteBranches(),
  };

  const next = [...repoOptions, newEntry];
  saveRepoOptions(next, scriptDir);
  success(`Added ${remoteSlug} to repos.json.`);
  return next;
}

async function selectRepo(repoOptions, detectedSlug) {
  const map = new Map();
  for (const item of repoOptions) {
    map.set(formatRepo(item), item);
  }

  if (detectedSlug) {
    const detected = repoOptions.find((item) => item.repo === detectedSlug);
    if (detected) {
      const { useDetected } = await inquirer.prompt([
        {
          type: "confirm",
          name: "useDetected",
          message: `Use detected repository ${detected.repo}?`,
          default: true,
        },
      ]);
      if (useDetected) {
        return detected;
      }
    }
  }

  const { repoKey } = await inquirer.prompt([
    {
      type: "list",
      name: "repoKey",
      message: "Select repository:",
      choices: [...map.keys(), "Cancel"],
    },
  ]);

  if (repoKey === "Cancel") {
    return null;
  }

  return map.get(repoKey) || null;
}

async function selectPair(selectedRepo) {
  const pairs = Array.isArray(selectedRepo.pairs) ? selectedRepo.pairs : [];
  if (pairs.length === 0) {
    error("No branch pairs configured for this repository.");
    return null;
  }

  const choices = pairs.map((pair) => ({
    name: `${pair.head} -> ${pair.base}`,
    value: pair,
  }));
  choices.push({ name: "Cancel", value: null });

  const { pair } = await inquirer.prompt([
    {
      type: "list",
      name: "pair",
      message: `Select branch pair for ${selectedRepo.repo}:`,
      choices,
    },
  ]);

  return pair;
}

async function ensurePullRequest(repoSlug, pair, token) {
  const [owner] = repoSlug.split("/");
  const headQuery = encodeURIComponent(`${owner}:${pair.head}`);
  const baseQuery = encodeURIComponent(pair.base);

  const list = await githubApi(
    "GET",
    `/repos/${repoSlug}/pulls?state=open&head=${headQuery}&base=${baseQuery}`,
    token
  );

  if (Array.isArray(list) && list.length > 0) {
    return list[0];
  }

  return githubApi("POST", `/repos/${repoSlug}/pulls`, token, {
    title: `Merge ${pair.head} into ${pair.base}`,
    body: `Automatic pull request: ${pair.head} -> ${pair.base}`,
    head: pair.head,
    base: pair.base,
  });
}

async function mergePullRequest(repoSlug, prNumber, token) {
  return githubApi("PUT", `/repos/${repoSlug}/pulls/${prNumber}/merge`, token, {
    merge_method: "merge",
    commit_title: `Merge PR #${prNumber}`,
  });
}

async function runUploadMenu() {
  await backgroundCheck(scriptDir);
  notifyIfUpdateAvailable(scriptDir);
  header("TerminalUtils", "GitHub pull request and merge");

  const auth = await ensureGithubAuth();
  if (!auth?.token) {
    info("GitHub authorization canceled.");
    return;
  }
  const token = auth.token;

  const remoteUrl = getGitRemoteUrl();
  const remoteSlug = parseRemoteToSlug(remoteUrl);

  let repoOptions = loadRepoOptions(scriptDir);
  repoOptions = await maybeAddDetectedRepo(repoOptions, remoteSlug);

  if (repoOptions.length === 0) {
    throw new Error("No repositories configured. Add entries in repos.json.");
  }

  const selectedRepo = await selectRepo(repoOptions, remoteSlug);
  if (!selectedRepo) {
    info("Canceled.");
    return;
  }

  const pair = await selectPair(selectedRepo);
  if (!pair) {
    info("Canceled.");
    return;
  }

  info(
    `Creating or finding PR for ${selectedRepo.repo}: ${pair.head} -> ${pair.base}`
  );
  const pr = await ensurePullRequest(selectedRepo.repo, pair, token);
  success(`Pull request ready: #${pr.number}`);

  info(`Merging pull request #${pr.number}...`);
  await mergePullRequest(selectedRepo.repo, pr.number, token);

  success("Pull request merged successfully.");
  console.log(`Repository: https://github.com/${selectedRepo.repo}`);
  console.log(`Pull Request: https://github.com/${selectedRepo.repo}/pull/${pr.number}`);
  console.log(`Actions: https://github.com/${selectedRepo.repo}/actions`);
}

if (require.main === module) {
  runUploadMenu().catch((runError) => {
    error(runError.message);
    process.exit(1);
  });
}

module.exports = {
  runUploadMenu,
};
