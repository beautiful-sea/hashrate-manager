const D = require("decimal.js");
const { createHash } = require("node:crypto");
const { creationScript } = require("./creation-dom.cjs");
const { CreationGuard } = require("./creation-guard.cjs");
const { parseNumber } = require("./engine.cjs");
const accountHash = (v) =>
  createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
class CreationAdapter {
  constructor(adapter, options = {}) {
    this.adapter = adapter;
    this.views = adapter.views;
    this.guard = new CreationGuard(this.views.creation.webContents, options);
    adapter.requestGuard.creation = this.guard;
    for (const key of ["wallet", "creationEvidence"])
      if (this.views[key])
        adapter.requestGuard.readOnlyIds.add(this.views[key].webContents.id);
  }
  async run(wc, mode, p, readDeadline = null) {
    const remaining =
      readDeadline === null ? 4000 : Math.min(4000, readDeadline - Date.now());
    if (remaining <= 0) throw Error("Tempo de leitura da criação esgotado.");
    let timer;
    try {
      const r = await Promise.race([
        (readDeadline !== null ? wc.mainFrame || wc : wc).executeJavaScript(
          creationScript(mode, p),
        ),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("Tempo de leitura da criação esgotado.")),
            remaining,
          );
        }),
      ]);
      if (readDeadline !== null && Date.now() >= readDeadline)
        throw Error("Tempo de leitura da criação esgotado.");
      if (!r?.ok) throw Error(r?.error || "Formulário indisponível.");
      return mode === "recover"
        ? r.value
        : { ...r.value, account: accountHash(r.value.account) };
    } finally {
      clearTimeout(timer);
    }
  }
  async readPage(key, url, mode, p, attempts = 3) {
    const wc = this.views[key].webContents;
    let stage = "read-availability";
    let lastReadError = null;
    if (key === "creation") this.guard?.resetDiagnostics?.();
    try {
      this.adapter.assertReadAvailable("hashsell");
      let error;
      const deadline = Date.now() + 90000;
      let normalReloaded = false;
      const reloadCurrent = async (readDeadline) => {
        if (normalReloaded || key !== "creation" || mode !== "options") return;
        this.adapter.assertReadAvailable("hashsell");
        const before = new URL(wc.getURL());
        if (
          before.origin !== "https://hashsell.com" ||
          before.username ||
          before.password ||
          before.search ||
          before.hash ||
          !["/market", "/orders", "/orders/new"].includes(before.pathname)
        )
          throw Error("Página indisponível para recarga da criação.");
        // This read started with loadURL GET and followed only the two fixed GET links.
        // Never reload while a preview or save grant/request is active.
        if (
          this.guard?.phase ||
          this.guard?.grant ||
          [...(this.guard?.requests?.values() || [])].some(
            (request) => !request.revoked,
          )
        )
          throw Error("Existe uma operação de criação em andamento.");
        const remaining = Math.min(20000, readDeadline - Date.now());
        if (remaining <= 0)
          throw Error("Tempo de recarga da criação esgotado.");
        normalReloaded = true;
        let timer, onLoaded, onFailed;
        try {
          await new Promise((resolve, reject) => {
            onLoaded = () => resolve();
            onFailed = (_event, _code, _description, _url, mainFrame) => {
              if (mainFrame !== false)
                reject(Error("Falha ao recarregar a página de criação."));
            };
            wc.once("dom-ready", onLoaded);
            wc.on("did-fail-load", onFailed);
            timer = setTimeout(
              () => reject(Error("Tempo de recarga da criação esgotado.")),
              remaining,
            );
            wc.reload();
          });
          if (Date.now() >= readDeadline)
            throw Error("Tempo de recarga da criação esgotado.");
          this.adapter.assertReadAvailable("hashsell");
          if (wc.getURL() !== before.href)
            throw Error("Página mudou durante a recarga da criação.");
        } catch (e) {
          wc.stop();
          throw e;
        } finally {
          clearTimeout(timer);
          if (onLoaded) wc.removeListener("dom-ready", onLoaded);
          if (onFailed) wc.removeListener("did-fail-load", onFailed);
        }
      };
      for (let attempt = 0; attempt < attempts; attempt++) {
        this.adapter.assertReadAvailable("hashsell");
        if (Date.now() >= deadline) break;
        const diagnostics = this.adapter.readResponses?.get(wc.id);
        if (diagnostics) {
          diagnostics.since = Date.now();
          diagnostics.items = [];
        }
        try {
          stage = key === "creation" ? "entry-navigation" : "page-navigation";
          await this.adapter.navigate(
            wc,
            key === "creation" ? "https://hashsell.com/market" : url,
            "hashsell",
            Math.min(20000, deadline - Date.now()),
            key === "creation" && mode === "options",
          );
          let navigationAccount = null;
          if (key === "creation") {
            for (const route of [
              {
                mode: "navigateOrders",
                path: "/orders",
                stage: "orders-navigation",
                recovery: "entry-recovery",
              },
              {
                mode: "navigateCreation",
                path: "/orders/new",
                stage: "new-order-navigation",
                recovery: "orders-recovery",
              },
            ]) {
              const routeDeadline = Math.min(deadline, Date.now() + 25000);
              let routed = false;
              let recovered = false,
                recoveryAt = 0;
              while (!routed) {
                this.adapter.assertReadAvailable("hashsell");
                if (Date.now() >= routeDeadline)
                  throw Error("Link de navegação indisponível.");
                try {
                  stage = route.stage;
                  const value = await this.run(
                    wc,
                    route.mode,
                    undefined,
                    routeDeadline,
                  );
                  if (navigationAccount && value.account !== navigationAccount)
                    throw Error("Conta mudou durante a navegação da criação.");
                  navigationAccount = value.account;
                  routed = value.navigated === true;
                  if (!routed) await wait(250);
                } catch (e) {
                  if (
                    /faça login|HTTP (401|403|429)|Conta mudou durante/i.test(
                      e.message,
                    ) ||
                    Date.now() >= routeDeadline
                  )
                    throw e;
                  stage = route.recovery;
                  const recovery = await this.run(
                    wc,
                    "recover",
                    { probeOnly: recovered },
                    routeDeadline,
                  );
                  if (recovery.recovered) {
                    recovered = true;
                    recoveryAt = Date.now();
                  }
                  this.adapter.assertReadAvailable("hashsell");
                  if (
                    recovery.unavailable &&
                    (!recovered || Date.now() - recoveryAt >= 1000)
                  ) {
                    stage = route.recovery + "-reload";
                    await reloadCurrent(routeDeadline);
                  }
                  await wait(250);
                }
              }
              stage =
                route.path === "/orders" ? "orders-route" : "new-order-route";
              while (new URL(wc.getURL()).pathname !== route.path) {
                this.adapter.assertReadAvailable("hashsell");
                if (Date.now() >= routeDeadline)
                  throw Error("Página de navegação indisponível.");
                await wait(250);
              }
            }
          }
          // Wait for the streamed document and then hydrate on this same page.
          const readyUntil = Math.min(deadline, Date.now() + 25000);
          let recovered = false,
            recoveryAt = 0;
          while (true) {
            this.adapter.assertReadAvailable("hashsell");
            if (Date.now() >= readyUntil)
              throw Error("Tempo de leitura da criação esgotado.");
            try {
              stage = "page-recovery";
              const recovery = await this.run(
                wc,
                "recover",
                { probeOnly: recovered },
                readyUntil,
              );
              if (recovery.recovered) {
                recovered = true;
                recoveryAt = Date.now();
              }
              if (
                recovery.unavailable &&
                (!recovered || Date.now() - recoveryAt >= 1000)
              ) {
                stage = "page-recovery-reload";
                await reloadCurrent(readyUntil);
              }
              stage = ["options", "wallet", "evidence"].includes(mode)
                ? mode
                : "read-dom";
              const value = await this.run(wc, mode, p, readyUntil);
              if (navigationAccount && value.account !== navigationAccount)
                throw Error("Conta mudou durante a navegação da criação.");
              return value;
            } catch (e) {
              lastReadError = e.message;
              if (
                !/Hashsell não conseguiu carregar|formulário.*indisponível|conta.*não identificada|aguardando os valores completos|saldo disponível temporariamente/i.test(
                  e.message,
                ) ||
                Date.now() >= readyUntil
              )
                throw e;
              await wait(250);
            }
          }
        } catch (e) {
          error = e;
          if (
            /faça login|HTTP (401|403|429)|Conta mudou durante/i.test(e.message)
          )
            break;
          if (Date.now() >= deadline) break;
          await wait(300);
        }
      }
      throw error || Error("Tempo de carregamento da página esgotado.");
    } catch (e) {
      let page = null;
      try {
        const current = new URL(wc.getURL());
        if (["https:", "http:"].includes(current.protocol))
          page = {
            origin: current.origin,
            pathname: current.pathname.slice(0, 300),
          };
      } catch {}
      const responses = this.adapter.readResponses?.get(wc.id)?.items || [];
      const responseSummary =
        responses
          .slice(-6)
          .filter(
            (item) =>
              ["mainFrame", "xhr", "script"].includes(item.type) &&
              Number.isInteger(item.status) &&
              item.status >= 100 &&
              item.status <= 599,
          )
          .map((item) => item.type + " HTTP " + item.status)
          .join(", ") || "HTTP não observado";
      const failure =
        e instanceof Error ? e : Error("Falha na consulta da criação.");
      failure.diagnostics = {
        stage,
        lastReadError,
        page,
        responseSummary,
        guardRefusals: this.guard?.diagnostics?.() || [],
      };
      throw failure;
    }
  }
  async options({ poolsOnly = false } = {}) {
    const result = await this.readPage(
      "creation",
      "https://hashsell.com/orders/new",
      "options",
      { poolsOnly },
    );
    if (!result.pools.length)
      throw Error("Cadastre um pool de entrega na Hashsell.");
    if (poolsOnly) return { account: result.account, pools: result.pools };
    const { feeSummary, ...options } = result;
    const values = feeSummary && [
      feeSummary.debit,
      feeSummary.amount,
      feeSummary.fee,
      feeSummary.fieldAmount,
      options.creationFeeUsd,
    ];
    if (
      !values ||
      values.some(
        (v) => typeof v !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v),
      )
    )
      throw Error("Resumo da taxa de criação inválido.");
    const Money = D.clone({
      precision: Math.max(
        32,
        ...values.map((v) => v.replace(".", "").length + 2),
      ),
    });
    if (
      !new Money(feeSummary.amount).eq(feeSummary.fieldAmount) ||
      !new Money(feeSummary.amount).plus(feeSummary.fee).eq(feeSummary.debit) ||
      !new Money(feeSummary.fee).eq(options.creationFeeUsd)
    )
      throw Error("Resumo do custo da criação não confere.");
    return options;
  }
  async wallet() {
    const at = Date.now();
    const value = await this.readPage(
      "wallet",
      "https://hashsell.com/wallet",
      "wallet",
    );
    if (
      !new D(value.availableExact)
        .toDecimalPlaces(2)
        .eq(parseNumber(value.available, "pt-BR"))
    )
      throw Error("Saldo da carteira não confere.");
    return {
      at,
      account: value.account,
      available: value.availableExact,
    };
  }
  async prepare(plan, config, key, isCurrent) {
    const wc = this.views.creation.webContents;
    this.guard.cancel();
    const options = await this.options();
    if (
      options.account !== plan.account ||
      !options.pools.some((p) => p.id === plan.destination)
    )
      throw Error("Conta ou pool diferente da configuração.");
    key = options.platformKey || key;
    await this.run(wc, "unit");
    await wait(150);
    const fields = {
      destination: plan.destination,
      limit: new D(plan.speedPH).toFixed(4),
      price: new D(plan.bid).toFixed(4),
      amount: new D(plan.amount).toFixed(2),
      key,
    };
    const grant = {
      ...plan,
      key,
      tick: config.tick,
      href: "https://hashsell.com/orders/new",
      debit: plan.amount,
      available: plan.available,
      expiresAt: Date.now() + 20000,
      isCurrent,
    };
    this.guard.arm(grant, "preview");
    await this.run(wc, "fill", fields);
    let inspected, error;
    for (let i = 0; i < 20 && isCurrent(); i++) {
      await wait(200);
      try {
        inspected = await this.run(wc, "inspect", {
          ...fields,
          allowKeyRefresh: true,
          allowEmptyKey: true,
        });
        if (this.guard.previewReady) break;
      } catch (e) {
        error = e;
      }
    }
    if (!isCurrent() || !inspected || !this.guard.previewReady)
      throw error || Error("Prévia da nova ordem indisponível.");
    const debit = new D(plan.amount).plus(options.creationFeeUsd).toString();
    if (
      !new D(debit).toDecimalPlaces(2).eq(parseNumber(inspected.debit, "pt-BR"))
    )
      throw Error("Prévia do custo não confere com a taxa de criação.");
    if (new D(debit).lt(plan.amount) || new D(debit).gt(plan.available))
      throw Error("Saldo insuficiente incluindo a taxa de criação.");
    if (inspected.account !== plan.account)
      throw Error("Conta mudou durante a prévia.");
    // The client form regenerates its key when parameters change. Adopt it only
    // before any durable intent or financial dispatch; submit still requires equality.
    fields.key = inspected.fields.idempotencyKey;
    await this.run(wc, "open", fields);
    await wait(200);
    const confirmed = await this.run(wc, "inspect", {
      ...fields,
      allowKeyRefresh: true,
      allowEmptyKey: true,
    });
    if (
      confirmed.account !== plan.account ||
      !new D(debit).toDecimalPlaces(2).eq(parseNumber(confirmed.debit, "pt-BR"))
    )
      throw Error("Confirmação da nova ordem mudou.");
    fields.key = confirmed.fields.idempotencyKey || key;
    key = fields.key;
    return {
      plan,
      form: fields,
      fields: { ...confirmed.fields, idempotencyKey: key },
      debit,
      key,
    };
  }
  async submit(prepared, latest, config, isCurrent) {
    const wc = this.views.creation.webContents;
    let receipt;
    try {
      const current = await this.run(wc, "inspect", {
        ...prepared.form,
        allowKeyRefresh: true,
        allowEmptyKey: true,
      });
      // React may reset this uncontrolled hidden input. Reuse the durable key,
      // never generate/adopt another key once the intent has been recorded.
      if (current.fields.idempotencyKey === "")
        current.fields.idempotencyKey = prepared.key;
      if (
        current.account !== latest.account ||
        JSON.stringify(current.fields) !== JSON.stringify(prepared.fields) ||
        !new D(prepared.debit)
          .toDecimalPlaces(2)
          .eq(parseNumber(current.debit, "pt-BR"))
      )
        throw Error("Formulário mudou antes da criação.");
      this.guard.arm(
        {
          ...latest,
          key: prepared.key,
          fields: prepared.fields,
          debit: prepared.debit,
          tick: config.tick,
          href: "https://hashsell.com/orders/new",
          isCurrent,
        },
        "save",
      );
      // A reused idle socket can replay POST internally without webRequest hooks.
      // Start this financial dispatch on a fresh connection after all reads.
      await wc.session.closeAllConnections();
      await this.run(wc, "save", prepared.form);
      for (let i = 0; i < 50; i++) {
        await wait(200);
        receipt = this.guard.receipt;
        if (receipt?.error || receipt?.completed || receipt?.transportError)
          break;
      }
      receipt = this.guard.receipt;
      if (!receipt?.admitted)
        throw Object.assign(Error(receipt?.error || "Criação não enviada."), {
          notDispatched: true,
        });
      if (!receipt.completed || ![200, 201, 303].includes(receipt.statusCode))
        throw Error("Aguardando conferência da nova ordem.");
      const href = wc.getURL();
      return {
        ...receipt,
        href: /^https:\/\/hashsell.com\/orders\/HS-[A-Z0-9]+$/.test(href)
          ? href
          : null,
      };
    } catch (e) {
      receipt = this.guard.receipt;
      throw Object.assign(e, {
        receipt: receipt || null,
        notDispatched: !receipt?.admitted,
      });
    } finally {
      this.guard.cancel();
    }
  }
  async reconcile(intent, orders) {
    if (orders.account !== intent.account) return null;
    const freshIds = orders.items.filter(
      (o) => !intent.beforeIds.includes(o.id),
    );
    if (!freshIds.length) return null;
    const signature =
      intent.key +
      ":" +
      freshIds
        .map((o) => o.id)
        .sort()
        .join("|");
    if (this.scan?.signature !== signature)
      this.scan = { signature, index: 0, matched: [], failed: false };
    const scan = this.scan;
    // One evidence page per monitor cycle keeps existing bids responsive.
    for (const o of freshIds.slice(scan.index, scan.index + 1)) {
      try {
        const e = await this.readPage(
          "creationEvidence",
          o.href,
          "evidence",
          {
            id: o.id,
          },
          1,
        );
        const at = Date.parse(e.createdAt);
        if (
          e.account === intent.account &&
          e.type === "STANDARD" &&
          e.poolId === intent.destination &&
          Number.isFinite(at) &&
          at >= intent.at - 5000 &&
          at <= Date.now() + 5000 &&
          new D(e.priceScaled).eq(new D(intent.bid).mul(100000)) &&
          new D(e.limitHash).eq(new D(intent.speedPH).mul(1000000000)) &&
          new D(e.amountUsd).eq(intent.amount)
        )
          scan.matched.push({
            ...e,
            id: o.id,
            href: o.href,
            checkedAt: Date.now(),
          });
      } catch {
        scan.failed = true;
      }
      scan.index++;
    }
    if (scan.index < freshIds.length) return null;
    this.scan = null;
    return !scan.failed && scan.matched.length === 1 ? scan.matched[0] : null;
  }
}
module.exports = { CreationAdapter, accountHash };
