# Banco externo MySQL pela tela — instalação real (19/10/2026)

**Tipo:** HISTÓRICA (captura manual pela tela, recortada só na área da funcionalidade).

**Contra qual código:** imagem construída a partir do head do #2639, `208e55ad4` (traz #2638 e #2640 embaixo), rodando numa VPS com o `baseline.sql` desse commit aplicado. Banco do outro lado: MySQL 8.4 descartável, com dados fictícios (`loja_teste`: 3 produtos, 2 pedidos).

| Arquivo | O que prova |
|---|---|
| `grade-le-o-mysql.png` | Depois de salvar a conexão MySQL e liberar só `produtos`, a grade lê as linhas do MySQL (acento correto em "Boné"). |
| `aviso-de-usuario-que-escreve.png` | "Testar" com um usuário que tem INSERT/UPDATE: selos "Conectada" e "MySQL" e o aviso de que o usuário pode escrever. |

**Não medido pela tela:** o agente consultando o MySQL numa conversa. Isso é coberto pelo teste contra MySQL 8 de verdade do #2640.
