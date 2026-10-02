const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { JSDOM } = require("jsdom");
const main = fs.readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");
function handler() {
  let quits = 0;
  const app = { quit: () => quits++ };
  const quitSource = main.match(/  function quitApp\(\) \{[\s\S]*?\n  \}/)[0];
  const lifecycle = new Function(
    "app",
    "let quitting = false;" +
      quitSource +
      "return { quitApp, isQuitting: () => quitting };",
  )(app);
  const body = main.match(
    /ipcMain\.handle\("manager", async \(event, action, payload\) => \{([\s\S]*?)\n      \}\);/,
  )[1];
  const win = { webContents: {} },
    uiUrl = "file:///controlled-app/ui/index.html",
    monitor = { maintenance: true };
  const invoke = new Function(
    "win",
    "uiUrl",
    "monitor",
    "quitApp",
    "return async (event, action, payload) => {" + body + "};",
  )(win, uiUrl, monitor, lifecycle.quitApp);
  return {
    invoke,
    lifecycle,
    quits: () => quits,
    event: { sender: win.webContents, senderFrame: { url: uiUrl } },
  };
}
test("normal exit uses app.quit during update maintenance and sets the ordinary close flag", async () => {
  const h = handler();
  assert.equal(await h.invoke(h.event, "app-quit"), true);
  assert.equal(h.quits(), 1);
  assert.equal(h.lifecycle.isQuitting(), true);
});
test("embedded pages and foreign frames cannot request app exit", async () => {
  const h = handler();
  for (const event of [
    { ...h.event, sender: {} },
    { ...h.event, senderFrame: { url: "https://hashsell.com/orders" } },
    { ...h.event, senderFrame: { ...h.event.senderFrame, parent: {} } },
  ])
    await assert.rejects(h.invoke(event, "app-quit"), /IPC não autorizado/);
  assert.equal(h.quits(), 0);
  assert.equal(h.lifecycle.isQuitting(), false);
});
test("sidebar exit is a keyboard-accessible button and requests only ordinary app exit", () => {
  const dom = new JSDOM(
    fs.readFileSync(path.join(__dirname, "../src/ui/index.html"), "utf8"),
    { runScripts: "outside-only" },
  );
  const actions = [];
  dom.window.hashrate = {
    invoke: async (action) => {
      actions.push(action);
      return null;
    },
    onState: () => {},
  };
  dom.window.setInterval = () => 1;
  dom.window.eval(
    fs.readFileSync(path.join(__dirname, "../src/ui/app.js"), "utf8"),
  );
  const button = dom.window.document.querySelector("#app-quit");
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.type, "button");
  assert.equal(button.textContent.trim(), "Sair");
  assert.equal(button.disabled, false);
  button.focus();
  assert.equal(dom.window.document.activeElement, button);
  button.click();
  assert.deepEqual(actions, ["state", "app-quit"]);
  dom.window.close();
});
