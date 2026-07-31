import { describe, expect, it } from 'vitest';
import { safeRedirect } from './safe-redirect';

describe('safeRedirect', () => {
  it('aceita caminho relativo à raiz', () => {
    expect(safeRedirect('/app/prometheon/projects')).toBe('/app/prometheon/projects');
    expect(safeRedirect('/app?tab=1#top')).toBe('/app?tab=1#top');
    expect(safeRedirect('/app/acme-labs')).toBe('/app/acme-labs');
  });

  it('recusa URL absoluta', () => {
    expect(safeRedirect('https://evil.example/phish')).toBe('/app');
    expect(safeRedirect('http://127.0.0.1:3550/app')).toBe('/app');
  });

  it('recusa protocolo relativo e barra invertida', () => {
    expect(safeRedirect('//evil.example')).toBe('/app');
    expect(safeRedirect('/\\evil.example')).toBe('/app');
    expect(safeRedirect('/app\\..\\evil')).toBe('/app');
  });

  it('recusa esquema disfarçado', () => {
    expect(safeRedirect('/javascript:alert(1)')).toBe('/app');
    expect(safeRedirect('javascript:alert(1)')).toBe('/app');
  });

  it('recusa contorno por percent-encoding', () => {
    expect(safeRedirect('%2F%2Fevil.example')).toBe('/app');
    expect(safeRedirect('/%5Cevil.example')).toBe('/app');
  });

  it('recusa espaço e caractere de controle', () => {
    expect(safeRedirect('/app /x')).toBe('/app');
    expect(safeRedirect('/\tapp')).toBe('/app');
    expect(safeRedirect('/\napp')).toBe('/app');
  });

  it('recusa percent-encoding inválido', () => {
    expect(safeRedirect('%E0%A4%A')).toBe('/app');
  });

  it('cai no destino informado quando o valor é vazio ou ausente', () => {
    expect(safeRedirect(undefined)).toBe('/app');
    expect(safeRedirect(null)).toBe('/app');
    expect(safeRedirect('')).toBe('/app');
    expect(safeRedirect('', '/login')).toBe('/login');
  });
});
