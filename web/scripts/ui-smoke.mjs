import { chromium } from 'playwright';

const baseUrl = (process.env.CONTAINR_SMOKE_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const suppliedEmail = process.env.CONTAINR_SMOKE_EMAIL || '';
const suppliedPassword = process.env.CONTAINR_SMOKE_PASSWORD || '';
const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const generatedEmail = `ui-smoke-${stamp}@example.com`;
const generatedPassword = `Sm0ke-${stamp}`;
const secondUserEmail = `ui-user-${stamp}@example.com`;
const serviceName = `ui-smoke-${stamp}`;

const expect = async (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const waitForVisible = async (locator, message) => {
  try {
    await locator.waitFor({ state: 'visible', timeout: 15000 });
  } catch (error) {
    throw new Error(message);
  }
};

const getJson = async (url) => {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`request failed for ${url}: ${response.status}`);
  }
  return response.json();
};

const fillAndSubmitLogin = async (page, email, password, buttonName) => {
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: buttonName }).click();
};

const waitForOverview = async (page) => {
  await page.waitForURL(new RegExp(`^${baseUrl}/?$`));
  await waitForVisible(page.getByRole('heading', { name: 'Overview' }), 'overview page did not load');
};

const createManagedService = async (page) => {
  await page.goto(`${baseUrl}/new/database?engine=redis`, { waitUntil: 'networkidle' });
  await page.locator('main input:not([type])').first().fill(serviceName);
  await page.getByRole('button', { name: /^Create Redis/ }).click();
  await page.waitForURL(/\/services\/.+/);
  await waitForVisible(page.getByRole('heading', { name: serviceName }), 'service detail did not load');
};

const deleteManagedService = async (page) => {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete service' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input').fill(serviceName);
  await dialog.getByRole('button', { name: 'Delete service' }).click();
  await page.waitForURL(/\/services(?:\?.*)?$/);
  await expect(
    !(await page.locator('table').filter({ hasText: serviceName }).isVisible().catch(() => false)),
    'service still visible after delete',
  );
};

const verifyAdminCanCreateUser = async (page, email) => {
  await page.goto(`${baseUrl}/settings/users`, { waitUntil: 'networkidle' });
  await waitForVisible(page.getByRole('button', { name: 'Add user' }), 'users page did not load');
  await page.getByRole('button', { name: 'Add user' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type="email"]').fill(email);
  await dialog.getByRole('button', { name: 'Add user' }).click();
  await waitForVisible(page.getByText(email), 'new user did not appear in the users list');
};

const run = async () => {
  const status = await getJson(`${baseUrl}/api/auth/status`);
  const browser = await chromium.launch({ headless: process.env.CONTAINR_SMOKE_HEADLESS !== 'false' });
  const page = await browser.newPage();

  try {
    if (status.registration_open) {
      await page.goto(`${baseUrl}/register`, { waitUntil: 'networkidle' });
      await page.locator('input[type="email"]').fill(generatedEmail);
      await page.locator('input[type="password"]').nth(0).fill(generatedPassword);
      await page.locator('input[type="password"]').nth(1).fill(generatedPassword);
      await page.getByRole('button', { name: 'Create account' }).click();
      await waitForOverview(page);
      await verifyAdminCanCreateUser(page, secondUserEmail);
    } else {
      await expect(Boolean(suppliedEmail && suppliedPassword), 'registration is closed; set CONTAINR_SMOKE_EMAIL and CONTAINR_SMOKE_PASSWORD');
      await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
      await fillAndSubmitLogin(page, suppliedEmail, suppliedPassword, 'Sign in');
      await waitForOverview(page);
    }

    await createManagedService(page);
    await deleteManagedService(page);
    console.log(`ui smoke completed against ${baseUrl}`);
  } catch (error) {
    const failurePath = '/tmp/containr-ui-smoke-failure.png';
    await page.screenshot({ path: failurePath, fullPage: true }).catch(() => {});
    console.error(`ui smoke url: ${page.url()}`);
    console.error(`ui smoke screenshot: ${failurePath}`);
    console.error(
      await page.evaluate(async () => {
        const token = localStorage.getItem('containr_token');
        const user = localStorage.getItem('containr_user');
        let meStatus = 'request-not-run';
        try {
          const response = await fetch('/api/auth/me', {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          meStatus = `${response.status}`;
        } catch (requestError) {
          meStatus = String(requestError);
        }
        return {
          tokenLength: token ? token.length : 0,
          hasUser: Boolean(user),
          meStatus,
        };
      }),
    );
    console.error(await page.locator('body').innerText().catch(() => 'body unavailable'));
    throw error;
  } finally {
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
