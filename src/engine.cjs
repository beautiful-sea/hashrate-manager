const D = require("decimal.js");
D.set({ precision: 32 });
const FACTORS = { TH: "1000", PH: "1", EH: "0.001" };
function parseNumber(text, locale = "pt-BR") {
  const raw = String(text)
    .replace(/US\$|USD|R\$|\$/gi, "")
    .trim();
  const match = raw.match(/-?\d[\d.,\s\u00a0]*/g);
  if (!match || match.length !== 1)
    throw Error("Valor numérico ausente ou ambíguo.");
  let n = match[0].replace(/[\s\u00a0]/g, "");
  const pattern =
    locale === "pt-BR"
      ? /^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/
      : /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
  if (!pattern.test(n))
    throw Error("Formato numérico incompatível com a localidade.");
  n =
    locale === "pt-BR"
      ? n.replace(/\./g, "").replace(",", ".")
      : n.replace(/,/g, "");
  const value = new D(n);
  if (!value.isFinite() || value.lt(0))
    throw Error("Valor negativo ou inválido.");
  return value.toString();
}
function pricePerPH(text, unit, locale) {
  if (!FACTORS[unit]) throw Error("Unidade desconhecida.");
  const seen = [...String(text).matchAll(/\b(TH|PH|EH)\s*\/\s*s\b/gi)].map(
    (x) => x[1].toUpperCase(),
  );
  if (seen.some((x) => x !== unit))
    throw Error("Unidade da página diverge da configuração.");
  return new D(parseNumber(text, locale)).mul(FACTORS[unit]).toString();
}
function ceiling(rate, c) {
  const net = new D(rate)
    .mul(c.recognition)
    .mul(new D(1).minus(c.margin))
    .minus(c.otherCost);
  return D.max(0, net.div(new D(1).plus(c.fee)))
    .div(c.tick)
    .floor()
    .mul(c.tick)
    .toString();
}
function fresh(snapshot, now, c) {
  return (
    snapshot &&
    Number.isFinite(snapshot.at) &&
    now >= snapshot.at &&
    now - snapshot.at <= c.maxAgeSeconds * 1000
  );
}
function marketMargin({ rental, market, config, now = Date.now() }) {
  if (![rental, market].every((source) => fresh(source, now, config)))
    return null;
  try {
    const revenue = new D(rental.rate).mul(config.recognition);
    const cost = new D(market.cut)
      .mul(new D(1).plus(config.fee))
      .plus(config.otherCost);
    if (
      !revenue.isFinite() ||
      revenue.lte(0) ||
      !cost.isFinite() ||
      new D(market.cut).lt(0)
    )
      return null;
    return revenue.minus(cost).div(revenue).mul(100).toString();
  } catch {
    return null;
  }
}
function decide({
  rental,
  market,
  orders,
  config: c,
  memory = {},
  pending = {},
  now = Date.now(),
}) {
  if (![rental, market, orders].every((s) => fresh(s, now, c)))
    return {
      blocked:
        "Leitura ausente ou desatualizada. Ordens remotas podem continuar gastando.",
      decisions: [],
    };
  if (new D(rental.rate).lte(0) || new D(market.cut).lt(0))
    return { blocked: "Tarifa ou corte inválidos.", decisions: [] };
  const max = new D(ceiling(rental.rate, c));
  const target = new D(market.cut)
    .plus(c.buffer)
    .div(c.tick)
    .ceil()
    .mul(c.tick);
  const decisions = orders.items.map((o) => {
    const prev = memory[o.id] || {};
    const base = {
      id: o.id,
      current: o.bid,
      ceiling: max.toString(),
      target: o.bid,
      action: "hold",
      reason:
        "O lance está adequado às condições atuais. O app continua acompanhando.",
      stable: 0,
      href: o.href,
    };
    if (pending[o.id])
      return {
        ...base,
        reason:
          pending[o.id].status === "checking"
            ? "O app está verificando se a Hashsell aplicou o ajuste."
            : "A Hashsell ainda não confirmou o ajuste. O app está verificando automaticamente.",
      };
    if (now < (prev.retryAfter || 0))
      return {
        ...base,
        reason:
          prev.retryReason === "platform-cooldown"
            ? "A Hashsell exige um intervalo entre reduções. O app aguardará e avaliará novamente."
            : "A Hashsell não aceitou o último ajuste. O app vai avaliar novamente em instantes.",
      };
    if (o.active !== true || new D(o.balance).lte(0))
      return {
        ...base,
        reason: "Esta ordem terminou ou está sem saldo para operar.",
      };
    const bid = new D(o.bid);
    if (max.lte(0))
      return {
        ...base,
        action: "alert",
        reason:
          "Teto inviável. Interrompa a ordem na Hashsell; pausar o robô não interrompe o gasto.",
      };
    if (bid.gt(max))
      return {
        ...base,
        action: "decrease",
        target: max.toString(),
        title: "Proteger sua margem",
        reason: target.gt(max)
          ? "O preço para receber potência está acima do que sua margem permite. O app propõe baixar o lance para proteger seu lucro; isso não retoma a entrega. Acompanharemos o mercado automaticamente."
          : "O lance atual deixa seu lucro abaixo da margem escolhida. O app propõe reduzir o custo para respeitar essa margem.",
      };
    if (target.gt(max))
      return {
        ...base,
        action: "alert",
        title: "Aguardando preço melhor",
        reason:
          "O preço para receber potência está acima do que sua margem permite. O app aguarda um preço melhor e volta a ajustar automaticamente. Você não precisa reativar nada.",
      };
    if (now - (prev.changedAt || 0) < c.cooldownSeconds * 1000)
      return {
        ...base,
        reason:
          "Aguardando um pouco antes do próximo ajuste. Você não precisa fazer nada.",
      };
    if (bid.lt(target)) {
      // Do not chase our own cutoff upwards when an order is already being served.
      if (bid.gte(market.cut) && o.delivering === true)
        return {
          ...base,
          reason:
            "A ordem já está recebendo potência. Não é necessário pagar mais.",
        };
      return {
        ...base,
        action: "increase",
        target: target.toString(),
        reason:
          "Aumentar o lance para tentar receber potência, mantendo sua margem mínima.",
      };
    }
    if (bid.gt(target)) {
      const stable =
        prev.candidate === target.toString() ? (prev.stable || 0) + 1 : 1;
      return {
        ...base,
        stable,
        candidate: target.toString(),
        action: stable >= c.decreaseCycles ? "decrease" : "hold",
        target: target.toString(),
        reason:
          stable >= c.decreaseCycles
            ? "O preço caiu. Reduzir o lance para gastar menos."
            : "O preço parece estar caindo. O app vai confirmar antes de reduzir o lance.",
      };
    }
    return base;
  });
  return { ceiling: max.toString(), decisions, blocked: null };
}
module.exports = {
  parseNumber,
  pricePerPH,
  ceiling,
  decide,
  fresh,
  marketMargin,
};
