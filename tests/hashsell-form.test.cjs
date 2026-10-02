const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULTS } = require("../src/config.cjs");
const { authorizeBid, encodeBid } = require("../src/bid-safety.cjs");
const {
  UPDATE_ACTION,
  parseFormBody,
  inspectFormPayload,
  inspectFormHeaders,
} = require("../src/hashsell-form.cjs");
const { RequestGuard } = require("../src/request-guard.cjs");

const UUID = "11111111-2222-4333-8444-555555555555";
const BOUNDARY = "----WebKitFormBoundaryControlledFixture";
const ACTION = "7056d2f339116e189948b384d3364705634ca693b2";

function fixture() {
  const config = structuredClone(DEFAULTS);
  config.tick = "0.0001";
  config.buffer = "0.001";
  const at = Date.now();
  const decision = {
    id: "HS-TEST",
    href: "https://hashsell.com/orders/HS-TEST",
    current: "39.3",
    target: "39.4213",
  };
  const sources = {
    rental: { at, rate: "43" },
    market: { at, cut: "39.4203" },
    orders: {
      at,
      items: [{ ...decision, bid: "39.3", active: true, balance: "500" }],
    },
  };
  const authority = authorizeBid(decision, config, sources);
  const prepared = {
    id: decision.id,
    href: decision.href,
    unit: "PH",
    value: encodeBid(decision.target, config.editor),
  };
  return {
    prepared,
    authority,
    domSave: true,
    orderRoot: `/api/proxy/orders/${UUID}`,
    limitHash: "55000000000",
    isCurrent: () => true,
  };
}

function fields(overrides = {}) {
  return Object.entries({
    _1_unit: "PH",
    _1_price: "39.4213",
    _1_limit: "55.0000",
    0: JSON.stringify([UUID, { status: "idle" }, "$K1"]),
    ...overrides,
  });
}

