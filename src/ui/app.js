const $ = (s) => document.querySelector(s);
const api = window.hashrate;
let creationAccount = "";
const settingsDraftKey = "hashrate-settings-draft-v1";
let draftRestored = false;
function settingsFeedback(text) {
  const node = $("#settings-save-status");
  if (node) node.textContent = text;
}
function keepSettingsDraft() {
  dirty = true;
  settingsFeedback(
    "Alterações não salvas. Clique em Salvar configurações para aplicar.",
  );
  const fields = [...$("#settings-form").elements]
    .filter((e) => e.name)
    .map((e) => ({
      name: e.name,
      value: e.value,
      checked: e.checked,
      type: e.type,
    }));
  try {
    localStorage.setItem(
      settingsDraftKey,
      JSON.stringify({ account: creationAccount, fields }),
    );
  } catch {
    settingsFeedback("Alterações não salvas. Salve antes de fechar o app.");
  }
}
function restoreSettingsDraft() {
  if (draftRestored) return;
  draftRestored = true;
  try {
    const draft = JSON.parse(localStorage.getItem(settingsDraftKey));
    if (!draft || draft.account !== creationAccount) return;
    for (const f of draft.fields || []) {
      const e = [...$("#settings-form").elements].find(
        (e) => e.name === f.name,
      );
      if (!e) continue;
      if (e.type === "checkbox") e.checked = !!f.checked;
      else e.value = f.value;
    }
    dirty = true;
    syncCreationFunding();
    settingsFeedback(
      "Edição anterior recuperada. Salve para aplicar ou descarte para usar os valores salvos.",
    );
  } catch {
    settingsFeedback(
      "Não foi possível recuperar a edição anterior. Confira os valores antes de salvar.",
    );
  }
}
let state,
  dirty = false,
  currentTab = "dashboard";
const money = (value, digits = 4) =>
  value == null
    ? "—"
    : Number(value).toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: digits,
      });
