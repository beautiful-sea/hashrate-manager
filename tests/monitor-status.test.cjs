const { test } = require("node:test");
const assert = require("node:assert/strict");
const { monitorStatus } = require("../src/ui/monitor-status.js");
const base = {
  running: true,
  mode: "live",
  result: {},
  errors: {},
  pending: {},
};
test("healthy status is simple while failures never claim successful adjustments", () => {
  assert.equal(
    monitorStatus(base).text,
    "Monitoramento ativo. Ajustes automáticos ligados.",
  );
  const failure = monitorStatus({ ...base, result: { blocked: "HTTP 404" } });
  assert.match(failure.text, /Atualizando/);
  assert.equal(failure.warning, false);
  assert.doesNotMatch(failure.text, /histórico|bloquead|gastando|funcionando/);
});
test("pending conference is automatic and expired login still gives necessary action", () => {
  const pending = monitorStatus({ ...base, pending: { "HS-1": {} } });
  assert.match(pending.text, /automaticamente/);
  assert.doesNotMatch(pending.text, /histórico/);
  const expired = monitorStatus({
    ...base,
    errors: { rental: "Faça login na plataforma." },
    result: { blocked: "read failed" },
  });
  assert.equal(expired.warning, true);
  assert.match(expired.text, /Faça login novamente/);
  assert.equal(
    monitorStatus({ ...base, running: false }).text,
    "Monitoramento pausado.",
  );
});

test("missing orders never mean zero orders or expired login", () => {
  const { ordersStatus } = require("../src/ui/monitor-status.js");
  const state = { ...base, config: { maxAgeSeconds: 75 }, sources: {} };
  const failure = ordersStatus(
    { ...state, errors: { orders: "SITE_UNAVAILABLE HTTP 404" } },
    100000,
  );
  assert.equal(failure.known, false);
  assert.match(failure.title, /Aguardando leitura/);
  assert.match(failure.text, /automaticamente/);
  assert.doesNotMatch(failure.text, /login|Iniciar/);
  assert.match(
    ordersStatus({ ...state, errors: { orders: "AUTH_REQUIRED" } }, 100000)
      .title,
    /Entre novamente/,
  );
  assert.equal(
    ordersStatus(
      { ...state, sources: { orders: { at: 100000, items: [] } } },
      100000,
    ).known,
    true,
  );
  assert.equal(
    ordersStatus(
      { ...state, sources: { orders: { at: 1, items: [] } } },
      100000,
    ).known,
    false,
  );
  assert.match(
    ordersStatus({ ...state, running: false }, 100000).title,
    /pausado/,
  );
});
