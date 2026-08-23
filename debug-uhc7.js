// debug-uhc7.js
// Use Playwright's native page.click() so React's synthetic events fire properly.
// After location selection, wait for plans to render, then click Choice Plus.

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const graphql = [];
  page.on('response', async res => {
    if (res.url().includes('graphql') && res.url().includes('uhc')) {
      try { graphql.push({ q: new URL(res.url()).searchParams.get('q'), body: await res.text() }); } catch {}
    }
  });

  // Steps 1-3: Employer → Medical → plan-selection
  await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  // Native click on first "Explore coverage" (Employer and Individual)
  await page.locator('button:has-text("Explore coverage")').first().click();
  await page.waitForURL('**/select-coverage-type**', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // Native click on first "Explore" (Medical)
  await page.locator('button:has-text("Explore")').first().click();
  await page.waitForURL('**/plan-selection**', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  console.log('On plan-selection:', page.url());

  // Step 4: Type 77041 in location combobox, then use native click on dropdown option
  const locInput = page.locator('input[role="combobox"]').first();
  await locInput.click();
  await locInput.fill('77041');
  await page.waitForTimeout(1500);

  // Wait for the dropdown option to appear, then native-click it
  await page.waitForSelector('[role="option"]', { timeout: 8000 }).catch(() => console.log('No options appeared'));
  const optionText = await page.locator('[role="option"]').first().textContent().catch(() => '');
  console.log('First dropdown option:', optionText);

  // Native click using Playwright (triggers React synthetic events)
  await page.locator('[role="option"]').first().click();
  console.log('Clicked location option');

  // Wait for GetPlanDefinitions to fire with Houston-specific plans
  console.log('Waiting for plans to load (up to 15s)...');
  const planDefPromise = page.waitForResponse(
    res => res.url().includes('GetPlanDefinitions'),
    { timeout: 15000 }
  ).catch(() => null);

  await page.waitForTimeout(2000);
  const planDefRes = await planDefPromise;
  if (planDefRes) {
    console.log('GetPlanDefinitions fired after location select!');
    try {
      const body = await planDefRes.text().catch(() => '{}');
      const parsed = JSON.parse(body);
      const plans = parsed?.data?.getPlanDefinitions;
      if (plans) {
        const names = (plans.planDetails || []).map(p => p.planName)
          .concat((plans.planCategories || []).flatMap(c => (c.planDetails || []).map(p => p.planName)));
        console.log('Plans returned:', names.slice(0, 30).join(', '));
      }
    } catch {}
  } else {
    console.log('GetPlanDefinitions did not fire after location select');
  }

  // Wait for Choice Plus to appear in the UI
  let found = false;
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    const txt = await page.evaluate(() => document.body.innerText);
    if (txt.toLowerCase().includes('choice plus')) {
      found = true;
      console.log(`Choice Plus appeared in UI after ${i + 1}s`);
      break;
    }
  }

  if (!found) {
    console.log('Choice Plus never appeared. Current page text:');
    console.log(await page.evaluate(() => document.body.innerText.substring(0, 2000)));
    await browser.close();
    return;
  }

  // Step 5: Native click on "Choice Plus" (not Advanced, not Premier, not HMO)
  // Use locator with exact text match
  let cpClicked = false;
  const cpLocators = [
    page.locator('text="Choice Plus"'),
    page.locator('button:has-text("Choice Plus")').filter({ hasNotText: 'Advanced' }).filter({ hasNotText: 'Premier' }).filter({ hasNotText: 'HMO' }),
    page.locator('li:has-text("Choice Plus")').filter({ hasNotText: 'Advanced' }).first(),
  ];
  for (const loc of cpLocators) {
    try {
      const count = await loc.count();
      if (count > 0) {
        const text = await loc.first().textContent();
        console.log('Clicking:', text?.trim().substring(0, 60));
        await loc.first().click();
        cpClicked = true;
        break;
      }
    } catch {}
  }
  if (!cpClicked) console.log('Could not click Choice Plus');

  await page.waitForTimeout(4000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  console.log('URL after plan click:', page.url());

  const afterText = await page.evaluate(() => document.body.innerText);
  console.log('\nPage after Choice Plus (first 5000):\n', afterText.substring(0, 5000));

  // Search inputs on next page
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent).map(el => ({
      id: el.id, type: el.type, placeholder: el.placeholder,
      ariaLabel: el.getAttribute('aria-label'), name: el.name,
    }))
  );
  console.log('\nSearch inputs:', JSON.stringify(inputs, null, 2));

  // All GraphQL calls
  console.log('\n=== GraphQL calls ===');
  graphql.forEach(r => console.log(r.q));

  await browser.close();
})();