function body(entries = fields(), boundary = BOUNDARY) {
  return Buffer.from(
    entries
      .map(
        ([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      )
      .join("") + `--${boundary}--\r\n`,
  );
}

function request(f, entries = fields()) {
  return {
    id: "save-1",
    webContentsId: 7,
    method: "POST",
    url: f.prepared.href,
    uploadData: [{ bytes: body(entries) }],
  };
}

function headers(details, changes = {}) {
  return {
    ...details,
    requestHeaders: {
      "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      "Next-Action": ACTION,
      Accept: "text/x-component",
      ...changes,
    },
  };
}

function harness() {
  const f = fixture();
  const handlers = {};
  let current = true;
  let href = f.prepared.href;
  const wc = {
    id: 7,
    getURL: () => href,
    session: {
      webRequest: Object.fromEntries(
        [
          "onBeforeRequest",
          "onBeforeSendHeaders",
          "onCompleted",
          "onErrorOccurred",
        ].map((name) => [name, (fn) => (handlers[name] = fn)]),
      ),
    },
  };
  const guard = new RequestGuard(wc);
  const call = (event, details) => {
    const responses = [];
    handlers[event](details, (response) => responses.push(response));
    assert.equal(responses.length, 1, `${event} must resolve exactly once`);
    return responses[0];
  };
  const before = (details) => call("onBeforeRequest", details);
  const sendHeaders = (details) => call("onBeforeSendHeaders", details);
  const arm = () => {
    guard.armPreview(f.prepared, f.authority, f.limitHash, () => current);
    const preview = {
      id: "preview-1",
      webContentsId: wc.id,
      method: "POST",
      url: `https://hashsell.com${f.orderRoot}/simulate`,
      uploadData: [
        {
          bytes: Buffer.from(
            '{"priceScaled":"3942130","limitHash":"55000000000"}',
          ),
        },
      ],
    };
    assert.notEqual(before(preview).cancel, true);
    handlers.onCompleted({ id: preview.id, statusCode: 200 });
    guard.armDOMSave(f.prepared, f.authority, () => current);
  };
  return {
    f,
    guard,
    handlers,
    before,
    sendHeaders,
    arm,
    pause: () => (current = false),
    navigate: () => (href = "https://hashsell.com/orders/HS-OTHER"),
  };
}

test("known PH form retains four decimals and validates body before action headers", () => {
  const f = fixture();
  const details = request(f);
  const candidate = { ...inspectFormPayload(details, f), expected: f };
  assert.equal(UPDATE_ACTION, ACTION);
  assert.equal(candidate.boundary, BOUNDARY);
  assert.deepEqual(candidate.payload, {
    priceScaled: "3942130",
    limitHash: "55000000000",
  });
  assert.deepEqual(
    inspectFormHeaders(headers(details), candidate),
    candidate.payload,
  );
  assert.deepEqual(
    inspectFormHeaders(
      headers(details, {
        "Content-Type": `multipart/form-data; boundary="${BOUNDARY}"`,
      }),
      candidate,
    ),
    candidate.payload,
  );
});

test("form rejects 1000x, over-ceiling, different bid and changed speed", () => {
  for (const overrides of [
    { _1_price: "39421.3" },
    { _1_price: "40" },
    { _1_price: "39.4212" },
    { _1_limit: "56" },
    { _1_limit: "54.9999" },
    { _1_limit: "0" },
    { _1_unit: "EH" },
    { _1_unit: "ph" },
  ]) {
    const f = fixture();
    assert.throws(() => inspectFormPayload(request(f, fields(overrides)), f));
  }
});

test("hidden decimal values reject locale punctuation, exponent, signs and excess precision", () => {
  for (const value of [
    "39,4213",
    "39.421,3",
    "3.94213e1",
    "+39.4213",
    "039.4213",
    " 39.4213",
    "39.42130",
    "NaN",
    "Infinity",
    "-39.4213",
  ]) {
    const f = fixture();
    assert.throws(() =>
      inspectFormPayload(request(f, fields({ _1_price: value })), f),
    );
  }
});

test("root envelope binds exact preview UUID, idle state, FormData reference and argument count", () => {
  for (const root of [
    [UUID.replace("11111111", "99999999"), { status: "idle" }, "$K1"],
    ["HS-TEST", { status: "idle" }, "$K1"],
    [UUID, { status: "ok" }, "$K1"],
    [UUID, { status: "idle", extra: true }, "$K1"],
    [UUID, { status: "idle" }, "$K2"],
    [UUID, { status: "idle" }, "$@1"],
    [UUID, { status: "idle" }, "$K1", "extra"],
    [UUID, "$K1"],
    { id: UUID, status: "idle", form: "$K1" },
  ]) {
    const f = fixture();
    assert.throws(() =>
      inspectFormPayload(request(f, fields({ 0: JSON.stringify(root) })), f),
    );
  }
});

test("multipart rejects extra, duplicate and alternate-prefix fields", () => {
  const original = fields();
  for (const entries of [
    [...original, ["extra", "1"]],
    [...original, ["_1_price", "39.4213"]],
    original.map(([name, value]) => [
      name === "_1_limit" ? "_1_price" : name,
      value,
    ]),
    original.map(([name, value]) => [name.replace("_1_", "1_"), value]),
    original.map(([name, value]) => [
      name === "_1_price" ? "_2_price" : name,
      value,
    ]),
  ]) {
    assert.throws(() => parseFormBody([{ bytes: body(entries) }]));
  }
});

test("multipart rejects file uploads, malformed boundaries, invalid UTF-8 and oversized data", () => {
  for (const parts of [
    [{ file: "local-file", bytes: body() }],
    [{ bytes: body().subarray(1) }],
    [{ bytes: Buffer.from(body().toString().replaceAll("\r\n", "\n")) }],
    [{ bytes: Buffer.concat([body(), Buffer.from("extra")]) }],
    [
      {
        bytes: Buffer.concat([
          body().subarray(0, 100),
          Buffer.from([0xff]),
          body().subarray(100),
        ]),
      },
    ],
    [{ bytes: Buffer.alloc(8193) }],
  ]) {
    assert.throws(() => parseFormBody(parts));
  }
});

test("multipart request must retain exact order URL, POST method and unexpired authorization", () => {
  const f = fixture();
  const details = request(f);
  for (const change of [
    { method: "PATCH" },
    { url: details.url + "?extra=1" },
    { url: details.url + "#extra" },
    { url: details.url + "-OTHER" },
    { url: "https://hashsell.com" + f.orderRoot },
    { url: details.url.replace("https:", "http:") },
  ])
    assert.throws(() => inspectFormPayload({ ...details, ...change }, f));
  assert.throws(() =>
    inspectFormPayload(details, f, f.authority.expiresAt + 1),
  );
  assert.throws(() => inspectFormPayload(details, { ...f, domSave: false }));
});

test("action headers reject cancellation/refill actions, JSON, wrong boundary and ambiguous casing", () => {
  const f = fixture();
  const details = request(f);
  const candidate = { ...inspectFormPayload(details, f), expected: f };
  for (const change of [
    { "Next-Action": "4013ada94decdf6ec56b8984ff31e69227a2755cc2" },
    { "Next-Action": "707543af80b07ad82a16d1e1f734de895310def924" },
    { "Next-Action": undefined },
    { "Content-Type": "application/json" },
    { "Content-Type": "multipart/form-data; boundary=different" },
    {
      "Content-Type": `multipart/form-data; boundary=${BOUNDARY}; charset=utf-8`,
    },
    { "next-action": ACTION },
    { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  ])
    assert.throws(() =>
      inspectFormHeaders(headers(details, change), candidate),
    );
  assert.throws(() =>
    inspectFormHeaders(headers(details), candidate, f.authority.expiresAt + 1),
  );
});

test("guard admits only after matching multipart body and final headers, even with one-byte chunks", () => {
  const h = harness();
  h.arm();
  const details = request(h.f);
  details.uploadData = [...body()].map((byte) => ({
    bytes: Buffer.from([byte]),
  }));
  assert.notEqual(h.before(details).cancel, true);
  assert.equal(h.guard.result.admitted, undefined);
  assert.equal(h.guard.result.awaitingHeaders, true);
  assert.notEqual(h.sendHeaders(headers(details)).cancel, true);
  assert.equal(h.guard.result.admitted, true);
  assert.deepEqual(h.guard.result.payload, {
    priceScaled: "3942130",
    limitHash: "55000000000",
  });
});

test("DOM save cannot fall back to the former JSON endpoint contract", () => {
  const h = harness();
  h.arm();
  const details = {
    ...request(h.f),
    url: `https://hashsell.com${h.f.orderRoot}/fixture-save`,
    uploadData: [
      {
        bytes: Buffer.from(
          '{"priceScaled":"3942130","limitHash":"55000000000"}',
        ),
      },
    ],
  };
  assert.equal(h.before(details).cancel, true);
  assert.notEqual(h.guard.result.admitted, true);
});

test("guard rejects mismatched final headers without admitting an otherwise valid body", () => {
  for (const change of [
    { "Next-Action": "wrong-action" },
    { "Content-Type": "application/json" },
    { "Content-Type": "multipart/form-data; boundary=wrong" },
  ]) {
    const h = harness();
    h.arm();
    const details = request(h.f);
    assert.notEqual(h.before(details).cancel, true);
    assert.equal(h.sendHeaders(headers(details, change)).cancel, true);
    assert.notEqual(h.guard.result.admitted, true);
  }
});

test("revocation between body and headers cancels even if action headers are removed", () => {
  for (const revoke of ["disarm", "pause", "navigate"]) {
    for (const removeAction of [false, true]) {
      const h = harness();
      h.arm();
      const details = request(h.f);
      assert.notEqual(h.before(details).cancel, true);
      if (revoke === "disarm") h.guard.disarm();
      else h[revoke]();
      const final = headers(details);
      if (removeAction) delete final.requestHeaders["Next-Action"];
      assert.equal(
        h.sendHeaders(final).cancel,
        true,
        `${revoke}, removeAction=${removeAction}`,
      );
      assert.notEqual(h.guard.result.admitted, true);
    }
  }
});

test("authorization expiring between body and headers cannot admit the request", (t) => {
  const h = harness();
  h.arm();
  const details = request(h.f);
  assert.notEqual(h.before(details).cancel, true);
  t.mock.method(Date, "now", () => h.f.authority.expiresAt + 1);
  assert.equal(h.sendHeaders(headers(details)).cancel, true);
  assert.notEqual(h.guard.result.admitted, true);
});

test("a successful admission survives blocked duplicates and cannot spend twice", () => {
  const h = harness();
  h.arm();
  const details = request(h.f);
  assert.notEqual(h.before(details).cancel, true);
  assert.notEqual(h.sendHeaders(headers(details)).cancel, true);
  const admitted = structuredClone(h.guard.result);
  assert.equal(h.before({ ...details, id: "save-duplicate" }).cancel, true);
  assert.deepEqual(h.guard.result, admitted);
  assert.equal(
    h.sendHeaders(headers({ ...details, id: "save-duplicate" })).cancel,
    true,
  );
  assert.deepEqual(h.guard.result, admitted);
  assert.equal(h.sendHeaders(headers(details)).cancel, true);
  assert.deepEqual(h.guard.result, admitted);
});

test("multipart dry probes validate both phases but never admit a financial request", () => {
  const h = harness();
  h.arm();
  h.guard.authorization.dryRun = true;
  const details = request(h.f);
  assert.notEqual(h.before(details).cancel, true);
  assert.equal(h.guard.result.awaitingHeaders, true);
  assert.equal(h.sendHeaders(headers(details)).cancel, true);
  assert.equal(h.guard.result.blockedProbe, true);
  assert.equal(h.guard.result.admitted, false);
  assert.deepEqual(h.guard.result.payload, {
    priceScaled: "3942130",
    limitHash: "55000000000",
  });
});

test("late headers of an older generation are cancelled without changing the new preview", () => {
  for (const removeAction of [false, true]) {
    const h = harness();
    h.arm();
    const pendingA = request(h.f);
    assert.notEqual(h.before(pendingA).cancel, true);
    const authorityB = { ...h.f.authority, target: "39.4223" };
    const preparedB = { ...h.f.prepared, value: "39,4223" };
    h.guard.armPreview(preparedB, authorityB, h.f.limitHash, () => true);
    const previewB = {
      id: "preview-b",
      webContentsId: pendingA.webContentsId,
      method: "POST",
      url: `https://hashsell.com${h.f.orderRoot}/simulate`,
      uploadData: [
        {
          bytes: Buffer.from(
            '{"priceScaled":"3942230","limitHash":"55000000000"}',
          ),
        },
      ],
    };
    assert.notEqual(h.before(previewB).cancel, true);
    const resultB = h.guard.result;
    const authorizationB = h.guard.authorization;
    assert.equal(resultB.preview, true);
    const oldHeaders = headers(pendingA);
    if (removeAction) delete oldHeaders.requestHeaders["Next-Action"];
    assert.equal(h.sendHeaders(oldHeaders).cancel, true);
    assert.strictEqual(h.guard.result, resultB);
    assert.strictEqual(h.guard.authorization, authorizationB);
    assert.equal(h.guard.preview.target, authorityB.target);
    assert.equal(h.guard.previewComplete, false);
    h.handlers.onCompleted({ id: previewB.id, statusCode: 200 });
    assert.doesNotThrow(() =>
      h.guard.armDOMSave(preparedB, authorityB, () => true),
    );
  }
});

test("save admission records completion separately and retains uncertainty after network failure", () => {
  for (const failed of [false, true]) {
    const h = harness();
    h.arm();
    const d = request(h.f);
    h.before(d);
    h.sendHeaders(headers(d));
    const result = h.guard.result;
    assert.equal(result.completed, undefined);
    h.guard.disarm();
    if (failed) h.handlers.onErrorOccurred({ id: d.id });
    else h.handlers.onCompleted({ id: d.id, statusCode: 500 });
    assert.equal(result.admitted, true);
    if (failed) assert.ok(result.transportError);
    else {
      assert.equal(result.completed, true);
      assert.equal(result.statusCode, 500);
    }
    assert.equal(h.guard.saveRequests.size, 0);
  }
});
