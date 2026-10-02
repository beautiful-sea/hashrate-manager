(() => {
  const q = (s) => document.querySelector(s);
  const dialog = q("#update-modal");
  const announced = new Set();
  let latest,
    opening = false,
    dismissed;
  try {
    dismissed = sessionStorage.getItem("postponed-update");
  } catch {
    /* In-memory fallback. */
  }
  async function openModal() {
    if (
      opening ||
      dialog.open ||
      !["ready", "waiting"].includes(latest?.status)
    )
      return;
    opening = true;
    try {
      await window.hashrate.invoke("updates-dialog", true);
      dialog.showModal();
      announced.add(latest.version);
    } catch {
      await window.hashrate.invoke("updates-dialog", false).catch(() => {});
    } finally {
      opening = false;
    }
  }
  async function postpone() {
    if (latest?.status === "installing") return;
    if (latest?.status === "waiting") await refresh("updates-cancel");
    if (latest?.status === "installing") return;
    dismissed = latest?.version;
    try {
      sessionStorage.setItem("postponed-update", dismissed || "");
    } catch {
      /* In-memory fallback. */
    }
    dialog.close();
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    void postpone();
  });
  dialog.addEventListener("close", () => {
    void window.hashrate.invoke("updates-dialog", false).catch(() => {});
  });
  async function refresh(action = "updates-state") {
    try {
      const s = await window.hashrate.invoke(action);
      latest = s;
      q("#app-version").textContent = `DESKTOP · v${s.current}`;
      const messages = {
        downloading: `Baixando atualização${s.version ? " " + s.version : ""} · ${Math.round(s.percent)}%`,
        ready: "Nova versão pronta para instalar.",
        waiting: `Download concluído · 100%. ${s.waitingReason || "Preparando o reinício."}`,
        installing: "Instalando atualização…",
        error:
          "Não foi possível verificar a atualização. Tentaremos novamente.",
      };
      const complete = ["ready", "waiting", "installing"].includes(s.status);
      const percent = complete ? 100 : Math.round(s.percent || 0);
      const mb = (value) =>
        (Number(value) / 1048576).toLocaleString("pt-BR", {
          maximumFractionDigits: 1,
        });
      const progressLabel = complete
        ? "Download concluído · 100%"
        : `${percent}%${s.total ? ` · ${mb(s.transferred)} de ${mb(s.total)} MB` : ""}`;
      q("#update-progress").hidden = !complete && s.status !== "downloading";
      q("#update-download").value = percent;
      q("#update-progress-label").textContent = progressLabel;
      q("#update-modal-download").value = percent;
      q("#update-modal-progress-label").textContent = progressLabel;
      q("#app-update").hidden = !messages[s.status];
      q("#app-update-text").textContent = messages[s.status] || "";
      q("#app-update-action").hidden = s.status !== "ready";
      q("#app-update-cancel").hidden = s.status !== "waiting";
      q("#updates-check").disabled = [
        "checking",
        "downloading",
        "waiting",
        "installing",
      ].includes(s.status);
      q("#update-modal-version").textContent = s.version
        ? `Versão ${s.version}`
        : "";
      q("#update-modal-description").textContent =
        s.status === "waiting"
          ? `${s.waitingReason || "Preparando o reinício."} O aplicativo vai reiniciar em seguida.`
          : s.status === "installing"
            ? "Instalando a atualização. O aplicativo será reaberto em seguida."
            : "A atualização está pronta. O aplicativo será reiniciado para instalar.";
      q("#update-modal-install").hidden = ["waiting", "installing"].includes(
        s.status,
      );
      q("#update-modal-later").disabled = s.status === "installing";
      q("#update-modal-later").textContent =
        s.status === "waiting" ? "Cancelar reinício" : "Agora não";
      if (!["ready", "waiting", "installing"].includes(s.status) && dialog.open)
        dialog.close();
      if (
        s.status === "ready" &&
        (action === "updates-check" ||
          (!announced.has(s.version) && dismissed !== s.version))
      )
        await openModal();
      if (action === "updates-check" && s.status === "idle") {
        q("#app-update").hidden = false;
        q("#app-update-text").textContent =
          "Você está usando a versão mais recente.";
      }
    } catch {
      /* Update failures must not disrupt operation. */
    }
  }
  q("#updates-check").onclick = () => refresh("updates-check");
  q("#app-update-action").onclick = () => void openModal();
  q("#app-update-cancel").onclick = () => refresh("updates-cancel");
  q("#update-modal-later").onclick = () => void postpone();
  q("#update-modal-install").onclick = () => refresh("updates-install");
  void refresh();
  setInterval(() => void refresh(), 2000);
})();
