// debug-aetna13.js
// Add stealth plugin. After navigation reaches providerResults still showing "We're Sorry",
// try calling publicdse_providersearch directly from page context (using existing session cookies).
// Also try intercepting the Angular $http service to see what params it would use.

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

  const captured = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('api01.aetna.com') || url.includes('aetna.com/healthcore')) {
      try { captured.push({ url, status: res.status(), body: await res.text() }); } catch {}
    }
  });

  // ── Full navigation flow ───────────────────────────────────────────────────
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
  console.log('Plan list URL:', page.url());

  const ppLabel = page.locator('label').filter({ hasText: 'Open Choice' }).first();
  if (await ppLabel.count() > 0) { await ppLabel.click(); console.log('Clicked Open Choice PPO'); }
  await page.waitForTimeout(800);

  const contBtn = page.locator('button:not(.ng-hide):has-text("Continue")').first();
  if (await contBtn.count() > 0) { await contBtn.click(); console.log('Clicked Continue'); }
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

  const allSpecLink = page.locator('a, button, li').filter({ hasText: 'All Medical Specialists' }).first();
  if (await allSpecLink.count() > 0) await allSpecLink.click();
  await page.waitForURL('**/providerResults**', { timeout: 25000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  console.log('Final URL:', page.url());
  const providerCalls = captured.filter(c => c.url.includes('providersearch'));
  console.log(`Provider search API calls with stealth: ${providerCalls.length}`);

  // ── Regardless of result, try direct API call from page context ───────────
  // The page already has valid aetna.com session cookies so Akamai may allow it
  console.log('\nTrying direct fetch from page context (has session cookies)...');

  const directResult = await page.evaluate(async () => {
    const base = 'https://api01.aetna.com/healthcore/prod/v3/publicdse_providersearch';
    const tries = [
      // Guided search params (what Angular uses after clicking "All Medical Specialists")
      'postalCode=77041&siteId=dse&planCode=MPPO&searchText=All%20Medical%20Specialists&isGuidedSearch=true&radius=25&startIndex=0&pageSize=10&responseLanguagePreference=en',
      // Free-text cardiologist
      'postalCode=77041&siteId=dse&planCode=MPPO&searchText=Cardiologist&isGuidedSearch=false&radius=25&startIndex=0&pageSize=10&responseLanguagePreference=en',
      // Specialty code approach
      'postalCode=77041&siteId=dse&planCode=MPPO&specialtyCode=CA&radius=25&startIndex=0&pageSize=10&responseLanguagePreference=en',
      // Without planCode (maybe it's different)
      'postalCode=77041&siteId=dse&networkId=MPPO&searchText=Cardiologist&radius=25&startIndex=0&pageSize=10&responseLanguagePreference=en',
    ];

    const results = [];
    for (const qs of tries) {
      try {
        const res = await fetch(`${base}?${qs}`, {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.aetna.com/',
          }
        });
        const text = await res.text();
        results.push({ qs: qs.substring(0, 80), status: res.status, preview: text.substring(0, 200) });
        // Stop on first success
        if (res.ok) break;
      } catch(e) {
        results.push({ qs: qs.substring(0, 80), error: e.message });
      }
    }
    return results;
  });

  for (const r of directResult) {
    console.log('\n---');
    console.log('Params:', r.qs);
    if (r.error) { console.log('Error:', r.error); continue; }
    console.log('Status:', r.status);
    console.log('Preview:', r.preview);
    if (r.status === 200) {
      try {
        const p = JSON.parse(r.preview + '...');  // will likely fail but try
        console.log('Keys:', Object.keys(p));
      } catch {}
    }
  }

  // Also try to peek at Angular's internal state to find the plan code it uses
  const angularState = await page.evaluate(() => {
    try {
      // Angular services on $rootScope
      const rootEl = document.querySelector('[ng-app]') || document.body;
      const $injector = angular.element(rootEl).injector();
      if (!$injector) return 'no injector';

      const planSvc = $injector.get('PlanSearchService') || $injector.get('planService') || $injector.get('PlanService');
      const searchSvc = $injector.get('ProviderSearchService') || $injector.get('providerSearchService');
      const session = $injector.get('SessionService') || $injector.get('sessionService');

      return {
        planSvc: planSvc ? Object.keys(planSvc) : 'not found',
        searchSvc: searchSvc ? Object.keys(searchSvc) : 'not found',
        session: session ? JSON.stringify(session).substring(0, 300) : 'not found',
      };
    } catch(e) { return 'error: ' + e.message; }
  });
  console.log('\nAngular state:', JSON.stringify(angularState, null, 2).substring(0, 500));

  // Try to get the plan code from $rootScope
  const rootScope = await page.evaluate(() => {
    try {
      const rootEl = document.querySelector('[ng-app]') || document.body;
      const scope = angular.element(rootEl).scope().$root;
      return JSON.stringify({
        planCode: scope.planCode,
        selectedPlan: scope.selectedPlan,
        planData: scope.planData,
        userPlan: scope.userPlan,
        searchParams: scope.searchParams,
      }).substring(0, 500);
    } catch(e) { return 'error: ' + e.message; }
  });
  console.log('\n$rootScope plan data:', rootScope);

  // Print any captured provider search calls
  if (providerCalls.length > 0) {
    for (const c of providerCalls) {
      console.log('\n=== PROVIDER SEARCH API CAPTURED ===');
      console.log('URL:', c.url.substring(0, 400));
      try {
        const p = JSON.parse(c.body);
        const key = Object.keys(p).find(k => Array.isArray(p[k]) && p[k].length > 0);
        if (key) {
          console.log(`${p[key].length} providers under "${key}"`);
          console.log('Keys:', Object.keys(p[key][0]));
          console.log('First:', JSON.stringify(p[key][0], null, 2).substring(0, 3000));
        } else {
          console.log(JSON.stringify(p, null, 2).substring(0, 1000));
        }
      } catch { console.log('Raw:', c.body.substring(0, 500)); }
    }
  }

  await browser.close();
})();
