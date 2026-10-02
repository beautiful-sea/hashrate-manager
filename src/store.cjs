const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DEFAULTS, validateConfig } = require("./config.cjs");
class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "state.json");
    this.state = {
      version: 1,
      bidDefaultsRevision: 2,
      config: structuredClone(DEFAULTS),
      pending: {},
      memory: {},
      history: [],
    };
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (
        saved.version !== 1 ||
        !saved.pending ||
        !saved.memory ||
        !Array.isArray(saved.history)
      )
        throw Error("Estado inválido. Preserve state.json para recuperação.");
      saved.config = validateConfig(saved.config);
      this.state = saved;
      if (!saved.bidDefaultsRevision || saved.bidDefaultsRevision < 2) {
        const oldDefaults =
          saved.config.tick === "0.0001" && saved.config.buffer === "0.001";
        const backup =
          this.file +
          ".before-bid-defaults-v2-" +
          Date.now() +
          "-" +
          randomUUID().slice(0, 8);
        fs.copyFileSync(this.file, backup, fs.constants.COPYFILE_EXCL);
        this.commit((next) => {
          next.bidDefaultsRevision = 2;
          if (oldDefaults) {
            next.config.tick = DEFAULTS.tick;
            next.config.buffer = DEFAULTS.buffer;
          }
        });
      }
    }
  }
  commit(mutator) {
    const next = structuredClone(this.state);
    mutator(next);
    const tmp = this.file + ".tmp";
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(next, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    this.state = next;
  }
  append(next, type, data) {
    next.history.push({ eventId: randomUUID(), at: Date.now(), type, ...data });
    next.history = next.history.slice(-5000);
  }
  log(type, data = {}) {
    this.commit((s) => this.append(s, type, data));
  }
  saveConfig(config) {
    const valid = validateConfig(config);
    this.commit((s) => {
      s.config = valid;
      s.memory = {};
      this.append(s, "config", {
        message:
          "Configuração atualizada. Monitoramento e ajustes mantêm o estado escolhido pelo usuário.",
      });
    });
  }
  intent(decision) {
    if (this.state.pending[decision.id])
      throw Error(
        "Esta ordem tem envio pendente; reconcilie antes de continuar.",
      );
    const intent = {
      id: decision.id,
      previous: decision.current,
      target: decision.target,
      href: decision.href,
      intentId: randomUUID(),
      at: Date.now(),
    };
    this.commit((s) => {
      s.pending[intent.id] = intent;
      this.append(s, "intent", intent);
    });
    return intent;
  }
  reconcile(orders) {
    let count = 0;
    for (const p of Object.values(this.state.pending)) {
      const found = orders.find((o) => o.id === p.id);
      if (found && require("decimal.js")(found.bid).eq(p.target)) {
        this.commit((s) => {
          delete s.pending[p.id];
          s.memory[p.id] = { changedAt: Date.now() };
          this.append(s, "confirmed", {
            id: p.id,
            target: p.target,
            message:
              "Lance relido e confirmado; entrega e lucro não comprovados.",
          });
        });
        count++;
      } else if (found) {
        this.commit((s) => {
          const pending = s.pending[p.id];
          pending.lastCheckedAt = Date.now();
          pending.lastBid = found.bid;
        });
      }
    }
    return count;
  }
  recordOutcome(intent, outcome) {
    if (this.state.pending[intent.id]?.intentId !== intent.intentId)
      return false;
    this.commit((s) => {
      s.pending[intent.id].outcome = {
        ...outcome,
        intentId: intent.intentId,
        at: Date.now(),
      };
    });
    return true;
  }
  recordReconciliation(intent, evidence) {
    if (this.state.pending[intent.id]?.intentId !== intent.intentId)
      return false;
    if (
      evidence.intentId !== intent.intentId ||
      evidence.id !== intent.id ||
      evidence.href !== intent.href ||
      !Number.isFinite(evidence.checkedAt) ||
      evidence.checkedAt < intent.at
    )
      throw Error("Evidência não corresponde ao envio pendente.");
    const outcome = this.state.pending[intent.id].outcome;
    if (
      outcome?.intentId === intent.intentId &&
      outcome.kind === "rejected" &&
      outcome.rejected === true &&
      outcome.receipt?.completed === true &&
      outcome.receipt.statusCode >= 200 &&
      outcome.receipt.statusCode < 300
    ) {
      this.reject(intent, outcome.message, outcome.receipt);
      return true;
    }
    if (
      outcome?.intentId === intent.intentId &&
      outcome.kind === "not-sent" &&
      outcome.notDispatched === true
    ) {
      this.abortUnsent(intent, outcome.message, outcome.editorState);
      return true;
    }
    const current = require("decimal.js")(evidence.current);
    if (evidence.exact !== false && current.eq(intent.target)) {
      this.reconcile([{ id: intent.id, bid: evidence.current }]);
      return true;
    }
    this.commit((s) => {
      const p = s.pending[intent.id];
      p.status = "checking";
      p.reconciliation = {
        ...evidence,
        status: "observed",
        nextAt: Date.now() + 60000,
        message: p.outcome
          ? "Lance ainda não confirmou; nova conferência automática agendada."
          : "O lance está diferente do solicitado. A resposta desse envio antigo não foi registrada.",
      };
      this.append(s, "reconciliation", {
        id: intent.id,
        intentId: intent.intentId,
        current: evidence.current,
        target: intent.target,
        message: p.reconciliation.message,
      });
    });
    return false;
  }
  reconciliationFailed(intent, message) {
    if (this.state.pending[intent.id]?.intentId !== intent.intentId) return;
    this.commit((s) => {
      const p = s.pending[intent.id];
      p.status = "checking";
      p.reconciliation = {
        status: "error",
        checkedAt: Date.now(),
        nextAt: Date.now() + 60000,
        message: String(message).slice(0, 500),
      };
      this.append(s, "reconciliation-error", {
        id: intent.id,
        intentId: intent.intentId,
        message: p.reconciliation.message,
      });
    });
  }
  abortUnsent(intent, message, editorState) {
    if (this.state.pending[intent.id]?.intentId !== intent.intentId)
      throw Error("Intenção mudou; preserve a pendência para conferência.");
    this.commit((s) => {
      delete s.pending[intent.id];
      this.append(s, "not-sent", {
        id: intent.id,
        target: intent.target,
        message,
        ...(editorState ? { editorState } : {}),
      });
    });
  }
  reject(intent, message, receipt) {
    if (this.state.pending[intent.id]?.intentId !== intent.intentId)
      throw Error("Intenção mudou; preserve a pendência.");
    const waitMatch = String(message).match(/Tente de novo em\s+(\d+)\s*s\b/i);
    const platformSeconds = waitMatch ? Number(waitMatch[1]) : null;
    const waitMs =
      platformSeconds !== null && Number.isSafeInteger(platformSeconds)
        ? Math.max(120000, platformSeconds * 1000 + 2000)
        : 120000;
    this.commit((s) => {
      delete s.pending[intent.id];
      s.memory[intent.id] = {
        changedAt: Date.now(),
        retryAfter: Date.now() + waitMs,
        retryReason: waitMatch ? "platform-cooldown" : "rejected",
      };
      this.append(s, "rejected", {
        id: intent.id,
        target: intent.target,
        message,
        receipt,
      });
    });
  }

  creationIntent(plan, beforeIds, key) {
    const account = plan.account;
    if (
      plan.action !== "create" ||
      !Array.isArray(beforeIds) ||
      beforeIds.length > 500 ||
      this.state.creations?.pending?.[account]
    )
      throw Error("Criação já pendente ou intenção inválida.");
    const intent = {
      account,
      amount: plan.amount,
      speedPH: plan.speedPH,
      bid: plan.bid,
      destination: plan.destination,
      beforeIds: [...beforeIds],
      key,
      intentId: key,
      at: Date.now(),
      phase: "prepared",
    };
    this.commit((s) => {
      s.creations ||= { pending: {}, retryAfter: {}, lastCreated: {} };
      s.creations.pending[account] = intent;
      this.append(s, "creation-intent", {
        message: "Nova ordem preparada.",
        intentId: key,
      });
    });
    return intent;
  }
  creationOutcome(intent, phase, receipt = null) {
    this.commit((s) => {
      const p = s.creations?.pending?.[intent.account];
      if (p?.key !== intent.key) throw Error("Intenção de criação mudou.");
      p.phase = phase;
      p.receipt = receipt;
    });
  }
  abortCreation(intent, message) {
    this.commit((s) => {
      if (s.creations?.pending?.[intent.account]?.key !== intent.key)
        throw Error("Intenção de criação mudou.");
      delete s.creations.pending[intent.account];
      s.creations.retryAfter[intent.account] = Date.now() + 120000;
      this.append(s, "creation-not-sent", { intentId: intent.key, message });
    });
  }
  confirmCreation(intent, e) {
    const D = require("decimal.js");
    if (
      e.account !== intent.account ||
      intent.beforeIds.includes(e.id) ||
      !/^HS-[A-Z0-9]+$/.test(e.id) ||
      e.href !== "https://hashsell.com/orders/" + e.id ||
      e.type !== "STANDARD" ||
      e.poolId !== intent.destination ||
      !Number.isFinite(e.checkedAt) ||
      e.checkedAt < intent.at ||
      !Number.isFinite(Date.parse(e.createdAt)) ||
      Date.parse(e.createdAt) < intent.at - 5000 ||
      Date.parse(e.createdAt) > e.checkedAt + 5000 ||
      !new D(e.amountUsd).eq(intent.amount) ||
      !new D(e.limitHash).eq(new D(intent.speedPH).mul(1000000000)) ||
      !new D(e.priceScaled).eq(new D(intent.bid).mul(100000))
    )
      throw Error("Evidência da criação não confere.");
    this.commit((s) => {
      if (s.creations?.pending?.[intent.account]?.key !== intent.key)
        throw Error("Intenção de criação mudou.");
      delete s.creations.pending[intent.account];
      s.creations.lastCreated[intent.account] = Date.now();
      this.append(s, "creation-confirmed", {
        id: e.id,
        intentId: intent.key,
        target: intent.bid,
        amount: intent.amount,
        message: "Nova ordem criada e conferida.",
      });
    });
  }

  resolveManually(id) {
    if (!this.state.pending[id]) throw Error("Pendência inexistente.");
    this.commit((s) => {
      delete s.pending[id];
      s.memory[id] = { changedAt: Date.now() };
      this.append(s, "manual-review", {
        id,
        message:
          "Operador conferiu a ordem e encerrou a pendência. Nenhum reenvio realizado.",
      });
    });
  }
}
module.exports = { Store };
