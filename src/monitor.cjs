const { CreationCoordinator } = require("./creation-coordinator.cjs");
const { EventEmitter } = require("node:events");
const { decide, fresh } = require("./engine.cjs");
const { assertLiveReady } = require("./config.cjs");
const { authorizeBid } = require("./bid-safety.cjs");
class Monitor extends EventEmitter {
  constructor(store, adapter) {
    super();
    this.store = store;
    this.adapter = adapter;
    this.running = false;
    this.mode = "monitoring";
    this.demo = false;
    this.busy = false;
    this.nextCycleAt = null;
    this.operation = null;
    this.epoch = 0;
    this.snapshots = {};
    this.errors = {};
    this.memory = structuredClone(store.state.memory);
    this.result = {
      decisions: [],
      blocked: "Inicie o monitoramento para consultar suas contas.",
    };
    this.lastSignature = "";
    this.creation = new CreationCoordinator(this);
  }
  get config() {
    return this.store.state.config;
  }
  snapshot() {
    let automationReady = this.adapter.liveReady !== false;
    let automationError = automationReady
      ? null
      : "Executor indisponível neste ambiente.";
    try {
      assertLiveReady(this.config);
    } catch (error) {
      automationReady = false;
      automationError = error.message;
    }
    return {
      creation: this.creation.snapshot(),
      automationReady,
      automationError,
      running: this.running,
      busy: this.busy,
      nextCycleAt: this.running ? this.nextCycleAt : null,
      operation: this.running ? this.operation : null,
      retryAfter: Object.fromEntries(
        Object.entries(this.memory).map(([id, v]) => [id, v.retryAfter || 0]),
      ),
      mode: this.mode,
      demo: this.demo,
      config: this.config,
      sources: this.snapshots,
      errors: this.errors,
      result: this.result,
      pending: this.store.state.pending,
      history: this.store.state.history
        .slice(-200)
        .reverse()
        .map((item) => {
          const publicItem = { ...item };
          delete publicItem.diagnostics;
          return publicItem;
        }),
      now: Date.now(),
    };
  }
  progress(id, phase) {
    this.operation = { id, phase };
    this.publish();
  }
  scheduleNextCycle() {
    this.operation = null;
    this.nextCycleAt = this.running
      ? Date.now() + this.config.pollSeconds * 1000
      : null;
    if (this.running)
      this.timer = setTimeout(
        () => void this.tick(),
        this.config.pollSeconds * 1000,
      );
    this.publish();
  }
  publish() {
    this.emit("state", this.snapshot());
  }
  stop() {
    this.running = false;
    this.mode = "monitoring";
    this.epoch++;
    this.adapter.cancel?.();
    clearTimeout(this.timer);
    this.nextCycleAt = null;
    this.publish();
  }
  async start() {
    if (!this.running) {
      this.running = true;
      this.epoch++;
    }
    return this.tick();
  }
  async startAutomatic() {
    if (this.demo || this.adapter.liveReady === false)
      throw Error("Inicialização automática indisponível neste ambiente.");
    assertLiveReady(this.config);
    this.mode = "live";
    this.epoch++;
    this.store.log("mode", {
      message:
        "Monitoramento e ajustes iniciados automaticamente conforme preferência do operador. Envios exigem leituras válidas e respeitam teto e pendências.",
    });
    return this.start();
  }
  setDemo(enabled) {
    this.stop();
    this.demo = enabled;
    this.snapshots = {};
    this.memory = {};
    this.result = {
      decisions: [],
      blocked: "Fontes alteradas; atualize a leitura.",
    };
    this.publish();
  }
  live() {
    if (this.demo) throw Error("Demonstração nunca altera ordens reais.");
    if (this.adapter.liveReady === false)
      throw Error("Executor indisponível neste ambiente.");
    assertLiveReady(this.config);
    if (
      !this.running ||
      this.busy ||
      this.result.blocked ||
      !["rental", "market", "orders"].every((k) =>
        fresh(this.snapshots[k], Date.now(), this.config),
      )
    )
      throw Error("Faça uma leitura válida antes de ativar.");
    this.mode = "live";
    this.epoch++;
    this.store.log("mode", {
      message:
        "Operador autorizou ajustes automáticos em todas as ordens ativas, incluindo novas ordens detectadas.",
    });
    this.publish();
  }
  disableAdjustments() {
    this.mode = "monitoring";
    this.epoch++;
    this.adapter.cancel?.();
    this.publish();
  }
  updateConfig(c) {
    this.store.saveConfig(c);
    this.epoch++;
    this.adapter.cancel?.();
    this.memory = {};
    this.snapshots = {};
    this.result = {
      decisions: [],
      blocked: "Configuração mudou; aguardando nova leitura.",
    };
    this.publish();
  }
  async checkPending(epoch, config) {
    if (!this.adapter.checkPending) return;
    const pending = Object.values(this.store.state.pending).filter(
      (p) => !p.reconciliation?.nextAt || p.reconciliation.nextAt <= Date.now(),
    );
    pending.sort(
      (a, b) =>
        (a.reconciliation?.checkedAt || 0) - (b.reconciliation?.checkedAt || 0),
    );
    for (const p of pending.slice(0, 1)) {
      try {
        const evidence = await this.adapter.checkPending(
          structuredClone(p),
          config,
        );
        if (epoch !== this.epoch) return;
        this.store.recordReconciliation(p, evidence);
      } catch (e) {
        if (epoch !== this.epoch) return;
        this.store.reconciliationFailed(p, e.message);
      }
    }
  }
  async recheckPending(id) {
    if (!this.store.state.pending[id]) return;
    this.store.commit((s) => {
      if (s.pending[id]?.reconciliation)
        s.pending[id].reconciliation.nextAt = 0;
    });
    if (!this.busy) await this.tick();
  }

