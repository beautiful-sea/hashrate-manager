// Native Electron transport test. Every HTTPS response is served in-process;
// this session has no account cookies and never contacts Hashsell.
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { RequestGuard } = require("../src/request-guard.cjs");
const { authorizeBid, encodeBid } = require("../src/bid-safety.cjs");
const { DEFAULTS } = require("../src/config.cjs");
app.setPath(
  "userData",
  fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-net-test-")),
);
app
  .whenReady()
  .then(async () => {
    const ses = session.fromPartition("isolated-network-smoke");
    let postCount = 0;
    await ses.protocol.handle("https", (req) => {
      if (req.method === "POST") {
        postCount++;
        return new Response("{}", {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        "<!doctype html><title>Controlled fixture only</title>",
        { headers: { "Content-Type": "text/html" } },
      );
    });
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    const guard = new RequestGuard(win.webContents);
    await win.loadURL("https://hashsell.com/orders/HS-TEST");
    const config = structuredClone(DEFAULTS);
    config.tick = "0.0001";
    config.buffer = "0.001";
    const at = Date.now();
    const decision = {
      id: "HS-TEST",
      href: "https://hashsell.com/orders/HS-TEST",
      current: "39.3",
      target: "39.411",
    };
    const sources = {
      rental: { at, rate: "43" },
      market: { at, cut: "39.41" },
      orders: {
        at,
        items: [{ ...decision, bid: "39.3", balance: "100", active: true }],
      },
    };
    const authority = authorizeBid(decision, config, sources);
    const expected = {
      authority,
      prepared: {
        id: decision.id,
        href: decision.href,
        value: encodeBid(decision.target, config.editor),
      },
      path: "/api/proxy/orders/controlled-fixture/update",
      limitHash: "55000000000",
    };
    const body = { priceScaled: "3941100", limitHash: "55000000000" };
    const send = (payload) =>
      win.webContents.executeJavaScript(
        `fetch(${JSON.stringify(expected.path)},{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(payload))}}).then(()=>true,()=>false)`,
      );
    assert.equal(await send(body), false);
    assert.equal(postCount, 0);
    guard.arm({ ...expected, dryRun: true });
    assert.equal(await send(body), false);
    assert.equal(postCount, 0);
    assert.equal(guard.result.blockedProbe, true);
    guard.arm(expected);
    assert.equal(await send(body), true);
    assert.equal(postCount, 1);
    assert.equal(guard.result.admitted, true);
    assert.equal(await send(body), false);
    assert.equal(postCount, 1);
    guard.arm(expected);
    assert.equal(await send({ ...body, priceScaled: "3941100000" }), false);
    assert.equal(postCount, 1);
    console.log(
      "NATIVE NETWORK PASS: default deny, dry probe blocked, exact payload admitted once to local handler, 1000x blocked; external requests=0",
    );
    win.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
