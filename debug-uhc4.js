// debug-uhc4.js
// Continues from plan-selection page: types "Texas" in location dropdown,
// waits for plans to load, finds "Choice Plus", clicks it, captures what follows.

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

  const apiResponses = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('graphql') && url.includes('uhc')) {
      try {
        const body = await res.text();
        apiResponses.push({ url, body: body.substring(0, 5000) });
      } catch {}
    }
  });

  // ── Steps 1-3: reach plan-selection page ──────────────────────────────────
  await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  // Employer and Individual
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('Explore coverage'));
    if (btns[0]) btns[0].click();
  });
  await page.waitForURL('**/select-coverage-type**', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // Medical
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('Explore'));
    if (btns[0]) btns[0].click();
  });
  await page.waitForURL('**/plan-selection**', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  console.log('On plan-selection:', page.url());

  // ── Step 4: Type "Texas" in the location combobox ─────────────────────────
  // The input has id=":rj:" — it's a combobox for state selection
  const locationInput = await page.$('input[id=":rj:"]') || await page.$('input[role="combobox"]') || await page.$('input[aria-label*="location" i], input[aria-label*="state" i], input[placeholder*="select" i]');

  if (locationInput) {
    await locationInput.click();
    await locationInput.fill('Texas');
    await page.waitForTimeout(1000);

    // Look for dropdown options
    const options = await page.evaluate(() => {
      const listbox = document.querySelector('[role="listbox"], [role="option"]');
      if (listbox) return listbox.parentElement?.innerText;
      // Try all visible list items
      const items = Array.from(document.querySelectorAll('li, [role="option"]')).filter(el => el.offsetParent);
      return items.map(el => el.textContent?.trim()).filter(Boolean).slice(0, 10).join(' | ');
    });
    console.log('Dropdown options after typing Texas:', options);

    // Click Texas option
    const clicked = await page.evaluate(() => {
      const options = Array.from(document.querySelectorAll('li, [role="option"]')).filter(el => el.offsetParent);
      const texas = options.find(el => el.textContent?.includes('Texas'));
      if (texas) { texas.click(); return 'clicked Texas'; }
      // Try pressing ArrowDown + Enter
      return 'Texas option not found in dropdown';
    });
    console.log('Texas click:', clicked);

    if (clicked.includes('not found')) {
      // Try keyboard navigation
      await locationInput.press('ArrowDown');
      await page.waitForTimeout(200);
      await locationInput.press('Enter');
      console.log('Used keyboard to select');
    }
  } else {
    // Fallback: find by any visible input
    console.log('Location input not found by expected selector, trying all inputs...');
    const allInputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent).map(el => ({
        id: el.id, type: el.type, placeholder: el.placeholder, ariaLabel: el.getAttribute('aria-label'),
      }))
    );
    console.log('All visible inputs:', JSON.stringify(allInputs));
  }

  // Wait for plans to load
  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  console.log('URL after state select:', page.url());

  const planPageText = await page.evaluate(() => document.body.innerText);
  console.log('\nPage text after state select (first 4000):\n', planPageText.substring(0, 4000));

  // Look for Choice Plus specifically
  const choicePlusFound = planPageText.includes('Choice Plus') || planPageText.includes('Choice plus');
  console.log('\nChoice Plus on page:', choicePlusFound);

  if (choicePlusFound) {
    // Click Choice Plus
    const planClicked = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('button, a, li, div[role="button"]'));
      const cp = allEls.find(el => el.textContent?.includes('Choice Plus'));
      if (cp) { cp.click(); return 'clicked: ' + cp.textContent?.trim().substring(0, 80); }
      return 'Choice Plus element not clickable';
    });
    console.log('Choice Plus click:', planClicked);

    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    console.log('URL after plan select:', page.url());

    const afterPlanText = await page.evaluate(() => document.body.innerText);
    console.log('\nPage text after plan select (first 4000):\n', afterPlanText.substring(0, 4000));

    // Look for search inputs
    const searchInputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent).map(el => ({
        id: el.id, type: el.type, placeholder: el.placeholder,
        ariaLabel: el.getAttribute('aria-label'), name: el.name,
      }))
    );
    console.log('\nSearch inputs on page:', JSON.stringify(searchInputs, null, 2));
  }

  // Print captured GraphQL responses
  console.log('\n\n=== GraphQL API Responses ===');
  for (const r of apiResponses) {
    console.log('\nURL:', r.url);
    try {
      const parsed = JSON.parse(r.body);
      console.log(JSON.stringify(parsed, null, 2).substring(0, 3000));
    } catch {
      console.log(r.body.substring(0, 1000));
    }
  }

  await browser.close();
})();
