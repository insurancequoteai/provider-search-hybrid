// debug-aetna6.js
// Use Playwright native clicks (not page.evaluate el.click()) so Angular fires properly.
// Click "Medical Doctors & Specialists" category to search, then capture the API response.

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const captured = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('aetna.com') && (url.includes('providersearch') || url.includes('provider') || url.includes('healthcore'))) {
      try { captured.push({ url, status: res.status(), body: await res.text() }); } catch {}
    }
  });

  // ── Step 1: Landing → ZIP ──────────────────────────────────────────────────
  await page.goto('https://www.aetna.com/dsepublic/#/contentPage?page=providerSearchLanding&site_id=dse&language=en', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(2000);
  await page.waitForSelector('#zip1', { timeout: 10000 });
  await page.click('#zip1', { clickCount: 3 });
  await page.type('#zip1', '77041', { delay: 80 });
  await page.waitForTimeout(400);

  // Native click on Search button (Playwright synthesizes proper events)
  await page.locator('button:has-text("Search")').first().click().catch(async () => {
    // Fallback: Enter key
    await page.keyboard.press('Enter');
  });
  await page.waitForURL('**/providerSearchPlanList**', { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('Plan list URL:', page.url());

  // ── Step 2: Select Open Choice PPO via label click ─────────────────────────
  await page.waitForTimeout(500);
  // Use locator to find the label containing "Open Choice"
  const ppLabel = page.locator('label').filter({ hasText: 'Open Choice' }).first();
  if (await ppLabel.count() > 0) {
    await ppLabel.click();
    console.log('Clicked Open Choice PPO label');
  } else {
    // Fallback: radio by value
    const radio = page.locator('input[type="radio"][value*="MPPO"]').first();
    if (await radio.count() > 0) await radio.click();
    console.log('Clicked MPPO radio');
  }
  await page.waitForTimeout(400);

  // Continue button
  await page.locator('button:has-text("Continue")').first().click();
  await page.waitForURL('**/providerSearch**', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('Provider search URL:', page.url());
  await page.waitForTimeout(1500);

  // ── Step 3: Click "Medical Doctors & Specialists" via Playwright native click
  console.log('Looking for Medical Doctors category...');
  // Try different selectors
  const medLocator = page.locator('text=Medical Doctors & Specialists').first();
  const medLocator2 = page.locator('text=Medical Doctors').first();

  if (await medLocator.count() > 0) {
    // Set up response capture BEFORE clicking
    const responsePromise = page.waitForResponse(
      res => res.url().includes('providersearch') || res.url().includes('publicdse_provider'),
      { timeout: 20000 }
    ).catch(() => null);

    await medLocator.click();
    console.log('Clicked "Medical Doctors & Specialists"');

    const res = await responsePromise;
    if (res) console.log('Captured response:', res.url().substring(0, 150));

    await page.waitForURL('**/providerResults**', { timeout: 20000 }).catch(() => {
      console.log('URL after category click:', page.url());
    });
  } else if (await medLocator2.count() > 0) {
    await medLocator2.click();
    console.log('Clicked "Medical Doctors" (partial match)');
    await page.waitForURL('**/providerResults**', { timeout: 20000 }).catch(() => {});
  } else {
    // Fallback: dump what IS on the page and try anything medical
    const pageLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a, button, li[role], div[role="button"]'))
        .filter(el => el.offsetParent)
        .map(el => el.textContent?.trim().substring(0, 80))
        .filter(Boolean)
    );
    console.log('Visible clickable elements:', pageLinks);

    // Try clicking the first one that has "Medical" or just search by category
    const anyMed = page.locator('[class*="category"], [class*="card"], [class*="option"]').filter({ hasText: 'Medical' }).first();
    if (await anyMed.count() > 0) {
      await anyMed.click();
      console.log('Clicked medical via class selector');
    }
    await page.waitForURL('**/providerResults**', { timeout: 20000 }).catch(() => {});
  }

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log('Final URL:', page.url());

  // Print all captured API calls
  console.log('\n=== All captured Aetna API calls ===');
  for (const c of captured) {
    console.log('\nURL:', c.url.substring(0, 200));
    console.log('Status:', c.status);
    if (c.url.includes('providersearch') || c.url.includes('publicdse_provider')) {
      try {
        const p = JSON.parse(c.body);
        const key = Object.keys(p).find(k => Array.isArray(p[k]) && p[k].length > 0);
        if (key) {
          console.log(`✅ ${p[key].length} results under "${key}"`);
          console.log('Keys:', Object.keys(p[key][0]));
          console.log('First result:\n', JSON.stringify(p[key][0], null, 2).substring(0, 3000));
        } else {
          console.log(JSON.stringify(p, null, 2).substring(0, 2000));
        }
      } catch { console.log('Raw:', c.body.substring(0, 1000)); }
    }
  }

  if (captured.length === 0) {
    const txt = await page.evaluate(() => document.body.innerText);
    console.log('\nPage text:', txt.substring(0, 2000));
  }

  await browser.close();
})();
