// debug-uhc9.js
// Fix: use keyboard (ArrowDown + Enter) to select location option instead of mouse click.
// React controlled comboboxes update state from keyboard events more reliably.

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
    if (res.url().includes('graphql') || res.url().includes('uhc.com')) {
      try { graphql.push({ url: res.url(), body: await res.text() }); } catch {}
    }
  });

  // Step 1: Landing
  await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Step 2: Dismiss modal via evaluate
  const modalDismissed = await page.evaluate(() => {
    const selectors = ['[aria-label="Close"]', '[aria-label="close"]', 'button[class*="close"]', '.abyss-icon-button'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { el.click(); return 'dismissed: ' + sel; }
    }
    const dialog = document.querySelector('[role="dialog"], [class*="modal"]');
    if (dialog) {
      const btns = Array.from(dialog.querySelectorAll('button'));
      const cb = btns.find(b => b.textContent?.toLowerCase().includes('close') || b.getAttribute('aria-label')?.toLowerCase().includes('close'));
      if (cb) { cb.click(); return 'dialog close btn'; }
      if (btns[0]) { btns[0].click(); return 'first dialog btn'; }
    }
    return 'no modal';
  });
  console.log('Modal:', modalDismissed);
  await page.waitForTimeout(800);

  // Step 3: Explore coverage (via evaluate)
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Explore coverage'));
    if (btn) btn.click();
  });
  await page.waitForURL('**/select-coverage-type**', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1000);
  console.log('Coverage type:', page.url());

  // Step 4: Explore Medical (via evaluate)
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim().startsWith('Explore'));
    if (btn) btn.click();
  });
  await page.waitForURL('**/plan-selection**', { timeout: 12000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  console.log('Plan selection:', page.url());

  // Step 5: Location — click input, type 77041, then keyboard select
  const locInput = page.locator('input[role="combobox"]').first();
  await locInput.click();
  await locInput.fill('');
  await page.waitForTimeout(300);
  await locInput.type('77041', { delay: 80 });
  await page.waitForTimeout(1500);

  // Check dropdown appeared
  const optCount = await page.locator('[role="option"]').count().catch(() => 0);
  const optText = optCount > 0 ? await page.locator('[role="option"]').first().textContent().catch(() => '') : '';
  console.log(`Options: ${optCount}, first: "${optText}"`);

  if (optCount > 0) {
    // Use ArrowDown to highlight first option, then Enter to confirm — triggers React onChange
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    console.log('Selected via ArrowDown + Enter');
  } else {
    // Fallback: try Tab to select highlighted, or evaluate click
    await page.keyboard.press('Tab');
    console.log('No options visible, tried Tab');
  }

  await page.waitForTimeout(1000);

  // Check if location is now set in UI
  const locValue = await locInput.inputValue().catch(() => '');
  console.log('Location input value after selection:', locValue);

  // Wait up to 20s for plans to render
  console.log('Waiting for plans...');
  let planText = '';
  let choicePlusFound = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    planText = await page.evaluate(() => document.body.innerText);
    if (planText.toLowerCase().includes('choice plus')) {
      choicePlusFound = true;
      console.log(`Choice Plus visible in UI after ${i + 1}s`);
      break;
    }
    if (i % 5 === 4) {
      // Every 5s, dump the location area and any React updates
      const locArea = await page.evaluate(() => {
        const locEl = document.querySelector('input[role="combobox"]');
        return locEl ? 'input value: ' + locEl.value : 'no combobox';
      });
      console.log(`t=${i+1}s: ${locArea}`);
    }
  }

  if (!choicePlusFound) {
    console.log('Choice Plus never appeared in UI. Page text (2000):\n', planText.substring(0, 2000));
    // Check what GetPlanDefinitions returned
    const planDef = graphql.filter(r => r.url.includes('GetPlanDefinitions')).pop();
    if (planDef) {
      try {
        const p = JSON.parse(planDef.body);
        const names = [
          ...(p?.data?.getPlanDefinitions?.planDetails || []).map(pl => pl.planName),
          ...(p?.data?.getPlanDefinitions?.planCategories || []).flatMap(c => (c.planDetails || []).map(pl => pl.planName)),
        ];
        console.log('API plans:', names.join(', '));
      } catch {}
    } else {
      console.log('No GetPlanDefinitions fired');
    }

    // Dump the location input's current value and the full set of inputs on the page
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(el => ({
        role: el.getAttribute('role'), value: el.value, placeholder: el.placeholder, ariaLabel: el.getAttribute('aria-label'),
      }))
    );
    console.log('All inputs:', JSON.stringify(inputs));

    await browser.close();
    return;
  }

  // Step 6: Click "Choice Plus" via evaluate
  const cpClicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, a, li, div[role="button"], span, h3, h4, p'));
    const exact = all.find(el => el.textContent?.trim().toLowerCase() === 'choice plus' && el.offsetParent !== null);
    if (exact) { exact.click(); return 'exact: ' + exact.tagName + ' | ' + exact.textContent.trim(); }
    const cp = all.find(el => {
      const t = el.textContent?.toLowerCase() || '';
      return t.includes('choice plus') && !t.includes('advanced') && !t.includes('premier') && !t.includes('hmo') && el.offsetParent !== null;
    });
    if (cp) { cp.click(); return 'contains: ' + cp.tagName + ' | ' + cp.textContent.trim().substring(0, 80); }
    const visible = all.filter(el => el.offsetParent !== null && el.textContent?.trim()).map(el => el.textContent.trim().substring(0, 40)).filter(Boolean).slice(0, 30);
    return 'not found. Visible: ' + JSON.stringify(visible);
  });
  console.log('Choice Plus click:', cpClicked);

  await page.waitForTimeout(4000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  console.log('URL after Choice Plus:', page.url());

  const afterText = await page.evaluate(() => document.body.innerText);
  console.log('\nPage after Choice Plus (5000):\n', afterText.substring(0, 5000));

  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent).map(el => ({
      id: el.id, type: el.type, placeholder: el.placeholder, ariaLabel: el.getAttribute('aria-label'), name: el.name,
    }))
  );
  console.log('\nVisible inputs:', JSON.stringify(inputs, null, 2));

  console.log('\n=== GraphQL ops ===');
  for (const r of graphql) {
    try { console.log(new URL(r.url).searchParams.get('q') || r.url.substring(0, 100)); } catch { console.log(r.url.substring(0, 100)); }
  }

  await browser.close();
})();
