# Distribuição macOS

O workflow `Build and publish macOS` gera DMG e ZIP para Apple Silicon (arm64) e Intel (x64) em runners macOS separados. Ele roda testes, verifica o conteúdo do ASAR e abre o aplicativo empacotado em um perfil temporário, com rede e envios financeiros bloqueados. A release só é publicada quando as duas arquiteturas passam.

Acione com `gh workflow run macos.yml --ref main -f version=0.2.41` depois de publicar o código correspondente à versão. O processo privado de publicação Windows dispara esse workflow para as futuras versões e exige igualdade dos fontes com o repositório público.

Links permanentes de download:

- https://github.com/beautiful-sea/hashrate-manager/releases/latest/download/Hashrate-Manager-mac-arm64.dmg
- https://github.com/beautiful-sea/hashrate-manager/releases/latest/download/Hashrate-Manager-mac-x64.dmg

Os nomes dos arquivos são estáveis e a release muda. O site consulta a versão macOS publicada, separadamente da versão Windows.

Não há certificado Apple configurado. Os pacotes usam assinatura local ad hoc, sem identidade Developer ID e sem notarização. O macOS pode impedir a abertura. A instalação não é testada com Gatekeeper em um Mac de usuário final. Não se deve anunciar esses pacotes como notarizados nem prometer atualização automática interna. O botão Atualizações para Mac abre a página de download, enquanto o atualizador Windows continua funcionando. Assinatura e notarização exigem credenciais Apple próprias, armazenadas em GitHub Secrets, nunca no código.
