const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  Tray,
  Menu,
  nativeImage,
  dialog,
  powerMonitor,
  clipboard,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { Store } = require("./store.cjs");
const { Monitor } = require("./monitor.cjs");
const { BrowserAdapter, allowed } = require("./adapters.cjs");
const { ReportSync } = require("./report-sync.cjs");
const { csv } = require("./reports.cjs");
const { Exchange, withBrl, withWithdrawalBrl } = require("./exchange.cjs");
const { withdrawalOverview } = require("./reinvestment.cjs");
const { UpdateGate } = require("./update-gate.cjs");
const { AppUpdates } = require("./app-updates.cjs");
const { Analytics } = require("./analytics.cjs");
const smoke = process.argv.includes("--smoke");
// CI Mac runners may not provide a usable graphics device.
if (smoke) app.disableHardwareAcceleration();
const manualMacUpdates =
  process.platform === "darwin" &&
  require("../package.json").macAutoUpdates !== true;
const exchange = new Exchange({ enabled: !smoke });
const reportDiagnose = process.argv.includes("--reports-diagnose");
const diagnose = process.argv.includes("--diagnose") || reportDiagnose;
if (smoke)
  app.setPath(
    "userData",
    fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-electron-")),
  );
app.setAppUserModelId("com.lg.hashrate-manager");
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win,
    tray,
    monitor,
    reports,
    updates,
    analytics,
    store,
    quitting = false,
    activeTab = "dashboard",
    updateDialogOpen = false,
    donationDialogOpen = false;
  const views = {};
  const reportViews = {};
  const visible = {};
  const uiUrl = pathToFileURL(path.join(__dirname, "ui", "index.html")).href;
  const icon = () =>
    nativeImage.createFromPath(path.join(__dirname, "assets", "icon.png"));
  function quitApp() {
    quitting = true;
    app.quit();
  }
  function bounds() {
    for (const [key, v] of Object.entries(visible)) {
      const shown =
        activeTab === key && !updateDialogOpen && !donationDialogOpen;
      v.setVisible(shown);
      if (shown) {
        const [w, h] = win.getContentSize();
        v.setBounds({
          x: 224,
          y: 136,
          width: Math.max(1, w - 224),
          height: Math.max(1, h - 136),
        });
      }
    }
  }
  function makeView(site) {
    const partition = smoke ? `smoke-${site}` : `persist:hashrate-${site}`;
    const ses = session.fromPartition(partition);
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    if (smoke)
      ses.webRequest.onBeforeRequest((_details, cb) => cb({ cancel: true }));
    const v = new WebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    const wc = v.webContents;
    v.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (event, url) => {
      if (!allowed(url, site)) event.preventDefault();
    });
    wc.on("will-redirect", (event, url) => {
      if (!allowed(url, site)) event.preventDefault();
    });
    wc.on("will-attach-webview", (event) => event.preventDefault());
    return v;
  }
  async function ensureSite(key) {
    const url =
      key === "rental"
        ? "https://rentalhash.com/login"
        : "https://hashsell.com/orders";
    if (!visible[key].webContents.getURL())
      await visible[key].webContents.loadURL(url);
  }
  async function confirm(title, message, detail) {
    const r = await dialog.showMessageBox(win, {
      type: "warning",
      title,
      message,
      detail,
      buttons: ["Cancelar", "Confirmar"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return r.response === 1;
  }
  function publish(state) {
    if (!win.isDestroyed()) win.webContents.send("state", state);
    tray?.setToolTip(
      `Hashrate Manager · ${state.running ? (state.mode === "live" ? "Ajustes ativos" : "Monitorando") : "Pausado"}`,
    );
  }
  app.on("second-instance", () => {
    win?.show();
    win?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      try {
        store = new Store(app.getPath("userData"));
      } catch (e) {
        dialog.showErrorBox("Estado não pôde ser aberto", e.message);
        app.quit();
        return;
      }
      win = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 1100,
        minHeight: 740,
        title: "Hashrate Manager",
        backgroundColor: "#0c1116",
        icon: icon(),
        show: !smoke && !diagnose,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
      win.removeMenu();
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (e) => e.preventDefault());
      win.webContents.on("will-attach-webview", (e) => e.preventDefault());
      for (const key of ["hashsell", "rental"]) {
        visible[key] = makeView(key);
        win.contentView.addChildView(visible[key]);
        visible[key].setVisible(false);
      }
      for (const key of [
        "rental",
        "market",
        "orders",
        "editor",
        "reconcile",
        "wallet",
        "creation",
        "creationEvidence",
      ])
        views[key] = makeView(key === "rental" ? "rental" : "hashsell");
      monitor = new Monitor(
        store,
        new BrowserAdapter(views, { blockAll: smoke }),
      );
      monitor.on("state", publish);
      if (!smoke) {
        for (const site of ["hashsell", "rental"])
          reportViews[site] = makeView(site);
        try {
          reports = new ReportSync({
            dir: app.getPath("userData"),
            views: reportViews,
            adapter: monitor.adapter,
            monitor,
          });
          for (const v of Object.values(visible)) {
            v.webContents.on("did-navigate", () => reports.invalidate());
            v.webContents.on("did-navigate-in-page", () =>
              reports.invalidate(),
            );
          }
        } catch (error) {
          store.log("error", { message: "Relatórios: " + error.message });
        }
      }
      for (const v of [...Object.values(views), ...Object.values(visible)])
        v.webContents.on("render-process-gone", () => {
          monitor.disableAdjustments();
          store.log("error", {
            message:
              "Uma página encerrou inesperadamente. Ajustes automáticos desligados.",
          });
        });
      powerMonitor.on("suspend", () => monitor.stop());
      powerMonitor.on("resume", () => {
        monitor.stop();
        store.log("system", {
          message: "Computador retomou. Atualize leituras antes de reativar.",
        });
      });
      tray = new Tray(icon().resize({ width: 32, height: 32 }));
      tray.setToolTip("Hashrate Manager · Pausado");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Abrir painel", click: () => win.show() },
          { label: "Pausar ajustes", click: () => monitor.stop() },
          { type: "separator" },
          {
            label: "Sair",
            click: quitApp,
          },
        ]),
      );
      tray.on("double-click", () => win.show());
      win.on("resize", bounds);
      win.on("close", (event) => {
        if (!quitting && !smoke) {
          event.preventDefault();
          win.hide();
        }
      });
      ipcMain.handle("manager", async (event, action, payload) => {
        if (
          event.sender !== win.webContents ||
          event.senderFrame?.url !== uiUrl ||
          event.senderFrame?.parent
        )
          throw Error("IPC não autorizado.");
        if (
          monitor.maintenance &&
          ![
            "state",
            "app-quit",
            "tab",
            "updates-state",
            "updates-dialog",
            "donation-info",
            "donation-dialog",
            "donation-copy",
            "updates-cancel",
            "withdrawals-query",
            "reports-query",
          ].includes(action)
        )
          throw Error("Aguarde o reinício para concluir a atualização.");
        switch (action) {
          case "app-quit":
            quitApp();
            return true;
          case "analytics-state":
            return analytics?.state() || { consent: null };
          case "analytics-consent":
            return analytics.choose(payload);
          case "donation-info":
            return require("./donation.json");
          case "donation-copy": {
            const data = require("./donation.json");
            if (!data.payload) throw Error("Pix ainda não configurado.");
            clipboard.writeText(data.payload);
            return true;
          }
          case "donation-dialog":
            if (typeof payload !== "boolean")
              throw Error("Estado da contribuição inválido.");
            donationDialogOpen = payload;
            bounds();
            return true;
          case "updates-dialog":
            if (typeof payload !== "boolean")
              throw Error("Estado do aviso inválido.");
            updateDialogOpen = payload;
            bounds();
            return true;
          case "updates-state":
            return (
              updates?.state() || {
                status: "disabled",
                current: app.getVersion(),
              }
            );
          case "updates-check":
            if (manualMacUpdates && app.isPackaged && !smoke && !diagnose) {
              await require("electron").shell.openExternal(
                "https://beautiful-sea.github.io/hashrate-manager/#download",
              );
              return updates.state();
            }
            return updates.check();
          case "updates-install":
            return updates.requestInstall();
          case "updates-cancel":
            return updates.cancelInstall();
          case "withdrawals-query":
            return withWithdrawalBrl(
              reports?.withdrawalsState() || withdrawalOverview(null),
              exchange.state(),
            );
          case "reports-query":
            if (!reports)
              return {
                ready: false,
                days: [],
                entries: [],
                warnings: ["Relatórios indisponíveis nesta sessão."],
                progress: "Sem importação",
                busy: false,
              };
            return withBrl(reports.state(payload), exchange.state());
          case "reports-sync":
            if (!reports) throw Error("Relatórios indisponíveis.");
            void reports.sync(false);
            return true;
          case "reports-export": {
            if (!reports) throw Error("Relatórios indisponíveis.");
            const report = reports.state(payload);
            if (!report.ready) throw Error("Aguarde uma importação completa.");
            const result = await dialog.showSaveDialog(win, {
              defaultPath: "arbitragem.csv",
              filters: [{ name: "CSV", extensions: ["csv"] }],
            });
            if (!result.canceled)
              fs.writeFileSync(result.filePath, csv(report), "utf8");
            return !result.canceled;
          }
          case "creation-options":
            return monitor.creationOptions();
          case "state":
            return monitor.snapshot();
          case "tab":
            if (
              ![
                "dashboard",
                "hashsell",
                "rental",
                "history",
                "reports",
                "withdrawals",
                "settings",
              ].includes(payload)
            )
              throw Error("Aba inválida.");
            activeTab = payload;
            bounds();
            if (visible[payload] && !smoke)
              void ensureSite(payload).catch((e) => {
                store.log("error", {
                  message: `Página indisponível: ${e.message}`,
                });
                monitor.publish();
              });
            return true;
          case "start":
            void monitor.start();
            return true;
          case "stop":
            monitor.stop();
            return true;
          case "refresh":
            void monitor.tick();
            return true;
          case "disable-adjustments":
            monitor.disableAdjustments();
            return true;
          case "save":
            if (monitor.busy)
              throw Error("Aguarde o ciclo atual antes de salvar.");
            monitor.updateConfig(payload);
            return true;
          case "live":
            if (smoke) throw Error("Smoke bloqueia operação real.");
            if (
              await confirm(
                "Ativar ajustes automáticos",
                "Autorizar alterações de lance em todas as ordens ativas?",
                `Margem mínima ${(Number(monitor.config.margin) * 100).toFixed(1)}%. Inclui todas as ordens ativas atuais e novas ordens detectadas durante o monitoramento. Isso pode alterar o gasto real. Pausar o robô não cancela as ordens.`,
              )
            )
              monitor.live();
            return true;
          case "recheck":
            await monitor.recheckPending(String(payload));
            return true;
          case "resolve":
            monitor.stop();
            if (
              await confirm(
                "Conferência manual",
                "Você conferiu o lance e o histórico desta ordem na Hashsell?",
                `Encerrar a pendência de ${String(payload)} libera futuras alterações quando você reativar. Não há reenvio agora.`,
              )
            )
              store.resolveManually(String(payload));
            monitor.publish();
            return true;
          case "reload":
            if (!visible[payload]) throw Error("Plataforma inválida.");
            visible[payload].webContents.reload();
            return true;
          case "inspect":
            if (!visible[payload]) throw Error("Plataforma inválida.");
            visible[payload].webContents.openDevTools({ mode: "detach" });
            return true;
          case "export": {
            const result = await dialog.showSaveDialog(win, {
              defaultPath: "hashrate-historico.json",
              filters: [{ name: "JSON", extensions: ["json"] }],
            });
            if (!result.canceled) {
              fs.writeFileSync(
                result.filePath,
                JSON.stringify(store.state.history, null, 2),
              );
              return true;
            }
            return false;
          }
          default:
            throw Error("Ação desconhecida.");
        }
      });
      const gate = new UpdateGate(monitor, reports, store);
      updates = new AppUpdates({
        enabled: app.isPackaged && !smoke && !diagnose && !manualMacUpdates,
        manualDownloadUrl:
          app.isPackaged && manualMacUpdates && !smoke && !diagnose
            ? "https://beautiful-sea.github.io/hashrate-manager/#download"
            : null,
        version: app.getVersion(),
        updater:
          app.isPackaged && !smoke && !diagnose
            ? require("electron-updater").autoUpdater
            : null,
        begin: () => gate.begin(),
        acquire: () => gate.acquire(),
        release: () => {
          quitting = false;
          gate.release();
        },
        install: () => {
          quitting = true;
          require("electron-updater").autoUpdater.quitAndInstall(true, true);
        },
      });
      updates.on("state", (value) => {
        if (value.status === "ready" && !win.isDestroyed() && !win.isVisible())
          win.show();
      });
      analytics = new Analytics(app.getPath("userData"), app.getVersion(), {
        enabled: !smoke && !diagnose,
        busy: () => monitor.busy || reports?.busy || monitor.maintenance,
      });
      await win.loadURL(uiUrl);
      analytics.start();
      updates.start();
      if (!smoke && !diagnose) {
        reports?.start();
        void monitor.startAutomatic().catch((error) => {
          store.log("error", {
            message: `Inicialização dos ajustes: ${error.message}`,
          });
          void monitor.start();
        });
      }
      if (reportDiagnose) {
        const ok = await reports?.sync(false);
        const result = reports?.state({ preset: "all" });
        fs.writeFileSync(
          path.join(app.getPath("userData"), "reports-diagnostic.json"),
          JSON.stringify(
            {
              ok,
              ready: result?.ready,
              error: result?.error,
              count: result?.entries.length,
              totals: result?.totals,
              coverage: result?.coverage,
              at: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-tab="reports"]').click()`,
        );
        await new Promise((r) => setTimeout(r, 2800));
        fs.writeFileSync(
          path.join(app.getPath("userData"), "reports-installed.png"),
          (await win.webContents.capturePage()).toPNG(),
        );
        quitting = true;
        app.quit();
        return;
      }
      if (diagnose) {
        await monitor.tick();
        const report = {
          at: new Date().toISOString(),
          sources: monitor.snapshots,
          errors: monitor.errors,
          mode: monitor.mode,
        };
        fs.writeFileSync(
          path.join(app.getPath("userData"), "read-diagnostic.json"),
          JSON.stringify(report, null, 2),
        );
        monitor.stop();
        quitting = true;
        app.quit();
        return;
      }
      if (smoke) {
        try {
          monitor.setDemo(true);
          await monitor.start();
          await new Promise((r) => setTimeout(r, 350));
          const evidence = await win.webContents.executeJavaScript(
            `({ title:document.title, rows:document.querySelectorAll('#orders-body tr').length, rate:document.querySelector('#rental-value').textContent, node:typeof require, mode:document.querySelector('#mode-label').textContent, adjustments:document.querySelector('#execution-title').textContent, demoControl:!!document.querySelector('#demo,#use-real'), adjustmentsDisabled:document.querySelector('#enable-live').disabled })`,
          );
          if (
            evidence.rows !== 2 ||
            evidence.node !== "undefined" ||
            evidence.mode !== "MONITORANDO" ||
            evidence.adjustments !== "Ajustes automáticos desligados" ||
            evidence.demoControl ||
            !evidence.adjustmentsDisabled ||
            !evidence.rate.includes("43")
          )
            throw Error("Dashboard smoke falhou: " + JSON.stringify(evidence));
          const demoBlocked = await win.webContents.executeJavaScript(
            `window.hashrate.invoke('demo', true).then(() => false, () => true)`,
          );
          if (!demoBlocked)
            throw Error("IPC de demonstração não foi removido.");
          const out =
            process.env.HASHRATE_SMOKE_OUTPUT ||
            path.join(
              app.isPackaged
                ? app.getPath("userData")
                : path.join(__dirname, ".."),
              "artifacts",
            );
          fs.mkdirSync(out, { recursive: true });
          fs.writeFileSync(
            path.join(out, "dashboard.png"),
            (await win.webContents.capturePage()).toPNG(),
          );
          await win.webContents.executeJavaScript(
            `document.querySelector('[data-tab="settings"]').click()`,
          );
          await new Promise((r) => setTimeout(r, 100));
          const settings = await win.webContents.executeJavaScript(
            `({visible:!document.querySelector('#page-settings').hidden, margin:document.querySelector('[name="margin"]').value, manualIds:!!document.querySelector('[name="managedOrders"]')})`,
          );
          if (
            !settings.visible ||
            settings.margin !== "5" ||
            settings.manualIds
          )
            throw Error("Settings smoke falhou.");
          const fundingBehavior = await win.webContents.executeJavaScript(
            `(()=>{const select=document.querySelector('[name="creation-funding"]'),amount=document.querySelector('[name="creation-amount"]');select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}));const all=amount.disabled&&amount.closest('label').hidden&&!new FormData(document.querySelector('#settings-form')).has('creation-amount');select.value='fixed';select.dispatchEvent(new Event('change',{bubbles:true}));return {all,fixed:!amount.disabled&&!amount.closest('label').hidden};})()`,
          );
          if (!fundingBehavior.all || !fundingBehavior.fixed)
            throw Error("Funding controls smoke failed.");
          const sizingBehavior = await win.webContents.executeJavaScript(
            `(()=>{const select=document.querySelector('[name="creation-sizing"]'),hours=document.querySelector('[name="creation-hours"]'),speed=document.querySelector('[name="creation-speedPH"]');select.value='duration';select.dispatchEvent(new Event('change',{bubbles:true}));const duration=!hours.disabled&&!hours.closest('label').hidden&&speed.disabled&&speed.closest('label').hidden;select.value='power';select.dispatchEvent(new Event('change',{bubbles:true}));return {duration,power:hours.disabled&&hours.closest('label').hidden&&!speed.disabled&&!speed.closest('label').hidden};})()`,
          );
          if (!sizingBehavior.duration || !sizingBehavior.power)
            throw Error("Duration sizing controls smoke failed.");
          const controls = await win.webContents.executeJavaScript(
            `(()=>{const c=document.querySelector('[name="creation-enabled"]'),p=document.querySelector('[name="creation-destination"]');return {checkbox:c.getBoundingClientRect().width,select:p.getBoundingClientRect().height,visible:!document.querySelector('#creation-settings').hidden,overflow:document.documentElement.scrollWidth>innerWidth};})()`,
          );
          if (
            controls.checkbox > 24 ||
            controls.select < 40 ||
            !controls.visible ||
            controls.overflow
          )
            throw Error(
              "Settings layout smoke failed: " + JSON.stringify(controls),
            );
          fs.writeFileSync(
            path.join(out, "settings.png"),
            (await win.webContents.capturePage()).toPNG(),
          );
          await win.webContents.executeJavaScript(
            `document.querySelector('[data-tab="withdrawals"]').click()`,
          );
          await new Promise((r) => setTimeout(r, 100));
          const withdrawals = await win.webContents.executeJavaScript(
            `(async()=>{const data=await window.hashrate.invoke('withdrawals-query');return {visible:!document.querySelector('#page-withdrawals').hidden,ready:data.ready,rows:data.rows.length,mean:document.querySelector('#withdrawal-average').textContent}})()`,
          );
          if (
            !withdrawals.visible ||
            withdrawals.ready ||
            withdrawals.rows !== 0 ||
            withdrawals.mean !== "—"
          )
            throw Error("Saques smoke falhou.");
          fs.writeFileSync(
            path.join(out, "smoke.json"),
            JSON.stringify(
              {
                passed: true,
                electron: process.versions.electron,
                evidence,
                settings,
                withdrawals,
                network: "blocked",
                liveWrites: 0,
              },
              null,
              2,
            ),
          );
          console.log("SMOKE PASS " + JSON.stringify(evidence));
          monitor.stop();
          quitting = true;
          app.quit();
        } catch (e) {
          console.error(e);
          quitting = true;
          app.exit(1);
        }
      }
    })
    .catch((e) => {
      console.error(e);
      app.exit(1);
    });
  app.on("before-quit", () => {
    analytics?.stop();
    updates?.stop();
    quitting = true;
    reports?.stop();
    for (const v of Object.values(reportViews))
      if (!v.webContents.isDestroyed()) v.webContents.close();
    monitor?.stop();
    for (const v of [...Object.values(views), ...Object.values(visible)])
      if (!v.webContents.isDestroyed()) v.webContents.close();
  });
  app.on("window-all-closed", () => app.quit());
}
