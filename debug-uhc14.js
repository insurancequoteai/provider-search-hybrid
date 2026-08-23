// debug-uhc14.js
// Direct URL bypass confirmed. Now: click first autocomplete option (native Playwright click)
// and capture the GraphQL provider search response with actual provider data.

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

  const graphqlResponses = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('findcare.guest.uhc.com/api/graphql')) {
      try {
        const body = await res.text();
        const op = new URL(url).searchParams.get('q');
        graphqlResponses.push({ url, op, body });
      } catch {}
    }
  });

  // Step 1: Guest session
  await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  // Step 2: Direct URL
  await page.goto('https://findcare.guest.uhc.com/find-care?plan=s00001&zip=77041', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(2000);

  // Step 3: Dismiss modal
  await page.evaluate(() => {
    const selectors = [
      'button[aria-label="close"]', 'button[aria-label="Close"]',
      '[data-testid="modal-close"]', '[aria-label="Close dialog"]',
      '.abyss-icon-button',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { el.click(); return; }
    }
    const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]');
    for (const d of dialogs) {
      const btns = Array.from(d.querySelectorAll('button'));
      const closeBtn = btns.find(b => b.getAttribute('aria-label')?.toLowerCase().includes('close') || b.textContent?.toLowerCase().trim() === 'close');
      if (closeBtn) { closeBtn.click(); return; }
    }
  });
  await page.waitForTimeout(1000);

  // Step 4: Type in search box
  const searchInput = page.locator('input[role="combobox"]').first();
  await searchInput.click();
  await searchInput.type('Cardiologist', { delay: 80 });
  await page.waitForTimeout(1500);

  // Wait for autocomplete options to appear
  await page.waitForSelector('[role="option"]', { timeout: 8000 }).catch(() => {});

  // Step 5: Set up response watcher BEFORE clicking option
  const providerSearchPromise = new Promise(resolve => {
    const handler = async (res) => {
      const url = res.url();
      if (url.includes('/api/graphql')) {
        try {
          const body = await res.text();
          const parsed = JSON.parse(body);
          // Look for a response with provider/result data
          const dataKeys = Object.keys(parsed?.data || {});
          const hasProviders = dataKeys.some(k => {
            const v = parsed.data[k];
            return (Array.isArray(v) && v.length > 0) ||
                   (v && typeof v === 'object' && (v.providers || v.providerList || v.results || v.totalCount > 0));
          });
          if (hasProviders || dataKeys.some(k => k.toLowerCase().includes('search') || k.toLowerCase().includes('provider') || k.toLowerCase().includes('result'))) {
            page.off('response', handler);
            resolve({ url, body, parsed });
          }
        } catch {}
      }
    };
    page.on('response', handler);
    setTimeout(() => resolve(null), 20000);
  });

  // Click first autocomplete option using native Playwright
  const firstOption = page.locator('[role="option"]').first();
  const optCount = await firstOption.count();
  console.log('Autocomplete options count:', optCount);
  if (optCount > 0) {
    const optText = await firstOption.textContent().catch(() => '?');
    console.log('Clicking option:', optText?.trim().substring(0, 60));
    await firstOption.click();
    console.log('Clicked first option');
  } else {
    console.log('No options, pressing Enter');
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(500);

  // Also try clicking Search button
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const sb = btns.find(b => b.textContent?.trim().toLowerCase() === 'search' || b.getAttribute('aria-label')?.toLowerCase().includes('search'));
    if (sb && sb.offsetParent !== null) sb.click();
  });

  // Wait for provider search response
  console.log('Waiting for provider search GraphQL response...');
  const providerResult = await providerSearchPromise;

  if (providerResult) {
    console.log('\n=== PROVIDER SEARCH RESPONSE ===');
    console.log('URL:', providerResult.url.substring(0, 150));
    console.log('Operation:', new URL(providerResult.url).searchParams.get('q'));
    const dataKeys = Object.keys(providerResult.parsed?.data || {});
    console.log('Data keys:', dataKeys);

    for (const k of dataKeys) {
      const val = providerResult.parsed.data[k];
      if (Array.isArray(val) && val.length > 0) {
        console.log(`\n${k}: array of ${val.length}`);
        console.log('First item keys:', Object.keys(val[0]));
        console.log('First item:\n', JSON.stringify(val[0], null, 2).substring(0, 3000));
      } else if (val && typeof val === 'object') {
        console.log(`\n${k}:`, JSON.stringify(val, null, 2).substring(0, 2000));
      }
    }
  } else {
    console.log('\nNo provider search response captured in 20s');
  }

  // Also wait for page to settle and check URL + text
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log('\nFinal URL:', page.url());
  const finalText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  console.log('\nFinal page (3000):\n', finalText.replace(/\n+/g, '\n'));

  // Print all GraphQL ops captured
  console.log('\n=== All GraphQL ops ===');
  const ops = [...new Set(graphqlResponses.map(r => r.op || '?'))];
  console.log(ops.join(', '));

  // Find any with provider data
  for (const r of graphqlResponses) {
    try {
      const p = JSON.parse(r.body);
      const keys = Object.keys(p?.data || {});
      for (const k of keys) {
        const v = p.data[k];
        if (Array.isArray(v) && v.length > 0 && JSON.stringify(v[0]).length > 100) {
          console.log(`\nOp: ${r.op} → ${k}: array of ${v.length}`);
          console.log('First:\n', JSON.stringify(v[0], null, 2).substring(0, 2000));
        } else if (v && typeof v === 'object' && v.providers && v.providers.length > 0) {
          console.log(`\nOp: ${r.op} → ${k}.providers: array of ${v.providers.length}`);
          console.log('First:\n', JSON.stringify(v.providers[0], null, 2).substring(0, 2000));
        }
      }
    } catch {}
  }

  await browser.close();
})();
