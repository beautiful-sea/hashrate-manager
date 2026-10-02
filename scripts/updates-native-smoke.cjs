const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-native-update-"));
app.setPath("userData", path.join(tmp, "profile"));
const { NsisUpdater } = require("electron-updater");
const {
  ElectronHttpExecutor,
} = require("electron-updater/out/electronHttpExecutor");
const { AppUpdates } = require("../src/app-updates.cjs");
const timeout = setTimeout(() => {
  console.error("UPDATE TEST TIMEOUT");
  app.exit(1);
}, 150000);
app
  .whenReady()
  .then(async () => {
    const first = path.join(
      root,
      "dist/updates-test/1.0.0/Hashrate-Manager-Setup-1.0.0-win-x64.exe",
    );
    const nextDir = path.join(root, "dist/updates-test/1.0.1");
    const target = path.join(tmp, "installed");
    const baseline = spawnSync(
      first,
      ["/S", "--no-desktop-shortcut", `/D=${target}`],
      { timeout: 120000, windowsHide: true },
    );
    assert.equal(baseline.status, 0);
    const profile = app.getPath("userData");
    fs.mkdirSync(profile, { recursive: true });
    const marker = path.join(profile, "history-preserve.json");
    const history = JSON.stringify({ history: ["test-only"], pending: [] });
    fs.writeFileSync(marker, history);
    const adapter = {
      version: "1.0.0",
      name: "Hashrate Update Test",
      isPackaged: true,
      appUpdateConfigPath: path.join(target, "resources/app-update.yml"),
      userDataPath: profile,
      baseCachePath: path.join(tmp, "cache"),
      whenReady: () => app.whenReady(),
      relaunch: () => {},
      quit: () => {},
      onQuit: () => {},
    };
    const server = http.createServer((req, res) => {
      const filename = decodeURIComponent(req.url.split("?")[0]).slice(1);
      if (
        ![
          "latest.yml",
          "Hashrate-Manager-Setup-1.0.1-win-x64.exe",
          "Hashrate-Manager-Setup-1.0.1-win-x64.exe.blockmap",
        ].includes(filename)
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      const file = path.join(nextDir, filename);
      res.setHeader("Content-Length", fs.statSync(file).size);
      fs.createReadStream(file).pipe(res);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const updater = new NsisUpdater({ provider: "generic", url }, adapter);
    updater.httpExecutor = new ElectronHttpExecutor();
    updater.setFeedURL({ provider: "generic", url });
    updater.disableDifferentialDownload = true;
    updater.installDirectory = target;
    updater.logger = null;
    let safe = false,
      installs = 0,
      gate = false,
      installed;
    updater.spawnLog = async (cmd, args) => {
      assert(cmd.startsWith(tmp));
      assert(args.includes("/S"));
      assert(!args.includes("--force-run"));
      const result = spawnSync(cmd, args, {
        timeout: 120000,
        windowsHide: true,
      });
      assert.equal(result.status, 0);
      installs++;
      installed = true;
    };
    const coordinator = new AppUpdates({
      updater,
      version: "1.0.0",
      acquire: () => {
        if (!safe) return false;
        gate = true;
        return true;
      },
      release: () => (gate = false),
      install: () => {
        assert(gate);
        updater.quitAndInstall(true, false);
      },
    });
    const events = [];
    coordinator.on("state", (s) => events.push(s.status));
    ipcMain.handle("manager", (_e, action) => {
      if (action === "updates-dialog") return true;
      if (action === "updates-state") return coordinator.state();
      if (action === "updates-install") return coordinator.requestInstall();
      if (action === "updates-check") return coordinator.check();
      if (action === "updates-cancel") return coordinator.cancelInstall();
      throw Error("Test denies operational IPC");
    });
    const html = path.join(tmp, "ui.html");
    fs.writeFileSync(
      html,
      '<html><body><span id="app-version"></span><button id="updates-check"></button><div id="app-update" hidden><span id="app-update-text"></span><button id="app-update-action" hidden></button><button id="app-update-cancel" hidden></button></div></body></html>',
    );
    const modalHtml = fs
      .readFileSync(path.join(root, "src/ui/index.html"), "utf8")
      .match(/<dialog\b[\s\S]*?id="update-modal"[\s\S]*?<\/dialog>/)[0];
    fs.appendFileSync(
      html,
      modalHtml +
        '<div id="update-progress"><label id="update-progress-label"></label><progress id="update-download" max="100"></progress></div>',
    );
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 400,
      webPreferences: {
        preload: path.join(root, "src/preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await win.loadFile(html);
    await win.webContents.executeJavaScript(
      fs.readFileSync(path.join(root, "src/ui/updates.js"), "utf8"),
    );
    const downloaded = new Promise((resolve, reject) => {
      updater.once("update-downloaded", resolve);
      updater.once("error", reject);
    });
    await coordinator.check();
    await downloaded;
    assert.equal(coordinator.state().status, "ready");
    await new Promise((r) => setTimeout(r, 2200));
    const ready = await win.webContents.executeJavaScript(
      '({visible:!document.querySelector("#app-update").hidden,button:!document.querySelector("#app-update-action").hidden,node:typeof require})',
    );
    assert.deepEqual(ready, { visible: true, button: true, node: "undefined" });
    fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "artifacts/updates-native.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await win.webContents.executeJavaScript(
      'document.querySelector("#update-modal-install").click()',
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(coordinator.state().status, "waiting");
    assert.equal(installs, 0);
    safe = true;
    coordinator.tryInstall();
    assert.equal(installed, true);
    assert.equal(installs, 1);
    assert.equal(fs.readFileSync(marker, "utf8"), history);
    const asar = require("@electron/asar");
    assert.equal(
      JSON.parse(
        asar.extractFile(
          path.join(target, "resources/app.asar"),
          "package.json",
        ),
      ).version,
      "1.0.1",
    );
    const uninstall = path.join(target, "Uninstall HashrateUpdateTest.exe");
    assert(fs.existsSync(uninstall));
    const un = spawnSync(uninstall, ["/S", `_?=${target}`], {
      windowsHide: true,
      timeout: 120000,
    });
    assert.equal(un.status, 0);
    assert.equal(fs.readFileSync(marker, "utf8"), history);
    const result = {
      passed: true,
      from: "1.0.0",
      to: "1.0.1",
      nativeUpdater: true,
      sha512Validated: true,
      waitingBlockedInstall: true,
      installedOnce: true,
      profilePreserved: true,
      realProfileUsed: false,
      ready,
      events,
      testDirectory: tmp,
    };
    fs.writeFileSync(
      path.join(root, "artifacts/updates-native.json"),
      JSON.stringify(result, null, 2),
    );
    console.log("NATIVE UPDATE PASS " + JSON.stringify(result));
    server.close();
    clearTimeout(timeout);
    win.destroy();
    app.exit(0);
  })
  .catch((e) => {
    console.error(e);
    clearTimeout(timeout);
    app.exit(1);
  });
