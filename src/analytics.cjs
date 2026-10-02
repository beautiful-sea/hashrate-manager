const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { randomUUID } = require("node:crypto");
const ENDPOINT = "https://ecoesponja.com.br/hashrate-usage";
function post(payload, endpoint = ENDPOINT) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = https.request(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: 5000,
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", resolve);
    req.end(data);
  });
}
class Analytics {
  constructor(
    dir,
    version,
    {
      enabled = true,
      send = post,
      busy = () => false,
      financial = () => null,
      sendFinancial = (p) => post(p, ENDPOINT + "/financial"),
    } = {},
  ) {
    this.file = path.join(dir, "analytics.json");
    this.version = version;
    this.enabled = enabled;
    this.send = send;
    this.busy = busy;
    this.pending = false;
    this.financial = financial;
    this.sendFinancial = sendFinancial;
    this.financialToken = randomUUID();
    this.financialPending = false;
    this.financialSent = false;
    this.stopped = false;
    this.data = { consent: false, id: randomUUID() };
    let persist = false;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (
        /^[0-9a-f-]{36}$/.test(saved.id) &&
        (typeof saved.consent === "boolean" || saved.consent === null)
      ) {
        this.data = { id: saved.id, consent: saved.consent ?? true };
        persist = saved.consent === null;
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        this.data.consent = true;
        persist = true;
      }
    }
    if (persist) {
      try {
        fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.data), {
          mode: 0o600,
        });
        fs.renameSync(this.file + ".tmp", this.file);
      } catch {
        this.data.consent = false;
      }
    }
  }

  state() {
    return { consent: this.data.consent };
  }
  choose(value) {
    if (typeof value !== "boolean")
      throw Error("Escolha de privacidade invÃ¡lida.");
    const next = { id: this.data.id, consent: value };
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.data = next;
    if (value) {
      void this.ping();
      void this.pingFinancial();
    } else void this.withdrawFinancial();
    return this.state();
  }
  async ping() {
    if (
      !this.enabled ||
      this.data.consent !== true ||
      this.pending ||
      this.busy()
    )
      return;
    this.pending = true;
    try {
      await this.send({ id: this.data.id, version: this.version });
    } catch {
      /* Metrics never block the operation. */
    } finally {
      this.pending = false;
    }
  }
  async withdrawFinancial() {
    if (!this.enabled || !this.financialSent) return;
    try {
      await this.sendFinancial({ token: this.financialToken, remove: true });
    } catch {}
  }
  async pingFinancial() {
    if (
      !this.enabled ||
      this.data.consent !== true ||
      this.stopped ||
      this.financialPending
    )
      return;
    this.financialPending = true;
    try {
      const totals = this.financial();
      if (totals) {
        this.financialSent = true;
        await this.sendFinancial({
          token: this.financialToken,
          capitalCents: totals.capitalCents,
          orders: totals.orders,
        });
      } else await this.withdrawFinancial();
    } catch {
    } finally {
      this.financialPending = false;
      if (this.data.consent !== true || this.stopped)
        await this.withdrawFinancial();
    }
  }
  start() {
    if (!this.enabled) return;
    this.initial = setTimeout(() => void this.ping(), 60000);
    this.timer = setInterval(() => void this.ping(), 3600000);
    this.financialTimer = setInterval(() => void this.pingFinancial(), 60000);
    this.financialTimer.unref?.();
    this.initial.unref?.();
    this.timer.unref?.();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.financialTimer);
    void this.withdrawFinancial();
    clearTimeout(this.initial);
    clearInterval(this.timer);
  }
}
module.exports = { Analytics, ENDPOINT };
