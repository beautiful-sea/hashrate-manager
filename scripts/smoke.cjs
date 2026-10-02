const { spawnSync } = require("node:child_process");
const path = require("node:path");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const args of [
  [path.join(__dirname, "network-smoke.cjs")],
  [path.join(__dirname, "dom-flow-smoke.cjs")],
  [path.join(__dirname, "withdrawals-smoke.cjs")],
  [path.join(__dirname, "creation-flow-smoke.cjs")],
  [path.join(__dirname, ".."), "--smoke"],
]) {
  const result = spawnSync(require("electron"), args, {
    env,
    stdio: "inherit",
    timeout: args[0].endsWith("creation-flow-smoke.cjs") ? 120000 : 45000,
    windowsHide: true,
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
