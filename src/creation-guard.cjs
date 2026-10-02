const D = require("decimal.js");
const CREATE_ACTION = "608990c82a03a35f7bf314414a78bf9b3df75419a6";
const REFUSAL_REASONS = new Set([
  "Criação cancelada ou valores fora dos limites.",
  "Somente prévia de criação é permitida.",
  "Prévia inválida.",
  "Prévia excede tamanho permitido.",
  "Prévia diverge da nova ordem.",
  "Destino da criação inválido.",
  "Formulário inválido.",
  "Formulário excessivo.",
  "Separador inválido.",
  "Multipart inválido.",
  "Campo extra ou duplicado.",
  "Campos da criação divergentes.",
  "Valor, potência, pool ou chave não confere.",
  "Página mudou.",
  "Envio sem autorização.",
  "Envio cancelado ou já autorizado uma vez.",
  "Ação de criação não validada.",
  "Bloqueio integral de diagnóstico.",
  "Envio bloqueado pelo teste.",
]);
function validGrant(g, now = Date.now()) {
  if (
    !g ||
    !g.isCurrent() ||
    now > g.expiresAt ||
    g.href !== "https://hashsell.com/orders/new" ||
    !new D(g.bid).gt(0) ||
    new D(g.bid).gt(g.ceiling) ||
    !new D(g.bid).mod(g.tick).eq(0) ||
    new D(g.amount).lt(5) ||
    new D(g.speedPH).lt(1) ||
    !new D(g.debit).gte(g.amount) ||
    new D(g.debit).gt(g.available)
  )
    throw Error("Criação cancelada ou valores fora dos limites.");
}
function quotePayload(details, g) {
  validGrant(g);
  if (
    details.url !== "https://hashsell.com/api/proxy/orders/quote" ||
    details.method !== "POST"
  )
    throw Error("Somente prévia de criação é permitida.");
  const body = Buffer.concat(
    (details.uploadData || []).map((p) => {
      if (!Buffer.isBuffer(p.bytes) || p.file) throw Error("Prévia inválida.");
      return p.bytes;
    }),
  ).toString("utf8");
  if (body.length > 2048) throw Error("Prévia excede tamanho permitido.");
  const p = JSON.parse(body);
  if (
    JSON.stringify(p) !== body ||
    Object.keys(p).sort().join(",") !==
      "amountUsd,limitHash,poolId,priceScaled,type" ||
    p.type !== "STANDARD" ||
    p.poolId !== g.destination ||
    !["priceScaled", "limitHash", "amountUsd"].every(
      (k) => typeof p[k] === "string" && /^\d+(?:\.\d+)?$/.test(p[k]),
    ) ||
    !new D(p.priceScaled).eq(new D(g.bid).mul(100000)) ||
    !new D(p.limitHash).eq(new D(g.speedPH).mul(1000000000)) ||
    !new D(p.amountUsd).eq(g.amount)
  )
    throw Error("Prévia diverge da nova ordem.");
  return p;
}
function formPayload(details, g) {
  validGrant(g);
  if (details.url !== g.href || details.method !== "POST")
    throw Error("Destino da criação inválido.");
  const parts = details.uploadData;
  if (
    !Array.isArray(parts) ||
    !parts.length ||
    parts.some((p) => !Buffer.isBuffer(p.bytes) || p.file)
  )
    throw Error("Formulário inválido.");
  const bytes = Buffer.concat(parts.map((p) => p.bytes));
  if (bytes.length > 16384) throw Error("Formulário excessivo.");
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    boundary = body.match(/^--([A-Za-z0-9_-]{1,70})\r\n/)?.[1];
  if (!boundary) throw Error("Separador inválido.");
  const chunks = body.split("--" + boundary);
  if (chunks[0] !== "" || !["--\r\n", "--"].includes(chunks.at(-1)))
    throw Error("Multipart inválido.");
  const fields = {};
  for (const c of chunks.slice(1, -1)) {
    const m = c.match(
      /^\r\nContent-Disposition: form-data; name="([^"\r\n]{1,80})"\r\n\r\n([^\r\n]*)\r\n$/,
    );
    if (!m || Object.hasOwn(fields, m[1]))
      throw Error("Campo extra ou duplicado.");
    fields[m[1]] = m[2];
  }
  const expected = Object.fromEntries(
    Object.entries(g.fields).map(([k, v]) => ["_1_" + k, v]),
  );
  expected["0"] = JSON.stringify([{ status: "idle" }, "$K1"]);
  if (
    Object.keys(fields).sort().join("|") !==
      Object.keys(expected).sort().join("|") ||
    Object.entries(expected).some(([k, v]) => fields[k] !== v)
  )
    throw Error("Campos da criação divergentes.");
  if (
    fields._1_idempotencyKey !== g.key ||
    fields._1_unit !== "PH" ||
    fields._1_type !== "STANDARD" ||
    fields._1_poolId !== g.destination ||
    !new D(fields._1_amount).eq(g.amount) ||
    !new D(fields._1_limit).eq(g.speedPH) ||
    !new D(fields._1_price).eq(g.bid)
  )
    throw Error("Valor, potência, pool ou chave não confere.");
  return { boundary };
}
class CreationGuard {
  constructor(wc, { blockAll = false } = {}) {
    this.wc = wc;
    this.blockAll = blockAll;
    this.requests = new Map();
    this.receipt = null;
    this.previewReady = false;
    this.refusals = [];
  }
  resetDiagnostics() {
    this.refusals = [];
  }
  diagnostics() {
    return this.refusals.map((item) => ({ ...item }));
  }
  recordRefusal(d, message, phase = this.phase) {
    if (d.method !== "POST") return;
    let pathname = null;
    try {
      pathname = new URL(d.url).pathname.slice(0, 300);
    } catch {}
    this.refusals.push({
      method: "POST",
      pathname,
      phase: ["preview", "save"].includes(phase) ? phase : "none",
      reason: REFUSAL_REASONS.has(message)
        ? message
        : "Validação da criação recusada.",
    });
    this.refusals = this.refusals.slice(-20);
  }
  arm(g, phase) {
    validGrant(g);
    this.grant = g;
    this.phase = phase;
    if (phase === "preview") {
      this.receipt = null;
      this.previewReady = false;
    }
  }
  cancel() {
    this.grant = null;
    this.phase = null;
    for (const c of this.requests.values()) c.revoked = true;
  }
  beforeRequest(d, cb) {
    if (this.blockAll) {
      this.recordRefusal(d, "Bloqueio integral de diagnóstico.");
      return cb({ cancel: true });
    }
    if (["GET", "HEAD", "OPTIONS"].includes(d.method)) return cb({});
    try {
      if (this.wc.getURL() !== this.grant?.href) throw Error("Página mudou.");
      if (this.phase === "preview") {
        quotePayload(d, this.grant);
        this.requests.set(d.id, { phase: "preview", grant: this.grant });
        return cb({});
      }
      if (this.phase !== "save" || this.receipt?.admitted)
        throw Error("Envio sem autorização.");
      const c = formPayload(d, this.grant);
      this.requests.set(d.id, { ...c, phase: "save", grant: this.grant });
      this.grant = null;
      cb({});
    } catch (e) {
      this.recordRefusal(d, e.message);
      if (this.phase === "save" && !this.receipt?.admitted)
        this.receipt = { admitted: false, error: e.message };
      cb({ cancel: true });
    }
  }
  beforeHeaders(d, cb) {
    if (["GET", "HEAD", "OPTIONS"].includes(d.method)) return cb({});
    const c = this.requests.get(d.id);
    try {
      if (!c || c.revoked || (c.phase === "save" && c.used))
        throw Error("Envio cancelado ou já autorizado uma vez.");
      validGrant(c.grant);
      if (this.wc.getURL() !== c.grant.href) throw Error("Página mudou.");
      if (c.phase === "save") {
        const h = Object.fromEntries(
          Object.entries(d.requestHeaders || {}).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        );
        if (
          h["next-action"] !== CREATE_ACTION ||
          h["content-type"] !== "multipart/form-data; boundary=" + c.boundary
        )
          throw Error("Ação de criação não validada.");
        c.used = true;
        this.receipt = {
          admitted: !c.grant.dryRun,
          blockedProbe: !!c.grant.dryRun,
          at: Date.now(),
        };
        if (c.grant.dryRun) {
          this.recordRefusal(d, "Envio bloqueado pelo teste.", c.phase);
          return cb({ cancel: true });
        }
      }
      cb({});
    } catch (e) {
      this.recordRefusal(d, e.message, c?.phase);
      if (c?.phase === "save" && !this.receipt?.admitted)
        this.receipt = { admitted: false, error: e.message };
      cb({ cancel: true });
    }
  }
  completed(d) {
    const c = this.requests.get(d.id);
    this.requests.delete(d.id);
    if (
      c?.phase === "preview" &&
      d.statusCode >= 200 &&
      d.statusCode < 300 &&
      !c.revoked
    )
      this.previewReady = true;
    if (c?.phase === "save" && this.receipt?.admitted) {
      this.receipt.completed = true;
      this.receipt.statusCode = d.statusCode;
    }
  }
  failed(d) {
    const c = this.requests.get(d.id);
    this.requests.delete(d.id);
    if (c?.phase === "save" && this.receipt?.admitted)
      this.receipt.transportError = true;
  }
}
module.exports = { CREATE_ACTION, quotePayload, formPayload, CreationGuard };
