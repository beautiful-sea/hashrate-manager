const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store.cjs");
const { Monitor } = require("../src/monitor.cjs");
const { DEFAULTS } = require("../src/config.cjs");
function fixture() {
  const s = new Store(
    fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-monitor-")),
  );
  const c = structuredClone(DEFAULTS);
  // Fixed custom precision for these reconciliation/dispatch fixtures.
  c.tick = "0.0001";
  c.buffer = "0.001";
  c.rental.selector = "#rate";
  c.market.selector = "#cut";
  for (const k of ["row", "id", "bid", "speed", "balance", "status", "link"])
    c.orders[k] = "#" + k;
  c.editor = {
    ...c.editor,
    verified: true,
    identity: "#id",
    input: "#bid",
    submit: "#save",
  };
  s.saveConfig(c);
  const a = {
    calls: 0,
    rate: "43",
    bid: "39",
    read: async function (k) {
      const at = Date.now();
      return k === "rental"
        ? { rate: this.rate, at }
        : k === "market"
          ? { cut: "39.11", at }
          : {
              at,
              items: [
                {
                  id: "HS-1",
                  bid: this.bid,
                  balance: "100",
                  active: true,
                  href: "https://hashsell.com/orders/HS-1",
                },
              ],
            };
    },
    prepare: async () => ({}),
    submit: async function () {
      this.calls++;
      throw Error("timeout");
    },
  };
  return { s, a, m: new Monitor(s, a) };
}
test("monitoring never submits, uncertain live submit is never repeated", async () => {
  const { s, a, m } = fixture();
  await m.start();
  assert.equal(a.calls, 0);
  m.live();
  await m.tick();
  assert.equal(a.calls, 1);
  assert.ok(s.state.pending["HS-1"]);
  await m.tick();
  assert.equal(a.calls, 1);
  a.bid = "39.111";
  await m.tick();
  assert.equal(s.state.pending["HS-1"], undefined);
  m.stop();
});
test("stop during preparation prevents financial dispatch", async () => {
  const { a, m } = fixture();
  await m.start();
  m.live();
  a.prepare = async () => {
    m.stop();
    return {};
  };
  await m.tick();
  assert.equal(a.calls, 0);
  m.stop();
});
test("rate changes during navigation discard original adjustment", async () => {
  const { a, m, s } = fixture();
  await m.start();
  m.live();
  a.prepare = async () => {
    a.rate = "40";
    return {};
  };
  await m.tick();
  assert.equal(a.calls, 0);
  assert.equal(Object.keys(s.state.pending).length, 0);
  m.stop();
});
test("source errors block writes and demo cannot activate live", async () => {
  const { a, m, s } = fixture();
  await m.start();
  m.live();
  a.read = async () => {
    throw Error("Faça login");
  };
  await m.tick();
  assert.equal(a.calls, 0);
  assert.ok(m.result.blocked);
  assert.equal(s.state.history.at(-1).errors.rental, "Faça login");
  m.setDemo(true);
  await m.start();
  assert.throws(() => m.live());
  m.stop();
});
test("confirmed order can accumulate stable decrease observations", async () => {
  const { s, a, m } = fixture();
  s.commit((state) => {
    state.memory["HS-1"] = { changedAt: 1 };
  });
  a.bid = "39.2";
  await m.start();
  assert.equal(m.result.decisions[0].stable, 1);
  await m.tick();
  assert.equal(m.result.decisions[0].stable, 2);
  await m.tick();
  assert.equal(m.result.decisions[0].action, "decrease");
  m.stop();
});
test("isolated environments cannot activate their executor", async () => {
  const { a, m } = fixture();
  try {
    a.liveReady = false;
    await m.start();
    assert.equal(m.snapshot().automationReady, false);
    assert.throws(() => m.live(), /Executor indisponível/);
    await m.tick();
    assert.equal(a.calls, 0);
  } finally {
    m.stop();
  }
});
test("successive reads discover new orders and drop missing orders while monitoring", async () => {
  const { a, m } = fixture();
  try {
    await m.start();
    assert.deepEqual(
      m.result.decisions.map((d) => d.id),
      ["HS-1"],
    );
    const originalRead = a.read.bind(a);
    a.read = async (kind) => {
      const source = await originalRead(kind);
      if (kind === "orders")
        source.items.push({ ...source.items[0], id: "HS-NEW" });
      return source;
    };
    await m.tick();
    assert.deepEqual(
      m.result.decisions.map((d) => d.id),
      ["HS-1", "HS-NEW"],
    );
    a.read = async (kind) => {
      const source = await originalRead(kind);
      if (kind === "orders") source.items = [];
      return source;
    };
    await m.tick();
    assert.deepEqual(m.result.decisions, []);
    assert.equal(m.mode, "monitoring");
    assert.equal(a.calls, 0);
  } finally {
    m.stop();
  }
});
test("disabling adjustments preserves monitoring and cancels prepared dispatch", async () => {
  const { a, m, s } = fixture();
  try {
    await m.start();
    assert.equal(m.snapshot().automationReady, true);
    m.live();
    a.prepare = async () => {
      m.disableAdjustments();
      return {};
    };
    await m.tick();
    assert.equal(m.mode, "monitoring");
    assert.equal(m.running, true);
    assert.equal(a.calls, 0);
    assert.deepEqual(s.state.pending, {});
    const config = structuredClone(m.config);
    config.editor.kind = "form";
    m.updateConfig(config);
    assert.equal(m.snapshot().automationReady, false);
    assert.throws(() => m.live(), /Edição/);
  } finally {
    m.stop();
  }
});
test("order disappearing during preflight cannot be submitted", async () => {
  const { a, m, s } = fixture();
  try {
    await m.start();
    m.live();
    const originalRead = a.read.bind(a);
    a.prepare = async () => {
      a.read = async (kind) => {
        const source = await originalRead(kind);
        if (kind === "orders") source.items = [];
        return source;
      };
      return {};
    };
    await m.tick();
    assert.equal(a.calls, 0);
    assert.deepEqual(s.state.pending, {});
    assert.match(m.result.blocked, /ajuste descartado/);
  } finally {
    m.stop();
  }
});

