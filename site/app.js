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
