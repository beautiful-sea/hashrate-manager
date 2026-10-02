"use strict";
// The permanent download URL is usable even when the version lookup fails.
const feed = "https://ecoesponja.com.br/hashrate-updates/latest.yml";
async function refreshVersion() {
  try {
    const response = await fetch(feed, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return;
    const match = (await response.text()).match(
      /^version:\s*["']?(\d+\.\d+\.\d+)["']?\s*$/m,
    );
    if (!match) return;
    document.querySelectorAll("[data-version]").forEach((node) => {
      node.textContent = "v" + match[1];
    });
  } catch {
    /* Download remains available without a version label. */
  }
}
refreshVersion();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshVersion();
});

async function refreshMacVersion() {
  try {
    const response = await fetch(
      "https://api.github.com/repos/beautiful-sea/hashrate-manager/releases/latest",
      { cache: "no-store", signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) return;
    const release = await response.json();
    if (
      !/^v\d+\.\d+\.\d+$/.test(release.tag_name) ||
      release.draft ||
      release.prerelease
    )
      return;
    if (
      !["arm64", "x64"].every((arch) =>
        release.assets?.some(
          (asset) => asset.name === "Hashrate-Manager-mac-" + arch + ".dmg",
        ),
      )
    )
      return;
    document.querySelectorAll("[data-mac-version]").forEach((node) => {
      node.textContent = release.tag_name;
    });
  } catch {
    /* Stable release download links remain available. */
  }
}
refreshMacVersion();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshMacVersion();
});

const donationModal = document.querySelector("#donation-modal");
let donationTrigger;
document.querySelectorAll("[data-open-donation]").forEach((button) => {
  button.addEventListener("click", () => {
    donationTrigger = button;
    document.querySelector("#donation-feedback").textContent = "";
    donationModal.showModal();
    document.querySelector("#donation-close").focus();
  });
});
document
  .querySelector("#donation-close")
  .addEventListener("click", () => donationModal.close());
donationModal.addEventListener("close", () => donationTrigger?.focus());
donationModal.addEventListener("click", (event) => {
  const bounds = donationModal.getBoundingClientRect();
  if (
    event.target === donationModal &&
    (event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom)
  )
    donationModal.close();
});
document.querySelector("#donation-copy").addEventListener("click", async () => {
  const code = document.querySelector("#donation-code");
  const feedback = document.querySelector("#donation-feedback");
  try {
    await navigator.clipboard.writeText(code.value);
    feedback.textContent = "Código copiado. Cole no seu banco para contribuir.";
  } catch {
    code.focus();
    code.select();
    feedback.textContent =
      "Selecione Copiar no seu dispositivo para copiar o código Pix.";
  }
});
