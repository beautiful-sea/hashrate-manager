const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Store } = require("../src/store.cjs");
const { Monitor } = require("../src/monitor.cjs");
const { DEFAULTS } = require("../src/config.cjs");
const { CREATION_DEFAULTS } = require("../src/order-creation.cjs");
const {
  quotePayload,
  formPayload,
  CreationGuard,
  CREATE_ACTION,
} = require("../src/creation-guard.cjs");
const account = "a".repeat(64),
  destination = "11111111-1111-4111-8111-111111111111",
  key = "22222222-2222-4222-8222-222222222222";
const policy = {
  ...CREATION_DEFAULTS,
  enabled: true,
  account,
  destination,
  amount: "25",
  minimumBalance: "5",
  speedPH: "1",
};
const grant = () => ({
  account,
  destination,
  amount: "25",
  available: "100",
  debit: "25",
  speedPH: "1",
  bid: "39.45",
  ceiling: "39.66",
  tick: "0.01",
  key,
  expiresAt: Date.now() + 5000,
  href: "https://hashsell.com/orders/new",
  isCurrent: () => true,
  fields: {
    unit: "PH",
    type: "STANDARD",
    poolId: destination,
    limit: "1.0000",
    price: "39.4500",
    amount: "25.00",
    idempotencyKey: key,
  },
});
function multipart(g, changes = {}) {
  const fields = Object.fromEntries(
    Object.entries(g.fields).map(([k, v]) => ["_1_" + k, v]),
  );
  fields["0"] = JSON.stringify([{ status: "idle" }, "$K1"]);
  Object.assign(fields, changes);
  return Buffer.from(
    Object.entries(fields)
      .map(
        ([k, v]) =>
          '--BOUNDARY\r\nContent-Disposition: form-data; name="' +
          k +
          '"\r\n\r\n' +
          v +
          "\r\n",
      )
      .join("") + "--BOUNDARY--\r\n",
  );
}
test("creation transport blocks changed amounts, 1000x units, destination, keys, duplicates, expiry and unknown actions", () => {
  const g = grant();
  const d = {
    method: "POST",
    url: g.href,
    uploadData: [{ bytes: multipart(g) }],
  };
  assert.equal(formPayload(d, g).boundary, "BOUNDARY");
  for (const change of [
    { _1_amount: "1000" },
    { _1_price: "39450" },
    { _1_limit: "1000" },
    { _1_unit: "EH" },
    { _1_type: "FIXED" },
    { _1_poolId: key },
    { _1_idempotencyKey: "" },
    { extra: "evil" },
    { 0: "[]" },
  ])
    assert.throws(() =>
      formPayload({ ...d, uploadData: [{ bytes: multipart(g, change) }] }, g),
    );
  assert.throws(() => formPayload(d, { ...g, expiresAt: Date.now() - 1 }));
  assert.throws(() =>
    formPayload({ ...d, url: "https://hashsell.com/orders/HS-OTHER" }, g),
  );
  const guard = new CreationGuard({ getURL: () => g.href });
  guard.arm(g, "save");
  let verdict;
  guard.beforeRequest({ ...d, id: 1 }, (r) => (verdict = r));
  assert.deepEqual(verdict, {});
  guard.beforeHeaders(
    {
      ...d,
      id: 1,
      requestHeaders: {
        "Next-Action": "unknown",
        "Content-Type": "multipart/form-data; boundary=BOUNDARY",
      },
    },
    (r) => (verdict = r),
  );
  assert.equal(verdict.cancel, true);
  assert.equal(guard.receipt.admitted, false);
  const q = {
    type: "STANDARD",
    poolId: destination,
    priceScaled: "3945000",
    limitHash: "1000000000",
    amountUsd: "25.00",
  };
  assert.deepEqual(
    quotePayload(
      {
        url: "https://hashsell.com/api/proxy/orders/quote",
        method: "POST",
        uploadData: [{ bytes: Buffer.from(JSON.stringify(q)) }],
      },
      g,
    ),
    q,
  );
  assert.throws(() =>
    quotePayload(
      {
        url: "https://hashsell.com/api/proxy/orders/quote",
        method: "POST",
        uploadData: [
          { bytes: Buffer.from(JSON.stringify({ ...q, amountUsd: "500" })) },
        ],
      },
      g,
    ),
  );
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "creation-flow-"));
  const store = new Store(dir);
  store.saveConfig({ ...structuredClone(DEFAULTS), creation: policy });
  let wallet = "100";
  const at = () => Date.now();
  const adapter = {
    calls: 0,
    read: async (k) =>
      k === "rental"
        ? { at: at(), rate: "43" }
        : k === "market"
          ? { at: at(), cut: "39.4" }
          : { at: at(), account, items: [] },
    creation: {
      wallet: async () => ({ at: at(), account, available: wallet }),
      options: async () => ({
        account,
        pools: [{ id: destination, name: "Pool test" }],
      }),
      prepare: async (p, c, key) => ({ plan: p, debit: p.amount, key }),
      submit: async function () {
        adapter.calls++;
        throw Object.assign(Error("Unknown response"), {
          receipt: { admitted: true },
        });
      },
      reconcile: async () => null,
      guard: { cancel() {} },
    },
  };
  const m = new Monitor(store, adapter);
  return { dir, store, m, adapter, setWallet: (v) => (wallet = v) };
}
test("uncertain creation survives restart and never repeats; other known orders remain eligible for adjustment", async () => {
  const f = fixture();
  try {
    await f.m.startAutomatic();
    assert.equal(f.adapter.calls, 1);
    const pending = f.store.state.creations.pending[account];
    assert.equal(pending.phase, "uncertain");
    assert.equal(pending.amount, "25");
    assert.equal(
      new Store(f.dir).state.creations.pending[account].key,
      pending.key,
    );
    await f.m.tick();
    assert.equal(f.adapter.calls, 1);
    const known = f.m.creation.adjustmentPending({
      account,
      items: [{ id: "HS-NEW" }, { id: "HS-EXISTING" }],
    });
    assert.ok(known["HS-NEW"]);
    pending.beforeIds.push("HS-EXISTING");
    assert.equal(
      f.m.creation.adjustmentPending({
        account,
        items: [{ id: "HS-EXISTING" }],
      })["HS-EXISTING"],
      undefined,
    );
    assert.equal(f.m.mode, "live");
  } finally {
    f.m.stop();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
test("changing balance or margin during preparation creates no intent or financial submission", async () => {
  for (const kind of ["wallet", "rate", "stop"]) {
    const f = fixture();
    try {
      f.adapter.creation.prepare = async (p, c, key) => {
        if (kind === "wallet") f.setWallet("2");
        if (kind === "rate")
          f.adapter.read = async (k) =>
            k === "rental"
              ? { at: Date.now(), rate: "30" }
              : k === "market"
                ? { at: Date.now(), cut: "39.4" }
                : { at: Date.now(), account, items: [] };
        if (kind === "stop") f.m.stop();
        return { plan: p, debit: p.amount, key };
      };
      await f.m.startAutomatic();
      assert.equal(f.adapter.calls, 0);
      assert.deepEqual(f.store.state.creations?.pending || {}, {});
    } finally {
      f.m.stop();
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  }
});
test("creation confirmation rejects wrong account, pool, initial funding and existing IDs", () => {
  const f = fixture();
  try {
    const p = { action: "create", ...policy, bid: "39.45" };
    const intent = f.store.creationIntent(p, ["HS-OLD"], key);
    f.store.creationOutcome(intent, "dispatching");
    const e = {
      account,
      id: "HS-NEW",
      href: "https://hashsell.com/orders/HS-NEW",
      poolId: destination,
      type: "STANDARD",
      checkedAt: Date.now(),
      createdAt: new Date().toISOString(),
      priceScaled: "3945000",
      limitHash: "1000000000",
      amountUsd: "25.00000000",
    };
    for (const change of [
      { account: "other" },
      { poolId: key },
      { amountUsd: "26" },
      { priceScaled: "3945000000" },
      { id: "HS-OLD", href: "https://hashsell.com/orders/HS-OLD" },
    ])
      assert.throws(() => f.store.confirmCreation(intent, { ...e, ...change }));
    assert.ok(f.store.state.creations.pending[account]);
    f.store.confirmCreation(intent, e);
    assert.equal(f.store.state.creations.pending[account], undefined);
    assert.equal(f.store.state.history.at(-1).type, "creation-confirmed");
  } finally {
    f.m.stop();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a creation grant admits only one native request and one headers callback", () => {
  const g = grant(),
    guard = new CreationGuard({ getURL: () => g.href });
  const d = {
    id: 10,
    method: "POST",
    url: g.href,
    uploadData: [{ bytes: multipart(g) }],
    requestHeaders: {
      "Next-Action": CREATE_ACTION,
      "Content-Type": "multipart/form-data; boundary=BOUNDARY",
    },
  };
  let r;
  guard.arm(g, "save");
  guard.beforeRequest(d, (v) => (r = v));
  assert.deepEqual(r, {});
  guard.beforeHeaders(d, (v) => (r = v));
  assert.deepEqual(r, {});
  assert.equal(guard.receipt.admitted, true);
  guard.beforeHeaders(d, (v) => (r = v));
  assert.equal(r.cancel, true);
  guard.beforeRequest({ ...d, id: 11 }, (v) => (r = v));
  assert.equal(r.cancel, true);
  assert.equal(guard.receipt.admitted, true);
});

test("creation evidence is checked one page per cycle and never confirms an incomplete scan", async () => {
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  const a = Object.create(CreationAdapter.prototype);
  let calls = 0;
  const intent = {
    account,
    key,
    beforeIds: [],
    at: Date.now(),
    destination,
    bid: "39.45",
    speedPH: "1",
    amount: "25",
  };
  const orders = {
    account,
    items: [
      { id: "HS-NEW1", href: "one" },
      { id: "HS-NEW2", href: "two" },
    ],
  };
  a.readPage = async (k, url) => {
    calls++;
    return {
      account,
      type: "STANDARD",
      poolId: destination,
      createdAt: new Date().toISOString(),
      priceScaled: url === "one" ? "3945000" : "3900000",
      limitHash: "1000000000",
      amountUsd: "25.00000000",
    };
  };
  assert.equal(await a.reconcile(intent, orders), null);
  assert.equal(calls, 1);
  assert.equal((await a.reconcile(intent, orders)).id, "HS-NEW1");
  assert.equal(calls, 2);
  a.readPage = async () => {
    throw Error("temporary failure");
  };
  assert.equal(await a.reconcile(intent, orders), null);
  assert.equal(await a.reconcile(intent, orders), null);
});

test("creation reader recovers the global site error without an account shell or main", () => {
  const { JSDOM } = require("jsdom");
  const { creationScript } = require("../src/creation-dom.cjs");
  const dom = new JSDOM(
    "<div>Não foi possível carregar esta tela<button>Tentar de novo</button></div>",
    { url: "https://hashsell.com/orders/new", runScripts: "outside-only" },
  );
  let retries = 0;
  dom.window.document.querySelector("button").onclick = () => retries++;
  const read = dom.window.eval(creationScript("options"));
  assert.equal(read.ok, false);
  assert.match(read.error, /Hashsell não conseguiu carregar/);
  const recovered = dom.window.eval(creationScript("recover"));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.value.recovered, true);
  assert.equal(retries, 1);
  dom.window.document.querySelector("button").disabled = true;
  assert.equal(
    dom.window.eval(creationScript("recover")).value.recovered,
    false,
  );
  dom.window.close();
});

test("creation options waits for the document and hydrates without another navigation", async () => {
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  const response = { since: Infinity, items: [{ status: 500 }] };
  let href = "https://hashsell.com/market",
    navigations = 0,
    reads = 0;
  const reader = {
    views: { creation: { webContents: { id: 42, getURL: () => href } } },
    adapter: {
      readResponses: new Map([[42, response]]),
      assertReadAvailable() {},
      async navigate(wc, url, site, timeout, readOnly) {
        navigations++;
        assert.equal(url, "https://hashsell.com/market");
        assert.equal(readOnly, true);
        assert.ok(timeout <= 20000);
      },
    },
    async run(wc, mode) {
      if (mode === "recover") return { recovered: false };
      if (mode === "navigateOrders") {
        href = "https://hashsell.com/orders";
        return { account: "test", navigated: true };
      }
      if (mode === "navigateCreation") {
        href = "https://hashsell.com/orders/new";
        return { account: "test", navigated: true };
      }
      if (++reads === 1) throw Error("Formulário de criação indisponível.");
      return { account: "test", pools: [{ id: "saved-pool" }] };
    },
  };
  const result = await CreationAdapter.prototype.readPage.call(
    reader,
    "creation",
    "https://hashsell.com/orders/new",
    "options",
  );
  assert.equal(navigations, 1);
  assert.equal(reads, 2);
  assert.ok(Number.isFinite(response.since));
  assert.equal(response.items.length, 0);
  assert.equal(result.pools.length, 1);
});

test("creation page rate limit stops recovery and never reloads early", async () => {
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  let navigations = 0,
    limited = false;
  const reader = {
    views: { creation: { webContents: { id: 42 } } },
    adapter: {
      assertReadAvailable() {
        if (limited) throw Error("HTTP 429: aguarde");
      },
      async navigate() {
        navigations++;
        limited = true;
      },
    },
    async run() {
      throw Error("Leitura não deveria ocorrer");
    },
  };
  await assert.rejects(
    CreationAdapter.prototype.readPage.call(
      reader,
      "creation",
      "https://hashsell.com/orders/new",
      "options",
    ),
    /HTTP 429/,
  );
  assert.equal(navigations, 1);
});

test("creation navigation uses only the native new-order link and never submits", () => {
  const { JSDOM } = require("jsdom");
  const { creationScript } = require("../src/creation-dom.cjs");
  const dom = new JSDOM(
    '<button aria-label="Conta de test@example.com"></button><a href="/orders/new">Nova ordem</a><form><button>Criar ordem</button></form>',
    { url: "https://hashsell.com/orders", runScripts: "outside-only" },
  );
  let links = 0,
    submits = 0;
  dom.window.document.querySelector("a").onclick = (event) => {
    event.preventDefault();
    links++;
  };
  dom.window.document.querySelector("form").onsubmit = (event) => {
    event.preventDefault();
    submits++;
  };
  const result = dom.window.eval(creationScript("navigateCreation"));
  assert.equal(result.ok, true);
  assert.equal(links, 1);
  assert.equal(submits, 0);
  dom.window.document
    .querySelector("a")
    .setAttribute("href", "https://other.example/orders/new");
  assert.equal(dom.window.eval(creationScript("navigateCreation")).ok, false);
  assert.equal(links, 1);
  dom.window.close();
});

test("creation recovers the entry error once and traverses both native routes without any submission", async () => {
  const { JSDOM } = require("jsdom");
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  const dom = new JSDOM(
    "<div>Não foi possível carregar esta tela<button>Tentar de novo</button></div>",
    { url: "https://hashsell.com/market", runScripts: "outside-only" },
  );
  const identity = '<button aria-label="Conta de test@example.com"></button>';
  let recoveries = 0,
    orderLinks = 0,
    newLinks = 0,
    submissions = 0,
    navigations = 0;
  dom.window.document.querySelector("button").onclick = () => {
    recoveries++;
    dom.window.setTimeout(() => {
      dom.window.document.body.innerHTML =
        identity +
        '<nav><a href="/orders">Ordens</a></nav><main>Não foi possível carregar esta tela</main>';
      dom.window.document.querySelector("a").onclick = (event) => {
        event.preventDefault();
        orderLinks++;
        dom.window.history.replaceState(null, "", "/orders");
        dom.window.document.body.innerHTML =
          identity +
          '<a href="/orders/new">Nova ordem</a><main>Não foi possível carregar esta tela</main>';
        dom.window.document.querySelector("a").onclick = (event) => {
          event.preventDefault();
          newLinks++;
          dom.window.history.replaceState(null, "", "/orders/new");
          dom.window.document.body.innerHTML =
            identity +
            '<form method="post"><select name="poolId"><option value="saved-pool">Pool</option></select><div data-slot="field" role="group"><input type="hidden" name="amount" value="25.00000000"><p data-slot="field-description">Sai da carteira: US$25,00 (US$25,00 + US$0,00000000 de taxa de criação)</p></div><dl><dt>Taxa de criação</dt><dd>–</dd></dl><button>Criar ordem</button></form>';
          dom.window.document.querySelector("form").onsubmit = (event) => {
            event.preventDefault();
            submissions++;
          };
        };
      };
    }, 350);
  };
  const wc = {
    id: 42,
    getURL: () => dom.window.location.href,
    executeJavaScript: async (code) => dom.window.eval(code),
  };
  const reader = {
    views: { creation: { webContents: wc } },
    adapter: {
      assertReadAvailable() {},
      async navigate(contents, url) {
        navigations++;
        assert.equal(contents, wc);
        assert.equal(url, "https://hashsell.com/market");
      },
    },
    run: CreationAdapter.prototype.run,
  };
  try {
    const result = await CreationAdapter.prototype.readPage.call(
      reader,
      "creation",
      "https://hashsell.com/orders/new",
      "options",
      undefined,
      1,
    );
    assert.equal(recoveries, 1);
    assert.equal(orderLinks, 1);
    assert.equal(newLinks, 1);
    assert.equal(navigations, 1);
    assert.equal(submissions, 0);
    assert.equal(result.pools[0].id, "saved-pool");
    assert.equal(result.creationFeeUsd, "0.00000000");
  } finally {
    dom.window.close();
  }
});

test("creation recovery on entry respects a new rate limit before retrying the route", async () => {
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  let recoveries = 0,
    routes = 0,
    navigations = 0,
    limited = false;
  const reader = {
    views: { creation: { webContents: { id: 42 } } },
    adapter: {
      assertReadAvailable() {
        if (limited) throw Error("HTTP 429: aguarde");
      },
      async navigate() {
        navigations++;
      },
    },
    async run(wc, mode) {
      if (mode === "recover") {
        recoveries++;
        limited = true;
        return { recovered: true };
      }
      routes++;
      throw Error("Navegação não deveria ocorrer");
    },
  };
  await assert.rejects(
    CreationAdapter.prototype.readPage.call(
      reader,
      "creation",
      "https://hashsell.com/orders/new",
      "options",
    ),
    /HTTP 429/,
  );
  assert.equal(recoveries, 1);
  assert.equal(routes, 1);
  assert.equal(navigations, 1);
});

function creationOptionsDOM(
  summary,
  extra = "",
  description = "Sai da carteira: US$25,00 (US$25,00 + US$0,00 de taxa de criação)",
) {
  const { JSDOM } = require("jsdom");
  return new JSDOM(
    '<button aria-label="Conta de test@example.com"></button>' +
      '<form method="post"><select name="poolId"><option value="saved-pool">Pool</option></select><dl>' +
      summary +
      '</dl><div data-slot="field" role="group"><input type="hidden" name="amount" value="25.00000000"><p data-slot="field-description"><span>Mínimo: US$5,00. Fica na carteira.</span>' +
      description +
      "</p></div></form>" +
      extra,
    { url: "https://hashsell.com/orders/new", runScripts: "outside-only" },
  );
}
test("creation options reads only the form fee after client navigation without inline metadata", () => {
  const { creationScript } = require("../src/creation-dom.cjs");
  const dom = creationOptionsDOM(
    '<dt><button type="button">Taxa de criação</button></dt><dd>US$ 0,00</dd>',
    "<dl><dt>Taxa de criação</dt><dd>US$ 99,00</dd></dl>",
  );
  try {
    dom.window.history.replaceState(null, "", "/orders");
    dom.window.history.replaceState(null, "", "/orders/new");
    assert.equal(dom.window.document.querySelectorAll("script").length, 0);
    const result = dom.window.eval(creationScript("options"));
    assert.equal(result.ok, true);
    assert.equal(result.value.creationFeeUsd, "0.00");
    assert.equal(result.value.pools[0].id, "saved-pool");
  } finally {
    dom.window.close();
  }
});
test("creation options preserves all fee decimal digits and ignores hidden or inert labels", async () => {
  const { creationScript } = require("../src/creation-dom.cjs");
  const dom = creationOptionsDOM(
    "<div hidden><dt>Taxa de criação</dt><dd>US$ 99,00</dd></div>" +
      "<div inert><dt>Taxa de criação</dt><dd>US$ 88,00</dd></div>" +
      '<dt><button type="button">Taxa de criação</button></dt><dd>US$ 1.234.567,00000001987654321</dd>',
    "",
    "Sai da carteira: US$1.234.592,00000001987654321 (US$25,00 + US$1.234.567,00000001987654321 de taxa de criação)",
  );
  try {
    const result = dom.window.eval(creationScript("options"));
    assert.equal(result.ok, true);
    assert.equal(result.value.creationFeeUsd, "1234567.00000001987654321");
    const { CreationAdapter } = require("../src/creation-adapter.cjs");
    const options = await CreationAdapter.prototype.options.call({
      readPage: async () => result.value,
    });
    assert.equal(options.creationFeeUsd, "1234567.00000001987654321");
    assert.equal(Object.hasOwn(options, "feeSummary"), false);
  } finally {
    dom.window.close();
  }
});
test("creation options rejects missing, duplicate, hidden, malformed or nonnumeric fees", () => {
  const { creationScript } = require("../src/creation-dom.cjs");
  for (const summary of [
    "",
    "<dt>Taxa de criação</dt>",
    "<dt>Taxa de criação</dt><span>US$ 0,00</span>",
    "<dt>Taxa de criação</dt><dd hidden>US$ 0,00</dd>",
    "<dt>Taxa de criação</dt><dd inert>US$ 0,00</dd>",
    "<dt>Taxa de criação</dt><dd>US$ 0,00</dd><dt>Taxa de criação</dt><dd>US$ 1,00</dd>",
    "<dt>Taxa de criação</dt><dd>Grátis</dd>",
    "<dt>Taxa de criação</dt><dd>US$ -1,00</dd>",
    "<dt>Taxa de criação</dt><dd>US$ 1.23</dd>",
    "<dt>Taxa de criação</dt><dd>US$ 1,2,3</dd>",
  ]) {
    const dom = creationOptionsDOM(summary);
    try {
      const result = dom.window.eval(creationScript("options"));
      assert.equal(result.ok, false, summary);
      assert.match(result.error, /taxa de criação/i);
    } finally {
      dom.window.close();
    }
  }
});

test("creation navigation waits for the native click handler and removes its temporary listener", () => {
  const { JSDOM } = require("jsdom");
  const { creationScript } = require("../src/creation-dom.cjs");
  const dom = new JSDOM(
    '<button aria-label="Conta de test@example.com"></button><a href="/orders/new">Nova ordem</a><form><button>Criar ordem</button></form>',
    { url: "https://hashsell.com/orders", runScripts: "outside-only" },
  );
  let event,
    clientRoutes = 0,
    submissions = 0;
  const link = dom.window.document.querySelector("a");
  link.addEventListener("click", (e) => {
    event = e;
  });
  dom.window.document.querySelector("form").onsubmit = (e) => {
    e.preventDefault();
    submissions++;
  };
  try {
    const beforeHydration = dom.window.eval(creationScript("navigateCreation"));
    assert.equal(beforeHydration.ok, true);
    assert.equal(beforeHydration.value.navigated, false);
    assert.equal(event.defaultPrevented, true);
    link.onclick = (e) => {
      e.preventDefault();
      clientRoutes++;
    };
    const afterHydration = dom.window.eval(creationScript("navigateCreation"));
    assert.equal(afterHydration.ok, true);
    assert.equal(afterHydration.value.navigated, true);
    assert.equal(clientRoutes, 1);
    assert.equal(submissions, 0);
    link.onclick = null;
    let retainedPrevention;
    dom.window.addEventListener(
      "click",
      (e) => {
        retainedPrevention = e.defaultPrevented;
        e.preventDefault();
      },
      { once: true },
    );
    link.click();
    assert.equal(retainedPrevention, false);
  } finally {
    dom.window.close();
  }
});
test("creation navigation does not assume hydration when click propagation stops", () => {
  const { JSDOM, VirtualConsole } = require("jsdom");
  const { creationScript } = require("../src/creation-dom.cjs");
  const dom = new JSDOM(
    '<button aria-label="Conta de test@example.com"></button><a href="/orders/new">Nova ordem</a>',
    {
      url: "https://hashsell.com/orders",
      runScripts: "outside-only",
      virtualConsole: new VirtualConsole(),
    },
  );
  let event;
  dom.window.document.querySelector("a").onclick = (e) => {
    event = e;
    e.stopPropagation();
  };
  try {
    const result = dom.window.eval(creationScript("navigateCreation"));
    assert.equal(result.ok, true);
    assert.equal(result.value.navigated, false);
    assert.equal(event.defaultPrevented, false);
    assert.equal(Object.hasOwn(event, "stopPropagation"), false);
  } finally {
    dom.window.close();
  }
});
test("creation routing polls hydration on both native links before reading options", async () => {
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  let href = "https://hashsell.com/market",
    navigations = 0,
    orderRoutes = 0,
    newRoutes = 0,
    reads = 0;
  const reader = {
    views: { creation: { webContents: { id: 42, getURL: () => href } } },
    adapter: {
      assertReadAvailable() {},
      async navigate() {
        navigations++;
      },
    },
    async run(wc, mode) {
      if (mode === "recover") return { recovered: false };
      if (mode === "navigateOrders") {
        orderRoutes++;
        if (orderRoutes === 1) return { account: "test", navigated: false };
        href = "https://hashsell.com/orders";
        return { account: "test", navigated: true };
      }
      if (mode === "navigateCreation") {
        newRoutes++;
        if (newRoutes === 1) return { account: "test", navigated: false };
        href = "https://hashsell.com/orders/new";
        return { account: "test", navigated: true };
      }
      assert.equal(href, "https://hashsell.com/orders/new");
      reads++;
      return {
        account: "test",
        pools: [{ id: "saved-pool" }],
        creationFeeUsd: "0.00",
      };
    },
  };
  const result = await CreationAdapter.prototype.readPage.call(
    reader,
    "creation",
    "https://hashsell.com/orders/new",
    "options",
  );
  assert.equal(navigations, 1);
  assert.equal(orderRoutes, 2);
  assert.equal(newRoutes, 2);
  assert.equal(reads, 1);
  assert.equal(result.pools[0].id, "saved-pool");
});

test("creation guard diagnostics retain only twenty sanitized POST refusals without payloads or headers", () => {
  const guard = new CreationGuard({
    getURL: () => "https://hashsell.com/orders/new",
  });
  for (let i = 0; i < 25; i++) {
    guard.beforeRequest(
      {
        id: i,
        method: "POST",
        url: "https://url-user:url-password@hashsell.com/api/proxy/orders/quote?token=query-secret#fragment-secret",
        uploadData: [{ bytes: Buffer.from("body-secret") }],
        requestHeaders: { Authorization: "header-secret" },
      },
      (result) => assert.equal(result.cancel, true),
    );
  }
  const records = guard.diagnostics();
  assert.equal(records.length, 20);
  assert.deepEqual(records[0], {
    method: "POST",
    pathname: "/api/proxy/orders/quote",
    phase: "none",
    reason: "Página mudou.",
  });
  assert.doesNotMatch(JSON.stringify(records), /secret|url-user|url-password/);
  records[0].reason = "external mutation";
  assert.equal(guard.diagnostics()[0].reason, "Página mudou.");
  guard.beforeRequest(
    { method: "GET", url: "https://hashsell.com/orders" },
    (result) => assert.equal(result.cancel, undefined),
  );
  assert.equal(guard.diagnostics().length, 20);
  guard.resetDiagnostics();
  assert.deepEqual(guard.diagnostics(), []);
});
test("creation guard diagnostics do not echo parser errors and leave valid preview authorization unchanged", () => {
  const g = grant();
  const guard = new CreationGuard({ getURL: () => g.href });
  guard.arm(g, "preview");
  guard.beforeRequest(
    {
      id: 1,
      method: "POST",
      url: "https://hashsell.com/api/proxy/orders/quote",
      uploadData: [
        { bytes: Buffer.from('{"value":"parser-body-secret",invalid}') },
      ],
      requestHeaders: { Cookie: "cookie-secret" },
    },
    (result) => assert.equal(result.cancel, true),
  );
  assert.equal(guard.diagnostics()[0].reason, "Validação da criação recusada.");
  assert.equal(guard.diagnostics()[0].phase, "preview");
  assert.doesNotMatch(
    JSON.stringify(guard.diagnostics()),
    /secret|Cookie|value/,
  );
  const payload = {
    type: "STANDARD",
    poolId: g.destination,
    priceScaled: "3945000",
    limitHash: "1000000000",
    amountUsd: "25",
  };
  guard.beforeRequest(
    {
      id: 2,
      method: "POST",
      url: "https://hashsell.com/api/proxy/orders/quote",
      uploadData: [{ bytes: Buffer.from(JSON.stringify(payload)) }],
    },
    (result) => assert.equal(result.cancel, undefined),
  );
  assert.equal(guard.diagnostics().length, 1);
  guard.beforeHeaders(
    {
      id: 99,
      method: "POST",
      url: g.href + "?query=query-secret",
      requestHeaders: { Authorization: "header-secret" },
    },
    (result) => assert.equal(result.cancel, true),
  );
  assert.equal(
    guard.diagnostics()[1].reason,
    "Envio cancelado ou já autorizado uma vez.",
  );
  assert.doesNotMatch(
    JSON.stringify(guard.diagnostics()),
    /secret|Authorization/,
  );
});
test("creation read failure diagnostics include stage and safe current page with only HTTP and refusal summaries", async () => {
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  const wc = {
    id: 42,
    getURL: () =>
      "https://url-user:url-password@hashsell.com/orders/new?token=query-secret#fragment-secret",
  };
  const guard = new CreationGuard(wc);
  const response = { since: Infinity, items: [] };
  let resets = 0;
  const reset = guard.resetDiagnostics.bind(guard);
  guard.resetDiagnostics = () => {
    resets++;
    reset();
  };
  const reader = {
    guard,
    views: { creation: { webContents: wc } },
    adapter: {
      readResponses: new Map([[42, response]]),
      assertReadAvailable() {},
      async navigate() {
        response.items.push({
          type: "mainFrame",
          status: 500,
          url: "query-secret",
          body: "body-secret",
        });
        guard.beforeRequest(
          {
            id: 1,
            method: "POST",
            url: "https://hashsell.com/api/proxy/orders/quote?token=query-secret",
            uploadData: [{ bytes: Buffer.from("body-secret") }],
          },
          (result) => assert.equal(result.cancel, true),
        );
        throw Error("Falha no documento.");
      },
    },
  };
  await assert.rejects(
    CreationAdapter.prototype.readPage.call(
      reader,
      "creation",
      "https://hashsell.com/orders/new",
      "options",
      undefined,
      1,
    ),
    (error) => {
      assert.deepEqual(error.diagnostics, {
        stage: "entry-navigation",
        lastReadError: null,
        page: { origin: "https://hashsell.com", pathname: "/orders/new" },
        responseSummary: "mainFrame HTTP 500",
        guardRefusals: [
          {
            method: "POST",
            pathname: "/api/proxy/orders/quote",
            phase: "none",
            reason: "Página mudou.",
          },
        ],
      });
      assert.doesNotMatch(
        JSON.stringify(error.diagnostics),
        /secret|url-user|url-password/,
      );
      return true;
    },
  );
  assert.equal(resets, 1);
});
test("creation option failure diagnostics persist locally and never enter UI snapshots or the public error", async () => {
  const f = fixture();
  const diagnostics = {
    stage: "options",
    page: { origin: "https://hashsell.com", pathname: "/orders/new" },
    responseSummary: "mainFrame HTTP 200",
    guardRefusals: [
      {
        method: "POST",
        pathname: "/api/proxy/orders/quote",
        phase: "none",
        reason: "Página mudou.",
      },
    ],
  };
  let cancellations = 0;
  const states = [];
  f.adapter.creation.guard.cancel = () => cancellations++;
  f.adapter.creation.options = async () => {
    throw Object.assign(
      Error("A Hashsell não conseguiu carregar esta página."),
      {
        diagnostics,
        privateBody: "body-secret",
        privateHeaders: { Cookie: "cookie-secret" },
      },
    );
  };
  f.m.on("state", (state) => states.push(state));
  try {
    await assert.rejects(f.m.creationOptions(), (error) => {
      assert.equal(
        error.message,
        "A Hashsell não conseguiu carregar esta página.",
      );
      assert.equal(error.diagnostics, undefined);
      assert.equal(error.privateBody, undefined);
      return true;
    });
    const record = new Store(f.dir).state.history.findLast(
      (item) => item.source === "creation-options",
    );
    assert.equal(record.type, "error");
    assert.deepEqual(record.diagnostics, diagnostics);
    assert.doesNotMatch(
      JSON.stringify(record),
      /body-secret|cookie-secret|privateBody|privateHeaders/,
    );
    assert.doesNotMatch(
      JSON.stringify(states),
      /guardRefusals|responseSummary|diagnostics/,
    );
    assert.equal(f.m.busy, false);
    assert.equal(cancellations, 1);
  } finally {
    f.m.stop();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("creation entry reads the authenticated navigation shell despite a failed market main and keeps financial reads blocked", () => {
  const { JSDOM } = require("jsdom");
  const { creationScript } = require("../src/creation-dom.cjs");
  const dom = new JSDOM(
    '<button aria-label="Conta de test@example.com"></button><nav aria-label="Navegação principal"><a href="/orders">Ordens</a></nav><main>Não foi possível carregar esta tela</main><form><button>Criar ordem</button></form>',
    { url: "https://hashsell.com/market", runScripts: "outside-only" },
  );
  let clicks = 0,
    submissions = 0;
  dom.window.document.querySelector("a").onclick = (event) => {
    event.preventDefault();
    clicks++;
  };
  dom.window.document.querySelector("form").onsubmit = (event) => {
    event.preventDefault();
    submissions++;
  };
  try {
    const result = dom.window.eval(creationScript("navigateOrders"));
    assert.equal(result.ok, true);
    assert.equal(result.value.account, "test@example.com");
    assert.equal(result.value.navigated, true);
    assert.equal(clicks, 1);
    for (const mode of [
      "options",
      "wallet",
      "fill",
      "inspect",
      "open",
      "save",
    ]) {
      const financial = dom.window.eval(creationScript(mode));
      assert.equal(financial.ok, false, mode);
      assert.match(financial.error, /Hashsell não conseguiu carregar/);
    }
    assert.equal(submissions, 0);
  } finally {
    dom.window.close();
  }
});
test("creation entry requires one exact authenticated orders link inside navigation and refuses ambiguity or login", () => {
  const { JSDOM } = require("jsdom");
  const { creationScript } = require("../src/creation-dom.cjs");
  for (const markup of [
    '<a href="/orders">Ordens</a>',
    '<nav><a href="/orders">Ordens</a><a href="/orders">Ordens</a></nav>',
    '<nav><a href="https://other.example/orders">Ordens</a></nav>',
    '<nav hidden><a href="/orders">Ordens</a></nav>',
    '<nav inert><a href="/orders">Ordens</a></nav>',
    '<nav><a href="/orders">Ordens</a></nav><input type="password">',
  ]) {
    const dom = new JSDOM(
      '<button aria-label="Conta de test@example.com"></button>' + markup,
      { url: "https://hashsell.com/market", runScripts: "outside-only" },
    );
    try {
      assert.equal(
        dom.window.eval(creationScript("navigateOrders")).ok,
        false,
        markup,
      );
    } finally {
      dom.window.close();
    }
  }
  const dom = new JSDOM('<nav><a href="/orders">Ordens</a></nav>', {
    url: "https://hashsell.com/market",
    runScripts: "outside-only",
  });
  try {
    assert.match(
      dom.window.eval(creationScript("navigateOrders")).error,
      /Conta Hashsell não identificada/,
    );
  } finally {
    dom.window.close();
  }
});
test("creation entry refuses an account change between native routes or final options without reading or submitting further", async () => {
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  for (const changeAt of ["navigateCreation", "options"]) {
    let href = "https://hashsell.com/market",
      navigations = 0,
      reads = 0;
    const reader = {
      views: { creation: { webContents: { id: 42, getURL: () => href } } },
      adapter: {
        assertReadAvailable() {},
        async navigate() {
          navigations++;
        },
      },
      async run(wc, mode) {
        if (mode === "recover") return { recovered: false };
        if (mode === "navigateOrders") {
          href = "https://hashsell.com/orders";
          return { account: "first", navigated: true };
        }
        if (mode === "navigateCreation") {
          href = "https://hashsell.com/orders/new";
          return {
            account: changeAt === mode ? "second" : "first",
            navigated: true,
          };
        }
        reads++;
        assert.equal(mode, "options");
        return { account: "second", pools: [{ id: "saved-pool" }] };
      },
    };
    await assert.rejects(
      CreationAdapter.prototype.readPage.call(
        reader,
        "creation",
        "https://hashsell.com/orders/new",
        "options",
      ),
      /Conta mudou durante a navegação/,
    );
    assert.equal(navigations, 1);
    assert.equal(reads, changeAt === "options" ? 1 : 0);
  }
});

test("creation options reads the amount-associated static summary when the initial quote is blocked", async () => {
  const { creationScript } = require("../src/creation-dom.cjs");
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  const dom = creationOptionsDOM(
    "<dt>Taxa de criação</dt><dd>–</dd>",
    "<p>Sai da carteira: US$900,00 (US$900,00 + US$10,00 de taxa de criação)</p>",
  );
  let calls = 0;
  dom.window.fetch = () => {
    calls++;
    throw Error("Network forbidden");
  };
  try {
    const result = dom.window.eval(creationScript("options"));
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result.value.feeSummary)), {
      debit: "25.00",
      amount: "25.00",
      fee: "0.00",
      fieldAmount: "25.00000000",
    });
    const options = await CreationAdapter.prototype.options.call({
      readPage: async () => result.value,
    });
    assert.equal(options.creationFeeUsd, "0.00");
    assert.equal(Object.hasOwn(options, "feeSummary"), false);
    assert.equal(calls, 0);
  } finally {
    dom.window.close();
  }
});

test("creation options rejects incomplete, duplicated, hidden or unrelated amount summaries", () => {
  const { creationScript } = require("../src/creation-dom.cjs");
  for (const mutate of [
    (d) => d.querySelector('[data-slot="field-description"]').remove(),
    (d) =>
      d
        .querySelector('[data-slot="field-description"]')
        .setAttribute("hidden", ""),
    (d) =>
      d
        .querySelector('[data-slot="field-description"]')
        .setAttribute("inert", ""),
    (d) =>
      d
        .querySelector('[data-slot="field"]')
        .append(
          d.querySelector('[data-slot="field-description"]').cloneNode(true),
        ),
    (d) =>
      d
        .querySelector('[data-slot="field-description"]')
        .append(
          d.createElement("br"),
          d.createTextNode(
            "Sai da carteira: US$25,00 (US$25,00 + US$0,00 de taxa de criação)",
          ),
        ),
    (d) =>
      (d.querySelector('[data-slot="field-description"]').innerHTML =
        "<span>Sai da carteira: US$25,00 (US$25,00 + US$0,00 de taxa de criação)</span>"),
    (d) =>
      (d.querySelector('[data-slot="field-description"]').textContent =
        "Sai da carteira: US$25.00 (US$25,00 + US$0,00 de taxa de criação)"),
    (d) =>
      (d.querySelector('[data-slot="field-description"]').textContent =
        "Sai da carteira: US$25,00 (US$25,00 + US$-1,00 de taxa de criação)"),
    (d) =>
      (d.querySelector('[data-slot="field-description"]').textContent =
        "Sai da carteira: US$25,00 (US$25,00 + US$0,00 de taxa de criação) valor estimado"),
    (d) =>
      d
        .querySelector('[data-slot="field"]')
        .append(d.querySelector('[name="amount"]').cloneNode(true)),
    (d) => (d.querySelector('[name="amount"]').value = "25,00"),
    (d) => (d.querySelector('[name="amount"]').type = "text"),
    (d) => d.querySelector('[data-slot="field"]').setAttribute("hidden", ""),
    (d) => d.querySelector('[data-slot="field"]').setAttribute("inert", ""),
    (d) => {
      const nested = d.createElement("div");
      nested.dataset.slot = "field";
      d.querySelector('[data-slot="field"]').append(nested);
      nested.append(d.querySelector('[data-slot="field-description"]'));
    },
    (d) =>
      d
        .querySelector("form")
        .append(d.querySelector('[data-slot="field-description"]')),
    (d) => {
      const form = d.querySelector("form");
      form.id = "creation";
      const field = d.querySelector('[data-slot="field"]');
      d.querySelector('[name="amount"]').setAttribute("form", "creation");
      d.body.append(field);
    },
  ]) {
    const dom = creationOptionsDOM("<dt>Taxa de criação</dt><dd>–</dd>");
    try {
      mutate(dom.window.document);
      const result = dom.window.eval(creationScript("options"));
      assert.equal(result.ok, false, String(mutate));
      assert.match(result.error, /valor da criação|resumo.*criação/i);
    } finally {
      dom.window.close();
    }
  }
});

test("creation options verifies exact total, principal, hidden amount and numeric fee coherence", async () => {
  const { creationScript } = require("../src/creation-dom.cjs");
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  for (const [fee, description] of [
    ["–", "Sai da carteira: US$26,00 (US$25,00 + US$0,00 de taxa de criação)"],
    ["–", "Sai da carteira: US$26,00 (US$26,00 + US$0,00 de taxa de criação)"],
    [
      "US$1,00",
      "Sai da carteira: US$25,00 (US$25,00 + US$0,00 de taxa de criação)",
    ],
  ]) {
    const dom = creationOptionsDOM(
      "<dt>Taxa de criação</dt><dd>" + fee + "</dd>",
      "",
      description,
    );
    try {
      const result = dom.window.eval(creationScript("options"));
      assert.equal(result.ok, true);
      await assert.rejects(
        CreationAdapter.prototype.options.call({
          readPage: async () => result.value,
        }),
        /não confere/,
      );
    } finally {
      dom.window.close();
    }
  }
});

test("creation read budget rejects an expired or late result while keeping financial calls unchanged", async () => {
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  const originalNow = Date.now;
  let now = 1000,
    calls = 0;
  Date.now = () => now;
  const wc = {
    executeJavaScript: async () => {
      calls++;
      now += 500;
      return { ok: true, value: { account: "fixture@example.com" } };
    },
  };
  try {
    await assert.rejects(
      CreationAdapter.prototype.run.call({}, wc, "options", undefined, 0),
      /esgotado/,
    );
    await assert.rejects(
      CreationAdapter.prototype.run.call({}, wc, "options", undefined, 1000),
      /esgotado/,
    );
    assert.equal(calls, 0);
    await assert.rejects(
      CreationAdapter.prototype.run.call({}, wc, "options", undefined, 1400),
      /esgotado/,
    );
    assert.equal(calls, 1);
    const saved = await CreationAdapter.prototype.run.call({}, wc, "save");
    assert.equal(calls, 2);
    assert.match(saved.account, /^[a-f0-9]{64}$/);
  } finally {
    Date.now = originalNow;
  }
});

test("creation fee placeholder uses a positive static fee without assuming zero or losing source decimals", async () => {
  const { creationScript } = require("../src/creation-dom.cjs");
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  const fee = "0.00000000000000000000000000000000000000000000000001";
  const description =
    "Sai da carteira: US$25,00000000000000000000000000000000000000000000000001 (US$25,00 + US$" +
    fee.replace(".", ",") +
    " de taxa de criação)";
  const dom = creationOptionsDOM(
    "<dt>Taxa de criação</dt><dd>–</dd>",
    "",
    description,
  );
  try {
    const parsed = dom.window.eval(creationScript("options"));
    assert.equal(parsed.ok, true);
    const options = await CreationAdapter.prototype.options.call({
      readPage: async () => parsed.value,
    });
    assert.equal(options.creationFeeUsd, fee);
    dom.window.document.querySelector('[name="amount"]').value = "25.00000001";
    const changed = dom.window.eval(creationScript("options"));
    assert.equal(changed.ok, true);
    await assert.rejects(
      CreationAdapter.prototype.options.call({
        readPage: async () => changed.value,
      }),
      /não confere/,
    );
  } finally {
    dom.window.close();
  }
});

test("creation waits for the amount description to hydrate on the same document without another bootstrap", async () => {
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  const dom = creationOptionsDOM("<dt>Taxa de criação</dt><dd>–</dd>");
  const description = dom.window.document.querySelector(
    '[data-slot="field-description"]',
  );
  description.remove();
  let navigations = 0,
    optionReads = 0;
  const wc = {
    id: 42,
    getURL: () => dom.window.location.href,
    executeJavaScript: async (code) => dom.window.eval(code),
  };
  const reader = {
    views: { creation: { webContents: wc } },
    adapter: {
      assertReadAvailable() {},
      async navigate() {
        navigations++;
        dom.window.setTimeout(
          () =>
            dom.window.document
              .querySelector('[data-slot="field"]')
              .append(description),
          300,
        );
      },
    },
    async run(contents, mode, p, deadline) {
      if (mode.startsWith("navigate"))
        return {
          account: require("../src/creation-adapter.cjs").accountHash(
            "test@example.com",
          ),
          navigated: true,
        };
      if (mode === "options") optionReads++;
      return CreationAdapter.prototype.run.call(
        this,
        contents,
        mode,
        p,
        deadline,
      );
    },
  };
  // Mock route completion only; fee parsing uses the real serialized DOM reader.
  let path = "/orders";
  wc.getURL = () => "https://hashsell.com" + path;
  const delegate = reader.run;
  reader.run = async function (contents, mode, p, deadline) {
    if (mode === "navigateOrders") path = "/orders";
    if (mode === "navigateCreation") path = "/orders/new";
    return delegate.call(this, contents, mode, p, deadline);
  };
  try {
    const result = await CreationAdapter.prototype.readPage.call(
      reader,
      "creation",
      "https://hashsell.com/orders/new",
      "options",
      undefined,
      1,
    );
    assert.equal(result.creationFeeUsd, "0.00");
    assert.equal(navigations, 1);
    assert.ok(optionReads >= 2);
  } finally {
    dom.window.close();
  }
});

function creationReloadReader(options = {}) {
  const { EventEmitter } = require("node:events");
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  const state = {
    href: "https://hashsell.com/market",
    navigations: 0,
    reloads: 0,
    stops: 0,
    reads: 0,
    failed: false,
    healed: false,
    limited: false,
    account: "original-account",
  };
  const wc = new EventEmitter();
  wc.id = 42;
  wc.getURL = () => state.href;
  wc.stop = () => state.stops++;
  wc.reload = () => {
    state.reloads++;
    if (options.onReload) return options.onReload(wc, state);
    state.healed = true;
    state.failed = false;
    setImmediate(() => wc.emit("dom-ready"));
  };
  const reader = {
    views: { creation: { webContents: wc } },
    guard: options.guard || { requests: new Map() },
    adapter: {
      assertReadAvailable() {
        if (state.limited) throw Error("HTTP 429: aguarde");
      },
      async navigate(_wc, url) {
        state.navigations++;
        state.href = url;
        state.failed = false;
      },
    },
    async run(_wc, mode, p, deadline) {
      assert.ok(deadline > Date.now());
      if (mode === "recover")
        return { recovered: false, unavailable: state.failed };
      if (mode === "navigateOrders") {
        state.href = options.href || "https://hashsell.com/orders";
        state.failed = !state.healed && options.failureAt !== "options";
        return { account: state.account, navigated: true };
      }
      if (mode === "navigateCreation") {
        if (state.failed) {
          options.onRouteFailure?.();
          throw Error("Link de navegação indisponível.");
        }
        state.href = "https://hashsell.com/orders/new";
        state.failed = !state.healed && options.failureAt === "options";
        return { account: state.account, navigated: true };
      }
      state.reads++;
      if (state.failed)
        throw Error(
          "A Hashsell não conseguiu carregar esta página. Tentando novamente.",
        );
      return {
        account: state.account,
        pools: [{ id: "saved-pool" }],
        creationFeeUsd: "0.00",
      };
    },
  };
  return {
    state,
    wc,
    reader,
    read: () =>
      CreationAdapter.prototype.readPage.call(
        reader,
        "creation",
        "https://hashsell.com/orders/new",
        "options",
        undefined,
        options.attempts || 1,
      ),
  };
}

test("creation recovers a failed GET route with one normal reload, cleans listeners and never submits", async () => {
  const f = creationReloadReader();
  let posts = 0;
  f.wc.executeJavaScript = () => {
    posts++;
    throw Error("No financial scripts expected");
  };
  const result = await f.read();
  assert.equal(result.account, "original-account");
  assert.equal(f.state.reloads, 1);
  assert.equal(f.state.navigations, 1);
  assert.equal(f.state.stops, 0);
  assert.equal(posts, 0);
  assert.equal(f.wc.listenerCount("dom-ready"), 0);
  assert.equal(f.wc.listenerCount("did-fail-load"), 0);
});

test("creation also recovers failed options with a normal GET reload and refuses an account change afterward", async () => {
  const f = creationReloadReader({ failureAt: "options" });
  assert.equal((await f.read()).pools[0].id, "saved-pool");
  assert.equal(f.state.reloads, 1);
  const changed = creationReloadReader({
    onReload(wc, state) {
      state.healed = true;
      state.failed = false;
      state.account = "other-account";
      setImmediate(() => wc.emit("dom-ready"));
    },
  });
  await assert.rejects(changed.read(), /Conta mudou durante/);
  assert.equal(changed.state.reloads, 1);
  assert.equal(changed.state.reads, 0);
});

test("creation never reloads a foreign, credential-bearing, query-bearing or financial URL, or an active grant", async () => {
  for (const href of [
    "https://other.example/orders",
    "https://user:password@hashsell.com/orders",
    "https://hashsell.com/orders?token=secret",
    "https://hashsell.com/orders#fragment",
    "https://hashsell.com:8443/orders",
  ]) {
    const f = creationReloadReader({ href });
    await assert.rejects(f.read(), /indisponível para recarga/);
    assert.equal(f.state.reloads, 0);
  }
  for (const guard of [
    { phase: "preview", requests: new Map() },
    { phase: "save", requests: new Map() },
    { grant: { key: "not-consumed" }, requests: new Map() },
    { requests: new Map([["request", { phase: "save", revoked: false }]]) },
  ]) {
    const f = creationReloadReader({ guard });
    await assert.rejects(f.read(), /operação de criação em andamento/);
    assert.equal(f.state.reloads, 0);
    assert.equal(f.reader.guard, guard);
  }
});

test("normal creation reload observes rate limits and main-frame failure, stopping and removing listeners", async () => {
  for (const onReload of [
    (wc, state) => {
      state.limited = true;
      setImmediate(() => wc.emit("dom-ready"));
    },
    (wc) =>
      setImmediate(() =>
        wc.emit(
          "did-fail-load",
          {},
          -2,
          "failure",
          "https://hashsell.com/orders",
          true,
        ),
      ),
  ]) {
    const f = creationReloadReader({ onReload });
    await assert.rejects(f.read(), /HTTP 429|Falha ao recarregar/);
    assert.equal(f.state.reloads, 1);
    assert.equal(f.state.stops, 1);
    assert.equal(f.state.reads, 0);
    assert.equal(f.wc.listenerCount("dom-ready"), 0);
    assert.equal(f.wc.listenerCount("did-fail-load"), 0);
  }
});

test("creation GET reload is limited to one per query and cannot return success past its remaining deadline", async () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const f = creationReloadReader({
      onReload(wc) {
        now += 25001;
        setImmediate(() => wc.emit("dom-ready"));
      },
    });
    await assert.rejects(f.read(), /recarga.*esgotado/);
    assert.equal(f.state.reloads, 1);
    assert.equal(f.state.stops, 1);
    assert.equal(f.state.reads, 0);
    const persistent = creationReloadReader({
      attempts: 3,
      onRouteFailure() {
        now += 11000;
      },
      onReload(wc) {
        setImmediate(() => wc.emit("dom-ready"));
      },
    });
    await assert.rejects(persistent.read(), /indisponível|esgotado/);
    assert.equal(persistent.state.reloads, 1);
    assert.ok(persistent.state.navigations <= 3);
    assert.equal(persistent.wc.listenerCount("dom-ready"), 0);
  } finally {
    Date.now = originalNow;
  }
});

test("wallet and evidence retain the original fresh navigation and never use normal creation reload", async () => {
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  for (const [key, mode, url] of [
    ["wallet", "wallet", "https://hashsell.com/wallet"],
    ["creationEvidence", "evidence", "https://hashsell.com/orders/HS-TEST"],
  ]) {
    let reloads = 0;
    const wc = {
      id: 42,
      getURL: () => url,
      reload() {
        reloads++;
      },
    };
    const reader = {
      views: { [key]: { webContents: wc } },
      adapter: {
        assertReadAvailable() {},
        async navigate(_wc, href, _site, _timeout, readOnly) {
          assert.equal(href, url);
          assert.equal(readOnly, false);
        },
      },
      async run(_wc, currentMode) {
        if (currentMode === "recover")
          return { recovered: false, unavailable: true };
        throw Error("HTTP 401");
      },
    };
    await assert.rejects(
      CreationAdapter.prototype.readPage.call(
        reader,
        key,
        url,
        mode,
        undefined,
        1,
      ),
      /HTTP 401/,
    );
    assert.equal(reloads, 0);
  }
});

test("recovery probe reports a failed page without clicking its retry button twice", () => {
  const { JSDOM } = require("jsdom");
  const { creationScript } = require("../src/creation-dom.cjs");
  const dom = new JSDOM(
    "<p>Não foi possível carregar esta tela</p><button>Tentar de novo</button>",
    { url: "https://hashsell.com/orders", runScripts: "outside-only" },
  );
  let clicks = 0;
  dom.window.document.querySelector("button").onclick = () => clicks++;
  try {
    const first = dom.window.eval(creationScript("recover"));
    assert.equal(first.value.recovered, true);
    assert.equal(first.value.unavailable, true);
    const second = dom.window.eval(
      creationScript("recover", { probeOnly: true }),
    );
    assert.equal(second.value.recovered, false);
    assert.equal(second.value.unavailable, true);
    assert.equal(clicks, 1);
  } finally {
    dom.window.close();
  }
});

test("pool selection reads authenticated form without requiring a financial quote", async () => {
  const { creationScript } = require("../src/creation-dom.cjs");
  const { CreationAdapter } = require("../src/creation-adapter.cjs");
  const dom = creationOptionsDOM("<dt>Taxa de criação</dt><dd>–</dd>");
  try {
    dom.window.document
      .querySelector('[data-slot="field-description"]')
      .remove();
    const result = dom.window.eval(
      creationScript("options", { poolsOnly: true }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.value.pools.length, 1);
    assert.equal(Object.hasOwn(result.value, "creationFeeUsd"), false);
    const actual = await CreationAdapter.prototype.options.call(
      {
        readPage: async (...args) => {
          assert.deepEqual(args[3], { poolsOnly: true });
          return result.value;
        },
      },
      { poolsOnly: true },
    );
    assert.equal(actual.pools.length, 1);
    const financial = dom.window.eval(creationScript("options"));
    assert.equal(financial.ok, false);
  } finally {
    dom.window.close();
  }
});

test("creation ignores cached hidden pages, stale accounts and duplicate forms but rejects active ambiguity", () => {
  const { creationScript } = require("../src/creation-dom.cjs");
  for (const attr of [
    "hidden",
    "inert",
    'style="display:none"',
    'style="visibility:hidden"',
    'style="content-visibility:hidden"',
  ]) {
    const dom = creationOptionsDOM("<dt>Taxa de criação</dt><dd>–</dd>");
    dom.window.document.body.insertAdjacentHTML(
      "afterbegin",
      `<section ${attr}><button aria-label="Conta de previous@example.com"></button><input type="password"><div>Não foi possível carregar esta tela<button>Tentar de novo</button></div><form method="get"><select name="poolId"><option value="stale">Old pool</option></select></form></section>`,
    );
    let clicked = false;
    dom.window.document.querySelector("section button:last-of-type").onclick =
      () => {
        clicked = true;
      };
    try {
      const recovery = dom.window.eval(creationScript("recover"));
      assert.equal(recovery.value.unavailable, false, attr);
      assert.equal(clicked, false);
      for (const params of [{ poolsOnly: true }, {}]) {
        const result = dom.window.eval(creationScript("options", params));
        assert.equal(result.ok, true, result.error);
        assert.equal(result.value.account, "test@example.com");
        assert.equal(result.value.pools.length, 1);
        assert.equal(result.value.pools[0].id, "saved-pool");
      }
      dom.window.document.body.insertAdjacentHTML(
        "beforeend",
        '<form method="post"><select name="poolId"><option value="other">Other</option></select></form>',
      );
      assert.equal(
        dom.window.eval(creationScript("options", { poolsOnly: true })).ok,
        false,
      );
    } finally {
      dom.window.close();
    }
  }
});

test("reading options does not require POST metadata but mutation still validates form contract", () => {
  const { creationScript } = require("../src/creation-dom.cjs");
  const dom = creationOptionsDOM("<dt>Taxa de criação</dt><dd>–</dd>");
  try {
    dom.window.document.querySelector("form").removeAttribute("method");
    const result = dom.window.eval(
      creationScript("options", { poolsOnly: true }),
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.value.pools[0].id, "saved-pool");
    assert.equal(dom.window.eval(creationScript("options")).ok, true);
    assert.equal(dom.window.eval(creationScript("unit")).ok, false);
  } finally {
    dom.window.close();
  }
});

test("creation is evaluated after adjustments without submitting during uncertain adjustment", async () => {
  const f = fixture();
  try {
    f.m.running = true;
    f.m.mode = "live";
    f.m.result = { blocked: null };
    f.m.snapshots = Object.fromEntries(
      await Promise.all(
        ["orders", "rental", "market"].map(async (k) => [
          k,
          await f.adapter.read(k),
        ]),
      ),
    );
    await f.m.creation.tick(f.m.config, f.m.epoch, true);
    assert.match(f.m.creation.status, /próximo ciclo/);
    assert.equal(f.adapter.calls, 0);
    f.m.snapshots.market.cut = "50";
    await f.m.creation.tick(f.m.config, f.m.epoch, true);
    assert.match(f.m.creation.status, /margem/);
    assert.equal(f.adapter.calls, 0);
    f.m.snapshots.market.cut = "39.4";
    f.setWallet("1");
    await f.m.creation.tick(f.m.config, f.m.epoch, true);
    assert.match(f.m.creation.status, /Saldo/);
    assert.equal(f.adapter.calls, 0);
  } finally {
    f.m.stop();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
test("enabled status never reports disabled before first evaluation; stale readings explain waiting", async () => {
  const f = fixture();
  try {
    f.m.running = true;
    f.m.mode = "live";
    f.m.result = { blocked: null };
    assert.match(f.m.creation.snapshot().status, /ativada/);
    await f.m.creation.tick(f.m.config, f.m.epoch, false);
    assert.match(f.m.creation.snapshot().status, /leitura atualizada/);
  } finally {
    f.m.stop();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("creation timeout exposes its stage and retry time without sending or losing diagnostics", async () => {
  const f = fixture();
  try {
    f.m.running = true;
    f.m.mode = "live";
    f.m.result = { blocked: null };
    f.m.snapshots = Object.fromEntries(
      await Promise.all(
        ["orders", "rental", "market"].map(async (k) => [
          k,
          await f.adapter.read(k),
        ]),
      ),
    );
    const diagnostics = {
      stage: "wallet",
      responseSummary: "mainFrame HTTP 200",
    };
    let calls = 0;
    f.adapter.creation.wallet = async () => {
      calls++;
      assert.equal(f.m.creation.snapshot().stage, "wallet");
      throw Object.assign(Error("Tempo de leitura da criação esgotado."), {
        diagnostics,
      });
    };
    await f.m.creation.tick(f.m.config, f.m.epoch, false);
    const status = f.m.creation.snapshot();
    assert.match(status.status, /saldo demorou/);
    assert.equal(status.stage, null);
    assert.ok(status.lastAttemptAt);
    assert.ok(status.nextCheckAt > Date.now());
    const event = f.m.store.state.history.findLast(
      (e) => e.type === "creation-error",
    );
    assert.deepEqual(event.diagnostics, diagnostics);
    await f.m.creation.tick(f.m.config, f.m.epoch, false);
    assert.equal(calls, 1);
    assert.match(f.m.creation.snapshot().status, /saldo demorou/);
    assert.equal(f.adapter.calls, 0);
  } finally {
    f.m.stop();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("client React form accepts read and unit stages but a plain GET form cannot mutate", () => {
  const { creationScript } = require("../src/creation-dom.cjs");
  const dom = creationOptionsDOM("<dt>Taxa de criação</dt><dd>–</dd>");
  try {
    const form = dom.window.document.querySelector("form");
    form.removeAttribute("method");
    const input = dom.window.document.createElement("input");
    input.name = "unit";
    input.type = "hidden";
    input.value = "PH";
    form.append(input);
    assert.equal(dom.window.eval(creationScript("options")).ok, true);
    assert.equal(dom.window.eval(creationScript("unit")).ok, false);
    form.setAttribute(
      "action",
      "javascript:throw new Error('A React form was unexpectedly submitted.')",
    );
    assert.equal(dom.window.eval(creationScript("unit")).ok, true);
    form.setAttribute("method", "get");
    assert.equal(dom.window.eval(creationScript("unit")).ok, false);
  } finally {
    dom.window.close();
  }
});

test("React options preserve the platform idempotency key and reject ambiguous keys", () => {
  const { creationScript } = require("../src/creation-dom.cjs");
  const dom = creationOptionsDOM("<dt>Taxa de criação</dt><dd>–</dd>");
  try {
    const form = dom.window.document.querySelector("form");
    form.removeAttribute("method");
    form.setAttribute(
      "action",
      "javascript:throw new Error('A React form was unexpectedly submitted.')",
    );
    const input = dom.window.document.createElement("input");
    input.type = "hidden";
    input.name = "idempotencyKey";
    input.value = key;
    form.append(input);
    assert.equal(
      dom.window.eval(creationScript("options")).value.platformKey,
      key,
    );
    assert.equal(input.value, key);
    input.value = "invalid";
    assert.equal(dom.window.eval(creationScript("options")).ok, false);
    input.value = key;
    form.append(input.cloneNode());
    assert.equal(dom.window.eval(creationScript("options")).ok, false);
  } finally {
    dom.window.close();
  }
});

test("wallet ignores CSS-hidden duplicate balance labels and rejects two visible balances", () => {
  const { JSDOM } = require("jsdom");
  const { creationScript } = require("../src/creation-dom.cjs");
  const flight = JSON.stringify([1, '0:{"availableUsd":"16.46000000"}\n']);
  const dom = new JSDOM(
    '<button aria-label="Conta de test@example.com">test@example.com</button><p>Disponível</p><strong>US$ 16,46</strong><section style="display:none"><p>Disponível</p><strong>US$ 16,46</strong></section><script>self.__next_f.push(' +
      flight +
      ")</script>",
    { url: "https://hashsell.com/wallet", runScripts: "outside-only" },
  );
  try {
    const result = dom.window.eval(creationScript("wallet"));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.value.availableExact, "16.46000000");
    dom.window.document.querySelector("section").style.display = "block";
    assert.equal(dom.window.eval(creationScript("wallet")).ok, false);
  } finally {
    dom.window.close();
  }
});
