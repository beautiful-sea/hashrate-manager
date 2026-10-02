// Full executor test using Chromium and locally served HTTPS fixtures only.
// No production profile, cookies or external transport is used.
const { app, WebContentsView, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const https = require("node:https");
const { X509Certificate } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const source = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "..", "src");
const { BrowserAdapter, executeEditor } = require(
  path.join(source, "adapters.cjs"),
);
const { UPDATE_ACTION } = require(path.join(source, "hashsell-form.cjs"));
const { Monitor } = require(path.join(source, "monitor.cjs"));
const { Store } = require(path.join(source, "store.cjs"));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hashrate-dom-flow-"));
app.setPath("userData", profile);
app.commandLine.appendSwitch("no-proxy-server");
const keyPath = path.join(profile, "fixture-key.pem");
const certPath = path.join(profile, "fixture-cert.pem");
const openssl = "E:/laragon/bin/git/mingw64/bin/openssl.exe";
execFileSync(
  openssl,
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=Hashrate Manager isolated fixture",
    "-addext",
    "subjectAltName=DNS:hashsell.com,DNS:rentalhash.com",
  ],
  { stdio: "pipe", windowsHide: true },
);
const fixtureCert = fs.readFileSync(certPath);
const fixtureFingerprint = new X509Certificate(fixtureCert).fingerprint256;
const fixtureHosts = new Set(["hashsell.com", "rentalhash.com"]);
const backend = {
  bid: "39.3",
  cut: "39410",
  rate: "43",
  saves: [],
  previews: 0,
  wrongPrice: false,
  wrongAction: false,
  additionalStep: false,
  marketLoads: 0,
  marketStatus: 200,
  rentalLoads: 0,
  slowResourceFinished: false,
};
const root = "/api/proxy/orders/11111111-2222-4333-8444-555555555555";
const br = (v) => String(v).replace(".", ",");
function html(body) {
  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"></head><body>${body}</body></html>`,
    { headers: { "Content-Type": "text/html" } },
  );
}
function editor() {
  return html(`<button id="open">Ajustar lance</button><div role="dialog" hidden>
    <h2>Ajustar lance e limite</h2><form>
    <label for="adjust-price">Lance, em US$ por PH/s por dia</label><input type="text" id="adjust-price" value="${br(backend.bid)}">
    <label for="adjust-limit">Limite, em PH/s</label><input type="text" id="adjust-limit" value="55,0000">
    <input type="hidden" name="unit" value="PH"><input type="hidden" name="price" value="${backend.bid}"><input type="hidden" name="limit" value="55">
    <button id="save" type="button" disabled>Salvar ajuste</button><div role="alert"></div></form></div>
    <script>
    const dialog=document.querySelector('[role="dialog"]'), input=document.querySelector('#adjust-price'), save=document.querySelector('#save');
    let model=null;
    document.querySelector('#open').onclick=()=>dialog.hidden=false;
    input.addEventListener('input',async()=>{
      save.disabled=true; model=null;
      const candidate={priceScaled:String(Math.round(Number(input.value.replace(',','.'))*100000)),limitHash:'55000000000'};
      try {
        const result=await fetch('${root}/simulate',{method:'POST',body:JSON.stringify(candidate)});
        if(result.ok) {model=candidate; document.querySelector('[name="price"]').value=String(Number(candidate.priceScaled)/100000); save.disabled=false;}
      } catch {};
    });
    input.addEventListener('blur',()=>{input.value=Number(input.value.replace(',','.')).toFixed(4).replace('.',',')});
    window.fixtureClicks={first:0,confirmation:0};
    document.querySelector('form').addEventListener('submit',async event=>{
      event.preventDefault();
      const data=new FormData();
      for(const [name,value] of new FormData(event.target)) data.append('_1_'+name,value);
      if(${backend.wrongPrice})data.set('_1_price',String(Number(data.get('_1_price'))*1000));
      data.append('0',JSON.stringify(['11111111-2222-4333-8444-555555555555',{status:'idle'},'$K1']));
      const headers={'Next-Action':'${backend.wrongAction ? "0000000000000000000000000000000000000000" : UPDATE_ACTION}',Accept:'text/x-component'};
      try {await fetch(location.href,{method:'POST',headers,body:data});}catch{}
      // A repeated site request must not result in a second mutation.
      try {await fetch(location.href,{method:'POST',headers,body:data});}catch{}
    });
    function send(){
      window.fixtureClicks.confirmation++;
      document.querySelector('form').requestSubmit();
    }
    save.onclick=()=>{
      window.fixtureClicks.first++;
      if(!model)return;
      if(${backend.additionalStep}) {
        dialog.setAttribute('role','alertdialog');
        dialog.innerHTML='<h2>Confirmar alteração</h2><p>Confira o novo lance.</p><button>Confirmar</button><button>Voltar</button>';
        return;
      }
      dialog.setAttribute('aria-hidden','true'); dialog.inert=true;
      const confirmation=document.createElement('div');
      confirmation.setAttribute('role','alertdialog');
      confirmation.innerHTML='<h2>Ajustar lance e limite</h2><p>Passa a valer no próximo tick e muda quanto esta ordem recebe e quanto ela gasta por dia.</p><p>Reduzir tem intervalo de espera: depois de salvar, a próxima redução só vale mais tarde.</p><button type="button">Voltar</button><button type="button">Salvar ajuste</button>';
      document.body.append(confirmation);
      confirmation.querySelectorAll('button')[1].onclick=send;
    };
    </script>`);
}
async function fixtureResponse(req) {
  const url = new URL(req.url);
  if (req.method !== "GET") {
    if (url.pathname === root + "/simulate") {
      JSON.parse(await req.text());
      backend.previews++;
      await new Promise((r) => setTimeout(r, 120));
      return new Response("{}", {
        headers: { "Content-Type": "application/json" },
      });
    }
    assert.equal(url.pathname, "/orders/HS-TEST");
    assert.equal(req.headers.get("Next-Action"), UPDATE_ACTION);
    const data = await req.formData();
    assert.equal(
      data.get("0"),
      JSON.stringify([
        "11111111-2222-4333-8444-555555555555",
        { status: "idle" },
        "$K1",
      ]),
    );
    const payload = {
      priceScaled: String(Math.round(Number(data.get("_1_price")) * 100000)),
      limitHash: String(Number(data.get("_1_limit")) * 1e9),
    };
    backend.saves.push(payload);
    backend.bid = String(Number(payload.priceScaled) / 100000);
    return new Response("{}", {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.pathname === "/fixture-slow.png") {
    await new Promise((r) => setTimeout(r, 9000));
    backend.slowResourceFinished = true;
    return new Response("", { headers: { "Content-Type": "image/png" } });
  }
  if (url.hostname === "rentalhash.com") {
    if (url.pathname === "/painel/fidelidade")
      return html("<p>Nível atual</p><p>Basic</p><p>Bônus atual</p><p>0%</p>");
    backend.rentalLoads++;
    return html(
      `<p>Você está no nível Basic.</p><div>1 PH/s US$ ${br(backend.rate)} por dia</div>${backend.rentalLoads === 1 ? '<img src="/fixture-slow.png">' : ""}`,
    );
  }
  if (url.pathname === "/market") {
    backend.marketLoads++;
    if (backend.marketStatus !== 200)
      return new Response("Não foi possível carregar esta tela", {
        status: backend.marketStatus,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Retry-After": "120",
        },
      });
    if (backend.marketLoads === 1)
      return html(
        "<h2>Não foi possível carregar esta tela</h2><p>O servidor não respondeu como esperado.</p>",
      );
    if (backend.marketLoads === 2)
      return html(
        `<div id="market">Carregando…</div><script>setTimeout(()=>document.querySelector('#market').innerHTML='<span>Preço de corte</span><strong>US$ ${br(backend.cut)} /EH/s/dia</strong>',1000)</script>`,
      );
    return html(
      `<div><span>Preço de corte</span><strong>US$ ${br(backend.cut)} /EH/s/dia</strong></div>`,
    );
  }
  if (url.pathname === "/orders")
    return html(
      `<table><thead><tr><th>Ordem</th><th>Situação</th><th>Lance</th></tr></thead><tbody><tr><td><a href="/orders/HS-TEST">HS-TEST</a></td><td>Entregando 55 PH/s</td><td>US$ ${br(backend.bid)} /PH/s/dia</td><td>55 PH/s</td><td>US$ 2000</td><td>US$ 500</td></tr></tbody></table>`,
    );
  assert.equal(url.pathname, "/orders/HS-TEST");
  return editor();
}
// Use a real TLS socket: Electron custom protocols bypass onBeforeSendHeaders.
// All fixture names resolve exclusively to this listener; every other name fails.
const server = https.createServer(
  { key: fs.readFileSync(keyPath), cert: fixtureCert },
  async (incoming, outgoing) => {
    try {
      assert.equal(incoming.socket.remoteAddress, "127.0.0.1");
      assert.ok(fixtureHosts.has(incoming.headers.host));
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const init = { method: incoming.method, headers: incoming.headers };
      if (!["GET", "HEAD"].includes(incoming.method)) {
        init.body = Buffer.concat(chunks);
        init.duplex = "half";
      }
      const response = await fixtureResponse(
        new Request("https://" + incoming.headers.host + incoming.url, init),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error("Fixture request failed:", error);
      outgoing.writeHead(500);
      outgoing.end("Isolated fixture failure");
    }
  },
);
const listening = new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    try {
      assert.equal(
        app.isReady(),
        false,
        "fixture routing must be set before Electron readiness",
      );
      const port = server.address().port;
      app.commandLine.appendSwitch(
        "host-resolver-rules",
        "MAP hashsell.com 127.0.0.1:" +
          port +
          ", MAP rentalhash.com 127.0.0.1:" +
          port +
          ", MAP * ~NOTFOUND",
      );
      resolve();
    } catch (error) {
      reject(error);
    }
  });
});
Promise.all([app.whenReady(), listening])
  .then(async () => {
    const ses = session.fromPartition("isolated-dom-flow");
    await ses.setProxy({ mode: "direct" });
    ses.setCertificateVerifyProc((request, callback) => {
      let trusted = false;
      try {
        trusted =
          fixtureHosts.has(request.hostname) &&
          new X509Certificate(request.certificate.data).fingerprint256 ===
            fixtureFingerprint;
      } catch {}
      callback(trusted ? 0 : -2);
    });
    const views = {};
    for (const kind of ["rental", "market", "orders", "editor"])
      views[kind] = new WebContentsView({
        webPreferences: {
          session: ses,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
    for (const view of Object.values(views))
      view.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
    const store = new Store(path.join(profile, "business"));
    const config = structuredClone(store.state.config);
    config.cooldownSeconds = 0;
    config.decreaseCycles = 1;
    store.saveConfig(config);
    const adapter = new BrowserAdapter(views);
    const monitor = new Monitor(store, adapter);
    try {
      await monitor.start();
      assert.equal(
        backend.slowResourceFinished,
        false,
        "reader must obtain fresh rate before slow image finishes",
      );

      assert.equal(
        backend.marketLoads,
        2,
        "one reload recovers a site error, then waits for hydration without reloading again",
      );
      assert.equal(monitor.snapshot().automationReady, true);
      assert.equal(
        monitor.result.blocked,
        null,
        JSON.stringify({
          errors: monitor.errors,
          market: await views.market.webContents.executeJavaScript(
            "document.body.innerText",
          ),
        }),
      );
      await assert.rejects(
        executeEditor(
          views.orders.webContents,
          function () {
            throw Error("Falha DOM controlada");
          },
          [],
          "Teste do renderer",
          1000,
        ),
        /Teste do renderer: Falha DOM controlada/,
      );
      monitor.live();
      await monitor.tick();
      assert.equal(
        backend.saves.length,
        1,
        JSON.stringify(store.state.history.slice(-4)),
      );
      assert.equal(backend.bid, "39.46");
      assert.deepEqual(
        await views.editor.webContents.executeJavaScript(
          "window.fixtureClicks",
        ),
        { first: 1, confirmation: 1 },
      );
      assert.equal(backend.saves[0].limitHash, "55000000000");
      assert.equal(Object.keys(store.state.pending).length, 0);
      assert.equal(store.state.history.at(-1).type, "confirmed");
      backend.cut = "39200";
      await monitor.tick();
      assert.equal(backend.saves.length, 2);
      assert.equal(backend.bid, "39.25");
      assert.equal(store.state.history.at(-1).type, "confirmed");
      backend.cut = "39410";
      backend.wrongPrice = true;
      await monitor.tick();
      assert.equal(
        backend.saves.length,
        2,
        "1000x payload must not reach even the local backend",
      );
      assert.equal(monitor.mode, "live");
      assert.ok(Object.values(store.state.memory)[0].retryAfter > Date.now());
      assert.equal(Object.keys(store.state.pending).length, 0);
      assert.equal(store.state.history.at(-1).type, "not-sent");
      backend.wrongPrice = false;
      store.commit((state) => {
        for (const memory of Object.values(state.memory)) memory.retryAfter = 0;
      });
      for (const memory of Object.values(monitor.memory)) memory.retryAfter = 0;
      backend.wrongAction = true;
      await monitor.tick();
      assert.equal(
        backend.saves.length,
        2,
        "invalid Next-Action must be blocked before the TLS backend",
      );
      assert.equal(store.state.history.at(-1).type, "not-sent");

      backend.wrongAction = false;
      store.commit((state) => {
        for (const memory of Object.values(state.memory)) memory.retryAfter = 0;
      });
      for (const memory of Object.values(monitor.memory)) memory.retryAfter = 0;
      backend.additionalStep = true;
      await monitor.tick();
      assert.equal(backend.saves.length, 2);
      assert.equal(store.state.history.at(-1).type, "not-sent");
      assert.equal(
        store.state.history.at(-1).editorState.kind,
        "additional-step",
      );
      assert.equal(
        store.state.history.at(-1).editorState.dialogs[0].title,
        "Confirmar alteração",
      );
      backend.additionalStep = false;
      store.commit((state) => {
        for (const memory of Object.values(state.memory)) memory.retryAfter = 0;
      });
      for (const memory of Object.values(monitor.memory)) memory.retryAfter = 0;
      const stage = adapter.stage.bind(adapter);
      adapter.stage = async (...args) => {
        await stage(...args);
        monitor.disableAdjustments();
      };
      await monitor.tick();
      assert.equal(
        backend.saves.length,
        2,
        "pause between preview and click prevents saving",
      );
      assert.equal(Object.keys(store.state.pending).length, 0);
      monitor.stop();
      backend.marketStatus = 403;
      let loadsBefore = backend.marketLoads;
      await assert.rejects(adapter.read("market", config), /HTTP 403/);
      assert.equal(backend.marketLoads, loadsBefore + 1);
      backend.marketStatus = 429;
      loadsBefore = backend.marketLoads;
      await assert.rejects(adapter.read("market", config), /HTTP 429/);
      await assert.rejects(adapter.read("market", config), /HTTP 429/);
      assert.equal(backend.marketLoads, loadsBefore + 1);
      assert.ok(adapter.readBackoff.get("hashsell") > Date.now() + 118000);
      console.log(
        "DOM FLOW PASS: production WebContentsView; two-step DOM Save and requestSubmit multipart/Next-Action, inert background rechecked, increase/decrease, single dispatch, readback, 1000x and wrong action blocked by native webRequest, unknown confirmation rejected, pause respected; external requests=0",
      );
    } finally {
      monitor.stop();
      for (const view of Object.values(views)) view.webContents.close();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    server.closeAllConnections();
    server.close();
    app.exit(1);
  });
