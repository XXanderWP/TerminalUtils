import inquirer from "inquirer";
import { runSshServersMenu } from "./ssh-servers-handler";
import { runUploadMenu } from "./upload-handler";
import { runNewVersionMenu } from "./new-version";
import { manageGithubAuth } from "./utils/github-auth";
import { backgroundCheck, interactiveCheck, notifyIfUpdateAvailable } from "./update-check";
import { header, error, panel, bullets, section } from "./utils/tui";
import { DetectApp } from "./utils/path";

const scriptDir = __dirname;

async function runMainMenu() {
  await backgroundCheck(scriptDir);
  notifyIfUpdateAvailable(scriptDir);
  header("TerminalUtils", "Interactive terminal utilities");
  panel("Workspace", [
    "Pick a focused terminal workflow.",
    "Each tool keeps prompts short and shows only the next useful step.",
  ]);

  while (true) {
    section("Main Menu", "Choose the area you want to work in");
    bullets([
      "Updates checks new releases and can apply them in place.",
      "SSH opens saved server connections and maintenance actions.",
      "GitHub tools handle auth, PR creation, and merges.",
    ]);

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "What do you want to do?",
        choices: [
          {
            name: "Check for updates  ·  inspect and apply newer release",
            value: "updates",
          },
          {
            name: "Connect to server via SSH  ·  open saved hosts",
            value: "ssh",
          },
          {
            name: "Create and merge GitHub pull request  ·  repo branch flow",
            value: "upload",
          },
          {
            name: "GitHub authorization  ·  manage OAuth or token",
            value: "github-auth",
          },
          {
            name: "Update project version  ·  bump and tag release",
            value: "version",
          },
          {
            name: "Exit",
            value: "exit",
          },
        ],
      },
    ]);

    if (action === "exit") {
      return;
    }

    if (action === "updates") {
      await interactiveCheck(scriptDir);
      continue;
    }

    if (action === "ssh") {
      await runSshServersMenu();
      continue;
    }

    if (action === "upload") {
      await runUploadMenu();
      continue;
    }

    if (action === "github-auth") {
      await manageGithubAuth();
      continue;
    }

    if (action === "version") {
      await runNewVersionMenu();
    }
  }
}

if (DetectApp() === "util") {
  runMainMenu().catch((runError) => {
    error(runError.message);
    process.exit(1);
  });
}