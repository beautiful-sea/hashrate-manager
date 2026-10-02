const Decimal = require("decimal.js");
// Only totals leave this module; account and order identifiers are never serialized.
function financialTotals(monitor, now = Date.now()) {
  const source = monitor.snapshots?.orders;
  if (
    !monitor.running ||
    monitor.demo ||
    !source ||
    monitor.errors?.orders ||
    !Number.isFinite(source.at) ||
    source.at > now ||
    now - source.at > 120000 ||
    !Array.isArray(source.items)
  )
    return null;
  let capital = new Decimal(0),
    orders = 0;
  try {
    for (const order of source.items) {
      if (typeof order.active !== "boolean") return null;
      if (!order.active) continue;
      const balance = new Decimal(order.balance);
      if (!balance.isFinite() || balance.lt(0) || balance.gt(1000000000))
        return null;
      capital = capital.plus(balance);
      orders++;
    }
    if (orders > 10000 || capital.gt(1000000000)) return null;
    return {
      capitalCents: capital.mul(100).toDecimalPlaces(0).toNumber(),
      orders,
    };
  } catch {
    return null;
  }
}
module.exports = { financialTotals };
