/**
 * `send_message` recusa repetição quase idêntica do que JÁ saiu no turno
 * (regressão de segurança do gate near-dup).
 *
 * Defeito observado em produção: uma única pergunta levou 4 respostas — 3 do
 * caminho de recuperação do "turno mudo" (o modelo chamou `send_message` 3× com
 * corpos quase idênticos) e 1 de um follow-up de promessa. O contrato é UMA
 * resposta adequada e completa por turno; repetição imediata é redundância.
 *
 * Mesma técnica de `send-message-corpo-vazio.test.ts`: o `execute` é uma closure
 * dentro do turno, sem ponto de injeção barato, então o teste prende o `if` no
 * caminho que fala no canal — presença, ordem, e o fato de a recusa devolver erro
 * de ENSINO (`ok:false`) e NUNCA marcar nada como entregue (sem ledger row).
 *
 * Também pinça, aqui, as quatro mudanças da revisão do #2996:
 *  - item 1: seeding com `!preview &&` (o `liveJob()` do preview lança);
 *  - item 6: `checar` → `reservar` síncronos antes do primeiro `await`, `promover`
 *    no aceite e `liberar` em todo caminho de não-envio (finally incluso);
 *  - item 6 (revisão): a janela entre a reserva e a cadeia fica sob `try/catch`
 *    que libera e re-lança intacto — exceção pré-cadeia não deixa reserva órfã;
 *  - item 7: a supressão emite `send_vetoed` na timeline, sem conteúdo de mensagem.
 *
 * A régua pura de similaridade (normalização + Dice + exceções) vive em
 * `near-dup.test.ts`; a janela de banco em `memoria-envio-janela.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { criarTravaDeDuplicata } from "@/lib/agent-engine/agent/near-dup";

const FONTE = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
const corpoDoSend = (() => {
  const i = FONTE.indexOf("send_message: tool({");
  const j = FONTE.indexOf("update_lead_state: tool({", i);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return FONTE.slice(i, j);
})();

describe("send_message nunca reenvia repetição do mesmo turno", () => {
  it("o execute recusa duplicata próxima com erro de ENSINO (ok:false, nunca entregue)", () => {
    // A recusa é um `ok:false` com code distinto — mesma forma de corpo_vazio/
    // resposta_obsoleta. Não há `outcomes.push`, ledger nem chamada de canal
    // dentro do ramo: nada é marcado como entregue.
    expect(corpoDoSend).toMatch(
      /const corpoRepetido = dupTrava\.checar\(body\);\s*if \(corpoRepetido !== null\) \{\s*runLog\.info\('duplicate_suppressed/,
    );
    expect(corpoDoSend).toContain("code: 'duplicate_suppressed'");
    expect(corpoDoSend).toMatch(/code: 'duplicate_suppressed',\s*message:/);
  });

  it("a recusa vem antes do teto de envios — duplicata não gasta a cota do turno", () => {
    const dup = corpoDoSend.indexOf("'duplicate_suppressed'");
    const teto = corpoDoSend.indexOf("'max_sends_per_turn'");
    expect(dup).toBeGreaterThan(-1);
    expect(teto).toBeGreaterThan(-1);
    expect(dup).toBeLessThan(teto);
  });

  it("corpo vazio é checado primeiro — ordem vazio → duplicata → cota", () => {
    const vazio = corpoDoSend.indexOf("'corpo_vazio'");
    const dup = corpoDoSend.indexOf("'duplicate_suppressed'");
    expect(vazio).toBeGreaterThan(-1);
    expect(dup).toBeGreaterThan(vazio);
  });
});

describe("a memória de duplicata só cresce com envio REAL e é semeada por histórico", () => {
  it("candidato aceito (sent/already_sent/queued) PROMOVE de em-voo para a memória", () => {
    // O `promover` está DEPOIS de `outcomes.push(outcome)` e sob os kinds que
    // saíram — transição exatamente uma vez (em-voo → aceitos), nunca dupla.
    expect(FONTE).toMatch(
      /if \(outcome\.kind === 'sent' \|\| outcome\.kind === 'already_sent' \|\| outcome\.kind === 'queued'\) \{\s*dupTrava\.promover\(body\);/,
    );
  });

  it("o turno semeia a memória com o que já saiu desde a última inbound (cobre follow-up)", () => {
    // Janela "desde a última inbound": vazia num turno fresco (não suprime
    // resposta legítima), cheia num follow-up que re-responde conversa calada.
    expect(FONTE).toContain("corposEnviadosDesdeUltimaInbound(");
    expect(FONTE).toMatch(/dupTrava\.semear\(jaDito\)/);
  });
});

// ─── #2996 item 1: preview não pode entrar no seeding ───────────────────────
describe("preview safety: o seeding não chama liveJob() em preview", () => {
  const blocoDeSeeding = (() => {
    const i = FONTE.indexOf("MEMÓRIA DE DUPLICATA CRUZADA");
    expect(i).toBeGreaterThan(-1);
    return FONTE.slice(i, i + 1600);
  })();

  it("o guard do seeding carrega `!preview &&` (mesma forma da guarda irmã)", () => {
    expect(blocoDeSeeding).toContain("if (!preview && turnoVaiFalarComOLead(liveJob()))");
    // Sem o `!preview &&`, `liveJob()` lança `preview_operational_job_forbidden`
    // no `runAgentPreview` — é exatamente o crash reportado na revisão.
    expect(blocoDeSeeding).not.toMatch(/if \(turnoVaiFalarComOLead\(liveJob\(\)\)\)/);
  });
});

// ─── #2996 item 6: reserva em voo / promoção / liberação ────────────────────
describe("reserva em voo fecha a corrida de tool calls paralelas", () => {
  it("`checar` → `reservar` síncronos no caminho de passagem e antes da cadeia", () => {
    const gi = corpoDoSend.indexOf("dupTrava.checar(body)");
    const ri = corpoDoSend.indexOf("dupTrava.reservar(body)");
    expect(gi).toBeGreaterThan(-1);
    expect(ri).toBeGreaterThan(gi);
    // O ramo de SUPRESSÃO termina em `return` e pode conter await (o emit do
    // item 7 mora lá). O caminho que LEVA à reserva é o que precisa ser
    // síncrono: do fim daquele ramo até `reservar`, nenhuma operação assíncrona
    // — se houvesse, a chamada paralela seguinte rodaria durante o yield e
    // passaria pela checagem antes da reserva.
    const fimRamSupressao = corpoDoSend.indexOf("if (claimsCurrentInboundIsEmpty", gi);
    expect(fimRamSupressao).toBeGreaterThan(gi);
    expect(fimRamSupressao).toBeLessThan(ri);
    expect(corpoDoSend.slice(fimRamSupressao, ri)).not.toMatch(/\bawait\b/);
    // E antes do primeiro ponto assíncrono de qualquer espécie (a cadeia e a
    // checagem de obsolescência): se a reserva fosse depois, as paralelas
    // passariam pela checagem durante o await.
    expect(ri).toBeLessThan(corpoDoSend.indexOf("runBeforeSend(", gi));
    expect(ri).toBeLessThan(corpoDoSend.indexOf("respostaFicouObsoleta", gi));
  });

  it("toda tentativa não-aceita libera a reserva (returns explícitos + finally)", () => {
    // resposta_obsoleta e falha de preparo de foto: liberação explícita antes
    // do return (estão FORA do try/catch da cadeia).
    const obs = corpoDoSend.indexOf("turnoDescartado = true;");
    expect(obs).toBeGreaterThan(-1);
    expect(corpoDoSend.slice(obs, obs + 220)).toContain("dupTrava.liberar(body)");
    const prep = corpoDoSend.indexOf("if (!preparadas.ok) {");
    expect(prep).toBeGreaterThan(-1);
    expect(corpoDoSend.slice(prep, prep + 240)).toContain("dupTrava.liberar(body);");
    // Vetos, outcomes não-aceitos, exception e timeout saem pelo finally da
    // cadeia: nenhuma reserva sobrevive à tentativa.
    expect(corpoDoSend).toMatch(
      /code: 'internal_error'[\s\S]*\} finally \{[\s\S]*dupTrava\.liberar\(body\);/,
    );
  });

  it("a candidata checada nunca se auto-suprime (reservar DEPOIS do checar)", () => {
    const gi = corpoDoSend.indexOf("dupTrava.checar(body)");
    const ri = corpoDoSend.indexOf("dupTrava.reservar(body)");
    expect(ri).toBeGreaterThan(gi);
    // O corpo só entra em `emVoo` depois da própria checagem — `checar` consulta
    // aceitos ∪ emVoo, então a ordem é a garantia contra auto-supressão.
    expect(corpoDoSend.slice(gi, ri)).not.toContain("dupTrava.reservar");
  });
});

// ─── #2996 item 6 (revisão): exceção pré-cadeia não deixa reserva órfã ──────
describe("janela pré-cadeia sob try/catch: libera a reserva e re-lança o erro intacto", () => {
  const janela = (() => {
    const ri = corpoDoSend.indexOf("dupTrava.reservar(body)");
    const fim = corpoDoSend.indexOf("// Cadeia de guardrails", ri);
    expect(ri).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(ri);
    // O `try` que envolve a janela vem IMEDIATAMENTE antes da reserva (o emit
    // do ramo de supressão é outro `try`, bem mais acima — este acha o mais
    // próximo por trás dela).
    const ti = corpoDoSend.lastIndexOf("try {", ri);
    expect(ti).toBeGreaterThan(-1);
    return { fonte: corpoDoSend.slice(ti, fim), fim };
  })();

  it("as duas consultas pré-cadeia ficam DEPOIS da reserva e ANTES do catch que libera", () => {
    const { fonte } = janela;
    // Ordem obrigatória dentro da janela: try → reservar → resposta obsoleta →
    // preparo de fotos → catch. Uma exceção em QUALQUER das duas consultas passa
    // pelo catch, que é quem tem que soltar a reserva.
    const iReserva = fonte.indexOf("dupTrava.reservar(body);");
    const iObs = fonte.indexOf("await respostaFicouObsoleta(");
    const iFotos = fonte.indexOf("await prepararFotosDoProduto(");
    const iCatch = fonte.indexOf("} catch (err) {");
    expect(iReserva).toBeGreaterThan(-1);
    expect(iObs).toBeGreaterThan(iReserva);
    expect(iFotos).toBeGreaterThan(iObs);
    expect(iCatch).toBeGreaterThan(iFotos);
    // O catch da janela SOLTA a reserva e RE-LANÇA o erro original — sem
    // `return` com code novo e sem traduzir para `internal_error` (a tradução
    // continua sendo exclusivamente da cadeia, que vem depois).
    expect(fonte).toMatch(/\} catch \(err\) \{[\s\S]*?dupTrava\.liberar\(body\);\s*throw err;/);
    expect(fonte).not.toContain("internal_error");
    // Sem este catch, a janela não teria fecho nenhum: o `finally` que libera
    // pertence à cadeia e roda DEPOIS — uma exceção aqui escaparia por cima dele.
    expect(fonte).not.toMatch(/finally/);
  });

  it("a tradução de falha e o finally que libera seguem intocados DENTRO da cadeia", () => {
    const cadeia = corpoDoSend.slice(janela.fim);
    expect(cadeia).toMatch(
      /code: 'internal_error'[\s\S]*\} finally \{[\s\S]*dupTrava\.liberar\(body\);/,
    );
    expect(cadeia).toContain("dupTrava.promover(body);");
  });

  it("liberada a reserva órfã, a tentativa equivalente NÃO é suprimida (trava real)", () => {
    // Metade executável do contrato: o único efeito do catch é chamar
    // `liberar`, e a trava real prova as duas pontas — com a reserva viva a
    // re-tentativa idêntica cai na supressão (é o vazamento), e com o
    // `liberar` que o catch garante a candidata volta a passar. O `execute` em
    // si é closure do turno sem ponto de injeção (ver cabeçalho), então a
    // rejeição em runtime das consultas não é exercitável aqui — o que se
    // prende é a presença/ordem da janela acima.
    const t = criarTravaDeDuplicata();
    const corpo = "Olá! Sua entrega sai amanhã de manhã, tudo certo?";
    t.reservar(corpo);
    expect(t.checar(corpo)).not.toBeNull(); // sem liberar: suprimida (o vazamento)
    t.liberar(corpo); // o que o catch pré-cadeia garante em exceção
    expect(t.checar(corpo)).toBeNull(); // com liberar: elegível de novo
  });
});

// ─── #2996 item 7: rastro visível para o operador ───────────────────────────
describe("supressão vira atividade na timeline do negócio (sem PII)", () => {
  it("emite `send_vetoed` pelo vocabulário existente, dentro do ramo de supressão", () => {
    const gi = corpoDoSend.indexOf("dupTrava.checar(body)");
    const emit = corpoDoSend.indexOf("await emitAgentActivityForContact({", gi);
    // Fim do ramo: o próximo statement depois do `return` de ensino. O emit
    // precisa estar ENTRE o checar e esse fim — ou seja, dentro do ramo que
    // devolve o erro, antes de qualquer caminho que siga adiante.
    const fimRam = corpoDoSend.indexOf("if (claimsCurrentInboundIsEmpty", gi);
    expect(gi).toBeGreaterThan(-1);
    expect(emit).toBeGreaterThan(gi);
    expect(fimRam).toBeGreaterThan(emit);
    const bloco = corpoDoSend.slice(gi, fimRam);
    expect(bloco).toContain("type: 'send_vetoed'");
    expect(bloco).toContain("sourceModule: 'near-dup'");
    expect(bloco).toContain("reason: vetoReason('near_dup', 'duplicate_suppressed')");
    // O erro de ensino continua devolvido ao modelo no mesmo ramo (com `message:`
    // — distingue o `code:` do return do `code:` do payload, que vem antes).
    expect(bloco).toMatch(/code: 'duplicate_suppressed',\s*message:/);
    // Nunca lança: a timeline não derruba a recusa que ela descreve.
    expect(bloco).toMatch(/try \{\s*const roteou = await emitAgentActivityForContact\(\{/);
    expect(bloco).toContain("if (!roteou.routed)");
    expect(bloco).toContain("runLog.warn('atividade da supressão near-dup não gravada'");
  });

  it("o payload carrega só ids e tamanhos — nunca o texto das mensagens (PII)", () => {
    const emit = corpoDoSend.indexOf("await emitAgentActivityForContact({");
    const payloadStart = corpoDoSend.indexOf("payload: {", emit);
    const payloadEnd = corpoDoSend.indexOf("}", corpoDoSend.indexOf("candidato_len", payloadStart));
    expect(payloadStart).toBeGreaterThan(-1);
    const payload = corpoDoSend.slice(payloadStart, payloadEnd);
    expect(payload).toContain("prior_len");
    expect(payload).toContain("candidato_len");
    expect(payload).toContain("conversation_id");
    // Valores são `.length`/ids — nunca o corpo cru (nem o memorizado).
    expect(payload).not.toMatch(/:\s*(body|corpoRepetido)\s*[,}]/);
  });
});
