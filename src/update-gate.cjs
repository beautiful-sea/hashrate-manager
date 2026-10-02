class UpdateGate {
  constructor(monitor, reports, store) {
    Object.assign(this, { monitor, reports, store });
    this.active = false;
  }
  begin() {
    if (this.active) return;
    this.active = true;
    this.resumeReports = !!this.reports && !this.reports.stopped;
    this.monitor.maintenance = true;
    if (this.reports) {
      this.reports.maintenance = true;
      this.reports.stop();
    }
  }
  acquire() {
    if (!this.active) throw Error("Update preparation not reserved");
    if (this.monitor.busy)
      return { ready: false, reason: "Finalizando o ciclo de monitoramento." };
    if (this.reports?.busy)
      return { ready: false, reason: "Finalizando a leitura do relatório." };
    // Existing pending records are durable reconciliation, not an active dispatch.
    // Flush unchanged state. Do not clear, resolve or resend any attempt.
    this.store.commit(() => {});
    return { ready: true };
  }
  release() {
    if (!this.active) return;
    this.active = false;
    this.monitor.maintenance = false;
    if (this.reports) {
      this.reports.maintenance = false;
      if (this.resumeReports) this.reports.start();
    }
    if (this.monitor.running) queueMicrotask(() => void this.monitor.tick());
  }
}
module.exports = { UpdateGate };
