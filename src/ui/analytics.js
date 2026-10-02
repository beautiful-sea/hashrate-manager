(() => {
  const q = (s) => document.querySelector(s);
  async function refresh(action = "analytics-state", value) {
    try {
      const state = await window.hashrate.invoke(action, value);
      q("#analytics-enabled").checked = state.consent === true;
      if (action === "analytics-consent")
        q("#analytics-feedback").textContent = state.consent
          ? "Métricas de uso ativadas."
          : "Métricas desativadas. Nenhum novo dado será enviado.";
    } catch {
      q("#analytics-feedback").textContent =
        "Não foi possível salvar a escolha. Tente novamente.";
    }
  }
  q("#analytics-enabled").onchange = (event) =>
    refresh("analytics-consent", event.target.checked);
  void refresh();
})();
