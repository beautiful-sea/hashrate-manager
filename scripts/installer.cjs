const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const metadata = require("../package.json");
const runtime = path.resolve(
  root,
  process.argv[2] ||
    "dist/compartilhar-previsao-capital-em-transferencia-v2/HashrateManager",
);
const compilerRoot = path.resolve(
  process.env.HASHRATE_NSIS_DIR ||
    path.join(root, "artifacts/installer-tools/nsis-3.12/nsis-bundle/windows"),
);
const compiler = path.join(compilerRoot, "makensis.exe");
const buildId = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.join(root, "dist", "instalador", buildId);
const staging = path.join(root, "artifacts", "installer", buildId);
const payload = path.join(staging, "payload");
const app = path.join(staging, "app");
const output = path.join(
  outputDir,
  `Hashrate-Manager-Setup-${metadata.version}-win-x64.exe`,
);
const runtimeFiles = [
  "HashrateManager.exe",
  "chrome_100_percent.pak",
  "chrome_200_percent.pak",
  "d3dcompiler_47.dll",
  "dxcompiler.dll",
  "dxil.dll",
  "ffmpeg.dll",
  "icudtl.dat",
  "LICENSE",
  "LICENSES.chromium.html",
  "resources.pak",
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "version",
  "vk_swiftshader_icd.json",
  "vk_swiftshader.dll",
  "vulkan-1.dll",
  "locales/en-US.pak",
  "locales/pt-BR.pak",
];

