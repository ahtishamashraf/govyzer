import { expect, test } from '@playwright/test';

const SCREEN_URL = 'http://localhost:3400';
const password = 'PlaywrightPass!2026';

function unique(prefix) {
  return `${prefix}-${Date.now().toString().slice(-6)}`;
}

// The second test signs in with the account created by the first, so they run in order.
test.describe.serial('Govyzer end to end', () => {
  const slug = unique('e2e');
  const email = `owner@${slug}.test`;

  test('an owner can register, work the CRM and pair a Sales Screen', async ({ page, context }) => {
    // --- Onboarding ---
    await page.goto('/register');
    await page.getByLabel('Company name').fill(`E2E Realty ${slug}`);
    await page.getByLabel('Workspace address').fill(slug);
    await page.getByLabel('First name').fill('Playwright');
    await page.getByLabel('Last name').fill('Owner');
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByLabel('Off-plan projects').check();
    await page.getByLabel('Sales Screen displays').check();
    await page.getByRole('button', { name: 'Create workspace' }).click();

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Executive overview' })).toBeVisible();

    // --- Create a lead ---
    await page.getByRole('link', { name: 'Leads' }).click();
    await expect(page).toHaveURL(/\/leads/);
    await page.getByRole('button', { name: 'New lead' }).click();
    await page.getByLabel('First name').fill('Aisha');
    await page.getByLabel('Last name').fill('Rahman');
    await page.getByLabel('Mobile').fill('0501234599');
    await page.getByLabel('Budget').fill('2400000');
    await page.getByRole('button', { name: 'Create lead' }).click();

    await expect(page).toHaveURL(/\/leads\/[0-9A-Z]{26}/);
    await expect(page.getByRole('heading', { name: 'Aisha Rahman' })).toBeVisible();
    await expect(page.getByText('SLA pending')).toBeVisible();

    // A repeat enquiry from the same mobile attaches to the same contact.
    await page.goto('/leads');
    await page.getByRole('button', { name: 'New lead' }).click();
    await page.getByLabel('First name').fill('Aisha');
    await page.getByLabel('Mobile').fill('+971501234599');
    await page.getByRole('button', { name: 'Create lead' }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9A-Z]{26}/);
    await page.getByRole('link', { name: 'Open contact' }).click();
    await expect(page.getByRole('heading', { name: /Aisha/ })).toBeVisible();
    await expect(page.locator('.gv-card:has(.gv-card__title:text-is("Leads")) tbody tr')).toHaveCount(2);

    // --- Create and approve a listing ---
    await page.goto('/ready/listings/new');
    await page.getByLabel('Built up area').fill('1280');
    await page.getByLabel('Bedrooms').fill('2');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Price').fill('2450000');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Title').fill('Marina view two bedroom with study');
    await page.getByLabel('Description').fill('A bright two bedroom apartment with an unobstructed marina view, upgraded kitchen and covered parking.');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Permit number').fill('7194000123');
    await page.getByRole('button', { name: 'Create listing' }).click();

    await expect(page).toHaveURL(/\/ready\/listings\/[0-9A-Z]{26}/);
    await expect(page.getByRole('heading', { name: 'Marina view two bedroom with study' })).toBeVisible();
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('approved', { exact: false }).first()).toBeVisible();

    // --- Sales Screen: create a display and pair it ---
    await page.goto('/sales-screen');
    await page.getByRole('button', { name: 'New display' }).click();
    await page.getByLabel('Display name').fill('E2E reception TV');
    await page.getByRole('button', { name: 'Create display' }).click();
    await expect(page.getByText('E2E reception TV').first()).toBeVisible();

    await page.getByRole('button', { name: 'Pair' }).first().click();
    const code = await page.locator('div', { hasText: /^[A-Z0-9]{8}$/ }).last().innerText();
    expect(code).toMatch(/^[A-Z0-9]{8}$/);

    const screen = await context.newPage();
    await screen.goto(`${SCREEN_URL}/pair`);
    await screen.getByLabel('Pairing code').fill(code);
    await screen.getByRole('button', { name: 'Pair this display' }).click();

    await expect(screen).toHaveURL(new RegExp(`${SCREEN_URL}/display`));
    await expect(screen.getByText(`E2E Realty ${slug}`)).toBeVisible({ timeout: 30_000 });
    await expect(screen.getByText('Live').first()).toBeVisible();

    // The CRM shows the display as paired and online after its first heartbeat.
    await page.reload();
    await expect(page.getByText('Paired').first()).toBeVisible();

    // --- Revoking the display takes it off the wall ---
    await page.getByRole('button', { name: 'Revoke' }).first().click();
    await expect(page.getByText('Revoked').first()).toBeVisible();
    await screen.waitForURL(new RegExp(`${SCREEN_URL}/pair`), { timeout: 60_000 });
  });

  test('sign in, keyboard shortcuts and permission-aware navigation work', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.keyboard.press('Control+k');
    await expect(page.getByPlaceholder('Jump to a screen or action…')).toBeVisible();
    await page.getByPlaceholder('Jump to a screen or action…').fill('inventory');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/offplan\/inventory/);

    await page.getByRole('button', { name: 'العربية' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});
