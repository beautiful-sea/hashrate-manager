const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { financialTotals } = require("../src/financial-metrics.cjs");
const { Analytics } = require("../src/analytics.cjs");
function monitor() {
  return {
    running: true,
    demo: false,
    snapshots: {
      orders: {
        at: 1000,
        account: "private-account",
        items: [
          { id: "private-order", active: true, balance: "10.01" },
          { active: true, balance: "20.02" },
          { active: false, balance: "999" },
        ],
      },
    },
  };
}
test("financial totals exclude identities and inactive orders using exact cents", () => {
  assert.deepEqual(financialTotals(monitor(), 2000), {
    capitalCents: 3003,
    orders: 2,
  });
});
test("unknown, stale, failed and demo readings never become financial zeroes", () => {
  for (const change of [
    (m) => (m.running = false),
    (m) => (m.demo = true),
    (m) => (m.errors = { orders: "failed" }),
    (m) => (m.snapshots.orders.at = 3000),
    (m) => (m.snapshots.orders.at = -130000),
    (m) => (m.snapshots.orders.items[0].balance = "NaN"),
    (m) => (m.snapshots.orders.items[0].balance = "-1"),
    (m) => delete m.snapshots.orders.items[0].balance,
    (m) => delete m.snapshots.orders.items[0].active,
  ]) {
    const m = monitor();
    change(m);
    assert.equal(financialTotals(m, 2000), null);
  }
});
test("financial tokens are temporary, separate from usage, and opt-out persists", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "financial-test-")),
    sent = [];
  const a = new Analytics(dir, "0.2.45", {
    financial: () => financialTotals(monitor(), 2000),
    send: async () => {},
    sendFinancial: async (p) => sent.push(p),
  });
  await a.pingFinancial();
  await a.pingFinancial();
  assert.deepEqual(Object.keys(sent[0]).sort(), [
    "capitalCents",
    "orders",
    "token",
  ]);
  assert.equal(sent[0].token, sent[1].token);
  assert.notEqual(sent[0].token, a.data.id);
  const b = new Analytics(dir, "0.2.45");
  assert.notEqual(b.financialToken, a.financialToken);
  assert.ok(!fs.readFileSync(a.file, "utf8").includes(a.financialToken));
  a.choose(false);
  await new Promise((r) => setImmediate(r));
  await a.pingFinancial();
  assert.equal(sent.at(-1).remove, true);
  assert.equal(sent.filter((p) => !p.remove).length, 2);
  assert.equal(new Analytics(dir, "0.2.46").state().consent, false);
});
test("financial sends cannot overlap and opt-out removes an in-flight snapshot", async () => {
  let resolve;
  const sent = [],
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "financial-test-"));
  const a = new Analytics(dir, "0.2.45", {
    financial: () => ({ capitalCents: 100, orders: 1 }),
    sendFinancial: (p) => {
      sent.push(p);
      return p.remove ? Promise.resolve() : new Promise((r) => (resolve = r));
    },
  });
  const pending = a.pingFinancial();
  await a.pingFinancial();
  assert.equal(sent.length, 1);
  a.choose(false);
  resolve();
  await pending;
  assert.equal(sent.at(-1).remove, true);
  a.enabled = false;
  await a.pingFinancial();
  assert.equal(sent.filter((p) => !p.remove).length, 1);
});
