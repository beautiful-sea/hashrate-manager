const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULTS } = require("../src/config.cjs");
const {
  authorizeBid,
  encodeBid,
  verifyPrepared,
  verifyBidText,
} = require("../src/bid-safety.cjs");
const { inspectPayload, RequestGuard } = require("../src/request-guard.cjs");
const { JSDOM } = require("jsdom");
const { script, inspectEditor, submitEditor } = require("../src/dom.cjs");
const {
  editorScript,
  inspectHashsellEditor,
  fillHashsellEditor,
  commitHashsellEditor,
  commitHashsellConfirmation,
} = require("../src/hashsell-editor.cjs");

test("final confirmation validates the shown contract and hidden background values before one click", () => {
  for (const scenario of [
    "valid",
    "wrong-price",
    "wrong-limit",
    "wrong-dialog",
    "expired",
    "ambiguous",
  ]) {
    const w = new JSDOM(
      `<div role="dialog" aria-hidden="true" inert><h2>Ajustar lance e limite</h2><form><label for="adjust-price">Lance, em US$ por PH/s por dia</label><input id="adjust-price" value="39,4110"><input id="adjust-limit" value="55,0000"><button type="button">Salvar ajuste</button></form></div><div role="alertdialog"><h2>Ajustar lance e limite</h2><p>Passa a valer no próximo tick e muda quanto esta ordem recebe e quanto ela gasta por dia.</p><p>Reduzir tem intervalo de espera: depois de salvar, a próxima redução só vale mais tarde.</p><button type="button">Voltar</button><button type="button" id="final-save">Salvar ajuste</button></div>`,
      {
        url: "https://hashsell.com/orders/HS-TEST",
        runScripts: "outside-only",
      },
    ).window;
    const f = fixture();
    const prepared = {
      ...f.prepared,
      limit: "55,0000",
      authority: f.authority,
    };
    let finalClicks = 0,
      originalClicks = 0;
    w.document.querySelector("#final-save").onclick = () => finalClicks++;
    w.document.querySelector("form button").onclick = () => originalClicks++;
    if (scenario === "wrong-price")
      w.document.querySelector("#adjust-price").value = "39411";
    if (scenario === "wrong-limit")
      w.document.querySelector("#adjust-limit").value = "56,0000";
    if (scenario === "wrong-dialog")
      w.document.querySelector('[role="alertdialog"] h2').textContent =
        "Cancelar ordem";
    if (scenario === "expired")
      prepared.authority = { ...prepared.authority, expiresAt: Date.now() - 1 };
    if (scenario === "ambiguous")
      w.document.body.append(
        w.document.querySelector('[role="alertdialog"]').cloneNode(true),
      );
    const act = () =>
      w.eval(editorScript(commitHashsellConfirmation, prepared));
    if (scenario === "valid") {
      act();
      assert.equal(finalClicks, 1);
    } else {
      assert.throws(act);
      assert.equal(finalClicks, 0);
    }
    assert.equal(originalClicks, 0);
  }
});
function fixture(unit = "PH", locale = "pt-BR") {
  const c = structuredClone(DEFAULTS);
  c.tick = "0.0001";
  c.buffer = "0.001";
  c.editor.unit = unit;
  c.editor.locale = locale;
  const at = Date.now();
  const decision = {
    id: "HS-TEST",
    href: "https://hashsell.com/orders/HS-TEST",
    current: "39.3",
    target: "39.411",
    ceiling: "999",
  };
  const sources = {
    rental: { at, rate: "43" },
    market: { at, cut: "39.41" },
    orders: {
      at,
      items: [{ ...decision, bid: "39.3", active: true, balance: "500" }],
    },
  };
  const authority = authorizeBid(decision, c, sources);
  const prepared = {
    id: decision.id,
    href: decision.href,
    value: encodeBid(decision.target, c.editor),
  };
  return { c, decision, sources, authority, prepared };
}
test("final ceiling is independently recomputed and does not trust the decision ceiling", () => {
  const f = fixture();
  assert.equal(f.authority.ceiling, "39.6601");
  f.decision.target = "39111";
  assert.throws(() => authorizeBid(f.decision, f.c, f.sources), /teto/);
  f.decision.target = "39.41101";
  assert.throws(() => authorizeBid(f.decision, f.c, f.sources), /incremento/);
  f.decision.target = "39.411";
  f.sources.rental.rate = "42";
  assert.throws(() => authorizeBid(f.decision, f.c, f.sources), /teto/);
});
test("stale readings, inactive orders and URL changes cannot authorize sending", () => {
  for (const change of [
    (f) => {
      f.sources.orders.at -= 100000;
    },
    (f) => {
      f.sources.orders.items[0].active = false;
    },
    (f) => {
      f.sources.orders.items[0].href += "-OTHER";
    },
    (f) => {
      f.sources.orders.items[0].balance = "0";
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => authorizeBid(f.decision, f.c, f.sources));
  }
});
test("PH TH EH and both locales roundtrip through independent integer validation", () => {
  for (const unit of ["PH", "TH", "EH"])
    for (const locale of ["pt-BR", "en-US"]) {
      const f = fixture(unit, locale);
      assert.equal(verifyPrepared(f.prepared, f.authority), true);
      assert.equal(verifyBidText(f.prepared.value, f.authority, unit), true);
      assert.throws(() =>
        verifyBidText(encodeBid("39411", f.c.editor), f.authority, unit),
      );
    }
});
test("ambiguous separators, exponent, negative, wrong unit and expired grants are blocked", () => {
  const f = fixture();
  for (const value of [
    "39.411",
    "39.411,0",
    "3,9411e1",
    "-39,411",
    "39,411 USD",
    "NaN",
    "Infinity",
    "0",
    "39411",
    "39,4110000000001",
  ])
    assert.throws(() => verifyBidText(value, f.authority, "PH"));
  assert.throws(() => verifyBidText(f.prepared.value, f.authority, "EH"));
  assert.throws(() =>
    verifyPrepared(f.prepared, { ...f.authority, expiresAt: Date.now() - 1 }),
  );
  assert.throws(() =>
    verifyPrepared({ ...f.prepared, value: "39411" }, f.authority),
  );
});
test("regression: the final generic submit rejects a 1000x value without any submit event", () => {
  const w = new JSDOM(
    '<h1 id="id">HS-TEST</h1><form method="post"><input id="bid" type="number" min="1" step="0.0001" value="39.3"><button id="save" type="submit">Salvar</button></form>',
    { url: "https://hashsell.com/orders/HS-TEST", runScripts: "outside-only" },
  ).window;
  const mapping = {
    identity: "#id",
    input: "#bid",
    submit: "#save",
    unit: "PH",
    locale: "en-US",
  };
  let calls = 0;
  w.document.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    calls++;
  });
  const info = w.eval(script(inspectEditor, mapping));
  const f = fixture("PH", "en-US");
  assert.throws(() =>
    w.eval(
      script(submitEditor, mapping, {
        ...info,
        original: info.value,
        value: "39411",
        authority: f.authority,
      }),
    ),
  );
  assert.equal(calls, 0);
  assert.equal(w.document.querySelector("#bid").value, "39.3");
});
function networkFixture() {
  const f = fixture();
  const expected = {
    ...f,
    path: "/api/proxy/orders/controlled-fixture/update",
    limitHash: "55000000000",
  };
  const details = {
    webContentsId: 7,
    url: "https://hashsell.com" + expected.path,
    method: "POST",
    uploadData: [
      {
        bytes: Buffer.from(
          '{"priceScaled":"3941100","limitHash":"55000000000"}',
        ),
      },
    ],
  };
  return { expected, details };
}
test("unvalidated form payload is refused with a useful error and without exposing its body", () => {
  const { expected, details } = networkFixture();
  const body =
    '--boundary\r\nContent-Disposition: form-data; name="secret"\r\n\r\nnever-expose-this';
  assert.throws(
    () =>
      inspectPayload(
        { ...details, uploadData: [{ bytes: Buffer.from(body) }] },
        expected,
      ),
    (error) => {
      assert.match(error.message, /Formulário não permitido/);
      assert.equal(error.message.includes("secret"), false);
      assert.equal(error.message.includes("never-expose-this"), false);
      return true;
    },
  );
});
test("request guard independently checks outgoing scaled price, limit, endpoint and payload keys", () => {
  const { expected, details } = networkFixture();
  assert.equal(inspectPayload(details, expected).priceScaled, "3941100");
  for (const body of [
    '{"priceScaled":"3941100000","limitHash":"55000000000"}',
    '{"priceScaled":"3941100","limitHash":"56000000000"}',
    '{"priceScaled":3941100,"limitHash":"55000000000"}',
    '{"priceScaled":"1","priceScaled":"3941100","limitHash":"55000000000"}',
    '{"priceScaled":"3941100","limitHash":"55000000000","other":1}',
  ])
    assert.throws(() =>
      inspectPayload(
        { ...details, uploadData: [{ bytes: Buffer.from(body) }] },
        expected,
      ),
    );
  assert.throws(() =>
    inspectPayload({ ...details, url: details.url + "-other" }, expected),
  );
  assert.throws(() =>
    inspectPayload(details, expected, expected.authority.expiresAt + 1),
  );
});
test("network guard defaults to deny, dry probes never leave and live authority permits only once", () => {
  let handler;
  const wc = {
    id: 7,
    session: {
      webRequest: {
        onBeforeSendHeaders() {},
        onCompleted() {},
        onErrorOccurred() {},
        onBeforeRequest: (f) => {
          handler = f;
        },
      },
    },
  };
  const guard = new RequestGuard(wc);
  const { expected, details } = networkFixture();
  let result;
  handler(details, (r) => (result = r));
  assert.equal(result.cancel, true);
  guard.arm({ ...expected, dryRun: true });
  handler(details, (r) => (result = r));
  assert.equal(result.cancel, true);
  assert.equal(guard.result.blockedProbe, true);
  guard.arm(expected);
  handler(details, (r) => (result = r));
  assert.equal(result.cancel, false);
  handler(details, (r) => (result = r));
  assert.equal(result.cancel, true);
  assert.equal(guard.result.admitted, true);
});
test("observed React modal preserves speed and rechecks exact field after state changes", () => {
  const w = new JSDOM(
    '<div role="dialog"><h2>Ajustar lance e limite</h2><form><label for="adjust-price">Lance, em US$ por PH/s por dia</label><input type="text" id="adjust-price" value="39,3000"><label for="adjust-limit">Limite, em PH/s</label><input type="text" id="adjust-limit" value="55,0000"><button type="button">Salvar ajuste</button></form></div>',
    { url: "https://hashsell.com/orders/HS-TEST", runScripts: "outside-only" },
  ).window;
  const f = fixture();
  const info = w.eval(editorScript(inspectHashsellEditor, "HS-TEST"));
  const prepared = {
    ...info,
    original: info.value,
    value: f.prepared.value,
    authority: f.authority,
  };
  let clicks = 0;
  w.document.querySelector("button").onclick = () => clicks++;
  w.eval(editorScript(fillHashsellEditor, prepared));
  assert.equal(w.document.querySelector("#adjust-price").value, "39,411");
  w.document.querySelector("#adjust-limit").value = "56,0000";
  assert.throws(() => w.eval(editorScript(commitHashsellEditor, prepared)));
  assert.equal(clicks, 0);
  w.document.querySelector("#adjust-limit").value = "55,0000";
  w.document.querySelector("#adjust-price").value = "39411";
  assert.throws(() => w.eval(editorScript(commitHashsellEditor, prepared)));
  assert.equal(clicks, 0);
  w.document.querySelector("#adjust-price").value = "39,411";
  w.eval(editorScript(commitHashsellEditor, prepared));
  assert.equal(clicks, 1);
});

