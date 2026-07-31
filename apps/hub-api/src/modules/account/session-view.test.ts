/**
 * O que a lista de sessões conta, e o que ela se recusa a contar.
 *
 * Estas duas funções são a única barreira entre a coluna crua do banco e a tela
 * do usuário. Um teste que só verificasse o caminho feliz deixaria passar
 * justamente o caso perigoso — o valor que não casa com nada e escapa inteiro.
 */

import { describe, expect, it } from 'vitest';

import { describeClient, maskIp } from './session-view.js';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const EDGE_WINDOWS = `${CHROME_WINDOWS} Edg/141.0.0.0`;
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

describe('describeClient', () => {
  it('prefere o nome que a pessoa deu ao dispositivo', () => {
    expect(describeClient(CHROME_WINDOWS, 'Notebook do trabalho')).toBe(
      'Notebook do trabalho',
    );
  });

  it('resume navegador e sistema sem devolver o user agent', () => {
    expect(describeClient(CHROME_WINDOWS, null)).toBe('Chrome on Windows');
    expect(describeClient(SAFARI_IOS, null)).toBe('Safari on iOS');
  });

  it('não confunde Edge com Chrome', () => {
    // O Edge anuncia `Chrome/` no próprio user agent. Sem a ordem certa na
    // tabela, toda sessão do Edge apareceria como Chrome — e a pessoa não
    // reconheceria a própria máquina.
    expect(describeClient(EDGE_WINDOWS, null)).toBe('Edge on Windows');
  });

  it('reconhece o cliente próprio antes de qualquer navegador', () => {
    expect(describeClient('Prometheon-Code/0.1.0 (Windows NT 10.0)', null)).toBe(
      'Prometheon on Windows',
    );
  });

  it('devolve nulo em vez de vazar um user agent desconhecido', () => {
    const exotic = 'AlgumClienteQueNinguemConhece/9.9 (segredo-da-maquina)';

    expect(describeClient(exotic, null)).toBeNull();
    expect(describeClient(null, null)).toBeNull();
    expect(describeClient('', '  ')).toBeNull();
  });
});

describe('maskIp', () => {
  it('reduz o IPv4 à rede /24', () => {
    expect(maskIp('203.0.113.9')).toBe('203.0.113.0');
    expect(maskIp('127.0.0.1')).toBe('127.0.0.0');
  });

  it('desembrulha o IPv4 que chega mapeado em IPv6', () => {
    expect(maskIp('::ffff:203.0.113.9')).toBe('203.0.113.0');
  });

  it('reduz o IPv6 ao bloco /48', () => {
    expect(maskIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:0db8:85a3::');
  });

  it('devolve nulo para o que não sabe truncar', () => {
    // O caso que importa: um valor inesperado não pode escapar inteiro só
    // porque a função não soube o que fazer com ele.
    expect(maskIp('nao-e-um-endereco')).toBeNull();
    expect(maskIp('999.1.1.1')).toBeNull();
    expect(maskIp(null)).toBeNull();
    expect(maskIp('   ')).toBeNull();
  });
});
