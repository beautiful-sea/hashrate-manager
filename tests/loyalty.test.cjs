const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { readScript } = require("../src/dom.cjs");
const { applyLoyalty } = require("../src/loyalty.cjs");
const { ceiling, marketMargin } = require("../src/engine.cjs");
const { DEFAULTS } = require("../src/config.cjs");
for (const [plan, bonus, rate] of [
  ["Connected", "0", "42"],
  ["Silver", "2,5", "43.05"],
  ["Gold", "5", "44.1"],
  ["Diamond", "7,5", "45.15"],
  ["Elite", "10", "46.2"],
])
  test(
    "reads current " + plan + " rather than another tier in the ladder",
    () => {
      const w = new JSDOM(
        `<div><p>Nível atual</p><p>${plan}</p></div><div><p>Bônus atual</p><p>+${bonus}%</p><p>somado à taxa base em cada hora</p></div><p>Elite +10%</p>`,
        {
          url: "https://rentalhash.com/painel/fidelidade",
          runScripts: "outside-only",
        },
      ).window;
      const raw = w.eval(readScript("loyalty", {}));
      assert.equal(raw.ok, true);
      assert.equal(raw.value.plan, plan);
      const rental = applyLoyalty("42", raw.value);
      assert.equal(rental.rate, rate);
      assert.equal(rental.baseRate, "42");
      const margin = marketMargin({
        rental: { ...rental, at: 1000 },
        market: { cut: "39.55", at: 1000 },
        config: DEFAULTS,
        now: 1000,
      });
      assert.ok(Number(margin) > 0);
      assert.ok(
        Number(ceiling(rate, DEFAULTS)) <=
          (Number(rate) * (1 - Number(DEFAULTS.margin))) /
            (1 + Number(DEFAULTS.fee)),
      );
    },
  );
test("missing, duplicated or unbounded bonus is never guessed", () => {
  for (const html of [
    "<p>Silver +2,5%</p>",
    "<div><p>Nível atual</p><p>Gold</p></div><div><p>Bônus atual</p><p>+5%</p></div><div><p>Bônus atual</p><p>+10%</p></div>",
  ]) {
    const w = new JSDOM(html, {
      url: "https://rentalhash.com/painel/fidelidade",
      runScripts: "outside-only",
    }).window;
    assert.equal(w.eval(readScript("loyalty", {})).ok, false);
  }
  assert.throws(() =>
    applyLoyalty("42", { plan: "Silver", bonus: "250%", locale: "en-US" }),
  );
  assert.throws(() =>
    applyLoyalty("42", { plan: "Silver", bonus: "-2%", locale: "en-US" }),
  );
});
test("dashboard identifies current plan separately from the base tariff", () => {
  const w = new JSDOM(
    "<p>Você está no nível Silver. Veja o próximo degrau.</p><div>1 PH/s US$ 42,00 por dia</div>",
    { url: "https://rentalhash.com/painel", runScripts: "outside-only" },
  ).window;
  const raw = w.eval(readScript("rental", { selector: "" }));
  assert.equal(raw.ok, true);
  assert.equal(raw.value.loyaltyPlan, "Silver");
  assert.equal(raw.value.value, "42,00");
});
test("server-streamed loyalty remains readable in detached monitor views without accepting conflicting copies", () => {
  const card =
    "<div><p>Nível atual</p><p>Silver</p></div><div><p>Bônus atual</p><p>+2,5%</p></div>";
  for (const html of [
    "<div hidden>" + card + "</div>",
    "<div hidden>" + card + card + "</div>",
  ]) {
    const w = new JSDOM(html, {
      url: "https://rentalhash.com/painel/fidelidade",
      runScripts: "outside-only",
    }).window;
    const raw = w.eval(readScript("loyalty", {}));
    assert.equal(raw.ok, true);
    assert.equal(applyLoyalty("42", raw.value).rate, "43.05");
  }
  const conflicting = new JSDOM(
    "<div hidden>" + card + card.replace("2,5", "5") + "</div>",
    {
      url: "https://rentalhash.com/painel/fidelidade",
      runScripts: "outside-only",
    },
  ).window;
  assert.equal(conflicting.eval(readScript("loyalty", {})).ok, false);
  const dashboard = new JSDOM(
    "<div hidden><p>Você está no nível Silver. Veja o próximo degrau.</p><div>1 PH/s US$ 42,00 por dia</div></div>",
    { url: "https://rentalhash.com/painel", runScripts: "outside-only" },
  ).window;
  assert.equal(
    dashboard.eval(readScript("rental", { selector: "" })).value.loyaltyPlan,
    "Silver",
  );
});