test("DOM guard binds preview order, waits for success, revokes on pause and rejects an invented JSON save", () => {
  const f = fixture();
  const handlers = {};
  let current = true;
  const wc = {
    id: 7,
    getURL: () => f.prepared.href,
    session: {
      webRequest: {
        onBeforeSendHeaders(fn) {
          handlers.headers = fn;
        },
        onBeforeRequest(fn) {
          handlers.before = fn;
        },
        onCompleted(fn) {
          handlers.complete = fn;
        },
        onErrorOccurred(fn) {
          handlers.error = fn;
        },
      },
    },
  };
  const guard = new RequestGuard(wc);
  const root = "/api/proxy/orders/11111111-2222-4333-8444-555555555555";
  const details = {
    ...networkFixture().details,
    id: "preview",
    url: "https://hashsell.com" + root + "/simulate",
  };
  const dispatch = (d) => {
    let result;
    handlers.before(d, (r) => {
      result = r;
    });
    return result;
  };
  const startPreview = () => {
    guard.armPreview(f.prepared, f.authority, "55000000000", () => current);
    assert.equal(dispatch(details).cancel, undefined);
  };
  startPreview();
  assert.throws(
    () => guard.armDOMSave(f.prepared, f.authority, () => current),
    /Prévia/,
  );
  handlers.complete({ id: "preview", statusCode: 500 });
  assert.throws(
    () => guard.armDOMSave(f.prepared, f.authority, () => current),
    /Prévia/,
  );
  startPreview();
  handlers.complete({ id: "preview", statusCode: 200 });
  guard.armDOMSave(f.prepared, f.authority, () => current);
  const save = {
    ...details,
    id: "save",
    url: "https://hashsell.com" + root + "/fixture-save",
  };
  assert.equal(
    dispatch({ ...save, url: save.url.replace("11111111", "99999999") }).cancel,
    true,
  );
  startPreview();
  handlers.complete({ id: "preview", statusCode: 200 });
  guard.armDOMSave(f.prepared, f.authority, () => current);
  current = false;
  assert.equal(dispatch(save).cancel, true);
  current = true;
  startPreview();
  handlers.complete({ id: "preview", statusCode: 200 });
  guard.armDOMSave(f.prepared, f.authority, () => current);
  assert.equal(dispatch(save).cancel, true);
  assert.equal(dispatch(save).cancel, true);
  assert.equal(guard.result.admitted, false);
  assert.throws(
    () => guard.armDOMSave(f.prepared, f.authority, () => current),
    /Prévia/,
  );
});
