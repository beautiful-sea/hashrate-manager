# Padrões de lance — 0.2.11

Incremento: US$ 0,01 / PH/s/dia. Folga sobre corte: US$ 0,05 / PH/s/dia.

O alvo é corte mais folga, arredondado para cima no incremento. Corte 39,4121 gera alvo 39,47. O teto da margem é arredondado para baixo; por exemplo, receita 43 e margem 5% com taxa 3% resultam em teto 39,66. Alvo acima do teto continua bloqueado. Ordens já entregando não recebem aumentos desnecessários apenas para perseguir a própria linha de corte.

Isso dá mais distância para pequenas oscilações entre leituras; não garante entrega contínua se o corte saltar ou superar o teto. Intervalo de leitura, cooldown e margem permanecem iguais.

Na abertura após atualizar, apenas perfis anteriores sem revisão 2 e com o par exato tick=0.0001 e buffer=0.001 recebem os novos valores. Qualquer outro par permanece personalizado. Um backup do state.json original fica no mesmo diretório do perfil, com sufixo before-bid-defaults-v2. Commit atômico preserva pendências, memória, histórico, margem e modo. A migração não envia ajustes nem resolve pendências. Revisão gravada impede substituir de novo o par antigo se o usuário escolher esses valores depois.

Validação: 183 testes Node; migração com backup e preservação de pendências; motor com teto, arredondamento e compatibilidade de incrementos personalizados. Smoke Electron DOM com padrões novos enviou 39,46 para corte 39,41 e reduziu a 39,25 para corte 39,20, com dupla confirmação, releitura, bloqueio de payload 1000x e pausa. Só backend local controlado, zero solicitações externas. Pacote final validado. Evidências artifacts/bid-defaults-*.log.
