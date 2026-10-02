const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { JSDOM } = require("jsdom");
const {
  ReportStore,
  dayOf,
  usd,
  accountKey,
  normalize,
  validatePage,
  sumRows,
  range,
  csv,
} = require("../src/reports.cjs");
const { reportScript } = require("../src/reports-dom.cjs");
const { ReportSync } = require("../src/report-sync.cjs");
const raw = (amount, label = "Consumo de hashpower", wallet = "Travado") => ({
  at: "2026-09-27T22:00:00.000Z",
  displayed: "27/09, 19:00",
  amount,
  label,
  wallet,
  order: "HS-TEST",
});
const row = (amount, label, wallet) =>
  normalize("hashsell", raw(amount, label, wallet));
const revenue = normalize("rental", raw("US$ 110,0000", "Crédito horário", ""));
const key =
  accountKey("hashsell", "a@example.com") +
  ":" +
  accountKey("rental", "b@example.com");
const snapshots = () => [
  {
    site: "hashsell",
    complete: true,
    rows: [
      row("−US$ 100,00000000"),
      row("−US$ 3,00000000", "Taxa de consumo"),
      row("+US$ 300,00", "USDT Recarga Creditado"),
    ],
  },
  { site: "rental", complete: true, rows: [revenue] },
];
const store = () =>
  new ReportStore(fs.mkdtempSync(path.join(os.tmpdir(), "reports-test-")));
