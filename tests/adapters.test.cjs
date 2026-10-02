const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const {
  collectPage,
  inspectEditor,
  submitEditor,
  script,
  readScript,
} = require("../src/dom.cjs");
const {
  normalizeOrders,
  allowed,
  BrowserAdapter,
  executeEditor,
} = require("../src/adapters.cjs");
const { DEFAULTS } = require("../src/config.cjs");
const page = (html) =>
  new JSDOM(html, {
    url: "https://hashsell.com/orders/HS-1",
    runScripts: "outside-only",
  }).window;

test("renderer errors retain their original reason and stage without replaying the script", async () => {
  const w = page("<div></div>");
  let calls = 0;
  const wc = {
    executeJavaScript: async (code) => {
      calls++;
      return w.eval(code);
    },
  };
  await assert.rejects(
    executeEditor(
      wc,
      function () {
        throw Error("Modal de edição ausente ou ambíguo.");
      },
      [],
      "Abertura do formulário",
      1000,
    ),
    /Abertura do formulário: Modal de edição ausente ou ambíguo/,
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await executeEditor(
        wc,
        async function () {
          return { value: "39,42" };
        },
        [],
        "Leitura",
        1000,
      )
    ).value,
    "39,42",
  );
});
test("a renderer context rejection names the stage and never retries Save", async () => {
  let calls = 0;
  const wc = {
    executeJavaScript: async () => {
      calls++;
      throw Error(
        "Script failed to execute, this normally means an error was thrown.",
      );
    },
  };
  await assert.rejects(
    executeEditor(wc, function () {}, [], "Confirmação final", 1000),
    /Confirmação final: A página interrompeu/,
  );
  assert.equal(calls, 1);
});
function diagnosticAdapter() {
  const adapter = Object.create(BrowserAdapter.prototype);
  const callbacks = [];
  const session = {
    webRequest: { onResponseStarted: (cb) => callbacks.push(cb) },
  };
  adapter.views = Object.fromEntries(
    ["rental", "market", "orders"].map((kind, id) => [
      kind,
      { webContents: { id, session } },
    ]),
  );
  adapter.watchReadResponses();
  return { adapter, callbacks };
}
test("read diagnostics share one passive observer and retain no URL, headers or body", () => {
  const { adapter, callbacks } = diagnosticAdapter();
  assert.equal(callbacks.length, 1);
  adapter.readResponses.get(1).since = Date.now() - 100;
  const response = {
    webContentsId: 1,
    timestamp: Date.now(),
    url: "https://hashsell.com/market?secret=never-retain",
    resourceType: "mainFrame",
    statusCode: 503,
    responseHeaders: { "Set-Cookie": ["secret"] },
  };
  callbacks[0](response);
  assert.equal(
    adapter.responseSummary(adapter.views.market.webContents),
    "mainFrame HTTP 503",
  );
  callbacks[0]({ ...response, url: "https://other.example/", statusCode: 403 });
  callbacks[0]({ ...response, webContentsId: 999, statusCode: 403 });
  const serialized = JSON.stringify([...adapter.readResponses]);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("403"), false);
});
test("HTTP 429 respects Retry-After across readers without reloading", async () => {
  const { adapter, callbacks } = diagnosticAdapter();
  let loads = 0;
  adapter.navigate = async () => {
    loads++;
    callbacks[0]({
      webContentsId: 1,
      timestamp: Date.now(),
      url: "https://hashsell.com/market",
      resourceType: "mainFrame",
      statusCode: 429,
      responseHeaders: { "Retry-After": ["120"] },
    });
  };
  adapter.views.market.webContents.executeJavaScript = async () => ({
    ok: false,
    code: "SITE_UNAVAILABLE",
  });
  await assert.rejects(adapter.read("market", DEFAULTS), /HTTP 429/);
  assert.ok(adapter.readBackoff.get("hashsell") > Date.now() + 119000);
  await assert.rejects(adapter.read("orders", DEFAULTS), /HTTP 429/);
  assert.equal(loads, 1);
  assert.doesNotThrow(() => adapter.assertReadAvailable("rental"));
});
test("HTTP 401 and 403 are diagnosed without repeating the refused navigation", async () => {
  for (const statusCode of [401, 403]) {
    const { adapter, callbacks } = diagnosticAdapter();
    let loads = 0;
    adapter.navigate = async () => {
      loads++;
      callbacks[0]({
        webContentsId: 1,
        timestamp: Date.now(),
        url: "https://hashsell.com/market",
        resourceType: "mainFrame",
        statusCode,
      });
    };
    adapter.views.market.webContents.executeJavaScript = async () => ({
      ok: false,
      code: "SITE_UNAVAILABLE",
    });
    await assert.rejects(
      adapter.read("market", DEFAULTS),
      new RegExp(`HTTP ${statusCode}`),
    );
    assert.equal(loads, 1);
  }
});

