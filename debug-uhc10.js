// debug-uhc10.js
// Fix: use page.mouse.click() at element's bounding box coordinates — the most realistic
// click simulation. Also capture GetPlanDefinitions response for plan IDs as fallback.

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const graphqlResponses = [];
  page.on('response', async res => {
    if (res.url().includes('graphql') || res.url().includes('uhc.com')) {
      try { graphqlResponses.push({ url: res.url(), body: await res.text() }); } catch {}
    }
  });

  // Step 1: Landing
  await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Step 2: Dismiss modal
  const modalDismissed = await page.evaluate(() => {
    const selectors = ['[aria-label="Close"]', '[aria-label="close"]', 'button[class*="close"]'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { el.click(); return 'dismissed: ' + sel; }
    }
    const dialog = document.querySelector('[role="dialog"], [class*="modal"]');
    if (dialog) {
      const btns = Array.from(dialog.querySelectorAll('button'));
      const cb = btns.find(b => b.getAttribute('aria-label')?.toLowerCase().includes('close') || b.textContent?.toLowerCase().includes('close'));
      if (cb) { cb.click(); return 'dialog close'; }
      if (btns[0]) { btns[0].click(); return 'first dialog btn'; }
    }
    return 'no modal';
  });
  console.log('Modal:', modalDismissed);
  await page.waitForTimeout(800);

  // Step 3-4: Navigate to plan-selection via evaluate (bypasses any overlay)
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Explore coverage'))?.click();
  });
  await page.waitForURL('**/select-coverage-type**', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim().startsWith('Explore'))?.click();
  });
  await page.waitForURL('**/plan-selection**', { timeout: 12000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  console.log('Plan selection:', page.url());

  // Step 5: Type location into combobox
  const locInput = page.locator('input[role="combobox"]').first();
  await locInput.click();
  await locInput.fill('');
  await page.waitForTimeout(200);
  await locInput.type('77041', { delay: 80 });
  await page.waitForTimeout(1500);

  // Wait for option to appear
  await page.waitForSelector('[role="option"]', { timeout: 8000 }).catch(() => console.log('No options appeared'));
  const optCount = await page.locator('[role="option"]').count().catch(() => 0);
  const optText = optCount > 0 ? await page.locator('[role="option"]').first().textContent().catch(() => '') : '';
  console.log(`Options: ${optCount}, first: "${optText}"`);

  if (optCount > 0) {
    // Get bounding box of the first option and click at its center via page.mouse
    const optEl = await page.$('[role="option"]');
    const box = await optEl?.boundingBox();
    if (box) {
      console.log('Option bounding box:', JSON.stringify(box));
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      console.log('Clicked via page.mouse.click at coordinates');
    } else {
      // Fallback: native locator click
      await page.locator('[role="option"]').first().click({ force: true });
      console.log('Clicked via locator force click');
    }
  } else {
    console.log('No options — cannot select location');
    await browser.close();
    return;
  }

  await page.waitForTimeout(1000);

  // Check location state
  const locValue = await locInput.inputValue().catch(() => '');
  const pageText1 = await page.evaluate(() => document.body.innerText.substring(0, 200));
  console.log('Input value:', locValue);
  console.log('Page snippet:', pageText1);

  // Wait up to 20s for plans
  console.log('Waiting for plans...');
  let planText = '';
  let choicePlusFound = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    planText = await page.evaluate(() => document.body.innerText);
    if (planText.toLowerCase().includes('choice plus')) {
      choicePlusFound = true;
      console.log(`✅ Choice Plus appeared after ${i + 1}s`);
      break;
    }
    if (i % 5 === 4) {
      const locLabel = await page.evaluate(() => {
        // Check what the location selector shows
        const combobox = document.querySelector('input[role="combobox"]');
        const locSection = document.querySelector('[data-testid*="location"], [class*="location"]');
        return JSON.stringify({ inputVal: combobox?.value, locText: locSection?.textContent?.trim().substring(0, 80) });
      });
      console.log(`t=${i+1}s: ${locLabel}`);
    }
  }

  // Capture GetPlanDefinitions response regardless
  const planDefRes = graphqlResponses.filter(r => r.url.includes('GetPlanDefinitions')).pop();
  let choicePlusPlan = null;
  if (planDefRes) {
    try {
      const p = JSON.parse(planDefRes.body);
      const allPlans = [
        ...(p?.data?.getPlanDefinitions?.planDetails || []),
        ...(p?.data?.getPlanDefinitions?.planCategories || []).flatMap(c => c.planDetails || []),
      ];
      choicePlusPlan = allPlans.find(pl => pl.planName?.toLowerCase() === 'choice plus' && !pl.planName?.toLowerCase().includes('advanced') && !pl.planName?.toLowerCase().includes('premier') && !pl.planName?.toLowerCase().includes('hmo'));
      console.log('\nChoice Plus plan from API:', JSON.stringify(choicePlusPlan, null, 2));
      console.log('\nAll plan names:', allPlans.map(p => p.planName).join(', '));
    } catch (e) { console.log('Parse error:', e.message); }
  } else {
    console.log('No GetPlanDefinitions response captured');
  }

  if (!choicePlusFound) {
    console.log('\nPlans never appeared. Page text (2000):\n', planText.substring(0, 2000));
    await browser.close();
    return;
  }

  // Step 6: Click Choice Plus
  const cpClicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, a, li, div[role="button"], span, h3, h4, p'));
    const exact = all.find(el => el.textContent?.trim().toLowerCase() === 'choice plus' && el.offsetParent !== null);
    if (exact) { exact.click(); return 'exact: ' + exact.tagName; }
    const cp = all.find(el => {
      const t = el.textContent?.toLowerCase() || '';
      return t.includes('choice plus') && !t.includes('advanced') && !t.includes('premier') && !t.includes('hmo') && el.offsetParent !== null;
    });
    if (cp) { cp.click(); return 'contains: ' + cp.tagName + ' | ' + cp.textContent.trim().substring(0, 60); }
    return 'not found';
  });
  console.log('Choice Plus click:', cpClicked);

  await page.waitForTimeout(4000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  console.log('URL after Choice Plus:', page.url());

  const afterText = await page.evaluate(() => document.body.innerText);
  console.log('\nPage after Choice Plus (5000):\n', afterText.substring(0, 5000));

  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent).map(el => ({
      id: el.id, placeholder: el.placeholder, ariaLabel: el.getAttribute('aria-label'),
    }))
  );
  console.log('\nVisible inputs:', JSON.stringify(inputs, null, 2));

  console.log('\n=== All GraphQL ops ===');
  for (const r of graphqlResponses) {
    try { console.log(new URL(r.url).searchParams.get('q') || r.url.substring(0, 100)); }
    catch { console.log(r.url.substring(0, 100)); }
  }

  await browser.close();
})();
