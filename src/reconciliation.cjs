// Serialized into a dedicated GET-only page. Never opens or submits a form.
function collectOrderEvidence(expected) {
  const text = (n) => (n?.textContent || "").replace(/\s+/g, " ").trim();
  if (
    location.origin !== "https://hashsell.com" ||
    location.pathname !== "/orders/" + expected.id ||
    document.querySelector('input[type="password"]')
  )
    throw Error("Identidade ou sessão da conferência não confere.");
  // Inline Flight data includes error translations even on successful pages.
  // Only the rendered message indicates a failed page.
  const visibleBody = () => {
    if (typeof document.body?.innerText === "string")
      return document.body.innerText;
    const body = document.body?.cloneNode(true);
    body
      ?.querySelectorAll("script,style,template,noscript,[hidden]")
      .forEach((n) => n.remove());
    return text(body);
  };
  if (
    /Não foi possível carregar esta tela|O servidor não respondeu como esperado/.test(
      visibleBody(),
    )
  )
    throw Error("Página temporariamente indisponível.");
  const candidates = [];
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (
      v.code === expected.id &&
      typeof v.priceScaled === "string" &&
      /^\d+$/.test(v.priceScaled)
    )
      candidates.push({
        id: v.code,
        priceScaled: v.priceScaled,
        orderId: v.id,
      });
    for (const x of Object.values(v)) walk(x);
  };
  for (const s of document.querySelectorAll("script:not([src])")) {
    let p;
    try {
      p = JSON.parse(s.textContent.match(/push\((\[.*\])\)/s)?.[1]);
    } catch {
      continue;
    }
    if (p?.[0] !== 1 || typeof p[1] !== "string") continue;
    for (const line of p[1].split("\n")) {
      const data = line.match(/^[a-f0-9]+:(.*)$/)?.[1];
      if (!data) continue;
      try {
        walk(JSON.parse(data));
      } catch {}
    }
  }
  const unique = [
    ...new Map(candidates.map((c) => [JSON.stringify(c), c])).values(),
  ];
  if (unique.length === 1)
    return {
      ...unique[0],
      href: location.origin + location.pathname,
      source: "order-document",
    };
  if (unique.length > 1) throw Error("Dados conflitantes na conferência.");
  const labels = [...document.querySelectorAll("p,span,div")].filter(
    (n) =>
      !n.children.length &&
      text(n).toLocaleLowerCase("pt-BR") === "seu lance" &&
      !n.closest("[hidden],[inert]"),
  );
  if (labels.length !== 1) throw Error("Cartão do lance ausente ou ambíguo.");
  const value = text(labels[0].nextElementSibling).match(
    /^US\$\s*([\d.,]+)\s*\/?\s*(TH|PH|EH)\s*\/s\s*\/dia$/i,
  );
  if (!value || !text(document.querySelector("h1")).includes(expected.id))
    throw Error("Valor ou ordem não confirmado no detalhe.");
  return {
    id: expected.id,
    href: location.origin + location.pathname,
    value: value[1],
    unit: value[2].toUpperCase(),
    source: "order-card",
  };
}
const reconciliationScript = (intent) =>
  "( ()=>{try{return {ok:true,value:(" +
  collectOrderEvidence.toString() +
  ")(" +
  JSON.stringify({ id: intent.id }) +
  ")}}catch(e){return {ok:false,error:String(e.message)}}})()";
module.exports = { collectOrderEvidence, reconciliationScript };
