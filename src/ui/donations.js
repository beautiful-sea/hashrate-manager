(() => {
  const q = (s) => document.querySelector(s);
  const modal = q("#donation-modal");
  let opening = false;
  q("#contribute-project").onclick = async () => {
    if (opening || modal.open) return;
    opening = true;
    try {
      const data = await window.hashrate.invoke("donation-info");
      const ready = Boolean(data.payload && data.qr);
      q("#donation-payment").hidden = !ready;
      q("#donation-unavailable").hidden = ready;
      q("#donation-feedback").textContent = "";
      q("#donation-beneficiary").textContent = data.beneficiary;
      if (ready) q("#donation-qr").src = data.qr;
      await window.hashrate.invoke("donation-dialog", true);
      modal.showModal();
      q("#donation-close").focus();
    } catch {
      await window.hashrate.invoke("donation-dialog", false).catch(() => {});
    } finally {
      opening = false;
    }
  };
  q("#donation-close").onclick = () => modal.close();
  modal.addEventListener("close", () => {
    void window.hashrate.invoke("donation-dialog", false).catch(() => {});
  });
  q("#donation-copy").onclick = async () => {
    try {
      await window.hashrate.invoke("donation-copy");
      q("#donation-feedback").textContent =
        "Código copiado. Cole no seu banco para contribuir.";
    } catch {
      q("#donation-feedback").textContent =
        "Não foi possível copiar. Tente novamente.";
    }
  };
})();
