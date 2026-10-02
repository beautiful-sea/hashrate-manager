// These functions are serialized into sandboxed pages. No Node, preload or credentials.
const { verifyBidText } = require("./bid-safety.cjs");
function collectPage(kind, mapping) {
  const text = (el) => (el?.innerText ?? el?.textContent ?? "").trim();
  const fail = (message, code) => {
    throw Object.assign(Error(message), { code });
  };
  const one = (root, selector) => {
    const found = root.querySelectorAll(selector);
    if (found.length !== 1)
      throw Error(`Seletor deve encontrar exatamente um elemento: ${selector}`);
    return found[0];
  };
  if (
    document.querySelector('input[type="password"]') ||
    /\/(login|sign-in)(\/|$)/i.test(location.pathname)
  )
    fail("Faça login na plataforma.", "AUTH_REQUIRED");
  if (
    /Não foi possível carregar esta tela|O servidor não respondeu como esperado/i.test(
      text(document.body),
    )
  )
    fail(
      "A plataforma exibiu uma falha temporária de carregamento.",
      "SITE_UNAVAILABLE",
    );
  if (kind === "loyalty") {
    const labeled = (label) => {
      const nodes = [...document.querySelectorAll("p")].filter(
        (e) => !e.closest("[hidden], [inert]") && label.test(text(e)),
      );
      if (nodes.length !== 1)
        fail("Aguardando o plano de fidelidade carregar.", "NOT_READY");
      const value = nodes[0].nextElementSibling;
      if (!value || value.tagName !== "P")
        fail("Plano de fidelidade não identificado.", "NOT_READY");
      return text(value);
    };
    const plan = labeled(/^(Nível atual|Current level)$/i);
    const bonus = labeled(/^(Bônus atual|Current bonus)$/i);
    if (
      !/^[A-Za-z][A-Za-z -]{0,39}$/.test(plan) ||
      !/^\+?\d+(?:[.,]\d+)?%$/.test(bonus)
    )
      fail("Plano de fidelidade inválido.", "INVALID_DATA");
    return { plan, bonus, locale: bonus.includes(",") ? "pt-BR" : "en-US" };
  }
  if (kind === "orders") {
    let rows;
    if (mapping.row) rows = [...document.querySelectorAll(mapping.row)];
    else {
      const tables = [...document.querySelectorAll("table")].filter((t) => {
        // Next.js can retain a hidden streamed copy of the same table.
        // Reading both duplicates orders; selecting the first is not reliable.
        if (t.closest("[hidden], [inert]")) return false;
        const headers = [...t.querySelectorAll("th")].map(text);
        return (
          headers.some((h) => /^(Lance|Bid)$/i.test(h)) &&
          headers.some((h) => /^(Ordem|Order)$/i.test(h))
        );
      });
      if (tables.length !== 1)
        fail(
          tables.length
            ? "Tabela de ordens ambígua."
            : "Aguardando a tabela de ordens carregar.",
          tables.length ? "AMBIGUOUS" : "NOT_READY",
        );
      rows = [...tables[0].querySelectorAll("tbody tr")];
    }
    if (rows.length > 500) throw Error("Quantidade inesperada de ordens.");
    return rows
      .map((row) => {
        const cells = [...row.querySelectorAll("td")];
        if (cells.length < 3 && !mapping.row) return null;
        const value = (key, index) =>
          text(mapping[key] ? one(row, mapping[key]) : cells[index]);
        const idText = value("id", 0);
        const id =
          idText.match(/\bHS-[A-Z0-9_-]+\b/i)?.[0] ||
          (mapping.id ? idText : "");
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(id))
          throw Error("ID de ordem não identificado.");
        const anchor = mapping.link
          ? one(row, mapping.link)
          : cells[0]?.querySelector("a[href]");
        return {
          id,
          bid: value("bid", 2),
          speed: value("speed", 3),
          balance: value("balance", 5),
          status: value("status", 1),
          href: anchor?.href || "",
          locale: mapping.row
            ? mapping.locale
            : document.documentElement.lang.toLowerCase().startsWith("en")
              ? "en-US"
              : "pt-BR",
        };
      })
      .filter(Boolean);
  }
  let loyaltyPlan = null;
  if (kind === "rental") {
    const plans = [...document.querySelectorAll("p")]
      .filter((e) => !e.closest("[hidden], [inert]"))
      .map(
        (e) =>
          text(e).match(
            /^(?:Você está no nível|You are at level) ([A-Za-z][A-Za-z -]{0,39})\./,
          )?.[1],
      )
      .filter(Boolean);
    if (plans.length === 1) loyaltyPlan = plans[0];
  }
  if (mapping.selector)
    return {
      value: text(one(document, mapping.selector)),
      detected: false,
      loyaltyPlan,
    };
  const money = (t) => t.match(/(?:US\$|USD|\$)\s*([\d.,]+)/i)?.[1];
  const candidates = [];
  if (kind === "rental") {
    for (const el of document.querySelectorAll("tr, li, div")) {
      const t = text(el);
      if (t.length < 200 && /(?:^|\s)1\s*PH\s*\/\s*s\b/i.test(t) && money(t))
        candidates.push(money(t));
    }
  } else {
    for (const el of document.querySelectorAll(
      "span,small,dt,p,button,h2,h3,div",
    )) {
      const label = text(el);
      if (!/^(Preço de corte|Clearing price)$/i.test(label)) continue;
      let parent = el.parentElement;
      for (
        let depth = 0;
        parent && depth < 3;
        depth++, parent = parent.parentElement
      ) {
        const t = text(parent);
        if (t.length < 350 && money(t)) {
          candidates.push(money(t));
          break;
        }
      }
    }
  }
  const unique = [...new Set(candidates)];
  if (unique.length !== 1)
    fail(
      unique.length
        ? "Preço não identificado de forma única; calibre o seletor de leitura."
        : "Aguardando o preço carregar na página.",
      unique.length ? "AMBIGUOUS" : "NOT_READY",
    );
  return {
    loyaltyPlan,
    value: unique[0],
    detected: true,
    locale: document.documentElement.lang.toLowerCase().startsWith("en")
      ? "en-US"
      : "pt-BR",
  };
}
function inspectEditor(mapping) {
  const one = (selector) => {
    const nodes = document.querySelectorAll(selector);
    if (nodes.length !== 1) throw Error("Campo de edição ausente ou ambíguo.");
    return nodes[0];
  };
  const id = one(mapping.identity);
  const input = one(mapping.input);
  const button = one(mapping.submit);
  if (
    !(input instanceof HTMLInputElement) ||
    !["number", "text"].includes(input.type)
  )
    throw Error("Tipo do campo de lance não suportado.");
  if (
    !input.form ||
    button.form !== input.form ||
    button.type !== "submit" ||
    input.form.method.toLowerCase() !== "post"
  )
    throw Error(
      "Formulário de edição não validado: exige POST e botão submit no mesmo formulário.",
    );
  if (new URL(input.form.action, location.href).origin !== location.origin)
    throw Error("Destino do formulário não permitido.");
  if (input.disabled || input.readOnly || button.disabled)
    throw Error("Edição indisponível.");
  return {
    identity: (id.innerText ?? id.textContent ?? "").trim(),
    value: input.value,
    min: input.min,
    max: input.max,
    step: input.step,
    href: location.href,
  };
}
function submitEditor(mapping, expected) {
  verifyBidText(expected.value, expected.authority, mapping.unit);
  if (location.href !== expected.href)
    throw Error("Página mudou antes do envio.");
  const one = (s) => {
    const nodes = document.querySelectorAll(s);
    if (nodes.length !== 1) throw Error("Campo de edição mudou.");
    return nodes[0];
  };
  const identity = (
    one(mapping.identity).innerText ??
    one(mapping.identity).textContent ??
    ""
  ).trim();
  const input = one(mapping.input),
    button = one(mapping.submit);
  if (identity !== expected.identity || input.value !== expected.original)
    throw Error("Ordem ou lance mudou antes do envio.");
  if (
    !(input instanceof HTMLInputElement) ||
    !input.form ||
    button.form !== input.form ||
    button.type !== "submit" ||
    input.form.method.toLowerCase() !== "post" ||
    new URL(input.form.action, location.href).origin !== location.origin ||
    input.disabled ||
    input.readOnly ||
    button.disabled
  )
    throw Error("Formulário mudou antes do envio.");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
    input,
    expected.value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  if (
    input.value !== expected.value ||
    !input.checkValidity() ||
    !input.form.checkValidity()
  )
    throw Error("Novo lance rejeitado pelo formulário.");
  verifyBidText(input.value, expected.authority, mapping.unit);
  button.click();
  return { submitted: true };
}
function script(fn, ...args) {
  return `(() => { const verifyBidText = ${verifyBidText.toString()}; return (${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")}); })()`;
}
function readScript(kind, mapping) {
  return `(() => { try { return { ok: true, value: ${script(collectPage, kind, mapping)} }; } catch(error) { return { ok: false, error: error.message, code: error.code || "INVALID_DATA", path: location.pathname, tables: document.querySelectorAll('table').length, layouts: [...document.querySelectorAll('table')].map(t=>({rects:t.getClientRects().length,hidden:!!t.closest('[hidden]'),display:getComputedStyle(t).display,rows:t.querySelectorAll('tbody tr').length})), headings: [...document.querySelectorAll('th')].map(e => (e.innerText || e.textContent || '').trim()).slice(0,20), viewport: {width:innerWidth,height:innerHeight} }; } })()`;
}
module.exports = {
  collectPage,
  inspectEditor,
  submitEditor,
  script,
  readScript,
};
