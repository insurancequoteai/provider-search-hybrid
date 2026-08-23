// debug-uhc3.js
// Continues UHC flow: Employer & Individual → Medical → captures next step
// (plan selection or provider search form)

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const apiCalls = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('graphql') || url.includes('/api/') || url.includes('provider') || url.includes('plan')) {
      apiCalls.push({ method: req.method(), url: url.substring(0, 200) });
    }
  });

  // ── Step 1: Guest plan selection ──────────────────────────────────────────
  await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(1500);

  // Click "Explore coverage" for Employer and Individual (first button)
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('Explore coverage'));
    if (btns[0]) btns[0].click();
  });
  await page.waitForURL('**/select-coverage-type**', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('Step 1 URL:', page.url());

  // ── Step 2: Click "Explore" for Medical ───────────────────────────────────
  await page.waitForTimeout(1000);
  const medClicked = await page.evaluate(() => {
    // Find the Medical card's Explore button
    const allText = document.body.innerText;
    if (!allText.includes('Medical')) return 'Medical not found on page';

    // Try: find button near "Medical" text
    const btns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('Explore'));
    if (btns[0]) { btns[0].click(); return `clicked Explore #1 of ${btns.length}`; }
    return 'no Explore buttons found';
  });
  console.log('Step 2 click:', medClicked);

  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  console.log('Step 2 URL:', page.url());

  const step2Text = await page.evaluate(() => document.body.innerText);
  console.log('\nPage text after Medical click (first 3000):\n', step2Text.substring(0, 3000));

  // Capture inputs/selects/buttons
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, select')).filter(el => el.offsetParent !== null).map(el => ({
      tag: el.tagName, id: el.id, type: el.type || '', name: el.name,
      placeholder: el.placeholder,
      options: el.tagName === 'SELECT' ? Array.from(el.options).map(o => o.text).slice(0, 10) : undefined,
    }))
  );
  console.log('\nVisible inputs/selects:', JSON.stringify(inputs, null, 2));

  // ── Step 3: If there's a plan type / state selector, interact with it ─────
  // Check for state dropdown or plan name search
  const hasStateSelect = await page.$('select[name*="state"], select[id*="state"], select[aria-label*="state" i]');
  const hasZipInput = await page.$('input[id*="zip"], input[placeholder*="zip" i], input[placeholder*="postal" i]');
  const hasPlanInput = await page.$('input[id*="plan"], input[placeholder*="plan" i]');

  console.log('\nHas state select:', !!hasStateSelect);
  console.log('Has ZIP input:', !!hasZipInput);
  console.log('Has plan input:', !!hasPlanInput);

  // If there's a ZIP input, enter one and submit
  if (hasZipInput) {
    await hasZipInput.fill('77041');
    console.log('Filled ZIP: 77041');
    await page.waitForTimeout(500);
    // Try submitting
    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]') ||
                  Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Search') || b.textContent.includes('Find'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    console.log('After ZIP submit URL:', page.url());
    const afterZipText = await page.evaluate(() => document.body.innerText);
    console.log('Page text after ZIP:\n', afterZipText.substring(0, 3000));
  }

  // If there's a state select, show its options
  if (hasStateSelect) {
    const options = await page.evaluate(() => {
      const sel = document.querySelector('select[name*="state"], select[id*="state"]');
      return sel ? Array.from(sel.options).map(o => ({ value: o.value, text: o.text })) : [];
    });
    console.log('State dropdown options (first 10):', options.slice(0, 10));
  }

  console.log('\n\nFinal API calls:', JSON.stringify(apiCalls.slice(-15), null, 2));

  await browser.close();
})();