test("signed USD and eight decimals remain exact", () => {
  assert.equal(usd("−US$ 1.234,12345678"), "-1234.12345678");
  assert.equal(usd("+US$ 0,00000001"), "0.00000001");
  assert.throws(() => usd("US$ 1,234.55"));
});
test("profit uses actual fees once; deposits are separate", () => {
  const t = sumRows(snapshots().flatMap((s) => s.rows));
  assert.equal(t.profit, "7");
  assert.equal(t.deposits, "300");
  assert.equal(t.fees, "3");
});
test("paired reserves and returns do not change profit", () => {
  const transfers = ["Reserva para ordem", "Devolução"].flatMap((label) => [
    row("−US$ 10,00", label, "Disponível"),
    row("+US$ 10,00", label, "Travado"),
  ]);
  assert.equal(sumRows(transfers).profit, "0");
  assert.ok(transfers.every((r) => r.category === "transfer"));
});
test("unidentified refunds and reversed-sign charges stay pending", () => {
  assert.equal(row("+US$ 1,00", "Estorno").category, "unknown");
  assert.equal(row("+US$ 1,00").category, "unknown");
  assert.equal(
    normalize("rental", raw("−US$ 1,00", "Crédito horário")).category,
    "unknown",
  );
});
test("reject ambiguous dates and mismatched timezones", () => {
  assert.throws(() =>
    normalize("hashsell", { ...raw("US$ 1,00"), at: "27/09" }),
  );
  assert.throws(() =>
    normalize("hashsell", { ...raw("US$ 1,00"), displayed: "27/09, 22:00" }),
  );
});
test("daily summary checks hourly credits without double counting", () => {
  const p = {
    rows: [raw("US$ 110,0000", "Crédito horário")],
    checks: [{ day: "2026-09-27", total: "US$ 110,00", count: 1 }],
  };
  assert.equal(sumRows(validatePage("rental", p)).revenue, "110");
  p.checks[0].total = "US$ 220,00";
  assert.throws(() => validatePage("rental", p));
});
test("atomic replacement preserves identical entries and idempotence", () => {
  const s = store(),
    p = snapshots();
  p[0].rows.push({ ...p[0].rows[0] });
  s.commit(key, p, { full: true });
  assert.equal(s.query(key).entries.length, 5);
  s.commit(key, p, { full: true });
  assert.equal(s.query(key).entries.length, 5);
  assert.equal(s.query(key).totals.consumption, "200");
});
test("interrupted import never replaces durable history", () => {
  const s = store();
  s.commit(key, snapshots(), { full: true });
  const before = fs.readFileSync(s.file, "utf8");
  const p = snapshots();
  p[1].complete = false;
  assert.throws(() => s.commit(key, p, { full: true }));
  assert.equal(fs.readFileSync(s.file, "utf8"), before);
});
test("incremental replacement and separate account pairs", () => {
  const s = store();
  s.commit(key, snapshots(), { full: true });
  s.commit(key, snapshots(), { full: false, from: "2026-09-27" });
  assert.equal(s.query(key).entries.length, 4);
  const other =
    accountKey("hashsell", "other@example.com") +
    ":" +
    accountKey("rental", "b@example.com");
  assert.equal(s.query(other).ready, false);
  assert.equal(s.query(null).ready, false);
});
test("filters, partial current day, CSV escaping", () => {
  assert.deepEqual(
    range({ preset: "yesterday" }, Date.parse("2026-09-28T12:00:00Z")),
    { from: "2026-09-27", to: "2026-09-27" },
  );
  assert.throws(() =>
    range({ preset: "custom", from: "2026-02-30", to: "2026-03-01" }),
  );
  const s = store();
  s.commit(key, snapshots(), {
    full: true,
    at: Date.parse("2026-09-27T23:00:00Z"),
  });
  assert.equal(
    s.query(key, {}, Date.parse("2026-09-27T23:00:00Z")).days[0].partial,
    true,
  );
  assert.match(csv({ entries: [{ label: '=HYPERLINK("x")' }] }), /'=HYPERLINK/);
});
const th = (names) =>
  "<thead><tr>" +
  names
    .split("|")
    .map((n) => `<th>${n}</th>`)
    .join("") +
  "</tr></thead>";
test("Hashsell DOM excludes hidden duplicate and reads pagination counter", () => {
  const table =
    "<table>" +
    th("Quando|Lançamento|Carteira|Ordem|Valor") +
    '<tbody><tr><td><time datetime="2026-09-27T22:00:00.000Z">27/09, 19:00</time></td><td>Consumo de hashpower</td><td>Travado</td><td>HS-TEST</td><td>−US$ 1,00000001</td></tr></tbody></table>';
  const dom = new JSDOM(
    `<button aria-label="Conta de teste">a@example.com</button><section><div>${table}</div><div><span>1–1 de 2</span><a href="/wallet?page=2">Próxima</a></div></section><div hidden>${table}</div>`,
    { url: "https://hashsell.com/wallet", runScripts: "outside-only" },
  );
  const result = dom.window.eval(reportScript("hashsell"));
  assert.equal(result.ok, true);
  assert.equal(result.value.rows.length, 1);
  assert.deepEqual([...result.value.counter], [1, 1, 2]);
  assert.equal(result.value.next.page, 2);
});
function rentalFixture() {
  const cells = [
    "19:00",
    "0 TH/s",
    "1 PH/s US$ 110,0000",
    "Connected",
    "US$ 110,0000",
  ].map((v) => ["$", "td", null, { children: v }]);
  cells[1] = "$a";
  const tr = ["$", "tr", "2026-09-27T22:00:00.000Z", { children: cells }];
  const flight =
    "0:" +
    JSON.stringify({
      name: "Test",
      email: "test@example.com",
      status: "ACTIVE",
      children: tr,
    }) +
    "\na:" +
    JSON.stringify(["$", "td", null, { children: "0 TH/s" }]) +
    "\n";
  return `<div hidden><details><summary><span><span>domingo, 27/09</span><span>1 hora</span></span><span>US$ 110,00</span></summary><table>${th("Hora|Direto|Marketplace|Nível|Crédito")}<tbody><tr>${["19:00", "0 TH/s", "1 PH/s US$ 110,0000", "Connected", "US$ 110,0000"].map((v) => "<td>" + v + "</td>").join("")}</tr></tbody></table></details><a href="?extrato=2">2</a><a href="?saques=2">2</a></div><script>self.__next_f.push(${JSON.stringify([1, flight])})</script>`;
}
test("Rental DOM expands days, resolves ISO keys, ignores withdrawal pagination", () => {
  const dom = new JSDOM(rentalFixture(), {
    url: "https://rentalhash.com/painel/financeiro",
    runScripts: "outside-only",
  });
  const r = dom.window.eval(reportScript("rental"));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.rows[0].at, "2026-09-27T22:00:00.000Z");
  assert.equal(
    r.value.next.url,
    "https://rentalhash.com/painel/financeiro?extrato=2",
  );
  assert.equal(dom.window.document.querySelector("details").open, true);
  assert.equal(sumRows(validatePage("rental", r.value)).revenue, "110");
});
test("Rental rejects missing full dates rather than guessing year", () => {
  const dom = new JSDOM(
    rentalFixture().replace("2026-09-27T22:00:00.000Z", "27/09"),
    {
      url: "https://rentalhash.com/painel/financeiro",
      runScripts: "outside-only",
    },
  );
  assert.equal(dom.window.eval(reportScript("rental")).ok, false);
});
test("pagination repetition and account switch reject staged collection", async () => {
  const sync = Object.create(ReportSync.prototype);
  sync.epoch = 0;
  sync.stopped = false;
  sync.monitor = { busy: false };
  sync.page = async () => ({ ...first, current: 2 });
  const first = {
    account: "a",
    rows: [revenue],
    current: 1,
    next: {
      page: 2,
      url: "https://rentalhash.com/painel/financeiro?extrato=2",
    },
  };
  await assert.rejects(
    sync.collect("rental", first, true, null, 0),
    /repetida/,
  );
  sync.page = async () => ({ ...first, current: 2, account: "b" });
  await assert.rejects(
    sync.collect("rental", first, true, null, 0),
    /Conta mudou/,
  );
});
test("report waits for trading cycle without stopping it; cancellation stops wait", async () => {
  const sync = Object.create(ReportSync.prototype);
  sync.monitor = { busy: true };
  sync.epoch = 0;
  sync.stopped = false;
  setTimeout(() => (sync.monitor.busy = false), 10);
  await sync.priority(0);
  assert.equal(sync.monitor.busy, false);
  sync.monitor.busy = true;
  sync.epoch++;
  await assert.rejects(sync.priority(0), /interrompida/);
});
test("expired login cannot commit an import or expose another account", async () => {
  const sync = Object.create(ReportSync.prototype);
  sync.busy = false;
  sync.stopped = false;
  sync.epoch = 0;
  sync.key = null;
  sync.store = store();
  sync.page = async () => {
    throw Error("login expirado");
  };
  assert.equal(await sync.sync(), false);
  assert.match(sync.error, /login expirado/);
  assert.equal(Object.keys(sync.store.data.accounts).length, 0);
});