test("preview cannot bypass a later revenue drop or pause", async () => {
  for (const stop of [false, true]) {
    const { a, m, s } = fixture();
    try {
      await m.start();
      m.live();
      a.stage = async (_prepared, authority, isCurrent) => {
        assert.equal(authority.target, "39.111");
        assert.equal(isCurrent(), true);
        if (stop) {
          m.disableAdjustments();
          assert.equal(isCurrent(), false);
        } else a.rate = "40";
      };
      await m.tick();
      assert.equal(a.calls, 0);
      assert.deepEqual(s.state.pending, {});
    } finally {
      m.stop();
    }
  }
});

test("proven pre-transport rejection defers only its order and keeps automatic adjustments", async () => {
  const { a, m, s } = fixture();
  try {
    await m.start();
    m.live();
    a.submit = async () => {
      throw Object.assign(Error("Payload inválido"), { notDispatched: true });
    };
    await m.tick();
    assert.deepEqual(s.state.pending, {});
    assert.equal(m.mode, "live");
    assert.equal(m.running, true);
    assert.ok(s.state.memory["HS-1"].retryAfter > Date.now());
    assert.equal(s.state.history.at(-1).type, "not-sent");
    assert.equal(m.result.blocked, null);
    assert.match(s.state.history.at(-1).message, /Payload inválido/);
    a.submit = async () => {
      a.calls++;
    };
    await m.tick();
    assert.equal(a.calls, 0);
    assert.deepEqual(s.state.pending, {});
  } finally {
    m.stop();
  }
});

test("automatic startup enables monitoring and adjustments but does not resend uncertain intent", async () => {
  const { s, a, m } = fixture();
  try {
    await m.startAutomatic();
    assert.equal(m.running, true);
    assert.equal(m.mode, "live");
    assert.equal(a.calls, 1);
    assert.ok(s.state.pending["HS-1"]);
    await m.tick();
    assert.equal(a.calls, 1);
    m.disableAdjustments();
    await m.tick();
    assert.equal(m.mode, "monitoring");
    assert.equal(a.calls, 1);
  } finally {
    m.stop();
  }
});
test("automatic startup waits through failed readings and never bypasses the margin", async () => {
  for (const rate of [null, "1"]) {
    const { a, m } = fixture();
    const read = a.read.bind(a);
    a.read = async (kind) => {
      if (kind === "rental" && rate === null) throw Error("Login necessário");
      return read(kind);
    };
    a.rate = rate;
    try {
      await m.startAutomatic();
      assert.equal(m.running, true);
      assert.equal(m.mode, "live");
      if (rate === null) assert.equal(a.calls, 0);
      else {
        assert.equal(a.calls, 1);
        const intent = m.store.state.history.find((e) => e.type === "intent");
        const cap = require("../src/engine.cjs").ceiling(rate, m.config);
        assert.ok(Number(intent.target) <= Number(cap));
        assert.ok(Number(intent.target) < Number(intent.previous));
      }
    } finally {
      m.stop();
    }
  }
});
test("automatic startup cannot enable isolated executors or demo", async () => {
  for (const scenario of ["demo", "isolated"]) {
    const { a, m } = fixture();
    if (scenario === "demo") m.demo = true;
    else a.liveReady = false;
    await assert.rejects(m.startAutomatic(), /indisponível/);
    assert.equal(a.calls, 0);
    assert.equal(m.running, false);
  }
});

