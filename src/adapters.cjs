const { CreationAdapter, accountHash } = require("./creation-adapter.cjs");
const { creationScript } = require("./creation-dom.cjs");
const { reconciliationScript } = require("./reconciliation.cjs");
const D = require("decimal.js");
const { parseNumber, pricePerPH } = require("./engine.cjs");
const {
  encodeBid,
  verifyPrepared,
  verifyBidText,
} = require("./bid-safety.cjs");
const { RequestGuard } = require("./request-guard.cjs");
const {
  openHashsellEditor,
  inspectHashsellEditor,
  fillHashsellEditor,
  commitHashsellEditor,
  commitHashsellConfirmation,
  readHashsellEditorState,
  editorScript,
} = require("./hashsell-editor.cjs");
const { readScript } = require("./dom.cjs");
const HOSTS = {
  hashsell: "https://hashsell.com",
  rental: "https://rentalhash.com",
};
function allowed(url, site) {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      ["hashsell", "rental"].includes(site) &&
      [
        new URL(HOSTS[site]).hostname,
        `www.${new URL(HOSTS[site]).hostname}`,
      ].includes(u.hostname) &&
      !u.port
    );
  } catch {
    return false;
  }
}
function normalizeOrders(raw, c) {
  const ids = new Set();
  return raw.map((o) => {
    if (ids.has(o.id)) throw Error("IDs duplicados: leitura rejeitada.");
    ids.add(o.id);
    if (o.href && !allowed(o.href, "hashsell"))
      throw Error("Link da ordem fora da Hashsell.");
    const clean = o.status.replace(/\d[\d.,]*\s*[TPE]H\s*\/\s*s/gi, "").trim();
    const active =
      /^(Entregando|Delivering|Aguardando|Waiting|Sem entrega|Not delivering|Below cut|Abaixo do corte)(\s|$)/i.test(
        clean,
      );
    return {
      id: o.id,
      bid: pricePerPH(o.bid, c.unit, o.locale || c.locale),
      speed: o.speed,
      balance: parseNumber(o.balance, o.locale || c.locale),
      status: o.status,
      active,
      delivering: /^(Entregando|Delivering)(\s|$)/i.test(clean),
      href: o.href,
    };
  });
}
async function deadline(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error(`${label}: tempo esgotado.`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function executeEditor(wc, fn, args, label, timeoutMs) {
  let result;
  try {
    // Return exceptions as data: Electron otherwise discards the actual DOM error.
    // This wrapper executes once and must never retry a Save click.
    const code = `(async () => { try { return {ok:true,value:await (${editorScript(fn, ...args)})}; } catch(error) { return {ok:false,message:String(error?.message || "Falha no formulário").slice(0,500)}; } })()`;
    result = await deadline(wc.executeJavaScript(code), timeoutMs, label);
  } catch (error) {
    const message = /Script failed to execute/.test(error.message)
      ? "A página interrompeu a execução; a causa original não ficou disponível."
      : error.message;
    throw Error(`${label}: ${message}`);
  }
  if (result?.ok !== true)
    throw Error(
      `${label}: ${result?.message || "Resposta inválida do formulário."}`,
    );
  return result.value;
}
class BrowserAdapter {
  constructor(views, options = {}) {
    this.views = views;
    this.liveReady = !options.blockAll;
    // No editor mutation can reach the network without an exact, one-use grant.
    this.requestGuard = new RequestGuard(views.editor.webContents, options);
    this.creation = views.creation ? new CreationAdapter(this, options) : null;
    this.watchReadResponses();
    if (views.reconcile)
      this.requestGuard.readOnlyIds.add(views.reconcile.webContents.id);
  }
  watchReadResponses() {
    this.readResponses = new Map();
    this.readBackoff = new Map();
    const sessions = new Set();
    for (const kind of [
      "rental",
      "market",
      "orders",
      "reconcile",
      "wallet",
      "creationEvidence",
      "creation",
    ].filter((k) => this.views[k])) {
      const wc = this.views[kind].webContents;
      this.readResponses.set(wc.id, { kind, since: Infinity, items: [] });
      sessions.add(wc.session);
    }
    // Use a distinct event: replacing onCompleted/onErrorOccurred would disable
    // the financial request guard. No headers, bodies or full URLs are retained.
    for (const ses of sessions)
      ses.webRequest.onResponseStarted((details) => {
        const read = this.readResponses.get(details.webContentsId);
        const site = read?.kind === "rental" ? "rental" : "hashsell";
        if (
          !read ||
          details.timestamp < read.since ||
          !Number.isFinite(details.timestamp) ||
          !allowed(details.url, site) ||
          !["mainFrame", "xhr", "script"].includes(details.resourceType) ||
          !Number.isInteger(details.statusCode)
        )
          return;
        if (details.resourceType === "mainFrame" || details.statusCode >= 400) {
          read.items.push({
            type: details.resourceType,
            status: details.statusCode,
          });
          read.items = read.items.slice(-6);
        }
        if (details.statusCode === 429) {
          const header = Object.entries(details.responseHeaders || {}).find(
            ([key]) => key.toLowerCase() === "retry-after",
          )?.[1]?.[0];
          const now = Date.now();
          const delay = /^\d+$/.test(header || "")
            ? Number(header) * 1000
            : Date.parse(header || "") - now;
          const until =
            now + Math.max(60000, Number.isFinite(delay) ? delay : 0);
          this.readBackoff.set(
            site,
            Math.max(this.readBackoff.get(site) || 0, until),
          );
        }
      });
  }
  assertReadAvailable(site) {
    const until = this.readBackoff?.get(site) || 0;
    if (until > Date.now())
      throw Error(
        `HTTP 429: limite de consultas da plataforma. Nova leitura após ${new Date(until).toISOString()}.`,
      );
  }
  responseSummary(wc) {
    return (
      this.readResponses
        ?.get(wc.id)
        ?.items.map((item) => `${item.type} HTTP ${item.status}`)
        .join(", ") || "HTTP não observado"
    );
  }
  async navigate(wc, url, site, timeoutMs = 20000, readOnly = false) {
    if (!allowed(url, site)) throw Error("URL não permitida.");
    let onReady;
    // Readers need the new document, not completion of images/analytics.
    // Editors retain the full-load requirement. No cached data is reused.
    const domReady = readOnly
      ? new Promise((resolve, reject) => {
          onReady = () =>
            allowed(wc.getURL(), site)
              ? resolve()
              : reject(Error("Redirecionamento fora da plataforma."));
          wc.once("dom-ready", onReady);
        })
      : null;
    try {
      const loaded = wc.loadURL(url, {
        extraHeaders: "Cache-Control: no-cache\nPragma: no-cache\n",
      });
      await deadline(
        domReady ? Promise.race([loaded, domReady]) : loaded,
        timeoutMs,
        "Carregamento",
      );
      if (!allowed(wc.getURL(), site))
        throw Error("Redirecionamento fora da plataforma.");
    } catch (e) {
      wc.stop();
      throw e;
    } finally {
      if (onReady) wc.removeListener("dom-ready", onReady);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  async read(kind, config) {
    const site = kind === "rental" ? "rental" : "hashsell";
    this.assertReadAvailable(site);
    const wc = this.views[kind].webContents;
    const started = Date.now(),
      expires = started + 15000;
    let requestedAt, response;
    for (let attempt = 0; attempt < 2 && Date.now() < expires; attempt++) {
      this.assertReadAvailable(site);
      requestedAt = Date.now();
      const diagnostics = this.readResponses?.get(wc.id);
      if (diagnostics) {
        diagnostics.since = requestedAt;
        diagnostics.items = [];
      }
      try {
        await this.navigate(
          wc,
          new URL(config[kind].path, HOSTS[site]).href,
          site,
          Math.max(1, Math.min(7000, expires - Date.now())),
          true,
        );
      } catch (error) {
        if (
          attempt === 0 &&
          Date.now() + 1000 < expires &&
          /tempo esgotado|ERR_(?:TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|NETWORK_CHANGED)/.test(
            error.message,
          )
        ) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        throw Error(`${error.message} [${kind}; ${this.responseSummary(wc)}]`);
      }
      const domExpires = Math.min(expires, Date.now() + 5000);
      do {
        // WebContents.executeJavaScript waits for full load; the ready main frame does not.
        response = await deadline(
          (wc.mainFrame || wc).executeJavaScript(
            readScript(kind, config[kind]),
          ),
          Math.max(1, Math.min(1500, domExpires - Date.now())),
          "Leitura da página",
        );
        this.assertReadAvailable(site);
        if (
          !response?.ok &&
          diagnostics?.items.some((item) => [401, 403].includes(item.status))
        ) {
          throw Error(
            `Acesso recusado durante a leitura; confira a sessão e as restrições da plataforma. [${kind}; ${this.responseSummary(wc)}]`,
          );
        }
        if (response?.ok || response?.code !== "NOT_READY") break;
        await new Promise((r) => setTimeout(r, 200));
      } while (Date.now() < domExpires);
      if (
        response?.ok ||
        !["NOT_READY", "SITE_UNAVAILABLE"].includes(response?.code)
      )
        break;
      if (attempt === 0 && Date.now() + 1000 < expires)
        await new Promise((r) => setTimeout(r, 500));
    }
    if (!response?.ok) {
      throw Error(
        `${response?.error || "Resposta de leitura inválida."} [${response?.path || kind}; ${response?.code || "INVALID_DATA"}; ${((Date.now() - started) / 1000).toFixed(1)}s; ${this.responseSummary(wc)}; tabelas=${response?.tables ?? "?"}]`,
      );
    }
    const raw = response.value;
    if (kind === "orders") {
      let account = null;
      try {
        const identity = await wc.executeJavaScript(creationScript("identity"));
        if (identity.ok) account = accountHash(identity.value.account);
      } catch {}
      return {
        at: requestedAt,
        account,
        items: normalizeOrders(raw, config.orders),
      };
    }
    return {
      at: requestedAt,
      [kind === "rental" ? "rate" : "cut"]: pricePerPH(
        raw.value,
        raw.detected ? (kind === "rental" ? "PH" : "EH") : config[kind].unit,
        raw.detected ? raw.locale : config[kind].locale,
      ),
      detected: raw.detected,
    };
  }
  async checkPending(intent, config) {
    this.assertReadAvailable("hashsell");
    const wc = this.views.reconcile?.webContents;
    if (!wc) throw Error("Página de conferência indisponível.");
    const href = "https://hashsell.com/orders/" + intent.id;
    if (intent.href !== href) throw Error("Link da pendência não confere.");
    const checkedAt = Date.now();
    const diagnostic = this.readResponses.get(wc.id);
    diagnostic.since = checkedAt;
    diagnostic.items = [];
    await this.navigate(wc, href, "hashsell", 12000, true);
    for (let attempt = 0; attempt < 6; attempt++) {
      if (
        diagnostic.items.some((d) => d.type === "mainFrame" && d.status >= 400)
      )
        throw Error(this.responseSummary(wc));
      const r = await deadline(
        wc.mainFrame.executeJavaScript(reconciliationScript(intent)),
        2000,
        "Conferência da ordem",
      );
      if (r?.ok) {
        const raw = r.value;
        const current = raw.priceScaled
          ? new D(raw.priceScaled).div(100000).toFixed()
          : pricePerPH(raw.value, raw.unit, "pt-BR");
        return {
          intentId: intent.intentId,
          id: raw.id,
          href: raw.href,
          current,
          checkedAt,
          source: raw.source,
          exact: !!raw.priceScaled,
        };
      }
      if (attempt === 5)
        throw Error(r?.error || "Detalhe da ordem indisponível.");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  async prepare(decision, config) {
    if (!decision.href) throw Error("Link da ordem ausente.");
    const wc = this.views.editor.webContents;
    await this.navigate(wc, decision.href, "hashsell");
    if (config.editor.kind === "hashsell-dom") {
      if (config.editor.locale !== "pt-BR")
        throw Error(
          "O modal observado exige formato pt-BR; configuração de edição não validada.",
        );
      await executeEditor(
        wc,
        openHashsellEditor,
        [decision.id],
        "Abertura do formulário",
        5000,
      );
      await new Promise((r) => setTimeout(r, 500));
      const info = await executeEditor(
        wc,
        inspectHashsellEditor,
        [decision.id],
        "Leitura do formulário",
        5000,
      );
      if (
        info.unit !== config.editor.unit ||
        !new D(pricePerPH(info.value, info.unit, "pt-BR")).eq(decision.current)
      )
        throw Error("Unidade ou lance atual diverge no modal.");
      return {
        ...info,
        original: info.value,
        value: encodeBid(decision.target, config.editor),
        kind: "hashsell-react",
      };
    }
    throw Error("Adaptador de edição não suportado; use hashsell-dom.");
  }
  cancel() {
    this.requestGuard.disarm();
  }
  async stage(prepared, authority, isCurrent) {
    verifyPrepared(prepared, authority);
    const wc = this.views.editor.webContents;
    if (!isCurrent() || wc.getURL() !== prepared.href)
      throw Error("Ajuste cancelado ou ordem alterada.");
    const limitHash = new D(parseNumber(prepared.limit, "pt-BR")).mul(
      { TH: "1000000", PH: "1000000000", EH: "1000000000000" }[prepared.unit],
    );
    if (!limitHash.isInteger() || limitHash.lte(0))
      throw Error("Limite de velocidade inválido.");
    this.requestGuard.armPreview(
      prepared,
      authority,
      limitHash.toFixed(0),
      isCurrent,
    );
    try {
      await executeEditor(
        wc,
        fillHashsellEditor,
        [{ ...prepared, authority }],
        "Preenchimento",
        4000,
      );
      while (Date.now() < authority.expiresAt) {
        if (!isCurrent()) throw Error("Ajuste cancelado antes de salvar.");
        if (this.requestGuard.result?.error)
          throw Error(this.requestGuard.result.error);
        const info = await executeEditor(
          wc,
          inspectHashsellEditor,
          [prepared.id],
          "Prévia do formulário",
          1500,
        );
        if (
          info.limit !== prepared.limit ||
          info.href !== prepared.href ||
          info.unit !== prepared.unit
        )
          throw Error("Formulário mudou durante a prévia.");
        verifyBidText(info.value, authority, info.unit);
        if (this.requestGuard.previewComplete && !info.disabled && !info.error)
          return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error(
        "A prévia não ficou pronta no prazo; nenhum clique em Salvar foi feito.",
      );
    } finally {
      this.requestGuard.disarm();
    }
  }
  async submit(prepared, config, authority, isCurrent = () => true) {
    const wc = this.views.editor.webContents;
    let editorState;
    let confirmationClicked = false;
    try {
      verifyPrepared(prepared, authority);
      if (!isCurrent() || wc.getURL() !== prepared.href)
        throw Error("Ajuste cancelado ou ordem alterada antes de salvar.");
      this.requestGuard.armDOMSave(prepared, authority, isCurrent);
      await executeEditor(
        wc,
        commitHashsellEditor,
        [{ ...prepared, authority }],
        "Clique em Salvar ajuste",
        4000,
      );
      while (Date.now() < authority.expiresAt) {
        if (this.requestGuard.result?.admitted) {
          const result = this.requestGuard.result;
          const until = Date.now() + 15000;
          while (
            !result.completed &&
            !result.transportError &&
            Date.now() < until
          )
            await new Promise((r) => setTimeout(r, 100));
          const receipt = {
            admitted: true,
            completed: !!result.completed,
            statusCode: result.statusCode ?? null,
          };
          try {
            editorState = await executeEditor(
              wc,
              readHashsellEditorState,
              [prepared.id],
              "Resposta após envio",
              2000,
            );
          } catch {}
          if (
            result.completed &&
            result.statusCode >= 200 &&
            result.statusCode < 300
          ) {
            // React action errors are rendered inside this exact adjustment form.
            for (
              let i = 0;
              i < 10 &&
              editorState?.kind === "editor" &&
              !editorState.errors?.length;
              i++
            ) {
              await new Promise((r) => setTimeout(r, 100));
              editorState = await executeEditor(
                wc,
                readHashsellEditorState,
                [prepared.id],
                "Resultado do formulário",
                2000,
              );
            }
            if (editorState?.errors?.length) {
              const error = Error(
                "Hashsell recusou o ajuste: " +
                  editorState.errors.join(" ").slice(0, 500),
              );
              error.rejected = true;
              error.receipt = receipt;
              error.editorState = editorState;
              throw error;
            }
          }
          if (
            !result.completed ||
            result.statusCode < 200 ||
            result.statusCode >= 300
          ) {
            const error = Error(
              result.transportError ||
                (result.completed
                  ? "Resposta HTTP " +
                    result.statusCode +
                    " após envio; resultado financeiro não confirmado."
                  : "Envio sem resposta no prazo; conferir a ordem."),
            );
            error.receipt = receipt;
            error.editorState = editorState;
            throw error;
          }
          return { submitted: true, ...receipt, editorState };
        }
        if (this.requestGuard.result?.error)
          throw Error(this.requestGuard.result.error);
        if (!isCurrent()) throw Error("Ajuste cancelado.");
        editorState = await executeEditor(
          wc,
          readHashsellEditorState,
          [prepared.id],
          "Conferência após Salvar",
          1000,
        );
        if (editorState.kind === "additional-step" && !confirmationClicked) {
          if (!isCurrent())
            throw Error("Ajuste cancelado antes da confirmação.");
          verifyPrepared(prepared, authority);
          confirmationClicked = true; // Never retry an uncertain confirmation click.
          await executeEditor(
            wc,
            commitHashsellConfirmation,
            [{ ...prepared, authority }],
            "Confirmação final de Salvar ajuste",
            1500,
          );
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error("Salvar não gerou um envio validado no prazo.");
    } catch (error) {
      this.requestGuard.disarm();
      error.notDispatched = !this.requestGuard.result?.admitted;
      if (editorState) error.editorState = editorState;
      throw error;
    } finally {
      this.requestGuard.disarm();
    }
  }
}
module.exports = {
  BrowserAdapter,
  allowed,
  normalizeOrders,
  deadline,
  executeEditor,
};
