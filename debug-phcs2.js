/**
 * debug-phcs2.js
 * Get past reCAPTCHA v3 by simulating human behavior,
 * capture the JWT token, then intercept the searchProviders call.
 * Run: node debug-phcs2.js
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const ZIP       = '77041';
const SPECIALTY = 'Cardiologist';

// ── helpers ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd   = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;

async function humanMouse(page) {
  // Random jittery mouse movements across the page
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(rnd(100, 1200), rnd(100, 800), { steps: rnd(8, 20) });
    await sleep(rnd(80, 220));
  }
}

async function humanScroll(page) {
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) {
      window.scrollBy(0, Math.random() * 120 + 40);
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
    }
    window.scrollTo(0, 0);
  });
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  const page = await ctx.newPage();

  // ── Track validate responses and search responses ────────────────────────
  let jwtToken = null;
  let searchResponse = null;
  let autoSuggestResponse = null;

  page.on('response', async res => {
    const url = res.url();
    const status = res.status();

    if (url.includes('/validate')) {
      try {
        const body = await res.json();
        console.log(`\n[VALIDATE] status=${status}`);
        console.log(JSON.stringify(body, null, 2));
        if (body.jwttoken) {
          jwtToken = body.jwttoken;
          console.log('✅ GOT JWT TOKEN!', jwtToken.slice(0, 60) + '...');
        } else {
          console.log('❌ No JWT - reCAPTCHA score too low');
        }
      } catch {}
    }

    if (url.includes('/autoSuggest')) {
      try {
        const body = await res.text();
        autoSuggestResponse = body;
        console.log('\n[AUTO-SUGGEST]', body.slice(0, 500));
      } catch {}
    }

    if (url.includes('/searchProviders')) {
      try {
        const body = await res.text();
        searchResponse = body;
        console.log('\n[SEARCH RESPONSE - FIRST 1000 chars]');
        console.log(body.slice(0, 1000));
      } catch {}
    }
  });

  // Also log request bodies for searchProviders
  page.on('request', req => {
    const url = req.url();
    if (url.includes('/searchProviders') || url.includes('/autoSuggest') || url.includes('/getNetworkConfig')) {
      console.log(`\n→ ${req.method()} ${url}`);
      const body = req.postData();
      if (body) console.log('  BODY:', body.slice(0, 1000));
      console.log('  HEADERS:', JSON.stringify(Object.fromEntries(
        Object.entries(req.headers()).filter(([k]) => ['authorization','x-','content-type','accept'].some(p => k.toLowerCase().startsWith(p)))
      ), null, 2));
    }
  });

  // ── Step 1: Start at Google to warm up the recaptcha session ────────────
  console.log('\n=== Step 1: Warm-up visit ===');
  await page.goto('https://www.google.com', { waitUntil: 'load', timeout: 15000 }).catch(() => {});
  await sleep(1500);
  await humanMouse(page);
  await sleep(1000);

  // ── Step 2: Navigate to MultiPlan ────────────────────────────────────────
  console.log('\n=== Step 2: Loading MultiPlan ===');
  await page.goto('https://providersearch.multiplan.com/', {
    waitUntil: 'load',
    timeout: 30000,
  });

  // Human behavior right after load
  await sleep(rnd(1500, 2500));
  await humanMouse(page);
  await sleep(rnd(800, 1500));
  await humanScroll(page);
  await sleep(rnd(1000, 2000));

  // ── Step 3: Wait for the validate call to complete (with JWT hopefully) ──
  console.log('\n=== Step 3: Waiting for validate/JWT ===');
  await sleep(5000); // give reCAPTCHA time to evaluate

  console.log('\nJWT status:', jwtToken ? '✅ OBTAINED' : '❌ Not obtained yet');

  // ── Step 4: Wait for the React form to render ────────────────────────────
  console.log('\n=== Step 4: Waiting for form ===');
  const formSelectors = [
    'input', 'input[type="text"]', '[placeholder]',
    '[data-testid]', 'form', '#root > div',
  ];

  for (const sel of formSelectors) {
    const count = await page.locator(sel).count();
    if (count > 0) console.log(`Found ${count}x "${sel}"`);
  }

  // Wait specifically for a text input to appear (React may lazy-render)
  await page.waitForSelector('input[type="text"], input:not([type="hidden"])', {
    timeout: 15000,
  }).catch(() => console.log('⚠️ No text inputs appeared after 15s'));

  // ── Dump all inputs now ───────────────────────────────────────────────────
  const inputs = await page.$$eval('input', els =>
    els.map(el => ({
      type: el.type, name: el.name, id: el.id,
      placeholder: el.placeholder,
      'aria-label': el.getAttribute('aria-label'),
      visible: el.offsetParent !== null,
    }))
  );
  console.log('\nAll inputs after wait:', JSON.stringify(inputs, null, 2));

  // ── Step 5: Try to fill the search ───────────────────────────────────────
  console.log('\n=== Step 5: Filling search form ===');

  // Find the main search/specialty input
  const allInputs = await page.locator('input:not([type="hidden"])').all();
  console.log(`Found ${allInputs.length} visible inputs`);

  for (const inp of allInputs.slice(0, 5)) {
    const ph = await inp.getAttribute('placeholder').catch(() => '');
    const al = await inp.getAttribute('aria-label').catch(() => '');
    const id = await inp.getAttribute('id').catch(() => '');
    const vis = await inp.isVisible().catch(() => false);
    console.log(`  Input: placeholder="${ph}" aria-label="${al}" id="${id}" visible=${vis}`);
  }

  // Try typing into any visible text input (likely specialty/name search)
  const searchInput = page.locator('input:not([type="hidden"])').first();
  if (await searchInput.count() > 0 && await searchInput.isVisible()) {
    await searchInput.click();
    await sleep(300);
    await searchInput.type(SPECIALTY, { delay: rnd(80, 140) });
    await sleep(1500);

    // Check for autocomplete
    const opts = await page.locator('[role="option"], .suggestion, li[class*="item"]').all();
    console.log(`\nAutocomplete options: ${opts.length}`);
    for (const o of opts.slice(0, 5)) {
      console.log(' -', await o.textContent().catch(() => '?'));
    }

    if (opts.length > 0) {
      await opts[0].click();
      await sleep(1000);
    }
  }

  // ── ZIP ────────────────────────────────────────────────────────────────
  const zipInput = page.locator('input[placeholder*="ZIP" i], input[placeholder*="zip" i], input[placeholder*="postal" i]').first();
  if (await zipInput.count() > 0) {
    await zipInput.click();
    await zipInput.type(ZIP, { delay: rnd(80, 120) });
    console.log('Filled ZIP');
    await sleep(1000);
  }

  // ── Search button ─────────────────────────────────────────────────────
  const searchBtn = page.locator('button[type="submit"], button:has-text("Search"), button:has-text("Find")').first();
  if (await searchBtn.count() > 0) {
    console.log('Clicking search...');
    await searchBtn.click();
    await sleep(5000);
  }

  // ── Step 6: Screenshot and summary ───────────────────────────────────────
  console.log('\n=== Final URL:', page.url());

  if (searchResponse) {
    console.log('\n✅ GOT SEARCH RESPONSE!');
    console.log(searchResponse.slice(0, 2000));
  } else {
    console.log('\n❌ No searchProviders response captured');
  }

  await page.screenshot({ path: '/tmp/phcs-debug2.png', fullPage: true });
  console.log('\nScreenshot saved: /tmp/phcs-debug2.png');

  await browser.close();
})();