test("uncertain order does not block another order and never resends itself", async () => {
  const { s, a, m } = fixture();
  const original = a.read;
  a.read = async function (k) {
    const data = await original.call(this, k);
    if (k === "orders")
      data.items.push({
        ...data.items[0],
        id: "HS-2",
        href: "https://hashsell.com/orders/HS-2",
      });
    return data;
  };
  await m.start();
  m.live();
  await m.tick();
  assert.equal(a.calls, 1);
  assert.ok(s.state.pending["HS-1"]);
  await m.tick();
  assert.equal(a.calls, 2);
  assert.ok(s.state.pending["HS-2"]);
  await m.tick();
  assert.equal(a.calls, 2);
  m.stop();
});
test("explicit form rejection releases only rejected order and backs off before reevaluating", async () => {
  const { s, a, m } = fixture();
  a.submit = async () => {
    a.calls++;
    const e = Error("Hashsell recusou o ajuste: aguarde");
    e.rejected = true;
    e.receipt = { completed: true, statusCode: 200 };
    throw e;
  };
  await m.start();
  m.live();
  await m.tick();
  assert.equal(a.calls, 1);
  assert.equal(s.state.pending["HS-1"], undefined);
  assert.ok(s.state.memory["HS-1"].retryAfter > Date.now());
  await m.tick();
  assert.equal(a.calls, 1);
  assert.equal(m.mode, "live");
  m.stop();
});
test("HTTP failure marked rejected remains uncertain and cannot release an intent", async () => {
  const { s, a, m } = fixture();
  a.submit = async () => {
    a.calls++;
    const e = Error("HTTP 500");
    e.rejected = true;
    e.receipt = { completed: true, statusCode: 500 };
    throw e;
  };
  await m.start();
  m.live();
  await m.tick();
  assert.ok(s.state.pending["HS-1"]);
  await m.tick();
  assert.equal(a.calls, 1);
  m.stop();
});

test("pending detail conference runs automatically in monitoring mode and survives read-list failure", async () => {
  const { s, a, m } = fixture();
  const p = s.intent({
    id: "HS-1",
    current: "39",
    target: "39.111",
    href: "https://hashsell.com/orders/HS-1",
  });
  let checks = 0;
  a.checkPending = async (intent) => {
    checks++;
    return {
      id: intent.id,
      intentId: intent.intentId,
      href: intent.href,
      current: "39",
      checkedAt: Date.now(),
    };
  };
  const original = a.read;
  a.read = async (k) => {
    if (k === "orders") throw Error("HTTP 500");
    return original.call(a, k);
  };
  await m.start();
  assert.equal(checks, 1);
  assert.equal(a.calls, 0);
  assert.ok(s.state.pending["HS-1"].reconciliation);
  await m.tick();
  assert.equal(checks, 1);
  m.stop();
});
test("stop or changed intent during detail conference cannot confirm another attempt", async () => {
  const { s, a, m } = fixture();
  const p = s.intent({
    id: "HS-1",
    current: "39",
    target: "39.111",
    href: "https://hashsell.com/orders/HS-1",
  });
  a.checkPending = async (intent) => {
    m.stop();
    return {
      id: intent.id,
      intentId: intent.intentId,
      href: intent.href,
      current: "39.111",
      checkedAt: Date.now(),
    };
  };
  await m.start();
  assert.ok(s.state.pending["HS-1"]);
  assert.equal(a.calls, 0);
  m.stop();
});

test("one pending detail per cycle is checked before obtaining fresh market snapshots", async () => {
  const { s, a, m } = fixture();
  for (const id of ["HS-1", "HS-2"])
    s.intent({
      id,
      current: "39",
      target: "39.111",
      href: "https://hashsell.com/orders/" + id,
    });
  const events = [];
  const original = a.read;
  a.read = async (k) => {
    events.push(k);
    return original.call(a, k);
  };
  a.checkPending = async (intent) => {
    events.push("check:" + intent.id);
    return {
      id: intent.id,
      intentId: intent.intentId,
      href: intent.href,
      current: "39",
      checkedAt: Date.now(),
    };
  };
  await m.start();
  assert.deepEqual(events.slice(0, 2), ["check:HS-1", "rental"]);
  assert.equal(events.filter((x) => x.startsWith("check:")).length, 1);
  await m.tick();
  assert.equal(events.filter((x) => x.startsWith("check:")).length, 2);
  assert.ok(events.includes("check:HS-2"));
  m.stop();
});

test("temporary read failure keeps live monitoring and recovers without manual activation", async () => {
  const { a, m, s } = fixture();
  const read = a.read.bind(a);
  try {
    await m.start();
    m.live();
    a.read = async (kind) => {
      if (kind === "market") throw Error("HTTP 404");
      return read(kind);
    };
    await m.tick();
    assert.equal(m.running, true);
    assert.equal(m.mode, "live");
    assert.equal(a.calls, 0);
    assert.ok(m.timer);
    assert.deepEqual(s.state.pending, {});
    a.read = read;
    await m.tick();
    assert.equal(a.calls, 1);
    assert.equal(m.mode, "live");
    assert.equal(m.result.blocked, null);
    await m.tick();
    assert.equal(a.calls, 1);
  } finally {
    m.stop();
  }
});

