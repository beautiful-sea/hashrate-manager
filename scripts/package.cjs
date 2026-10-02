const path = require("node:path");
const fs = require("node:fs");
(async () => {
  const { packager } = await import("@electron/packager");
  const root = path.join(__dirname, "..");
  const localZip = path.join(
    root,
    "artifacts",
    `electron-v${require("../package.json").devDependencies.electron}-win32-x64.zip`,
  );
  const output = await packager({
    dir: root,
    name: "HashrateManager",
    icon: path.join(root, "src/assets/icon.ico"),
    platform: "win32",
    arch: "x64",
    out: path.resolve(root, process.argv[2] || "dist"),
    ...(fs.existsSync(localZip)
      ? { electronZipDir: path.dirname(localZip) }
      : {}),
    ignore: [/^\/(tests|scripts|server|artifacts|openspec|\.codex|dist)(\/|$)/],
    prune: true,
  });
  console.log(output.join("\n"));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