const time = (at) => new Date(at).toLocaleString("pt-BR");
const labels = {
  increase: "Aumentar",
  decrease: "Reduzir",
  hold: "Manter",
  alert: "Atenção",
  simulation: "Análise de lances",
  analysis: "Análise de lances",
  decision: "Decisão",
  demo: "Teste antigo · dados fictícios",
  intent: "Intenção registrada",
  submitted: "Enviado",
  "not-sent": "Não enviado",
  uncertain: "Conferência pendente",
  confirmed: "Lance confirmado",
  rejected: "Recusado pela Hashsell",
  "review-required": "Conferência necessária",
  error: "Falha",
  config: "Configuração",
  mode: "Modo alterado",
  "manual-review": "Conferência manual",
  "creation-confirmed": "Nova ordem criada",
  "creation-intent": "Preparando nova ordem",
  "creation-not-sent": "Criação adiada",
  "creation-error": "Criação adiada",
  "creation-check": "Conferindo nova ordem",
  system: "Sistema",
};
function el(tag, text, className) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (className) n.className = className;
  return n;
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").hidden = true), 6500);
}
async function call(action, payload) {
  try {
    return await api.invoke(action, payload);
  } catch (e) {
    toast(
      e.message.replace(/^Error invoking remote method '[^']+': Error: /, ""),
    );
    return null;
  }
}
async function tab(name) {
  currentTab = name;
  for (const node of document.querySelectorAll(".page,.site-page"))
    node.hidden = node.id !== `page-${name}`;
  window.scrollTo(0, 0);
  for (const node of document.querySelectorAll("[data-tab]"))
    node.classList.toggle("active", node.dataset.tab === name);
  $("#page-title").textContent = {
    dashboard: "Visão geral",
    hashsell: "Hashsell",
    rental: "RentalHash",
    history: "Histórico",
    reports: "Relatórios",
    withdrawals: "Saques",
    settings: "Configurações",
  }[name];
  await call("tab", name);
}
function syncCreationFunding() {
  const amount = $('[name="creation-amount"]');
  const fixed = $('[name="creation-funding"]').value === "fixed";
  amount.disabled = !fixed;
  amount.closest("label").hidden = !fixed;
  const duration = $('[name="creation-sizing"]').value === "duration";
  for (const [key, show] of [
    ["hours", duration],
    ["speedPH", !duration],
  ]) {
    const field = $(`[name="creation-${key}"]`);
    field.disabled = !show;
    field.closest("label").hidden = !show;
  }
}
function fillSettings(config) {
  const creation = config.creation;
  creationAccount = creation.account;
  const poolSelect = $('[name="creation-destination"]');
  if (
    creation.destination &&
    ![...poolSelect.options].some((o) => o.value === creation.destination)
  ) {
    const option = el("option", "Pool selecionado");
    option.value = creation.destination;
    poolSelect.append(option);
  }
  for (const key of ["enabled", "allowActive"])
    $(`[name="creation-${key}"]`).checked = creation[key];
  for (const key of [
    "funding",
    "sizing",
    "hours",
    "amount",
    "minimumBalance",
    "speedPH",
    "destination",
  ])
    $(`[name="creation-${key}"]`).value =
      creation[key] || ({ speedPH: "50", minimumBalance: "5" }[key] ?? "");
  for (const key of ["margin", "fee", "recognition"])
    $(`[name="${key}"]`).value = Number(config[key]) * 100;
  for (const key of [
    "otherCost",
    "tick",
    "buffer",
    "pollSeconds",
    "maxAgeSeconds",
    "cooldownSeconds",
    "decreaseCycles",
  ])
    $(`[name="${key}"]`).value = config[key];
  syncCreationFunding();
}
function render(s) {
  state = s;
  const creationStatus = s.creation?.status || "Criação automática desligada.";
  const creationTime = [];
  if (s.creation?.lastAttemptAt)
    creationTime.push(
      "Última tentativa às " +
        new Date(s.creation.lastAttemptAt).toLocaleTimeString("pt-BR"),
    );
  if (
    s.creation?.enabled &&
    s.running &&
    s.mode === "live" &&
    !s.creation?.stage &&
    !s.creation?.pending
  ) {
    const seconds = Math.max(
      0,
      Math.ceil(((s.creation.nextCheckAt || 0) - Date.now()) / 1000),
    );
    creationTime.push(
      seconds > 0
        ? `Próxima verificação em ${seconds}s`
        : "Aguardando a próxima avaliação do monitor",
    );
  }
  $("#creation-status").textContent = [creationStatus, ...creationTime].join(
    " · ",
  );
  $("#creation-tracker-status").textContent = creationStatus;
  const creating = s.creation?.stage || s.creation?.pending;
  const creationActive = s.creation?.enabled && s.running && s.mode === "live";
  const badge = $("#creation-tracker-badge");
  badge.textContent = !s.creation?.enabled
    ? "Desligadas"
    : !creationActive
      ? "Pausadas"
      : creating
        ? "Em andamento"
        : "Acompanhando";
  badge.dataset.active = String(!!creationActive);
  const remaining = Math.max(
    0,
    Math.ceil(((s.creation?.nextCheckAt || 0) - Date.now()) / 1000),
  );
  $("#creation-tracker-time").textContent = !creationActive
    ? "—"
    : creating
      ? "Em andamento"
      : remaining
        ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
        : "Próximo ciclo";
  $("#creation-tracker-last").textContent = s.creation?.lastAttemptAt
    ? "Última tentativa às " +
      new Date(s.creation.lastAttemptAt).toLocaleTimeString("pt-BR")
    : "";
  $("#engine-label").textContent = s.running
    ? s.busy
      ? "Consultando fontes…"
      : "Monitor em execução"
    : "Motor pausado";
  $("#engine-dot").classList.toggle("running", s.running);
  $("#mode-label").textContent = s.running ? "MONITORANDO" : "PAUSADO";
  $("#mode-label").classList.toggle("live", s.running);
  $("#toggle-running").textContent = s.running
    ? "Pausar monitoramento"
    : "Iniciar monitoramento";
  $("#refresh").disabled = s.busy;
  $("#rental-value").textContent = money(s.sources.rental?.rate);
  $("#cut-value").textContent = money(s.sources.market?.cut);
  $("#ceiling-value").textContent = money(s.result.ceiling);
  $("#margin-value").replaceChildren(
    document.createTextNode(money(Number(s.config.margin) * 100, 2)),
    el("span", "%"),
  );
  const age = (source) =>
    source
      ? `${Math.max(0, Math.floor((Date.now() - source.at) / 1000))}s atrás`
      : "Sem leitura";
  $("#rental-age").textContent = age(s.sources.rental);
  $("#market-age").textContent = age(s.sources.market);
  const notice = window.monitorStatus(s);
  $("#notice").classList.toggle("warning", notice.warning);
  $("#notice").textContent = notice.text;
  const orders = s.sources.orders?.items || [];
  const orderState = window.ordersStatus(s);
  $("#order-count").textContent = orderState.known ? orders.length : "—";
  $("#empty-orders h3").textContent = orderState.title;
  $("#empty-orders p").textContent = orderState.text;
  $("#empty-orders").hidden = orders.length > 0;
  $("#orders-body").replaceChildren();
  for (const order of orders) {
    const d = s.result.decisions.find((x) => x.id === order.id);
    const row = el("tr");
    const id = el("td");
    id.append(
      el("strong", order.id),
      el("small", `${order.status} · ${order.speed}`),
    );
    const bid = el("td", money(order.bid));
    bid.append(el("small", `Saldo US$ ${money(order.balance, 2)}`));
    const proposed = el("td");
    proposed.append(el("span", d ? money(d.target) : "—", "price"));
    const revenue =
      Number(s.sources.rental?.rate) * Number(s.config.recognition);
    const margin =
      revenue > 0
        ? (1 -
            (Number(order.bid) * (1 + Number(s.config.fee)) +
              Number(s.config.otherCost)) /
              revenue) *
          100
        : null;
    const profit = el("td", margin == null ? "—" : `${money(margin, 2)}%`);
    const action = el("td");
    const execution = s.history.find(
      (h) =>
        h.id === order.id &&
        [
          "submitted",
          "confirmed",
          "uncertain",
          "not-sent",
          "rejected",
          "review-required",
        ].includes(h.type),
    );
    const awaiting = Boolean(s.pending[order.id]);
    action.append(
      el(
        "span",
        awaiting
          ? s.pending[order.id].status === "checking"
            ? "Conferindo ajuste"
            : "Aguardando confirmação"
          : d
            ? d.title ||
              {
                increase: "Aumentar para receber",
                decrease: "Reduzir o custo",
                hold: "Acompanhando",
                alert: "Atenção",
              }[d.action] ||
              "Acompanhando"
            : "Aguardando leitura",
        `action-pill ${d?.action || "hold"}`,
      ),
      el(
        "small",
        d?.reason || "Buscando os dados desta ordem. A avaliação é automática.",
      ),
    );
    const countdown = Math.max(
      0,
      Math.ceil(
        (Math.max(s.nextCycleAt || 0, s.retryAfter?.[order.id] || 0) -
          Date.now()) /
          1000,
      ),
    );
    const phase = s.operation?.id === order.id ? s.operation.phase : null;
    const progress = !s.running
      ? "Monitoramento pausado. Inicie para acompanhar esta ordem."
      : s.mode !== "live"
        ? "Ajustes desligados. Ligue para aplicar as propostas."
        : phase
          ? {
              preparing: "Preparando o ajuste…",
              sending: "Enviando o ajuste à Hashsell…",
              checking: "Conferindo se o ajuste foi aplicado…",
            }[phase]
          : (s.retryAfter?.[order.id] || 0) > Date.now()
            ? `Aguardando liberação para nova avaliação: ${Math.floor(countdown / 60)} min ${countdown % 60} s`
            : s.creation?.stage
              ? "Acompanhando a ordem. A criação de uma nova ordem está em andamento."
              : s.busy
                ? "Atualizando e avaliando as ordens…"
                : countdown > 0
                  ? "Próxima avaliação em " +
                    (countdown >= 60
                      ? Math.floor(countdown / 60) + " min "
                      : "") +
                    (countdown % 60) +
                    " s"
                  : "Aguardando a próxima avaliação…";
    action.append(el("small", progress, "order-progress"));
    const checked = s.pending[order.id]?.reconciliation;
    if (checked)
      action.append(
        el(
          "small",
          checked.status === "error"
            ? "Conferência temporariamente indisponível; nova tentativa automática."
            : "Última conferência: " + time(checked.checkedAt),
        ),
      );
    if (execution)
      action.append(
        el(
          "small",
          `Último ajuste: ${labels[execution.type]} · ${time(execution.at)}`,
        ),
      );
    row.append(id, bid, proposed, profit, action);
    $("#orders-body").append(row);
  }
  $("#managed-count").textContent = orderState.known
    ? `${orders.filter((o) => o.active).length} ordem(ns) ativa(s) acompanhada(s) automaticamente · Novas ordens entram a cada leitura`
    : orderState.title;
  $("#last-cycle").textContent = s.sources.orders
    ? `Leitura ${new Date(s.sources.orders.at).toLocaleTimeString("pt-BR")}`
    : "Aguardando leitura";
  $("#execution-title").textContent =
    s.mode === "live"
      ? "Ajustes automáticos ligados"
      : "Ajustes automáticos desligados";
  $("#execution-description").textContent =
    s.mode === "live"
      ? "O app acompanha os preços e ajusta os lances dentro da sua margem."
      : !s.automationReady
        ? s.automationError || "Não foi possível iniciar os ajustes."
        : "Ligue os ajustes para o app cuidar dos lances dentro da sua margem.";
  $("#enable-live").textContent =
    s.mode === "live"
      ? "Desligar ajustes automáticos"
      : "Ligar ajustes automáticos";
  $("#enable-live").disabled =
    s.mode !== "live" &&
    (s.busy || !s.automationReady || !s.running || Boolean(s.result.blocked));
  $("#source-status").replaceChildren();
  for (const [key, title] of [
    ["rental", "RentalHash · remuneração"],
    ["market", "Hashsell · mercado"],
    ["orders", "Hashsell · ordens"],
  ]) {
    const source = s.sources[key];
    const fresh =
      source && Date.now() - source.at <= s.config.maxAgeSeconds * 1000;
    const r = el("div", null, "source-row");
    const name = el("div", title);
    name.append(el("small", "Atualização automática"));
    r.append(
      name,
      el(
        "span",
        (s.errors[key]
          ? /login|sessão expirad/i.test(s.errors[key])
            ? "Entre novamente na plataforma"
            : "Não foi possível atualizar. Tentaremos novamente."
          : "") ||
          (fresh
            ? "● Leitura disponível"
            : source
              ? "Leitura desatualizada"
              : "Aguardando conexão"),
        `status ${s.errors[key] ? "bad" : fresh ? "good" : ""}`,
      ),
    );
    $("#source-status").append(r);
  }
  $("#recent-activity").replaceChildren();
  const last = s.history[0];
  if (last) {
    $("#recent-activity").append(
      el("time", time(last.at)),
      el("strong", labels[last.type] || last.type),
      el(
        "p",
        [
          "error",
          "rejected",
          "not-sent",
          "reconciliation-error",
          "creation-error",
        ].includes(last.type)
          ? "A última tentativa não foi concluída. O app continua acompanhando."
          : "Registro atualizado automaticamente.",
      ),
    );
  } else
    $("#recent-activity").textContent =
      "As decisões e confirmações aparecerão aqui.";
  $("#history-body").replaceChildren();
  for (const entry of s.history) {
    const row = el("tr");
    const details =
      entry.message ||
      [entry.previous, entry.target].filter(Boolean).join(" → ");
    const cell = el("td", details);
    if (entry.decisions?.length)
      cell.append(
        el(
          "small",
          entry.decisions
            .map(
              (d) =>
                `${d.id}: ${labels[d.action]} ${money(d.target)} (${d.reason})`,
            )
            .join(" | "),
        ),
      );
    row.append(
      el("td", time(entry.at)),
      el("td", labels[entry.type] || entry.type),
      el("td", entry.id || "—"),
      cell,
    );
    $("#history-body").append(row);
  }
  if (!dirty) fillSettings(s.config);
  restoreSettingsDraft();
}
document
  .querySelectorAll("[data-tab]")
  .forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
