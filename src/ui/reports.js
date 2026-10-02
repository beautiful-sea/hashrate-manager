(() => {
  const nav = document.createElement("button");
  nav.className = "nav";
  nav.dataset.tab = "reports";
  const icon = document.createElement("span");
  icon.textContent = "▤";
  nav.append(icon, document.createTextNode("Relatórios"));
  document
    .querySelector("nav")
    .insertBefore(nav, document.querySelector('[data-tab="history"]'));
  const page = document.createElement("section");
  page.id = "page-reports";
  page.className = "page";
  page.hidden = true;
  page.innerHTML = `<div class="page-heading"><div><div class="eyebrow">SUA ARBITRAGEM</div><h1>Relatórios</h1><p>Acompanhe seus ganhos e custos.</p></div><div class="actions"><button id="report-sync" class="button primary">Consultar agora</button><button id="report-export" class="button subtle">Exportar CSV</button></div></div>
  <div class="report-filters"><label>Período <select id="report-preset"><option value="today">Hoje</option><option value="yesterday">Ontem</option><option value="7d">Últimos 7 dias</option><option value="month">Mês atual</option><option value="all" selected>Todo o histórico</option><option value="custom">Personalizado</option></select></label><label>De <input id="report-from" type="date" disabled></label><label>Até <input id="report-to" type="date" disabled></label></div>
  <div class="report-meta"><span id="report-fx" class="report-fx" role="status"></span><span id="report-status" role="status"></span><details class="report-info"><summary>Detalhes</summary><p id="report-fx-detail"></p><p id="report-sync-detail"></p><p id="report-warnings"></p><p id="report-coverage"></p></details></div>
  <div id="report-metrics" class="metrics report-metrics"></div>
  <article class="panel report-panel"><div class="report-chart-heading"><h2 id="report-chart-title">Lucro acumulado</h2><button id="report-forecast" class="button subtle" aria-pressed="false">Ver previsão</button></div><details class="forecast-settings"><summary>Como calculamos</summary><p id="forecast-assumptions"></p></details><div id="report-investment" class="report-investment"><strong id="investment-total"></strong><p id="investment-status" role="status"></p><details><summary>Ver aportes Pix</summary><p>Todo o histórico da conta. A meta é ter lucro líquido igual ao total aportado via Pix. Recargas USDT não entram nessa meta.</p><div id="investment-deposits"></div></details></div><div class="report-chart-wrap"><div id="report-chart-tooltip" class="chart-tooltip" role="status" hidden></div><svg id="report-chart" viewBox="0 0 900 190" role="img" aria-label="Lucro acumulado por dia"></svg></div><p id="report-chart-label"></p></article>
  <article class="panel report-panel"><h2>Resultado diário</h2><div class="report-table"><table><thead><tr><th>Dia</th><th>Recargas</th><th>Receita</th><th>Consumo</th><th>Taxas</th><th>Lucro</th><th>Margem</th><th></th></tr></thead><tbody id="report-days"></tbody></table></div></article>
  <article class="panel report-panel"><h2 id="report-detail-title">Lançamentos do período</h2><div class="report-table"><table><thead><tr><th>Plataforma / data</th><th>Lançamento</th><th>Carteira / ordem</th><th>Valor</th><th>Classificação</th></tr></thead><tbody id="report-entries"></tbody></table></div><button id="report-all" class="button subtle">Ver todo o período</button></article>`;
  document.querySelector("main").append(page);
  const $ = (s) => page.querySelector(s),
    make = (tag, text) => {
      const e = document.createElement(tag);
      e.textContent = text;
      return e;
    };
  const money = (n) =>
    n == null
      ? "—"
      : Number(n).toLocaleString("pt-BR", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
  const category = {
    deposits: "Depósito",
    revenue: "Receita",
    consumption: "Consumo",
    fees: "Taxa",
    transfer: "Transferência interna",
    unknown: "Pendente de classificação",
  };
  let report,
    selectedDay = null,
    loading = false,
    forecasting = false;
  const filter = () => ({
    preset: $("#report-preset").value,
    from: $("#report-from").value,
    to: $("#report-to").value,
  });
  const chart = new window.ReportChart(
    $("#report-chart"),
    $("#report-chart-tooltip"),
    (day) => {
      selectedDay = day;
      entries();
      $("#report-detail-title").scrollIntoView({ behavior: "smooth" });
    },
  );
  const dual = (usd, brl, original = false) => {
    const n = make("span", "US$ " + (original ? usd : money(usd)));
    n.className = "dual-money";
    const equivalent = make("small", "≈ R$ " + money(brl));
    equivalent.className = "brl-value";
    n.append(equivalent);
    return n;
  };
  function entries() {
    $("#report-entries").replaceChildren();
    $("#report-detail-title").textContent = selectedDay
      ? `Lançamentos · ${selectedDay}`
      : "Lançamentos do período";
    for (const r of (report?.entries || []).filter(
      (r) => !selectedDay || r.day === selectedDay,
    )) {
      const tr = make("tr", "");
      for (const value of [
        `${r.site} · ${r.displayedAt || new Date(r.at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`,
        r.label,
        `${r.wallet} ${r.order}`,
        r.amount,
        category[r.category],
      ])
        tr.append(make("td", value));
      tr.children[3].replaceChildren(dual(r.amount, r.brlAmount, true));
      if (r.reportAt)
        tr.children[0].title =
          "Fechamento: " +
          new Date(r.reportAt).toLocaleString("pt-BR", {
            timeZone: "America/Sao_Paulo",
          });
      if (r.category === "unknown") tr.className = "report-pending";
      $("#report-entries").append(tr);
    }
  }
  function draw() {
    const projection = report.forecast;
    $("#forecast-assumptions").textContent = !forecasting
      ? "Receita menos consumo e taxas. Receita e custos são agrupados pelo fechamento da hora trabalhada. Os horários originais permanecem nos lançamentos e no CSV."
      : projection?.available
        ? "Capital: US$ " +
          money(projection.initialCapital) +
          ". Ciclo estimado: " +
          money(projection.cycleHours) +
          " horas, incluindo " +
          money(projection.timing.transitHours) +
          " horas entre pedido de saque e recarga (média de " +
          projection.timing.samples +
          " pagamentos), mais " +
          money(projection.timing.allocationHours) +
          " horas até a próxima reserva de ordem. Essa sequência estima a reaplicação; considera 24 horas de operação por ciclo. Retorno histórico de " +
          money(Number(projection.cycleRate) * 100) +
          "% por giro; US$ 2 por saque. Estimativa mantendo essas condições."
        : projection?.reason || "Aguardando dados";
    const button = $("#report-forecast");
    button.disabled = !projection?.available;
    button.title = projection?.available
      ? "Reinvestimento integral com retorno histórico"
      : projection?.reason || "Aguardando histórico";
    if (!projection?.available) forecasting = false;
    button.textContent = forecasting ? "Ver histórico" : "Ver previsão";
    button.setAttribute("aria-pressed", String(forecasting));
    $("#report-chart-title").textContent = forecasting
      ? "Previsão · próximos 30 dias"
      : "Lucro acumulado";
    const inv = report.investment;
    $("#report-investment").hidden = !inv;
    if (inv) {
      $("#investment-total").textContent =
        "Investido via Pix · US$ " +
        money(inv.target) +
        (inv.originalBrl != null
          ? " · R$ " + money(inv.originalBrl) + " pagos"
          : "");
      const date = (d) => d.split("-").reverse().join("/");
      $("#investment-status").textContent = !inv.count
        ? "Nenhum aporte Pix identificado no histórico."
        : !inv.complete
          ? "Aguardando histórico completo para estimar a recuperação."
          : inv.reached
            ? "Lucro igual ao investimento em " + date(inv.reached) + "."
            : inv.projected
              ? "Estimativa de recuperar o investimento: " +
                date(inv.projected) +
                ". Sem novos aportes."
              : projection?.available
                ? "Meta ainda não alcançada na previsão dos próximos 30 dias."
                : "Previsão de recuperação indisponível por enquanto.";
      const list = $("#investment-deposits");
      const signature = JSON.stringify(inv.deposits);
      if (list.dataset.signature !== signature) {
        list.dataset.signature = signature;
        list.replaceChildren(
          ...inv.deposits.map((r) =>
            make("p", date(r.day) + " · US$ " + money(r.amount)),
          ),
        );
      }
    }
    chart.render(
      forecasting ? projection.days : report.days,
      inv?.count
        ? {
            target: forecasting ? inv.forecastTarget : inv.historyTarget,
            day: forecasting ? inv.projected : inv.reached,
          }
        : null,
    );
    const label = $("#report-chart-label");
    label.replaceChildren();
    if (forecasting) {
      label.append(
        document.createTextNode("Acumulado previsto "),
        dual(projection.total, projection.brlTotal),
        document.createTextNode(" · Ganho previsto "),
        dual(projection.gain, projection.brlGain),
        document.createTextNode(
          " · Base: " + projection.count + " dias encerrados",
        ),
      );
      return;
    }
    if (!report.days.length) {
      label.textContent = "Sem lançamentos no período.";
      return;
    }
    const last = report.days.at(-1);
    label.append(
      document.createTextNode(
        report.days[0].day + " → " + last.day + " · acumulado ",
      ),
      dual(last.cumulative, last.brl?.cumulative),
    );
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      report = await window.hashrate.invoke("reports-query", filter());
      const fx = report.fx;
      $("#report-fx").classList.toggle("fx-stale", !!fx?.stale || !!fx?.error);
      $("#report-fx-detail").textContent = fx?.available
        ? "US$ 1 = R$ " +
          Number(fx.rate).toLocaleString("pt-BR", {
            minimumFractionDigits: 4,
            maximumFractionDigits: 6,
          }) +
          " · " +
          fx.source +
          " · Cotação: " +
          new Date(fx.at).toLocaleString("pt-BR") +
          (fx.stale ? " · Sem atualização recente." : "") +
          (fx.error ? " " + fx.error : "") +
          " Equivalentes estimados pela última cotação disponível, não pelo câmbio histórico. Consulta a cada minuto."
        : (fx?.error || "Consultando cotação USD/BRL…") +
          " Os valores em dólar continuam disponíveis.";
      $("#report-fx").textContent = fx?.available
        ? "Dólar R$ " +
          Number(fx.rate).toLocaleString("pt-BR", {
            minimumFractionDigits: 4,
            maximumFractionDigits: 4,
          }) +
          (fx.stale ? " · Última cotação" : "")
        : "Dólar · " + (fx?.loading ? "Consultando…" : "Indisponível");
      $("#report-status").textContent = report.busy
        ? "Atualizando…"
        : report.error
          ? /login expirado|redirecionada/i.test(report.error)
            ? "Entre novamente nas suas contas"
            : "Atualização pendente"
          : !report.ready
            ? "Aguardando suas contas"
            : report.warnings?.length
              ? "Há dados a conferir"
              : "Atualizado " +
                new Date(report.updatedAt).toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                });
      $("#report-sync-detail").textContent =
        (report.error ? `${report.error} · ` : "") +
        (report.progress || "Histórico local") +
        (report.updatedAt
          ? ` · Atualização: ${new Date(report.updatedAt).toLocaleString("pt-BR")}`
          : "");
      $("#report-sync").disabled = report.busy;
      $("#report-export").disabled = !report.ready;
      $("#report-warnings").hidden = !report.warnings.length;
      $("#report-warnings").textContent = report.warnings.join(" ");
      $("#report-coverage").textContent =
        report.coverage
          ?.map((c) => `${c.site}: ${c.from} a ${c.to}`)
          .join(" · ") ||
        "Dados locais, separados por conta. Faça login nas duas plataformas para importar.";
      // Keep card nodes so open disclosures, selection and keyboard focus survive polling.
      for (const [key, label] of [
        [
          "profit",
          report.paymentsReady ? "Lucro apurado" : "Lucro antes dos saques",
        ],
        ["revenue", "Receita RentalHash"],
        ["consumption", "Hashpower consumido"],
        ["fees", "Taxas"],
        ["deposits", "Recargas na Hashsell"],
        ["margin", "Margem sobre receita"],
      ]) {
        const existing = $("#report-metrics").querySelector(
          '[data-metric="' + key + '"]',
        );
        if (existing) {
          existing.firstElementChild.textContent = label;
          const value = existing.querySelector("h2");
          if (!report.ready) value.textContent = "—";
          else if (key === "margin")
            value.textContent = money(report.totals[key]) + "%";
          else
            value.replaceChildren(
              dual(report.totals[key], report.totals.brl?.[key]),
            );
          if (key === "profit")
            existing.querySelector("p").textContent = report.paymentsReady
              ? "Após consumo e taxas"
              : "Taxas de saque ainda não importadas";
          if (key === "fees") {
            const paragraphs = existing.querySelectorAll("details p");
            const texts = [
              "Consumo Hashsell (3%): US$ " +
                money(report.totals?.consumptionFees),
              report.paymentsReady
                ? "Saques RentalHash: US$ " +
                  money(report.totals?.withdrawalFees)
                : "Saques: aguardando importação",
            ];
            paragraphs.forEach((p, i) => {
              if (p.textContent !== texts[i]) p.textContent = texts[i];
            });
          }
          continue;
        }
        const card = make("article", "");
        card.dataset.metric = key;
        card.className =
          "metric" + (key === "profit" ? " profit-highlight" : "");
        card.append(
          make("div", label),
          make(
            "h2",
            report.ready
              ? `${key === "margin" ? "" : "US$ "}${money(report.totals[key])}${key === "margin" ? "%" : ""}`
              : "—",
          ),
        );
        if (report.ready && key !== "margin")
          card
            .querySelector("h2")
            .replaceChildren(
              dual(report.totals[key], report.totals.brl?.[key]),
            );
        if (key === "profit")
          card.append(
            make(
              "p",
              report.paymentsReady
                ? "Após consumo e taxas"
                : "Taxas de saque ainda não importadas",
            ),
          );
        if (key === "deposits") {
          const detail = make("details", "");
          detail.append(
            make("summary", "Ver composição"),
            make(
              "p",
              "Soma das recargas do período, incluindo possíveis reinvestimentos. Não representa capital próprio investido.",
            ),
          );
          card.append(detail);
        }
        if (key === "fees") {
          const detail = make("details", "");
          detail.append(
            make("summary", "Ver taxas"),
            make(
              "p",
              "Consumo Hashsell (3%): US$ " +
                money(report.totals?.consumptionFees),
            ),
            make(
              "p",
              report.paymentsReady
                ? "Saques RentalHash: US$ " +
                    money(report.totals?.withdrawalFees)
                : "Saques: aguardando importação",
            ),
          );
          card.append(detail);
        }
        $("#report-metrics").append(card);
      }
      $("#report-days").replaceChildren();
      for (const d of report.days) {
        const row = make("tr", "");
        for (const value of [
          `${d.day.split("-").reverse().join("/")}${d.partial ? " · Em andamento" : ""}`,
          money(d.deposits),
          money(d.revenue),
          money(d.consumption),
          money(d.fees),
          money(d.profit),
          money(d.margin) + "%",
        ])
          row.append(make("td", value));
        ["deposits", "revenue", "consumption", "fees", "profit"].forEach(
          (key, index) =>
            row.children[index + 1].replaceChildren(dual(d[key], d.brl?.[key])),
        );
        const cell = make("td", ""),
          button = make("button", "Ver lançamentos");
        button.className = "button subtle";
        button.onclick = () => {
          selectedDay = d.day;
          entries();
          $("#report-detail-title").scrollIntoView({ behavior: "smooth" });
        };
        cell.append(button);
        row.append(cell);
        $("#report-days").append(row);
      }
      entries();
      draw();
    } catch (e) {
      $("#report-status").textContent = e.message;
    } finally {
      loading = false;
    }
  }

  $("#report-forecast").onclick = () => {
    forecasting = !forecasting;
    draw();
  };
  $("#report-preset").onchange = () => {
    const custom = $("#report-preset").value === "custom";
    $("#report-from").disabled = $("#report-to").disabled = !custom;
    if (!custom || ($("#report-from").value && $("#report-to").value))
      void refresh();
  };
  for (const id of ["#report-from", "#report-to"])
    $(id).onchange = () => {
      if ($("#report-from").value && $("#report-to").value) void refresh();
    };
  $("#report-sync").onclick = async () => {
    await window.hashrate.invoke("reports-sync");
    void refresh();
  };
  $("#report-export").onclick = async () => {
    try {
      await window.hashrate.invoke("reports-export", filter());
    } catch (e) {
      $("#report-status").textContent = e.message;
    }
  };
  $("#report-all").onclick = () => {
    selectedDay = null;
    entries();
  };
  setInterval(() => {
    if (!page.hidden) void refresh();
  }, 2500);
})();
