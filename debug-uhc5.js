// debug-uhc5.js
// Properly selects location via ZIP 77041, waits for plans to load,
// finds and clicks Choice Plus, captures what comes next.

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

  const graphqlResponses = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('graphql') && url.includes('uhc')) {
      try { graphqlResponses.push({ url, body: await res.text() }); } catch {}
    }
  });

  // ── Steps 1-3: Navigate to plan-selection page ────────────────────────────
  await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('Explore coverage'));
    if (btns[0]) btns[0].click();
  });
  await page.waitForURL('**/select-coverage-type**', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('Explore'));
    if (btns[0]) btns[0].click();
  });
  await page.waitForURL('**/plan-selection**', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  console.log('On plan-selection:', page.url());

  // ── Step 4: Enter ZIP 77041 in location combobox ──────────────────────────
  // Find the location input (might have dynamic id like :rj:)
  const locationInput = await page.$('input[role="combobox"]') ||
    await page.$('input[aria-label*="location" i]') ||
    await page.$('input[aria-autocomplete]') ||
    await page.$('#\\3Arj\\3A');  // escaped :rj: selector

  if (locationInput) {
    console.log('Found location input');
    await locationInput.click();
    await locationInput.fill('77041');
    console.log('Typed 77041');
    await page.waitForTimeout(1500);

    // Check what dropdown options appeared
    const dropdownText = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] li, [data-testid*="option"], [class*="suggestion"], [class*="dropdown"] li'));
      return items.map(el => el.textContent?.trim()).filter(Boolean);
    });
    console.log('Dropdown options:', dropdownText);

    // Click the first dropdown option
    const optionClicked = await page.evaluate(() => {
      // Try role=option first
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      if (options[0]) { options[0].click(); return 'clicked role=option: ' + options[0].textContent?.trim().substring(0, 60); }

      // Try listbox children
      const listbox = document.querySelector('[role="listbox"]');
      if (listbox) {
        const children = Array.from(listbox.querySelectorAll('li, div, button')).filter(el => el.offsetParent);
        if (children[0]) { children[0].click(); return 'clicked listbox child: ' + children[0].textContent?.trim().substring(0, 60); }
      }

      // Try any visible li that appeared after typing
      const lis = Array.from(document.querySelectorAll('li')).filter(el => el.offsetParent && el.textContent?.includes('77041'));
      if (lis[0]) { lis[0].click(); return 'clicked li with 77041: ' + lis[0].textContent?.trim().substring(0, 60); }

      // Fallback: press ArrowDown then Enter on the input
      return 'no option element found';
    });
    console.log('Option click:', optionClicked);

    if (optionClicked.includes('no option')) {
      // Use keyboard
      await locationInput.press('ArrowDown');
      await page.waitForTimeout(200);
      await locationInput.press('Enter');
      console.log('Used keyboard ArrowDown+Enter');
    }
  } else {
    // Dump all inputs to diagnose
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(el => ({ id: el.id, type: el.type, placeholder: el.placeholder, ariaLabel: el.getAttribute('aria-label'), role: el.getAttribute('role'), ariaAuto: el.getAttribute('aria-autocomplete') }))
    );
    console.log('No location input found. All inputs:', JSON.stringify(inputs, null, 2));
  }

  // Wait for GetPlanDefinitions to fire with the new location
  await page.waitForTimeout(2000);
  await page.waitForResponse(
    res => res.url().includes('GetPlanDefinitions'),
    { timeout: 10000 }
  ).catch(() => console.log('GetPlanDefinitions timeout'));
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const planText = await page.evaluate(() => document.body.innerText);
  console.log('\nPage text after location select (first 5000):\n', planText.substring(0, 5000));

  const hasChoicePlus = planText.toLowerCase().includes('choice plus');
  console.log('\nChoice Plus on page:', hasChoicePlus);

  if (hasChoicePlus) {
    const planClicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button, a, li, div[role="button"], span[role="button"]'));
      const cp = all.find(el => el.textContent?.toLowerCase().includes('choice plus'));
      if (cp) { cp.click(); return 'clicked: ' + cp.textContent?.trim().substring(0, 80); }
      return 'Choice Plus element not clickable';
    });
    console.log('Choice Plus click:', planClicked);

    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    console.log('URL after plan click:', page.url());
    const afterText = await page.evaluate(() => document.body.innerText);
    console.log('\nPage after Choice Plus (first 4000):\n', afterText.substring(0, 4000));

    // Find search inputs
    const searchInputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent).map(el => ({
        id: el.id, type: el.type, placeholder: el.placeholder,
        ariaLabel: el.getAttribute('aria-label'), name: el.name,
      }))
    );
    console.log('\nSearch inputs:', JSON.stringify(searchInputs, null, 2));
  }

  // Print the latest GetPlanDefinitions response
  const planDefResp = graphqlResponses.filter(r => r.url.includes('GetPlanDefinitions')).pop();
  if (planDefResp) {
    console.log('\n=== GetPlanDefinitions response ===');
    try {
      const parsed = JSON.parse(planDefResp.body);
      // Show just plan names
      const plans = parsed?.data?.getPlanDefinitions;
      if (plans) {
        const allPlanNames = (plans.planDetails || []).map(p => p.planName);
        const catPlans = (plans.planCategories || []).flatMap(c => (c.planDetails || []).map(p => c.planCategory + ': ' + p.planName));
        console.log('Plan names:', [...allPlanNames, ...catPlans].join('\n'));
      }
    } catch { console.log(planDefResp.body.substring(0, 3000)); }
  }

  await browser.close();
})();
