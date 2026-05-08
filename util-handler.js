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
const { header, error } = require("./tui");

const scriptDir = __dirname;

async function runMainMenu() {
  await backgroundCheck(scriptDir);
  notifyIfUpdateAvailable(scriptDir);
  header("TerminalUtils", "Interactive terminal utilities");

  while (true) {
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "What do you want to do?",
        choices: [
          {
            name: "Check for updates",
            value: "updates",
          },
          {
            name: "Connect to server via SSH",
            value: "ssh",
          },
          {
            name: "Create and merge GitHub pull request",
            value: "upload",
          },
          {
            name: "GitHub authorization",
            value: "github-auth",
          },
          {
            name: "Update project version",
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
