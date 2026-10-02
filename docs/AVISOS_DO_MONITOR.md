# Avisos e recuperação automática
Falhas temporárias exibem “Atualizando os dados das plataformas” e não solicitam acesso ao histórico. O monitor mantém o agendamento e retoma os ajustes quando obtém leituras válidas.
Envios comprovadamente não realizados adiam apenas aquela ordem por dois minutos, mantendo o modo automático. A próxima tentativa refaz leitura, decisão e validação. Tentativas incertas permanecem em conferência sem reenvio.
Uma sessão expirada ainda solicita login, pois o app não pode renovar credenciais sozinho. Pausa manual permanece respeitada. Nunca afirmar que os ajustes estão funcionando quando faltam dados válidos.
