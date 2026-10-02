const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const root = path.join(__dirname, "..");
const target = path.resolve(
  root,
  process.argv[2] || "dist/release/HashrateManager-win32-x64",
);
(async () => {
  const asar = await import("@electron/asar");
  function verify(dir) {
    for (const entry of fs.readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) verify(relative);
      else
        assert.deepEqual(
          asar.extractFile(
            path.join(target, "resources", "app.asar"),
            relative,
          ),
          fs.readFileSync(path.join(root, relative)),
        );
    }
  }
  verify("src");
  const env = {
    ...process.env,
    HASHRATE_SMOKE_OUTPUT: path.join(root, "artifacts", "packaged"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(
    path.join(target, "HashrateManager.exe"),
    ["--smoke"],
    { env, stdio: "inherit", timeout: 45000, windowsHide: true },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0);
  const domResult = spawnSync(
    require("electron"),
    [
      path.join(__dirname, "dom-flow-smoke.cjs"),
      path.join(target, "resources", "app.asar", "src"),
    ],
    { env, stdio: "inherit", timeout: 45000, windowsHide: true },
  );
  if (domResult.error) throw domResult.error;
  assert.equal(domResult.status, 0);
  const withdrawals = spawnSync(
    require("electron"),
    [
      path.join(__dirname, "withdrawals-smoke.cjs"),
      path.join(target, "resources", "app.asar", "src"),
    ],
    { env, stdio: "inherit", timeout: 45000, windowsHide: true },
  );
  if (withdrawals.error) throw withdrawals.error;
  assert.equal(withdrawals.status, 0);
  const creation = spawnSync(
    require("electron"),
    [
      path.join(__dirname, "creation-flow-smoke.cjs"),
      path.join(target, "resources", "app.asar", "src"),
    ],
    { env, stdio: "inherit", timeout: 120000, windowsHide: true },
  );
  if (creation.error) throw creation.error;
  assert.equal(creation.status, 0);
  console.log("Packaged source matches; native packaged smoke passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
