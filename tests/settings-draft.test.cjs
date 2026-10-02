const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const { DEFAULTS } = require("../src/config.cjs");
function page(draft) {
  const dom = new JSDOM(fs.readFileSync("src/ui/index.html", "utf8"), {
    url: "https://local.test",
    runScripts: "outside-only",
  });
  const w = dom.window;
  w.hashrate = { invoke: async () => null, onState: () => {} };
  w.setInterval = () => 0;
  w.structuredClone = structuredClone;
  if (draft) w.localStorage.setItem("hashrate-settings-draft-v1", draft);
  w.eval(
    fs.readFileSync("src/ui/app.js", "utf8") +
      "\nwindow.setTestState = v => state = v;",
  );
  w.config = structuredClone(DEFAULTS);
  w.config.creation.account = "a".repeat(64);
  w.eval("fillSettings(config)");
  return dom;
}
test("unsaved duration survives reopening as a draft, does not change saved config, and discard restores saved value", () => {
  const a = page();
  a.window.document.querySelector('[name="creation-hours"]').value = "17";
  a.window.eval("keepSettingsDraft()");
  const draft = a.window.localStorage.getItem("hashrate-settings-draft-v1");
  const b = page(draft);
  b.window.eval("restoreSettingsDraft()");
  assert.equal(
    b.window.document.querySelector('[name="creation-hours"]').value,
    "17",
  );
  assert.equal(b.window.config.creation.hours, "9");
  assert.match(
    b.window.document.querySelector("#settings-save-status").textContent,
    /Salve/,
  );
  b.window.setTestState({ config: b.window.config });
  b.window.document.querySelector("#reset-form").click();
  assert.equal(
    b.window.document.querySelector('[name="creation-hours"]').value,
    "9",
  );
  assert.equal(
    b.window.localStorage.getItem("hashrate-settings-draft-v1"),
    null,
  );
  a.window.close();
  b.window.close();
});
test("draft from another configured account is not restored", () => {
  const d = page(
    JSON.stringify({
      account: "b".repeat(64),
      fields: [{ name: "creation-hours", value: "17" }],
    }),
  );
  d.window.eval("restoreSettingsDraft()");
  assert.equal(
    d.window.document.querySelector('[name="creation-hours"]').value,
    "9",
  );
  d.window.close();
});
