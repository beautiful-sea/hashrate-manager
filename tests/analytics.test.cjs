const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Analytics } = require("../src/analytics.cjs");
test("new profiles enable minimal metrics and disabling is preserved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
  const calls = [];
  const a = new Analytics(dir, "0.2.9", { send: async (p) => calls.push(p) });
  await a.ping();
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), ["id", "version"]);
  assert.match(calls[0].id, /^[0-9a-f-]{36}$/);
  a.choose(false);
  await a.ping();
  assert.equal(calls.length, 1);
  const reopened = new Analytics(dir, "0.2.9", {
    send: async (p) => calls.push(p),
  });
  assert.equal(reopened.state().consent, false);
  assert.equal(reopened.data.id, a.data.id);
  assert.throws(() => a.choose("true"));
});
test("offline, active operation and diagnostics never block or send metrics", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
  let calls = 0;
  let busy = true;
  const a = new Analytics(dir, "0.2.9", {
    busy: () => busy,
    send: async () => {
      calls++;
      throw Error("offline");
    },
  });
  a.choose(true);
  await a.ping();
  assert.equal(calls, 0);
  busy = false;
  await a.ping();
  assert.equal(calls, 1);
  assert.equal(a.pending, false);
  a.enabled = false;
  await a.ping();
  assert.equal(calls, 1);
});
test("concurrent heartbeats are coalesced and corrupt state disables collection", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
  let done,
    calls = 0;
  const a = new Analytics(dir, "0.2.9", {
    send: () => {
      calls++;
      return new Promise((r) => (done = r));
    },
  });
  a.choose(true);
  await a.ping();
  assert.equal(calls, 1);
  done();
  await new Promise((r) => setImmediate(r));
  fs.writeFileSync(a.file, '{"consent":true,"id":"account-email"}');
  assert.equal(new Analytics(dir, "0.2.9").state().consent, false);
});

test("default UUID and preference persist across upgrades without sending at construction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
  let calls = 0;
  const a = new Analytics(dir, "0.2.10", { send: async () => calls++ });
  assert.equal(a.state().consent, true);
  assert.equal(calls, 0);
  const b = new Analytics(dir, "0.2.11");
  assert.equal(b.data.id, a.data.id);
  assert.equal(b.state().consent, true);
  a.choose(false);
  assert.equal(new Analytics(dir, "0.2.11").state().consent, false);
});
