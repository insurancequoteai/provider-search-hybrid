// debug-uhc12.js
// Skip the broken plan-selection UI. Navigate directly to UHC's provider finder
// using the known Choice Plus plan identifier (52 / s00001).
// Try multiple URL patterns to find the one that works.

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

  const allResponses = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('uhc.com') && (url.includes('graphql') || url.includes('api') || url.includes('provider') || url.includes('find'))) {
      try { allResponses.push({ url, status: res.status(), body: await res.text() }); } catch {}
    }
  });

  // ── First: get a valid guest session by landing on the main page ──────────
  console.log('Creating guest session...');
  await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  // Dismiss modal
  await page.evaluate(() => document.querySelector('[aria-label="Close"]')?.click());
  await page.waitForTimeout(500);

  // ── Try URL pattern 1: guest find-care with plan param ───────────────────
  const urlsToTry = [
    'https://findcare.guest.uhc.com/find-care?plan=s00001&zip=77041',
    'https://findcare.guest.uhc.com/find-care?guestPlanIdentifier=s00001&zip=77041',
    'https://findcare.guest.uhc.com/find-care?planIdentifier=52&zip=77041',
    'https://findcare.guest.uhc.com/find-care?planId=52&location=77041',
    'https://findcare.guest.uhc.com/provider-search?plan=s00001&zip=77041',
    'https://findcare.uhc.com/content/findcare/en/ul4me/plan.html#/provider?lang=en&plan=52&zip=77041&type=physician',
  ];

  for (const url of urlsToTry) {
    console.log('\nTrying:', url);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const finalUrl = page.url();
    const txt = await page.evaluate(() => document.body.innerText.substring(0, 300));
    console.log('Final URL:', finalUrl);
    console.log('Page snippet:', txt.replace(/\n+/g, ' ').substring(0, 200));

    // Check if we landed on a provider search page
    if (finalUrl.includes('find-care') || finalUrl.includes('provider') || txt.toLowerCase().includes('find a doctor')) {
      console.log('→ Looks promising!');
      break;
    }
    // If redirected back to guest-plan-selection, try next URL
    if (finalUrl.includes('guest-plan-selection')) {
      console.log('→ Redirected back to plan selection, trying next URL...');
    }
  }

  // ── Try GraphQL API directly (in-browser fetch with session cookies) ──────
  console.log('\n\nTrying GraphQL provider search API directly from browser...');

  // First call GetLocation to get the locationId for 77041
  const locationData = await page.evaluate(async () => {
    try {
      const res = await fetch('https://findcare.guest.uhc.com/green/api/graphql?q=GetLocation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          operationName: 'GetLocation',
          variables: { location: '77041', type: 'UNKNOWN' },
          query: `query GetLocation($location: String!, $type: LocationType) {
            getLocation(location: $location, type: $type) {
              displayName latitude longitude city state zip county
            }
          }`,
        }),
      });
      const data = await res.json();
      return { ok: res.ok, status: res.status, data };
    } catch (e) { return { error: e.message }; }
  });
  console.log('GetLocation result:', JSON.stringify(locationData, null, 2).substring(0, 500));

  // Try a provider search GraphQL query
  const providerData = await page.evaluate(async () => {
    try {
      // Common UHC provider search operation names
      const ops = ['GetProviders', 'ProviderSearch', 'SearchProviders', 'FindProviders', 'GetProviderResults'];
      for (const op of ops) {
        const res = await fetch(`https://findcare.guest.uhc.com/green/api/graphql?q=${op}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            operationName: op,
            variables: { planCode: '52', zip: '77041', specialty: 'physician', networkId: 'UNET', radius: 25, pageSize: 10 },
            query: `query ${op}($planCode: String, $zip: String, $specialty: String) { providers(planCode: $planCode, zip: $zip, specialty: $specialty) { id name address { street city state zip } phone specialty } }`,
          }),
        });
        const text = await res.text();
        if (res.status === 200) return { op, status: res.status, body: text.substring(0, 500) };
        if (!text.includes('Cannot query field') && !text.includes('Unknown operation')) {
          return { op, status: res.status, body: text.substring(0, 300) };
        }
      }
      return { tried: ops.length, message: 'no matching operation' };
    } catch (e) { return { error: e.message }; }
  });
  console.log('Provider search attempt:', JSON.stringify(providerData, null, 2).substring(0, 800));

  // ── Dump all captured API responses ──────────────────────────────────────
  console.log(`\n=== All captured (${allResponses.length}) ===`);
  for (const r of allResponses) {
    console.log(`[${r.status}] ${r.url.substring(0, 150)}`);
    // Look for any provider-related response
    if (r.url.includes('graphql') && r.body.includes('provider')) {
      try {
        const p = JSON.parse(r.body);
        console.log('  GraphQL data keys:', Object.keys(p?.data || {}));
      } catch {}
    }
  }

  // ── Try going through plan selection then immediately navigating ──────────
  console.log('\n\nTrying plan selection then URL intercept...');
  await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('[aria-label="Close"]')?.click());
  await page.waitForTimeout(500);
  // Navigate through to plan-selection
  await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Explore coverage'))?.click());
  await page.waitForURL('**/select-coverage-type**', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim().startsWith('Explore'))?.click());
  await page.waitForURL('**/plan-selection**', { timeout: 12000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Type location
  const locInput = page.locator('input[role="combobox"]').first();
  await locInput.click();
  await locInput.fill('77041');
  await page.waitForTimeout(1500);
  await page.waitForSelector('[role="option"]', { timeout: 6000 }).catch(() => {});

  // Capture what URL the site would navigate to after plan selection by
  // watching for navigation events
  const navPromise = page.waitForNavigation({ timeout: 8000 }).catch(() => null);

  // Try clicking the option via evaluate one more time and watch for URL change
  await page.evaluate(() => {
    const opt = document.querySelector('[role="option"]');
    if (opt) opt.click();
  });
  await page.waitForTimeout(500);

  // Check if navigation happened
  const nav = await navPromise;
  console.log('Navigation after option click:', nav ? page.url() : 'none');

  // Read what's now in the URL
  console.log('Current URL after all steps:', page.url());

  await browser.close();
})();
