const {
  CREATION_DEFAULTS,
  validateCreationPolicy,
} = require("./order-creation.cjs");
const DEFAULTS = {
  creation: structuredClone(CREATION_DEFAULTS),
  margin: "0.05",
  fee: "0.03",
  recognition: "1",
  otherCost: "0",
  tick: "0.01",
  buffer: "0.05",
  pollSeconds: 30,
  maxAgeSeconds: 75,
  cooldownSeconds: 60,
  decreaseCycles: 3,
  rental: { path: "/painel", selector: "", unit: "PH", locale: "pt-BR" },
  market: { path: "/market", selector: "", unit: "EH", locale: "pt-BR" },
  orders: {
    path: "/orders",
    row: "",
    id: "",
    bid: "",
    speed: "",
    balance: "",
    status: "",
    link: "",
    unit: "PH",
    locale: "pt-BR",
  },
  editor: {
    kind: "hashsell-dom",
    verified: false,
    identity: "",
    input: "",
    submit: "",
    unit: "PH",
    locale: "pt-BR",
  },
};
function validateConfig(input) {
  const c = JSON.parse(JSON.stringify(input));
  if (!c || typeof c !== "object") throw Error("Configuração inválida.");
  const limits = {
    margin: [0, Number.MAX_VALUE],
    fee: [0, 1],
    recognition: [0.01, 1],
    otherCost: [0, 100000],
    tick: [0.000001, 100],
    buffer: [0, 100],
  };
  for (const [key, [min, max]] of Object.entries(limits)) {
    if (
      !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(String(c[key])) ||
      !Number.isFinite(Number(c[key])) ||
      (key === "margin" && Number(c[key]) <= 0) ||
      Number(c[key]) < min ||
      Number(c[key]) > max
    )
      throw Error(`Valor inválido: ${key}`);
    c[key] = String(c[key]);
  }
  for (const [key, min, max] of [
    ["pollSeconds", 15, 300],
    ["maxAgeSeconds", 15, 300],
    ["cooldownSeconds", 0, 3600],
    ["decreaseCycles", 1, 20],
  ]) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max)
      throw Error(`Valor inválido: ${key}`);
  }
  if (c.maxAgeSeconds < c.pollSeconds)
    throw Error("Validade deve cobrir o intervalo de consulta.");
  c.creation = validateCreationPolicy(c.creation);
  // Older profiles used an explicit allowlist. Discovery now covers every order.
  delete c.managedOrders;
  // Older releases had a generic, unused editor and required manual calibration.
  // Only migrate its empty mapping; preserve custom mappings for explicit review.
  if (c.editor && !c.editor.kind) {
    c.editor.kind = ["identity", "input", "submit"].every((k) => !c.editor[k])
      ? "hashsell-dom"
      : "form";
    if (c.editor.kind === "hashsell-dom") c.editor.locale = "pt-BR";
  }
  for (const key of ["rental", "market", "orders", "editor"]) {
    const section = c[key];
    if (
      !section ||
      !["TH", "PH", "EH"].includes(section.unit) ||
      !["pt-BR", "en-US"].includes(section.locale)
    )
      throw Error(`Unidade/localidade inválida: ${key}`);
    for (const field of Object.keys(DEFAULTS[key])) {
      if (field === "verified") {
        if (typeof section[field] !== "boolean")
          throw Error("Confirmação inválida.");
        continue;
      }
      if (typeof section[field] !== "string" || section[field].length > 500)
        throw Error(`Campo inválido: ${key}.${field}`);
    }
    if (
      key !== "editor" &&
      (!/^\/(?!\/)/.test(section.path) || /[?#\\]/.test(section.path))
    )
      throw Error(`Caminho inválido: ${key}`);
  }
  return c;
}
function assertLiveReady(c) {
  if (c.editor.kind !== "hashsell-dom" || c.editor.locale !== "pt-BR")
    throw Error("Edição exige o adaptador DOM nativo Hashsell em pt-BR.");
}
module.exports = { DEFAULTS, validateConfig, assertLiveReady };
