---
impacto: capacidade_nova
secao: adicionado
titulo: Sistema atualizado para a versão 1.94.0 do upstream, com todo o trabalho desta instalação preservado
---

Sincronizado com a v1.94.0 do projeto original (`melgarafael/DeskcommCRM`) — 15 versões à frente da v1.79.0 anterior, trazendo recursos novos do upstream (segunda visão em lista do pipeline, agendamento recorrente, conector MySQL, servidor MCP externo, entre outros) sem perder nada construído nesta instalação: o cadastro de negócio estilo Kommo, o dossiê em duas colunas, o comentário manual na linha do tempo, a integração com a api4com e o nome "Pipeline" no menu continuam exatamente como estavam.

Onde o upstream mexeu na MESMA tela que esta instalação já tinha customizado, a reconciliação seguiu um critério simples: quando o upstream resolveu o mesmo problema de um jeito mais completo (o seletor de pipeline no cabeçalho, por exemplo), a versão dele entrou no lugar da nossa; quando a mudança era uma decisão de produto específica desta instalação (o layout em duas colunas do dossiê, a volta do nome "Pipeline"), ela foi mantida por cima do redesenho do upstream, com as duas razões documentadas lado a lado no código.

Nada para configurar. Quem usa o sistema não vê diferença nas telas que já conhecia — só ganha o que o upstream trouxe de novo.