test("report POST guard preserves editor and visible login handlers", () => {
  const { RequestGuard } = require("../src/request-guard.cjs");
  const handlers = {};
  const webRequest = {};
  for (const event of [
    "onCompleted",
    "onErrorOccurred",
    "onBeforeSendHeaders",
    "onBeforeRequest",
  ])
    webRequest[event] = (cb) => (handlers[event] = cb);
  const guard = new RequestGuard({ id: 1, session: { webRequest } });
  guard.readOnlyIds.add(9);
  let result;
  handlers.onBeforeRequest(
    { webContentsId: 9, method: "POST" },
    (x) => (result = x),
  );
  assert.equal(result.cancel, true);
  handlers.onBeforeRequest(
    { webContentsId: 9, method: "GET" },
    (x) => (result = x),
  );
  assert.notEqual(result.cancel, true);
  handlers.onBeforeRequest(
    { webContentsId: 10, method: "POST" },
    (x) => (result = x),
  );
  assert.notEqual(result.cancel, true);
  assert.equal(typeof handlers.onBeforeSendHeaders, "function");
});

test("display rounding of hourly four decimals and daily two decimals is bounded", () => {
  const p = {
    rows: [raw("US$ 547,4550", "Crédito horário")],
    checks: [{ day: "2026-09-27", total: "US$ 547,45", count: 1 }],
  };
  assert.equal(sumRows(validatePage("rental", p)).revenue, "547.455");
  p.checks[0].total = "US$ 547,44";
  assert.throws(() => validatePage("rental", p));
});

