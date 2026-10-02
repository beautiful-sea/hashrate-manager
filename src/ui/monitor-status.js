(function (root) {
  function ordersStatus(s, now = Date.now()) {
    const orders = s.sources?.orders;
    const error = s.errors?.orders || "";
    const known =
      !error &&
      orders &&
      Number.isFinite(orders.at) &&
      now >= orders.at &&
      now - orders.at <= (s.config?.maxAgeSeconds || 75) * 1000;
    if (known)
      return {
        known: true,
        title: "Nenhuma ordem ativa encontrada",
        text: s.running
          ? "A leitura da Hashsell foi concluída. Novas ordens serão acompanhadas automaticamente."
          : "A última leitura não encontrou ordens ativas. Inicie o monitoramento para atualizar.",
      };
    if (/faça login|login expir|sessão expir|AUTH_REQUIRED/i.test(error))
      return {
        known: false,
        title: "Entre novamente na Hashsell",
        text: "Sua sessão precisa de login para que o app consiga ler as ordens.",
      };
    if (!s.running)
      return {
        known: false,
        title: "Monitoramento pausado",
        text: "Inicie o monitoramento para consultar suas ordens na Hashsell.",
      };
    return {
      known: false,
      title: "Aguardando leitura da Hashsell",
      text: error
        ? "Não foi possível carregar as ordens na Hashsell agora. O app tentará novamente automaticamente."
        : "Buscando suas ordens na Hashsell. Elas aparecerão assim que a leitura for concluída.",
    };
  }
  function monitorStatus(s) {
    if (!s.running) return { text: "Monitoramento pausado.", warning: false };
    const errors = Object.values(s.errors || {}).join(" ");
    if (/faça login|login expir|sessão expir|AUTH_REQUIRED/i.test(errors))
      return {
        text: "Faça login novamente na plataforma para retomar os ajustes. O monitoramento continua ativo.",
        warning: true,
      };
    if (s.result?.blocked)
      return {
        text: "Atualizando os dados das plataformas. O monitoramento continua e os ajustes retomam assim que a leitura estiver disponível.",
        warning: false,
      };
    if (Object.keys(s.pending || {}).length)
      return {
        text: "Conferindo um ajuste automaticamente. As demais ordens continuam sendo acompanhadas.",
        warning: false,
      };
    return {
      text:
        s.mode === "live"
          ? "Monitoramento ativo. Ajustes automáticos ligados."
          : "Monitoramento ativo. Ajustes automáticos desligados.",
      warning: false,
    };
  }
  if (typeof module !== "undefined" && module.exports)
    module.exports = { monitorStatus, ordersStatus };
  else {
    root.monitorStatus = monitorStatus;
    root.ordersStatus = ordersStatus;
  }
})(typeof window !== "undefined" ? window : globalThis);
