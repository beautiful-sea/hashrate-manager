const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const testRelease = process.argv.includes("--test-release");
const feed = "https://ecoesponja.com.br/hashrate-updates/";
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
}
async function release() {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
  const version = process.argv[2] || metadata.version;
  assert(/^\d+\.\d+\.\d+$/.test(version), "Use a stable semantic version");
  const stage = path.join(
    root,
    "artifacts",
    testRelease ? "update-test-releases" : "releases",
    version,
  );
  const project = path.join(stage, "app");
  const output = path.join(
    root,
    "dist",
    testRelease ? "updates-test" : "updates",
    version,
  );
  assert(
    !fs.existsSync(output),
    "Version already built; never overwrite a release",
  );
  fs.mkdirSync(project, { recursive: true });
  fs.cpSync(path.join(root, "src"), path.join(project, "src"), {
    recursive: true,
  });
  const list = spawnSync(
    "npm.cmd",
    ["ls", "--omit=dev", "--all", "--parseable"],
    { cwd: root, encoding: "utf8", shell: true, windowsHide: true },
  );
  assert.equal(list.status, 0, list.stderr);
  const dirs = list.stdout.trim().split(/\r?\n/).slice(1);
  for (const dir of dirs) {
    const relative = path.relative(root, dir);
    assert(
      relative.startsWith("node_modules" + path.sep) &&
        !relative.includes(".."),
    );
    // Never copy nested node_modules incidentally; every dependency is an explicit closure entry.
    fs.cpSync(dir, path.join(project, relative), {
      recursive: true,
      filter: (source) =>
        !path.relative(dir, source).split(path.sep).includes("node_modules"),
    });
  }
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify(
      {
        name: metadata.name,
        productName: metadata.productName,
        version,
        description: metadata.description,
        main: metadata.main,
        license: metadata.license,
        private: true,
        dependencies: metadata.dependencies,
      },
      null,
      2,
    ),
  );
  for (const file of walk(project)) {
    assert(
      !/(^|[\\/])(Partitions|Cookies|Cache|state\.json|reports\.json|analytics\.json|\.env|\.ssh|artifacts|tests|scripts|server)([\\/]|$)/i.test(
        path.relative(project, file),
      ),
      "Private file " + file,
    );
    if (file.startsWith(path.join(project, "src") + path.sep))
      assert(
        !/C:[\\/]Users|E:[\\/]laragon/i.test(fs.readFileSync(file, "utf8")),
        "Personal data " + file,
      );
  }
  const { build, Platform, Arch } = require("electron-builder");
  await build({
    projectDir: project,
    targets: Platform.WINDOWS.createTarget("nsis", Arch.x64),
    publish: "never",
    config: {
      appId: testRelease
        ? "com.hashrate.update-test"
        : "com.lg.hashrate-manager",
      productName: testRelease ? "Hashrate Update Test" : "Hashrate Manager",
      electronVersion: metadata.devDependencies.electron,
      electronDist: path.join(root, "node_modules/electron/dist"),
      directories: { output },
      files: ["src/**/*", "package.json", "node_modules/**/*"],
      npmRebuild: false,
      win: {
        executableName: testRelease ? "HashrateUpdateTest" : "HashrateManager",
        target: ["nsis"],
        icon: path.join(root, "src/assets/icon.ico"),
        signExecutable: false,
      },
      nsis: {
        ...(testRelease
          ? {}
          : { include: path.join(root, "scripts/updater-installer.nsh") }),
        installerIcon: path.join(root, "src/assets/icon.ico"),
        uninstallerIcon: path.join(root, "src/assets/icon.ico"),
        oneClick: true,
        perMachine: false,
        allowElevation: false,
        deleteAppDataOnUninstall: false,
        runAfterFinish: true,
        artifactName: "Hashrate-Manager-Setup-${version}-win-x64.exe",
      },
      publish: { provider: "generic", url: feed },
    },
  });
  const archive = path.join(output, "win-unpacked/resources/app.asar");
  const asar = await import("@electron/asar");
  const entries = asar
    .listPackage(archive)
    .map((x) => x.replace(/^[\\/]/, "").replaceAll("\\", "/"));
  assert(
    entries.every(
      (x) =>
        x === "package.json" ||
        x === "src" ||
        x.startsWith("src/") ||
        x === "node_modules" ||
        x.startsWith("node_modules/"),
    ),
    "Unexpected archive entry",
  );
  const config = fs.readFileSync(
    path.join(output, "win-unpacked/resources/app-update.yml"),
    "utf8",
  );
  assert(config.includes(feed), "Wrong update feed");
  const assets = fs
    .readdirSync(output)
    .filter(
      (n) =>
        n === "latest.yml" ||
        /^Hashrate-Manager-Setup-.*\.exe(\.blockmap)?$/.test(n),
    );
  assert(assets.includes("latest.yml"));
  const manifest = {
    version,
    feed,
    userDataIncluded: false,
    authenticodeSigned: false,
    dependencies: dirs.map((d) => path.relative(root, d)),
    archiveEntries: entries,
    assets: assets.map((name) => {
      const bytes = fs.readFileSync(path.join(output, name));
      return {
        name,
        bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  };
  fs.writeFileSync(
    path.join(output, "verification.json"),
    JSON.stringify(manifest, null, 2),
  );
  console.log(JSON.stringify({ output, version, assets }, null, 2));
}
release().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
