import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const localAuthEnabled = process.env.E2E_LOCAL_AUTH === 'true';

test.describe('Phase 1 Supabase workspace flow', () => {
  test.skip(
    !localAuthEnabled,
    'Set E2E_LOCAL_AUTH=true and configure apps/web/.env.local for local Supabase Auth.',
  );

  test('signs up, creates workspace context, and denies another user access', async ({
    browser,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const password = `Local-Test-${randomUUID()}!`;
    const companyName = `Test Company ${suffix}`;
    const projectName = `Test Project ${suffix}`;
    const meetingTitle = `Test Meeting ${suffix}`;
    const workspaceName = `Test Workspace ${suffix}`;

    const owner = await browser.newPage();
    await signUp(owner, `owner-${suffix}@example.test`, password);

    await expect(owner.getByRole('heading', { name: 'Your workspaces' })).toBeVisible();
    await owner.getByLabel('Workspace name').fill(workspaceName);
    await owner.getByRole('button', { name: 'Create workspace' }).click();
    await expect(owner).toHaveURL(/\/w\/[0-9a-f-]+$/i);
    const workspacePath = new URL(owner.url()).pathname;

    await owner.getByLabel('Company name').fill(companyName);
    await owner.locator('#companies').getByRole('button', { name: 'Add' }).click();
    await expect(owner.locator('#companies').getByText(companyName)).toBeVisible();

    await owner.getByLabel('Project name').fill(projectName);
    await owner.locator('#projects').locator('select[name="companyId"]').selectOption({
      label: companyName,
    });
    await owner.getByRole('button', { name: 'Add project' }).click();
    await expect(owner.locator('#projects').getByText(projectName)).toBeVisible();

    await owner.getByLabel('Meeting title').fill(meetingTitle);
    await owner.locator('#meetings').locator('select[name="meetingTypeId"]').selectOption({
      label: 'General',
    });
    await owner.locator('#meetings').locator('select[name="companyId"]').selectOption({
      label: companyName,
    });
    await owner.locator('#meetings').locator('select[name="projectId"]').selectOption({
      label: projectName,
    });
    await owner.getByRole('button', { name: 'Create draft' }).click();
    await expect(owner.getByRole('row', { name: new RegExp(meetingTitle) })).toBeVisible();

    await owner.getByRole('button', { name: 'Sign out' }).click();
    await expect(owner).toHaveURL(/\/login/);

    const otherUser = await browser.newPage();
    await signUp(otherUser, `other-${suffix}@example.test`, password);
    await expect(otherUser.getByRole('heading', { name: 'Your workspaces' })).toBeVisible();
    await otherUser.goto(workspacePath);
    await expect(otherUser.getByRole('heading', { name: 'Workspace unavailable' })).toBeVisible();

    await owner.close();
    await otherUser.close();
  });
});

async function signUp(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.locator('#signup-email').fill(email);
  await page.locator('#signup-password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
}
