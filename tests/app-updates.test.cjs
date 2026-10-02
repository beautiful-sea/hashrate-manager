const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { AppUpdates } = require("../src/app-updates.cjs");
function fixture() {
  const updater = new EventEmitter();
  let calls = 0,
    installs = 0,
    safe = false,
    reserved = false;
  updater.checkForUpdates = async () => {
    calls++;
  };
  const updates = new AppUpdates({
    updater,
    version: "0.2.0",
    acquire: () => {
      if (!safe) return false;
      reserved = true;
      return true;
    },
    release: () => {
      reserved = false;
    },
    install: () => {
      assert.equal(reserved, true);
      installs++;
    },
  });
  return {
    updater,
    updates,
    safe: () => (safe = true),
    calls: () => calls,
    installs: () => installs,
  };
}
test("updates wait for safe boundary without canceling a pending financial operation", () => {
  const f = fixture();
  f.updater.emit("update-downloaded", { version: "0.2.1" });
  f.updates.requestInstall();
  assert.equal(f.updates.state().status, "waiting");
  assert.equal(f.installs(), 0);
  f.safe();
  f.updates.tryInstall();
  assert.equal(f.installs(), 1);
  f.updates.tryInstall();
  assert.equal(f.installs(), 1);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowDowngrade, false);
});
test("later cancels requested restart, ordinary downloaded update never installs itself", () => {
  const f = fixture();
  f.updater.emit("update-downloaded", { version: "0.2.1" });
  f.safe();
  f.updates.tryInstall();
  assert.equal(f.installs(), 0);
  const g = fixture();
  g.updater.emit("update-downloaded", { version: "0.2.1" });
  g.updates.requestInstall();
  g.updates.cancelInstall();
  g.safe();
  g.updates.tryInstall();
  assert.equal(g.installs(), 0);
});
test("check errors recover and simultaneous checks are serialized", async () => {
  const f = fixture();
  let unblock;
  f.updater.checkForUpdates = () => new Promise((r) => (unblock = r));
  const p = f.updates.check();
  await f.updates.check();
  unblock();
  await p;
  f.updater.checkForUpdates = async () => {
    throw Error("offline");
  };
  await f.updates.check();
  assert.equal(f.updates.state().status, "error");
  f.updater.checkForUpdates = async () =>
    f.updater.emit("update-not-available");
  await f.updates.check();
  assert.equal(f.updates.state().status, "idle");
});
test("failed install releases maintenance gate and disabled diagnostics never check", () => {
  let released = false;
  const updater = new EventEmitter();
  const u = new AppUpdates({
    updater,
    version: "0.2.0",
    acquire: () => true,
    release: () => (released = true),
    install: () => {
      throw Error("failed");
    },
  });
  updater.emit("update-downloaded", { version: "0.2.1" });
  u.requestInstall();
  assert.equal(released, true);
  assert.equal(u.state().status, "ready");
  const disabled = new AppUpdates({ version: "0.2.0", enabled: false });
  disabled.start();
  assert.equal(disabled.state().status, "disabled");
});

test("unsigned Mac distribution offers a manual download without invoking an installer", async () => {
  const updates = new AppUpdates({
    updater: null,
    version: "0.2.41",
    enabled: false,
    manualDownloadUrl:
      "https://beautiful-sea.github.io/hashrate-manager/#download",
  });
  assert.equal((await updates.check()).status, "disabled");
  assert.equal(
    updates.state().manualDownloadUrl,
    "https://beautiful-sea.github.io/hashrate-manager/#download",
  );
  assert.throws(() => updates.requestInstall(), /ainda não está pronta/);
  updates.start();
  assert.equal(updates.timer, undefined);
});