function retryHarness() {
  const sync = Object.create(ReportSync.prototype);
  Object.assign(sync, {
    epoch: 0,
    stopped: false,
    monitor: { busy: false },
    adapter: { readBackoff: new Map() },
  });
  const waits = [];
  sync.waitForRetry = async (ms) => waits.push(ms);
  return { sync, waits };
}
test("404 then 500 reloads the same page and succeeds with progressive waits", async () => {
  const { sync, waits } = retryHarness();
  const seen = [];
  sync.pageOnce = async (site, url) => {
    seen.push(url);
    if (seen.length < 3) throw Error("HTTP " + (seen.length === 1 ? 404 : 500));
    return { current: 4 };
  };
  const result = await sync.page(
    "hashsell",
    "https://hashsell.com/wallet?page=4",
    0,
  );
  assert.equal(result.current, 4);
  assert.deepEqual(waits, [2000, 5000]);
  assert.equal(new Set(seen).size, 1);
});
test("persistent 404 stops after four attempts without infinite retry", async () => {
  const { sync, waits } = retryHarness();
  let calls = 0;
  sync.pageOnce = async () => {
    calls++;
    throw Error("HTTP 404");
  };
  await assert.rejects(
    sync.page("hashsell", "https://hashsell.com/wallet?page=3", 0),
    /página 3: falha após 4 tentativas/,
  );
  assert.equal(calls, 4);
  assert.deepEqual(waits, [2000, 5000, 10000]);
});
test("auth, account and financial validation errors never retry", async () => {
  for (const message of [
    "HTTP 401",
    "HTTP 403",
    "login expirado",
    "Conta mudou durante a importação.",
    "Total diário não confere com os créditos horários.",
    "Data sem ano ou fuso comprovado.",
  ]) {
    const { sync, waits } = retryHarness();
    let calls = 0;
    sync.pageOnce = async () => {
      calls++;
      throw Error(message);
    };
    await assert.rejects(
      sync.page("rental", "https://rentalhash.com/painel/financeiro", 0),
    );
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  }
});
test("HTTP 429 waits for Retry-After instead of rapid reloads", async () => {
  const { sync, waits } = retryHarness();
  sync.adapter.readBackoff.set("hashsell", Date.now() + 120000);
  let calls = 0;
  sync.pageOnce = async () => {
    if (++calls === 1) throw Error("HTTP 429");
    return {};
  };
  await sync.page("hashsell", "https://hashsell.com/wallet", 0);
  assert.equal(calls, 2);
  assert.ok(waits[0] > 119000);
});
test("a long rate limit defers collection without early requests", async () => {
  const { sync, waits } = retryHarness();
  sync.adapter.readBackoff.set("hashsell", Date.now() + 3600000);
  let calls = 0;
  sync.pageOnce = async () => {
    calls++;
    throw Error("HTTP 429");
  };
  await assert.rejects(
    sync.page("hashsell", "https://hashsell.com/wallet", 0),
    /aguarde o prazo/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});
test("network timeout retries but cancellation during backoff stops before a new request", async () => {
  const { sync } = retryHarness();
  let calls = 0;
  sync.pageOnce = async () => {
    calls++;
    throw Error("ERR_CONNECTION_RESET");
  };
  sync.waitForRetry = async () => {
    sync.epoch++;
  };
  await assert.rejects(
    sync.page("hashsell", "https://hashsell.com/wallet", 0),
    /interrompida/,
  );
  assert.equal(calls, 1);
  sync.waitForRetry = ReportSync.prototype.waitForRetry;
  const before = Date.now();
  await assert.rejects(sync.waitForRetry(10000, 0), /interrompida/);
  assert.ok(Date.now() - before < 1000);
});
test("HTTP 200 soft-404 document is detected by its DOM before ledger parsing", async () => {
  const { sync } = retryHarness();
  const dom = new JSDOM(
    "<title>Hashsell</title><h1>404</h1><h2>This page could not be found.</h2>",
    { url: "https://hashsell.com/wallet", runScripts: "outside-only" },
  );
  const wc = {
    id: 99,
    getURL: () => dom.window.location.href,
    mainFrame: { executeJavaScript: async (code) => dom.window.eval(code) },
  };
  sync.views = { hashsell: { webContents: wc } };
  sync.adapter.assertReadAvailable = () => {};
  sync.adapter.navigate = async () => {};
  sync.adapter.readResponses = new Map([[99, { items: [] }]]);
  await assert.rejects(
    sync.pageOnce("hashsell", "https://hashsell.com/wallet", 0),
    (e) => e.status === 404 && e.retryable,
  );
});
test("main-frame 404 is retryable but a missing ancillary script does not reject valid ledger", async () => {
  const { sync } = retryHarness();
  const wc = {
    id: 99,
    getURL: () => "https://hashsell.com/wallet",
    mainFrame: {
      executeJavaScript: async (code) =>
        code.includes("document.title")
          ? false
          : {
              ok: true,
              value: {
                account: "a@example.com",
                rows: [raw("−US$ 1,00")],
                checks: [],
              },
            },
    },
  };
  sync.views = { hashsell: { webContents: wc } };
  sync.adapter.assertReadAvailable = () => {};
  const d = { items: [] };
  sync.adapter.readResponses = new Map([[99, d]]);
  sync.adapter.navigate = async () => {
    d.items = [{ type: "mainFrame", status: 404 }];
  };
  await assert.rejects(
    sync.pageOnce("hashsell", "https://hashsell.com/wallet", 0),
    (e) => e.status === 404,
  );
  sync.adapter.navigate = async () => {
    d.items = [{ type: "script", status: 404 }];
  };
  assert.equal(
    (await sync.pageOnce("hashsell", "https://hashsell.com/wallet", 0)).rows
      .length,
    1,
  );
});
test("page two recovery retains page one and does not duplicate accumulated rows", async () => {
  const { sync } = retryHarness();
  const one = {
    account: "a",
    current: 1,
    rows: [revenue],
    next: {
      page: 2,
      url: "https://rentalhash.com/painel/financeiro?extrato=2",
    },
  };
  const two = {
    account: "a",
    current: 2,
    rows: [{ ...revenue, at: "2026-09-26T22:00:00.000Z", day: "2026-09-26" }],
    next: null,
  };
  let second = 0;
  sync.pageOnce = async (_site, url) => {
    if (url.includes("extrato=2")) {
      if (++second === 1) throw Error("HTTP 404");
      return two;
    }
    return one;
  };
  const result = await sync.collect("rental", one, true, null, 0);
  assert.equal(result.rows.length, 2);
  assert.equal(second, 2);
  assert.equal(result.complete, true);
});

test("navigation preserves snapshot and schedules automatic identity refresh", () => {
  const sync = Object.create(ReportSync.prototype);
  sync.key = "known";
  sync.epoch = 0;
  sync.stopped = false;
  sync.invalidate();
  assert.equal(sync.key, "known");
  assert.equal(sync.epoch, 1);
  assert.ok(sync.refreshTimer);
  clearTimeout(sync.refreshTimer);
});
test("transient read failure preserves displayed account", async () => {
  const sync = Object.create(ReportSync.prototype);
  Object.assign(sync, { key: "known", epoch: 0, busy: false, stopped: false });
  sync.page = async () => {
    throw Error("HTTP 503");
  };
  assert.equal(await sync.sync(), false);
  assert.equal(sync.key, "known");
  sync.page = async () => {
    throw Error("login expirado");
  };
  await sync.sync();
  assert.equal(sync.key, null);
});
test("existing account resumes incrementally from last successful import after offline gap", async () => {
  const sync = Object.create(ReportSync.prototype);
  const last = Date.now() - 5 * 86400000;
  let saved;
  Object.assign(sync, {
    key: "h:r",
    epoch: 0,
    busy: false,
    stopped: false,
    monitor: { busy: false },
    store: {
      data: { accounts: { "h:r": { fullAt: last, updatedAt: last } } },
      commit: (...args) => (saved = args),
    },
  });
  sync.page = async (site) => ({ account: site === "hashsell" ? "h" : "r" });
  sync.collectPayments = async () => ({ at: Date.now(), rows: [] });
  sync.collect = async (site, first, full, from) => {
    assert.equal(full, false);
    assert.equal(from, dayOf(last - 86400000));
    return { site, rows: [], complete: true };
  };
  assert.equal(await sync.sync(), true);
  assert.equal(saved[0], "h:r");
  assert.equal(saved[2].full, false);
});

test("withdrawal fees reduce profit once and remain separate from consumption fees", () => {
  const rows = [
    { category: "revenue", amount: "100" },
    { category: "consumption", amount: "80" * -1 + "" },
    { category: "fees", amount: "-2.40" },
    { category: "fees", feeKind: "withdrawal", amount: "-2" },
  ];
  const t = sumRows(rows);
  assert.equal(t.profit, "15.6");
  assert.equal(t.consumptionFees, "2.4");
  assert.equal(t.withdrawalFees, "2");
  assert.equal(t.fees, "4.4");
});

test("payments DOM reads actual fee and ignores credit pagination", () => {
  const dom = new JSDOM(rentalFixture(), {
    url: "https://rentalhash.com/painel/financeiro?saques=2",
    runScripts: "outside-only",
  });
  dom.window.document.body.insertAdjacentHTML(
    "beforeend",
    '<div><div><div><h2>Histórico de pagamentos</h2></div></div><ul><li><span>Concluído</span><p>28/09/2026, 00:01 · ERC20 · taxa US$ 2,00</p><a href="https://etherscan.io/tx/test">test</a></li></ul></div><a href="?saques=2&extrato=2">2</a>',
  );
  const result = dom.window.eval(reportScript("payments"));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.rows[0].fee, "US$ 2,00");
  assert.equal(result.value.rows[0].day, "2026-09-28");
  assert.equal(result.value.current, 2);
});

