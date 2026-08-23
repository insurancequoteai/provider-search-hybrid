// debug-uhc2.js
// Fixed: uses puppeteer-extra-plugin-stealth (not playwright-extra-plugin-stealth)
// Clicks "Employer and Individual" → Explore coverage, captures next step

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
    if (url.includes('graphql') || url.includes('/api/') || url.includes('provider') || url.includes('search') || url.includes('plan')) {
      apiCalls.push({ method: req.method(), url: url.substring(0, 200) });
    }
  });

  // ── Step 1: Guest plan selection ──────────────────────────────────────────
  await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(2000);
  console.log('URL:', page.url());
  console.log('Page title:', await page.title());

  // ── Step 2: Click "Explore coverage" for Employer and Individual ──────────
  const clicked = await page.evaluate(() => {
    // Find all sections/cards on page
    const allText = document.body.innerText;
    const hasEmployer = allText.includes('Employer and Individual');
    if (!hasEmployer) return 'No Employer and Individual section found';

    // Find the button near "Employer and Individual" text
    const buttons = Array.from(document.querySelectorAll('button'));
    const exploreBtns = buttons.filter(b => b.textContent.includes('Explore coverage'));
    if (exploreBtns.length === 0) return 'No Explore coverage buttons found';

    // Click the first one (Employer and Individual is first)
    exploreBtns[0].click();
    return `Clicked button #1 of ${exploreBtns.length}`;
  });
  console.log('Click result:', clicked);

  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  console.log('\nAfter click URL:', page.url());
  const pageText = await page.evaluate(() => document.body.innerText);
  console.log('\nPage text (first 3000 chars):\n', pageText.substring(0, 3000));

  // Capture inputs
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, button, select')).map(el => ({
      tag: el.tagName,
      id: el.id,
      type: el.type,
      placeholder: el.placeholder,
      name: el.name,
      value: el.tagName === 'INPUT' ? el.value : undefined,
      text: el.tagName !== 'INPUT' ? el.textContent?.trim().substring(0, 60) : undefined,
      visible: el.offsetParent !== null,
    })).filter(el => el.visible)
  );
  console.log('\nVisible inputs/buttons:', JSON.stringify(inputs, null, 2));
  console.log('\nAPI calls so far:', JSON.stringify(apiCalls.slice(-20), null, 2));

  // ── Step 3: If we're on a state/plan selection page, find what to do next ─
  // Look for state dropdown, plan name input, or zip field
  const nextStepInfo = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll('select')).map(s => ({
      id: s.id, name: s.name,
      options: Array.from(s.options).map(o => o.text).slice(0, 10),
    }));
    const textInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="search"]')).map(i => ({
      id: i.id, placeholder: i.placeholder, name: i.name,
    }));
    return { selects, textInputs };
  });
  console.log('\nSelect dropdowns:', JSON.stringify(nextStepInfo.selects, null, 2));
  console.log('Text inputs:', JSON.stringify(nextStepInfo.textInputs, null, 2));

  await browser.close();
})();
