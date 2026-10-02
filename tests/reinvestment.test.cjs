const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  paymentTiming,
  reinvestmentTiming,
  withdrawalCapital,
} = require("../src/reinvestment.cjs");
const header = "Data,Finalizado em,Situação,Líquido (USD),Comprovante\r\n";
test("CSV retains explicit timezone, completion and exact net without addresses", () => {
  const rows = paymentTiming(
    header +
      "2026-09-20T00:00:00-03:00,2026-09-21T06:00:00-03:00,Concluído,12.12345678,0x" +
      "a".repeat(64),
  );
  assert.equal(rows[0].net, "12.12345678");
  assert.equal(
    Date.parse(rows[0].completedAt) - Date.parse(rows[0].requestedAt),
    30 * 3600000,
  );
  assert.throws(() =>
    paymentTiming(
      header + "2026-09-20,2026-09-21,Concluído,12,0x" + "a".repeat(64),
    ),
  );
});
test("duplicate export IDs and malformed quoted CSV are rejected", () => {
  const r =
    "2026-09-20T00:00:00Z,2026-09-21T06:00:00Z,Concluído,12,0x" +
    "a".repeat(64);
  assert.throws(() => paymentTiming(header + r + "\n" + r));
  assert.throws(() => paymentTiming(header + '"unfinished'));
});
test("requires three unique prefix and amount matches, never pairs by date alone", () => {
  const a = {
    payments: {
      timing: [1, 2, 3].map((i) => ({
        id: "0x" + String(i).repeat(64),
        requestedAt: "2026-09-20T00:00:00Z",
        completedAt: "2026-09-21T06:00:00Z",
        net: "12",
      })),
    },
    entries: [],
  };
  a.entries = a.payments.timing.map((p) => ({
    site: "hashsell",
    category: "deposits",
    label: p.id.slice(0, 10),
    amount: "12",
    at: "2026-09-21T07:00:00Z",
  }));
  a.entries.push(
    ...a.entries
      .filter((r) => r.category === "deposits")
      .map((r) => ({
        ...r,
        category: "transfer",
        label: "Reserva para ordem",
        amount: "-12",
      })),
  );
  assert.equal(reinvestmentTiming(a).transitHours, 31);
  a.entries[0].amount = "13";
  assert.equal(reinvestmentTiming(a), null);
});

const transfer = (extra = {}) => ({
  day: "2026-09-29",
  displayedAt: "29/09/2026, 23:01",
  gross: "US$ 102,00",
  fee: "US$ 2,00",
  net: "100",
  status: "Pendente",
  id: null,
  ...extra,
});
test("known withdrawal remains capital after completion until matching deposit is credited", () => {
  const completed = transfer({
    status: "Concluído",
    id: "0x" + "a".repeat(64),
  });
  const first = withdrawalCapital(
    { pending: [], completed: [completed] },
    { pending: [transfer()], rows: [] },
    [],
  );
  assert.equal(first.inTransit, "100");
  assert.equal(first.settling.length, 1);
  const prior = {
    settling: first.settling,
    pending: [],
    rows: [{ id: completed.id }],
  };
  const waiting = withdrawalCapital(
    { pending: [], completed: [completed] },
    prior,
    [],
  );
  assert.equal(waiting.inTransit, "100");
  const credit = {
    site: "hashsell",
    category: "deposits",
    label: "USDT " + completed.id.slice(0, 10) + "...",
    amount: "100",
  };
  const credited = withdrawalCapital(
    { pending: [], completed: [completed] },
    prior,
    [credit],
  );
  assert.equal(credited.inTransit, "0");
  assert.equal(credited.settling.length, 0);
});
test("equal pending withdrawals are counted separately and one completion does not double count", () => {
  const completed = transfer({
    status: "Concluído",
    id: "0x" + "a".repeat(64),
  });
  const r = withdrawalCapital(
    { pending: [transfer()], completed: [completed] },
    { pending: [transfer(), transfer()], rows: [] },
    [],
  );
  assert.equal(r.inTransit, "200");
  assert.equal(r.settling.length, 1);
});
test("historical completed payments and cancelled withdrawals do not invent in-transit funds", () => {
  const completed = transfer({
    status: "Concluído",
    id: "0x" + "a".repeat(64),
  });
  assert.equal(
    withdrawalCapital({ pending: [], completed: [completed] }, null, [])
      .inTransit,
    "0",
  );
  assert.equal(
    withdrawalCapital(
      { pending: [], completed: [completed] },
      { pending: [transfer()], rows: [{ id: completed.id }] },
      [],
    ).inTransit,
    "0",
  );
});