test("capital reader uses only available RentalHash balance, excluding pending credits", () => {
  const dom = new JSDOM(rentalFixture(), {
    url: "https://rentalhash.com/painel/financeiro",
    runScripts: "outside-only",
  });
  dom.window.document.body.insertAdjacentHTML(
    "beforeend",
    "<div inert><p>Saldo disponível</p><p><span>US$ 664,19</span></p><div>A creditar + US$ 120,06</div></div>",
  );
  const result = dom.window.eval(reportScript("rental"));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.capital, "US$ 664,19");
  dom.window.document.body.insertAdjacentHTML(
    "beforeend",
    "<p>Saldo disponível</p><p>US$ 1,00</p>",
  );
  assert.equal(dom.window.eval(reportScript("rental")).value.capital, null);
});

test("pending withdrawals do not abort statement sync or create completed fees", async () => {
  const sync = Object.create(ReportSync.prototype);
  const pending = {
    gross: "US$ 102,00",
    day: "2026-09-29",
    fee: "US$ 2,00",
    status: "Processando",
    id: null,
  };
  const completed = {
    day: "2026-09-28",
    fee: "US$ 2,00",
    status: "Concluído",
    id: "completed-tx",
  };
  sync.page = async () => ({
    account: "r",
    current: 1,
    next: null,
    rows: [pending, completed],
  });
  sync.priority = async () => {};
  sync.views = {
    rental: {
      webContents: {
        mainFrame: {
          executeJavaScript: async () => {
            throw Error("Exportação indisponível");
          },
        },
      },
    },
  };
  sync.epoch = 0;
  const result = await sync.collectPayments("r", null, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].amount, "-2.00");
  assert.deepEqual(result.pending, [{ ...pending, net: "100" }]);
});

