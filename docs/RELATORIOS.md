# Relatórios de arbitragem

Abra Relatórios e use Atualizar relatório para conferir todo o histórico. A primeira importação requer login nas duas plataformas e pode levar alguns minutos; o monitor de lances tem prioridade. As atualizações automáticas consultam hoje e ontem a cada 15 minutos e o histórico completo diariamente, com o aplicativo aberto.

Os dados ficam em %APPDATA%/Hashrate Manager/reports.json, separados pelo par de contas autenticadas. Não são enviados à VPS. Trocar de conta exige nova identificação e não mistura históricos. Os arquivos do ZIP não incluem seus dados.

Lucro = créditos horários RentalHash - consumo Hashsell - taxas efetivamente lançadas. Recargas em USD são depósitos, inclusive Pix/USDT. Reservas/devoluções são transferências. A taxa configurada para lances não é descontada novamente. Estornos desconhecidos ficam pendentes.

Teste manual:
1. Selecione um dia encerrado em Personalizado; compare Receita com a soma dos créditos horários da RentalHash. O resumo diário não é somado novamente.
2. Clique Ver lançamentos; compare Consumo e Taxas com os lançamentos correspondentes da carteira Hashsell.
3. Confira Lucro = Receita - Consumo - Taxas e Margem = Lucro / Receita. Depósitos não reduzem o resultado.
4. Troque Hoje, Ontem, 7 dias, Mês e Todo o histórico. Hoje deve estar Parcial. A tabela agrupa receita e consumo pelo fechamento da hora trabalhada em America/Sao_Paulo. Horários originais são preservados; não há promessa de lucro horário.
5. Atualize duas vezes: linhas e totais não devem duplicar. Exportar CSV preserva os valores originais e suas classificações.
6. Em falha de login/coleta, veja a mensagem. Snapshots completos anteriores permanecem no disco e reaparecem após identificar as mesmas contas. Dados com mais de 30 minutos recebem aviso.

O monitoramento e os ajustes de lances iniciam ligados ao abrir o app, conforme configuração padrão solicitada. Os relatórios não acionam lances. O computador deve permanecer ligado e conectado.

A conferência de resumos respeita o arredondamento observado: créditos exibidos com quatro casas e resumo diário com duas. A tolerância é somente a soma dos limites dessas precisões; os créditos não são alterados.

## Saques

A tela Saques mostra a média de espera, o mais rápido, os pendentes, uma linha do tempo e a lista de pagamentos. A média usa pedido até conclusão dos saques com datas confirmadas; cancelados e falhas não entram. O tempo restante é estimado pela média de todo o histórico. Quando ultrapassado, aparece quanto está acima da média; isso não significa que o saque já concluiu. Sem datas suficientes, a estimativa fica indisponível. Atualiza junto com a importação automática a cada 15 minutos, com o app aberto. A contagem na tela avança automaticamente. Detalhes e filtros permanecem abertos enquanto o usuário lê. Em falha de exportação, preserva a média anterior e informa a situação. Nenhum saque é solicitado ou cancelado por essa tela.

## Datas de apuração

A RentalHash identifica créditos pelo início da hora trabalhada. Para comparar com a Hashsell, o relatório usa o fechamento dessa hora. Consumos e taxas de consumo de ordens encerradas no meio da hora entram no mesmo fechamento horário. Depósitos, transferências e taxas de saque mantêm suas datas originais. Valores e horários armazenados não são alterados. O CSV conserva a data original e inclui data de apuração e fechamento. Filtros, gráfico e previsão usam a mesma regra; conferências antigas dos dias redistribuídos deixam de ser consideradas válidas.