const { withdrawalOverview } = require("../src/reinvestment.cjs");
const hour = 3600000,
  clock = Date.parse("2026-10-01T15:00:00Z");
const sample = (n, hours) => ({
  id: "0x" + String(n).repeat(64),
  requestedAt: "2026-09-25T12:00:00Z",
  completedAt: new Date(
    Date.parse("2026-09-25T12:00:00Z") + hours * hour,
  ).toISOString(),
  net: "100.12345678",
});
const paymentAccount = () => ({
  payments: {
    at: clock,
    timing: [sample(1, 24), sample(2, 36)],
    completed: [1, 2].map((i) => ({
      id: "0x" + String(i).repeat(64),
      status: "Concluído",
      displayedAt: "25/09/2026, 09:00",
    })),
    pending: [
      {
        status: "Pendente",
        displayedAt: "01/10/2026, 06:00",
        gross: "US$ 102,12345678",
        fee: "US$ 2,00",
      },
    ],
  },
});
test("withdrawals average processing alone and preserve original net precision", () => {
  const result = withdrawalOverview(paymentAccount(), clock);
  assert.equal(result.averageMs, 30 * hour);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.fastestMs, 24 * hour);
  assert.equal(result.slowestMs, 36 * hour);
  const pending = result.rows.find((r) => r.pending);
  assert.equal(pending.net, "100.12345678");
  assert.equal(pending.elapsedMs, 6 * hour);
  assert.equal(pending.remainingMs, 24 * hour);
  assert.equal(pending.estimatedAt, "2026-10-02T15:00:00.000Z");
});
test("past mean shows overdue without inventing completion and identical pending occurrences survive", () => {
  const account = paymentAccount();
  account.payments.pending[0].displayedAt = "29/09/2026, 06:00";
  account.payments.pending.push({ ...account.payments.pending[0] });
  const result = withdrawalOverview(account, clock);
  assert.equal(result.pendingCount, 2);
  const pending = result.rows.filter((r) => r.pending);
  assert.notEqual(pending[0].key, pending[1].key);
  assert.equal(pending[0].remainingMs, 0);
  assert.equal(pending[0].overdueMs, 24 * hour);
  assert.equal(pending[0].completedAt, null);
});
test("unknown timezone and missing samples never fabricate pending deadlines", () => {
  const account = paymentAccount();
  account.payments.completed[0].displayedAt = "25/09/2026, 12:00";
  assert.equal(
    withdrawalOverview(account, clock).rows.find((r) => r.pending).estimatedAt,
    null,
  );
  account.payments.timing = [];
  const result = withdrawalOverview(account, clock);
  assert.equal(result.averageMs, null);
  assert.equal(result.rows.find((r) => r.pending).remainingMs, null);
  assert.equal(result.completedCount, 2);
});
test("deduplicate completed identifiers and exclude reversed, future, ambiguous and canceled times", () => {
  const account = paymentAccount();
  account.payments.timing.push(
    sample(1, 24),
    { ...sample(3, 24), requestedAt: "25/09/2026" },
    { ...sample(4, 24), completedAt: "2027-01-01T00:00:00Z" },
    sample(5, -1),
    sample(6, 200),
  );
  account.payments.items = [
    ...account.payments.completed,
    ...account.payments.pending,
    {
      id: sample(6, 200).id,
      status: "Cancelado",
      displayedAt: "25/09/2026, 09:00",
    },
  ];
  const result = withdrawalOverview(account, clock);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.averageMs, 30 * hour);
  assert.equal(
    result.rows.find((r) => r.status === "Cancelado").pending,
    false,
  );
});
test("invalid and future pending dates have no countdown, single sample remains informative", () => {
  const account = paymentAccount();
  account.payments.timing = [sample(1, 24)];
  account.payments.completed = account.payments.completed.slice(0, 1);
  account.payments.pending[0].displayedAt = "31/02/2026, 06:00";
  assert.equal(
    withdrawalOverview(account, clock).rows.find((r) => r.pending).elapsedMs,
    null,
  );
  account.payments.pending[0].displayedAt = "01/10/2027, 06:00";
  assert.equal(
    withdrawalOverview(account, clock).rows.find((r) => r.pending).estimatedAt,
    null,
  );
  assert.equal(withdrawalOverview(account, clock).sampleCount, 1);
  assert.equal(withdrawalOverview(null, clock).ready, false);
});

