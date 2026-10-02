const { reinvestmentTiming } = require("./reinvestment.cjs");
const D = require("decimal.js").clone({ precision: 50 });
const { dayOf, sumRows, accountingEntries } = require("./reports.cjs");
function forecast(account, now = Date.now()) {
  const unavailable = {
    available: false,
    days: [],
    reason: "Aguardando histórico completo de pelo menos um dia encerrado.",
  };
  if (
    !account?.payments ||
    !account.coverage?.length ||
    account.coverage.some((c) => !c.complete)
  )
    return unavailable;
  const from = account.coverage
    .map((c) => c.from)
    .sort()
    .at(-1);
  const lastRead = Math.min(now, account.updatedAt, account.payments.at);
  if (!Number.isFinite(lastRead)) return unavailable;
  const readDay = dayOf(lastRead);
  const end = dayOf(Date.parse(readDay + "T12:00:00-03:00") - 86400000);
  if (from > end) return unavailable;
  const entries = accountingEntries(account).filter(
    (r) => r.day >= from && r.day <= end,
  );
  if (entries.some((r) => r.category === "unknown" || r.periodUnconfirmed))
    return {
      ...unavailable,
      reason: "Confira os lançamentos pendentes para calcular a previsão.",
    };
  const count =
    Math.round(
      (Date.parse(end + "T12:00:00-03:00") -
        Date.parse(from + "T12:00:00-03:00")) /
        86400000,
    ) + 1;
  if (!account.capital)
    return {
      ...unavailable,
      reason: "Aguardando leitura dos saldos para calcular o reinvestimento.",
    };
  const timing = reinvestmentTiming(account);
  if (!timing)
    return {
      ...unavailable,
      reason:
        "Aguardando cruzamento dos saques com as recargas para estimar o prazo.",
    };
  // One productive day is the user's assumption; observed transit adds downtime.
  const cycleHours = 24 + timing.unavailableHours;
  const totals = sumRows(entries),
    baseline = new D(totals.profit);
  const cost = new D(totals.consumption).plus(totals.consumptionFees);
  if (!cost.gt(0))
    return {
      ...unavailable,
      reason: "Sem consumo suficiente para estimar o retorno.",
    };
  const rate = new D(totals.revenue).minus(cost).div(cost);
  const initialCapital = new D(account.capital.hashsell)
    .plus(account.capital.rental)
    .plus(account.capital.inTransit || 0);
  if (!initialCapital.gt(0))
    return {
      ...unavailable,
      reason: "Sem capital disponível para reinvestir.",
    };
  let capital = initialCapital,
    withdrawalFees = new D(0),
    dailyStart = capital;
  const base = Date.parse(end + "T12:00:00-03:00");
  const days = [
    {
      day: end,
      forecast: true,
      baseline: true,
      profit: "0",
      cumulative: baseline.toFixed(),
      capital: capital.toFixed(),
    },
  ];
  for (let hour = 1; hour <= 720; hour++) {
    if (Math.floor(hour / cycleHours) > Math.floor((hour - 1) / cycleHours)) {
      capital = capital.mul(new D(1).plus(rate));
      const fee = D.min(2, capital);
      capital = capital.minus(fee);
      withdrawalFees = withdrawalFees.plus(fee);
    }
    if (hour % 24 === 0) {
      days.push({
        day: dayOf(base + hour * 3600000),
        forecast: true,
        profit: capital.minus(dailyStart).toFixed(),
        cumulative: baseline.plus(capital.minus(initialCapital)).toFixed(),
        capital: capital.toFixed(),
      });
      dailyStart = capital;
    }
  }
  const gain = capital.minus(initialCapital);
  return {
    available: true,
    from,
    to: end,
    count,
    model: "historical-transit",
    timing,
    cycleHours,
    cycleRate: rate.toFixed(),
    initialCapital: initialCapital.toFixed(),
    capitalAt: account.capital.at,
    withdrawalFees: withdrawalFees.toFixed(),
    average: baseline.div(count).toFixed(),
    baseline: baseline.toFixed(),
    gain: gain.toFixed(),
    total: baseline.plus(gain).toFixed(),
    days,
  };
}
module.exports = { forecast };