function digest(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function listFiles(directory, relative = "") {
  return fs
    .readdirSync(path.join(directory, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const name = path.posix.join(relative, entry.name);
      assert(!entry.isSymbolicLink(), `Link não permitido: ${name}`);
      return entry.isDirectory() ? listFiles(directory, name) : [name];
    });
}

function copy(relative, from, to) {
  const source = path.join(from, relative);
  assert(fs.lstatSync(source).isFile(), `Arquivo ausente: ${relative}`);
  const destination = path.join(to, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function nsis(value) {
  return value
    .replaceAll("$", "$$")
    .replaceAll('"', '$\\"')
    .replaceAll("/", "\\");
}

(async () => {
  assert(
    fs.existsSync(compiler),
    "Compilador NSIS ausente. Defina HASHRATE_NSIS_DIR para o compilador portátil verificado.",
  );
  assert.equal(
    fs.readFileSync(path.join(runtime, "version"), "utf8").trim(),
    metadata.devDependencies.electron,
  );
  assert(
    !fs.existsSync(staging) && !fs.existsSync(outputDir),
    "Não sobrescrever uma entrega existente.",
  );
  fs.mkdirSync(payload, { recursive: true });
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  // Positive allowlist: never traverse project artifacts, AppData, or browser profiles.
  for (const relative of runtimeFiles) copy(relative, runtime, payload);
  for (const relative of listFiles(path.join(root, "src"))) {
    assert(
      /\.(cjs|js|html|css|svg|png|ico)$/.test(relative),
      `Tipo inesperado em src: ${relative}`,
    );
    copy(`src/${relative}`, root, app);
  }
  for (const relative of listFiles(
    path.join(root, "node_modules/decimal.js"),
  )) {
    copy(`node_modules/decimal.js/${relative}`, root, app);
  }
  fs.writeFileSync(
    path.join(app, "package.json"),
    JSON.stringify(
      {
        name: metadata.name,
        productName: metadata.productName,
        version: metadata.version,
        description: metadata.description,
        main: metadata.main,
        private: true,
        license: metadata.license,
        dependencies: metadata.dependencies,
      },
      null,
      2,
    ) + "\n",
  );

  const { createPackage, listPackage, extractFile, statFile } =
    await import("@electron/asar");
  const archive = path.join(payload, "resources/app.asar");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  await createPackage(app, archive);
  const archiveFiles = [];
  for (const item of listPackage(archive)) {
    const relative = item.replace(/^[\\/]+/, "").replaceAll("\\", "/");
    assert(
      relative === "package.json" ||
        relative === "src" ||
        relative.startsWith("src/") ||
        relative === "node_modules" ||
        relative === "node_modules/decimal.js" ||
        relative.startsWith("node_modules/decimal.js/"),
      `Entrada proibida no ASAR: ${relative}`,
    );
    if (statFile(archive, path.normalize(relative)).files) continue;
    archiveFiles.push(relative);
    if (relative.startsWith("src/")) {
      const bytes = extractFile(archive, path.normalize(relative));
      assert.deepEqual(bytes, fs.readFileSync(path.join(root, relative)));
      assert(
        !/ecoesponja\.com\.br|\bC:[\\/]Users[\\/]|\bE:[\\/]laragon[\\/]/i.test(
          bytes.toString(),
        ),
        `Identificação pessoal inesperada: ${relative}`,
      );
    }
  }
  const shippedMetadata = JSON.parse(extractFile(archive, "package.json"));
  assert(
    !shippedMetadata.author &&
      !shippedMetadata.scripts &&
      !shippedMetadata.devDependencies,
  );

  fs.writeFileSync(
    path.join(payload, "LEIA-ME.txt"),
    [
      "Hashrate Manager — Windows 64 bits",
      "",
      "Abra o instalador e siga as etapas. Não precisa instalar Node.js.",
      "O pacote não inclui contas, logins, senhas, sessões, histórico ou cache do remetente.",
      "Entre nas suas próprias contas Hashsell e RentalHash pelo aplicativo.",
      "",
      "Confira a margem, as taxas e os custos em Configurações antes de entrar nas contas.",
      "Monitoramento e ajustes automáticos iniciam ligados por padrão ao abrir. Após o login, lances reais das ordens ativas podem ser alterados automaticamente. Os controles do painel permitem pausar o monitor e desligar os ajustes.",
      "",
      "Relatórios são importados e atualizados automaticamente. Escolha o período, veja a composição dos valores e use Exportar CSV. Receita menos consumo e taxas corresponde ao lucro; depósitos ficam separados. O dia atual é parcial.",
      "",
      "Saques: acompanhe a média histórica, a duração de cada pedido e o tempo restante estimado dos pendentes. A tela atualiza automaticamente; a estimativa pode ser ultrapassada.",
      "",
      "Mantenha o computador ligado, conectado e sem suspensão para monitorar continuamente.",
      "Dados e sessões são salvos localmente no perfil do usuário do Windows. Desinstalar remove o programa e preserva os dados locais.",
      "",
    ].join("\r\n"),
  );

  // Neutral product metadata: the local portable build may include its author's initials.
  const { resedit } = await import("@electron/packager/resedit");
  await resedit(path.join(payload, "HashrateManager.exe"), {
    productName: metadata.productName,
    productVersion: metadata.version,
    fileVersion: metadata.version,
    legalCopyright: metadata.productName,
    win32Metadata: {
      CompanyName: metadata.productName,
      FileDescription: metadata.productName,
      InternalName: "HashrateManager",
      OriginalFilename: "HashrateManager.exe",
    },
  });
  let files = listFiles(payload).sort();
  const manifest = {
    product: metadata.productName,
    version: metadata.version,
    platform: "win32-x64",
    userDataIncluded: false,
    files: files.map((relative) => ({
      path: relative,
      bytes: fs.statSync(path.join(payload, relative)).size,
      sha256: digest(path.join(payload, relative)),
    })),
  };
  fs.writeFileSync(
    path.join(payload, "manifesto.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  files = listFiles(payload).sort();
  const allowed = new Set([
    ...runtimeFiles,
    "resources/app.asar",
    "LEIA-ME.txt",
    "manifesto.json",
  ]);
  assert.deepEqual(files, [...allowed].sort());
  const payloadBytes = files.reduce(
    (sum, relative) => sum + fs.statSync(path.join(payload, relative)).size,
    0,
  );

  let previousDirectory;
  const installLines = [];
  for (const relative of files) {
    const directory = path.posix.dirname(relative);
    if (directory !== previousDirectory) {
      installLines.push(
        `SetOutPath "$INSTDIR${directory === "." ? "" : "\\" + nsis(directory)}"`,
      );
      previousDirectory = directory;
    }
    installLines.push(`File "${nsis(path.join(payload, relative))}"`);
  }
  const directories = [
    ...new Set(
      files
        .map((relative) => path.posix.dirname(relative))
        .filter((dir) => dir !== "."),
    ),
  ].sort((a, b) => b.length - a.length);
  const uninstallLines = files
    .map((relative) => `Delete "$INSTDIR\\${nsis(relative)}"`)
    .concat(
      directories.map((directory) => `RMDir "$INSTDIR\\${nsis(directory)}"`),
    );
  const installInclude = path.join(staging, "payload.nsh");
  const uninstallInclude = path.join(staging, "uninstall.nsh");
  fs.writeFileSync(installInclude, installLines.join("\n") + "\n");
  fs.writeFileSync(uninstallInclude, uninstallLines.join("\n") + "\n");
  console.log(
    `Payload auditado: ${files.length} arquivos, ${archiveFiles.length} entradas no ASAR, ${(payloadBytes / 1024 / 1024).toFixed(1)} MiB. Nenhum perfil incluído.`,
  );
  console.log("Comprimindo instalador...");
  const result = spawnSync(
    compiler,
    [
      "-V3",
      "-WX",
      "-INPUTCHARSET",
      "UTF8",
      `-DOUTPUT=${output}`,
      `-DVERSION=${metadata.version}`,
      `-DPAYLOAD_INCLUDE=${installInclude}`,
      `-DUNINSTALL_INCLUDE=${uninstallInclude}`,
      `-DINSTALLED_KB=${Math.ceil(payloadBytes / 1024)}`,
      path.join(__dirname, "installer.nsi"),
    ],
    {
      env: { ...process.env, NSISDIR: compilerRoot },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "Falha ao compilar instalador.");
  const info = {
    installer: output,
    payload,
    manifest: path.join(payload, "manifesto.json"),
    bytes: fs.statSync(output).size,
    sha256: digest(output),
    payloadBytes,
    archiveEntries: archiveFiles,
    files: files.map((relative) => ({
      path: relative,
      sha256: digest(path.join(payload, relative)),
    })),
  };
  fs.writeFileSync(
    path.join(outputDir, "verificacao.json"),
    JSON.stringify(info, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(outputDir, "SHA256.txt"),
    `${info.sha256}  ${path.basename(output)}\n`,
  );
  console.log(
    JSON.stringify(
      { installer: output, bytes: info.bytes, sha256: info.sha256 },
      null,
      2,
    ),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
