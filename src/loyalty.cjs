const D = require("decimal.js");
const { parseNumber } = require("./engine.cjs");
function applyLoyalty(baseRate, loyalty) {
  const bonus = new D(
    parseNumber(loyalty.bonus.replace(/%$/, ""), loyalty.locale),
  ).div(100);
  const base = new D(baseRate);
  if (
    !base.isFinite() ||
    !base.gt(0) ||
    !bonus.isFinite() ||
    bonus.lt(0) ||
    bonus.gt("0.1")
  )
    throw Error("Taxa ou bônus de fidelidade fora do limite verificado.");
  return {
    baseRate: base.toString(),
    rate: base.mul(new D(1).plus(bonus)).toString(),
    loyalty: { plan: loyalty.plan, bonus: bonus.toString() },
  };
}
module.exports = { applyLoyalty };
