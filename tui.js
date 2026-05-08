const chalk = require("chalk");
const boxenModule = require("boxen");
const boxen =
  typeof boxenModule === "function" ? boxenModule : boxenModule.default;

function divider() {
  console.log(chalk.hex("#5f7a8a")("─".repeat(54)));
}

function header(title, subtitle = "") {
  const accent = chalk.hex("#6dd3ce");
  const titleLine = accent.bold(title);
  const body = subtitle ? `${titleLine}\n${chalk.dim(subtitle)}` : titleLine;
  console.log(
    boxen(body, {
      padding: 1,
      margin: { top: 1, bottom: 1 },
      borderColor: "cyan",
      borderStyle: "round",
    })
  );
}

function section(title, description = "") {
  const line = `${chalk.bold.white(title)}${description ? chalk.dim(`  ${description}`) : ""}`;
  console.log(`\n${line}`);
  divider();
}

function panel(title, lines = [], options = {}) {
  const content = [chalk.bold(title), ...lines.filter(Boolean)].join("\n");
  console.log(
    boxen(content, {
      padding: { top: 0, right: 1, bottom: 0, left: 1 },
      margin: options.margin || { top: 0, bottom: 1 },
      borderColor: options.borderColor || "gray",
      borderStyle: options.borderStyle || "round",
    })
  );
}

function kv(label, value) {
  return `${chalk.hex("#9fb3c8")(label.padEnd(14, " "))} ${value}`;
}

function bullets(items = []) {
  for (const item of items) {
    console.log(` ${chalk.hex("#6dd3ce")("•")} ${item}`);
  }
}

function step(label, detail = "") {
  console.log(`${chalk.hex("#f4b860")("→")} ${chalk.bold(label)}${detail ? chalk.dim(`  ${detail}`) : ""}`);
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
  bullets,
  divider,
  header,
  info,
  kv,
  panel,
  warn,
  section,
  step,
  success,
  error,
};
