// Serialized DOM functions. Never invoke an API to create orders.
function creationPage(mode, p) {
  const text = (n) => (n?.textContent || "").replace(/\s+/g, " ").trim();
  const visible = (node) => {
    if (!node || node.closest("[hidden],[inert]")) return false;
    for (let n = node; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.contentVisibility === "hidden"
      )
        return false;
    }
    return true;
  };
  if (
    location.origin !== "https://hashsell.com" ||
    [...document.querySelectorAll('input[type="password"]')].some(visible)
  )
    throw Error("Faça login na Hashsell.");
  const pageFailed = [...document.querySelectorAll("body *")].some(
    (n) =>
      visible(n) &&
      (text(n) === "Não foi possível carregar esta tela" ||
        [...n.childNodes].some(
          (child) =>
            child.nodeType === 3 &&
            text(child).includes("Não foi possível carregar esta tela"),
        )),
  );
  if (mode === "recover") {
    const buttons = [...document.querySelectorAll("button")].filter(
      (n) => text(n) === "Tentar de novo" && !n.disabled && visible(n),
    );
    if (pageFailed && !p?.probeOnly && buttons.length === 1) {
      buttons[0].click();
      return { recovered: true, unavailable: pageFailed };
    }
    return { recovered: false, unavailable: pageFailed };
  }
  const navigationMode = ["navigateOrders", "navigateCreation"].includes(mode);
  if (pageFailed && !navigationMode)
    throw Error(
      "A Hashsell não conseguiu carregar esta página. Tentando novamente.",
    );
  const accountNodes = [
    ...document.querySelectorAll('button[aria-label^="Conta de "]'),
  ].filter(visible);
  const accountNode = accountNodes.length === 1 ? accountNodes[0] : null;
  const account = (
    text(accountNode) +
    " " +
    (accountNode?.getAttribute("aria-label") || "")
  )
    .match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0]
    ?.toLowerCase();
  if (!account) throw Error("Conta Hashsell não identificada.");
  if (mode === "identity") return { account };
  if (navigationMode) {
    const toOrders = mode === "navigateOrders";
    if (location.pathname !== (toOrders ? "/market" : "/orders"))
      throw Error("Página de navegação indisponível.");
    const links = [
      ...document.querySelectorAll(
        toOrders ? 'nav a[href="/orders"]' : 'a[href="/orders/new"]',
      ),
    ].filter(
      (n) => text(n) === (toOrders ? "Ordens" : "Nova ordem") && visible(n),
    );
    if (links.length !== 1) throw Error("Link de navegação indisponível.");
    let navigated = false;
    const hydratedClick = (event) => {
      if (event.target !== links[0]) return;
      navigated = event.defaultPrevented;
      if (!navigated) event.preventDefault();
    };
    window.addEventListener("click", hydratedClick);
    try {
      links[0].click();
    } finally {
      window.removeEventListener("click", hydratedClick);
    }
    return { account, navigated };
  }

  const metadataValue = (key) => {
    const values = [];
    let visited = 0;
    const walk = (v) => {
      if (!v || typeof v !== "object" || ++visited > 20000) return;
      if (
        typeof v[key] === "string" &&
        /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(v[key])
      )
        values.push(v[key]);
      for (const x of Object.values(v)) walk(x);
    };
    for (const n of document.querySelectorAll("script:not([src])")) {
      try {
        const a = JSON.parse(n.textContent.match(/push\((\[.*\])\)/s)?.[1]);
        if (a[0] !== 1 || typeof a[1] !== "string") continue;
        for (const line of a[1].split("\n")) {
          try {
            walk(JSON.parse(line.replace(/^[a-f0-9]+:/, "")));
          } catch {}
        }
      } catch {}
    }
    const unique = [...new Set(values)];
    if (unique.length !== 1)
      throw Error("Aguardando os valores completos da plataforma.");
    return unique[0];
  };

  if (mode === "wallet") {
    if (location.pathname !== "/wallet") throw Error("Carteira inválida.");
    const labels = [...document.querySelectorAll("p")].filter(
      (n) => text(n).toLowerCase() === "disponível" && visible(n),
    );
    if (labels.length !== 1)
      throw Error("Saldo disponível temporariamente indisponível.");
    const available = text(labels[0].nextElementSibling);
    if (!/^US\$\s*[\d.,]+$/.test(available))
      throw Error("Saldo disponível inválido.");
    return {
      account,
      available,
      availableExact: metadataValue("availableUsd"),
    };
  }
  if (mode === "evidence") {
    const matches = [];
    const walk = (v) => {
      if (!v || typeof v !== "object") return;
      if (
        v.code === p.id &&
        v.priceScaled &&
        v.limitHash &&
        v.amountUsd &&
        v.createdAt
      )
        matches.push({
          id: v.code,
          type: v.type,
          poolId: v.pool?.id,
          priceScaled: v.priceScaled,
          limitHash: v.limitHash,
          amountUsd: v.amountUsd,
          createdAt: v.createdAt,
        });
      for (const x of Object.values(v)) walk(x);
    };
    for (const n of document.querySelectorAll("script:not([src])")) {
      try {
        const a = JSON.parse(n.textContent.match(/push\((\[.*\])\)/s)?.[1]);
        if (a[0] !== 1 || typeof a[1] !== "string") continue;
        for (const line of a[1].split("\n")) {
          try {
            walk(JSON.parse(line.replace(/^[a-f0-9]+:/, "")));
          } catch {}
        }
      } catch {}
    }
    const unique = [
      ...new Map(matches.map((v) => [JSON.stringify(v), v])).values(),
    ];
    if (location.pathname !== "/orders/" + p.id || unique.length !== 1)
      throw Error("Nova ordem ainda não conferida.");
    return { account, ...unique[0] };
  }
  if (location.pathname !== "/orders/new")
    throw Error("Formulário de criação inválido.");
  const selectors = [
    ...document.querySelectorAll('select[name="poolId"]'),
  ].filter(visible);
  if (selectors.length !== 1)
    throw Error("Formulário de criação indisponível.");
  const pool = selectors[0];
  const form = pool.form;
  const pools = [...pool.options]
    .filter((o) => o.value)
    .map((o) => ({ id: o.value, name: text(o) }));
  if (!form) throw Error("Formulário de criação indisponível.");
  // Listing saved pools is read-only; submission metadata is checked by the executor.
  if (mode === "options" && p.poolsOnly === true) return { account, pools };
  const clientAction =
    !form.hasAttribute("method") &&
    (form.getAttribute("action") || "").startsWith(
      "javascript:throw new Error('A React form was unexpectedly submitted.",
    );
  if (mode === "options") {
    const labels = [...form.querySelectorAll("dt")].filter(
      (n) => text(n) === "Taxa de criação" && !n.closest("[hidden],[inert]"),
    );
    if (labels.length !== 1)
      throw Error(
        "Formulário de criação indisponível: taxa de criação ausente ou ambígua.",
      );
    const feeNode = labels[0].nextElementSibling;
    if (feeNode?.tagName !== "DD" || feeNode.closest("[hidden],[inert]"))
      throw Error("Taxa de criação inválida.");
    const usdPattern = "(?:\\d{1,3}(?:\\.\\d{3})+|\\d+)(?:,\\d+)?";
    const normalizeUsd = (v) => v.replace(/\./g, "").replace(",", ".");
    const feeText = text(feeNode);
    const fee = feeText.match(
      new RegExp("^US\\$\\s*(" + usdPattern + ")$"),
    )?.[1];
    if (!fee && feeText !== "–") throw Error("Taxa de criação inválida.");
    const amounts = [...form.elements].filter((n) => n.name === "amount");
    if (!amounts.length)
      throw Error(
        "Formulário de criação indisponível: valor da criação ausente.",
      );
    if (
      amounts.length !== 1 ||
      amounts[0].type !== "hidden" ||
      !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amounts[0].value)
    )
      throw Error("Valor da criação ausente ou ambíguo.");
    const amountField = amounts[0].closest('[data-slot="field"]');
    if (!amountField)
      throw Error(
        "Formulário de criação indisponível: resumo do valor da criação ausente.",
      );
    if (
      amountField.closest("form") !== form ||
      amountField.closest("[hidden],[inert]")
    )
      throw Error("Resumo do valor da criação indisponível.");
    const descriptions = [
      ...amountField.querySelectorAll('p[data-slot="field-description"]'),
    ].filter(
      (n) =>
        n.closest('[data-slot="field"]') === amountField &&
        !n.closest("[hidden],[inert]"),
    );
    if (!descriptions.length)
      throw Error(
        "Formulário de criação indisponível: resumo do valor da criação ausente.",
      );
    if (descriptions.length !== 1)
      throw Error("Resumo do valor da criação ambíguo.");
    const summaries = [...descriptions[0].childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => text(n))
      .filter((v) => v.includes("Sai da carteira:"));
    if (!summaries.length)
      throw Error(
        "Formulário de criação indisponível: resumo da taxa de criação ausente.",
      );
    const summary =
      summaries.length === 1 &&
      summaries[0].match(
        new RegExp(
          "^Sai da carteira:\\s*US\\$\\s*(" +
            usdPattern +
            ")\\s*\\(US\\$\\s*(" +
            usdPattern +
            ")\\s*\\+\\s*US\\$\\s*(" +
            usdPattern +
            ") de taxa de criação\\)$",
        ),
      );
    if (!summary) throw Error("Resumo da taxa de criação inválido.");
    const feeSummary = {
      debit: normalizeUsd(summary[1]),
      amount: normalizeUsd(summary[2]),
      fee: normalizeUsd(summary[3]),
      fieldAmount: amounts[0].value,
    };
    const keys = [...form.elements].filter((n) => n.name === "idempotencyKey");
    let platformKey;
    if (clientAction) {
      if (
        keys.length !== 1 ||
        keys[0].type !== "hidden" ||
        (keys[0].value !== "" &&
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(keys[0].value))
      )
        throw Error("Chave da nova ordem indisponível.");
      platformKey = keys[0].value;
    }
    return {
      account,
      pools,
      ...(platformKey ? { platformKey } : {}),
      creationFeeUsd: fee ? normalizeUsd(fee) : feeSummary.fee,
      feeSummary,
    };
  }
  if (form.method.toLowerCase() !== "post" && !clientAction)
    throw Error("Formulário de criação indisponível.");
  const value = (name) => {
    const nodes = [...form.elements].filter(
      (n) => n.name === name && (n.type !== "radio" || n.checked),
    );
    if (nodes.length !== 1) throw Error("Campo ausente ou ambíguo: " + name);
    return nodes[0].value;
  };
  const verify = () => {
    for (const [name, want] of Object.entries({
      unit: "PH",
      type: "STANDARD",
      poolId: p.destination,
      limit: p.limit,
      price: p.price,
      amount: p.amount,
    }))
      if (value(name) !== want)
        throw Error("Formulário diverge de " + name + ".");
    const currentKey = value("idempotencyKey");
    if (mode === "inspect" && p.allowKeyRefresh === true && clientAction) {
      if (
        !(p.allowEmptyKey === true && currentKey === "") &&
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(currentKey)
      )
        throw Error("Chave da nova ordem indisponível.");
    } else if (currentKey !== p.key) throw Error("Chave de criação mudou.");
  };
  if (mode === "unit") {
    if (value("unit") !== "PH") {
      const choices = [...form.querySelectorAll("select")].filter(
        (n) =>
          !n.name &&
          [...n.options]
            .map((o) => o.value)
            .sort()
            .join(",") === "EH,PH,TH",
      );
      if (choices.length !== 1) throw Error("Unidade indisponível.");
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      ).set.call(choices[0], "PH");
      choices[0].dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { account };
  }
  if (mode === "fill") {
    if (!pools.some((o) => o.id === p.destination))
      throw Error("Pool não pertence à conta atual.");
    if (value("unit") !== "PH")
      throw Error(
        "Selecione PH/s na Hashsell antes de configurar novas ordens.",
      );
    const standard = form.querySelector("#type-standard");
    if (!standard) throw Error("Tipo de lance ausente.");
    standard.click();
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    ).set.call(pool, p.destination);
    pool.dispatchEvent(new Event("change", { bubbles: true }));
    for (const [id, v] of [
      ["limit", p.limit.replace(".", ",")],
      ["price", p.price.replace(".", ",")],
      ["amount", p.amount.replace(".", ",")],
    ]) {
      const n = form.querySelector(`[id="${id}"]`);
      if (n?.type !== "text") throw Error("Campo numérico ausente.");
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set.call(n, v);
      n.dispatchEvent(new Event("input", { bubbles: true }));
      n.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const key = form.elements.namedItem("idempotencyKey");
    if (key?.type !== "hidden") throw Error("Chave de criação ausente.");
    if (!clientAction) key.value = p.key;
    return { account };
  }
  if (mode === "save" && clientAction && value("idempotencyKey") === "") {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(p.key))
      throw Error("Chave da nova ordem indisponível.");
    form.elements.namedItem("idempotencyKey").value = p.key;
  }
  verify();
  if (mode === "inspect") {
    const fields = {};
    for (const n of form.elements) {
      if (!n.name || (n.type === "radio" && !n.checked)) continue;
      if (Object.hasOwn(fields, n.name)) throw Error("Campos duplicados.");
      fields[n.name] = n.value;
    }
    const allowed = [
      ...(clientAction
        ? []
        : ["$ACTION_REF_1", "$ACTION_1:0", "$ACTION_1:1", "$ACTION_KEY"]),
      "idempotencyKey",
      "unit",
      "type",
      "poolId",
      "limit",
      "price",
      "amount",
    ];
    if (Object.keys(fields).sort().join("|") !== allowed.sort().join("|"))
      throw Error("Estrutura do formulário mudou.");

    const costs = [
      ...new Set(
        [...form.querySelectorAll("p,span")]
          .filter(visible)
          .map(text)
          .filter((t) => t.length < 400)
          .map((t) => t.match(/Sai da carteira:\s*US\$\s*([\d.,]+)/)?.[1])
          .filter(Boolean),
      ),
    ];
    if (costs.length !== 1)
      throw Error("Aguardando a prévia do custo da nova ordem.");
    const debit = costs[0];
    if (!debit) throw Error("Custo não confirmado.");
    return { account, fields, debit };
  }
  const dialogs = [
    ...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog'),
  ].filter(visible);
  if (mode === "open") {
    if (dialogs.length) throw Error("Existe outro diálogo aberto.");
    const buttons = [...form.querySelectorAll("button")].filter(
      (n) => text(n) === "Criar ordem" && visible(n),
    );
    if (
      buttons.length === 1 &&
      buttons[0].disabled &&
      /bid is below the market minimum price/i.test(text(form))
    )
      throw Error(
        "O preço mínimo da Hashsell mudou. A nova ordem será recalculada no próximo ciclo.",
      );
    if (buttons.length !== 1 || buttons[0].disabled)
      throw Error("Botão de criar indisponível.");
    buttons[0].click();
    return { account };
  }
  if (mode === "save") {
    if (dialogs.length !== 1 || !text(dialogs[0]).includes("Criar ordem"))
      throw Error("Confirmação de criação não identificada.");
    const buttons = [...dialogs[0].querySelectorAll("button")].filter(
      (n) => text(n) === "Criar ordem",
    );
    if (buttons.length !== 1 || buttons[0].disabled)
      throw Error("Confirmação de criação indisponível.");
    buttons[0].click();
    return { account };
  }
  throw Error("Etapa de criação inválida.");
}
const creationScript = (mode, p) =>
  "(()=>{try{return {ok:true,value:(" +
  creationPage.toString() +
  ")(" +
  JSON.stringify(mode) +
  "," +
  JSON.stringify(p || {}) +
  ")}}catch(e){return {ok:false,error:String(e.message)}}})()";
module.exports = { creationPage, creationScript };
