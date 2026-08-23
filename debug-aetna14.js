// debug-aetna14.js
// Stealth works! Capture FULL URL (no truncation) and all provider fields.
// Also print total count and first 3 providers so we know the full data shape.

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  let providerApiUrl = null;
  let providerApiBody = null;

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('publicdse_providersearch')) {
      try {
        providerApiUrl = url;  // full URL, no truncation
        providerApiBody = await res.text();
      } catch {}
    }
  });

  // ── Navigation (same as aetna13 — stealth confirmed working) ───────────────
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
  await page.keyboard.press('Enter');
  await page.waitForURL('**/providerSearchPlanList**', { timeout: 20000 }).catch(() => {});
  if (!page.url().includes('providerSearchPlanList')) {
    await page.locator('button:has-text("Search")').first().click().catch(() => {});
    await page.waitForURL('**/providerSearchPlanList**', { timeout: 15000 }).catch(() => {});
  }
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  const ppLabel = page.locator('label').filter({ hasText: 'Open Choice' }).first();
  if (await ppLabel.count() > 0) await ppLabel.click();
  await page.waitForTimeout(800);

  const contBtn = page.locator('button:not(.ng-hide):has-text("Continue")').first();
  if (await contBtn.count() > 0) await contBtn.click();
  await page.waitForURL('**/providerSearch**', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  const medLink = page.locator('a, button, li').filter({ hasText: 'Medical Doctors' }).first();
  if (await medLink.count() > 0) await medLink.click();
  await page.waitForURL('**/providerMedical**', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  const specLink = page.locator('a, button, li').filter({ hasText: 'Medical Specialists' }).first();
  if (await specLink.count() > 0) await specLink.click();
  await page.waitForURL('**/providerSearchSpecialists**', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  // Wait for provider search response BEFORE clicking
  const responsePromise = page.waitForResponse(
    res => res.url().includes('publicdse_providersearch'),
    { timeout: 25000 }
  ).catch(() => null);

  const allSpecLink = page.locator('a, button, li').filter({ hasText: 'All Medical Specialists' }).first();
  if (await allSpecLink.count() > 0) await allSpecLink.click();

  await responsePromise;
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // ── Print full API URL ─────────────────────────────────────────────────────
  if (providerApiUrl) {
    console.log('\n=== FULL API URL ===');
    console.log(providerApiUrl);  // No truncation

    const urlObj = new URL(providerApiUrl);
    console.log('\n=== URL PARAMS ===');
    for (const [k, v] of urlObj.searchParams.entries()) {
      console.log(`  ${k} = ${v}`);
    }

    // ── Parse provider data ──────────────────────────────────────────────────
    try {
      const p = JSON.parse(providerApiBody);
      const resp = p?.providersResponse?.readProvidersResponse;
      const providers = resp?.providerInfoResponses || [];
      const totalCount = p?.providersResponse?.totalResultsCount || providers.length;

      console.log(`\n=== PROVIDERS: ${providers.length} returned, ${totalCount} total ===`);

      // Print first 3 providers with all fields
      for (let i = 0; i < Math.min(3, providers.length); i++) {
        const prov = providers[i];
        console.log(`\n--- Provider ${i + 1} ---`);
        console.log(JSON.stringify(prov, null, 2).substring(0, 3000));
      }

      // Print top-level keys of full response
      console.log('\n=== Top-level response keys ===');
      console.log(JSON.stringify(Object.keys(p), null, 2));
      if (p.providersResponse) {
        console.log('providersResponse keys:', Object.keys(p.providersResponse));
        if (p.providersResponse.readProvidersResponse) {
          console.log('readProvidersResponse keys:', Object.keys(p.providersResponse.readProvidersResponse));
        }
        if (p.providersResponse.totalResultsCount !== undefined) {
          console.log('totalResultsCount:', p.providersResponse.totalResultsCount);
        }
      }
    } catch(e) {
      console.log('Parse error:', e.message);
      console.log('Raw (2000):', providerApiBody?.substring(0, 2000));
    }
  } else {
    console.log('No provider search API call captured');
    const txt = await page.evaluate(() => document.body.innerText);
    console.log('Page text:', txt.substring(0, 1000));
  }

  await browser.close();
})();