document
  .querySelectorAll("[data-reload]")
  .forEach((b) => (b.onclick = () => call("reload", b.dataset.reload)));
document
  .querySelectorAll("[data-inspect]")
  .forEach((b) => (b.onclick = () => call("inspect", b.dataset.inspect)));
$("#toggle-running").onclick = () => call(state?.running ? "stop" : "start");
$("#refresh").onclick = () => call("refresh");
$("#enable-live").onclick = () =>
  call(state?.mode === "live" ? "disable-adjustments" : "live");
$("#configure-strategy").onclick = () => tab("settings");
$("#view-history").onclick = () => tab("history");
$("#export").onclick = () => call("export");
$("#app-quit").onclick = () => call("app-quit");
$("#settings-form").addEventListener("input", keepSettingsDraft);
$("#settings-form").addEventListener("change", keepSettingsDraft);
$('[name="creation-funding"]').addEventListener("change", () => {
  dirty = true;
  syncCreationFunding();
});
$('[name="creation-sizing"]').addEventListener("change", () => {
  dirty = true;
  syncCreationFunding();
});
$("#reset-form").onclick = () => {
  localStorage.removeItem(settingsDraftKey);
  settingsFeedback("Usando as configurações salvas.");
  dirty = false;
  fillSettings(state.config);
};
$("#settings-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const c = structuredClone(state.config);
    const fields = new FormData(e.target);
    if (
      !Number.isFinite(Number(fields.get("margin"))) ||
      Number(fields.get("margin")) <= 0
    )
      throw Error("Informe uma margem maior que 0%.");
    for (const key of ["margin", "fee", "recognition"])
      c[key] = (Number(fields.get(key)) / 100)
        .toFixed(8)
        .replace(/0+$/, "")
        .replace(/\.$/, "");
    for (const key of ["otherCost", "tick", "buffer"])
      c[key] = String(fields.get(key));
    for (const key of [
      "pollSeconds",
      "maxAgeSeconds",
      "cooldownSeconds",
      "decreaseCycles",
    ])
      c[key] = Number(fields.get(key));
    c.creation = {
      enabled: fields.has("creation-enabled"),
      account: creationAccount,
      allowActive: fields.has("creation-allowActive"),
      funding: String(fields.get("creation-funding")),
      amount:
        fields.get("creation-funding") === "fixed"
          ? String(fields.get("creation-amount"))
          : state.config.creation.amount,
      minimumBalance: String(fields.get("creation-minimumBalance")),
      speedPH:
        fields.get("creation-sizing") === "power"
          ? String(fields.get("creation-speedPH"))
          : state.config.creation.speedPH,
      sizing: String(fields.get("creation-sizing")),
      hours:
        fields.get("creation-sizing") === "duration"
          ? String(fields.get("creation-hours"))
          : state.config.creation.hours,
      destination: String(fields.get("creation-destination")),
    };
    const saved = await call("save", c);
    if (saved) {
      dirty = false;
      state.config = c;
      localStorage.removeItem(settingsDraftKey);
      settingsFeedback("Configurações salvas neste computador.");
      fillSettings(c);
      toast("Configuração salva. Suas escolhas foram mantidas.");
    }
  } catch (error) {
    toast(`Configuração inválida: ${error.message}`);
  }
};
$("#creation-load-pools").onclick = async () => {
  const button = $("#creation-load-pools");
  button.disabled = true;
  button.textContent = "Carregando pools…";
  try {
    const result = await call("creation-options");
    if (!result) return;
    const select = $('[name="creation-destination"]');
    const previous = select.value;
    select.replaceChildren(el("option", "Selecione um pool"));
    select.options[0].value = "";
    for (const pool of result.pools) {
      const option = el("option", pool.name);
      option.value = pool.id;
      select.append(option);
    }
    if (result.pools.some((p) => p.id === previous)) select.value = previous;
    creationAccount = result.account;
    dirty = true;
    toast("Pools carregados. Selecione o destino da nova ordem.");
  } finally {
    button.disabled = false;
    button.textContent = "Carregar pools da Hashsell";
  }
};
api.onState(render);
call("state").then((s) => {
  if (s) render(s);
});
setInterval(() => {
  if (state && ["dashboard", "settings"].includes(currentTab)) render(state);
}, 1000);
