import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import inquirer from "inquirer";
import { backgroundCheck, notifyIfUpdateAvailable } from "./update-check";
import { ensureGithubAuth } from "./github-auth";
import { loadRepoOptions, saveRepoOptions } from "./repos";
import { header, info, warn, success, error, panel, kv, section, step, bullets } from "./tui";

const scriptDir = __dirname;

function runGit(args: string[]) {
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

function parseRemoteToSlug(url: string) {
  if (!url) {
    return undefined;
  }

  const trimmed = url.trim();
  if (trimmed.startsWith("git@")) {
    const parts = trimmed.split(":");
    if (parts.length > 1) {
      return parts[1].replace(/\.git$/, "");
    }
    return undefined;
  }

  const marker = "github.com/";
  if (trimmed.includes(marker)) {
    return trimmed.split(marker)[1].replace(/\.git$/, "");
  }

  return undefined;
}

function formatRepo(item: { name?: string; repo: string; pairs?: { head: string; base: string }[] }) {
  const name = item.name || item.repo;
  const firstPair = Array.isArray(item.pairs) && item.pairs[0] ? item.pairs[0] : null;
  const pairPart = firstPair ? `${firstPair.head} -> ${firstPair.base}` : "no pairs";
  return `${name} (${pairPart}) [${item.repo}]`;
}

async function githubApi(method: string, endpoint: string, token: string, body?: any) {
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
    const apiError = new Error(message) as any;
    apiError.status = response.status;
    apiError.documentationUrl = payload?.documentation_url || "";
    throw apiError;
  }

  return payload;
}

function isOAuthAppRestrictionError(err: any) {
  const combined = `${err?.message || ""} ${err?.documentationUrl || ""}`.toLowerCase();
  return (
    combined.includes("oauth app access restrictions") ||
    combined.includes("restricting-access-to-your-organization-s-data")
  );
}

function showOAuthRestrictionGuidance(repoSlug: string, userLogin: string) {
  const org = repoSlug.split("/")[0] || "organization";
  panel(
    "OAuth app blocked by organization policy",
    [
      kv("Organization", org),
      kv("User", userLogin || "unknown"),
      "The token is valid, but this OAuth App is not approved for org data access.",
    ],
    { borderColor: "yellow" }
  );
  section("How to fix", "Pick one option");
  bullets([
    "Ask an org owner to approve this OAuth App in Organization Settings -> Third-party access.",
    "Or switch to a Personal Access Token (classic: repo, or fine-grained with PR/Contents permissions).",
    "Then run upload again.",
  ]);
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

async function maybeAddDetectedRepo(repoOptions: { name?: string; repo: string; pairs?: { head: string; base: string }[] }[], remoteSlug?: string) {
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

async function selectRepo(repoOptions: { name?: string; repo: string; pairs?: { head: string; base: string }[] }[], detectedSlug?: string) {
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

async function selectPair(selectedRepo: { name?: string; repo: string; pairs?: { head: string; base: string }[] }) {
  const pairs = Array.isArray(selectedRepo.pairs) ? selectedRepo.pairs : [];
  if (pairs.length === 0) {
    error("No branch pairs configured for this repository.");
    return null;
  }

  const choices = pairs.map((pair) => ({
    name: `${pair.head} -> ${pair.base}`,
    value: pair,
  }));
  choices.push({ name: "Cancel", value: null as any });

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

async function ensurePullRequest(repoSlug: string, pair: { head: string; base: string }, token: string) {
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

async function mergePullRequest(repoSlug: string, prNumber: number, token: string) {
  return githubApi("PUT", `/repos/${repoSlug}/pulls/${prNumber}/merge`, token, {
    merge_method: "merge",
    commit_title: `Merge PR #${prNumber}`,
  });
}

async function runUploadMenu() {
  await backgroundCheck(scriptDir);
  notifyIfUpdateAvailable(scriptDir);
  header("TerminalUtils", "GitHub pull request and merge");
  panel("Flow", [
    "1. Resolve GitHub authorization",
    "2. Pick repository and branch direction",
    "3. Create PR if needed and merge it",
  ], { borderColor: "yellow" });

  const auth = await ensureGithubAuth();
  if (!auth?.token) {
    info("GitHub authorization canceled.");
    return;
  }
  const token = auth.token;
  panel("Session", [kv("GitHub user", auth.user?.login || "unknown")]);

  const remoteUrl = getGitRemoteUrl();
  const remoteSlug = parseRemoteToSlug(remoteUrl);
  section("Repository Context", "Detection from current git remote");
  panel("Detected remote", [
    kv("Origin", remoteUrl || "not found"),
    kv("Repo slug", remoteSlug || "not detected"),
  ]);

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
  panel("Selected repository", [
    kv("Name", selectedRepo.name || selectedRepo.repo),
    kv("Slug", selectedRepo.repo),
    kv("Pairs", String(selectedRepo.pairs?.length || 0)),
  ]);

  const pair = await selectPair(selectedRepo);
  if (!pair) {
    info("Canceled.");
    return;
  }
  section("Execution Plan", "About to run GitHub API operations");
  bullets([
    `Head branch: ${pair.head}`,
    `Base branch: ${pair.base}`,
    "Open PR will be reused when possible.",
  ]);

  let pr;
  try {
    step("Create or find pull request", `${selectedRepo.repo}  ${pair.head} -> ${pair.base}`);
    pr = await ensurePullRequest(selectedRepo.repo, pair, token);
    success(`Pull request ready: #${pr.number}`);

    step("Merge pull request", `#${pr.number}`);
    await mergePullRequest(selectedRepo.repo, pr.number, token);
  } catch (runError) {
    if (isOAuthAppRestrictionError(runError)) {
      showOAuthRestrictionGuidance(selectedRepo.repo, auth.user?.login);
      return;
    }
    throw runError;
  }

  success("Pull request merged successfully.");
  panel("Useful links", [
    `Repository: https://github.com/${selectedRepo.repo}`,
    `Pull Request: https://github.com/${selectedRepo.repo}/pull/${pr.number}`,
    `Actions: https://github.com/${selectedRepo.repo}/actions`,
  ], { borderColor: "green" });
}

if (require.main === module) {
  runUploadMenu().catch((runError) => {
    error(runError.message);
    process.exit(1);
  });
}

export {
  runUploadMenu,
};
