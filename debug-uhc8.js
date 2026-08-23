// debug-uhc8.js
// Fix: dismiss the modal dialog with page.evaluate() before doing anything else,
// then use page.evaluate() for all early nav clicks to bypass modal pointer interception.
// Native click only for the location dropdown option (needed for React state update).

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
    if (res.url().includes('graphql') || res.url().includes('uhc')) {
      try { graphql.push({ url: res.url(), body: await res.text() }); } catch {}
    }
  });

  // Step 1: Land on guest-plan-selection
  await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  console.log('Landed on:', page.url());

  // Step 2: Dismiss any modal — try all common close-button patterns via page.evaluate()
  const modalDismissed = await page.evaluate(() => {
    const selectors = [
      '[aria-label="Close"]',
      '[aria-label="close"]',
      '[aria-label="Close dialog"]',
      'button[class*="close"]',
      'button[class*="Close"]',
      '.abyss-icon-button',
      '[data-testid="close-button"]',
      '[data-testid="modal-close"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        el.click();
        return 'dismissed via: ' + sel;
      }
    }
    // Try any button inside a dialog/modal container
    const dialog = document.querySelector('[role="dialog"], [class*="modal"], [class*="dialog"]');
    if (dialog) {
      const btns = Array.from(dialog.querySelectorAll('button'));
      const closeBtn = btns.find(b =>
        b.textContent?.toLowerCase().includes('close') ||
        b.getAttribute('aria-label')?.toLowerCase().includes('close') ||
        b.classList.toString().toLowerCase().includes('close')
      );
      if (closeBtn) { closeBtn.click(); return 'dismissed via dialog button: ' + closeBtn.outerHTML.substring(0, 100); }
      // Last resort: click first button in dialog (often X close)
      if (btns[0]) { btns[0].click(); return 'dismissed via first dialog button: ' + btns[0].outerHTML.substring(0, 80); }
    }
    return 'no modal found';
  });
  console.log('Modal dismiss:', modalDismissed);
  await page.waitForTimeout(800);

  // Step 3: Click "Explore coverage" via page.evaluate() to bypass any remaining overlay
  const exploreClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent?.includes('Explore coverage'));
    if (btn) { btn.click(); return 'clicked: ' + btn.textContent.trim().substring(0, 60); }
    return 'not found. Buttons: ' + btns.map(b => b.textContent?.trim().substring(0, 30)).filter(Boolean).slice(0, 15).join(' | ');
  });
  console.log('Explore coverage:', exploreClicked);

  await page.waitForURL('**/select-coverage-type**', { timeout: 12000 }).catch(() => {
    console.log('select-coverage-type not reached:', page.url());
  });
  await page.waitForTimeout(1000);
  console.log('Coverage type URL:', page.url());

  // Step 4: Click "Explore" (Medical) via page.evaluate()
  const medClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    // First "Explore" button should be for Medical
    const btn = btns.find(b => b.textContent?.trim() === 'Explore' || b.textContent?.includes('Explore'));
    if (btn) { btn.click(); return 'clicked: ' + btn.textContent.trim().substring(0, 60); }
    return 'not found. Buttons: ' + btns.map(b => b.textContent?.trim().substring(0, 30)).filter(Boolean).slice(0, 15).join(' | ');
  });
  console.log('Medical Explore:', medClicked);

  await page.waitForURL('**/plan-selection**', { timeout: 12000 }).catch(() => {
    console.log('plan-selection not reached:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  console.log('Plan selection URL:', page.url());

  // Step 5: Type 77041 into location input, then native-click the dropdown option
  const locInput = page.locator('input[role="combobox"]').first();
  await locInput.click();
  await locInput.fill('77041');
  await page.waitForTimeout(1500);

  // Check if dropdown appeared
  const optCount = await page.locator('[role="option"]').count().catch(() => 0);
  console.log('Dropdown option count:', optCount);

  if (optCount > 0) {
    const optText = await page.locator('[role="option"]').first().textContent().catch(() => '');
    console.log('First option text:', optText);
    // Native click so React fires proper synthetic events
    await page.locator('[role="option"]').first().click();
    console.log('Clicked location option (native)');
  } else {
    // Fallback: page.evaluate click
    const evalOpt = await page.evaluate(() => {
      const opts = Array.from(document.querySelectorAll('[role="option"]'));
      if (opts[0]) { opts[0].click(); return 'eval clicked: ' + opts[0].textContent?.trim(); }
      return 'no options visible. Body snippet: ' + document.body.innerText.substring(0, 500);
    });
    console.log('Fallback option click:', evalOpt);
  }

  // Step 6: Wait for GetPlanDefinitions with location-specific plans (up to 15s)
  console.log('Waiting for location-specific plans...');
  let planText = '';
  let choicePlusFound = false;
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    planText = await page.evaluate(() => document.body.innerText);
    if (planText.toLowerCase().includes('choice plus')) {
      choicePlusFound = true;
      console.log(`Choice Plus appeared after ${i + 1}s`);
      break;
    }
  }

  if (!choicePlusFound) {
    console.log('Choice Plus never appeared. Page text (2000 chars):');
    console.log(planText.substring(0, 2000));
    // Dump GraphQL calls to diagnose
    const planDef = graphql.filter(r => r.url.includes('GetPlanDefinitions')).pop();
    if (planDef) {
      try {
        const p = JSON.parse(planDef.body);
        const names = [
          ...(p?.data?.getPlanDefinitions?.planDetails || []).map(pl => pl.planName),
          ...(p?.data?.getPlanDefinitions?.planCategories || []).flatMap(c => (c.planDetails || []).map(pl => pl.planName)),
        ];
        console.log('Plans from API:', names.join(', '));
      } catch (e) { console.log('Could not parse GetPlanDefinitions'); }
    } else {
      console.log('No GetPlanDefinitions call captured');
    }
    await browser.close();
    return;
  }

  // Step 7: Click "Choice Plus" via page.evaluate() to avoid any overlay issues
  const cpClicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, a, li, div[role="button"], span, h3, h4, p'));
    // Exact match first
    const exact = all.find(el => el.textContent?.trim().toLowerCase() === 'choice plus' && el.offsetParent !== null);
    if (exact) { exact.click(); return 'exact: ' + exact.tagName + ' | ' + exact.textContent.trim(); }
    // Contains but not "Advanced", "Premier", "HMO"
    const cp = all.find(el => {
      const t = el.textContent?.toLowerCase() || '';
      return t.includes('choice plus') && !t.includes('advanced') && !t.includes('premier') && !t.includes('hmo') && el.offsetParent !== null;
    });
    if (cp) { cp.click(); return 'contains: ' + cp.tagName + ' | ' + cp.textContent.trim().substring(0, 80); }
    // Dump what's visible for debugging
    const visible = all.filter(el => el.offsetParent !== null && el.textContent?.trim()).map(el => el.textContent.trim().substring(0, 40)).filter(Boolean).slice(0, 30);
    return 'not found. Visible: ' + JSON.stringify(visible);
  });
  console.log('Choice Plus click:', cpClicked);

  await page.waitForTimeout(4000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  console.log('URL after Choice Plus:', page.url());

  const afterText = await page.evaluate(() => document.body.innerText);
  console.log('\nPage after Choice Plus (5000):\n', afterText.substring(0, 5000));

  // What inputs are on the next page?
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent).map(el => ({
      id: el.id, type: el.type, placeholder: el.placeholder,
      ariaLabel: el.getAttribute('aria-label'), name: el.name,
    }))
  );
  console.log('\nVisible inputs:', JSON.stringify(inputs, null, 2));

  // All GraphQL operations captured
  console.log('\n=== GraphQL operations ===');
  for (const r of graphql) {
    try {
      const u = new URL(r.url);
      console.log(u.searchParams.get('q') || r.url.substring(0, 120));
    } catch { console.log(r.url.substring(0, 120)); }
  }

  await browser.close();
})();
