const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Decimal = require("decimal.js").clone({ precision: 50 });
const ZONE = "America/Sao_Paulo";
function dayOf(at) {
  if (!Number.isFinite(new Date(at).getTime())) throw Error("Data inválida.");
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
function usd(raw) {
  const s = String(raw).replace(/\s/g, "").replace(/−/g, "-");
  const m = s.match(/^([+-]?)US\$(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,12}))?$/);
  if (!m) throw Error("Valor USD não reconhecido.");
  return `${m[1] === "-" ? "-" : ""}${m[2].replace(/\./g, "")}${m[3] ? "." + m[3] : ""}`;
}
function accountKey(site, account) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account || ""))
    throw Error("Conta não identificada.");
  return crypto
    .createHash("sha256")
    .update(`${site}:${account.trim().toLowerCase()}`)
    .digest("hex");
}
function normalize(site, raw) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw.at))
    throw Error("Data sem ano ou fuso comprovado.");
  const date = new Date(raw.at);
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  if (local !== raw.displayed)
    throw Error("Horário exibido diverge do fuso verificado.");
  const amount = usd(raw.amount),
    value = new Decimal(amount);
  let category = "unknown";
  if (site === "rental" && raw.label === "Crédito horário" && value.gte(0))
    category = "revenue";
  if (site === "hashsell") {
    if (raw.label === "Consumo de hashpower" && value.lte(0))
      category = "consumption";
    if (raw.label === "Taxa de consumo" && value.lte(0)) category = "fees";
    if (
      ["Reserva para ordem", "Devolução"].includes(raw.label) &&
      ["Disponível", "Travado"].includes(raw.wallet)
    )
      category = "transfer";
    if (
      /\bRecarga\b/.test(raw.label) &&
      /\bCreditado\b/.test(raw.label) &&
      value.gt(0)
    )
      category = "deposits";
  }
  // Unknown refunds remain visible; never infer their economic nature from sign.
  return {
    site,
    at: date.toISOString(),
    day: dayOf(raw.at),
    label: raw.label,
    wallet: raw.wallet,
    order: raw.order,
    amount,
    category,
  };
}
function validatePage(site, page) {
  if (!page?.rows?.length) throw Error("Extrato vazio não comprova cobertura.");
  const rows = page.rows.map((r) => normalize(site, r));
  for (const check of page.checks || []) {
    const daily = rows.filter((r) => r.day === check.day);
    const sum = daily.reduce((s, r) => s.plus(r.amount), new Decimal(0));
    if (
      daily.length !== check.count ||
      sum
        .minus(usd(check.total))
        .abs()
        .gt(new Decimal("0.005").plus(new Decimal("0.00005").mul(daily.length)))
    )
      throw Error("Total diário não confere com os créditos horários.");
  }
  return rows;
}
const blank = () => ({
  deposits: "0",
  revenue: "0",
  consumption: "0",
  fees: "0",
  consumptionFees: "0",
  withdrawalFees: "0",
  profit: "0",
  margin: null,
  unknown: 0,
});
function sumRows(rows) {
  const total = blank();
  for (const r of rows) {
    if (r.category === "unknown") total.unknown++;
    if (r.category === "fees") {
      const key =
        r.feeKind === "withdrawal" ? "withdrawalFees" : "consumptionFees";
      total[key] = new Decimal(total[key]).minus(r.amount).toFixed();
    }
    if (["deposits", "revenue", "consumption", "fees"].includes(r.category))
      total[r.category] = new Decimal(total[r.category])
        .plus(
          ["consumption", "fees"].includes(r.category)
            ? new Decimal(r.amount).neg()
            : r.amount,
        )
        .toFixed();
  }
  total.profit = new Decimal(total.revenue)
    .minus(total.consumption)
    .minus(total.fees)
    .toFixed();
  total.margin = new Decimal(total.revenue).gt(0)
    ? new Decimal(total.profit).div(total.revenue).mul(100).toFixed()
    : null;
  return total;
}
function range(filter = {}, now = Date.now()) {
  const today = dayOf(now),
    shift = (n) =>
      dayOf(new Date(`${today}T12:00:00-03:00`).getTime() + n * 86400000);
  let from,
    to = today;
  switch (filter.preset || "all") {
    case "today":
      from = today;
      break;
    case "yesterday":
      from = to = shift(-1);
      break;
    case "7d":
      from = shift(-6);
      break;
    case "month":
      from = today.slice(0, 8) + "01";
      break;
    case "all":
      from = "0000-01-01";
      break;
    case "custom":
      from = filter.from;
      to = filter.to;
      break;
    default:
      throw Error("Filtro inválido.");
  }
  const valid = (d) =>
    typeof d === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    (d === "0000-01-01" ||
      new Date(d + "T12:00:00Z").toISOString().slice(0, 10) === d);
  if (!valid(from) || !valid(to) || from > to) throw Error("Período inválido.");
  return { from, to };
}
// RentalHash labels the start of a worked hour; Hashsell bills at its end,
// including partial order closings. Apportion both to the hourly closing while
// preserving the source timestamps and immutable ledger values.
function accountingEntries(account) {
  return [...account.entries, ...(account.payments?.rows || [])].map((row) => {
    const credit =
      row.site === "rental" &&
      row.category === "revenue" &&
      row.label === "Crédito horário";
    const cost =
      row.site === "hashsell" &&
      ((row.category === "consumption" &&
        row.label === "Consumo de hashpower") ||
        (row.category === "fees" && row.label === "Taxa de consumo"));
    if (!credit && !cost) return row;
    const start = Date.parse(row.at);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
        row.at || "",
      ) ||
      !Number.isFinite(start) ||
      new Date(start).toISOString() !==
        row.at.replace(/Z$/, row.at.includes(".") ? "Z" : ".000Z") ||
      (credit && start % 3600000 !== 0)
    )
      return { ...row, periodUnconfirmed: true };
    const reportAt = new Date(
      credit ? start + 3600000 : Math.ceil(start / 3600000) * 3600000,
    ).toISOString();
    return {
      ...row,
      sourceDay: row.sourceDay || row.day,
      reportAt,
      day: dayOf(reportAt),
    };
  });
}
class ReportStore {
  constructor(dir) {
    this.file = path.join(dir, "reports.json");
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { version: 1, accounts: {} };
    if (this.data.version !== 1 || !this.data.accounts)
      throw Error("Arquivo de relatórios incompatível.");
  }
  save(data) {
    const temp = this.file + ".tmp",
      fd = fs.openSync(temp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, this.file);
    this.data = data;
  }
  commit(key, snapshots, { full, from, payments, capital, at = Date.now() }) {
    if (
      !/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(key) ||
      snapshots.length !== 2 ||
      new Set(snapshots.map((s) => s.site)).size !== 2 ||
      snapshots.some((s) => !s.complete)
    )
      throw Error("Importação incompleta.");
    const data = structuredClone(this.data),
      prior = data.accounts[key];
    if (!full && !prior?.fullAt)
      throw Error("Importação inicial completa obrigatória.");
    let entries = snapshots.flatMap((s) => s.rows);
    if (!full)
      entries = [
        ...prior.entries.filter((r) => r.day < from),
        ...entries.filter((r) => r.day >= from),
      ];
    // Preserve occurrences, including identical legitimate ledger entries.
    data.accounts[key] = {
      entries,
      payments: payments || prior?.payments,
      capital: capital || null,
      updatedAt: at,
      fullAt: full ? at : prior.fullAt,
      coverage: snapshots.map((s) => ({
        site: s.site,
        from: full
          ? s.rows.map((r) => r.day).sort()[0]
          : prior.coverage.find((c) => c.site === s.site).from,
        to: dayOf(at),
        complete: true,
      })),
      verified: (prior?.verified || []).filter(
        (day) =>
          JSON.stringify(prior.entries.filter((r) => r.day === day)) ===
          JSON.stringify(entries.filter((r) => r.day === day)),
      ),
    };
    this.save(data);
  }
  query(key, filter = {}, now = Date.now()) {
    const dates = range(filter, now),
      account = this.data.accounts[key];
    if (!account)
      return {
        ready: false,
        range: dates,
        days: [],
        entries: [],
        warnings: ["Aguardando importação completa das duas contas."],
      };
    const allEntries = accountingEntries(account);
    const shiftedDays = new Set(
      allEntries
        .filter((r) => r.sourceDay && r.sourceDay !== r.day)
        .flatMap((r) => [r.sourceDay, r.day]),
    );
    const entries = allEntries
      .filter((r) => r.day >= dates.from && r.day <= dates.to)
      .sort((a, b) => (a.reportAt || a.at).localeCompare(b.reportAt || b.at));
    const allDays = [...new Set(entries.map((r) => r.day))].sort();
    const oldest = account.coverage.map((c) => c.from).sort()[0];
    const start = dates.from > oldest ? dates.from : oldest;
    const end = dates.to < dayOf(now) ? dates.to : dayOf(now);
    const daySet = new Set(allDays);
    for (
      let day = start, count = 0;
      day <= end && count < 36600;
      count++, day = dayOf(Date.parse(day + "T12:00:00-03:00") + 86400000)
    )
      daySet.add(day);
    allDays.splice(0, allDays.length, ...[...daySet].sort());
    const lastCredit = allEntries
      .filter((r) => r.site === "rental" && r.category === "revenue")
      .map((r) => r.day)
      .sort()
      .at(-1);
    let cumulative = new Decimal(0);
    const coverageFrom = account.coverage
      .map((c) => c.from)
      .sort()
      .at(-1);
    const days = allDays.map((day) => {
      const rows = entries.filter((r) => r.day === day),
        totals = sumRows(rows);
      cumulative = cumulative.plus(totals.profit);
      return {
        day,
        ...totals,
        cumulative: cumulative.toFixed(),
        partial:
          day >= dayOf(now) ||
          day < coverageFrom ||
          day > lastCredit ||
          totals.unknown > 0 ||
          rows.some((r) => r.periodUnconfirmed),
        verified:
          account.verified.includes(day) &&
          !shiftedDays.has(day) &&
          !rows.some((r) => r.periodUnconfirmed) &&
          !(account.payments?.rows || []).some((r) => r.day === day),
      };
    });
    const warnings = [];
    if (entries.some((r) => r.periodUnconfirmed))
      warnings.push(
        "Há créditos com horário não confirmado; apuração diária parcial.",
      );
    if (!account.payments)
      warnings.push("Taxas de saque ainda não importadas.");
    else
      warnings.push(
        "Taxas de saque por data exibida na RentalHash; fuso dos pagamentos ainda não confirmado.",
      );
    if (
      (filter.preset === "custom" && dates.from < coverageFrom) ||
      dates.to > dayOf(now)
    )
      warnings.push("O período solicitado ultrapassa a cobertura disponível.");
    if (now - account.updatedAt > 30 * 60000)
      warnings.push(
        "Dados desatualizados: última importação há mais de 30 minutos.",
      );
    if (entries.some((r) => r.category === "unknown"))
      warnings.push(
        "Há lançamentos pendentes de classificação; resultado incompleto.",
      );
    if (days.some((d) => d.partial))
      warnings.push(
        "Dias parciais: horário atual ainda não fechado, cobertura desigual ou classificação pendente.",
      );
    if (!account.verified.length)
      warnings.push(
        "Histórico importado; conferência manual de um dia completo ainda pendente.",
      );
    return {
      ready: true,
      paymentsReady: !!account.payments,
      range: dates,
      updatedAt: account.updatedAt,
      fullAt: account.fullAt,
      coverage: account.coverage,
      totals: sumRows(entries),
      days,
      entries,
      warnings,
      zone: ZONE,
      accountingBasis: "hour-close-v1",
    };
  }
}
function csv(report) {
  const escape = (v) => {
    let s = String(v ?? "");
    if (/^[=+@\t\r]/.test(s) || /^-[^\d]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const header = [
    "Plataforma",
    "Data UTC",
    "Data do lançamento",
    "Lançamento",
    "Carteira",
    "Ordem",
    "USD original",
    "Classificação",
    "Data de apuração",
    "Fechamento UTC",
  ];
  return (
    "\uFEFF" +
    [
      header,
      ...report.entries.map((r) => [
        r.site,
        r.at,
        r.sourceDay || r.day,
        r.label,
        r.wallet,
        r.order,
        r.amount,
        r.category,
        r.day,
        r.reportAt || r.at,
      ]),
    ]
      .map((row) => row.map(escape).join(";"))
      .join("\r\n")
  );
}
module.exports = {
  ReportStore,
  dayOf,
  usd,
  accountKey,
  normalize,
  validatePage,
  sumRows,
  accountingEntries,
  range,
  csv,
  Decimal,
};
