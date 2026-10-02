const D = require("decimal.js");
const { verifyPrepared } = require("./bid-safety.cjs");
// Public editor build inspected on 2026-09-29. Unknown actions fail closed.
const UPDATE_ACTION = "7056d2f339116e189948b384d3364705634ca693b2";
function parseFormBody(parts) {
  if (
    !Array.isArray(parts) ||
    !parts.length ||
    parts.some((p) => !Buffer.isBuffer(p.bytes) || p.file)
  )
    throw Error("Formulário contém dados não verificáveis.");
  if (parts.reduce((n, p) => n + p.bytes.length, 0) > 8192)
    throw Error("Formulário excede tamanho permitido.");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(parts.map((p) => p.bytes)),
    );
  } catch {
    throw Error("Codificação do formulário inválida.");
  }
  const boundary = text.match(/^--([A-Za-z0-9_-]{1,70})\r\n/)?.[1];
  if (!boundary) throw Error("Separador do formulário inválido.");
  const sections = text.split("--" + boundary);
  if (
    sections.length !== 6 ||
    sections[0] !== "" ||
    !["--\r\n", "--"].includes(sections.at(-1))
  )
    throw Error("Estrutura multipart divergente.");
  const fields = Object.create(null);
  for (const section of sections.slice(1, -1)) {
    const match = section.match(
      /^\r\nContent-Disposition: form-data; name="(0|_1_unit|_1_price|_1_limit)"\r\n\r\n([^\r\n]*)\r\n$/,
    );
    if (!match || Object.hasOwn(fields, match[1]))
      throw Error("Campos multipart extras, duplicados ou inválidos.");
    fields[match[1]] = match[2];
  }
  if (Object.keys(fields).sort().join(",") !== "0,_1_limit,_1_price,_1_unit")
    throw Error("Campos do ajuste não conferem.");
  return { boundary, fields };
}
function inspectFormPayload(details, expected, now = Date.now()) {
  if (!expected?.domSave)
    throw Error("Formulário permitido somente ao salvar pelo DOM.");
  verifyPrepared(expected.prepared, expected.authority, now);
  const url = new URL(details.url);
  if (
    details.method !== "POST" ||
    details.url !== expected.prepared.href ||
    url.origin !== "https://hashsell.com" ||
    url.pathname !== `/orders/${expected.prepared.id}` ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw Error("Destino do formulário diverge da ordem.");
  const uuid = expected.orderRoot?.match(
    /^\/api\/proxy\/orders\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i,
  )?.[1];
  const { fields, boundary } = parseFormBody(details.uploadData);
  if (
    !uuid ||
    fields["0"] !== JSON.stringify([uuid, { status: "idle" }, "$K1"])
  )
    throw Error("Ação vinculada a outra ordem, estado ou argumentos.");
  const unit = fields._1_unit;
  if (
    !["TH", "PH", "EH"].includes(unit) ||
    unit !== expected.authority.unit ||
    unit !== expected.prepared.unit
  )
    throw Error("Unidade do formulário diverge do campo autorizado.");
  if (
    ![fields._1_price, fields._1_limit].every((v) =>
      /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(v),
    )
  )
    throw Error("Número do formulário não é decimal canônico.");
  const pricePH = new D(fields._1_price).div(
    { TH: "0.001", PH: "1", EH: "1000" }[unit],
  );
  if (
    pricePH.lte(0) ||
    !pricePH.eq(expected.authority.target) ||
    pricePH.gt(expected.authority.ceiling) ||
    !pricePH.mod(expected.authority.tick).isZero()
  )
    throw Error("Preço do formulário diverge do lance, incremento ou teto.");
  const limitHash = new D(fields._1_limit).mul(
    { TH: "1000000", PH: "1000000000", EH: "1000000000000" }[unit],
  );
  if (
    limitHash.lte(0) ||
    !limitHash.isInteger() ||
    !limitHash.eq(expected.limitHash)
  )
    throw Error("Limite de velocidade do formulário foi alterado.");
  const priceScaled = pricePH.mul(100000);
  if (!priceScaled.isInteger())
    throw Error("Preço do formulário fora da precisão da plataforma.");
  return {
    boundary,
    payload: {
      priceScaled: priceScaled.toFixed(0),
      limitHash: limitHash.toFixed(0),
    },
  };
}
function inspectFormHeaders(details, candidate, now = Date.now()) {
  const expected = candidate.expected;
  verifyPrepared(expected.prepared, expected.authority, now);
  if (
    details.url !== expected.prepared.href ||
    details.method !== "POST" ||
    !expected.isCurrent()
  )
    throw Error("Envio do formulário cancelado, expirado ou redirecionado.");
  const one = (name) => {
    const entries = Object.entries(details.requestHeaders || {}).filter(
      ([key]) => key.toLowerCase() === name,
    );
    if (entries.length !== 1 || typeof entries[0][1] !== "string")
      throw Error("Cabeçalho do formulário ausente ou ambíguo.");
    return entries[0][1];
  };
  if (one("next-action") !== UPDATE_ACTION)
    throw Error("Ação de servidor diferente de ajustar lance e limite.");
  const type = one("content-type");
  if (
    type !== `multipart/form-data; boundary=${candidate.boundary}` &&
    type !== `multipart/form-data; boundary="${candidate.boundary}"`
  )
    throw Error("Tipo ou separador do envio não confere.");
  return candidate.payload;
}
module.exports = {
  UPDATE_ACTION,
  parseFormBody,
  inspectFormPayload,
  inspectFormHeaders,
};
