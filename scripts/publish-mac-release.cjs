const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  { spawnSync } = require("node:child_process");
const version = process.env.RELEASE_VERSION;
assert(/^\d+\.\d+\.\d+$/.test(version));
const root = path.resolve(process.argv[2]);
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
}
const all = walk(root),
  files = [];
const architectures = new Set();
for (const file of all.filter((f) =>
  /verification-mac-(arm64|x64)\.json$/.test(f),
)) {
  const report = JSON.parse(fs.readFileSync(file));
  assert.equal(report.version, version);
  assert.equal(report.sourceCommit, process.env.GITHUB_SHA);
  assert.equal(report.userDataIncluded, false);
  assert.equal(report.packagedSmokePassed, true);
  assert(!architectures.has(report.arch));
  architectures.add(report.arch);
  for (const asset of report.assets) {
    assert(/^[A-Za-z0-9._-]+$/.test(asset.name));
    const p = path.join(path.dirname(file), asset.name);
    const bytes = fs.readFileSync(p);
    assert.equal(bytes.length, asset.bytes);
    assert.equal(
      crypto.createHash("sha256").update(bytes).digest("hex"),
      asset.sha256,
    );
    files.push(p);
  }
  files.push(file);
}
assert(architectures.has("arm64") && architectures.has("x64"));
assert.equal(
  new Set(files.map((f) => path.basename(f))).size,
  files.length,
  "Duplicate release asset names",
);
function run(args) {
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) throw Error(r.stderr || r.stdout);
  return r.stdout;
}
const tag = "v" + version;
const existing = spawnSync(
  "gh",
  ["release", "view", tag, "--json", "isDraft"],
  { encoding: "utf8" },
);
if (existing.status === 0) {
  assert(
    JSON.parse(existing.stdout).isDraft,
    "Never replace an already published release",
  );
} else {
  run([
    "release",
    "create",
    tag,
    "--draft",
    "--target",
    process.env.GITHUB_SHA,
    "--title",
    "Hashrate Manager " + version + " — macOS",
    "--notes",
    "Instaladores macOS para Apple Silicon e Intel. Aplicativo gratuito; perfil e sessões pessoais não estão incluídos. Pacotes validados com testes e execução isolada no macOS. Esta versão não tem assinatura Developer ID nem notarização Apple. Atualizações desta distribuição são baixadas pelo site.",
  ]);
}
run(["release", "upload", tag, ...files, "--clobber"]);
run(["release", "edit", tag, "--draft=false", "--latest"]);
console.log("Published macOS " + version + " for arm64 and x64.");