test("only definitive rejection or proven no dispatch releases creation in the same cycle", async () => {
  for (const outcome of ["rejected", "not-sent", "uncertain", "accepted"]) {
    const { s, a, m } = fixture();
    let deferred;
    m.creation.tick = async (c, e, d) => {
      deferred = d;
    };
    a.submit = async () => {
      if (outcome === "accepted")
        return { admitted: true, completed: true, statusCode: 200 };
      throw Object.assign(
        Error(outcome),
        outcome === "rejected"
          ? {
              rejected: true,
              receipt: { admitted: true, completed: true, statusCode: 200 },
            }
          : outcome === "not-sent"
            ? { notDispatched: true }
            : {},
      );
    };
    try {
      await m.start();
      m.live();
      await m.tick();
      assert.equal(
        deferred,
        ["uncertain", "accepted"].includes(outcome),
        outcome,
      );
      if (outcome === "rejected") {
        assert.ok(s.state.memory["HS-1"].retryAfter > Date.now());
        assert.equal(s.state.pending["HS-1"], undefined);
      }
      if (outcome === "uncertain") assert.ok(s.state.pending["HS-1"]);
    } finally {
      m.stop();
    }
  }
});

test("live progress publishes actual order phases, next evaluation and clears on pause", async () => {
  const { a, m } = fixture();
  const seen = [];
  m.on("state", (s) => seen.push(s));
  try {
    await m.start();
    m.live();
    await m.tick();
    assert.ok(
      seen.some(
        (s) => s.operation?.id === "HS-1" && s.operation.phase === "preparing",
      ),
    );
    assert.ok(
      seen.some(
        (s) => s.operation?.id === "HS-1" && s.operation.phase === "sending",
      ),
    );
    assert.ok(
      seen.some(
        (s) => s.operation?.id === "HS-1" && s.operation.phase === "checking",
      ),
    );
    const idle = m.snapshot();
    assert.equal(idle.operation, null);
    assert.ok(idle.nextCycleAt > Date.now());
    assert.ok(idle.nextCycleAt <= Date.now() + m.config.pollSeconds * 1000);
    m.stop();
    assert.equal(m.snapshot().nextCycleAt, null);
    assert.equal(m.snapshot().operation, null);
  } finally {
    m.stop();
  }
});

test("saving settings preserves live, monitoring-only and paused state; invalid settings have no effect", async () => {
  for (const mode of ["live", "monitoring", "paused"]) {
    const { m } = fixture();
    try {
      if (mode !== "paused") await m.start();
      if (mode === "live") m.live();
      const before = { running: m.running, mode: m.mode, epoch: m.epoch };
      m.updateConfig({ ...m.config, margin: "0.03" });
      assert.equal(m.running, before.running);
      assert.equal(m.mode, before.mode);
      assert.equal(m.epoch, before.epoch + 1);
      const epoch = m.epoch;
      assert.throws(() => m.updateConfig({ ...m.config, margin: "invalid" }));
      assert.equal(m.epoch, epoch);
      assert.equal(m.mode, before.mode);
    } finally {
      m.stop();
    }
  }
});
test("settings changed during preparation cancel old bid without disabling automation", async () => {
  const { m, a, s } = fixture();
  try {
    await m.start();
    m.live();
    a.prepare = async () => {
      m.updateConfig({ ...m.config, margin: "0.03" });
      return {};
    };
    await m.tick();
    assert.equal(a.calls, 0);
    assert.equal(m.mode, "live");
    assert.equal(m.running, true);
    assert.deepEqual(s.state.pending, {});
    assert.ok(m.snapshot().nextCycleAt > Date.now());
  } finally {
    m.stop();
  }
});

test("confirmed adjustment releases creation after independent read without starving it", async () => {
  const { s, a, m } = fixture();
  const events = [];
  a.submit = async () => {
    events.push("adjust");
    a.bid = "39.111";
    return { admitted: true, completed: true, statusCode: 200 };
  };
  m.creation.tick = async (_c, _e, deferred) => {
    if (m.mode !== "live") return;
    events.push("creation");
    assert.equal(deferred, false);
    assert.equal(s.state.pending["HS-1"], undefined);
    assert.ok(
      s.state.history.some((e) => e.type === "confirmed" && e.id === "HS-1"),
    );
  };
  try {
    await m.start();
    m.live();
    await m.tick();
    assert.deepEqual(events, ["adjust", "creation"]);
  } finally {
    m.stop();
  }
});
