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
const openssl =
  process.env.HASHRATE_OPENSSL ||
  (process.platform === "win32"
    ? "E:/laragon/bin/git/mingw64/bin/openssl.exe"
    : "openssl");
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
const { CREATE_ACTION } = require(path.join(source, "creation-guard.cjs"));
const { accountHash } = require(path.join(source, "creation-adapter.cjs"));
const poolId = "11111111-1111-4111-8111-111111111111";
const backend = {
  available: 100,
  delayedForm: true,
  cut: "39.4",
  account: "fixture@example.com",
  orders: [],
  saves: 0,
  quotes: 0,
  wrongPrice: false,
  wrongAction: false,
  loseReceipt: false,
  posts: [],
};
const shell = (body) =>
  '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"></head><body><button aria-label="Conta de ' +
  backend.account +
  '">' +
  backend.account +
  "</button>" +
  body +
  "</body></html>";
const flight = (v) =>
  "<script>self.__next_f=self.__next_f||[];self.__next_f.push(" +
  JSON.stringify([1, "0:" + JSON.stringify(v) + "\n"]) +
  ");</script>";
function newForm() {
  const amount = backend.available.toFixed(2);
  const amountPt = amount.replace(".", ",");
  return shell(
    '<section style="display:none"><div>Não foi possível carregar esta tela<button>Tentar de novo</button></div><form><select name="poolId"><option value="stale">Old pool</option></select></form></section>' +
      flight({
        balances: { availableUsd: backend.available.toFixed(8) },
      }) +
      '<form id="unrelated"></form><form method="post"><input type="hidden" name="$ACTION_REF_1" value=""><input type="hidden" name="$ACTION_1:0" value="meta"><input type="hidden" name="$ACTION_1:1" value="bound"><input type="hidden" name="$ACTION_KEY" value="key">' +
      '<input type="hidden" name="idempotencyKey" value=""><input type="hidden" name="unit" value="PH"><button type="button" id="type-standard">Lance</button><input type="radio" name="type" value="STANDARD" checked><input type="radio" name="type" value="FIXED">' +
      '<select name="poolId"><option value="' +
      poolId +
      '">Pool de teste</option></select><label for="limit">Velocidade máxima, em PH/s</label><input type="text" id="limit"><input type="hidden" name="limit" value="0.0000">' +
      '<label for="price">Seu lance, em US$ por PH/s por dia</label><input type="text" id="price"><input type="hidden" name="price" value="0.0000">' +
      '<div data-slot="field" role="group"><label for="amount">Quanto quer gastar, em US$</label><input type="text" id="amount" value="' +
      amount +
      '"><input type="hidden" name="amount" value="' +
      amount +
      '000000"><p id="cost" data-slot="field-description"><span>Mínimo: US$5,00. Fica reservado na ordem.</span>Sai da carteira: US$' +
      amountPt +
      " (US$" +
      amountPt +
      ' + US$0,00 de taxa de criação)</p></div><dl><dt><button type="button">Taxa de criação</button></dt><dd id="creation-fee">–</dd></dl><button type="button" id="create">Criar ordem</button></form>' +
      String.raw`<script>
 let timer;const form=document.querySelector('form[method="post"]');
 form.querySelector('[name="idempotencyKey"]').value=crypto.randomUUID();
 form.removeAttribute('method');
 form.setAttribute('action', "javascript:throw new Error('A React form was unexpectedly submitted.')");
 for(const field of [...form.elements])if(field.name.startsWith('$ACTION'))field.remove();
 document.querySelector('#type-standard').onclick=()=>document.querySelector('[name="type"][value="STANDARD"]').checked=true;
 const summary=()=>{const amount=Number(form.querySelector('[name="amount"]').value).toFixed(2).replace('.',',');document.querySelector('#cost').textContent='Sai da carteira: US$'+amount+' (US$'+amount+' + US$0,00 de taxa de criação)';};
 const quote=async()=>{try{const p={type:'STANDARD',poolId:form.elements.poolId.value,priceScaled:String(Math.round(Number(form.querySelector('[name="price"]').value)*100000)),limitHash:String(Math.round(Number(form.querySelector('[name="limit"]').value)*1000000000)),amountUsd:form.querySelector('[name="amount"]').value};const r=await fetch('/api/proxy/orders/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});if(r.ok){summary();document.querySelector('#creation-fee').textContent='US$0,00';}}catch{}};
 // The real form asks for a quote immediately. The unarmed guard must deny it;
 // the amount-associated static summary remains available with the DD placeholder.
 setTimeout(quote,0);
 for(const id of ['limit','price','amount'])document.getElementById(id).addEventListener('input',()=>{const number=Number(document.getElementById(id).value.replace(',','.'));form.querySelector('[name="idempotencyKey"]').value='';form.querySelector('[name="'+id+'"]').value=number.toFixed(id==='amount'?2:4);summary();document.querySelector('#creation-fee').textContent='–';clearTimeout(timer);timer=setTimeout(quote,50);});
 document.querySelector('#create').onclick=()=>{const d=document.createElement('div');d.setAttribute('role','dialog');d.innerHTML='<h2>Criar ordem</h2><button type="button">Voltar</button><button type="button">Criar ordem</button>';document.body.append(d);d.querySelectorAll('button')[0].onclick=()=>d.remove();d.querySelectorAll('button')[1].onclick=()=>{form.requestSubmit();d.remove();};};
 form.onsubmit=async e=>{e.preventDefault();const data=new FormData();for(const [k,v] of new FormData(form))data.append('_1_'+k,v);if(${backend.wrongPrice})data.set('_1_price','39450.0000');data.append('0',JSON.stringify([{status:'idle'},'$K1']));try{const r=await fetch('/orders/new',{method:'POST',headers:{'Next-Action':'${backend.wrongAction ? "unknown" : CREATE_ACTION}'},body:data});if(r.ok){const result=await r.json();location.href='/orders/'+result.id;}}catch{}};
 </script>`,
  );
}
const server = https.createServer(
  { key: fs.readFileSync(keyPath), cert: fixtureCert },
  (req, res) => {
    const send = (body) => {
      res.setHeader("Content-Type", "text/html");
      res.end(body);
    };
    const json = (data) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    };
    if (req.method === "POST") {
      let body = "";
      req.on("data", (b) => (body += b));
      req.on("end", () => {
        backend.posts.push(req.url);
        if (req.url === "/api/proxy/orders/quote") {
          backend.quotes++;
          return json({ ok: true });
        }
        if (req.url === "/orders/new") {
          backend.saves++;
          const fields = Object.fromEntries(
            [...body.matchAll(/name="([^"\r\n]+)"\r\n\r\n([^\r\n]*)/g)].map(
              (m) => [m[1], m[2]],
            ),
          );
          const id = "HS-CREATE" + backend.saves;
          const o = {
            code: id,
            type: "STANDARD",
            priceScaled: String(Math.round(Number(fields._1_price) * 100000)),
            limitHash: String(Math.round(Number(fields._1_limit) * 1000000000)),
            amountUsd: Number(fields._1_amount).toFixed(8),
            pool: { id: fields._1_poolId },
            createdAt: new Date().toISOString(),
            balance: fields._1_amount,
          };
          backend.orders.push(o);
          backend.available -= Number(fields._1_amount);
          if (backend.loseReceipt) return req.socket.destroy();
          return json({ id });
        }
        res.statusCode = 403;
        res.end();
      });
      return;
    }
    if (req.url === "/wallet")
      return send(
        shell(
          "<p>Disponível</p><p>US$ " +
            backend.available.toFixed(2).replace(".", ",") +
            "</p>" +
            flight({
              balances: { availableUsd: backend.available.toFixed(8) },
            }),
        ),
      );
    if (req.url === "/orders/new") {
      if (!backend.delayedForm) return send(newForm());
      const html = JSON.stringify(newForm()).replace(/</g, "\\u003c");
      return send(
        shell(
          "<p>Carregando...</p><script>setTimeout(()=>{document.open();document.write(" +
            html +
            ");document.close()},1200)</script>",
        ),
      );
    }
    if (req.url === "/orders")
      return send(
        shell(
          "<table><thead><tr><th>Ordem</th><th>Situação</th><th>Lance</th><th>Limite</th><th>Recebendo</th><th>Saldo</th></tr></thead><tbody>" +
            backend.orders
              .map(
                (o) =>
                  '<tr><td><a href="/orders/' +
                  o.code +
                  '">' +
                  o.code +
                  "</a></td><td>Sem entrega 0 TH/s</td><td>" +
                  String(Number(o.priceScaled) / 100000).replace(".", ",") +
                  "</td><td>1 PH/s</td><td>0 TH/s</td><td>US$ " +
                  o.balance.replace(".", ",") +
                  "</td></tr>",
              )
              .join("") +
            "</tbody></table>" +
            '<a id="new-order" href="/orders/new">Nova ordem</a><script>document.getElementById("new-order").onclick=async(event)=>{event.preventDefault();const response=await fetch("/orders/new");if(!response.ok)return;const html=await response.text();history.pushState(null,"","/orders/new");document.open();document.write(html);document.close();};</script>',
        ),
      );
    if (req.url?.startsWith("/orders/")) {
      const o = backend.orders.find((o) => "/orders/" + o.code === req.url);
      if (o)
        return send(shell(flight({ order: o }) + "<h1>" + o.code + "</h1>"));
    }
    if (req.url === "/painel") return send(shell('<p id="rate">43,00</p>'));
    if (req.url === "/market")
      return send(
        shell(
          '<p id="cut">' +
            backend.cut.replace(".", ",") +
            "</p>" +
            '<nav aria-label="Navegação principal"><a id="orders-entry" href="/orders">Ordens</a></nav><script>document.getElementById("orders-entry").onclick=async(event)=>{event.preventDefault();const response=await fetch("/orders");if(!response.ok)return;const html=await response.text();history.pushState(null,"","/orders");document.open();document.write(html);document.close();};</script>',
        ),
      );
    res.statusCode = 404;
    res.end();
  },
);
const listening = new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    try {
      assert.equal(app.isReady(), false);
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
    } catch (e) {
      reject(e);
    }
  });
});
Promise.all([app.whenReady(), listening])
  .then(async () => {
    const ses = session.fromPartition("isolated-creation");
    await ses.setProxy({ mode: "direct" });
    ses.setCertificateVerifyProc((request, cb) => {
      let valid = false;
      try {
        valid =
          fixtureHosts.has(request.hostname) &&
          new X509Certificate(request.certificate.data).fingerprint256 ===
            fixtureFingerprint;
      } catch {}
      cb(valid ? 0 : -2);
    });
    const views = {};
    for (const key of [
      "rental",
      "market",
      "orders",
      "editor",
      "reconcile",
      "wallet",
      "creation",
      "creationEvidence",
    ]) {
      views[key] = new WebContentsView({
        webPreferences: {
          session: ses,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      views[key].setBounds({ x: 0, y: 0, width: 1440, height: 960 });
    }
    const store = new Store(path.join(profile, "business"));
    const config = structuredClone(store.state.config);
    config.rental.selector = "#rate";
    config.market.selector = "#cut";
    config.market.unit = "PH";
    config.creation = {
      ...config.creation,
      enabled: true,
      account: accountHash(backend.account),
      funding: "fixed",
      minimumBalance: "5",
      amount: "25",
      speedPH: "1",
      destination: poolId,
      allowActive: false,
    };
    store.saveConfig(config);
    const adapter = new BrowserAdapter(views);
    let monitor = new Monitor(store, adapter);
    const account = config.creation.account;
    try {
      const pools = await adapter.creation.options({ poolsOnly: true });
      assert.equal(pools.pools.length, 1);
      assert.equal(pools.pools[0].id, poolId);
      const options = await adapter.creation.options();
      assert.equal(options.account, account);
      assert.equal(options.pools[0].id, poolId);
      assert.equal(options.creationFeeUsd, "0.00");
      assert.equal(
        backend.quotes,
        0,
        "initial unarmed quote cannot reach the server",
      );
      assert.ok(
        adapter.creation.guard
          .diagnostics()
          .some(
            (item) =>
              item.pathname === "/api/proxy/orders/quote" &&
              item.phase === "none",
          ),
      );
      assert.equal(Object.hasOwn(options, "feeSummary"), false);
      await monitor.startAutomatic();
      assert.equal(
        backend.saves,
        1,
        JSON.stringify({
          status: monitor.creation.status,
          history: store.state.history.slice(-3),
        }),
      );
      assert.equal(store.state.creations.pending[account].phase, "submitted");
      assert.equal(backend.available, 75);
      monitor.stop();
      const restored = new Store(path.join(profile, "business"));
      monitor = new Monitor(restored, adapter);
      await monitor.startAutomatic();
      assert.equal(backend.saves, 1);
      assert.equal(restored.state.creations.pending[account], undefined);
      assert.equal(restored.state.history.at(-1).type, "creation-confirmed");
      await monitor.tick();
      assert.equal(
        backend.saves,
        1,
        "confirmation must not create a duplicate",
      );
      restored.commit((s) => {
        s.creations.lastCreated[account] = 0;
      });
      await monitor.tick();
      assert.equal(backend.saves, 1, "active orders prevent another creation");
      restored.commit((s) => {
        s.config.creation.allowActive = true;
        s.creations.lastCreated[account] = 0;
      });
      backend.wrongPrice = true;
      await monitor.tick();
      assert.equal(backend.saves, 1, "1000x price must not reach server");
      assert.equal(restored.state.creations.pending[account], undefined);
      assert.equal(restored.state.history.at(-1).type, "creation-not-sent");
      backend.wrongPrice = false;
      backend.wrongAction = true;
      restored.commit((s) => (s.creations.retryAfter[account] = 0));
      await monitor.tick();
      assert.equal(
        backend.saves,
        1,
        "unknown server action must not reach server",
      );
      assert.equal(restored.state.creations.pending[account], undefined);
      backend.wrongAction = false;
      backend.cut = "40";
      restored.commit((s) => (s.creations.retryAfter[account] = 0));
      await monitor.tick();
      assert.equal(
        backend.saves,
        1,
        "market above margin ceiling cannot create",
      );
      backend.cut = "39.4";
      backend.loseReceipt = true;
      await monitor.tick();
      assert.equal(backend.saves, 2);
      assert.equal(
        restored.state.creations.pending[account].phase,
        "uncertain",
      );
      monitor.stop();
      backend.loseReceipt = false;
      const restartedStore = new Store(path.join(profile, "business"));
      monitor = new Monitor(restartedStore, adapter);
      await monitor.startAutomatic();
      assert.equal(backend.saves, 2, "lost response must never resend");
      assert.equal(restartedStore.state.creations.pending[account], undefined);
      assert.equal(
        restartedStore.state.history.at(-1).type,
        "creation-confirmed",
      );
      backend.account = "another@example.com";
      restartedStore.commit((s) => (s.creations.lastCreated[account] = 0));
      await monitor.tick();
      assert.equal(
        backend.saves,
        2,
        "another account cannot use saved creation policy",
      );
      backend.account = "fixture@example.com";
      restartedStore.commit((s) => {
        s.config.creation.sizing = "duration";
        s.config.creation.hours = "9";
        s.config.creation.speedPH = "";
        s.creations.lastCreated[account] = 0;
        s.creations.retryAfter[account] = 0;
      });
      await monitor.tick();
      assert.equal(
        backend.saves,
        3,
        "duration mode must create through guarded DOM",
      );
      const durationOrder = backend.orders.at(-1);
      const Decimal = require("decimal.js");
      const actualHours = new Decimal(durationOrder.amountUsd)
        .mul(24)
        .div(
          new Decimal(durationOrder.priceScaled)
            .div(100000)
            .mul(new Decimal(durationOrder.limitHash).div(1000000000))
            .mul("1.03"),
        );
      assert.ok(
        actualHours.gte(9) && actualHours.lt("9.01"),
        "duration must include fees and use current bid",
      );
      console.log(
        "CREATION DOM PASS: native WebContentsView, multipart/Next-Action guard, two DOM confirmations, exact available funds, account-bound pools, restart reconciliation, lost receipt without duplicate, 1000x and wrong action blocked, margin respected; external requests=0",
      );
    } finally {
      monitor.stop();
      for (const v of Object.values(views)) v.webContents.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      app.quit();
    }
  })
  .catch((e) => {
    console.error(e);
    server.close();
    app.exit(1);
  });
