const https = require("node:https");
const D = require("decimal.js").clone({ precision: 50 });
const URL = "https://economia.awesomeapi.com.br/json/last/USD-BRL";
function requestQuote() {
  return new Promise((resolve, reject) => {
    const request = https.get(
      URL,
      { headers: { Accept: "application/json" } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            Error("Cotação indisponível (HTTP " + response.statusCode + ")."),
          );
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 16384)
            request.destroy(Error("Resposta de cotação inválida."));
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(Error("Resposta de cotação inválida."));
          }
        });
      },
    );
    const timer = setTimeout(
      () => request.destroy(Error("Consulta de cotação demorou demais.")),
      8000,
    );
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
  });
}
function parseQuote(body, now = Date.now()) {
  const q = body?.USDBRL;
  if (
    q?.code !== "USD" ||
    q?.codein !== "BRL" ||
    typeof q.bid !== "string" ||
    !/^\d+(?:\.\d+)?$/.test(q.bid) ||
    !new D(q.bid).gt(0) ||
    !/^\d{10,11}$/.test(String(q.timestamp))
  )
    throw Error("Par USD/BRL ou valor de cotação inválido.");
  const at = Number(q.timestamp) * 1000;
  if (!Number.isSafeInteger(at) || at > now + 300000)
    throw Error("Horário da cotação inválido.");
  return {
    rate: q.bid,
    at,
    checkedAt: now,
    source: "AwesomeAPI · dólar comercial (compra)",
  };
}
class Exchange {
  constructor({
    fetchQuote = requestQuote,
    now = Date.now,
    enabled = true,
  } = {}) {
    this.fetchQuote = fetchQuote;
    this.now = now;
    this.enabled = enabled;
    this.quote = null;
    this.lastAttempt = -Infinity;
    this.pending = null;
    this.error = null;
  }
  state() {
    const now = this.now();
    if (this.enabled && !this.pending && now - this.lastAttempt >= 60000) {
      this.lastAttempt = now;
      this.pending = Promise.resolve()
        .then(() => this.fetchQuote())
        .then((data) => {
          this.quote = parseQuote(data, this.now());
          this.error = null;
        })
        .catch(() => {
          this.error = "Não foi possível atualizar a cotação.";
        })
        .finally(() => {
          this.pending = null;
        });
    }
    const q = this.quote;
    return {
      ...q,
      loading: !!this.pending,
      error: this.error,
      available: !!q,
      stale:
        !!q &&
        (now - q.at > 15 * 60000 ||
          now - q.checkedAt > 2 * 60000 ||
          !!this.error),
    };
  }
}
function withBrl(report, fx) {
  const convert = (value) =>
    fx.available ? new D(value).mul(fx.rate).toFixed() : null;
  const amounts = (row) =>
    Object.fromEntries(
      [
        "deposits",
        "revenue",
        "consumption",
        "fees",
        "consumptionFees",
        "withdrawalFees",
        "profit",
        "cumulative",
      ]
        .filter((k) => row[k] != null)
        .map((k) => [k, convert(row[k])]),
    );
  return {
    ...report,
    fx,
    forecast: report.forecast
      ? {
          ...report.forecast,
          brlAverage: convert(report.forecast.average || "0"),
          brlTotal: convert(report.forecast.total || "0"),
          brlInitialCapital: convert(report.forecast.initialCapital || "0"),
          brlBaseline: convert(report.forecast.baseline || "0"),
          brlGain: convert(report.forecast.gain || "0"),
          days: report.forecast.days.map((d) => ({ ...d, brl: amounts(d) })),
        }
      : undefined,
    totals: report.totals
      ? { ...report.totals, brl: amounts(report.totals) }
      : undefined,
    days: (report.days || []).map((d) => ({ ...d, brl: amounts(d) })),
    entries: (report.entries || []).map((r) => ({
      ...r,
      brlAmount: convert(r.amount),
    })),
  };
}
function withWithdrawalBrl(result, fx) {
  return {
    ...result,
    fx,
    rows: result.rows.map((row) => ({
      ...row,
      brlNet:
        fx.available && row.net != null
          ? new D(row.net).mul(fx.rate).toFixed()
          : null,
    })),
  };
}
module.exports = {
  Exchange,
  parseQuote,
  withBrl,
  requestQuote,
  withWithdrawalBrl,
};
