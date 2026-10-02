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
  fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-donation-test-")),
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
    const data = require("../src/donation.json");
    let copied = "",
      open = false;
    ipcMain.handle("manager", (event, action, payload) => {
      assert.equal(event.sender, win.webContents);
      if (action === "state") return monitor.snapshot();
      if (action === "updates-state")
        return { status: "idle", current: "0.2.8" };
      if (action === "donation-info") return data;
      if (action === "donation-dialog") {
        assert.equal(typeof payload, "boolean");
        open = payload;
        view.setVisible(!open);
        return true;
      }
      if (action === "donation-copy") {
        copied = data.payload;
        return true;
      }
      if (action === "tab") return true;
      throw Error("Operational action blocked");
    });
    await win.loadFile(path.join(root, "src/ui/index.html"));
    await delay(500);
    await win.webContents.executeJavaScript(
      'document.querySelector("#contribute-project").click()',
    );
    await delay(350);
    const ui = await win.webContents.executeJavaScript(
      '({open:document.querySelector("#donation-modal").open,qr:document.querySelector("#donation-qr").naturalWidth,name:document.querySelector("#donation-beneficiary").textContent,node:typeof require})',
    );
    assert(ui.open && open);
    assert(ui.qr > 0);
    assert.equal(ui.name, data.beneficiary);
    assert.equal(ui.node, "undefined");
    fs.writeFileSync(
      path.join(root, "artifacts/donation-modal.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await win.webContents.executeJavaScript(
      'document.querySelector("#donation-copy").click()',
    );
    await delay(100);
    assert.equal(copied, data.payload);
    await win.webContents.executeJavaScript(
      'document.querySelector("#donation-close").click()',
    );
    await delay(100);
    assert.equal(open, false);
    assert.equal(
      await view.webContents.executeJavaScript(
        'document.querySelector("input").value',
      ),
      "preserved",
    );
    console.log("DONATION NATIVE PASS", JSON.stringify(ui));
    win.destroy();
    app.quit();
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
