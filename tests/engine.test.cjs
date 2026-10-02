const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULTS, validateConfig } = require("../src/config.cjs");
const {
  parseNumber,
  pricePerPH,
  ceiling,
  decide,
} = require("../src/engine.cjs");
// Legacy/custom increments remain supported by the engine.
const cfg = () => ({
  ...structuredClone(DEFAULTS),
  tick: "0.0001",
  buffer: "0.001",
});
function input(bid = "39.2", rate = "43", cut = "39.11") {
  return {
    rental: { rate, at: 100000 },
    market: { cut, at: 100000 },
    orders: {
      at: 100000,
      items: [{ id: "HS-1", bid, balance: "500", active: true }],
    },
    config: cfg(),
    now: 100000,
  };
}
test("normalizes localized units without 1000x mistakes", () => {
  assert.equal(pricePerPH("US$ 39.110,00 /EH/s/dia", "EH", "pt-BR"), "39.11");
  assert.equal(pricePerPH("US$ 0,043", "TH", "pt-BR"), "43");
  assert.equal(pricePerPH("US$ 39.1829 /PH/s/day", "PH", "en-US"), "39.1829");
  assert.throws(() => pricePerPH("39 /EH/s/dia", "PH", "pt-BR"));
  assert.throws(() => parseNumber("39.1829", "pt-BR"));
  assert.throws(() => parseNumber("NaN"));
});
test("ceiling rounds down and accounts for revenue recognition", () => {
  assert.equal(ceiling("43", cfg()), "39.6601");
  assert.equal(ceiling("42", cfg()), "38.7378");
  assert.equal(ceiling("43", { ...cfg(), recognition: ".95" }), "37.6771");
});
test("rate drop forces reduction even in cooldown", () => {
  const i = input("39.2", "42");
  i.memory = { "HS-1": { changedAt: 99999 } };
  const d = decide(i).decisions[0];
  assert.equal(d.action, "decrease");
  assert.equal(d.target, "38.7378");
});
test("cut above ceiling cannot trigger an increase", () => {
  assert.equal(decide(input("39.2", "43", "41")).decisions[0].action, "alert");
});
test("below cut increases to tick-rounded cut plus buffer", () => {
  assert.equal(decide(input("39")).decisions[0].target, "39.111");
});
test("a served order at the cutoff does not ratchet its own price", () => {
  const i = input("39.11");
  i.orders.items[0].delivering = true;
  assert.equal(decide(i).decisions[0].action, "hold");
});
test("lowering waits for stable observations", () => {
  const i = input();
  const d = decide(i).decisions[0];
  assert.equal(d.action, "hold");
  i.memory = { "HS-1": { candidate: d.candidate, stable: 2 } };
  assert.equal(decide(i).decisions[0].action, "decrease");
});
test("stale, future and missing readings block all orders", () => {
  for (const at of [0, 100001, undefined]) {
    const i = input();
    i.rental.at = at;
    assert.ok(decide(i).blocked);
  }
});
test("pending, inactive and empty balance orders are not written", () => {
  const i = input("39");
  i.pending = { "HS-1": {} };
  assert.equal(decide(i).decisions[0].action, "hold");
  i.pending = {};
  i.orders.items[0].active = false;
  assert.equal(decide(i).decisions[0].action, "hold");
  i.orders.items[0].active = true;
  i.orders.items[0].balance = "0";
  assert.equal(decide(i).decisions[0].action, "hold");
});
test("all detected orders participate without an ID list, including legacy profiles", () => {
  for (const legacy of [undefined, [], ["HS-1"]]) {
    const i = input("39");
    if (legacy) i.config.managedOrders = legacy;
    i.orders.items.push({ ...i.orders.items[0], id: "HS-NEW" });
    assert.deepEqual(
      decide(i).decisions.map((d) => [d.id, d.action]),
      [
        ["HS-1", "increase"],
        ["HS-NEW", "increase"],
      ],
    );
    assert.equal("managedOrders" in validateConfig(i.config), false);
  }
});
test("configuration rejects nonpositive margins, invalid intervals and unsafe paths", () => {
  assert.equal(validateConfig(cfg()).margin, "0.05");
  for (const patch of [
    { margin: "0" },
    { margin: "-0.01" },
    { margin: "Infinity" },
    { pollSeconds: 1 },
    { tick: "0" },
    { rental: { ...cfg().rental, path: "//evil.test" } },
  ])
    assert.throws(() => validateConfig({ ...cfg(), ...patch }));
});

test("margin message explains waiting and recovers automatically without bypass", () => {
  const blocked = decide(input("39.2", "43", "41")).decisions[0];
  assert.equal(blocked.title, "Aguardando preço melhor");
  assert.match(blocked.reason, /não precisa reativar/);
  assert.equal(blocked.target, "39.2");
  assert.equal(
    decide(input("39", "43", "39.11")).decisions[0].action,
    "increase",
  );
  assert.equal(
    decide(input("39.2", "46", "41")).decisions[0].action,
    "increase",
  );
});

test("positive margins below five percent and above old maximum are accepted", () => {
  for (const margin of ["0.03", "0.001", "0.00000001", "0.96", "1", "1.5"]) {
    assert.equal(validateConfig({ ...cfg(), margin }).margin, margin);
  }
  const i = input("39", "43", "40");
  i.config.margin = "0.03";
  assert.equal(ceiling("43", i.config), "40.4951");
  assert.equal(decide(i).decisions[0].action, "increase");
  assert.equal(ceiling("43", { ...cfg(), margin: "1.5" }), "0");
});

test("new defaults provide headroom with tick rounding and never exceed the margin ceiling", () => {
  assert.equal(DEFAULTS.tick, "0.01");
  assert.equal(DEFAULTS.buffer, "0.05");
  const i = input("39.4", "43", "39.4121");
  i.config = structuredClone(DEFAULTS);
  const d = decide(i).decisions[0];
  assert.equal(d.action, "increase");
  assert.equal(d.target, "39.47");
  assert.equal(d.ceiling, "39.66");
  i.market.cut = "39.65";
  assert.equal(decide(i).decisions[0].action, "alert");
  i.orders.items[0].bid = "39.77";
  assert.equal(decide(i).decisions[0].action, "decrease");
  assert.equal(decide(i).decisions[0].target, "39.66");
});

test("market margin discounts configured fees and recognition and hides stale readings", () => {
  const { marketMargin } = require("../src/engine.cjs");
  const x = input();
  x.rental.rate = "42";
  x.market.cut = "39.55";
  assert.equal(Number(marketMargin(x)).toFixed(2), "3.01");
  assert.equal(marketMargin({ ...x, now: x.now + 76000 }), null);
  assert.equal(marketMargin({ ...x, rental: undefined }), null);
  assert.equal(
    marketMargin({ ...x, market: { cut: "inválido", at: x.now } }),
    null,
  );
  assert.equal(marketMargin({ ...x, rental: { rate: "0", at: x.now } }), null);
  assert(
    Number(
      marketMargin({
        ...x,
        config: { ...x.config, recognition: "0.95", otherCost: "0.5" },
      }),
    ) < 0,
  );
});
