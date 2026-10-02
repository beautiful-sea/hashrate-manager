(() => {
  const q = (s) => document.querySelector(s);
  async function refresh(action = "analytics-state", value) {
    try {
      const state = await window.hashrate.invoke(action, value);
      q("#analytics-enabled").checked = state.consent === true;
      if (action === "analytics-consent")
        q("#analytics-feedback").textContent = state.consent
          ? "MÃ©tricas de uso ativadas."
          : "MÃ©tricas desativadas. Nenhum novo dado serÃ¡ enviado.";
    } catch {
      q("#analytics-feedback").textContent =
        "NÃ£o foi possÃ­vel salvar a escolha. Tente novamente.";
    }
  }
  q("#analytics-enabled").onchange = (event) =>
    refresh("analytics-consent", event.target.checked);
  void refresh();
})();
