const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const infoPath = process.argv[2];
assert(infoPath, "Informe o arquivo verificacao.json do build.");
const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
const target = fs.mkdtempSync(
  path.join(os.tmpdir(), "hashrate-installer-test-"),
);
function digest(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}
function run(command, args, timeout = 180000) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    timeout,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Falha: ${path.basename(command)}`);
}
assert.equal(digest(info.installer), info.sha256);
console.log("Instalando em pasta temporária, sem atalhos ou registro...");
// /D must be last. TESTMODE changes registration only, never payload extraction.
run(info.installer, ["/S", "/TESTMODE", `/D=${target}`]);
for (const item of info.files) {
  assert.equal(digest(path.join(target, item.path)), item.sha256, item.path);
}
const expected = new Set([
  ...info.files.map((item) => item.path),
  "Desinstalar.exe",
]);
function files(directory, relative = "") {
  return fs
    .readdirSync(path.join(directory, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const name = path.posix.join(relative, entry.name);
      return entry.isDirectory() ? files(directory, name) : [name];
    });
}
assert.deepEqual(files(target).sort(), [...expected].sort());
console.log(
  `Extração íntegra: ${info.files.length} arquivos, sem dados de usuário.`,
);
run(process.execPath, [path.join(__dirname, "verify-package.cjs"), target]);

const marker = path.join(target, "dados-do-usuario-preservar.txt");
const markerContent = "Dado de teste. Deve sobreviver à desinstalação.";
fs.writeFileSync(marker, markerContent);
const cache = path.join(target, "cache-de-teste");
fs.mkdirSync(cache);
fs.writeFileSync(path.join(cache, "preservar.txt"), markerContent);
console.log("Conferindo desinstalação seletiva e preservação de dados...");
run(path.join(target, "Desinstalar.exe"), ["/S", "/TESTMODE", `_?=${target}`]);
for (const item of info.files) {
  assert(
    !fs.existsSync(path.join(target, item.path)),
    `Arquivo do programa permaneceu: ${item.path}`,
  );
}
assert.equal(fs.readFileSync(marker, "utf8"), markerContent);
assert.equal(
  fs.readFileSync(path.join(cache, "preservar.txt"), "utf8"),
  markerContent,
);
const result = {
  installerSha256: info.sha256,
  installationVerified: true,
  packagedSmokePassed: true,
  domFlowPassed: true,
  uninstallPreservesUnknownFiles: true,
  realProfileUsed: false,
  testDirectory: target,
  checkedAt: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(path.dirname(infoPath), "teste-instalacao.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  "INSTALADOR PASS: instalação, inicialização, DOM e desinstalação isolados.",
);
