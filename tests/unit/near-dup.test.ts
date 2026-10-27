import { describe, it, expect } from 'vitest';
import {
  normalizarParaComparacao,
  similaridadeDice,
  ehDuplicadoOuProximo,
  encontraDuplicado,
  criarTravaDeDuplicata,
  LIMIAR_DUPLICADO_PROXIMO,
} from '@/lib/agent-engine/agent/near-dup';

describe('normalizarParaComparacao', () => {
  it('colapsa espaços, trim e caixa', () => {
    expect(normalizarParaComparacao('  Ola,\n  mundo   ')).toBe('ola, mundo');
    expect(normalizarParaComparacao('OLA MUNDO')).toBe('ola mundo');
  });

  it('remove zero-width e BOM', () => {
    expect(normalizarParaComparacao('a\u200Bb\ufeff')).toBe('ab');
  });

  it('preserva script Devanagari (sem caixa, sem quebra)', () => {
    // "12 घंटे का उपवास" — normalização não deve corromper os glifos.
    const s = '१२ घंटे का उपवास';
    expect(normalizarParaComparacao(`  ${s}  `)).toBe(s);
  });
});

describe('similaridadeDice', () => {
  it('idênticos = 1', () => {
    expect(similaridadeDice('abc def', 'abc def')).toBe(1);
  });

  it('completamente diferentes = 0', () => {
    expect(similaridadeDice('aaaa', 'zzzz')).toBe(0);
  });

  it('quase-idênticos ficam altos', () => {
    const a = 'O preço do perfil de tireoide é R$ 550, agende com antecedência.';
    const b = 'O preço do perfil de tireoide é R$ 550, agende com antecedência agora.';
    expect(similaridadeDice(a, b)).toBeGreaterThan(LIMIAR_DUPLICADO_PROXIMO);
  });

  it('strings curtas (<2 chars) sem igualdade = 0', () => {
    expect(similaridadeDice('a', 'b')).toBe(0);
  });
});

describe('ehDuplicadoOuProximo', () => {
  it('duplicata exata após normalização', () => {
    expect(ehDuplicadoOuProximo('Sim, o exame custa R$550.', 'sim,  o exame custa r$550.')).toBe(true);
  });

  it('corpo em branco nunca suprime', () => {
    expect(ehDuplicadoOuProximo('', '')).toBe(false);
    expect(ehDuplicadoOuProximo('   ', '')).toBe(false);
  });

  it('redação genuinamente distinta passa (não suprime)', () => {
    expect(
      ehDuplicadoOuProximo(
        'Seu resultado do TSH fica pronto em 2 dias úteis.',
        'Para o exame de TSH é necessário 12 horas de jejum.',
      ),
    ).toBe(false);
  });

  it('repetição quase idêntica suprime', () => {
    expect(
      ehDuplicadoOuProximo(
        'Jejum de 12 horas é necessário para o perfil da tireoide.',
        'Jejum de 12 horas é necessário para o perfil da tireoide, ok?',
      ),
    ).toBe(true);
  });

  it('Devanagari quase idêntico suprime; conteúdo distinto passa', () => {
    expect(
      ehDuplicadoOuProximo('१२ घंटे का उपवास आवश्यक है।', '१२ घंटे का उपवास आवश्यक है।'),
    ).toBe(true);
    expect(
      ehDuplicadoOuProximo('१२ घंटे का उपवास आवश्यक है।', 'रिपोर्ट तैयार है, कृपया संपर्क करें।'),
    ).toBe(false);
  });

  it('respeita limiar customizado', () => {
    const a = 'abcde fghij';
    const b = 'abcde fghix';
    // com limiar 1.0 só igualdade exata suprime
    expect(ehDuplicadoOuProximo(a, b, 1.0)).toBe(false);
    expect(ehDuplicadoOuProximo(a, b, 0.5)).toBe(true);
  });
});

describe('encontraDuplicado', () => {
  it('devolve o PRIMEIRO corpo do qual o candidato é duplicata', () => {
    const enviados = [
      'Jejum de 12 horas é necessário.',
      'Outra coisa completamente diferente aqui.',
    ];
    const alvo = 'Jejum de 12 horas é necessário, ok?';
    expect(encontraDuplicado(alvo, enviados)).toBe(enviados[0]);
  });

  it('devolve null quando nada é duplicata', () => {
    expect(encontraDuplicado('conteúdo novo e distinto', ['algo velho e diferente'])).toBeNull();
  });

  it('lista vazia = null', () => {
    expect(encontraDuplicado('qualquer coisa', [])).toBeNull();
  });
});

