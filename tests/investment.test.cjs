const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { investment } = require("../src/investment.cjs");
const now = Date.parse("2026-10-01T15:00:00Z");
const row = (category, amount, day = "2026-09-28", label = "") => ({
  site: category === "revenue" ? "rental" : "hashsell",
  category,
  amount,
  day,
  label,
});
const pix = (amount, day) =>
  row("deposits", amount, day, "Pix Recarga Creditado Pix 500.01 BRL");
const account = (entries) => ({
  entries,
  payments: { rows: [], at: now },
  updatedAt: now,
  coverage: ["hashsell", "rental"].map((site) => ({
    site,
    complete: true,
    from: "2026-09-01",
    to: "2026-10-01",
  })),
});
const report = { range: { from: "0000-01-01" } };
test("Pix only, exact decimals and original BRL; equal deposits preserved", () => {
  const a = account([
    pix("100.00000001"),
    pix("100.00000001"),
    row("deposits", "900", undefined, "USDT Recarga Creditado"),
    row("transfer", "200", undefined, "Pix"),
  ]);
  const r = investment(a, report, null, now);
  assert.equal(r.target, "200.00000002");
  assert.equal(r.originalBrl, "1000.02");
  assert.equal(r.count, 2);
  assert.equal(r.profit, "0");
});
test("historical recovery includes costs and withdrawal fees, filters keep prior profit", () => {
  const a = account([
    pix("100"),
    row("revenue", "160"),
    row("consumption", "-40"),
    row("fees", "-3"),
    row("fees", "-2"),
  ]);
  const r = investment(a, { range: { from: "2026-09-29" } }, null, now);
  assert.equal(r.reached, "2026-09-28");
  assert.equal(r.historyTarget, "-15");
  assert.equal(r.profit, "115");
});
test("forecast aligns baseline to lifetime profit and does not count deposits as profit", () => {
  const a = account([pix("100"), row("revenue", "50")]);
  const f = {
    available: true,
    to: "2026-09-30",
    baseline: "30",
    days: [
      { day: "2026-10-01", cumulative: "70" },
      { day: "2026-10-02", cumulative: "80" },
    ],
  };
  const r = investment(a, report, f, now);
  assert.equal(r.forecastTarget, "80");
  assert.equal(r.projected, "2026-10-02");
  assert.equal(r.reached, null);
  f.days = [];
  assert.equal(investment(a, report, f, now).projected, null);
});
test("additional investment, losses, incomplete history and current day never falsely confirm recovery", () => {
  const a = account([
    pix("100"),
    row("revenue", "150"),
    pix("100", "2026-09-29"),
  ]);
  assert.equal(investment(a, report, null, now).reached, null);
  a.entries = [
    pix("100"),
    row("revenue", "150"),
    row("consumption", "-60", "2026-09-30"),
  ];
  assert.equal(investment(a, report, null, now).reached, null);
  a.entries = [pix("100"), row("revenue", "150", "2026-10-01")];
  assert.equal(investment(a, report, null, now).reached, null);
  a.entries = [pix("100"), row("revenue", "150")];
  a.payments = null;
  assert.equal(investment(a, report, null, now).complete, false);
  assert.equal(investment(a, report, null, now).reached, null);
  assert.equal(investment(null, report, null, now), null);
});
test("chart draws Pix target and refreshes when only target changes", () => {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("<svg></svg><div></div>", {
    runScripts: "outside-only",
  });
  dom.window.eval(require("fs").readFileSync("src/ui/report-chart.js", "utf8"));
  const svg = dom.window.document.querySelector("svg");
  const chart = new dom.window.ReportChart(
    svg,
    dom.window.document.querySelector("div"),
    () => {},
  );
  const days = [{ day: "2026-09-28", cumulative: "50" }];
  chart.render(days, { target: "100", day: null });
  assert.match(svg.textContent, /aportes Pix/);
  const before = svg.innerHTML;
  chart.render(days, { target: "200", day: null });
  assert.notEqual(svg.innerHTML, before);
});

test("reports screen shows actual Pix BRL, preserves details and exposes forecast date", async () => {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(
    '<nav><button data-tab="history"></button></nav><main></main>',
    { runScripts: "outside-only" },
  );
  let tick;
  dom.window.setInterval = (fn) => {
    tick = fn;
  };
  const totals = require("../src/reports.cjs").sumRows([]);
  const data = {
    ready: true,
    paymentsReady: true,
    totals,
    days: [],
    entries: [],
    warnings: [],
    forecast: {
      available: true,
      days: [],
      count: 2,
      cycleHours: "48",
      cycleRate: ".1",
      timing: { transitHours: 24, allocationHours: 0, samples: 2 },
    },
    investment: {
      target: "100",
      originalBrl: "500.01",
      count: 1,
      complete: true,
      projected: "2026-10-02",
      deposits: [{ day: "2026-09-28", amount: "100" }],
      historyTarget: "100",
      forecastTarget: "100",
    },
  };
  dom.window.hashrate = { invoke: async () => data };
  for (const file of ["report-chart.js", "reports.js"])
    dom.window.eval(fs.readFileSync("src/ui/" + file, "utf8"));
  const doc = dom.window.document;
  doc.querySelector("#page-reports").hidden = false;
  tick();
  await new Promise((r) => setImmediate(r));
  assert.match(
    doc.querySelector("#investment-total").textContent,
    /500,01 pagos/,
  );
  assert.match(
    doc.querySelector("#investment-status").textContent,
    /02\/10\/2026/,
  );
  const detail = doc.querySelector("#report-investment details");
  detail.open = true;
  tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(detail.open, true);
  dom.window.close();
});
