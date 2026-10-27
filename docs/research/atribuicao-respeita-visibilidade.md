# Atribuição respeita visibilidade

A atribuição definer resolve e bloqueia a conversa por organização. Antes do UPDATE/RETURNING, verifica o mesmo escopo da leitura com o responsável atual da linha, preservando o lock e a atribuição/evento na mesma transação.

Dono e fila permitida continuam operando. Gestores/administradores mantêm visão ampla; visibility_mode=all conserva compartilhamento explícito. Conversa fora do escopo responde zero linhas, igual a conversa inexistente (migration 0685); o claim perdido segue com zero linhas. Worker service-role sem auth.uid continua operando como antes. A assinatura existente e tipos não mudam.

A rota responde 404 (transferência) ou 409 (assumir), sem publicar atividade/auditoria/notificação de transferência concluída. Desde a 0685 a leitura de `event_log` também segue a visibilidade da conversa para eventos ligados a ela — a conversa do evento é resolvida pelo entity_id (conversation/conversation_note), por payload.conversation_id, ou pelo ref_id do aviso da Central; valor sem forma de uuid não restringe (segue o pertencimento à organização), uuid que não aponta para conversa da organização fica oculto ao atendente, e viewer/manager/admin/administrador da plataforma leem a organização inteira; permissões do destinatário e canal não mudam.

Validação direta de banco para modos own, own_and_unassigned e all, gestor/admin, transferência do dono, disputa e preservação de silêncio/auditoria/nome. Teste de rota para 404 e organização obtida da sessão. Não substitui auditoria de todas as rotas ou políticas do produto.