  async creationOptions() {
    if (this.busy || this.maintenance)
      throw Error("Aguarde a consulta em andamento e tente novamente.");
    if (!this.adapter.creation)
      throw Error("Criação indisponível neste ambiente.");
    clearTimeout(this.timer);
    this.nextCycleAt = null;
    this.busy = true;
    this.publish();
    try {
      return await this.adapter.creation.options({ poolsOnly: true });
    } catch (error) {
      this.store.log("error", {
        source: "creation-options",
        message: "Não foi possível carregar os pools da Hashsell.",
        diagnostics: error.diagnostics || { stage: "options" },
      });
      throw Error(
        error.message || "Não foi possível carregar os pools da Hashsell.",
      );
    } finally {
      this.busy = false;
      this.adapter.creation.guard.cancel();
      this.scheduleNextCycle();
    }
  }

  async readAll(c) {
    const results = await Promise.allSettled(
      ["rental", "market", "orders"].map((k) => this.adapter.read(k, c)),
    );
    const snapshots = {},
      errors = {};
    results.forEach((r, i) => {
      const key = ["rental", "market", "orders"][i];
      if (r.status === "fulfilled") snapshots[key] = r.value;
      else errors[key] = r.reason.message;
    });
    return { snapshots, errors };
  }
  demoSources() {
    const at = Date.now();
    return {
      rental: { rate: "43", at },
      market: { cut: "39.11", at },
      orders: {
        at,
        items: [
          {
            id: "DEMO-55",
            bid: "39.2",
            speed: "55 PH/s",
            balance: "664.03",
            active: true,
            status: "Entregando",
            href: "",
          },
          {
            id: "DEMO-50",
            bid: "39.05",
            speed: "50 PH/s",
            balance: "671.38",
            active: true,
            status: "Abaixo do corte",
            href: "",
          },
        ],
      },
    };
  }
  async tick() {
    if (this.busy || this.maintenance) return;
    clearTimeout(this.timer);
    this.nextCycleAt = null;
    this.busy = true;
    const epoch = this.epoch;
    const config = structuredClone(this.config);
    let didAdjust = false;
    this.publish();
    try {
      if (!this.demo) {
        await this.checkPending(epoch, config);
        if (epoch !== this.epoch) return;
      }
      const collected = this.demo
        ? { snapshots: this.demoSources(), errors: {} }
        : await this.readAll(config);
      if (epoch !== this.epoch) return;
      this.snapshots = collected.snapshots;
      this.errors = collected.errors;
      if (this.snapshots.orders && !this.demo) {
        this.store.reconcile(this.snapshots.orders.items);
        for (const [id, persisted] of Object.entries(this.store.state.memory)) {
          if (this.memory[id]?.changedAt !== persisted.changedAt)
            this.memory[id] = { ...persisted };
        }
      }
      for (const [id, persisted] of Object.entries(this.store.state.memory))
        if (this.memory[id]?.changedAt !== persisted.changedAt)
          this.memory[id] = { ...persisted };
      const beforeMemory = structuredClone(this.memory);
      this.result = decide({
        ...this.snapshots,
        config,
        memory: this.memory,
        pending: this.demo
          ? {}
          : this.creation.adjustmentPending(this.snapshots.orders),
      });
      if (Object.keys(this.errors).length)
        this.result.blocked =
          "Atualizando os dados das plataformas. Nova tentativa automática.";
      for (const d of this.result.decisions)
        this.memory[d.id] = {
          ...this.memory[d.id],
          candidate: d.candidate,
          stable: d.stable,
        };
      const signature = JSON.stringify({
        blocked: this.result.blocked,
        errors: this.errors,
        decisions: this.result.decisions.map((d) => [
          d.id,
          d.action,
          d.target,
          d.reason,
        ]),
      });
      if (signature !== this.lastSignature) {
        this.store.log(
          this.demo ? "demo" : this.mode === "live" ? "decision" : "analysis",
          {
            message: this.result.blocked || "Ciclo avaliado.",
            errors: this.errors,
            decisions: this.result.decisions,
          },
        );
        this.lastSignature = signature;
      }
      if (this.mode === "live" && !this.demo && !this.result.blocked) {
        // Adjustments have priority; creation may follow only after confirmation.
        // Uncertain dispatches never release the creation stage.
        const candidate =
          this.result.decisions.find(
            (d) =>
              d.action === "decrease" && Number(d.current) > Number(d.ceiling),
          ) ||
          this.result.decisions.find((d) =>
            ["increase", "decrease"].includes(d.action),
          );
        if (candidate) {
          didAdjust = true;
          this.progress(candidate.id, "preparing");
          const prepared = await this.adapter.prepare(candidate, config);
          if (epoch !== this.epoch || this.mode !== "live" || !this.running)
            return;
          const isCurrent = () =>
            epoch === this.epoch && this.mode === "live" && this.running;
          if (this.adapter.stage) {
            // Only the page's preview can leave during staging; saving is still denied.
            const previewAuthority = authorizeBid(
              candidate,
              config,
              this.snapshots,
            );
            await this.adapter.stage(prepared, previewAuthority, isCurrent);
            if (!isCurrent()) return;
          }
          // Refresh both prices and order state after navigation, before committing an intent.
          const latest = await this.readAll(config);
          if (epoch !== this.epoch || this.mode !== "live" || !this.running)
            return;
          if (Object.keys(latest.errors).length)
            throw Error("Pré-envio sem leituras válidas.");
          const reevaluated = decide({
            ...latest.snapshots,
            config,
            memory: beforeMemory,
            pending: this.creation.adjustmentPending(latest.snapshots.orders),
          });
          const checked = reevaluated.decisions.find(
            (d) => d.id === candidate.id,
          );
          if (
            reevaluated.blocked ||
            !checked ||
            checked.current !== candidate.current ||
            checked.target !== candidate.target ||
            checked.action !== candidate.action
          )
            throw Error(
              "Mercado ou ordem mudou: ajuste descartado antes do envio.",
            );
          const authority = authorizeBid(checked, config, latest.snapshots);
          const intent = this.store.intent(candidate);
          try {
            this.progress(candidate.id, "sending");
            const receipt = await this.adapter.submit(
              prepared,
              config,
              authority,
              isCurrent,
            );
            this.store.recordOutcome(intent, { kind: "submitted", receipt });
            this.store.log("submitted", {
              id: candidate.id,
              intentId: intent.intentId,
              target: candidate.target,
              message: "Enviado; aguardando releitura.",
              ...(receipt ? { receipt } : {}),
            });
          } catch (e) {
            this.store.recordOutcome(intent, {
              kind:
                e.rejected === true
                  ? "rejected"
                  : e.notDispatched === true
                    ? "not-sent"
                    : "uncertain",
              rejected: e.rejected === true,
              notDispatched: e.notDispatched === true,
              receipt: e.receipt || null,
              editorState: e.editorState || null,
              message: e.message,
            });
            if (
              e.rejected === true &&
              e.receipt?.completed === true &&
              e.receipt.statusCode >= 200 &&
              e.receipt.statusCode < 300
            ) {
              this.store.reject(intent, e.message, e.receipt);
              // A definitive rejection made no change; it must not starve creation.
              didAdjust = false;
              this.memory[candidate.id] = {
                ...this.store.state.memory[candidate.id],
              };
            } else if (e.notDispatched === true) {
              this.store.abortUnsent(intent, e.message, e.editorState);
              didAdjust = false;
              // Nothing left the process: defer this order without disabling others.
              const retryAfter = Date.now() + 120000;
              this.store.commit((state) => {
                state.memory[candidate.id] = {
                  ...state.memory[candidate.id],
                  retryAfter,
                };
              });
              this.memory[candidate.id] = {
                ...this.memory[candidate.id],
                retryAfter,
              };
            } else {
              this.store.log("uncertain", {
                intentId: intent.intentId,
                id: candidate.id,
                message: e.message,
                ...(e.receipt ? { receipt: e.receipt } : {}),
                ...(e.editorState ? { editorState: e.editorState } : {}),
              });
            }
          }
          if (this.store.state.pending[candidate.id]) {
            this.progress(candidate.id, "checking");
            try {
              const orders = await this.adapter.read("orders", config);
              if (fresh(orders, Date.now(), config)) {
                this.snapshots.orders = orders;
                this.store.reconcile(orders.items);
                if (!this.store.state.pending[candidate.id]) didAdjust = false;
              }
            } catch (e) {
              this.store.log("uncertain", {
                id: candidate.id,
                message: `Não foi possível conferir o lance: ${e.message}`,
              });
            }
          }
          // Pending stays durable until a subsequent, independent orders read confirms it.
        }
      }
      this.operation = null;
      this.publish();
      await this.creation.tick(config, epoch, didAdjust);
    } catch (e) {
      this.result = { ...this.result, blocked: e.message };
      this.store.log("error", { message: e.message });
    } finally {
      this.adapter.cancel?.();
      this.busy = false;
      this.scheduleNextCycle();
    }
  }
}
module.exports = { Monitor };
