const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const source = path.resolve(process.argv[2] || path.join(__dirname, "../src"));
const { ReportStore } = require(path.join(source, "reports.cjs"));
const { withBrl } = require(path.join(source, "exchange.cjs"));
const store = Object.create(ReportStore.prototype),
  now = Date.parse("2026-10-01T18:00:00Z");
store.data = {
  accounts: {
    test: {
      updatedAt: now,
      fullAt: now,
      verified: [],
      coverage: [
        {
          site: "rental",
          from: "2026-09-29",
          to: "2026-10-01",
          complete: true,
        },
        {
          site: "hashsell",
          from: "2026-09-29",
          to: "2026-10-01",
          complete: true,
        },
      ],
      payments: { rows: [] },
      entries: [
        {
          site: "rental",
          at: "2026-09-30T02:00:00.000Z",
          day: "2026-09-29",
          category: "revenue",
          label: "Crédito horário",
          amount: "110",
          wallet: "",
          order: "",
        },
        {
          site: "hashsell",
          at: "2026-09-30T03:00:00.000Z",
          day: "2026-09-30",
          category: "consumption",
          label: "Consumo de hashpower",
          amount: "-100",
          wallet: "Travado",
          order: "HS-TEST",
        },
        {
          site: "hashsell",
          at: "2026-09-30T03:00:00.000Z",
          day: "2026-09-30",
          category: "fees",
          label: "Taxa de consumo",
          amount: "-3",
          wallet: "Travado",
          order: "HS-TEST",
        },
      ],
    },
  },
};
app.setPath(
  "userData",
  fs.mkdtempSync(path.join(os.tmpdir(), "report-period-smoke-")),
);
app
  .whenReady()
  .then(async () => {
    let externalRequests = 0;
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
      const external = /^https?:/.test(d.url);
      if (external) externalRequests++;
      cb({ cancel: external });
    });
    const win = new BrowserWindow({
      show: false,
      width: 1500,
      height: 1100,
      webPreferences: {
        preload: path.join(source, "preload.cjs"),
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    ipcMain.handle("manager", (event, action, filter) => {
      assert.equal(event.sender, win.webContents);
      if (action === "tab") return true;
      if (action === "state") return null;
      if (action === "reports-query")
        return withBrl(store.query("test", filter, now), {
          available: false,
          loading: false,
        });
      throw Error("Ação bloqueada no teste");
    });
    await win.loadFile(path.join(source, "ui/index.html"));
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-tab="reports"]').click()`,
    );
    await new Promise((r) => setTimeout(r, 2800));
    const evidence = await win.webContents.executeJavaScript(
      `(()=>{const rows=[...document.querySelectorAll('#report-days tr')];rows.find(r=>r.textContent.includes('30/09/2026')).querySelector('button').click();const credit=[...document.querySelectorAll('#report-entries tr')].find(r=>r.textContent.includes('Crédito horário'));return {visible:!document.querySelector('#page-reports').hidden,days:rows.map(r=>r.textContent),profit:document.querySelector('[data-metric="profit"] h2').textContent,originalTime:credit.firstElementChild.textContent,closingTime:credit.firstElementChild.title,explanation:document.querySelector('#forecast-assumptions').textContent,chartPoints:document.querySelectorAll('#report-chart circle').length,node:typeof require};})()`,
    );
    assert.equal(evidence.visible, true);
    assert.ok(evidence.profit.includes("7,00"));
    assert.ok(evidence.originalTime.includes("29/09/2026"));
    assert.ok(evidence.closingTime.includes("30/09/2026"));
    assert.ok(evidence.explanation.includes("fechamento"));
    assert.ok(evidence.chartPoints >= 3);
    assert.equal(evidence.node, "undefined");
    assert.equal(externalRequests, 0);
    fs.writeFileSync(
      path.join(__dirname, "../artifacts/report-period-smoke.json"),
      JSON.stringify(
        { ...evidence, externalRequests, realProfileUsed: false },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(__dirname, "../artifacts/report-period-smoke.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    console.log("REPORT PERIOD SMOKE PASS " + JSON.stringify(evidence));
    app.quit();
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
