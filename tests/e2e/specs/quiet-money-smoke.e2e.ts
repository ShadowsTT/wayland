/**
 * E2E smoke: Quiet Money assistant kickoff card mounts and renders.
 *
 * Validates the v1 ship of the Quiet Money preset assistant:
 *  - Assistant resolves via the bundle (custom:ext-quiet-money)
 *  - SuggestionEngine returns a kickoff for it (7 entries in vendored overlay)
 *  - KickoffCard mounts below the input with the expected text patterns
 *
 * Sister-spec to kickoff-card.e2e.ts but scoped to the Quiet Money entry
 * specifically — verifies the bundle dual-write (live + fixture + vendored
 * overlay) actually wired through to the engine.
 */

import { test, expect } from '../fixtures';
import { invokeBridge, navigateTo, ROUTES } from '../helpers';

const KICKOFF_CARD = '[data-testid="new-chat-kickoff-card"]';
const KICKOFF_BODY = '[data-testid="new-chat-kickoff-body"]';
const GUID_TEXTAREA = 'textarea.arco-textarea';

const QM_KEY = 'custom:ext-quiet-money';

test('Quiet Money — kickoff card mounts for ext-quiet-money preset', async ({ page }) => {
  // Seed the preset selection + verify it round-tripped (per banked
  // feedback-questions-need-recommendations: defeat the reload race).
  await invokeBridge(page, 'agent.config.storage.set', {
    key: 'guid.lastSelectedAgent',
    data: QM_KEY,
  });
  const verified = await invokeBridge<string | null>(
    page,
    'agent.config.storage.get',
    'guid.lastSelectedAgent'
  );
  expect(verified).toBe(QM_KEY);

  await navigateTo(page, ROUTES.guid);
  await page.reload();
  await page.locator(GUID_TEXTAREA).first().waitFor({ state: 'visible', timeout: 10_000 });
  await expect(page.locator(KICKOFF_CARD)).toBeVisible({ timeout: 10_000 });

  // Kickoff body present and non-trivial — proves the engine returned a
  // suggestion (not a no-kickoffs-defined miss).
  const bodyText = (await page.locator(KICKOFF_BODY).textContent()) ?? '';
  expect(bodyText.length).toBeGreaterThan(30);

  // Sanity: the kickoff text should reference Quiet Money idioms (Boring
  // Path, Quiet Test, Enough Number, 12-month rule, career trajectory,
  // pickup, or first-time). One of the 7 kickoffs must match.
  const knownIdioms = [
    /boring path/i,
    /quiet test/i,
    /enough number/i,
    /12-month rule/i,
    /career trajectory/i,
    /pick up where we left/i,
    /first time/i,
  ];
  const matched = knownIdioms.some((re) => re.test(bodyText));
  expect(matched).toBe(true);
});
