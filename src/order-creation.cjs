const D = require("decimal.js");
const CREATION_DEFAULTS = Object.freeze({
  enabled: false,
  account: "",
  funding: "fixed",
  minimumBalance: "",
  amount: "",
  speedPH: "",
  sizing: "power",
  hours: "9",
  destination: "",
  allowActive: false,
});
function validateCreationPolicy(input) {
  if (input === undefined) return structuredClone(CREATION_DEFAULTS);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("Configuração de novas ordens inválida.");
  const p = { account: "", sizing: "power", hours: "9", ...input };
  if (
    Object.keys(p).sort().join(",") !==
    Object.keys(CREATION_DEFAULTS).sort().join(",")
  )
    throw Error("Campos de novas ordens inválidos.");
  if (
    typeof p.enabled !== "boolean" ||
    typeof p.allowActive !== "boolean" ||
    !["fixed", "all"].includes(p.funding) ||
    !["power", "duration"].includes(p.sizing)
  )
    throw Error("Opções de novas ordens inválidas.");
  for (const key of ["minimumBalance", "amount", "speedPH", "hours"]) {
    if (
      typeof p[key] !== "string" ||
      (p[key] !== "" &&
        (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(p[key]) ||
          p[key].length > 32 ||
          !new D(p[key]).isFinite() ||
          new D(p[key]).lte(0)))
    )
      throw Error("Informe um valor positivo para " + key + ".");
  }
  if (
    typeof p.destination !== "string" ||
    p.destination.length > 500 ||
    /[\x00-\x1f\x7f]/.test(p.destination)
  )
    throw Error("Destino de entrega inválido.");
  p.destination = p.destination.trim();
  if (
    typeof p.account !== "string" ||
    (p.account && !/^[a-f0-9]{64}$/.test(p.account))
  )
    throw Error("Conta de criação inválida.");
  if (
    p.enabled &&
    (!p.account ||
      !p.minimumBalance ||
      (p.sizing === "power" ? !p.speedPH : !p.hours) ||
      !p.destination ||
      (p.funding === "fixed" && !p.amount))
  )
    throw Error(
      "Preencha saldo mínimo, potência, destino e valor antes de ativar novas ordens.",
    );
  if (
    p.enabled &&
    (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      p.destination,
    ) ||
      (p.sizing === "power" &&
        (new D(p.speedPH).lt(1) || new D(p.speedPH).decimalPlaces() > 4)) ||
      (p.funding === "fixed" &&
        (new D(p.amount).lt(5) || new D(p.amount).decimalPlaces() > 2)))
  )
    throw Error(
      "Selecione um pool salvo, potência de pelo menos 1 PH/s e valor de pelo menos US$ 5,00, com até duas casas decimais.",
    );
  return p;
}
// Pure planning only. This module never submits or navigates a platform.
function planCreation({
  policy: input,
  wallet,
  orders,
  rental,
  market,
  config,
  pending,
  now = Date.now(),
}) {
  const policy = validateCreationPolicy(input);
  const hold = (reason) => ({ action: "hold", reason });
  if (!policy.enabled) return hold("Criação automática desligada.");
  if (pending) return hold("Conferindo a criação anterior.");
  const { fresh, ceiling } = require("./engine.cjs");
  if (![wallet, orders, rental, market].every((s) => fresh(s, now, config)))
    return hold("Aguardando leituras atualizadas.");
  if (
    !wallet.account ||
    wallet.account !== orders.account ||
    wallet.account !== policy.account
  )
    return hold("Aguardando identificação da conta Hashsell.");
  if (
    !Array.isArray(orders.items) ||
    orders.items.some((o) => typeof o.active !== "boolean")
  )
    return hold("Aguardando leitura completa das ordens.");
  if (!policy.allowActive && orders.items.some((o) => o.active))
    return hold("Aguardando as ordens ativas terminarem.");
  const decimal = (v) => {
    if (
      typeof v !== "string" ||
      !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(v) ||
      v.length > 32
    )
      throw Error("Leitura monetária inválida.");
    return new D(v);
  };
  const available = decimal(wallet.available);
  if (available.lt(policy.minimumBalance))
    return hold("Saldo disponível abaixo do mínimo.");
  const amount =
    policy.funding === "all"
      ? available.toDecimalPlaces(2, D.ROUND_FLOOR)
      : new D(policy.amount);
  if (amount.lt(5) || amount.gt(available))
    return hold("Saldo disponível insuficiente para a nova ordem.");
  if (decimal(rental.rate).lte(0)) return hold("Aguardando receita válida.");
  const target = decimal(market.cut)
    .plus(config.buffer)
    .div(config.tick)
    .ceil()
    .mul(config.tick);
  const max = new D(ceiling(rental.rate, config));
  if (target.lte(0) || target.gt(max) || target.decimalPlaces() > 4)
    return hold(
      "Aguardando preço compatível com sua margem. A criação será reavaliada automaticamente.",
    );
  const speed =
    policy.sizing === "duration"
      ? amount
          .mul(24)
          .div(new D(policy.hours).mul(target).mul(new D(1).plus(config.fee)))
          .toDecimalPlaces(4, D.ROUND_FLOOR)
      : new D(policy.speedPH);
  if (speed.lt(1))
    return hold(
      "Esse valor não permite a duração escolhida com o mínimo de 1 PH/s. Aumente o valor ou reduza a duração.",
    );
  const estimatedHours = amount
    .mul(24)
    .div(target.mul(speed).mul(new D(1).plus(config.fee)))
    .toString();
  return {
    action: "create",
    account: wallet.account,
    amount: amount.toString(),
    available: available.toString(),
    speedPH: speed.toString(),
    estimatedHours,
    destination: policy.destination,
    bid: target.toString(),
    ceiling: max.toString(),
    expiresAt: Math.min(
      now + 5000,
      ...[wallet, orders, rental, market].map(
        (s) => s.at + config.maxAgeSeconds * 1000,
      ),
    ),
  };
}
module.exports = { CREATION_DEFAULTS, validateCreationPolicy, planCreation };
