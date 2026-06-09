// @ts-check
const { test, expect } = require('@playwright/test');

// Supabase project id for the "Ritmo" workspace (see prompt / native.js LS_PROJECT).
const RITMO_ID = '76a469d3-8884-42e3-aed0-3d5cc4c9759f';
const LS_KEY = 'cc_current_project';

/**
 * Attach console / pageerror collectors. Returns an array of error strings.
 * We only treat genuine JS errors as failures (console.error + uncaught
 * pageerror). console.warn / log / info are ignored — the app logs benign
 * warnings (e.g. "Card not found").
 */
function collectErrors(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const txt = msg.text();
      // Ruído de REDE (404 de assets opcionais que o app busca com fallback) não
      // é bug de código — o chromium não inclui a URL no texto, então ignoramos
      // toda "Failed to load resource". Erros de JS reais chegam via 'pageerror'.
      if (/Failed to load resource/i.test(txt)) return;
      if (/favicon\.ico/.test(txt)) return;
      errors.push('[console.error] ' + txt);
    }
  });
  page.on('pageerror', (err) => {
    errors.push('[pageerror] ' + (err && err.message ? err.message : String(err)));
  });
  return errors;
}

/**
 * Boot the app pointing at the given workspace. Sets localStorage BEFORE any
 * script runs via addInitScript, navigates, and waits until the native layer
 * is ready and the page has rendered real content (kanban columns or cards).
 */
async function bootWorkspace(page, projectId) {
  // Só semeia se ainda não há workspace escolhido — senão o switchProject (que
  // grava no localStorage e recarrega) seria sobrescrito a cada reload, quebrando
  // o teste de persistência.
  await page.addInitScript(
    ([key, id]) => {
      try { if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, id); } catch (e) { /* noop */ }
    },
    [LS_KEY, projectId]
  );
  await page.goto('/#/kanban', { waitUntil: 'domcontentloaded' });

  // Wait for the native (Supabase) layer to finish booting and selecting a project.
  await page.waitForFunction(
    () => !!(window.CCNative && window.CCNative.isNative && window.CCNative.isNative()),
    null,
    { timeout: 30_000 }
  );

  // Wait for the board to actually render: kanban columns appear once loadData
  // resolves and render() runs.
  await page.waitForSelector('.kanban-col', { timeout: 30_000 });
}

/** Count rendered cards currently on the kanban. */
async function kanbanCardCount(page) {
  return page.locator('.kanban .card[data-card-id]').count();
}

