const D = require("decimal.js");
const {
  inspectFormPayload,
  inspectFormHeaders,
} = require("./hashsell-form.cjs");
const { verifyPrepared } = require("./bid-safety.cjs");
function inspectPayload(details, expected, now = Date.now()) {
  if (expected?.domSave)
    throw Error("Ajuste DOM exige o formulário observado da Hashsell.");
  if (!expected || now > expected.authority.expiresAt)
    throw Error("Envio sem autorização vigente.");
  verifyPrepared(expected.prepared, expected.authority, now);
  const url = new URL(details.url);
  if (
    url.origin !== "https://hashsell.com" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw Error("Destino de envio inválido.");
  if (details.method !== "POST") throw Error("Método de envio inválido.");
  const parts = details.uploadData;
  if (
    !Array.isArray(parts) ||
    !parts.length ||
    parts.some((p) => !Buffer.isBuffer(p.bytes) || p.file)
  )
    throw Error("Payload não verificável.");
  const body = Buffer.concat(parts.map((p) => p.bytes)).toString("utf8");
  if (body.length > 1000) throw Error("Payload inesperado.");
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    // Never include request contents: forms can contain sensitive fields.
    throw Error(
      body.startsWith("--")
        ? "Formulário não permitido nesta etapa. Requisição bloqueada."
        : "Formato do envio diferente do JSON validado. Requisição bloqueada.",
    );
  }
  // Reject duplicate JSON keys, strings with escapes, exponent notation and extra fields.
  const canonical = JSON.stringify(payload);
  if (
    body.replace(/\s/g, "") !== canonical ||
    Object.keys(payload).sort().join(",") !== "limitHash,priceScaled"
  )
    throw Error("Estrutura de payload divergente.");
  if (
    !/^\d+$/.test(payload.priceScaled) ||
    !/^\d+$/.test(payload.limitHash) ||
    typeof payload.priceScaled !== "string" ||
    typeof payload.limitHash !== "string"
  )
    throw Error("Payload deve usar inteiros decimais em texto.");
  const scaled = new D(expected.authority.target).mul(100000);
  if (
    !scaled.isInteger() ||
    payload.priceScaled !== scaled.toFixed(0) ||
    new D(payload.priceScaled).div(100000).gt(expected.authority.ceiling)
  )
    throw Error("Preço da requisição diverge do lance ou ultrapassa o teto.");
  if (payload.limitHash !== expected.limitHash)
    throw Error("O limite de velocidade não pode ser alterado.");
  if (url.pathname !== expected.path)
    throw Error("Ordem ou operação de envio divergente.");
  return payload;
}
class RequestGuard {
  constructor(wc, { blockAll = false } = {}) {
    this.wc = wc;
    this.readOnlyIds = new Set();
    this.authorization = null;
    this.result = null;
    this.preview = null;
    this.inflight = new Set();
    this.formRequests = new Map();
    this.saveRequests = new Map();
    this.generation = 0;
    this.previewComplete = false;
    wc.session.webRequest.onCompleted((details) => {
      if (this.creation && details.webContentsId === this.creation.wc.id)
        return this.creation.completed(details);
      const save = this.saveRequests.get(details.id);
      if (save) {
        save.completed = true;
        save.statusCode = details.statusCode;
        this.saveRequests.delete(details.id);
      }
      this.formRequests.delete(details.id);
      if (!this.inflight.delete(details.id)) return;
      if (details.statusCode < 200 || details.statusCode >= 300) {
        this.result = {
          admitted: false,
          error: `Prévia Hashsell recusada (HTTP ${details.statusCode}).`,
        };
        this.authorization = null;
      } else if (!this.inflight.size) this.previewComplete = true;
    });
    wc.session.webRequest.onErrorOccurred((details) => {
      if (this.creation && details.webContentsId === this.creation.wc.id)
        return this.creation.failed(details);
      const save = this.saveRequests.get(details.id);
      if (save) {
        save.transportError = "Falha de rede após o envio.";
        this.saveRequests.delete(details.id);
      }
      this.formRequests.delete(details.id);
      if (!this.inflight.delete(details.id)) return;
      this.result = {
        admitted: false,
        error: "Falha ao carregar a prévia Hashsell.",
      };
      this.authorization = null;
    });
    wc.session.webRequest.onBeforeSendHeaders((details, cb) => {
      if (this.creation && details.webContentsId === this.creation.wc.id)
        return this.creation.beforeHeaders(details, cb);
      if (
        details.webContentsId !== wc.id ||
        ["GET", "HEAD", "OPTIONS"].includes(details.method)
      )
        return cb({});
      const candidate = this.formRequests.get(details.id);
      const hasAction = Object.keys(details.requestHeaders || {}).some(
        (k) => k.toLowerCase() === "next-action",
      );
      if (!candidate) return cb({ cancel: hasAction });
      this.formRequests.delete(details.id);
      try {
        if (candidate.revoked || candidate.generation !== this.generation)
          throw Error(
            "Envio do formulário cancelado antes da confirmação de rede.",
          );
        if (wc.getURL() !== candidate.expected.prepared.href)
          throw Error("Página mudou antes do envio do formulário.");
        const payload = inspectFormHeaders(details, candidate);
        const dryRun = !!candidate.expected.dryRun;
        this.result = {
          admitted: !dryRun,
          blockedProbe: dryRun,
          path: new URL(details.url).pathname,
          payload,
        };
        if (!dryRun) this.saveRequests.set(details.id, this.result);
        cb({ cancel: dryRun });
      } catch (error) {
        if (
          candidate.generation === this.generation &&
          !this.result?.admitted &&
          !this.result?.error
        )
          this.result = { admitted: false, error: error.message };
        cb({ cancel: true });
      }
    });
    wc.session.webRequest.onBeforeRequest((details, cb) => {
      if (this.creation && details.webContentsId === this.creation.wc.id)
        return this.creation.beforeRequest(details, cb);
      if (
        blockAll ||
        (this.readOnlyIds.has(details.webContentsId) &&
          !["GET", "HEAD", "OPTIONS"].includes(details.method))
      )
        return cb({ cancel: true });
      if (
        details.webContentsId !== wc.id ||
        ["GET", "HEAD", "OPTIONS"].includes(details.method)
      )
        return cb({});
      try {
        const expected = this.authorization;
        if (expected?.domPreview || expected?.domSave) {
          if (!expected.isCurrent() || wc.getURL() !== expected.prepared.href)
            throw Error("Ajuste cancelado ou página da ordem alterada.");
          if (expected.domPreview) {
            const path = new URL(details.url).pathname;
            const match = path.match(
              /^\/api\/proxy\/orders\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/simulate$/i,
            );
            if (!match)
              throw Error(
                "Somente a prévia do lance é permitida antes de salvar.",
              );
            const payload = inspectPayload(details, { ...expected, path });
            const orderRoot = path.slice(0, -"/simulate".length);
            if (
              (this.preview && this.preview.orderRoot !== orderRoot) ||
              ++expected.count > 4
            )
              throw Error(
                "Prévia mudou de ordem ou excedeu o limite de consultas.",
              );
            this.preview = {
              orderRoot,
              limitHash: expected.limitHash,
              prepared: expected.prepared,
              target: expected.authority.target,
            };
            this.inflight.add(details.id);
            this.previewComplete = false;
            this.result = { preview: true, payload };
            return cb({});
          }
        }
        if (this.authorization?.domSave) {
          const expected = this.authorization;
          const candidate = inspectFormPayload(details, expected);
          this.authorization = null; // Reserve this one request before checking its headers.
          this.formRequests.set(details.id, {
            ...candidate,
            expected,
            generation: this.generation,
          });
          this.result = { awaitingHeaders: true };
          cb({});
          return;
        }
        const payload = inspectPayload(details, this.authorization);
        const dryRun = this.authorization.dryRun;
        this.authorization = null; // one admission, including blocked probes
        this.result = {
          admitted: !dryRun,
          blockedProbe: !!dryRun,
          path: new URL(details.url).pathname,
          payload,
        };
        cb({ cancel: !!dryRun });
      } catch (error) {
        this.authorization = null;
        // Never erase evidence that a previous request may already have spent.
        if (!this.result?.admitted && !this.result?.error)
          this.result = { admitted: false, error: error.message };
        cb({ cancel: true });
      }
    });
  }
  arm(expected) {
    this.disarm();
    this.generation++;
    verifyPrepared(expected.prepared, expected.authority);
    this.authorization = structuredClone(expected);
    this.result = null;
  }
  armPreview(prepared, authority, limitHash, isCurrent) {
    this.disarm();
    this.generation++;
    verifyPrepared(prepared, authority);
    this.preview = null;
    this.previewComplete = false;
    this.inflight.clear();
    this.result = null;
    this.authorization = {
      prepared: structuredClone(prepared),
      authority,
      limitHash,
      isCurrent,
      domPreview: true,
      count: 0,
    };
  }
  armDOMSave(prepared, authority, isCurrent) {
    this.disarm();
    this.generation++;
    verifyPrepared(prepared, authority);
    if (
      !this.previewComplete ||
      !this.preview ||
      this.result?.error ||
      this.preview.target !== authority.target ||
      JSON.stringify(this.preview.prepared) !== JSON.stringify(prepared)
    )
      throw Error("Prévia do formulário não confirmada para este lance.");
    this.authorization = {
      ...this.preview,
      authority,
      isCurrent,
      domSave: true,
    };
    this.preview = null;
    this.previewComplete = false;
    this.result = null;
  }
  disarm() {
    this.creation?.cancel();
    this.authorization = null;
    for (const candidate of this.formRequests.values())
      candidate.revoked = true;
  }
}
module.exports = { inspectPayload, RequestGuard };
