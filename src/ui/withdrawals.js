(() => {
  const nav = document.createElement("button");
  nav.className = "nav";
  nav.dataset.tab = "withdrawals";
  const icon = document.createElement("span");
  icon.textContent = "◷";
  nav.append(icon, document.createTextNode("Saques"));
  document
    .querySelector("nav")
    .insertBefore(nav, document.querySelector('[data-tab="history"]'));
  const page = document.createElement("section");
  page.id = "page-withdrawals";
  page.className = "page";
  page.hidden = true;
  page.innerHTML = `<div class="page-heading"><div><div class="eyebrow">RENTALHASH</div><h1>Saques</h1><p>Acompanhe a espera até o dinheiro chegar.</p></div></div>
    <div class="report-meta"><span id="withdrawal-status" role="status">Aguardando histórico</span><details class="report-info"><summary>Como estimamos</summary><p>A média considera o tempo entre o pedido e a conclusão de todos os saques com datas confirmadas. O tempo restante é uma estimativa; um saque pode demorar mais.</p><p id="withdrawal-detail"></p></details></div>
    <div class="metrics withdrawal-metrics"><article class="metric"><div class="metric-label">TEMPO MÉDIO</div><div class="metric-value" id="withdrawal-average">—</div><p id="withdrawal-samples">Aguardando saques concluídos</p></article><article class="metric"><div class="metric-label">MAIS RÁPIDO</div><div class="metric-value" id="withdrawal-fastest">—</div><p>Entre os saques concluídos</p></article><article class="metric"><div class="metric-label">EM ANDAMENTO</div><div class="metric-value" id="withdrawal-pending-count">—</div><p id="withdrawal-completed-count"></p></article></div>
    <article class="panel report-panel"><h2>Em andamento</h2><div id="withdrawal-pending" class="withdrawal-pending-grid"></div></article>
    <article class="panel report-panel"><div class="report-chart-heading"><h2>Tempo de cada saque</h2><span id="withdrawal-mean-label" class="withdrawal-legend"></span></div><div id="withdrawal-timeline" class="withdrawal-timeline" role="list" aria-label="Duração dos saques"></div></article>
    <article class="panel report-panel"><div class="report-chart-heading"><h2>Histórico de saques</h2><label class="withdrawal-filter">Mostrar <select id="withdrawal-filter"><option value="all">Todos</option><option value="pending">Em andamento</option><option value="completed">Concluídos</option><option value="closed">Cancelados e falhas</option></select></label></div><div class="report-table"><table><thead><tr><th>Pedido</th><th>Valor líquido</th><th>Situação</th><th>Tempo</th><th>Conclusão / estimativa</th></tr></thead><tbody id="withdrawal-rows"></tbody></table></div></article>`;
  document.querySelector("main").append(page);
  const $ = (selector) => page.querySelector(selector);
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const money = (n) =>
    n == null
      ? "—"
      : Number(n).toLocaleString("pt-BR", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
  const duration = (ms) => {
    if (ms == null) return "—";
    const minutes = Math.floor(Math.max(0, ms) / 60000);
    if (!minutes) return ms > 0 ? "menos de 1 min" : "0 min";
    const hours = Math.floor(minutes / 60),
      rest = minutes % 60;
    return hours ? `${hours} h${rest ? ` ${rest} min` : ""}` : `${rest} min`;
  };
  const date = (at) =>
    at
      ? new Date(at).toLocaleString("pt-BR", {
          timeZone: "America/Sao_Paulo",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
      : "—";
  const amount = (row) => {
    const value = make(
      "span",
      row.net == null ? "—" : "US$ " + money(row.net),
      "dual-money",
    );
    if (row.brlNet != null)
      value.append(make("small", "≈ R$ " + money(row.brlNet), "brl-value"));
    return value;
  };
  let state,
    loading = false,
    signature = null,
    clocks = [],
    bars = [],
    scale = 1;
  const visibleRows = () =>
    (state?.rows || []).filter((row) => {
      const filter = $("#withdrawal-filter").value;
      return (
        filter === "all" ||
        (filter === "pending" && row.pending) ||
        (filter === "completed" && row.status === "Concluído") ||
        (filter === "closed" && ["Cancelado", "Falhou"].includes(row.status))
      );
    });
  function pendingTime(row, now) {
    if (!row.estimatedAt) return "Ainda sem estimativa";
    const end = Date.parse(row.estimatedAt);
    return end > now
      ? `Cerca de ${duration(end - now)} restantes`
      : `${duration(now - end)} acima da média`;
  }
  function tick() {
    if (!state || page.hidden) return;
    const now = Date.now();
    for (const { node, row, kind } of clocks) {
      const elapsed = row.requestedAt
        ? Math.max(0, now - Date.parse(row.requestedAt))
        : null;
      node.textContent =
        kind === "estimate"
          ? pendingTime(row, now)
          : row.pending
            ? elapsed == null
              ? "Horário não confirmado"
              : duration(elapsed) + " de espera"
            : duration(row.durationMs);
      if (kind === "estimate")
        node.classList.toggle(
          "withdrawal-overdue",
          !!row.estimatedAt && Date.parse(row.estimatedAt) <= now,
        );
    }
    for (const { node, row } of bars) {
      const elapsed =
        row.pending && row.requestedAt
          ? Math.max(0, now - Date.parse(row.requestedAt))
          : row.durationMs;
      node.style.width = `${elapsed == null ? 0 : Math.min(100, (elapsed / scale) * 100)}%`;
    }
  }
  function rebuild() {
    clocks = [];
    bars = [];
    $("#withdrawal-pending").replaceChildren();
    const pending = (state.rows || []).filter((row) => row.pending);
    if (!pending.length)
      $("#withdrawal-pending").append(
        make(
          "p",
          state.ready
            ? "Nenhum saque em andamento."
            : "Entre nas suas contas para importar o histórico.",
          "withdrawal-empty",
        ),
      );
    for (const row of pending) {
      const card = make("div", null, "withdrawal-pending-card");
      const estimate = make("strong", null, "withdrawal-estimate"),
        elapsed = make("span", null, "withdrawal-elapsed");
      card.append(
        amount(row),
        make(
          "p",
          "Pedido em " +
            (row.requestedAt
              ? date(row.requestedAt)
              : row.displayedAt || "horário não confirmado"),
        ),
        estimate,
        elapsed,
      );
      if (row.estimatedAt)
        card.append(
          make("small", "Conclusão estimada: " + date(row.estimatedAt)),
        );
      $("#withdrawal-pending").append(card);
      clocks.push(
        { node: estimate, row, kind: "estimate" },
        { node: elapsed, row, kind: "duration" },
      );
    }
    const rows = visibleRows();
    $("#withdrawal-rows").replaceChildren();
    $("#withdrawal-timeline").replaceChildren();
    scale =
      Math.max(
        1,
        state.averageMs || 0,
        ...rows.map((row) => row.durationMs || row.elapsedMs || 0),
      ) * 1.12;
    const meanPercent =
      state.averageMs == null ? null : (state.averageMs / scale) * 100;
    for (const row of rows) {
      const tr = make("tr"),
        status = make(
          "span",
          row.status,
          "withdrawal-badge" +
            (row.pending
              ? " is-pending"
              : row.status === "Concluído"
                ? " is-completed"
                : ""),
        );
      const elapsed = make("td"),
        end = make("td");
      const value = make("td");
      value.append(amount(row));
      const statusCell = make("td");
      statusCell.append(status);
      tr.append(
        make(
          "td",
          row.requestedAt ? date(row.requestedAt) : row.displayedAt || "—",
        ),
        value,
        statusCell,
        elapsed,
        end,
      );
      if (row.pending)
        clocks.push(
          { node: elapsed, row, kind: "duration" },
          { node: end, row, kind: "estimate" },
        );
      else {
        elapsed.textContent = duration(row.durationMs);
        end.textContent = row.completedAt
          ? date(row.completedAt)
          : row.status === "Concluído"
            ? "Data não disponível"
            : "—";
      }
      $("#withdrawal-rows").append(tr);
      const line = make("div", null, "withdrawal-line");
      line.setAttribute("role", "listitem");
      const caption = make("div", null, "withdrawal-line-caption");
      caption.append(
        make(
          "strong",
          row.requestedAt
            ? date(row.requestedAt)
            : row.displayedAt || "Horário não confirmado",
        ),
        amount(row),
      );
      const journey = make("div", null, "withdrawal-journey"),
        track = make("div", null, "withdrawal-track"),
        bar = make(
          "div",
          null,
          "withdrawal-bar" + (row.pending ? " is-pending" : ""),
        );
      if (row.durationMs == null && !row.pending)
        bar.classList.add("unavailable");
      track.append(bar);
      if (meanPercent != null) {
        const marker = make("span", null, "withdrawal-mean");
        marker.style.left = meanPercent + "%";
        marker.title = "Média: " + duration(state.averageMs);
        track.append(marker);
      }
      const summary = make("div", null, "withdrawal-line-summary"),
        wait = make("strong");
      summary.append(
        wait,
        make(
          "span",
          row.pending
            ? "Em andamento"
            : row.completedAt
              ? "Concluído em " + date(row.completedAt)
              : row.status,
        ),
      );
      if (row.pending) clocks.push({ node: wait, row, kind: "duration" });
      else
        wait.textContent =
          row.durationMs == null
            ? "Duração não disponível"
            : duration(row.durationMs);
      bar.title = `${row.status} · ${date(row.requestedAt)} → ${date(row.completedAt)}`;
      journey.append(track, summary);
      line.append(caption, journey);
      $("#withdrawal-timeline").append(line);
      bars.push({ node: bar, row });
    }
    if (!rows.length) {
      $("#withdrawal-timeline").append(
        make("p", "Nenhum saque neste filtro.", "withdrawal-empty"),
      );
      const tr = make("tr"),
        cell = make("td", "Nenhum saque neste filtro.");
      cell.colSpan = 5;
      tr.append(cell);
      $("#withdrawal-rows").append(tr);
    }
    tick();
  }
  async function refresh() {
    if (loading || page.hidden) return;
    loading = true;
    try {
      const result = await window.hashrate.invoke("withdrawals-query");
      if (page.hidden) return;
      state = result;
      $("#withdrawal-average").textContent = duration(state.averageMs);
      $("#withdrawal-fastest").textContent = duration(state.fastestMs);
      $("#withdrawal-samples").textContent = state.sampleCount
        ? `Baseado em ${state.sampleCount} saque${state.sampleCount === 1 ? " concluído" : "s concluídos"}`
        : "Aguardando datas de conclusão";
      $("#withdrawal-pending-count").textContent = state.ready
        ? String(state.pendingCount)
        : "—";
      $("#withdrawal-completed-count").textContent = state.ready
        ? `${state.completedCount} concluídos no histórico`
        : "Aguardando histórico";
      $("#withdrawal-mean-label").textContent =
        state.averageMs == null ? "" : "┆ Média " + duration(state.averageMs);
      $("#withdrawal-status").textContent = state.busy
        ? "Atualizando histórico…"
        : state.error
          ? /login expirado|redirecionada/i.test(state.error)
            ? "Entre novamente nas suas contas"
            : "Atualização pendente"
          : !state.ready
            ? "Aguardando suas contas"
            : state.stale
              ? "Usando o último histórico disponível"
              : "Atualizado " +
                new Date(state.updatedAt).toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                });
      $("#withdrawal-detail").textContent = [
        state.timingError,
        state.error,
        state.ignored
          ? `${state.ignored} registro(s) sem datas válidas ficaram fora da média.`
          : "",
        state.ready && !state.timezoneConfirmed
          ? "Ainda não foi possível confirmar o horário dos pedidos pendentes."
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      const next = JSON.stringify([
        state.rows.map(({ elapsedMs, remainingMs, overdueMs, ...row }) => row),
        state.averageMs,
        $("#withdrawal-filter").value,
      ]);
      if (next !== signature) {
        signature = next;
        rebuild();
      } else tick();
    } catch {
      $("#withdrawal-status").textContent =
        "Não foi possível consultar o histórico";
    } finally {
      loading = false;
    }
  }
  $("#withdrawal-filter").onchange = () => {
    signature = null;
    if (state) rebuild();
  };
  nav.addEventListener("click", () => setTimeout(() => void refresh(), 0));
  setInterval(() => void refresh(), 10000);
  setInterval(tick, 1000);
})();
