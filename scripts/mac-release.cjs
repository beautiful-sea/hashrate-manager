const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
async function release() {
  assert.equal(
    process.platform,
    "darwin",
    "Build macOS packages on a macOS runner",
  );
  const version = process.argv[2];
  const arch = process.argv[3] || process.arch;
  assert(/^\d+\.\d+\.\d+$/.test(version), "A stable version is required");
  assert(["arm64", "x64"].includes(arch));
  const metadata = require("../package.json");
  const output = path.join(root, "dist", "mac", version, arch);
  assert(!fs.existsSync(output), "Never overwrite a release");
  const project = path.join(root, "artifacts", "mac", version, arch, "app");
  fs.mkdirSync(project, { recursive: true });
  fs.cpSync(path.join(root, "src"), path.join(project, "src"), {
    recursive: true,
  });
  const listed = spawnSync(
    "npm",
    ["ls", "--omit=dev", "--all", "--parseable"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stderr);
  const dependencies = listed.stdout.trim().split(/\r?\n/).slice(1);
  for (const dir of dependencies) {
    const relative = path.relative(root, dir);
    assert(
      relative.startsWith("node_modules" + path.sep) &&
        !relative.split(path.sep).includes(".."),
    );
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
        macAutoUpdates: false,
      },
      null,
      2,
    ),
  );
  const icon = path.join(project, "..", "icon-mac.png");
  assert.equal(
    spawnSync(
      "sips",
      [
        "-z",
        "1024",
        "1024",
        path.join(root, "src/assets/icon.png"),
        "--out",
        icon,
      ],
      { stdio: "inherit" },
    ).status,
    0,
  );
  const { build, Platform, Arch } = require("electron-builder");
  const feed =
    "https://github.com/beautiful-sea/hashrate-manager/releases/latest/download/";
  await build({
    projectDir: project,
    targets: Platform.MAC.createTarget(["dmg", "zip"], Arch[arch]),
    publish: "never",
    config: {
      appId: "com.lg.hashrate-manager",
      productName: "Hashrate Manager",
      electronVersion: metadata.devDependencies.electron,
      electronDist: path.join(root, "node_modules/electron/dist"),
      directories: { output },
      files: ["src/**/*", "package.json", "node_modules/**/*"],
      npmRebuild: false,
      mac: {
        target: ["dmg", "zip"],
        icon,
        identity: "-",
        hardenedRuntime: false,
        gatekeeperAssess: false,
        notarize: false,
        category: "public.app-category.finance",
        artifactName:
          "Hashrate-Manager-mac-" +
          arch +
          "." +
          String.fromCharCode(36) +
          "{ext}",
      },
      publish: { provider: "generic", url: feed },
    },
  });
  const appDir = path.join(
    output,
    arch === "arm64" ? "mac-arm64" : "mac",
    "Hashrate Manager.app",
  );
  const archive = path.join(appDir, "Contents/Resources/app.asar");
  const asar = await import("@electron/asar");
  const entries = asar.listPackage(archive).map((x) => x.replace(/^\//, ""));
  assert(
    entries.every(
      (x) =>
        x === "package.json" ||
        x === "src" ||
        x.startsWith("src/") ||
        x === "node_modules" ||
        x.startsWith("node_modules/"),
    ),
    "Unexpected package entry",
  );
  assert(
    entries.every(
      (x) =>
        !/(^|\/)(Cookies|Partitions|Cache|state\.json|reports\.json|analytics\.json|server|artifacts|\.env)(\/|$)/i.test(
          x,
        ),
    ),
    "Private profile or administration in package",
  );
  const packed = JSON.parse(
    asar.extractFile(archive, "package.json").toString(),
  );
  assert.equal(packed.version, version);
  assert.equal(packed.macAutoUpdates, false);
  function verify(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) verify(file);
      else {
        const relative = path.relative(root, file).split(path.sep).join("/");
        assert.deepEqual(
          asar.extractFile(archive, relative),
          fs.readFileSync(file),
        );
      }
    }
  }
  verify(path.join(root, "src"));
  const smokeEnv = { ...process.env };
  delete smokeEnv.ELECTRON_RUN_AS_NODE;
  const smoke = spawnSync(
    path.join(appDir, "Contents/MacOS/Hashrate Manager"),
    ["--smoke"],
    { env: smokeEnv, encoding: "utf8", timeout: 60000 },
  );
  console.log(smoke.stdout);
  console.error(smoke.stderr);
  assert.equal(smoke.status, 0, "Packaged app failed its isolated smoke test");
  assert(smoke.stdout.includes("SMOKE PASS"));
  const channel = path.join(output, "latest-mac.yml");
  fs.renameSync(channel, path.join(output, "latest-mac-" + arch + ".yml"));
  const assets = fs
    .readdirSync(output)
    .filter(
      (name) =>
        name === "latest-mac-" + arch + ".yml" ||
        new RegExp(
          "^Hashrate-Manager-mac-" + arch + "\\.(dmg|zip)(\\.blockmap)?$",
        ).test(name),
    );
  assert(assets.includes("Hashrate-Manager-mac-" + arch + ".dmg"));
  assert(assets.includes("Hashrate-Manager-mac-" + arch + ".zip"));
  const report = {
    version,
    arch,
    sourceCommit: process.env.GITHUB_SHA || null,
    userDataIncluded: false,
    appleDeveloperSigned: false,
    notarized: false,
    packagedSmokePassed: true,
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
    path.join(output, "verification-mac-" + arch + ".json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ output, version, arch, assets }, null, 2));
}
release().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
