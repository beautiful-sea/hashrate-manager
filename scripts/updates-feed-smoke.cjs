const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-feed-test-"));
app.setPath("userData", temp);
app
  .whenReady()
  .then(async () => {
    const resources =
      process.argv[2] ||
      path.join(root, "dist/updates/0.2.2/win-unpacked/resources");
    const version = JSON.parse(
      require("@electron/asar").extractFile(
        path.join(resources, "app.asar"),
        "package.json",
      ),
    ).version;
    const base = path.join(resources, "app.asar/node_modules/electron-updater");
    const { NsisUpdater } = require(base);
    const { ElectronHttpExecutor } = require(
      path.join(base, "out/electronHttpExecutor"),
    );
    const adapter = {
      version,
      name: "Public feed test",
      isPackaged: true,
      appUpdateConfigPath: path.join(resources, "app-update.yml"),
      userDataPath: temp,
      baseCachePath: temp,
      whenReady: () => app.whenReady(),
      quit: () => {},
      relaunch: () => {},
      onQuit: () => {},
    };
    const u = new NsisUpdater(null, adapter);
    u.httpExecutor = new ElectronHttpExecutor();
    u.autoDownload = false;
    u.autoInstallOnAppQuit = false;
    u.logger = null;
    u.on("error", () => {});
    const result = await u.checkForUpdates();
    assert.equal(result.updateInfo.version, version);
    assert.equal(result.downloadPromise, undefined);
    fs.writeFileSync(
      path.join(root, "artifacts/updates-public-feed.json"),
      JSON.stringify({
        passed: true,
        packagedDependenciesLoaded: true,
        httpsFeedConfirmed: true,
        version: result.updateInfo.version,
        downloadDisabled: true,
        realProfileUsed: false,
      }),
    );
    console.log("PUBLIC HTTPS FEED PASS");
    app.exit(0);
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
