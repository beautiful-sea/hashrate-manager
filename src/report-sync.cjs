const {
  paymentTiming,
  withdrawalCapital,
  withdrawalOverview,
} = require("./reinvestment.cjs");
const { forecast } = require("./forecast.cjs");
const {
  ReportStore,
  accountKey,
  validatePage,
  dayOf,
  usd,
  Decimal,
} = require("./reports.cjs");
const { reportScript } = require("./reports-dom.cjs");
const crypto = require("node:crypto");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function timeout(p, ms) {
  let timer;
  try {
    return await Promise.race([
      p,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Tempo de leitura do relatório esgotado.")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const RETRY_DELAYS = [2000, 5000, 10000];
function recoverable(error) {
  if (
    /login expirado|redirecionada|Conta mudou|interrompida/i.test(error.message)
  )
    return false;
  if ([401, 403].includes(error.status)) return false;
  return (
    error.retryable === true ||
    /HTTP (?:404|408|425|429|5\d\d)\b|tempo (?:de leitura do relatório )?esgotado|ERR_(?:TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED)/i.test(
      error.message,
    )
  );
}
function httpFailure(diagnostic) {
  const bad = diagnostic.items.find(
    (r) =>
      [401, 403, 408, 425, 429].includes(r.status) ||
      r.status >= 500 ||
      (r.type === "mainFrame" && r.status === 404),
  );
  if (!bad) return null;
  return Object.assign(Error("HTTP " + bad.status), {
    status: bad.status,
    retryable: [404, 408, 425, 429].includes(bad.status) || bad.status >= 500,
  });
}
class ReportSync {
  constructor({ dir, views, adapter, monitor }) {
    this.store = new ReportStore(dir);
    this.views = views;
    this.adapter = adapter;
    this.monitor = monitor;
    this.key = null;
    this.busy = false;
    this.error = null;
    this.progress = "Aguardando primeira importação";
    this.stopped = false;
    this.epoch = 0;
    for (const site of ["hashsell", "rental"]) {
      const wc = views[site].webContents;
      adapter.readResponses.set(wc.id, {
        kind: site === "rental" ? "rental" : "orders",
        since: Infinity,
        items: [],
      });
      if (site === "hashsell") adapter.requestGuard.readOnlyIds.add(wc.id);
      else
        wc.session.webRequest.onBeforeRequest((d, cb) =>
          cb({
            cancel:
              d.webContentsId === wc.id &&
              !["GET", "HEAD", "OPTIONS"].includes(d.method),
          }),
        );
    }
  }
  start() {
    this.stopped = false;
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.sync(false), 15 * 60000);
    this.timer.unref();
    void this.sync(false);
  }
  stop() {
    this.stopped = true;
    this.epoch++;
    clearInterval(this.timer);
    clearTimeout(this.refreshTimer);
    for (const v of Object.values(this.views))
      if (!v.webContents.isDestroyed()) v.webContents.stop();
  }
  invalidate() {
    // Navigation requests fresh identity proof, without discarding the last snapshot.
    this.epoch++;
    this.scheduleRefresh();
  }
  scheduleRefresh() {
    if (this.stopped) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      if (this.busy) this.scheduleRefresh();
      else void this.sync(false);
    }, 3000);
    this.refreshTimer.unref?.();
  }
  state(filter) {
    const now = Date.now();
    const account = this.store.data.accounts[this.key];
    const report = this.store.query(this.key, filter, now);
    const projection = forecast(account, now);
    return {
      ...report,
      forecast: projection,
      investment: require("./investment.cjs").investment(
        account,
        report,
        projection,
        now,
      ),
      busy: this.busy,
      error: this.error,
      progress: this.progress,
    };
  }
  withdrawalsState(now = Date.now()) {
    return {
      ...withdrawalOverview(this.store.data.accounts[this.key], now),
      busy: this.busy,
      error: this.error,
    };
  }
  async priority(epoch) {
    while (this.monitor.busy) {
      if (this.stopped || epoch !== this.epoch)
        throw Error("Importação interrompida.");
      this.progress = "Aguardando o ciclo de lances";
      await sleep(300);
    }
    if (this.stopped || epoch !== this.epoch)
      throw Error("Importação interrompida.");
  }
  async waitForRetry(ms, epoch) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (this.stopped || epoch !== this.epoch)
        throw Error("Importação interrompida.");
      await sleep(Math.min(250, until - Date.now()));
    }
    await this.priority(epoch);
  }
  async page(site, url, epoch, payments = false) {
    const parsed = new URL(url);
    const number =
      parsed.searchParams.get(site === "hashsell" ? "page" : "extrato") || "1";
    const label =
      (site === "hashsell" ? "Hashsell" : "RentalHash") + " · página " + number;
    for (let attempt = 0; ; attempt++) {
      await this.priority(epoch);
      this.progress =
        label + (attempt ? " · tentativa " + (attempt + 1) + "/4" : "");
      try {
        return await this.pageOnce(site, url, epoch, payments);
      } catch (error) {
        if (this.stopped || epoch !== this.epoch)
          throw Error("Importação interrompida.");
        if (!recoverable(error)) throw error;
        if (attempt >= RETRY_DELAYS.length)
          throw Error(label + ": falha após 4 tentativas. " + error.message);
        const backoff = Math.max(
          0,
          (this.adapter.readBackoff?.get(site) || 0) - Date.now(),
        );
        const wait = Math.max(
          RETRY_DELAYS[attempt],
          backoff,
          /HTTP 429\b/.test(error.message) ? 60000 : 0,
        );
        if (wait > 15 * 60000)
          throw Error(
            label +
              ": limite de consultas; aguarde o prazo da plataforma. " +
              error.message,
          );
        this.progress =
          label +
          " · " +
          error.message +
          " · nova tentativa " +
          (attempt + 2) +
          "/4 em " +
          Math.ceil(wait / 1000) +
          "s";
        await this.waitForRetry(wait, epoch);
      }
    }
  }
  async pageOnce(site, url, epoch, payments = false) {
    this.adapter.assertReadAvailable(site);
    const wc = this.views[site].webContents,
      diagnostic = this.adapter.readResponses.get(wc.id);
    diagnostic.since = Date.now();
    diagnostic.items = [];
    try {
      await this.adapter.navigate(wc, url, site, 12000, true);
    } catch (error) {
      throw httpFailure(diagnostic) || error;
    }
    const http = httpFailure(diagnostic);
    if (http) throw http;
    const expected = new URL(url);
    if (new URL(wc.getURL()).pathname !== expected.pathname)
      throw Error(site + ": login expirado ou página redirecionada.");
    let result;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (this.stopped || epoch !== this.epoch)
        throw Error("Importação interrompida.");
      this.adapter.assertReadAvailable(site);
      const bad = httpFailure(diagnostic);
      if (bad) throw bad;
      // Some Next.js failures render an error document with HTTP 200.
      const soft404 = await timeout(
        wc.mainFrame.executeJavaScript(
          `(()=>{const h=[document.title,...[...document.querySelectorAll('h1,h2')].map(n=>n.textContent)].join(' ');return /(?:^|\\s)404(?:\\s|:|$)|this page could not be found|página não encontrada/i.test(h)})()`,
        ),
        2000,
      );
      if (soft404)
        throw Object.assign(Error("HTTP 404 / página não encontrada"), {
          status: 404,
          retryable: true,
        });
      result = await timeout(
        wc.mainFrame.executeJavaScript(
          reportScript(payments ? "payments" : site),
        ),
        2000,
      );
      if (result?.ok && (payments || result.value?.capital || attempt === 11))
        break;
      await sleep(250);
    }
    if (!result?.ok)
      throw Error(site + ": " + (result?.error || "Extrato indisponível."));
    const raw = result.value;
    return {
      ...raw,
      account: accountKey(site, raw.account),
      rows: payments ? raw.rows : validatePage(site, raw),
    };
  }
  async collect(site, first, full, from, epoch) {
    const base =
      site === "hashsell"
        ? "https://hashsell.com/wallet"
        : "https://rentalhash.com/painel/financeiro";
    const rows = [],
      fingerprints = new Set();
    let page = first,
      previous = Infinity,
      pages = 0;
    const fingerprint = (p) =>
      crypto.createHash("sha256").update(JSON.stringify(p.rows)).digest("hex");
    const initial = fingerprint(first);
    for (;;) {
      this.progress = `${site === "hashsell" ? "Hashsell" : "RentalHash"} · página ${page.current}`;
      if (page.account !== first.account)
        throw Error("Conta mudou durante a importação.");
      if (page.current !== ++pages || pages > 500)
        throw Error("Paginação incompleta ou excedida.");
      const mark = fingerprint(page);
      if (fingerprints.has(mark))
        throw Error("Página repetida. Histórico anterior preservado.");
      fingerprints.add(mark);
      for (const row of page.rows) {
        const at = Date.parse(row.at);
        if (at > previous)
          throw Error("Ordenação do extrato mudou. Repita a importação.");
        previous = at;
        rows.push(row);
      }
      if (
        site === "hashsell" &&
        (!page.counter ||
          page.counter[0] !== rows.length - page.rows.length + 1 ||
          page.counter[1] !== rows.length ||
          page.counter[2] !== first.counter?.[2])
      )
        throw Error("Contagem da carteira mudou ou está incompleta.");
      if (!full && page.rows.at(-1).day < from) break;
      if (!page.next) {
        if (site === "hashsell" && rows.length !== page.counter[2])
          throw Error("Extrato Hashsell incompleto.");
        break;
      }
      if (page.next.page !== page.current + 1)
        throw Error("Salto na paginação.");
      await sleep(1200);
      page = await this.page(site, page.next.url, epoch);
    }
    await sleep(1200);
    const check = await this.page(site, base, epoch);
    if (check.account !== first.account || fingerprint(check) !== initial)
      throw Error(
        "Extrato mudou durante a leitura. Dados anteriores preservados.",
      );
    return {
      site,
      rows,
      complete: true,
      capital: check.capital || first.capital,
    };
  }
  async collectPayments(account, prior, epoch) {
    const base = "https://rentalhash.com/painel/financeiro";
    const rows = [],
      items = [],
      pending = [],
      completed = [],
      seen = new Set();
    let url = base,
      number = 1,
      first;
    for (;;) {
      const page = await this.page("rental", url, epoch, true);
      if (page.account !== account)
        throw Error("Conta mudou durante a importação.");
      const mark = JSON.stringify(page.rows);
      if (seen.has(mark) || page.current !== number || number > 500)
        throw Error("Paginação de pagamentos repetida ou incompleta.");
      seen.add(mark);
      if (!first) first = mark;
      for (const r of page.rows) {
        items.push(r);
        if (r.status !== "Concluído") {
          if (!["Cancelado", "Falhou"].includes(r.status)) {
            if (!r.gross)
              throw Error("Valor do saque em andamento não identificado.");
            const gross = new Decimal(usd(r.gross)),
              fee = new Decimal(usd(r.fee));
            if (!gross.gt(0) || fee.lt(0) || fee.gt(gross))
              throw Error("Valor do saque em andamento inválido.");
            pending.push({ ...r, net: gross.minus(fee).toFixed() });
          }
          continue;
        }
        if (!r.id) throw Error("Pagamento concluído sem identificador.");
        completed.push(r);
        const fee = usd(r.fee);
        if (fee.startsWith("-")) throw Error("Taxa de saque inválida.");
        rows.push({
          site: "rental",
          at: "",
          day: r.day,
          displayedAt: r.displayedAt,
          label: "Taxa de saque",
          wallet: "",
          order: "",
          amount: "-" + fee,
          category: "fees",
          feeKind: "withdrawal",
          id: r.id,
        });
      }
      if (!page.next) break;
      number++;
      url = page.next.url;
      await sleep(1200);
    }
    const check = await this.page("rental", base, epoch, true);
    if (check.account !== account || JSON.stringify(check.rows) !== first)
      throw Error("Histórico de pagamentos mudou durante a leitura.");
    // Requests outside the recent window can finish now. Payments are read in
    // full and reconciled by their receipt, preserving previously posted fees.
    const previous = prior?.rows || [];
    if (
      [previous, rows].some(
        (list) => new Set(list.map((r) => r.id)).size !== list.length,
      )
    )
      throw Error("Pagamento duplicado no histórico.");
    const byId = new Map(previous.map((r) => [r.id, r]));
    for (const row of rows) byId.set(row.id, row);
    const merged = [...byId.values()];
    let timing = prior?.timing || null,
      timingAt = prior?.timingAt || (prior?.timing ? prior.at : null),
      timingError = null;
    try {
      await this.priority(epoch);
      const wc = this.views.rental.webContents;
      const csv = await timeout(
        wc.mainFrame.executeJavaScript(
          `(async()=>{const r=await fetch('/painel/financeiro/exportar',{signal:AbortSignal.timeout(10000)});if(!r.ok||!r.headers.get('content-type')?.includes('text/csv'))throw Error('Exportação indisponível');return r.text()})()`,
        ),
        12000,
      );
      const imported = paymentTiming(csv);
      const identity = await timeout(
        wc.mainFrame.executeJavaScript(reportScript("payments")),
        2000,
      );
      if (
        !identity?.ok ||
        accountKey("rental", identity.value.account) !== account ||
        epoch !== this.epoch
      )
        throw Error("Conta mudou durante a importação.");
      const ids = new Set(merged.map((r) => r.id));
      if (imported.some((p) => !ids.has(p.id)))
        throw Error("Exportação e extrato divergentes.");
      timing = imported;
      timingAt = Date.now();
    } catch (e) {
      if (/Conta mudou/.test(e.message)) throw e;
      timingError =
        "Não foi possível atualizar as datas dos saques. A média anterior foi preservada.";
    }
    return {
      at: Date.now(),
      rows: merged,
      timing,
      timingAt,
      timingError,
      items,
      pending,
      completed,
    };
  }
  async sync(forceFull = false) {
    if (this.busy || this.stopped || this.maintenance) return false;
    this.busy = true;
    this.error = null;
    const epoch = this.epoch;
    try {
      const h = await this.page(
        "hashsell",
        "https://hashsell.com/wallet",
        epoch,
      );
      await sleep(1200);
      const r = await this.page(
        "rental",
        "https://rentalhash.com/painel/financeiro",
        epoch,
      );
      await this.priority(epoch);
      const key = `${h.account}:${r.account}`;
      // Identity is never restored from yesterday's session without fresh proof.
      this.key = key;
      const prior = this.store.data.accounts[key];
      const full = forceFull || !prior?.fullAt;
      const from = dayOf(
        Math.min(Date.now(), prior?.updatedAt || Date.now()) - 86400000,
      );
      const snapshots = [];
      snapshots.push(await this.collect("hashsell", h, full, from, epoch));
      snapshots.push(await this.collect("rental", r, full, from, epoch));
      await this.priority(epoch);
      const payments = await this.collectPayments(
        r.account,
        prior?.payments,
        epoch,
      );
      await this.priority(epoch);
      const transfer = withdrawalCapital(payments, prior?.payments, [
        ...(prior?.entries || []),
        ...snapshots.flatMap((s) => s.rows),
      ]);
      payments.settling = transfer.settling;
      const capital =
        snapshots[0].capital && snapshots[1].capital
          ? {
              hashsell: usd(snapshots[0].capital),
              rental: usd(snapshots[1].capital),
              inTransit: transfer.inTransit,
              at: Date.now(),
            }
          : prior?.capital || null;
      this.store.commit(key, snapshots, { full, from, payments, capital });
      this.progress = `${full ? "Histórico completo" : "Lançamentos recentes"} importado com sucesso`;
      return true;
    } catch (e) {
      if (/login expirado|redirecionada|Conta mudou/i.test(e.message))
        this.key = null;
      this.error = e.message;
      this.progress =
        "Importação não concluída; dados completos anteriores preservados";
      return false;
    } finally {
      this.busy = false;
    }
  }
}
module.exports = { ReportSync };
