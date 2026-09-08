const { spawnSync } = require("node:child_process");
const path = require("node:path");

const bash = process.platform === "win32"
  ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
  : "bash";
const result = spawnSync(bash, [path.join(__dirname, "dispatch.sh")], {
  env: process.env,
  stdio: "inherit",
});

if (result.error) console.error(`pi-herdr-subagents dispatcher failed: ${result.error.message}`);
process.exit(result.status ?? 1);
