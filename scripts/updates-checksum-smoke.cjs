const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { NsisUpdater } = require("electron-updater");
const {
  ElectronHttpExecutor,
} = require("electron-updater/out/electronHttpExecutor");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-bad-update-"));
app.setPath("userData", dir);
app
  .whenReady()
  .then(async () => {
    const bytes = Buffer.from("inert-test-data");
    const sha512 = crypto
      .createHash("sha512")
      .update("different")
      .digest("base64");
    const server = http.createServer((req, res) => {
      const value = req.url.startsWith("/latest.yml")
        ? Buffer.from(
            `version: 9.0.0\nfiles:\n  - url: inert.exe\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: inert.exe\nsha512: ${sha512}\nreleaseDate: '2026-10-01T00:00:00.000Z'\n`,
          )
        : bytes;
      res.setHeader("Content-Length", value.length);
      res.end(value);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const config = path.join(dir, "app-update.yml");
    fs.writeFileSync(config, "updaterCacheDirName: inert-checksum-test\n");
    const adapter = {
      version: "1.0.0",
      name: "Inert update test",
      isPackaged: true,
      appUpdateConfigPath: config,
      userDataPath: dir,
      baseCachePath: dir,
      whenReady: () => app.whenReady(),
      quit: () => {
        throw Error("Must not quit");
      },
      relaunch: () => {},
      onQuit: () => {},
    };
    const u = new NsisUpdater(null, adapter);
    u.httpExecutor = new ElectronHttpExecutor();
    u.setFeedURL({
      provider: "generic",
      url: `http://127.0.0.1:${server.address().port}/`,
    });
    u.autoDownload = false;
    u.autoInstallOnAppQuit = false;
    u.disableDifferentialDownload = true;
    u.logger = null;
    u.on("error", () => {});
    await u.checkForUpdates();
    await assert.rejects(u.downloadUpdate(), /sha512 checksum mismatch/i);
    assert.equal(u.installerPath, null);
    fs.writeFileSync(
      path.resolve(__dirname, "../artifacts/updates-checksum.json"),
      JSON.stringify({
        passed: true,
        corruptedDownloadRejected: true,
        installerNotExecuted: true,
        realProfileUsed: false,
      }),
    );
    console.log("CORRUPTED UPDATE REJECTED");
    server.close();
    app.exit(0);
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
