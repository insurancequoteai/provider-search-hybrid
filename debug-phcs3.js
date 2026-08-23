/**
 * debug-phcs3.js
 * Try real Chrome (non-headless) to pass reCAPTCHA v3.
 * Also logs the FULL /validate request (headers + body) so we know
 * exactly what to replicate if we go the 2captcha route.
 *
 * Run: node debug-phcs3.js
 *
 * This will open a visible Chrome window briefly — that's intentional.
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const ZIP       = '77041';
const SPECIALTY = 'Cardiologist';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd   = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;

(async () => {
  console.log('Launching real Chrome (non-headless)...');
  const browser = await chromium.launch({
    headless: false,          // ← real visible window
    channel: 'chrome',        // ← use system Chrome, not bundled Chromium
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  }).catch(async e => {
    console.log('System Chrome not found, falling back to Chromium headful:', e.message);
    return chromium.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
  });

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  const page = await ctx.newPage();

  let jwtToken = null;
  let searchResponse = null;

  // ── Log FULL /validate request (headers + body) ─────────────────────────
  page.on('request', req => {
    const url = req.url();
    if (url.includes('/validate')) {
      console.log('\n[VALIDATE REQUEST]');
      console.log('URL:', url);
      console.log('Method:', req.method());
      console.log('Headers:', JSON.stringify(req.headers(), null, 2));
      console.log('Body:', req.postData());
    }
    if (url.includes('/searchProviders')) {
      console.log('\n[SEARCH REQUEST]');
      console.log('URL:', url);
      console.log('Headers:', JSON.stringify(req.headers(), null, 2));
      console.log('Body:', req.postData()?.slice(0, 1000));
    }
    if (url.includes('/autoSuggest')) {
      console.log('\n[AUTOSUGGEST REQUEST]');
      console.log('Body:', req.postData()?.slice(0, 500));
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('/validate')) {
      try {
        const body = await res.json();
        console.log('\n[VALIDATE RESPONSE]', JSON.stringify(body, null, 2));
        if (body.jwttoken) {
          jwtToken = body.jwttoken;
          console.log('✅ GOT JWT:', jwtToken.slice(0, 80) + '...');
        }
      } catch {}
    }
    if (url.includes('/searchProviders')) {
      try {
        const text = await res.text();
        searchResponse = text;
        console.log('\n[SEARCH RESPONSE - first 2000 chars]:');
        console.log(text.slice(0, 2000));
      } catch {}
    }
    if (url.includes('/autoSuggest')) {
      try {
        const text = await res.text();
        console.log('\n[AUTOSUGGEST RESPONSE]:', text.slice(0, 500));
      } catch {}
    }
  });

  // ── Navigate ────────────────────────────────────────────────────────────
  console.log('\nNavigating to MultiPlan...');
  await page.goto('https://providersearch.multiplan.com/', {
    waitUntil: 'load',
    timeout: 30000,
  });

  // Natural pause while reCAPTCHA evaluates
  await sleep(4000);

  console.log('\nJWT after page load:', jwtToken ? '✅ GOT IT' : '❌ Still null');

  // ── Wait for search form to appear ────────────────────────────────────
  console.log('\nWaiting for form inputs...');
  await page.waitForSelector('input', { timeout: 20000 }).catch(() => {
    console.log('⚠️ inputs never appeared');
  });

  const inputs = await page.$$eval('input', els =>
    els.map(el => ({
      type: el.type, id: el.id, name: el.name,
      placeholder: el.placeholder,
      'aria-label': el.getAttribute('aria-label'),
      visible: el.offsetParent !== null,
    }))
  );
  console.log('\nInputs found:', JSON.stringify(inputs, null, 2));

  // ── Dump page source around the search area ──────────────────────────
  const bodyText = await page.evaluate(() =>
    document.body.innerText.slice(0, 2000)
  );
  console.log('\nPage text (first 2000 chars):\n', bodyText);

  // ── If form rendered, fill and search ────────────────────────────────
  if (inputs.filter(i => i.visible).length > 0) {
    console.log('\n=== FORM IS VISIBLE — filling in search ===');

    const visibleInputs = await page.locator('input:not([type="hidden"])').all();
    for (const inp of visibleInputs) {
      const ph = await inp.getAttribute('placeholder').catch(() => '');
      const al = await inp.getAttribute('aria-label').catch(() => '');
      console.log(`Input: "${ph}" / "${al}"`);
    }

    // Specialty / provider name
    const firstInput = page.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])').first();
    if (await firstInput.count() > 0) {
      await firstInput.click();
      await sleep(300);
      await firstInput.type(SPECIALTY, { delay: rnd(60, 120) });
      await sleep(1500);

      // Click first autocomplete option
      const opt = page.locator('[role="option"]').first();
      if (await opt.count() > 0) {
        console.log('Clicking autocomplete option:', await opt.textContent());
        await opt.click();
        await sleep(800);
      } else {
        await page.keyboard.press('Enter');
      }
    }

    // ZIP
    const zipInput = page.locator('input[placeholder*="ZIP" i], input[placeholder*="zip" i], input[placeholder*="postal" i], input[placeholder*="location" i]').first();
    if (await zipInput.count() > 0) {
      await zipInput.click();
      await zipInput.fill(ZIP);
      console.log('Filled ZIP');
      await sleep(500);
    }

    // Submit
    const btn = page.locator('button[type="submit"], button:has-text("Search"), button:has-text("Find")').first();
    if (await btn.count() > 0) {
      console.log('Submitting...');
      await btn.click();
      await sleep(8000);
    }

    console.log('\nFinal URL:', page.url());
    if (searchResponse) {
      console.log('\n✅ Search response captured!');
    } else {
      console.log('\n❌ No search response');
    }
  } else {
    console.log('\n❌ Form still not visible after wait');
    await page.screenshot({ path: '/tmp/phcs3-blocked.png', fullPage: true });
    console.log('Screenshot: /tmp/phcs3-blocked.png');
  }

  await sleep(2000);
  await browser.close();
  console.log('\nDone.');
})();
