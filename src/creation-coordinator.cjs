const { randomUUID } = require("node:crypto");
const D = require("decimal.js");
const { planCreation } = require("./order-creation.cjs");
const { fresh } = require("./engine.cjs");
class CreationCoordinator {
  constructor(monitor) {
    this.monitor = monitor;
    this.status = "Criação automática desligada.";
    this.wallet = null;
    this.activity = null;
    this.lastAttemptAt = null;
    this.lastFailure = null;
    this.activityAccount = null;
  }
  progress(stage, status) {
    this.activity = stage;
    this.status = status;
    this.monitor.publish();
  }
  snapshot() {
    const account = this.monitor.config.creation.account;
    const sameAccount = this.activityAccount === account;
    const active =
      this.monitor.running &&
      this.monitor.mode === "live" &&
      this.monitor.config.creation.enabled;
    return {
      stage: sameAccount ? this.activity : null,
      lastAttemptAt: sameAccount ? this.lastAttemptAt : null,
      lastFailure: sameAccount ? this.lastFailure : null,
      nextCheckAt:
        active && !this.activity
          ? Math.max(
              this.monitor.nextCycleAt || 0,
              this.monitor.store.state.creations?.retryAfter?.[account] || 0,
              (this.monitor.store.state.creations?.lastCreated?.[account] ||
                0) + 60000,
            )
          : null,
      status: !this.monitor.config.creation.enabled
        ? "Criação automática desligada."
        : !this.monitor.running
          ? "Inicie o monitoramento para criar novas ordens."
          : this.monitor.mode !== "live"
            ? "Ligue os ajustes automáticos para criar novas ordens."
            : this.monitor.result?.blocked
              ? "Aguardando dados válidos das plataformas. Nova avaliação automática."
              : this.status === "Criação automática desligada."
                ? "Criação ativada. Aguardando a próxima avaliação."
                : this.status,
      enabled: !!this.monitor.config.creation.enabled,
      pending:
        !!this.monitor.store.state.creations?.pending?.[
          this.monitor.config.creation.account
        ],
    };
  }
  adjustmentPending(orders) {
    const result = { ...this.monitor.store.state.pending };
    const p = this.monitor.store.state.creations?.pending?.[orders?.account];
    if (p)
      for (const o of orders.items)
        if (!p.beforeIds.includes(o.id)) result[o.id] = { status: "checking" };
    return result;
  }
  async tick(config, epoch, didAdjust) {
    const m = this.monitor,
      a = m.adapter.creation;
    if (!a || m.demo) return;
    if (m.epoch !== epoch) return;
    const current = () =>
      m.epoch === epoch &&
      m.running &&
      m.mode === "live" &&
      m.config.creation.enabled &&
      m.config.creation.account === config.creation.account;
    const orders = m.snapshots.orders;
    if (!fresh(orders, Date.now(), config)) {
      this.status =
        "Aguardando leitura atualizada das ordens. Nova avaliação automática.";
      return;
    }
    const p = m.store.state.creations?.pending?.[orders.account];
    if (p) {
      this.status = "Conferindo a nova ordem automaticamente.";
      if (p.phase === "prepared") {
        m.store.abortCreation(p, "Preparação interrompida antes do envio.");
        return;
      }
      try {
        const evidence = await a.reconcile(p, orders);
        if (m.epoch !== epoch) return;
        if (evidence) {
          m.store.confirmCreation(p, evidence);
          this.status = "Nova ordem criada e conferida.";
        }
      } catch (e) {
        m.store.log("creation-check", { message: e.message });
      }
      return;
    }
    if (!config.creation.enabled) {
      this.status = "Criação automática desligada.";
      return;
    }
    if (!current()) {
      this.status = "Ligue os ajustes automáticos para criar novas ordens.";
      return;
    }
    if (m.result.blocked) {
      this.status = "Aguardando os dados das plataformas.";
      return;
    }
    const account = config.creation.account;
    if (
      Date.now() < (m.store.state.creations?.retryAfter?.[account] || 0) ||
      Date.now() <
        (m.store.state.creations?.lastCreated?.[account] || 0) + 60000
    ) {
      this.status =
        this.lastFailure || "Aguardando a próxima verificação de saldo.";
      return;
    }
    let intent;
    try {
      this.activityAccount = account;
      this.lastAttemptAt = Date.now();
      this.lastFailure = null;
      this.progress("wallet", "Consultando o saldo disponível na Hashsell…");
      this.wallet = await a.wallet();
      if (!current()) return;
      const plan = planCreation({
        policy: config.creation,
        wallet: this.wallet,
        ...m.snapshots,
        config,
      });
      this.status = plan.reason || "Preparando a nova ordem.";
      if (plan.action !== "create") return;
      if (didAdjust) {
        this.status =
          "Saldo e margem permitem criar. Aguardando o próximo ciclo após o ajuste em andamento.";
        return;
      }
      // Release the previous adjustment's form/guard before opening the creation form.
      m.adapter.cancel?.();
      this.status = `Nova ordem: ${plan.speedPH} PH/s, duração estimada de ${new D(plan.estimatedHours).toDecimalPlaces(1)} h.`;
      m.publish();
      let key = randomUUID();
      this.progress("form", "Abrindo e conferindo o formulário da nova ordem…");
      const prepared = await a.prepare(plan, config, key, current);
      key = prepared.key || key;
      if (!current()) return;
      this.progress("validation", "Conferindo saldo e preço antes de criar…");
      const [collected, wallet] = await Promise.all([
        m.readAll(config),
        a.wallet(),
      ]);
      if (!current()) return;
      if (Object.keys(collected.errors).length)
        throw Error("Aguardando leituras atualizadas antes de criar.");
      const latest = planCreation({
        policy: config.creation,
        wallet,
        ...collected.snapshots,
        config,
      });
      if (
        latest.action !== "create" ||
        ["account", "amount", "bid", "speedPH", "destination"].some(
          (k) => latest[k] !== plan[k],
        )
      ) {
        this.status = "Dados mudaram. A nova ordem será reavaliada.";
        return;
      }
      if (new D(prepared.debit).gt(wallet.available))
        throw Error("Saldo insuficiente incluindo a taxa de criação.");
      intent = m.store.creationIntent(
        latest,
        collected.snapshots.orders.items.map((o) => o.id),
        key,
      );
      m.store.creationOutcome(intent, "dispatching");
      const stillCurrent = () =>
        current() && m.store.state.creations?.pending?.[account]?.key === key;
      this.progress("sending", "Enviando a nova ordem para a Hashsell…");
      const receipt = await a.submit(prepared, latest, config, stillCurrent);
      m.store.creationOutcome(intent, "submitted", receipt);
      this.status = "Conferindo a nova ordem automaticamente.";
    } catch (e) {
      if (intent) {
        if (e.notDispatched === true) {
          m.store.abortCreation(intent, e.message);
          this.status = "A criação será tentada novamente automaticamente.";
        } else {
          m.store.creationOutcome(intent, "uncertain", e.receipt || null);
          this.status = "Conferindo a nova ordem automaticamente.";
        }
      } else {
        this.status = /faça login/i.test(e.message)
          ? "Faça login na Hashsell para criar novas ordens."
          : /^O preço mínimo da Hashsell mudou\./.test(e.message)
            ? "O preço mínimo da Hashsell mudou. A nova ordem será recalculada automaticamente."
            : /tempo.*esgotado/i.test(e.message)
              ? this.activity === "wallet"
                ? "A leitura do saldo demorou demais. Nova tentativa automática."
                : "A leitura da nova ordem demorou demais. Nova tentativa automática."
              : "Não foi possível concluir a leitura na Hashsell. Nova tentativa automática.";
        this.lastFailure = this.status;
        m.store.commit((s) => {
          s.creations ||= { pending: {}, retryAfter: {}, lastCreated: {} };
          s.creations.retryAfter[account] = Date.now() + 120000;
        });
        m.store.log("creation-error", {
          message: e.message,
          stage: this.activity,
          diagnostics: e.diagnostics || null,
        });
      }
    } finally {
      this.activity = null;
      a.guard?.cancel();
      m.publish();
    }
  }
}
module.exports = { CreationCoordinator };
