// debug-uhc6.js
// Location select works — now wait longer for plans to render, click Choice Plus,
// then capture the provider search that follows.

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

  const graphql = [];
  page.on('response', async res => {
    if (res.url().includes('graphql') && res.url().includes('uhc')) {
      try { graphql.push({ url: res.url(), body: await res.text() }); } catch {}
    }
  });

  // Steps 1–3: get to plan-selection
  await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('Explore coverage'))[0]?.click());
  await page.waitForURL('**/select-coverage-type**', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('Explore'))[0]?.click());
  await page.waitForURL('**/plan-selection**', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Step 4: Enter 77041, click first dropdown option
  const locInput = await page.$('input[role="combobox"]') || await page.$('input[aria-autocomplete]');
  await locInput.click();
  await locInput.fill('77041');
  await page.waitForTimeout(1500);
  const optClicked = await page.evaluate(() => {
    const opts = Array.from(document.querySelectorAll('[role="option"]'));
    if (opts[0]) { opts[0].click(); return 'clicked: ' + opts[0].textContent.trim(); }
    return 'no option';
  });
  console.log('Location option:', optClicked);

  // Wait up to 10 seconds for plans to render
  console.log('Waiting for plans to load...');
  let planText = '';
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    planText = await page.evaluate(() => document.body.innerText);
    if (planText.toLowerCase().includes('choice plus')) {
      console.log(`Plans loaded after ${i + 1}s`);
      break;
    }
    if (i === 9) console.log('Plans still not loaded after 10s');
  }

  const hasChoicePlus = planText.toLowerCase().includes('choice plus');
  console.log('Choice Plus on page:', hasChoicePlus);

  if (!hasChoicePlus) {
    console.log('\nPage text (first 3000):\n', planText.substring(0, 3000));
    // Dump GraphQL to see what was returned
    const latest = graphql.filter(r => r.url.includes('GetPlanDefinitions')).pop();
    if (latest) {
      const p = JSON.parse(latest.body);
      const names = (p?.data?.getPlanDefinitions?.planDetails || []).map(pl => pl.planName)
        .concat((p?.data?.getPlanDefinitions?.planCategories || []).flatMap(c => c.planDetails.map(pl => pl.planName)));
      console.log('Plans from API:', names.join(', '));
    }
    await browser.close();
    return;
  }

  // Step 5: Click "Choice Plus" in the plan list
  const cpClicked = await page.evaluate(() => {
    // Try buttons/links with exact "Choice Plus" text
    const all = Array.from(document.querySelectorAll('button, a, li, div[role="button"], span'));
    const cp = all.find(el => el.textContent?.trim().toLowerCase() === 'choice plus');
    if (cp) { cp.click(); return 'exact: ' + cp.tagName + ' | ' + cp.textContent.trim(); }
    // Fallback: contains
    const cp2 = all.find(el => el.textContent?.toLowerCase().includes('choice plus') && !el.textContent?.includes('Advanced') && !el.textContent?.includes('Premier') && !el.textContent?.includes('HMO'));
    if (cp2) { cp2.click(); return 'contains: ' + cp2.tagName + ' | ' + cp2.textContent.trim().substring(0, 80); }
    return 'not clickable';
  });
  console.log('Choice Plus click:', cpClicked);

  await page.waitForTimeout(4000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  console.log('URL after plan:', page.url());

  const afterText = await page.evaluate(() => document.body.innerText);
  console.log('\nPage after Choice Plus (first 5000):\n', afterText.substring(0, 5000));

  // Inputs on the next page
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent).map(el => ({
      id: el.id, type: el.type, placeholder: el.placeholder,
      ariaLabel: el.getAttribute('aria-label'), name: el.name, role: el.getAttribute('role'),
    }))
  );
  console.log('\nVisible inputs:', JSON.stringify(inputs, null, 2));

  // Print all GraphQL calls made
  console.log('\n=== All GraphQL q= params ===');
  for (const r of graphql) {
    const q = new URL(r.url).searchParams.get('q');
    console.log(q, '-', r.url);
  }

  await browser.close();
})();
