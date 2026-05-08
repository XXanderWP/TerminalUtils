const chalk = require("chalk");
const boxenModule = require("boxen");
const boxen =
  typeof boxenModule === "function" ? boxenModule : boxenModule.default;

function header(title, subtitle = "") {
  const body = subtitle ? `${chalk.bold(title)}\n${chalk.dim(subtitle)}` : chalk.bold(title);
  console.log(
    boxen(body, {
      padding: 1,
      margin: { top: 1, bottom: 1 },
      borderColor: "cyan",
      borderStyle: "round",
    })
  );
}

function info(message) {
  console.log(chalk.cyan(`[info] ${message}`));
}

function warn(message) {
  console.log(chalk.yellow(`[warn] ${message}`));
}

function success(message) {
  console.log(chalk.green(`[ok] ${message}`));
}

function error(message) {
  console.error(chalk.red(`[error] ${message}`));
}

module.exports = {
  header,
  info,
  warn,
  success,
  error,
};
