const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path"),
  os = require("os");
const { JSDOM } = require("jsdom");
const { reconciliationScript } = require("../src/reconciliation.cjs");
const { Store } = require("../src/store.cjs");
const intent = {
  id: "HS-ABC123",
  intentId: "attempt-1",
  previous: "39.77",
  target: "39.66",
  href: "https://hashsell.com/orders/HS-ABC123",
  at: Date.now() - 3600000,
};
const read = (html, url = intent.href) =>
  new JSDOM(html, { url, runScripts: "outside-only" }).window.eval(
    reconciliationScript(intent),
  );
test("detail reader uses the specific order card, never the market price", () => {
  const r = read(
    "<h1>HS-ABC123</h1><p>Preço de corte</p><p>US$ 39,80 /PH/s/dia</p><p>Seu lance</p><p>US$ 39,7700 /PH/s/dia</p>",
  );
  assert.equal(r.ok, true);
  assert.equal(r.value.value, "39,7700");
  assert.equal(r.value.unit, "PH");
  for (const html of [
    "<h1>HS-WRONG</h1><p>Seu lance</p><p>US$ 39,77 /PH/s/dia</p>",
    "<input type=password>",
    "<p>Seu lance</p><p>Seu lance</p>",
  ])
    assert.equal(read(html).ok, false);
  assert.equal(
    read("<h1>HS-ABC123</h1>", "https://hashsell.com/login").ok,
    false,
  );
});
test("Flight exact order code and scaled price are data-only and conflicting records reject", () => {
  const payload =
    "1:" +
    JSON.stringify({
      order: { code: intent.id, id: "uuid", priceScaled: "3977000" },
    }) +
    "\n";
  const script = (p) =>
    "<script>self.__next_f.push(" + JSON.stringify([1, p]) + ")</script>";
  const r = read(script(payload));
  assert.equal(r.ok, true);
  assert.equal(r.value.priceScaled, "3977000");
  assert.equal(
    read(
      script(
        payload +
          "2:" +
          JSON.stringify({
            code: intent.id,
            id: "uuid",
            priceScaled: "3966000",
          }) +
          "\n",
      ),
    ).ok,
    false,
  );
});
function store() {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-")));
  s.commit((x) => (x.pending[intent.id] = structuredClone(intent)));
  return s;
}
const evidence = (current = "39.77") => ({
  id: intent.id,
  intentId: intent.intentId,
  href: intent.href,
  current,
  checkedAt: Date.now(),
  source: "order-card",
});
test("old/current/third price never closes uncertain intent; exact price confirms", () => {
  const s = store();
  for (const current of ["39.77", "39.80"]) {
    assert.equal(s.recordReconciliation(intent, evidence(current)), false);
    assert.ok(s.state.pending[intent.id]);
    assert.equal(s.state.pending[intent.id].status, "checking");
  }
  assert.equal(s.recordReconciliation(intent, evidence("39.6600")), true);
  assert.equal(s.state.pending[intent.id], undefined);
});
test("identity, attempt and stale document cannot resolve; failures persist and retry after one minute", () => {
  const s = store();
  for (const change of [
    { intentId: "different" },
    { id: "HS-OTHER" },
    { href: "https://hashsell.com/orders/HS-OTHER" },
    { checkedAt: intent.at - 1 },
  ])
    assert.throws(() =>
      s.recordReconciliation(intent, { ...evidence("39.66"), ...change }),
    );
  s.reconciliationFailed(intent, "HTTP 500");
  assert.ok(s.state.pending[intent.id].reconciliation.nextAt > Date.now());
  assert.ok(s.state.pending[intent.id]);
  s.commit((x) => (x.pending[intent.id].intentId = "new-attempt"));
  assert.equal(s.recordReconciliation(intent, evidence("39.66")), false);
});
test("submission outcome survives restart and is bound to the exact intent", () => {
  const s = store();
  s.recordOutcome(intent, {
    kind: "uncertain",
    receipt: { completed: false },
    message: "timeout",
  });
  const loaded = new Store(path.dirname(s.file));
  assert.equal(
    loaded.state.pending[intent.id].outcome.intentId,
    intent.intentId,
  );
  assert.equal(loaded.state.pending[intent.id].outcome.kind, "uncertain");
  assert.equal(
    s.recordOutcome({ ...intent, intentId: "wrong" }, { kind: "submitted" }),
    false,
  );
});

test("restart recovers only definitive rejection bound to pending intent", () => {
  for (const status of [200, 500]) {
    const s = store();
    s.recordOutcome(intent, {
      kind: "rejected",
      rejected: true,
      receipt: { completed: true, statusCode: status },
      message: "A redução ultrapassa o passo permitido.",
    });
    const loaded = new Store(path.dirname(s.file));
    loaded.recordReconciliation(intent, evidence());
    assert.equal(Boolean(loaded.state.pending[intent.id]), status === 500);
  }
});

test("rounded display cannot confirm exact financial target", () => {
  const s = store();
  assert.equal(
    s.recordReconciliation(intent, { ...evidence("39.66"), exact: false }),
    false,
  );
  assert.ok(s.state.pending[intent.id]);
});
test("proven unsent outcome recovers after restart without dispatching anything", () => {
  const s = store();
  s.recordOutcome(intent, {
    kind: "not-sent",
    notDispatched: true,
    message: "Guard blocked before send",
  });
  const loaded = new Store(path.dirname(s.file));
  assert.equal(loaded.recordReconciliation(intent, evidence()), true);
  assert.equal(loaded.state.pending[intent.id], undefined);
  assert.equal(loaded.state.history.at(-1).type, "not-sent");
});

test("hidden error translations do not reject valid order evidence; rendered errors do", () => {
  const payload =
    "1:" +
    JSON.stringify({
      order: { code: intent.id, id: "uuid", priceScaled: "3977000" },
      translations: { error: "Não foi possível carregar esta tela" },
    }) +
    "\n";
  const html =
    "<script>self.__next_f.push(" + JSON.stringify([1, payload]) + ")</script>";
  assert.equal(
    read(html + "<p hidden>Não foi possível carregar esta tela</p>").ok,
    true,
  );
  assert.equal(
    read(html + "<h1>Não foi possível carregar esta tela</h1>").ok,
    false,
  );
  const w = new JSDOM(html, { url: intent.href, runScripts: "outside-only" })
    .window;
  Object.defineProperty(w.document.body, "innerText", {
    value: "HS-ABC123 Seu lance US$ 39,77 /PH/s/dia",
    configurable: true,
  });
  assert.equal(w.eval(reconciliationScript(intent)).ok, true);
  Object.defineProperty(w.document.body, "innerText", {
    value: "O servidor não respondeu como esperado",
  });
  assert.equal(w.eval(reconciliationScript(intent)).ok, false);
});
