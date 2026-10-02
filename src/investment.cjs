const {
  Decimal: D,
  accountingEntries,
  sumRows,
  dayOf,
} = require("./reports.cjs");
// Pix is identified only on credited Hashsell deposits. Transfers and USDT are excluded.
function investment(account, report, projection, now = Date.now()) {
  if (!account) return null;
  const rows = accountingEntries(account);
  const deposits = rows.filter(
    (r) =>
      r.site === "hashsell" &&
      r.category === "deposits" &&
      /^Pix\s+Recarga\s+Creditado\b/i.test(r.label) &&
      new D(r.amount).gt(0),
  );
  const target = deposits.reduce((n, r) => n.plus(r.amount), new D(0));
  const originals = deposits.map(
    (r) => r.label.match(/\bPix\s+(\d+(?:\.\d+)?)\s+BRL\b/i)?.[1],
  );
  const originalBrl = originals.every(Boolean)
    ? originals.reduce((n, v) => n.plus(v), new D(0)).toFixed()
    : null;
  const profit = new D(sumRows(rows).profit);
  const complete =
    ["hashsell", "rental"].every((site) =>
      account.coverage?.some((c) => c.site === site && c.complete),
    ) &&
    !!account.payments &&
    !rows.some((r) => r.category === "unknown" || r.periodUnconfirmed);
  const lastRead = Math.min(now, account.updatedAt, account.payments?.at ?? 0);
  const closedBefore = Number.isFinite(lastRead)
    ? dayOf(lastRead)
    : "0000-01-01";
  const lastDeposit = deposits
    .map((r) => r.day)
    .sort()
    .at(-1);
  let running = new D(0),
    reached = null;
  for (const day of [...new Set(rows.map((r) => r.day))].sort()) {
    running = running.plus(sumRows(rows.filter((r) => r.day === day)).profit);
    if (
      complete &&
      target.gt(0) &&
      day >= lastDeposit &&
      day < closedBefore &&
      running.gte(target) &&
      !reached
    )
      reached = day;
    if (running.lt(target)) reached = null;
  }
  // Forecast baseline may start after the first imported date. Align to lifetime profit.
  const beforeForecast = projection?.available
    ? new D(sumRows(rows.filter((r) => r.day <= projection.to)).profit).minus(
        projection.baseline,
      )
    : new D(0);
  const projected =
    complete && !reached && projection?.available && target.gt(0)
      ? projection.days.find(
          (d) =>
            !d.baseline &&
            d.day >= dayOf(now) &&
            new D(d.cumulative).plus(beforeForecast).gte(target),
        )?.day || null
      : null;
  const beforeFilter = new D(
    sumRows(rows.filter((r) => r.day < report.range.from)).profit,
  );
  return {
    target: target.toFixed(),
    originalBrl,
    profit: profit.toFixed(),
    remaining: D.max(0, target.minus(profit)).toFixed(),
    count: deposits.length,
    deposits,
    complete,
    reached,
    projected,
    historyTarget: target.minus(beforeFilter).toFixed(),
    forecastTarget: target.minus(beforeForecast).toFixed(),
  };
}
module.exports = { investment };
