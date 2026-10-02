const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { JSDOM } = require("jsdom");
const { withdrawalOverview } = require("../src/reinvestment.cjs");
const hour = 3600000,
  initial = Date.parse("2026-10-01T15:00:00Z");
function fixture() {
  const timing = [1, 2].map((n, i) => ({
    id: "0x" + String(n).repeat(64),
    requestedAt: "2026-09-25T12:00:00Z",
    completedAt: new Date(
      Date.parse("2026-09-25T12:00:00Z") + (24 + i * 12) * hour,
    ).toISOString(),
    net: "100.12345678",
  }));
  return {
    payments: {
      at: initial,
      timing,
      completed: timing.map((r) => ({
        id: r.id,
        status: "Concluído",
        displayedAt: "25/09/2026, 09:00",
      })),
      pending: [
        {
          status: "Pendente",
          displayedAt: "01/10/2026, 06:00",
          gross: "US$ 102,00",
          fee: "US$ 2,00",
        },
      ],
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  const dom = new JSDOM(
    '<nav><button data-tab="history">Histórico</button></nav><main></main>',
    { runScripts: "outside-only" },
  );
  let now = initial,
    account = fixture(),
    calls = 0;
  const timers = new Map();
  dom.window.Date.now = () => now;
  dom.window.setInterval = (fn, ms) => {
    timers.set(ms, fn);
    return ms;
  };
  dom.window.setTimeout = (fn) => {
    fn();
    return 1;
  };
  dom.window.hashrate = {
    invoke: async (action) => {
      assert.equal(action, "withdrawals-query");
      calls++;
      const result = withdrawalOverview(account, now);
      return {
        ...result,
        rows: result.rows.map((r) => ({
          ...r,
          brlNet: r.net == null ? null : String(Number(r.net) * 5),
        })),
      };
    },
  };
  dom.window.eval(
    fs.readFileSync(path.join(__dirname, "../src/ui/withdrawals.js"), "utf8"),
  );
  const page = dom.window.document.querySelector("#page-withdrawals");
  return {
    dom,
    page,
    timers,
    calls: () => calls,
    setNow: (n) => (now = n),
    setAccount: (a) => (account = a),
    open: () => {
      page.hidden = false;
      dom.window.document.querySelector('[data-tab="withdrawals"]').click();
    },
  };
}
test("Saques renders mean, pending estimate, BRL, history and duration timeline", async () => {
  const h = harness();
  h.open();
  await flush();
  const doc = h.dom.window.document;
  assert.equal(doc.querySelector("#withdrawal-average").textContent, "30 h");
  assert.equal(doc.querySelector("#withdrawal-pending-count").textContent, "1");
  assert.match(
    doc.querySelector("#withdrawal-pending").textContent,
    /24 h restantes/,
  );
  assert.match(doc.querySelector("#withdrawal-pending").textContent, /≈ R\$/);
  assert.equal(doc.querySelectorAll("#withdrawal-rows tr").length, 3);
  assert.equal(
    doc.querySelectorAll("#withdrawal-timeline [role=listitem]").length,
    3,
  );
  h.dom.window.close();
});
test("countdown becomes overdue and automatic refresh preserves open details, filter and cards", async () => {
  const h = harness();
  h.open();
  await flush();
  const doc = h.dom.window.document,
    details = doc.querySelector("details"),
    filter = doc.querySelector("#withdrawal-filter");
  details.open = true;
  filter.value = "pending";
  filter.dispatchEvent(new h.dom.window.Event("change"));
  await h.timers.get(10000)();
  await flush();
  const card = doc.querySelector(".withdrawal-pending-card");
  h.setNow(initial + 25 * hour);
  h.timers.get(1000)();
  assert.match(card.textContent, /1 h acima da média/);
  await h.timers.get(10000)();
  await flush();
  assert.equal(details.open, true);
  assert.equal(filter.value, "pending");
  assert.equal(doc.querySelectorAll("#withdrawal-rows tr").length, 1);
  assert.equal(doc.querySelector(".withdrawal-pending-card"), card);
  assert.equal(doc.querySelectorAll(".withdrawal-overdue").length, 2);
  h.dom.window.close();
});
test("hidden screen performs no queries and account change removes prior withdrawals", async () => {
  const h = harness();
  await h.timers.get(10000)();
  await flush();
  assert.equal(h.calls(), 0);
  h.open();
  await flush();
  h.setAccount(null);
  await h.timers.get(10000)();
  await flush();
  assert.equal(
    h.dom.window.document.querySelector("#withdrawal-average").textContent,
    "—",
  );
  assert.equal(
    h.dom.window.document.querySelectorAll(".withdrawal-pending-card").length,
    0,
  );
  assert.match(h.page.textContent, /Aguardando suas contas/);
  h.dom.window.close();
});
