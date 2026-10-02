const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
} = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
app.setPath(
  "userData",
  fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-analytics-test-")),
);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
app
  .whenReady()
  .then(async () => {
    const { Store } = require("../src/store.cjs");
    const { Monitor } = require("../src/monitor.cjs");
    const store = new Store(app.getPath("userData"));
    const monitor = new Monitor(store, { liveReady: false });
    monitor.setDemo(true);
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (_d, cb) => cb({ cancel: true }),
    );
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        preload: path.join(root, "src/preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    win.contentView.addChildView(view);
    view.setBounds({ x: 280, y: 100, width: 900, height: 700 });
    await view.webContents.loadURL('data:text/html,<input value="preserved">');
    const { Analytics } = require("../src/analytics.cjs");
    const packets = [];
    const analytics = new Analytics(app.getPath("userData"), "0.2.9", {
      send: async (packet) => packets.push(packet),
    });
    ipcMain.handle("manager", (event, action, payload) => {
      assert.equal(event.sender, win.webContents);
      if (action === "state") return monitor.snapshot();
      if (action === "updates-state")
        return { status: "idle", current: "0.2.9" };
      if (action === "analytics-state") return analytics.state();
      if (action === "analytics-consent") return analytics.choose(payload);
      if (action === "tab") return true;
      throw Error("Operational action blocked");
    });
    await win.loadFile(path.join(root, "src/ui/index.html"));
    await delay(500);
    assert.equal(packets.length, 0);
    assert.equal(
      await win.webContents.executeJavaScript(
        'document.querySelector("#analytics-notice")',
      ),
      null,
    );
    assert.equal(
      await win.webContents.executeJavaScript(
        'document.querySelector("#analytics-enabled").checked',
      ),
      true,
    );
    await win.webContents.executeJavaScript(
      'document.querySelector("#analytics-enabled").checked=false; document.querySelector("#analytics-enabled").dispatchEvent(new Event("change"))',
    );
    await delay(100);
    assert.equal(packets.length, 0);
    assert.equal(analytics.state().consent, false);
    await win.webContents.executeJavaScript(
      'document.querySelector("#analytics-enabled").checked=true; document.querySelector("#analytics-enabled").dispatchEvent(new Event("change"))',
    );
    await delay(100);
    assert.equal(packets.length, 1);
    assert.deepEqual(Object.keys(packets[0]).sort(), ["id", "version"]);
    await win.webContents.executeJavaScript(
      'document.querySelector("#analytics-enabled").checked=false; document.querySelector("#analytics-enabled").dispatchEvent(new Event("change"))',
    );
    await analytics.ping();
    assert.equal(packets.length, 1);
    assert.equal(
      await view.webContents.executeJavaScript(
        'document.querySelector("input").value',
      ),
      "preserved",
    );
    console.log(
      "ANALYTICS NATIVE PASS: no initial question; visible notice, enable and disable; no accounts",
    );
    win.destroy();
    app.quit();
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
