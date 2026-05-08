const inquirer = require("inquirer");
const { runSshServersMenu } = require("./ssh-servers-handler");
const { runUploadMenu } = require("./upload-handler");
const { runNewVersionMenu } = require("./new-version");
const { manageGithubAuth } = require("./github-auth");
const {
  backgroundCheck,
  interactiveCheck,
  notifyIfUpdateAvailable,
} = require("./update-check");
const { header, error, panel, bullets, section } = require("./tui");

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

if (require.main === module) {
  runMainMenu().catch((runError) => {
    error(runError.message);
    process.exit(1);
  });
}

module.exports = {
  runMainMenu,
};
