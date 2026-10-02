const D = require("decimal.js");
const { ceiling, fresh } = require("./engine.cjs");
const SCALE = { TH: "0.001", PH: "1", EH: "1000" };
function positive(value, name) {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value)
  )
    throw Error(`Número canônico inválido: ${name}`);
  const n = new D(value);
  if (!n.isFinite() || n.lte(0)) throw Error(`Valor não positivo: ${name}`);
  return n;
}
function authorizeBid(decision, config, sources, now = Date.now()) {
  if (
    !sources ||
    !["rental", "market", "orders"].every((k) => fresh(sources[k], now, config))
  )
    throw Error("Envio exige leituras recentes e independentes.");
  const order = sources.orders.items.find((o) => o.id === decision.id);
  if (!order || order.active !== true || new D(order.balance).lte(0))
    throw Error("Ordem ausente, inativa ou sem saldo antes do envio.");
  if (
    order.href !== decision.href ||
    !positive(order.bid, "lance atual").eq(
      positive(decision.current, "lance esperado"),
    )
  )
    throw Error("Identidade ou lance atual mudou antes do envio.");
  const target = positive(decision.target, "lance proposto");
  const cap = positive(
    ceiling(sources.rental.rate, config),
    "teto recalculado",
  );
  if (
    target.gt(cap) ||
    !target.mod(positive(config.tick, "incremento")).isZero()
  )
    throw Error("Lance acima do teto ou fora do incremento permitido.");
  if (
    !SCALE[config.editor.unit] ||
    !["pt-BR", "en-US"].includes(config.editor.locale)
  )
    throw Error("Unidade ou localidade de edição inválida.");
  return Object.freeze({
    id: decision.id,
    href: decision.href,
    current: decision.current,
    target: target.toFixed(),
    ceiling: cap.toFixed(),
    tick: config.tick,
    unit: config.editor.unit,
    locale: config.editor.locale,
    expiresAt: Math.min(
      now + 5000,
      ...Object.values(sources).map((s) => s.at + config.maxAgeSeconds * 1000),
    ),
  });
}
function encodeBid(target, editor) {
  if (!SCALE[editor.unit]) throw Error("Unidade desconhecida.");
  const raw = positive(target, "lance").mul(SCALE[editor.unit]).toFixed();
  return editor.locale === "pt-BR" ? raw.replace(".", ",") : raw;
}
function verifyPrepared(prepared, authority, now = Date.now()) {
  if (
    !authority ||
    now > authority.expiresAt ||
    now < authority.expiresAt - 5000
  )
    throw Error("Autorização de envio ausente ou expirada.");
  if (
    prepared.href !== authority.href ||
    prepared.id !== authority.id ||
    prepared.value !== encodeBid(authority.target, authority)
  )
    throw Error("Campo preparado diverge do lance autorizado.");
  if (
    positive(authority.target, "lance").gt(positive(authority.ceiling, "teto"))
  )
    throw Error("Lance acima do teto antes do envio.");
  return true;
}
// Independent, self-contained integer check, serialized into the renderer.
function verifyBidText(value, guard, observedUnit) {
  const fail = () => {
    throw Error("Valor, unidade, teto ou prazo de envio não confere.");
  };
  if (
    !guard ||
    Date.now() > guard.expiresAt ||
    Date.now() < guard.expiresAt - 5000 ||
    guard.unit !== observedUnit
  )
    fail();
  const integer = (s, comma = false) => {
    if (
      typeof s !== "string" ||
      !(
        comma
          ? /^(?:0|[1-9]\d*)(?:,\d{1,12})?$/
          : /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/
      ).test(s)
    )
      fail();
    const [whole, part = ""] = s.replace(",", ".").split(".");
    return BigInt(whole) * 1000000000000n + BigInt(part.padEnd(12, "0"));
  };
  let actual = integer(value, guard.locale === "pt-BR");
  if (observedUnit === "TH") actual *= 1000n;
  else if (observedUnit === "EH") {
    if (actual % 1000n) fail();
    actual /= 1000n;
  } else if (observedUnit !== "PH") fail();
  const target = integer(guard.target),
    cap = integer(guard.ceiling),
    tick = integer(guard.tick);
  if (
    actual <= 0n ||
    actual !== target ||
    actual > cap ||
    tick <= 0n ||
    actual % tick
  )
    fail();
  return true;
}
module.exports = { authorizeBid, encodeBid, verifyPrepared, verifyBidText };
