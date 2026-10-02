# Novas ordens automáticas

Em Configurações, abra **Novas ordens automáticas**. Faça login na Hashsell e clique em **Carregar pools**. Escolha um pool já cadastrado na plataforma, a potência, o saldo mínimo e o valor por ordem (fixo ou todo o saldo disponível). Marque a criação automática e salve. Ligue os ajustes automáticos na visão geral.

A opção começa desligada. O mínimo da plataforma é US$ 5 por ordem e 1 PH/s. Por padrão o app espera as ordens ativas terminarem; marque a opção correspondente se desejar várias ordens. Com essa opção ligada, novas ordens podem consumir sucessivamente o saldo disponível.

O lance respeita a margem configurada. A criação usa os campos e botões do próprio site, com confirmação dos valores antes do envio. O app confere a nova ordem automaticamente e continua priorizando ajustes das ordens existentes. Um envio sem resposta não é reenviado: primeiro é conferido na plataforma.

Teste local: a versão foi validada com servidor isolado, sem criar ordens reais. Configure os valores antes de ativar. Não foi publicada no servidor de atualizações.

Para definir pelo tempo, escolha **Duração desejada** e informe as horas. O app calcula o limite de potência com o valor destinado à ordem, o lance e a taxa de consumo configurada, arredondando para quatro casas. A duração é estimada para entrega plena ao lance atual; menor entrega ou futuros ajustes de lance alteram o tempo. Se a potência calculada for menor que 1 PH/s, a criação aguarda aumento do valor ou redução da duração.
