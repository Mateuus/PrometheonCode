import { expect, test } from '@playwright/test';

/**
 * Fumaça: login → painel.
 *
 * Enquanto a Hub API não existe, o app roda com dados de exemplo e o login grava
 * uma sessão local — o suficiente para provar que a rota privada abre, que o
 * middleware devolve quem não tem sessão ao login, e que o painel renderiza.
 *
 * Quando a API subir, este arquivo continua valendo: só o que o `HUB_WEB_SAMPLE_DATA`
 * decide muda.
 */

test.describe('login e painel', () => {
  test('quem não tem sessão é levado ao login com o destino preservado', async ({ page }) => {
    await page.goto('/app/prometheon/projects');
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fprometheon%2Fprojects/);
    await expect(page.getByRole('heading', { level: 3 })).toBeVisible();
  });

  test('login abre o painel da organização', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel(/e-?mail/i).fill('mateus@prometheoncode.xyz');
    await page.getByLabel(/senha|password|contraseña/i).fill('uma-senha-bem-longa');
    await page.getByRole('button', { name: /entrar|sign in|iniciar/i }).click();

    await expect(page).toHaveURL(/\/app$/);
    await page.getByRole('link', { name: 'Prometheon', exact: true }).first().click();

    await expect(page.getByRole('main')).toBeVisible();
  });

  test('o parâmetro next não leva para fora do Hub', async ({ page }) => {
    await page.goto('/login?next=https://evil.example');
    const hidden = page.locator('input[name="next"]');
    await expect(hidden).toHaveValue('/app');
  });
});
