const test = require("node:test"),
  assert = require("node:assert/strict");
const { Exchange, parseQuote, withBrl } = require("../src/exchange.cjs");
const now = Date.parse("2026-09-29T22:00:00Z");
const payload = {
  USDBRL: {
    code: "USD",
    codein: "BRL",
    bid: "5.2031",
    timestamp: String(now / 1000),
  },
};
test("USD/BRL quote validates pair, exact rate and timestamp", () => {
  const q = parseQuote(payload, now);
  assert.equal(q.rate, "5.2031");
  assert.equal(q.at, now);
  for (const change of [
    { bid: "0" },
    { bid: "NaN" },
    { codein: "USD" },
    { timestamp: String(now / 1000 + 1000) },
  ])
    assert.throws(() =>
      parseQuote({ USDBRL: { ...payload.USDBRL, ...change } }, now),
    );
});
test("conversion uses decimal precision, preserves original USD and percentages", () => {
  const original = {
    totals: { profit: "471.54668263", margin: "6.91" },
    days: [{ profit: "-0.00000001", cumulative: "471.54668263" }],
    entries: [{ amount: "1234.12345678" }],
  };
  const before = JSON.stringify(original);
  const result = withBrl(original, { available: true, rate: "5.2031" });
  assert.equal(result.days[0].brl.profit, "-0.000000052031");
  assert.equal(result.totals.brl.profit, "2453.504544392153");
  assert.equal(result.totals.margin, "6.91");
  assert.equal(JSON.stringify(original), before);
  assert.equal(result.totals.profit, original.totals.profit);
});
test("unknown exchange rate never creates zero BRL estimates", () => {
  assert.equal(
    withBrl(
      { totals: { profit: "10" }, entries: [], days: [] },
      { available: false },
    ).totals.brl.profit,
    null,
  );
});
test("deduplicates concurrent requests and polls at most once per minute", async () => {
  let calls = 0,
    clock = now;
  const fx = new Exchange({
    now: () => clock,
    fetchQuote: async () => {
      calls++;
      return payload;
    },
  });
  assert.equal(fx.state().available, false);
  fx.state();
  await fx.pending;
  assert.equal(calls, 1);
  assert.equal(fx.state().rate, "5.2031");
  clock += 59999;
  fx.state();
  assert.equal(calls, 1);
  clock++;
  fx.state();
  await fx.pending;
  assert.equal(calls, 2);
});
test("provider failure retains last known value with a visible stale flag", async () => {
  let clock = now,
    fail = false;
  const fx = new Exchange({
    now: () => clock,
    fetchQuote: async () => {
      if (fail) throw Error("offline");
      return payload;
    },
  });
  fx.state();
  await fx.pending;
  fail = true;
  clock += 60000;
  fx.state();
  await fx.pending;
  const q = fx.state();
  assert.equal(q.rate, "5.2031");
  assert.equal(q.stale, true);
  assert.ok(q.error);
});
test("old market timestamp is never presented as a live fresh quote", async () => {
  const fx = new Exchange({
    now: () => now + 3600000,
    fetchQuote: async () => payload,
  });
  fx.state();
  await fx.pending;
  assert.equal(fx.state().stale, true);
  assert.equal(fx.state().at, now);
});
test("network disabled in smoke mode", () => {
  const fx = new Exchange({
    enabled: false,
    fetchQuote: () => {
      throw Error("network should not be called");
    },
  });
  assert.equal(fx.state().loading, false);
});