test("payments DOM reads gross USD separately from the withdrawal fee", () => {
  const dom = new JSDOM(rentalFixture(), {
    url: "https://rentalhash.com/painel/financeiro",
    runScripts: "outside-only",
  });
  dom.window.document.body.insertAdjacentHTML(
    "beforeend",
    "<div><div><div><h2>Histórico de pagamentos</h2></div></div><ul><li><span>US$ 102,12345678</span><span>Processando</span><p>29/09/2026, 23:01 · ERC20 · taxa US$ 2,00</p></li></ul></div>",
  );
  const result = dom.window.eval(reportScript("payments"));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.rows[0].gross, "US$ 102,12345678");
  assert.equal(result.value.rows[0].fee, "US$ 2,00");
  assert.equal(result.value.rows[0].id, null);
});

test("failed payment collection cannot overwrite the prior capital with available balances only", async () => {
  const sync = Object.create(ReportSync.prototype),
    last = Date.now() - 86400000;
  const prior = {
    fullAt: last,
    updatedAt: last,
    capital: { hashsell: "70", rental: "30", at: last },
  };
  Object.assign(sync, {
    epoch: 0,
    busy: false,
    stopped: false,
    monitor: { busy: false },
    store: {
      data: { accounts: { "h:r": prior } },
      commit: () => assert.fail("incomplete collection must not commit"),
      save: () => assert.fail("capital must not be saved before payments"),
    },
  });
  sync.page = async (site) => ({
    account: site === "hashsell" ? "h" : "r",
    capital: "US$ 0,01",
  });
  sync.collect = async (site, first) => ({
    site,
    capital: first.capital,
    rows: [],
    complete: true,
  });
  sync.collectPayments = async () => {
    throw Error("HTTP 503");
  };
  assert.equal(await sync.sync(), false);
  assert.equal(prior.capital.hashsell, "70");
});

