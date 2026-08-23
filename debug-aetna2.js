// debug-aetna2.js
// Navigates to Aetna providerSearch page, then calls the API directly via
// in-browser fetch (cookies included automatically). No typeahead, no providerID.

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  // ── Step 1: Landing page → enter ZIP ──────────────────────────────────────
  await page.goto('https://www.aetna.com/dsepublic/#/contentPage?page=providerSearch&site_id=dse&language=en', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForSelector('#zip1', { timeout: 15000 });
  await page.fill('#zip1', '77041');
  await Promise.all([
    page.waitForURL('**/providerSearchPlanList**', { timeout: 15000 }).catch(() => {}),
    page.evaluate(() => document.querySelector('button[type="submit"]')?.click()),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  console.log('After ZIP:', page.url());

  // ── Step 2: Select Open Choice PPO ────────────────────────────────────────
  await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    const mppo = radios.find(r => r.value && r.value.includes('MPPO'));
    if (mppo) mppo.click();
    else if (radios[0]) radios[0].click();
  });
  await page.waitForTimeout(400);

  // Click Continue
  const continued = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
    const cont = btns.find(b => b.textContent?.includes('Continue') || b.value?.includes('Continue'));
    if (cont) { cont.click(); return true; }
    return false;
  });
  console.log('Clicked Continue:', continued);
  await page.waitForURL('**/providerSearch**', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  console.log('On provider search page:', page.url());

  // ── Step 3: Call the API directly via in-browser fetch ────────────────────
  // No providerID, no typeahead — just specialty + location
  const apiResult = await page.evaluate(async () => {
    const ts = Date.now();
    const params = new URLSearchParams({
      searchText: 'Family Medicine',
      productIdentifier: '~MPPO',
      listFieldSelections: `acceptedVersion_jgegs,tmstmp${ts}tmstmp,affiliations,VisitType_NoPreference,groupSearch`,
      isGuidedSearch: 'true',
      state: 'TX',
      distance: '25',
      latitude: '29.873022',
      longitude: '-95.565545',
      postalCode: '77041',
      firstRecordOnPage: '1',
      lastRecordOnPage: '10',
      pipeName: 'Open Choice PPO',
      responseLanguagePreference: 'en',
      siteId: 'dse',
    });
    const url = `https://api01.aetna.com/healthcore/prod/v3/publicdse_providersearch?${params}`;
    console.log('Calling:', url);
    try {
      const resp = await fetch(url, { credentials: 'include' });
      const text = await resp.text();
      return { status: resp.status, url, body: text.substring(0, 8000) };
    } catch (e) {
      return { error: e.message, url };
    }
  });

  console.log('\n=== API RESULT ===');
  console.log('Status:', apiResult.status);
  if (apiResult.error) {
    console.log('Error:', apiResult.error);
  } else {
    // Pretty-print first provider if JSON
    try {
      const parsed = JSON.parse(apiResult.body);
      console.log('Top-level keys:', Object.keys(parsed));
      // Look for provider array
      const providerKey = Object.keys(parsed).find(k =>
        Array.isArray(parsed[k]) && parsed[k].length > 0
      );
      if (providerKey) {
        console.log(`\nFound ${parsed[providerKey].length} items under "${providerKey}"`);
        console.log('First item keys:', Object.keys(parsed[providerKey][0]));
        console.log('First item sample:', JSON.stringify(parsed[providerKey][0], null, 2).substring(0, 2000));
      } else {
        console.log('Full response (first 4000 chars):', JSON.stringify(parsed, null, 2).substring(0, 4000));
      }
    } catch {
      console.log('Raw body (first 2000 chars):', apiResult.body.substring(0, 2000));
    }
  }

  // ── Also try with isGuidedSearch=false (name search style) ───────────────
  console.log('\n=== RETRY: isGuidedSearch=false, searchText="John Smith" ===');
  const apiResult2 = await page.evaluate(async () => {
    const ts = Date.now();
    const params = new URLSearchParams({
      searchText: 'John Smith',
      productIdentifier: '~MPPO',
      listFieldSelections: `acceptedVersion_jgegs,tmstmp${ts}tmstmp,affiliations,VisitType_NoPreference,groupSearch`,
      isGuidedSearch: 'false',
      state: 'TX',
      distance: '25',
      latitude: '29.873022',
      longitude: '-95.565545',
      postalCode: '77041',
      firstRecordOnPage: '1',
      lastRecordOnPage: '10',
      pipeName: 'Open Choice PPO',
      responseLanguagePreference: 'en',
      siteId: 'dse',
    });
    const url = `https://api01.aetna.com/healthcore/prod/v3/publicdse_providersearch?${params}`;
    try {
      const resp = await fetch(url, { credentials: 'include' });
      const text = await resp.text();
      return { status: resp.status, body: text.substring(0, 4000) };
    } catch (e) {
      return { error: e.message };
    }
  });
  console.log('Status:', apiResult2.status);
  try {
    const p2 = JSON.parse(apiResult2.body);
    console.log('Top-level keys:', Object.keys(p2));
    const k = Object.keys(p2).find(k => Array.isArray(p2[k]) && p2[k].length > 0);
    if (k) console.log(`${p2[k].length} results under "${k}"`);
    else console.log(JSON.stringify(p2, null, 2).substring(0, 2000));
  } catch { console.log(apiResult2.body?.substring(0, 1000) || apiResult2.error); }

  await browser.close();
})();