test("read waits for hydration and reloads a temporary error only once", async () => {
  const adapter = Object.create(BrowserAdapter.prototype);
  let loads = 0,
    reads = 0;
  adapter.navigate = async () => {
    loads++;
  };
  adapter.views = {
    market: {
      webContents: {
        executeJavaScript: async () => {
          reads++;
          if (loads === 1)
            return {
              ok: false,
              code: "SITE_UNAVAILABLE",
              error: "Falha temporária",
            };
          if (reads === 2)
            return { ok: false, code: "NOT_READY", error: "Carregando" };
          return {
            ok: true,
            value: { value: "39.420,00", detected: true, locale: "pt-BR" },
          };
        },
      },
    },
  };
  const result = await adapter.read("market", DEFAULTS);
  assert.equal(result.cut, "39.42");
  assert.equal(loads, 2);
  assert.equal(reads, 3);
});
test("authentication and ambiguous readings never trigger automatic reload", async () => {
  for (const code of ["AUTH_REQUIRED", "AMBIGUOUS", "INVALID_DATA"]) {
    const adapter = Object.create(BrowserAdapter.prototype);
    let loads = 0;
    adapter.navigate = async () => {
      loads++;
    };
    adapter.views = {
      market: {
        webContents: {
          executeJavaScript: async () => ({ ok: false, code, error: code }),
        },
      },
    };
    await assert.rejects(adapter.read("market", DEFAULTS), new RegExp(code));
    assert.equal(loads, 1);
  }
});
test("DOM reports loading, site failure and login as distinct read errors", () => {
  for (const [html, code] of [
    ["<div>Carregando</div>", "NOT_READY"],
    ["<h2>Não foi possível carregar esta tela</h2>", "SITE_UNAVAILABLE"],
    ['<input type="password">', "AUTH_REQUIRED"],
  ]) {
    assert.equal(
      page(html).eval(readScript("market", DEFAULTS.market)).code,
      code,
    );
  }
});
test("strict selector rejects ambiguity and login", () => {
  assert.throws(() =>
    page("<b>43</b><b>42</b>").eval(
      script(collectPage, "rental", { selector: "b" }),
    ),
  );
  assert.throws(() =>
    page('<input type="password"><b>43</b>').eval(
      script(collectPage, "rental", { selector: "b" }),
    ),
  );
});
test("automatic rental reading uses PH row only", () => {
  const w = page(
    "<div><div>1 TH/s US$ 0,043 por dia</div><div>1 PH/s = 1.000 TH/s US$ 43,00 por dia</div><div>1 EH/s US$ 43.000,00</div></div>",
  );
  assert.equal(
    w.eval(script(collectPage, "rental", { selector: "" })).value,
    "43,00",
  );
});
test("orders are read from market-labeled table and normalized", () => {
  const w = page(
    '<table><thead><tr><th>Ordem</th><th>Situação</th><th>Lance</th></tr></thead><tbody><tr><td><a href="/orders/HS-1">HS-1</a></td><td>Entregando 55 PH/s</td><td>US$ 39,20 /PH/s/dia</td><td>55 PH/s</td><td>US$ 2.220,68</td><td>US$ 664,03</td></tr></tbody></table>',
  );
  const raw = w.eval(script(collectPage, "orders", DEFAULTS.orders));
  const o = normalizeOrders(raw, DEFAULTS.orders)[0];
  assert.equal(o.bid, "39.2");
  assert.equal(o.balance, "664.03");
  assert.equal(o.active, true);
  assert.throws(() => normalizeOrders([...raw, ...raw], DEFAULTS.orders));
});
test("allowed origins exclude lookalikes, credentials and ports", () => {
  for (const u of [
    "https://hashsell.com.evil.test",
    "http://hashsell.com",
    "https://x@hashsell.com",
    "https://hashsell.com:8443",
  ])
    assert.equal(allowed(u, "hashsell"), false);
  assert.equal(allowed("https://hashsell.com/orders", "hashsell"), true);
});
test("hidden streamed order table is excluded without hiding real ambiguity", () => {
  const table =
    '<table><thead><tr><th>Ordem</th><th>Lance</th></tr></thead><tbody><tr><td><a href="/orders/HS-1">HS-1</a></td><td>Entregando</td><td>US$ 39,20 /PH/s/dia</td><td>55 PH/s</td><td>US$ 2.220,68</td><td>US$ 664,03</td></tr></tbody></table>';
  const w = page(`<div hidden>${table}</div>${table}`);
  const response = w.eval(readScript("orders", DEFAULTS.orders));
  assert.equal(response.ok, true);
  assert.equal(response.value.length, 1);
  assert.equal(normalizeOrders(response.value, DEFAULTS.orders)[0].bid, "39.2");
  const ambiguous = page(table + table).eval(
    readScript("orders", DEFAULTS.orders),
  );
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /Tabela de ordens/);
});
test("read errors cross the Electron boundary as data, without leaking inputs", () => {
  const response = page(
    '<input type="password" value="never-export-this">',
  ).eval(readScript("rental", DEFAULTS.rental));
  assert.equal(response.ok, false);
  assert.equal(response.error, "Faça login na plataforma.");
  assert.equal(JSON.stringify(response).includes("never-export-this"), false);
});
const mapping = {
  identity: "#identity",
  input: "#bid",
  submit: "#save",
  unit: "PH",
  locale: "en-US",
};
const authority = (target = "39.111") => ({
  target,
  ceiling: "39.6601",
  tick: "0.0001",
  unit: "PH",
  locale: "en-US",
  expiresAt: Date.now() + 5000,
});
function form() {
  return page(
    '<h1 id="identity">HS-1</h1><form action="/orders/HS-1" method="post"><input id="bid" name="bid" type="number" step="0.0001" min="1" value="39.2"><button id="save" type="submit">Salvar</button></form>',
  );
}
test("executor validates identity and unchanged bid before a single submit", () => {
  const w = form();
  let submissions = 0;
  w.document.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    submissions++;
  });
  const info = w.eval(script(inspectEditor, mapping));
  w.eval(
    script(submitEditor, mapping, {
      ...info,
      original: info.value,
      value: "39.111",
      authority: authority(),
    }),
  );
  assert.equal(submissions, 1);
  assert.equal(w.document.querySelector("#bid").value, "39.111");
  assert.throws(() =>
    w.eval(
      script(submitEditor, mapping, {
        ...info,
        original: info.value,
        value: "39.112",
        authority: authority("39.112"),
      }),
    ),
  );
  assert.equal(submissions, 1);
});
test("form validation stops invalid tick and altered identity", () => {
  const w = form();
  const info = w.eval(script(inspectEditor, mapping));
  assert.throws(() =>
    w.eval(
      script(submitEditor, mapping, {
        ...info,
        identity: "HS-other",
        original: info.value,
        value: "39.1",
        authority: authority("39.1"),
      }),
    ),
  );
  assert.throws(() =>
    w.eval(
      script(submitEditor, mapping, {
        ...info,
        original: info.value,
        value: "0",
        authority: authority("0"),
      }),
    ),
  );
});

