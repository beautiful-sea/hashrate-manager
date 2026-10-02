const D = require("decimal.js").clone({ precision: 50 });
const { usd } = require("./reports.cjs");
// Parse RFC 4180 without retaining destination addresses.
function paymentTiming(csv) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(field);
      field = "";
    } else if (c === "\n" && !quoted) {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw Error("CSV de pagamentos incompleto.");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const header = rows.shift()?.map((s) => s.replace(/^\uFEFF/, ""));
  const expected = [
    "Data",
    "Finalizado em",
    "Situação",
    "Líquido (USD)",
    "Comprovante",
  ];
  if (!expected.every((k) => header?.includes(k)))
    throw Error("Exportação de pagamentos sem datas confirmadas.");
  const result = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.length === 1 && !r[0]) continue;
    if (r.length !== header.length) throw Error("CSV inválido.");
    const get = (k) => r[header.indexOf(k)];
    if (get("Situação") !== "Concluído") continue;
    const requestedAt = get("Data"),
      completedAt = get("Finalizado em"),
      id = get("Comprovante"),
      net = get("Líquido (USD)");
    if (
      ![requestedAt, completedAt].every(
        (t) =>
          /T.*(?:Z|[+-]\d\d:\d\d)$/.test(t) && Number.isFinite(Date.parse(t)),
      ) ||
      Date.parse(completedAt) < Date.parse(requestedAt) ||
      !/^0x[0-9a-f]{64}$/i.test(id) ||
      !/^\d+(\.\d+)?$/.test(net) ||
      seen.has(id)
    )
      throw Error("Datas ou identificadores de pagamentos inválidos.");
    seen.add(id);
    result.push({ id, requestedAt, completedAt, net });
  }
  return result;
}
function reinvestmentTiming(account) {
  const samples = [];
  const payments = account.payments?.timing || [];
  const deposits = account.entries.filter(
    (r) => r.site === "hashsell" && r.category === "deposits",
  );
  for (const p of payments) {
    const candidates = deposits.filter((r) => {
      const prefix = r.label?.match(/0x[0-9a-f]{8,64}/i)?.[0];
      return (
        prefix &&
        p.id.toLowerCase().startsWith(prefix.toLowerCase()) &&
        payments.filter((x) =>
          x.id.toLowerCase().startsWith(prefix.toLowerCase()),
        ).length === 1 &&
        new D(r.amount).eq(p.net)
      );
    });
    if (candidates.length !== 1) continue;
    const credited = Date.parse(candidates[0].at),
      start = Date.parse(p.requestedAt),
      done = Date.parse(p.completedAt);
    if (!Number.isFinite(credited) || credited < done || done < start) continue;
    const nextCredit =
      deposits
        .map((r) => Date.parse(r.at))
        .filter((t) => t > credited)
        .sort((a, b) => a - b)[0] ?? Infinity;
    const reserve = account.entries
      .filter(
        (r) =>
          r.site === "hashsell" &&
          /Reserva para ordem/i.test(r.label || "") &&
          new D(r.amount).lt(0) &&
          Date.parse(r.at) >= credited &&
          Date.parse(r.at) < nextCredit,
      )
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    if (!reserve) continue;
    const allocated = Date.parse(reserve.at);
    samples.push({
      id: p.id,
      withdrawalHours: (done - start) / 3600000,
      creditHours: (credited - done) / 3600000,
      hours: (credited - start) / 3600000,
      allocationHours: (allocated - credited) / 3600000,
    });
  }
  if (samples.length < 3) return null;
  const mean = (k) => samples.reduce((a, s) => a + s[k], 0) / samples.length;
  return {
    samples: samples.length,
    transitHours: mean("hours"),
    allocationHours: mean("allocationHours"),
    unavailableHours: mean("hours") + mean("allocationHours"),
    withdrawalHours: mean("withdrawalHours"),
    creditHours: mean("creditHours"),
  };
}
// Keep known pending funds in transit until a matching Hashsell credit appears.
function withdrawalCapital(payments, prior, entries) {
  const fingerprint = (p) =>
    JSON.stringify([
      p.day,
      p.displayedAt,
      new D(usd(p.gross)).toFixed(),
      new D(usd(p.fee)).toFixed(),
    ]);
  const remaining = new Map();
  for (const p of prior?.pending || []) {
    const key = fingerprint(p);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  for (const p of payments.pending || []) {
    const key = fingerprint(p);
    remaining.set(key, Math.max(0, (remaining.get(key) || 0) - 1));
  }
  const settling = new Map((prior?.settling || []).map((p) => [p.id, p]));
  const seen = new Set((prior?.rows || []).map((r) => r.id));
  for (const p of payments.completed || []) {
    if (seen.has(p.id) || settling.has(p.id) || !p.gross) continue;
    const key = fingerprint(p);
    if (!(remaining.get(key) > 0)) continue;
    if (!/^0x[0-9a-f]{64}$/i.test(p.id || ""))
      throw Error("Transferência concluída sem identificador confirmado.");
    const net = new D(usd(p.gross)).minus(usd(p.fee));
    if (net.lt(0)) throw Error("Transferência concluída com valor inválido.");
    settling.set(p.id, { ...p, net: net.toFixed() });
    remaining.set(key, remaining.get(key) - 1);
  }
  const ids = [
    ...new Set([
      ...(payments.completed || []).map((p) => p.id),
      ...settling.keys(),
    ]),
  ].filter(Boolean);
  const waiting = [...settling.values()].filter(
    (p) =>
      !entries.some((r) => {
        if (r.site !== "hashsell" || r.category !== "deposits") return false;
        const prefix = r.label?.match(/0x[0-9a-f]{8,64}/i)?.[0];
        return (
          prefix &&
          p.id.toLowerCase().startsWith(prefix.toLowerCase()) &&
          ids.filter((id) => id.toLowerCase().startsWith(prefix.toLowerCase()))
            .length === 1 &&
          new D(r.amount).eq(p.net)
        );
      }),
  );
  return {
    settling: waiting,
    inTransit: [...(payments.pending || []), ...waiting]
      .reduce((sum, p) => sum.plus(p.net), new D(0))
      .toFixed(),
  };
}
const withdrawalDate = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function explicitTime(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return null;
  const date = value.slice(0, 10),
    calendar = new Date(date + "T00:00:00Z");
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== date
  )
    return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
function withdrawalLocalTime(displayed) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2})$/.exec(
    displayed || "",
  );
  if (!m || +m[4] > 23 || +m[5] > 59) return null;
  const desired = Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00Z`);
  if (!Number.isFinite(desired)) return null;
  let at = desired;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(
      withdrawalDate.formatToParts(at).map((x) => [x.type, x.value]),
    );
    const local = Date.parse(
      `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`,
    );
    at += desired - local;
  }
  if (withdrawalDate.format(at) !== displayed) return null;
  // A clock repeated by a historical DST transition has no unique instant.
  if (
    [at - 3600000, at + 3600000].some(
      (t) => withdrawalDate.format(t) === displayed,
    )
  )
    return null;
  return at;
}
function withdrawalOverview(account, now = Date.now()) {
  const payments = account?.payments;
  const source = payments?.items || [
    ...(payments?.completed || []),
    ...(payments?.pending || []),
  ];
  const timing = new Map(),
    conflicts = new Set();
  let ignored = 0;
  for (const row of payments?.timing || []) {
    const start = explicitTime(row.requestedAt),
      end = explicitTime(row.completedAt);
    const current = source.find((x) => x.id === row.id);
    if (
      !/^0x[0-9a-f]{64}$/i.test(row.id || "") ||
      start == null ||
      end == null ||
      end < start ||
      end > now ||
      (current && current.status !== "Concluído")
    ) {
      ignored++;
      continue;
    }
    const id = row.id.toLowerCase();
    if (conflicts.has(id)) continue;
    if (timing.has(id)) {
      const prior = timing.get(id);
      if (prior.start !== start || prior.end !== end || prior.net !== row.net) {
        timing.delete(id);
        conflicts.add(id);
        ignored++;
      }
      continue;
    }
    timing.set(id, { ...row, start, end, durationMs: end - start });
  }
  const samples = [...timing.values()];
  const averageMs = samples.length
    ? samples.reduce((sum, x) => sum + x.durationMs, 0) / samples.length
    : null;
  const matched = source
    .map((row) => ({ row, sample: timing.get(row.id?.toLowerCase()) }))
    .filter((x) => x.sample);
  const timezoneConfirmed =
    matched.length > 0 &&
    matched.every(
      ({ row, sample }) =>
        row.displayedAt === withdrawalDate.format(sample.start),
    );
  const all = [...source];
  for (const sample of samples) {
    if (
      !source.some((row) => row.id?.toLowerCase() === sample.id.toLowerCase())
    )
      all.push({
        id: sample.id,
        status: "Concluído",
        displayedAt: withdrawalDate.format(sample.start),
        net: sample.net,
      });
  }
  const occurrences = new Map(),
    listed = new Set();
  const rows = [];
  for (const raw of all) {
    const id = raw.id?.toLowerCase(),
      sample = timing.get(id);
    if (id && listed.has(id)) continue;
    if (id) listed.add(id);
    const requested =
      sample?.start ??
      (timezoneConfirmed ? withdrawalLocalTime(raw.displayedAt) : null);
    const requestedAt =
      requested != null && requested <= now
        ? new Date(requested).toISOString()
        : null;
    const pending = ["Pendente", "Processando"].includes(raw.status);
    const elapsedMs = pending && requestedAt ? now - requested : null;
    const estimated =
      pending && requestedAt && averageMs != null
        ? requested + averageMs
        : null;
    let net = null,
      fee = null;
    try {
      fee = raw.fee ? usd(raw.fee) : null;
      net =
        raw.net ||
        sample?.net ||
        (raw.gross && fee != null
          ? new D(usd(raw.gross)).minus(fee).toFixed()
          : null);
      if (net != null && (!/^\d+(?:\.\d+)?$/.test(net) || new D(net).lt(0)))
        net = null;
    } catch {
      net = null;
      fee = null;
    }
    const mark = JSON.stringify([raw.displayedAt, raw.gross, net, raw.status]);
    const occurrence = occurrences.get(mark) || 0;
    occurrences.set(mark, occurrence + 1);
    rows.push({
      key: id || `${mark}:${occurrence}`,
      status: raw.status,
      pending,
      displayedAt: raw.displayedAt || null,
      requestedAt,
      completedAt: sample ? new Date(sample.end).toISOString() : null,
      net,
      fee,
      durationMs: sample?.durationMs ?? null,
      elapsedMs,
      estimatedAt: estimated != null ? new Date(estimated).toISOString() : null,
      remainingMs: estimated != null ? Math.max(0, estimated - now) : null,
      overdueMs: estimated != null ? Math.max(0, now - estimated) : null,
    });
  }
  rows.sort(
    (a, b) =>
      (Date.parse(b.requestedAt) || 0) - (Date.parse(a.requestedAt) || 0) ||
      String(b.displayedAt).localeCompare(String(a.displayedAt)),
  );
  return {
    ready: !!payments,
    updatedAt: payments?.at || null,
    timingUpdatedAt: payments?.timingAt || payments?.at || null,
    stale:
      !!payments && (now - payments.at > 30 * 60000 || !!payments.timingError),
    timingError: payments?.timingError || null,
    timezoneConfirmed,
    ignored,
    sampleCount: samples.length,
    averageMs,
    fastestMs: samples.length
      ? Math.min(...samples.map((x) => x.durationMs))
      : null,
    slowestMs: samples.length
      ? Math.max(...samples.map((x) => x.durationMs))
      : null,
    pendingCount: rows.filter((x) => x.pending).length,
    completedCount: rows.filter((x) => x.status === "Concluído").length,
    rows,
    now,
  };
}
module.exports = {
  paymentTiming,
  reinvestmentTiming,
  withdrawalCapital,
  withdrawalOverview,
};
