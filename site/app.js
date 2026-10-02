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