test("fresh capital commits pending transfers together and preserves equal withdrawals", async () => {
  const sync = Object.create(ReportSync.prototype),
    last = Date.now() - 86400000;
  let committed;
  Object.assign(sync, {
    epoch: 0,
    busy: false,
    stopped: false,
    monitor: { busy: false },
    store: {
      data: { accounts: { "h:r": { fullAt: last, updatedAt: last } } },
      commit: (...args) => (committed = args),
    },
  });
  sync.page = async (site) => ({
    account: site === "hashsell" ? "h" : "r",
    capital: site === "hashsell" ? "US$ 0,05" : "US$ 0,01",
  });
  sync.collect = async (site, first) => ({
    site,
    capital: first.capital,
    rows: [],
    complete: true,
  });
  sync.collectPayments = async () => ({
    at: Date.now(),
    rows: [],
    pending: [0, 1].map(() => ({
      day: "2026-09-29",
      displayedAt: "29/09/2026, 23:01",
      gross: "US$ 102,12345678",
      fee: "US$ 2,00",
      net: "100.12345678",
    })),
  });
  assert.equal(await sync.sync(), true);
  assert.equal(committed[2].capital.inTransit, "200.24691356");
  assert.equal(committed[2].payments.pending.length, 2);
});

const { accountingEntries } = require("../src/reports.cjs");
test("hour-start credit closes with midnight cost without changing total or stored history", () => {
  const s = store();
  const credit = normalize("rental", {
    at: "2026-09-30T02:00:00.000Z",
    displayed: "29/09, 23:00",
    amount: "US$ 110,0000",
    label: "Crédito horário",
    wallet: "",
    order: "",
  });
  const cost = normalize("hashsell", {
    at: "2026-09-30T03:00:00.000Z",
    displayed: "30/09, 00:00",
    amount: "−US$ 100,00000000",
    label: "Consumo de hashpower",
    wallet: "Travado",
    order: "HS-TEST",
  });
  const fee = {
    ...cost,
    amount: "-3",
    category: "fees",
    label: "Taxa de consumo",
  };
  s.commit(
    key,
    [
      { site: "hashsell", complete: true, rows: [cost, fee] },
      { site: "rental", complete: true, rows: [credit] },
    ],
    { full: true, at: Date.parse("2026-10-01T18:00:00Z") },
  );
  const before = fs.readFileSync(s.file, "utf8"),
    now = Date.parse("2026-10-01T18:00:00Z");
  const all = s.query(key, { preset: "all" }, now);
  assert.equal(all.totals.profit, "7");
  assert.equal(all.days.find((r) => r.day === "2026-09-29").profit, "0");
  assert.equal(all.days.find((r) => r.day === "2026-09-30").profit, "7");
  const returned = all.entries.find((r) => r.site === "rental");
  assert.equal(returned.at, credit.at);
  assert.equal(returned.sourceDay, "2026-09-29");
  assert.equal(returned.reportAt, "2026-09-30T03:00:00.000Z");
  assert.equal(
    s.query(
      key,
      { preset: "custom", from: "2026-09-29", to: "2026-09-29" },
      now,
    ).totals.revenue,
    "0",
  );
  assert.equal(
    s.query(
      key,
      { preset: "custom", from: "2026-09-30", to: "2026-09-30" },
      now,
    ).totals.revenue,
    "110",
  );
  assert.deepEqual(accountingEntries({ entries: all.entries }), all.entries);
  assert.equal(s.query(key, {}, now).totals.profit, "7");
  assert.equal(fs.readFileSync(s.file, "utf8"), before);
  assert.ok(csv(all).includes('"2026-09-30T02:00:00.000Z";"2026-09-29"'));
  assert.ok(csv(all).includes('"2026-09-30";"2026-09-30T03:00:00.000Z"'));
});
test("month and year closing boundaries leave deposits, transfers and fees unchanged", () => {
  const credit = {
    site: "rental",
    category: "revenue",
    label: "Crédito horário",
    at: "2027-01-01T02:00:00.000Z",
    day: "2026-12-31",
    amount: "10",
  };
  const deposit = {
    ...credit,
    site: "hashsell",
    category: "deposits",
    amount: "200",
  };
  const transfer = { ...deposit, category: "transfer", amount: "-200" };
  const fee = {
    ...credit,
    category: "fees",
    feeKind: "withdrawal",
    amount: "-2",
  };
  const result = accountingEntries({
    entries: [credit, deposit, transfer],
    payments: { rows: [fee] },
  });
  assert.equal(result[0].day, "2027-01-01");
  assert.deepEqual(result.slice(1), [deposit, transfer, fee]);
  assert.equal(sumRows(result).profit, "8");
  assert.equal(
    sumRows(result.filter((r) => r.day === "2026-12-31")).profit,
    "-2",
  );
});
test("unexpected or invalid hour-start dates remain unshifted and unconfirmed", () => {
  for (const at of [
    "2026-09-30T02:15:00.000Z",
    "2026-02-30T02:00:00.000Z",
    "30/09",
  ]) {
    const original = {
      site: "rental",
      category: "revenue",
      label: "Crédito horário",
      at,
      day: "2026-09-29",
      amount: "10",
    };
    const [result] = accountingEntries({ entries: [original] });
    assert.equal(result.day, original.day);
    assert.equal(result.at, original.at);
    assert.equal(result.reportAt, undefined);
    assert.equal(result.periodUnconfirmed, true);
  }
});

test("partial closing before midnight aligns both consumption and fees with the worked hour", () => {
  const credit = {
    site: "rental",
    category: "revenue",
    label: "Crédito horário",
    at: "2026-09-28T02:00:00.000Z",
    day: "2026-09-27",
    amount: "110",
  };
  const cost = {
    site: "hashsell",
    category: "consumption",
    label: "Consumo de hashpower",
    at: "2026-09-28T02:41:00.000Z",
    day: "2026-09-27",
    amount: "-100",
  };
  const fee = {
    ...cost,
    category: "fees",
    label: "Taxa de consumo",
    amount: "-3",
  };
  const original = [credit, cost, fee],
    before = JSON.stringify(original);
  const result = accountingEntries({ entries: original });
  assert.ok(result.every((r) => r.day === "2026-09-28"));
  assert.ok(result.every((r) => r.reportAt === "2026-09-28T03:00:00.000Z"));
  assert.equal(result[1].at, cost.at);
  assert.equal(sumRows(result).profit, "7");
  assert.equal(JSON.stringify(original), before);
});