test("read-only navigation accepts a fresh DOM while resources remain pending; editor does not", async () => {
  const { EventEmitter } = require("node:events");
  const adapter = Object.create(BrowserAdapter.prototype);
  function contents(url, ready = true) {
    const wc = new EventEmitter();
    wc.stopped = false;
    wc.getURL = () => url;
    wc.stop = () => {
      wc.stopped = true;
    };
    wc.loadURL = () => {
      if (ready) setImmediate(() => wc.emit("dom-ready"));
      return new Promise(() => {});
    };
    return wc;
  }
  const url = "https://rentalhash.com/painel";
  const wc = contents(url);
  await adapter.navigate(wc, url, "rental", 50, true);
  assert.equal(wc.stopped, false);
  assert.equal(wc.listenerCount("dom-ready"), 0);
  const editor = contents(url);
  await assert.rejects(
    adapter.navigate(editor, url, "rental", 30),
    /tempo esgotado/,
  );
  assert.equal(editor.stopped, true);
  const absent = contents(url, false);
  await assert.rejects(
    adapter.navigate(absent, url, "rental", 30, true),
    /tempo esgotado/,
  );
  assert.equal(absent.listenerCount("dom-ready"), 0);
  const foreign = contents("https://example.com/");
  await assert.rejects(
    adapter.navigate(foreign, url, "rental", 50, true),
    /fora da plataforma/,
  );
});
