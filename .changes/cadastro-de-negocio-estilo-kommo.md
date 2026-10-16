---
impacto: capacidade_nova
secao: adicionado
titulo: O cadastro de negócio ganha os campos do estilo Kommo — tipo de cliente, setor, orçamento, contrato e empresa
---

O diálogo "Novo Lead" passa a mostrar os mesmos campos que o painel do negócio já editava depois de criado: Tipo de cliente, Setor do cliente, Orçamento, Método de pagamento, Objetivo do cliente, Número e Data de contrato, Forma de pagamento e Arquivo (como link) — e uma seção de Empresa com nome, telefone comercial, e-mail comercial e cargo. Nada disso precisa de configuração: os campos já nascem prontos nos dois pipelines existentes, guardados em `crm_pipelines.settings.fields`, o mesmo catálogo que a edição do negócio já usava.

Dois conserto junto: o schema de criação de negócio (`POST /api/v1/leads`) não aceitava `custom_fields` — a tela enviava e o servidor descartava em silêncio antes mesmo de chegar à gravação, que já sabia lidar com o campo. Agora os dois lados usam o mesmo schema.

Não há tela para adicionar ou remover esses campos ainda — a lista é fixa, igual ao pedido. Arquivo é um link (cole o endereço de onde o arquivo está hospedado), não um upload de verdade: construir isso é um passo à parte, ainda não feito.
