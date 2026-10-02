const test = require("node:test"),
  assert = require("node:assert/strict"),
  D = require("decimal.js").clone({ precision: 50 });
const { forecast } = require("../src/forecast.cjs");
const { withBrl } = require("../src/exchange.cjs");
const now = Date.parse("2026-09-29T18:00:00Z");
function account() {
  const a = {
    updatedAt: now,
    capital: { hashsell: "70", rental: "30", at: now },
    payments: {
      at: now,
      rows: [
        {
          day: "2026-09-28",
          category: "fees",
          feeKind: "withdrawal",
          amount: "-2",
        },
      ],
    },
    coverage: [
      { from: "2026-09-26", complete: true },
      { from: "2026-09-26", complete: true },
    ],
    entries: [
      { day: "2026-09-26", category: "revenue", amount: "110" },
      { day: "2026-09-26", category: "consumption", amount: "-97" },
      { day: "2026-09-26", category: "fees", amount: "-3" },
      { day: "2026-09-29", category: "revenue", amount: "99999" },
    ],
  };
  a.payments.timing = [0, 1, 2].map((i) => ({
    id: "0x" + String(i + 1).repeat(64),
    requestedAt: "2026-09-20T00:00:00Z",
    completedAt: "2026-09-21T06:00:00Z",
    net: "10",
  }));
  a.entries.push(
    ...a.payments.timing.map((p) => ({
      site: "hashsell",
      category: "deposits",
      amount: "10",
      label: p.id.slice(0, 10) + "...",
      at: p.completedAt,
      day: "2026-09-21",
    })),
  );
  a.entries.push(
    ...a.entries
      .filter((r) => r.category === "deposits")
      .map((r) => ({
        ...r,
        category: "transfer",
        label: "Reserva para ordem",
        amount: "-12",
      })),
  );
  return a;
}
test("transit prevents daily compounding and preserves accrued profit", () => {
  const f = forecast(account(), now);
  assert.equal(f.baseline, "8");
  assert.equal(f.initialCapital, "100");
  assert.equal(f.cycleRate, "0.1");
  assert.equal(f.count, 3);
  assert.equal(f.days.length, 31);
  assert.equal(f.days[0].cumulative, "8");
  assert.equal(f.days[1].capital, "100");
  assert.equal(f.days[2].capital, "100");
  assert.equal(f.days[3].capital, "108");
  assert.equal(f.withdrawalFees, "26");
  assert.equal(f.cycleHours, 54);
  assert.equal(f.days[30].day, "2026-10-28");
  assert.equal(new D(f.total).minus(f.gain).toFixed(), "8");
});
test("observed 54-hour cycle matches completed-cycle formula", () => {
  const f = forecast(account(), now, { withdrawalHours: 24 });
  const expected = new D(80).mul(new D("1.1").pow(13)).plus(20);
  assert.ok(new D(f.days[30].capital).minus(expected).abs().lt("1e-40"));
  assert.equal(f.withdrawalFees, "26");
});
test("losses are not turned into positive compound profits", () => {
  const a = account();
  a.entries[0].amount = "90";
  const f = forecast(a, now);
  assert.equal(f.cycleRate, "-0.1");
  assert.ok(new D(f.gain).lt(0));
  assert.ok(new D(f.days[30].capital).gte(0));
});
test("missing capital or unknown history never invents a reinvestment base", () => {
  const a = account();
  delete a.capital;
  assert.equal(forecast(a, now).available, false);
  const b = account();
  b.entries.push({ day: "2026-09-27", category: "unknown", amount: "1" });
  assert.equal(forecast(b, now).available, false);
  delete b.payments.timing;
  assert.equal(forecast(b, now).available, false);
});
test("compound BRL conversion preserves original USD", () => {
  const f = forecast(account(), now);
  const r = withBrl({ forecast: f }, { available: true, rate: "5.20" });
  assert.equal(r.forecast.brlInitialCapital, "520");
  assert.equal(r.forecast.days[3].brl.profit, "41.6");
  assert.equal(f.initialCapital, "100");
});

test("longer observed transit reduces gains and waiting never compounds capital", () => {
  const a = account(),
    b = account();
  b.payments.timing.forEach((p) => (p.requestedAt = "2026-09-19T00:00:00Z"));
  const fast = forecast(a, now),
    slow = forecast(b, now);
  assert.ok(new D(slow.gain).lt(fast.gain));
  assert.equal(slow.days[3].capital, "100");
});

test("capital in a pending withdrawal stays in the forecast without becoming new revenue", () => {
  const a = account();
  a.capital = { hashsell: "0.05", rental: "0.01", inTransit: "100", at: now };
  const f = forecast(a, now);
  assert.equal(f.initialCapital, "100.06");
  assert.equal(f.baseline, "8");
  assert.equal(f.days[2].capital, "100.06");
  assert.equal(f.days[3].capital, "108.066");
  assert.ok(new D(f.gain).gt(0));
});

test("a credited reinvestment replaces in-transit capital without doubling the projection base", () => {
  const pending = account(),
    credited = account();
  pending.capital = {
    hashsell: "0.05",
    rental: "0.01",
    inTransit: "100",
    at: now,
  };
  credited.capital = {
    hashsell: "100.05",
    rental: "0.01",
    inTransit: "0",
    at: now,
  };
  assert.equal(
    forecast(pending, now).initialCapital,
    forecast(credited, now).initialCapital,
  );
  assert.equal(forecast(pending, now).total, forecast(credited, now).total);
});

test("forecast excludes a prior-day labeled credit closing on the current day", () => {
  const a = account();
  a.entries.push({
    site: "rental",
    category: "revenue",
    label: "Crédito horário",
    at: "2026-09-29T02:00:00.000Z",
    day: "2026-09-28",
    amount: "1000",
  });
  const before = JSON.stringify(a);
  assert.equal(forecast(a, now).baseline, "8");
  assert.equal(forecast(a, now).cycleRate, "0.1");
  assert.equal(JSON.stringify(a), before);
});
