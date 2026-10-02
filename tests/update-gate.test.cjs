const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { Store } = require("../src/store.cjs");
const { UpdateGate } = require("../src/update-gate.cjs");
const { AppUpdates } = require("../src/app-updates.cjs");
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-gate-unit-"));
  const store = new Store(dir);
  store.commit(
    (s) =>
      (s.pending.TEST = {
        id: "TEST",
        target: "39.66",
        status: "checking",
        reconciliation: { status: "error" },
      }),
  );
  let ticks = 0,
    stops = 0,
    starts = 0;
  const monitor = { busy: false, running: true, tick: () => ticks++ };
  const reports = {
    busy: false,
    stopped: false,
    stop() {
      stops++;
      this.stopped = true;
    },
    start() {
      starts++;
      this.stopped = false;
    },
  };
  const gate = new UpdateGate(monitor, reports, store);
  return {
    dir,
    store,
    monitor,
    reports,
    gate,
    counts: () => ({ ticks, stops, starts }),
  };
}
test("persisted uncertain dispatch survives update reservation and disk flush without blocking installation", () => {
  const f = fixture();
  const before = structuredClone(f.store.state.pending);
  f.gate.begin();
  assert(f.monitor.maintenance);
  assert(f.reports.maintenance);
  assert.equal(f.gate.acquire().ready, true);
  assert.deepEqual(new Store(f.dir).state.pending, before);
  assert.equal(f.counts().stops, 1);
});
test("active cycle drains before update and prevents another tick; cancelling resumes scheduling", async () => {
  const f = fixture();
  f.monitor.busy = true;
  f.gate.begin();
  assert.equal(f.gate.acquire().ready, false);
  assert.match(f.gate.acquire().reason, /ciclo/);
  f.gate.begin();
  assert.equal(f.counts().stops, 1);
  f.monitor.busy = false;
  f.reports.busy = true;
  assert.equal(f.gate.acquire().ready, false);
  f.reports.busy = false;
  assert.equal(f.gate.acquire().ready, true);
  f.gate.release();
  await Promise.resolve();
  assert.equal(f.monitor.maintenance, false);
  assert.deepEqual(f.counts(), { ticks: 1, stops: 1, starts: 1 });
  f.gate.release();
  assert.equal(f.counts().starts, 1);
});
test("flush failure does not install and releases preparation gate", () => {
  const f = fixture();
  let installs = 0;
  const u = new EventEmitter();
  const updates = new AppUpdates({
    updater: u,
    version: "0.2.4",
    begin: () => f.gate.begin(),
    acquire: () => f.gate.acquire(),
    release: () => f.gate.release(),
    install: () => installs++,
  });
  f.store.commit = () => {
    throw Error("disk failure");
  };
  u.emit("update-downloaded", { version: "0.2.5" });
  updates.requestInstall();
  assert.equal(installs, 0);
  assert.equal(f.monitor.maintenance, false);
  assert.equal(updates.state().requested, false);
});
test("real download bytes and percentage remain visible when ready", () => {
  const u = new EventEmitter();
  const updates = new AppUpdates({
    updater: u,
    version: "0.2.4",
    acquire: () => false,
    release: () => {},
    install: () => {},
  });
  u.emit("download-progress", { percent: 37, transferred: 37, total: 100 });
  assert.equal(updates.state().percent, 37);
  assert.equal(updates.state().transferred, 37);
  assert.equal(updates.state().total, 100);
  u.emit("update-downloaded", { version: "0.2.5" });
  assert.equal(updates.state().percent, 100);
});
