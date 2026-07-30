import { expect, test } from '@playwright/test';

/**
 * Fumaça do que não depende de conta.
 *
 * O caminho completo — cadastro, confirmação de e-mail, login, projeto,
 * conversa e mensagem ao vivo — precisa de Hub API, worker e banco no ar, e é
 * exercitado por `scripts/hub-smoke*.mjs` e pela navegação manual. Aqui ficam as
 * garantias que valem só com o Hub Web de pé: a portaria das rotas privadas, o
 * filtro de open redirect e as telas públicas de autenticação.
 */

test.describe('portaria e telas públicas', () => {
  test('quem não tem sessão é levado ao login com o destino preservado', async ({ page }) => {
    await page.goto('/app/prometheon/projects');
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fprometheon%2Fprojects/);
    await expect(page.getByRole('button', { name: /entrar|sign in|iniciar/i })).toBeVisible();
  });

  test('o parâmetro next não leva para fora do Hub', async ({ page }) => {
    await page.goto('/login?next=https://evil.example');
    await expect(page.locator('input[name="next"]')).toHaveValue('/app');
  });

  test('o cadastro oferece nomear a organização', async ({ page }) => {
    await page.goto('/register');
    await expect(page.locator('#register-organization')).toBeVisible();
  });

  test('o convite encaminha para o cadastro carregando o token', async ({ page }) => {
    await page.goto('/invite/token-de-teste-com-tamanho-suficiente');
    const accept = page.getByRole('link', { name: /aceitar|accept|aceptar/i });
    await expect(accept).toHaveAttribute(
      'href',
      /\/register\?invitation=token-de-teste-com-tamanho-suficiente/,
    );
  });

  test('a recuperação de senha sem token explica o que fazer', async ({ page }) => {
    await page.goto('/reset-password');
    await expect(page.getByRole('link', { name: /recupera|recovery|recuperación/i })).toBeVisible();
  });
});
