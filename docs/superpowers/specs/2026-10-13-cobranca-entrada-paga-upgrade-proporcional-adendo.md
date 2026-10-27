# Adendo aprovado — entrada paga e upgrade proporcional

Adendo aprovado pelo dono do produto no doc 146 (opção B, 15/10/2026). Revisa D-3 da especificação `2026-09-29-cobranca-do-revendedor-design.md`: upgrade após o teste aplica após confirmação da cobrança proporcional, mantendo a data de renovação; downgrade aplica na próxima renovação paga, sem crédito proporcional. O registro histórico da revisão original permanece na seção 3.8 da especificação canônica.

## Entrada paga

- No cadastro público, quando a cobrança está ligada, a pessoa pode selecionar um plano oferecido. O identificador escolhido é validado no servidor e novamente pelo gatilho que cria a assinatura.
- Plano com dias de teste positivos mantém o período de teste existente.
- Plano com zero dias de teste cria a assinatura como pendente e suspende a organização até o provedor confirmar o primeiro pagamento. A tolerância de renovação não abre o acesso inicial.
- Com a cobrança ligada, toda empresa nova nasce com plano: o escolhido ou, sem escolha, o padrão. Sem padrão e com plano oferecido, o cadastro sem escolha é recusado (`plano_obrigatorio`) e o "Entrar com Google" some do cadastro, porque não leva a escolha.
- Exceção (doc 146, opção B): o revendedor que não tem plano nenhum — nem padrão, nem oferecido — segue como antes. A empresa nasce isenta e o "Entrar com Google" aparece. A exceção não vale para quem oferece planos sem padrão, senão o Google e o cadastro sem escolha pulariam a entrada paga. O mesmo critério está no gatilho (`fn_trial_na_criacao_da_org`, migration 0679) e em `lib/cobranca/cadastro.ts`.
- Plano escolhido que deixou de ser oferecido (ou foi arquivado) entre o cadastro e a confirmação do e-mail vale como sem escolha: a empresa nasce no padrão.
- As portas sem seletor também seguem a regra: a aprovação de pedido (modo com aprovação) leva o plano escolhido no cadastro; a recuperação em `/get-started` mostra o seletor (é por onde sai quem entrou pelo Google na tela de login); a integração `/api/v1/tenants/provision` recebe `409 plano_obrigatorio`.
- Com a cobrança desligada, nada muda: nenhuma empresa nasce com plano.

## Troca de plano

- Upgrade pedido pela empresa durante período pago: calcular `round((preço_novo - preço_atual) × fração_restante_do_período)`, emitir cobrança avulsa pelo provedor e manter preço e limites atuais até a confirmação.
- Com confirmação, atualizar o preço recorrente da assinatura existente e aplicar o plano novo. Preservar o cliente e a âncora de renovação atual.
- Downgrade, diferença abaixo de R$ 5,00 e toda troca feita pelo dono mantêm o plano e os limites atuais até a próxima renovação paga; não há reembolso proporcional nesta entrega.
- A cobrança da diferença vale até o fim do período do cálculo: paga depois, o plano só vale na próxima renovação paga; não paga, é expirada no provedor.
- Se faltar início/fim confiável do período, recusar o cálculo e manter o plano atual. Nunca estimar o valor a partir da data de criação da organização.
- O painel compara preço, intervalo, assentos, canais e teto mensal de IA antes da confirmação e informa o valor estimado e a data da próxima renovação.

## Decisões aplicadas

- Upgrades são aplicados depois que o provedor confirma o pagamento proporcional (Pix/cartão/boleto); a renovação mantém a data atual.
- Downgrades não geram crédito e só entram na próxima renovação paga.
- A entrada paga inicial é separada da tolerância de renovação: acesso só abre após o primeiro pagamento confirmado quando o plano não oferece teste.
- A aplicação não devolve link se falhar ao persistir a referência do pagamento; tenta invalidar a cobrança criada. Com cobrança pendente, pedir outro plano a expira no provedor antes; já paga, recusa.
