/**
 * debug-phcs1.js
 * Sniff the MultiPlan/PHCS provider search API.
 * Run: node debug-phcs1.js
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const ZIP       = '77041';
const SPECIALTY = 'Cardiologist';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const captured = [];

  // Capture ALL XHR / fetch requests
  page.on('request', req => {
    const url = req.url();
    const type = req.resourceType();
    if (['fetch','xhr'].includes(type)) {
      console.log(`→ [${type.toUpperCase()}] ${req.method()} ${url}`);
      const body = req.postData();
      if (body) console.log('  BODY:', body.slice(0, 300));
    }
  });

  // Capture ALL fetch/xhr responses
  page.on('response', async res => {
    const url = res.url();
    const type = res.request().resourceType();
    if (!['fetch','xhr'].includes(type)) return;

    const status = res.status();
    console.log(`← [${status}] ${url}`);

    try {
      const text = await res.text();
      if (text.length > 20 && text.length < 50000) {
        captured.push({ url, status, body: text });
        // Print snippet if it looks like provider data
        if (text.includes('provider') || text.includes('Provider') ||
            text.includes('npi') || text.includes('NPI') ||
            text.includes('physician') || text.includes('doctor')) {
          console.log('  *** LOOKS LIKE PROVIDER DATA ***');
          console.log('  SNIPPET:', text.slice(0, 500));
        }
      }
    } catch {}
  });

  // ── Step 1: Load the site ─────────────────────────────────────────────────
  console.log('\n=== LOADING MULTIPLAN PROVIDER SEARCH ===');
  await page.goto('https://providersearch.multiplan.com/', {
    waitUntil: 'networkidle',
    timeout: 30000,
  }).catch(e => console.log('goto error:', e.message));

  await page.waitForTimeout(3000);

  // ── Dump page title and visible text ─────────────────────────────────────
  const title = await page.title();
  console.log('\nPage title:', title);
  console.log('URL:', page.url());

  // ── Look for input fields ──────────────────────────────────────────────────
  const inputs = await page.$$eval('input', els =>
    els.map(el => ({
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      value: el.value,
      visible: el.offsetParent !== null,
    }))
  );
  console.log('\nAll inputs:', JSON.stringify(inputs, null, 2));

  // ── Look for buttons ───────────────────────────────────────────────────────
  const btns = await page.$$eval('button', els =>
    els.slice(0, 20).map(el => ({
      text: el.textContent?.trim().slice(0, 60),
      type: el.type,
      visible: el.offsetParent !== null,
    }))
  );
  console.log('\nButtons:', JSON.stringify(btns, null, 2));

  // ── Try to fill the search form ───────────────────────────────────────────
  console.log('\n=== ATTEMPTING SEARCH ===');

  // Look for a ZIP input
  const zipSelectors = [
    'input[name="zip"]', 'input[id*="zip" i]', 'input[placeholder*="zip" i]',
    'input[placeholder*="postal" i]', 'input[placeholder*="location" i]',
  ];
  let zipFilled = false;
  for (const sel of zipSelectors) {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      await el.click({ clickCount: 3 });
      await el.type(ZIP, { delay: 80 });
      console.log('Filled ZIP with selector:', sel);
      zipFilled = true;
      break;
    }
  }
  if (!zipFilled) console.log('ZIP input not found');

  await page.waitForTimeout(800);

  // Look for specialty / provider name input
  const specSelectors = [
    'input[name*="specialty" i]', 'input[id*="specialty" i]',
    'input[placeholder*="specialty" i]', 'input[placeholder*="provider" i]',
    'input[placeholder*="doctor" i]', 'input[placeholder*="name" i]',
    'input[placeholder*="search" i]',
  ];
  let specFilled = false;
  for (const sel of specSelectors) {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      await el.click({ clickCount: 3 });
      await el.type(SPECIALTY, { delay: 80 });
      console.log('Filled specialty with selector:', sel);
      specFilled = true;
      break;
    }
  }
  if (!specFilled) console.log('Specialty input not found');

  await page.waitForTimeout(500);

  // Wait for autocomplete suggestions
  await page.waitForSelector('[role="option"], .suggestion, .autocomplete-item, li[class*="suggest"]', {
    timeout: 5000,
  }).catch(() => console.log('No autocomplete options appeared'));

  const opts = await page.$$eval('[role="option"], .suggestion, .autocomplete-item', els =>
    els.slice(0, 5).map(el => el.textContent?.trim())
  ).catch(() => []);
  console.log('Autocomplete options:', opts);

  if (opts.length > 0) {
    await page.locator('[role="option"]').first().click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  // Try clicking search button
  const searchBtnSels = [
    'button[type="submit"]',
    'button:has-text("Search")',
    'button:has-text("Find")',
    'input[type="submit"]',
  ];
  for (const sel of searchBtnSels) {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      console.log('Clicking search button:', sel);
      await el.click();
      break;
    }
  }

  // Wait for results
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);

  console.log('\nFinal URL:', page.url());

  // ── Summary of captured API calls ─────────────────────────────────────────
  console.log('\n=== CAPTURED API RESPONSES ===');
  captured.forEach((c, i) => {
    console.log(`\n[${i+1}] ${c.status} ${c.url}`);
    console.log(c.body.slice(0, 800));
    console.log('---');
  });

  // ── Screenshot for debugging ───────────────────────────────────────────────
  await page.screenshot({ path: '/tmp/phcs-debug.png', fullPage: true });
  console.log('\nScreenshot: /tmp/phcs-debug.png');

  await browser.close();
})();
