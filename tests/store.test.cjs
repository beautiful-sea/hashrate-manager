const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store.cjs");
test("intent survives restart, blocks retry and only exact price resolves", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-store-"));
  const s = new Store(dir);
  s.intent({
    id: "HS-1",
    current: "39",
    target: "39.111",
    href: "https://hashsell.com/orders/HS-1",
  });
  const recovered = new Store(dir);
  assert.equal(Object.keys(recovered.state.pending).length, 1);
  assert.throws(() => recovered.intent({ id: "HS-1" }));
  assert.equal(recovered.reconcile([{ id: "HS-1", bid: "39" }]), 0);
  assert.equal(recovered.reconcile([{ id: "HS-2", bid: "39.111" }]), 0);
  assert.equal(recovered.reconcile([{ id: "HS-1", bid: "39.1110" }]), 1);
  assert.equal(Object.keys(new Store(dir).state.pending).length, 0);
});
test("corrupt state is not silently replaced", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-corrupt-"));
  fs.writeFileSync(path.join(dir, "state.json"), "{bad");
  assert.throws(() => new Store(dir));
  assert.equal(fs.readFileSync(path.join(dir, "state.json"), "utf8"), "{bad");
});
test("legacy ID selection is removed without losing pending intents or history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-legacy-"));
  const s = new Store(dir);
  s.intent({ id: "HS-OLD", current: "39", target: "39.111", href: "" });
  s.commit((state) => {
    state.config.managedOrders = ["HS-OLD"];
  });
  const oldState = structuredClone(s.state);
  const recovered = new Store(dir);
  assert.equal("managedOrders" in recovered.state.config, false);
  assert.deepEqual(recovered.state.pending, oldState.pending);
  assert.deepEqual(recovered.state.history, oldState.history);
  assert.deepEqual(recovered.state.memory, oldState.memory);
});

test("empty legacy editor migrates automatically without changing margin or pending intent", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hashrate-editor-migration-"),
  );
  const s = new Store(dir);
  s.intent({ id: "HS-OLD", current: "39", target: "39.111", href: "" });
  s.commit((state) => {
    delete state.config.editor.kind;
    state.config.editor.locale = "en-US";
  });
  const recovered = new Store(dir);
  assert.equal(recovered.state.config.editor.kind, "hashsell-dom");
  assert.equal(recovered.state.config.editor.locale, "pt-BR");
  assert.equal(recovered.state.config.margin, "0.05");
  assert.deepEqual(recovered.state.pending, s.state.pending);
  assert.throws(() =>
    recovered.abortUnsent({ id: "HS-OLD", intentId: "wrong" }, "failed"),
  );
  assert.ok(recovered.state.pending["HS-OLD"]);
});

test("pending intents isolate orders and stale reads require review without deleting intent", () => {
  const s = new Store(
    fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-isolate-")),
  );
  const d = (id) => ({
    id,
    current: "39",
    target: "39.111",
    href: "https://hashsell.com/orders/" + id,
  });
  const old = s.intent(d("HS-1"));
  s.commit((x) => (x.pending["HS-1"].at = Date.now() - 180000));
  s.intent(d("HS-2"));
  s.reconcile([
    { id: "HS-1", bid: "39" },
    { id: "HS-2", bid: "39.111" },
  ]);
  assert.equal(s.state.pending["HS-1"].intentId, old.intentId);
  assert.equal(s.state.pending["HS-1"].status, undefined);
  assert.equal(s.state.pending["HS-2"], undefined);
  assert.throws(() => s.intent(d("HS-1")));
  s.reconcile([{ id: "HS-1", bid: "39" }]);
  assert.equal(
    s.state.history.filter((h) => h.type === "review-required").length,
    0,
  );
});

test("old default pair migrates once with original backup and unchanged pending/history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-defaults-"));
  const s = new Store(dir);
  s.intent({
    id: "HS-1",
    current: "39.3",
    target: "39.411",
    href: "https://hashsell.com/orders/HS-1",
  });
  s.commit((x) => {
    delete x.bidDefaultsRevision;
    x.config.tick = "0.0001";
    x.config.buffer = "0.001";
    x.config.margin = "0.03";
  });
  const before = structuredClone(s.state);
  const raw = fs.readFileSync(s.file, "utf8");
  const upgraded = new Store(dir);
  assert.equal(upgraded.state.config.tick, "0.01");
  assert.equal(upgraded.state.config.buffer, "0.05");
  assert.equal(upgraded.state.config.margin, "0.03");
  assert.deepEqual(upgraded.state.pending, before.pending);
  assert.deepEqual(upgraded.state.history, before.history);
  assert.deepEqual(upgraded.state.memory, before.memory);
  const backups = fs
    .readdirSync(dir)
    .filter((x) => x.includes("before-bid-defaults"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), raw);
  upgraded.commit((x) => {
    x.config.tick = "0.0001";
    x.config.buffer = "0.001";
  });
  assert.equal(new Store(dir).state.config.buffer, "0.001");
  assert.equal(
    fs.readdirSync(dir).filter((x) => x.includes("before-bid-defaults")).length,
    1,
  );
});
test("custom legacy headroom is never replaced", () => {
  for (const values of [
    { tick: "0.0001", buffer: "0.03" },
    { tick: "0.01", buffer: "0.001" },
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-custom-"));
    const s = new Store(dir);
    s.commit((x) => {
      delete x.bidDefaultsRevision;
      Object.assign(x.config, values);
    });
    const upgraded = new Store(dir);
    assert.equal(upgraded.state.config.tick, values.tick);
    assert.equal(upgraded.state.config.buffer, values.buffer);
  }
});

test("platform reduction cooldown survives restart and never retries before requested seconds", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-cooldown-"));
  const s = new Store(dir);
  const intent = s.intent({
    id: "HS-COOL",
    current: "39.14",
    target: "39.08",
    href: "https://hashsell.com/orders/HS-COOL",
  });
  const before = Date.now();
  s.reject(
    intent,
    "Reduções de preço têm um intervalo de espera. Tente de novo em 132 s.",
    { completed: true, statusCode: 200 },
  );
  const recovered = new Store(dir);
  assert.ok(recovered.state.memory["HS-COOL"].retryAfter >= before + 134000);
  assert.equal(
    recovered.state.memory["HS-COOL"].retryReason,
    "platform-cooldown",
  );
  assert.equal(recovered.state.pending["HS-COOL"], undefined);
});