// ─── #2996 item 3: informação nova não é repetição ───────────────────────
describe('informação nova (valor/negação) NÃO suprime — exceção da revisão', () => {
  // Os pares abaixo são as medições do mantenedor (main 330ead5ca): todos ficam
  // ACIMA do limiar (por isso a régua ingênua os suprimia) e passam GRÂCIAS à
  // exceção. O `quaseIdentico` documenta isso — sem ele, um Dice que "caísse
  // sozinho" sob a exceção mascararia a regressão dela.
  const quaseId = (a: string, b: string): void => {
    expect(similaridadeDice(normalizarParaComparacao(a), normalizarParaComparacao(b))).toBeGreaterThanOrEqual(
      LIMIAR_DUPLICADO_PROXIMO,
    );
  };

  it('preço mudado (R$ 1.250 → R$ 1.350) passa', () => {
    const a = 'O valor total do tratamento fica em R$ 1.250, podendo ser parcelado em 10x sem juros.';
    const b = 'O valor total do tratamento fica em R$ 1.350, podendo ser parcelado em 10x sem juros.';
    quaseId(a, b);
    expect(ehDuplicadoOuProximo(b, a)).toBe(false);
  });

  it('hora mudada (9h → 10h) passa', () => {
    const a = 'Sua consulta está marcada para amanhã às 9h, com a Dra. Ana, na unidade Centro.';
    const b = 'Sua consulta está marcada para amanhã às 10h, com a Dra. Ana, na unidade Centro.';
    quaseId(a, b);
    expect(ehDuplicadoOuProximo(b, a)).toBe(false);
  });

  it('negação acrescentada (Sim → Não na entrega) passa', () => {
    const a = 'Sim, fazemos entrega na região central, das 8h às 18h.';
    const b = 'Não, fazemos entrega na região central, das 8h às 18h.';
    quaseId(a, b);
    expect(ehDuplicadoOuProximo(b, a)).toBe(false);
  });

  it('negação no meio da frase (foi → não foi confirmado) passa', () => {
    const a = 'O seu pagamento foi confirmado e o agendamento está liberado para você.';
    const b = 'O seu pagamento não foi confirmado e o agendamento está liberado para você.';
    quaseId(a, b);
    expect(ehDuplicadoOuProximo(b, a)).toBe(false);
  });

  it('REMOVER a negação também é informação (não só acrescentar)', () => {
    const a = 'Não conseguimos entregar hoje, mas amanhã podemos sim.';
    const b = 'Conseguimos entregar hoje, mas amanhã podemos sim.';
    quaseId(a, b);
    expect(ehDuplicadoOuProximo(b, a)).toBe(false);
  });

  it('número SOLTO mudado também é informação (data, hora com dois-pontos, preço sem separador)', () => {
    // Um número sem separador nem unidade colada também é preço, data, hora,
    // pedido. Separar "valor" de "contador" pela forma suprimia correção de
    // data e de horário (medido na triagem do #2996).
    const pares: Array<[string, string]> = [
      [
        'Sua consulta está marcada para dia 15 de outubro às 9h, com a Dra. Ana.',
        'Sua consulta está marcada para dia 16 de outubro às 9h, com a Dra. Ana.',
      ],
      [
        'Sua consulta está marcada para amanhã às 9:00, com a Dra. Ana, na unidade Centro.',
        'Sua consulta está marcada para amanhã às 10:00, com a Dra. Ana, na unidade Centro.',
      ],
      [
        'O frete para o seu CEP fica R$ 25 e chega em até 3 dias úteis.',
        'O frete para o seu CEP fica R$ 35 e chega em até 3 dias úteis.',
      ],
      [
        'Oi! Passando para saber se ficou alguma dúvida sobre a proposta. Tentativa 1 de 3.',
        'Oi! Passando para saber se ficou alguma dúvida sobre a proposta. Tentativa 2 de 3.',
      ],
    ];
    for (const [a, b] of pares) {
      quaseId(a, b);
      expect(ehDuplicadoOuProximo(b, a)).toBe(false);
    }
  });

  it('mesmos números, só pontuação mudada: segue suprimindo', () => {
    const a = 'O valor do tratamento fica em R$ 1.250, podendo ser parcelado em 10x sem juros.';
    const b = 'O valor do tratamento fica em R$ 1.250, podendo ser parcelado em 10x sem juros!';
    quaseId(a, b);
    expect(ehDuplicadoOuProximo(b, a)).toBe(true);
  });

  it('reentrada idêntica segue suprimindo mesmo com valor e negação presentes', () => {
    const msg = 'Não é preciso pagar agora, o valor é R$ 1.250, às 9h.';
    expect(ehDuplicadoOuProximo(msg, msg)).toBe(true);
    expect(ehDuplicadoOuProximo(msg, '  Não é preciso pagar agora, o valor é R$ 1.250, às 9h.  ')).toBe(true);
  });

  it('Obrigado! → Obrigada! já passava por baixo do limiar (não é a exceção)', () => {
    const a = 'Obrigado!';
    const b = 'Obrigada!';
    expect(similaridadeDice(normalizarParaComparacao(a), normalizarParaComparacao(b))).toBeLessThan(
      LIMIAR_DUPLICADO_PROXIMO,
    );
    expect(ehDuplicadoOuProximo(b, a)).toBe(false);
  });
});

