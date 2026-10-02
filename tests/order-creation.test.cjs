const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULTS, validateConfig } = require("../src/config.cjs");
const { Store } = require("../src/store.cjs");
const {
  CREATION_DEFAULTS,
  validateCreationPolicy,
  planCreation,
} = require("../src/order-creation.cjs");
const policy = {
  ...CREATION_DEFAULTS,
  enabled: true,
  account: "a".repeat(64),
  minimumBalance: "20",
  amount: "25.12",
  speedPH: "1.5",
  destination: "11111111-1111-4111-8111-111111111111",
};
function fixture() {
  const now = 1000000;
  return {
    policy,
    now,
    config: structuredClone(DEFAULTS),
    wallet: {
      at: now,
      account: "a".repeat(64),
      available: "30.12345678",
      total: "5000",
    },
    orders: { at: now, account: "a".repeat(64), items: [] },
    rental: { at: now, rate: "43" },
    market: { at: now, cut: "39.4121" },
  };
}
test("creation requires explicit complete positive policy and rejects unknown fields", () => {
  assert.deepEqual(validateCreationPolicy(), CREATION_DEFAULTS);
  assert.throws(() =>
    validateCreationPolicy({ ...CREATION_DEFAULTS, enabled: true }),
  );
  for (const value of ["0", "-1", "1e3", "1,5", "NaN", "0.000000001", null])
    assert.throws(() => validateCreationPolicy({ ...policy, amount: value }));
  assert.throws(() => validateCreationPolicy({ ...policy, unknown: true }));
  assert.throws(() =>
    validateCreationPolicy({ ...policy, destination: "   " }),
  );
  assert.deepEqual(validateCreationPolicy(policy), policy);
});
test("funding uses only available wallet funds with exact decimals and margin ceiling", () => {
  const f = fixture();
  const fixed = planCreation(f);
  assert.equal(fixed.action, "create");
  assert.equal(fixed.amount, "25.12");
  assert.equal(fixed.bid, "39.47");
  assert.equal(fixed.ceiling, "39.66");
  assert.equal(
    planCreation({ ...f, policy: { ...policy, funding: "all", amount: "" } })
      .amount,
    "30.12",
  );
  assert.equal(
    planCreation({ ...f, wallet: { ...f.wallet, available: "19" } }).action,
    "hold",
  );
  assert.equal(
    planCreation({ ...f, wallet: { ...f.wallet, available: "22" } }).action,
    "hold",
  );
  assert.equal(
    planCreation({ ...f, market: { ...f.market, cut: "40" } }).action,
    "hold",
  );
});
test("pending creation, identity mismatch, stale reads and active orders defer creation", () => {
  const f = fixture();
  assert.equal(
    planCreation({ ...f, pending: { intentId: "pending" } }).action,
    "hold",
  );
  assert.equal(
    planCreation({ ...f, wallet: { ...f.wallet, account: "other" } }).action,
    "hold",
  );
  assert.equal(
    planCreation({ ...f, orders: { ...f.orders, account: undefined } }).action,
    "hold",
  );
  for (const key of ["wallet", "orders", "rental", "market"]) {
    assert.equal(
      planCreation({ ...f, [key]: { ...f[key], at: f.now - 76000 } }).action,
      "hold",
    );
    assert.equal(
      planCreation({ ...f, [key]: { ...f[key], at: f.now + 1 } }).action,
      "hold",
    );
  }
  const orders = { ...f.orders, items: [{ active: true }] };
  assert.equal(planCreation({ ...f, orders }).action, "hold");
  assert.equal(
    planCreation({ ...f, orders, policy: { ...policy, allowActive: true } })
      .action,
    "create",
  );
});
test("legacy config and state preserve pending adjustments while creation settings persist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "creation-settings-"));
  try {
    const store = new Store(dir);
    store.intent({
      id: "HS-OLD",
      current: "39",
      target: "39.4",
      href: "https://hashsell.com/orders/HS-OLD",
    });
    store.commit((s) => {
      delete s.config.creation;
    });
    const oldPending = structuredClone(store.state.pending);
    const restored = new Store(dir);
    assert.equal(restored.state.config.creation.enabled, false);
    assert.deepEqual(restored.state.pending, oldPending);
    restored.saveConfig({ ...restored.state.config, creation: policy });
    assert.deepEqual(new Store(dir).state.config.creation, policy);
    assert.deepEqual(new Store(dir).state.pending, oldPending);
    assert.deepEqual(
      validateConfig({ ...DEFAULTS, creation: undefined }).creation,
      CREATION_DEFAULTS,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("duration sizing includes fees, available funds, rounding and minimum power", () => {
  const f = fixture();
  f.policy = { ...policy, sizing: "duration", hours: "9", speedPH: "" };
  const plan = planCreation(f);
  assert.equal(plan.action, "create");
  const D = require("decimal.js");
  const speed = new D("25.12")
    .mul(24)
    .div(new D(9).mul(plan.bid).mul(new D(1).plus(f.config.fee)))
    .toDecimalPlaces(4, D.ROUND_FLOOR);
  assert.equal(plan.speedPH, speed.toString());
  assert.ok(new D(plan.estimatedHours).gte(9));
  assert.ok(new D(plan.estimatedHours).lt("9.001"));
  const all = planCreation({ ...f, policy: { ...f.policy, funding: "all" } });
  assert.ok(new D(all.speedPH).gt(plan.speedPH));
  assert.equal(
    planCreation({ ...f, policy: { ...f.policy, hours: "100" } }).action,
    "hold",
  );
  assert.throws(() => validateCreationPolicy({ ...f.policy, hours: "0" }));
  const { sizing, hours, ...legacy } = policy;
  assert.equal(validateCreationPolicy(legacy).sizing, "power");
});
