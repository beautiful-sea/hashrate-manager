const { EventEmitter } = require("node:events");
class AppUpdates extends EventEmitter {
  constructor({
    updater,
    version,
    enabled = true,
    begin = () => {},
    acquire,
    release,
    install,
  }) {
    super();
    Object.assign(this, { updater, begin, acquire, release, install, enabled });
    this.value = {
      current: version,
      status: enabled ? "idle" : "disabled",
      percent: 0,
      version: null,
      requested: false,
      transferred: 0,
      total: 0,
      waitingReason: null,
    };
    if (!enabled) return;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.on("checking-for-update", () => this.set({ status: "checking" }));
    updater.on("update-available", (info) =>
      this.set({ status: "downloading", version: info.version, percent: 0 }),
    );
    updater.on("download-progress", (info) =>
      this.set({
        status: "downloading",
        transferred: Math.max(0, Number(info.transferred) || 0),
        total: Math.max(0, Number(info.total) || 0),
        percent: Math.max(0, Math.min(100, Number(info.percent) || 0)),
      }),
    );
    updater.on("update-not-available", () =>
      this.set({ status: "idle", version: null }),
    );
    updater.on("update-downloaded", (info) => {
      this.set({ status: "ready", version: info.version, percent: 100 });
    });
    updater.on("error", () => {
      if (this.value.requested || this.value.status === "installing")
        this.release();
      this.set({ status: "error", requested: false });
    });
  }
  state() {
    return { ...this.value };
  }
  set(patch) {
    Object.assign(this.value, patch);
    this.emit("state", this.state());
  }
  async check() {
    if (
      !this.enabled ||
      this.checking ||
      ["ready", "waiting", "installing", "downloading"].includes(
        this.value.status,
      )
    )
      return this.state();
    this.checking = true;
    try {
      await this.updater.checkForUpdates();
    } catch {
      this.set({ status: "error", requested: false });
    } finally {
      this.checking = false;
    }
    return this.state();
  }
  requestInstall() {
    if (!["ready", "waiting"].includes(this.value.status))
      throw Error("A atualização ainda não está pronta.");
    if (!this.value.requested) {
      try {
        this.begin();
      } catch {
        this.release();
        throw Error("Não foi possível preparar a atualização.");
      }
    }
    this.set({ requested: true });
    this.tryInstall();
    return this.state();
  }
  cancelInstall() {
    if (this.value.status === "waiting") {
      this.release();
      this.set({ requested: false, status: "ready", waitingReason: null });
    }
    return this.state();
  }
  tryInstall() {
    if (
      !this.enabled ||
      !this.value.requested ||
      !["ready", "waiting"].includes(this.value.status)
    )
      return;
    try {
      const result = this.acquire();
      if (!(result === true || result?.ready === true)) {
        this.set({
          status: "waiting",
          waitingReason:
            result?.reason || "Finalizando a operação em andamento.",
        });
        return;
      }
      this.set({ status: "installing", waitingReason: null });
      this.install();
    } catch {
      this.release();
      this.set({
        status: "ready",
        requested: false,
        waitingReason: "Não foi possível preparar o reinício. Tente novamente.",
      });
    }
  }

  start() {
    if (!this.enabled) return;
    this.initial = setTimeout(() => void this.check(), 15000);
    this.timer = setInterval(() => void this.check(), 3600000);
    this.wait = setInterval(() => this.tryInstall(), 1000);
    this.initial.unref?.();
    this.timer.unref?.();
    this.wait.unref?.();
  }
  stop() {
    clearTimeout(this.initial);
    clearInterval(this.timer);
    clearInterval(this.wait);
  }
}
module.exports = { AppUpdates };