// ─── #2996 item 6: a trava em voo fecha a corrida de chamadas paralelas ─────
describe('criarTravaDeDuplicata — em-voo, promoção e liberação', () => {
  it('checar → reservar atômico: a 2ª candidata idêntica ENXERGA a 1ª em voo', () => {
    const t = criarTravaDeDuplicata();
    expect(t.checar('Sua consulta é amanhã às 10h.')).toBeNull(); // 1ª passa e reserva
    t.reservar('Sua consulta é amanhã às 10h.');
    // chamada paralela seguinte (mesma tick posterior): vê a reserva → suprime
    expect(t.checar('Sua consulta é amanhã às 10h!')).not.toBeNull();
    // candidata genuinamente diferente segue elegível
    expect(t.checar('Outro assunto: seu exame ficou pronto.')).toBeNull();
  });

  it('Promise.all: de 3 candidatas idênticas UMA só passa — determinístico', async () => {
    const t = criarTravaDeDuplicata();
    const corpo = 'Oi! Tudo bem? Vi que você pediu um orçamento, posso ajudar?';
    const resultados = await Promise.all(
      Array.from({ length: 3 }, async () => {
        // mesma ordem do execute real: checar → (se passou) reservar, síncronos,
        // ANTES do primeiro await da "cadeia".
        const r = t.checar(corpo);
        if (r === null) t.reservar(corpo);
        await new Promise((resolve) => setTimeout(resolve, 0)); // a cadeia
        if (r === null) t.promover(corpo);
        return r;
      }),
    );
    expect(resultados.filter((r) => r === null)).toHaveLength(1);
    expect(t.aceitos()).toHaveLength(1);
    expect(t.emVoo()).toHaveLength(0);
  });

  it('liberar devolve a candidata à elegibilidade (sem reserva órfã)', () => {
    const t = criarTravaDeDuplicata();
    const corpo = 'Seu pagamento foi aprovado.';
    expect(t.checar(corpo)).toBeNull();
    t.reservar(corpo);
    t.liberar(corpo); // veto/falha/exceção/finally
    expect(t.emVoo()).toHaveLength(0);
    expect(t.aceitos()).toHaveLength(0);
    expect(t.checar(corpo)).toBeNull(); // elegível de novo
  });

  it('promover transiciona exatamente uma vez; finally seguinte é no-op', () => {
    const t = criarTravaDeDuplicata();
    const corpo = 'Segunda via do comprovante a caminho.';
    expect(t.checar(corpo)).toBeNull();
    t.reservar(corpo);
    t.promover(corpo);
    t.promover(corpo); // chamada dupla não duplica a memória
    expect(t.aceitos()).toEqual([corpo]);
    expect(t.emVoo()).toHaveLength(0);
    t.liberar(corpo); // finally após o promover: no-op, não remove da durável
    expect(t.aceitos()).toEqual([corpo]);
    expect(t.checar('Segunda via do comprovante a caminho!')).not.toBeNull();
  });

  it('semear popula a memória durável sem tocar no em-voo', () => {
    const t = criarTravaDeDuplicata();
    t.semear(['Resposta histórica um.', 'Resposta histórica dois.']);
    t.semear(['Resposta histórica um.']); // semeador repetido não duplica
    expect(t.aceitos()).toHaveLength(2);
    expect(t.emVoo()).toHaveLength(0);
    expect(t.checar('Resposta histórica um.')).not.toBeNull();
  });
});
