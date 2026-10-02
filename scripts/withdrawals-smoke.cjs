const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const source = path.resolve(process.argv[2] || path.join(__dirname, "../src"));
const { withdrawalOverview } = require(path.join(source, "reinvestment.cjs"));
const now = Date.now(),
  hour = 3600000;
const formatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const timing = [24, 30, 36].map((hours, i) => ({
  id: "0x" + String(i + 1).repeat(64),
  requestedAt: new Date(now - 8 * 24 * hour).toISOString(),
  completedAt: new Date(now - 8 * 24 * hour + hours * hour).toISOString(),
  net: String(500 + i * 100),
}));
const result = withdrawalOverview(
  {
    payments: {
      at: now,
      timing,
      completed: timing.map((r) => ({
        id: r.id,
        status: "Concluído",
        displayedAt: formatter.format(Date.parse(r.requestedAt)),
      })),
      pending: [6, 40].map((hours) => ({
        status: "Pendente",
        displayedAt: formatter.format(now - hours * hour),
        gross: "US$ 752,00",
        fee: "US$ 2,00",
      })),
    },
  },
  now,
);
result.rows = result.rows.map((r) => ({
  ...r,
  brlNet: r.net == null ? null : String(Number(r.net) * 5),
}));
app.setPath(
  "userData",
  fs.mkdtempSync(path.join(os.tmpdir(), "withdrawals-ui-smoke-")),
);
app
  .whenReady()
  .then(async () => {
    let requests = 0;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const external = /^https?:/.test(details.url);
      if (external) requests++;
      callback({ cancel: external });
    });
    const win = new BrowserWindow({
      width: 1500,
      height: 1100,
      show: false,
      webPreferences: {
        preload: path.join(source, "preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    ipcMain.handle("manager", (event, action) => {
      assert.equal(event.sender, win.webContents);
      if (action === "withdrawals-query") return result;
      if (action === "tab") return true;
      if (action === "state") return null;
      throw Error("Ação de teste não permitida");
    });
    await win.loadFile(path.join(source, "ui/index.html"));
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-tab="withdrawals"]').click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const evidence = await win.webContents.executeJavaScript(
      `({visible:!document.querySelector('#page-withdrawals').hidden,title:document.querySelector('#page-title').textContent,average:document.querySelector('#withdrawal-average').textContent,pending:document.querySelector('#withdrawal-pending-count').textContent,rows:document.querySelectorAll('#withdrawal-rows tr').length,timeline:document.querySelectorAll('#withdrawal-timeline [role="listitem"]').length,overdue:document.querySelectorAll('.withdrawal-overdue').length,node:typeof require})`,
    );
    assert.equal(evidence.visible, true);
    assert.equal(evidence.title, "Saques");
    assert.equal(evidence.average, "30 h");
    assert.equal(evidence.pending, "2");
    assert.equal(evidence.rows, 5);
    assert.equal(evidence.timeline, 5);
    assert.equal(evidence.overdue, 2);
    assert.equal(evidence.node, "undefined");
    assert.equal(requests, 0);
    const output = path.join(__dirname, "../artifacts");
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(
      path.join(output, "withdrawals-smoke.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    fs.writeFileSync(
      path.join(output, "withdrawals-smoke.json"),
      JSON.stringify(
        { ...evidence, externalRequests: requests, realProfileUsed: false },
        null,
        2,
      ),
    );
    console.log("WITHDRAWALS SMOKE PASS " + JSON.stringify(evidence));
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
