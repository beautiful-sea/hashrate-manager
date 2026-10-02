const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-modal-test-"));
app.setPath("userData", temp);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
app
  .whenReady()
  .then(async () => {
    const { Store } = require("../src/store.cjs");
    const { Monitor } = require("../src/monitor.cjs");
    const store = new Store(temp);
    const monitor = new Monitor(store, { liveReady: false });
    monitor.setDemo(true);
    await monitor.start();
    let state = {
        current: "0.2.3",
        version: "0.2.4",
        status: "downloading",
        percent: 75,
        transferred: 78643200,
        total: 104857600,
      },
      dialogOpen = false,
      cancelled = 0,
      installs = 0;
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (_d, cb) => cb({ cancel: true }),
    );
    const win = new BrowserWindow({
      show: false,
      width: 1440,
      height: 960,
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
    view.setBounds({ x: 224, y: 136, width: 1100, height: 780 });
    await view.webContents.loadURL(
      'data:text/html,<body>Platform test - form preserved<input value="original"></body>',
    );
    const original = view.webContents.getURL();
    ipcMain.handle("manager", (event, action, payload) => {
      assert.equal(event.sender, win.webContents);
      if (action === "updates-dialog") {
        assert.equal(typeof payload, "boolean");
        dialogOpen = payload;
        view.setVisible(!payload);
        return true;
      }
      if (action === "updates-state" || action === "updates-check")
        return { ...state };
      if (action === "updates-install") {
        installs++;
        state.status = "waiting";
        return { ...state };
      }
      if (action === "updates-cancel") {
        cancelled++;
        state.status = "ready";
        return { ...state };
      }
      if (action === "state") return monitor.snapshot();
      if (action === "tab") return true;
      throw Error("Operational action blocked in modal test");
    });
    await win.loadFile(path.join(root, "src/ui/index.html"));
    await delay(500);
    const progress = await win.webContents.executeJavaScript(
      '({value:document.querySelector("#update-download").value,text:document.querySelector("#update-progress-label").textContent})',
    );
    assert.equal(progress.value, 75);
    assert(progress.text.includes("75"));
    state.status = "ready";
    state.percent = 100;
    await delay(2300);
    const isOpen = () =>
      win.webContents.executeJavaScript(
        'document.querySelector("#update-modal").open',
      );
    assert.equal(await isOpen(), true);
    assert.equal(dialogOpen, true);
    const first = await win.webContents.executeJavaScript(
      '({title:document.querySelector("#update-modal-title").textContent,version:document.querySelector("#update-modal-version").textContent,focused:document.activeElement.id,node:typeof require})',
    );
    assert.equal(first.version, "Versão 0.2.4");
    assert.equal(first.node, "undefined");
    assert.equal(first.focused, "update-modal-later");
    fs.writeFileSync(
      path.join(root, "artifacts/update-modal.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await win.webContents.executeJavaScript(
      'document.querySelector("#update-modal-later").click()',
    );
    await delay(2300);
    assert.equal(await isOpen(), false);
    assert.equal(dialogOpen, false);
    assert.equal(view.webContents.getURL(), original);
    assert.equal(
      await view.webContents.executeJavaScript(
        'document.querySelector("input").value',
      ),
      "original",
    );
    await win.webContents.executeJavaScript(
      'document.querySelector("#app-update-action").click()',
    );
    await delay(100);
    assert.equal(await isOpen(), true);
    await win.webContents.executeJavaScript(
      'document.querySelector("#update-modal-install").click()',
    );
    await delay(100);
    assert.equal(state.status, "waiting");
    assert.equal(installs, 1);
    await win.webContents.executeJavaScript(
      'document.querySelector("#update-modal-later").click()',
    );
    await delay(2300);
    assert.equal(cancelled, 1);
    assert.equal(await isOpen(), false);
    await win.webContents.executeJavaScript(
      'document.querySelector("#updates-check").click()',
    );
    await delay(100);
    assert.equal(await isOpen(), true);
    await win.webContents.executeJavaScript(
      'document.querySelector("#update-modal").dispatchEvent(new Event("cancel",{cancelable:true}))',
    );
    await delay(2300);
    assert.equal(await isOpen(), false);
    state.version = "0.2.5";
    await delay(2300);
    assert.equal(await isOpen(), true);
    const result = {
      passed: true,
      automaticAnnouncement: true,
      postponeNotReopened: true,
      manualReopen: true,
      queuedRestartCancelled: true,
      escapePostpones: true,
      newVersionReopens: true,
      platformDomPreserved: true,
      progressVisible: true,
      realProfileUsed: false,
      first,
    };
    fs.writeFileSync(
      path.join(root, "artifacts/update-modal-smoke.json"),
      JSON.stringify(result, null, 2),
    );
    console.log("MODAL PASS " + JSON.stringify(result));
    monitor.stop();
    view.webContents.close();
    win.destroy();
    app.exit(0);
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