test.describe('Command Center E2E', () => {
  test('1. Boot — Ritmo workspace loads with no JS errors and GitHub content', async ({ page }) => {
    const errors = collectErrors(page);

    await bootWorkspace(page, RITMO_ID);

    // Active workspace should be Ritmo.
    const activeId = await page.evaluate(() => window.CCNative.project && window.CCNative.project.id);
    expect(activeId).toBe(RITMO_ID);

    // Board rendered at least one column.
    expect(await page.locator('.kanban-col').count()).toBeGreaterThan(0);

    // Ritmo content present: either a "🐙 GitHub" list column OR a card referencing a PR.
    const githubCols = await page.locator('.kanban-col', { hasText: 'GitHub' }).count();
    const prCards = await page
      .locator('.kanban .card[data-card-id]')
      .filter({ hasText: /PR #|#\d+/ })
      .count();
    const totalCards = await kanbanCardCount(page);

    expect(totalCards, 'expected Ritmo to render some cards').toBeGreaterThan(0);
    expect(
      githubCols > 0 || prCards > 0,
      `expected a GitHub column (got ${githubCols}) or a PR card (got ${prCards})`
    ).toBeTruthy();

    // No uncaught JS errors during boot.
    expect(errors, `console/page errors during boot:\n${errors.join('\n')}`).toEqual([]);
  });

  test('2. Persistence — cards survive a workspace switch round-trip', async ({ page }) => {
    const errors = collectErrors(page);

    await bootWorkspace(page, RITMO_ID);
    const ritmoCardsBefore = await kanbanCardCount(page);
    expect(ritmoCardsBefore, 'Ritmo should start with cards').toBeGreaterThan(0);

    // The switcher lists projects by id; find the option whose label is "Meu Workspace".
    const select = page.locator('#cc-proj-select');
    await expect(select).toBeVisible();

    const otherId = await page.evaluate(() => {
      const sel = document.getElementById('cc-proj-select');
      if (!sel) return null;
      const opt = Array.from(sel.options).find((o) => /meu workspace/i.test(o.textContent || ''));
      return opt ? opt.value : null;
    });
    expect(otherId, 'expected a "Meu Workspace" option in the switcher').toBeTruthy();
    expect(otherId).not.toBe(RITMO_ID);

    // Switch to Meu Workspace (selectOption triggers onchange -> switchProject -> reload).
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      select.selectOption(/** @type {string} */ (otherId)),
    ]);
    await page.waitForFunction(
      () => !!(window.CCNative && window.CCNative.isNative && window.CCNative.isNative()),
      null,
      { timeout: 30_000 }
    );
    // Land on kanban regardless of where switchProject sent us.
    await page.goto('/#/kanban', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.kanban', { timeout: 30_000 });

    const activeMid = await page.evaluate(() => window.CCNative.project && window.CCNative.project.id);
    expect(activeMid).toBe(otherId);

    // Switch back to Ritmo.
    const select2 = page.locator('#cc-proj-select');
    await expect(select2).toBeVisible();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      select2.selectOption(RITMO_ID),
    ]);
    await page.waitForFunction(
      () => !!(window.CCNative && window.CCNative.isNative && window.CCNative.isNative()),
      null,
      { timeout: 30_000 }
    );
    await page.goto('/#/kanban', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.kanban-col', { timeout: 30_000 });

    const activeBack = await page.evaluate(() => window.CCNative.project && window.CCNative.project.id);
    expect(activeBack).toBe(RITMO_ID);

    // KEY REGRESSION: cards must still be there after the round-trip.
    const ritmoCardsAfter = await kanbanCardCount(page);
    expect(
      ritmoCardsAfter,
      `Ritmo cards vanished after workspace switch round-trip (before=${ritmoCardsBefore}, after=${ritmoCardsAfter})`
    ).toBeGreaterThan(0);

    expect(errors, `console/page errors during switch:\n${errors.join('\n')}`).toEqual([]);
  });

  test('3. Routes — each main route renders without errors', async ({ page }) => {
    const errors = collectErrors(page);
    await bootWorkspace(page, RITMO_ID);

    const routes = ['overview', 'kanban', 'github', 'devs', 'cards'];
    for (const route of routes) {
      await page.evaluate((r) => { window.location.hash = '#/' + r; }, route);
      // #page should contain rendered content (the route handler ran).
      await expect
        .poll(
          async () => {
            const html = await page.locator('#page').innerHTML();
            return html.trim().length;
          },
          { message: `route #/${route} did not render content`, timeout: 15_000 }
        )
        .toBeGreaterThan(0);

      // The loading placeholder must be gone (means render succeeded).
      const stillLoading = await page.locator('#page .loading').count();
      expect(stillLoading, `route #/${route} stuck on loading`).toBe(0);
    }

    expect(errors, `console/page errors across routes:\n${errors.join('\n')}`).toEqual([]);
  });

  test('4. Card modal — clicking a kanban card opens the modal', async ({ page }) => {
    collectErrors(page);
    await bootWorkspace(page, RITMO_ID);

    const firstCard = page.locator('.kanban .card[data-card-id]').first();
    await expect(firstCard).toBeVisible();
    await firstCard.scrollIntoViewIfNeeded();
    await firstCard.click({ force: true });

    const modal = page.locator('#modal');
    // Modal becomes visible by having its `hidden` attribute removed.
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal).not.toHaveAttribute('hidden', /.*/);

    // Modal has content rendered into it.
    const modalContentLen = await page.locator('#modal-content').innerHTML();
    expect(modalContentLen.trim().length).toBeGreaterThan(0);
  });
});
