// debug-aetna12.js
// Use Playwright native locator clicks throughout (fires Angular zone.js events properly).
// Continue button: use :not(.ng-hide) selector to get the visible one specifically.
// Broader API URL capture to catch any Aetna API call.

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  // Capture ALL aetna.com API calls so we don't miss any
  const captured = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('api01.aetna.com') || url.includes('aetna.com/healthcore')) {
      try { captured.push({ url, status: res.status(), body: await res.text() }); } catch {}
    }
  });

  // ── Step 1: ZIP ───────────────────────────────────────────────────────────
  await page.goto('https://www.aetna.com/dsepublic/#/contentPage?page=providerSearchLanding&site_id=dse&language=en', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(2000);
  await page.waitForSelector('#zip1', { timeout: 10000 });
  await page.click('#zip1', { clickCount: 3 });
  await page.type('#zip1', '77041', { delay: 100 });
  await page.evaluate(() => {
    const el = document.querySelector('#zip1');
    el?.dispatchEvent(new Event('input', { bubbles: true }));
    el?.dispatchEvent(new Event('change', { bubbles: true }));
    el?.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  // Use native Playwright click on Search button (fires Angular events)
  await page.keyboard.press('Enter');
  await page.waitForURL('**/providerSearchPlanList**', { timeout: 20000 }).catch(() => {});
  if (!page.url().includes('providerSearchPlanList')) {
    await page.locator('button:has-text("Search")').first().click().catch(() => {});
    await page.waitForURL('**/providerSearchPlanList**', { timeout: 15000 }).catch(() => {});
  }
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('Plan list URL:', page.url());

  // ── Step 2: Select Open Choice PPO — native click on label ───────────────
  await page.waitForTimeout(800);
  // Playwright native label click
  const ppLabel = page.locator('label').filter({ hasText: 'Open Choice' }).first();
  if (await ppLabel.count() > 0) {
    await ppLabel.click();
    console.log('Clicked Open Choice PPO label (native)');
  } else {
    // Fallback: radio click
    await page.locator('input[type="radio"][value*="MPPO"]').first().click().catch(() => {});
    console.log('Clicked MPPO radio (native)');
  }
  await page.waitForTimeout(800);

  // ── Step 3: Continue button — VISIBLE only via :not(.ng-hide) ────────────
  // Playwright's CSS filter will match only the button without ng-hide class
  const contBtn = page.locator('button:not(.ng-hide):has-text("Continue")').first();
  const contCount = await contBtn.count();
  console.log('Visible Continue buttons found:', contCount);
  if (contCount > 0) {
    const contId = await contBtn.getAttribute('id').catch(() => '');
    console.log('Continue button id:', contId);
    await contBtn.click();
    console.log('Clicked Continue (native, not ng-hide)');
  } else {
    // Fallback: evaluate click
    await page.evaluate(() => {
      const cont = Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent?.includes('Continue') && !b.classList.contains('ng-hide') && b.offsetParent !== null
      );
      if (cont) cont.click();
    });
    console.log('Clicked Continue (fallback evaluate)');
  }

  await page.waitForURL('**/providerSearch**', { timeout: 15000 }).catch(() => {
    console.log('providerSearch not reached:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('providerSearch:', page.url());
  await page.waitForTimeout(1000);

  // ── Step 4: Medical Doctors — native click ────────────────────────────────
  const medLink = page.locator('a, button, li').filter({ hasText: 'Medical Doctors' }).first();
  if (await medLink.count() > 0) {
    await medLink.click();
    console.log('Clicked Medical Doctors (native)');
  } else {
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('a, button, li, span')).find(el => el.offsetParent !== null && el.textContent?.includes('Medical Doctors'))?.click();
    });
    console.log('Clicked Medical Doctors (fallback)');
  }
  await page.waitForURL('**/providerMedical**', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('providerMedical:', page.url());
  await page.waitForTimeout(800);

  // ── Step 5: Medical Specialists — native click ───────────────────────────
  const specLink = page.locator('a, button, li').filter({ hasText: 'Medical Specialists' }).first();
  if (await specLink.count() > 0) {
    await specLink.click();
    console.log('Clicked Medical Specialists (native)');
  } else {
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('a, button, li, span')).find(el => el.offsetParent !== null && el.textContent?.includes('Medical Specialists') && !el.textContent?.includes('All'))?.click();
    });
    console.log('Clicked Medical Specialists (fallback)');
  }
  await page.waitForURL('**/providerSearchSpecialists**', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('providerSearchSpecialists:', page.url());
  await page.waitForTimeout(800);

  // ── Step 6: All Medical Specialists — native click ───────────────────────
  // Set up response capture BEFORE clicking so we don't miss fast responses
  const responsePromise = page.waitForResponse(
    res => res.url().includes('api01.aetna.com'),
    { timeout: 20000 }
  ).catch(() => null);

  const allSpecLink = page.locator('a, button, li').filter({ hasText: 'All Medical Specialists' }).first();
  if (await allSpecLink.count() > 0) {
    await allSpecLink.click();
    console.log('Clicked All Medical Specialists (native)');
  } else {
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('a, button, li, span')).find(el => el.offsetParent !== null && el.textContent?.includes('All Medical Specialists'))?.click();
    });
    console.log('Clicked All Medical Specialists (fallback)');
  }

  const capturedResponse = await responsePromise;
  if (capturedResponse) {
    console.log('First API response after click:', capturedResponse.url().substring(0, 200));
  } else {
    console.log('No API response captured within 20s');
  }

  await page.waitForURL('**/providerResults**', { timeout: 25000 }).catch(() => {
    console.log('Final URL after category:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log('Final URL:', page.url());

  // ── Print ALL captured API calls ─────────────────────────────────────────
  console.log(`\nTotal captured API calls: ${captured.length}`);
  for (const c of captured) {
    const isProviderSearch = c.url.includes('providersearch') || c.url.includes('publicdse_provider');
    console.log(`${isProviderSearch ? '★' : ' '} [${c.status}] ${c.url.substring(0, 200)}`);
    if (isProviderSearch) {
      try {
        const p = JSON.parse(c.body);
        const key = Object.keys(p).find(k => Array.isArray(p[k]) && p[k].length > 0);
        if (key) {
          console.log(`  ✅ ${p[key].length} providers under "${key}"`);
          console.log('  Keys:', Object.keys(p[key][0]));
          console.log('  First provider:', JSON.stringify(p[key][0], null, 2).substring(0, 2000));
        } else {
          console.log('  Body:', JSON.stringify(p, null, 2).substring(0, 1000));
        }
      } catch { console.log('  Raw:', c.body.substring(0, 500)); }
    }
  }

  if (captured.filter(c => c.url.includes('providersearch')).length === 0) {
    const txt = await page.evaluate(() => document.body.innerText);
    console.log('\nPage text:', txt.substring(0, 2000));
  }

  await browser.close();
})();
