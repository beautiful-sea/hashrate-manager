# Hashrate Manager

Aplicativo desktop em Electron para acompanhar operações na Hashsell e RentalHash, ajustar lances conforme a margem configurada e acompanhar resultados, saques e novas ordens automáticas.

## Desenvolvimento

Requer Node.js 22.12 ou superior e npm.

```sh
git clone https://github.com/beautiful-sea/hashrate-manager.git
cd hashrate-manager
npm ci
npm start
```

Faça login nas plataformas pelas abas do aplicativo. Configure a estratégia e acompanhe as leituras antes de ativar as operações automáticas. As operações utilizam saldo real; estimativas de duração, margem e lucro não garantem retorno.

## Verificações

```sh
npm test
npm run check
npm run lint
```

Os testes usam dados sintéticos. Não é necessário conectar uma conta real para executá-los.

## Pacote Windows

```sh
npm run release -- 0.2.41
```

O instalador e os arquivos do atualizador são gerados em `dist/updates/0.2.41`. Gerar o pacote não publica uma atualização. O feed configurado pertence à distribuição oficial; use infraestrutura própria para distribuir uma versão modificada.

## Dados e serviços

As sessões e configurações ficam no perfil local do usuário e não fazem parte deste repositório. O cliente de métricas anônimas está incluído; sua opção pode ser alterada em Configurações > Privacidade. O servidor de métricas, painel administrativo, credenciais e ferramentas de implantação não estão incluídos. A configuração pública de doações Pix faz parte do aplicativo.

## Documentação

- [Novas ordens automáticas](docs/NOVAS_ORDENS.md)
- [Relatórios](docs/RELATORIOS.md)
- [Padrões de lance](docs/PADROES_DE_LANCE.md)
- [Avisos do monitor](docs/AVISOS_DO_MONITOR.md)

## Licença

O projeto é público para consulta. Ainda não há uma licença de código aberto definida; a publicação não concede automaticamente direitos de redistribuição.

## Site e download

Landing page: https://beautiful-sea.github.io/hashrate-manager/

Download permanente: https://ecoesponja.com.br/hashrate-updates/Hashrate-Manager-Setup-latest-win-x64.exe

O site é publicado pelo GitHub Pages a partir de site/, usando o workflow de Pages. O instalador permanece no servidor oficial; a rotina privada de publicação atualiza o endereço permanente depois de validar os arquivos de cada versão. O rótulo da versão no site consulta o feed oficial e o download funciona mesmo se essa consulta falhar.