const { ReportSync } = require("../src/report-sync.cjs");
const { accountKey } = require("../src/reports.cjs");
test("withdrawal query is isolated to the active account and empty without identity", () => {
  const sync = Object.create(ReportSync.prototype);
  sync.store = {
    data: {
      accounts: {
        first: paymentAccount(),
        other: {
          payments: { at: clock, timing: [], pending: [], completed: [] },
        },
      },
    },
  };
  sync.key = "first";
  assert.equal(sync.withdrawalsState(clock).sampleCount, 2);
  sync.key = "other";
  assert.equal(sync.withdrawalsState(clock).sampleCount, 0);
  sync.key = null;
  assert.equal(sync.withdrawalsState(clock).ready, false);
});
function paymentHarness(fail = false) {
  const sync = Object.create(ReportSync.prototype),
    prior = paymentAccount().payments;
  const account = accountKey("rental", "controlled@example.test");
  const rows = [
    ...prior.completed.map((r) => ({
      ...r,
      day: "2026-09-25",
      gross: "US$ 102,12345678",
      fee: "US$ 2,00",
    })),
    ...prior.pending.map((r) => ({ ...r, day: "2026-10-01" })),
    {
      status: "Cancelado",
      displayedAt: "26/09/2026, 09:00",
      day: "2026-09-26",
      fee: "US$ 2,00",
    },
  ];
  prior.rows = rows
    .filter((r) => r.status === "Concluído")
    .map((r) => ({ id: r.id, day: r.day, amount: "-2", category: "fees" }));
  sync.epoch = 0;
  sync.priority = async () => {};
  sync.page = async () => ({ account, rows, current: 1, next: null });
  const csv =
    header +
    prior.timing
      .map((r) =>
        [r.requestedAt, r.completedAt, "Concluído", r.net, r.id].join(","),
      )
      .join("\r\n");
  sync.views = {
    rental: {
      webContents: {
        mainFrame: {
          executeJavaScript: async (code) => {
            if (fail) throw Error("Exportação indisponível");
            if (code.includes("await fetch")) return csv;
            return { ok: true, value: { account: "controlled@example.test" } };
          },
        },
      },
    },
  };
  return { sync, prior, account };
}
test("payment export failure keeps timing and all statuses without changing pending financial status", async () => {
  const { sync, prior, account } = paymentHarness(true);
  const result = await sync.collectPayments(account, prior, 0);
  assert.deepEqual(result.timing, prior.timing);
  assert.equal(result.timingAt, prior.at);
  assert.ok(result.timingError);
  assert.equal(result.items.filter((r) => r.status === "Cancelado").length, 1);
  assert.equal(result.pending.length, 1);
  assert.equal(result.completed.length, 2);
  assert.equal(withdrawalOverview({ payments: result }, clock).stale, true);
});
test("verified fresh export replaces timings only after account and ledger checks", async () => {
  const { sync, prior, account } = paymentHarness();
  const result = await sync.collectPayments(account, prior, 0);
  assert.equal(result.timing.length, 2);
  assert.equal(result.timingError, null);
  assert.ok(result.timingAt);
  assert.equal(result.rows.length, 2);
});

test("old pending request completed now enters fees and average once across reimports", async () => {
  const { sync, prior, account } = paymentHarness();
  prior.rows = prior.rows.slice(0, 1);
  prior.completed = prior.completed.slice(0, 1);
  prior.timing = prior.timing.slice(0, 1);
  const result = await sync.collectPayments(account, prior, 0);
  assert.equal(result.rows.length, 2);
  assert.equal(
    result.rows.find((r) => r.id === sample(2, 36).id).amount,
    "-2.00",
  );
  assert.equal(result.timingError, null);
  assert.equal(
    withdrawalOverview({ payments: result }, clock).averageMs,
    30 * hour,
  );
  const repeated = await sync.collectPayments(account, result, 0);
  assert.equal(repeated.rows.length, 2);
  assert.equal(repeated.timing.length, 2);
});
test("duplicate completed payments fail instead of silently suppressing an occurrence", async () => {
  const { sync, prior, account } = paymentHarness();
  const page = sync.page;
  sync.page = async (...args) => {
    const result = await page(...args);
    return { ...result, rows: [...result.rows, result.rows[0]] };
  };
  await assert.rejects(
    sync.collectPayments(account, prior, 0),
    /Pagamento duplicado/,
  );
});
