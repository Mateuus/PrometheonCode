import { describe, expect, it } from 'vitest';
import { CATALOG, SOURCE_STRINGS } from './catalog';
import { TRANSLATED_LOCALES } from './config';
import { buildDictionary, createTranslate, interpolate } from './dictionary';
import { plural, type CountableKey } from './plural';
import ptBr from './messages/pt-br.json';
import es from './messages/es.json';

/**
 * Guarda da localização.
 *
 * A promessa do produto é interface em `en`, `pt-br` e `es`. Uma promessa dessas
 * só se sustenta se quebrar o teste no minuto em que alguém acrescenta uma
 * frase e esquece de traduzir — revisão humana não pega isso de forma confiável.
 */

const BUNDLES: Record<string, Record<string, string>> = { 'pt-br': ptBr, es };

function placeholders(text: string): string[] {
  return (text.match(/\{[^}]*\}/g) ?? []).sort();
}

describe('localização', () => {
  it('todo texto da interface tem tradução nos idiomas suportados', () => {
    for (const locale of TRANSLATED_LOCALES) {
      const bundle = BUNDLES[locale]!;
      const missing = SOURCE_STRINGS.filter((text) => bundle[text] === undefined);
      expect(missing, `faltam traduções em ${locale}`).toEqual([]);
    }
  });

  it('nenhuma tradução fica vazia', () => {
    for (const locale of TRANSLATED_LOCALES) {
      for (const [english, translated] of Object.entries(BUNDLES[locale]!)) {
        expect(translated.trim(), `tradução vazia em ${locale}: "${english}"`).not.toBe('');
      }
    }
  });

  it('os bundles preservam os marcadores de interpolação', () => {
    for (const locale of TRANSLATED_LOCALES) {
      for (const [english, translated] of Object.entries(BUNDLES[locale]!)) {
        expect(placeholders(translated), `marcadores diferentes em ${locale}: "${english}"`).toEqual(
          placeholders(english),
        );
      }
    }
  });

  it('nenhum bundle carrega entrada que não existe mais no catálogo', () => {
    const known = new Set(SOURCE_STRINGS);
    for (const locale of TRANSLATED_LOCALES) {
      const orphans = Object.keys(BUNDLES[locale]!).filter((text) => !known.has(text));
      expect(orphans, `entradas órfãs em ${locale}`).toEqual([]);
    }
  });

  it('o dicionário resolve toda chave em todos os idiomas', () => {
    const keys = Object.keys(CATALOG);
    for (const locale of ['en', ...TRANSLATED_LOCALES] as const) {
      const dictionary = buildDictionary(locale);
      for (const key of keys) {
        expect(dictionary[key as keyof typeof CATALOG]).toBeTruthy();
      }
    }
  });

  it('o português e o espanhol não devolvem o texto em inglês', () => {
    // Um punhado de termos é igual nos três idiomas (Chat, Beta, Backlog); o
    // teste olha uma frase longa, onde repetir o inglês seria falta de tradução.
    for (const locale of TRANSLATED_LOCALES) {
      const dictionary = buildDictionary(locale);
      expect(dictionary['state.offline.description']).not.toBe(CATALOG['state.offline.description']);
    }
  });
});

describe('plural', () => {
  const countable: CountableKey[] = ['admin.plans.days', 'agents.runningCount'];

  it('toda chave contável tem a forma singular ao lado da plural', () => {
    for (const key of countable) {
      expect(CATALOG[key], `falta a chave plural ${key}`).toBeTruthy();
      expect(
        CATALOG[`${key}.one` as keyof typeof CATALOG],
        `falta a forma singular de ${key}`,
      ).toBeTruthy();
    }
  });

  it('escolhe singular para 1 e plural para o resto, em cada idioma', () => {
    for (const locale of ['en', ...TRANSLATED_LOCALES] as const) {
      const t = createTranslate(buildDictionary(locale));
      const one = plural(t, 'agents.runningCount', 1);
      const many = plural(t, 'agents.runningCount', 4);
      expect(one).toContain('1');
      expect(many).toContain('4');
      expect(one).not.toBe(many);
    }
  });
});

describe('interpolação', () => {
  it('substitui marcadores conhecidos', () => {
    expect(interpolate('Attempt {attempt}', { attempt: 3 })).toBe('Attempt 3');
  });

  it('deixa intacto o marcador sem valor', () => {
    expect(interpolate('Attempt {attempt}')).toBe('Attempt {attempt}');
  });
});
