// debug-uhc13.js
// Direct URL bypass works! Navigate to /find-care?plan=s00001&zip=77041 directly.
// Then close Smart Choice modal, search for providers, capture GraphQL response.

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

  const apiResponses = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('graphql') && url.includes('uhc.com')) {
      try { apiResponses.push({ url, op: new URL(url).searchParams.get('q'), body: await res.text() }); } catch {}
    }
  });

  // Step 1: Visit landing page first to get guest session cookie
  await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  console.log('Guest session established');

  // Step 2: Navigate directly to find-care with Choice Plus plan + Houston zip
  await page.goto('https://findcare.guest.uhc.com/find-care?plan=s00001&zip=77041', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(2000);
  console.log('Find-care URL:', page.url());

  // Dump what's on the page
  const initialText = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('Initial page text:', initialText.replace(/\n+/g, ' '));

  // Step 3: Dismiss Smart Choice modal (and any other modal)
  const dismissed = await page.evaluate(() => {
    const selectors = [
      'button[aria-label="close"]', 'button[aria-label="Close"]',
      '[data-testid="modal-close"]', '[aria-label="Close dialog"]',
      'button[class*="close"]', '.abyss-icon-button',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { el.click(); return 'dismissed: ' + sel; }
    }
    // Find any close button in a dialog
    const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]');
    for (const d of dialogs) {
      const btns = Array.from(d.querySelectorAll('button'));
      const closeBtn = btns.find(b => b.getAttribute('aria-label')?.toLowerCase().includes('close') || b.textContent?.toLowerCase().trim() === 'close');
      if (closeBtn) { closeBtn.click(); return 'dismissed dialog close btn'; }
    }
    return 'no modal found';
  });
  console.log('Modal dismiss:', dismissed);
  await page.waitForTimeout(1000);

  // Step 4: See what inputs / search UI is now visible
  const pageText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
  console.log('\nAfter modal dismiss (1000 chars):', pageText.replace(/\n+/g, '\n').substring(0, 800));

  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent !== null).map(el => ({
      id: el.id, placeholder: el.placeholder, ariaLabel: el.getAttribute('aria-label'),
      type: el.type, name: el.name, role: el.getAttribute('role'),
    }))
  );
  console.log('\nVisible inputs:', JSON.stringify(inputs, null, 2));

  // Step 5: Try to search for "Cardiologist" using the search input
  // First find the search input
  const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"], input[aria-label*="Search"], input[aria-label*="search"]').first();
  const searchCount = await searchInput.count();
  console.log('\nSearch inputs found:', searchCount);

  if (searchCount > 0) {
    await searchInput.click();
    await searchInput.type('Cardiologist', { delay: 80 });
    await page.waitForTimeout(1500);

    // Check for autocomplete options
    const acOpts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="option"], [role="listbox"] li, [class*="suggestion"], [class*="autocomplete"] li'))
        .filter(el => el.offsetParent !== null)
        .map(el => el.textContent?.trim().substring(0, 60))
        .filter(Boolean)
        .slice(0, 10)
    );
    console.log('Autocomplete options:', acOpts);

    if (acOpts.length > 0) {
      // Click first option
      await page.evaluate(() => {
        const opt = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] li')).find(el => el.offsetParent !== null);
        if (opt) opt.click();
      });
      await page.waitForTimeout(500);
    }

    // Set up response watcher before submitting
    const searchResponsePromise = page.waitForResponse(
      res => res.url().includes('/api/graphql') && res.url().includes('uhc.com'),
      { timeout: 15000 }
    ).catch(() => null);

    // Submit search (try Enter or Search button)
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // Also try clicking Search button
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const sb = btns.find(b => b.textContent?.trim().toLowerCase() === 'search' || b.getAttribute('aria-label')?.toLowerCase() === 'search');
      if (sb) sb.click();
    });

    const searchResp = await searchResponsePromise;
    if (searchResp) {
      console.log('\nFirst GraphQL response after search:', searchResp.url().substring(0, 150));
    }
  } else {
    // No search input — maybe there are category cards
    console.log('No search input. Looking for category links...');
    const catClicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('a, button, li, div[role="button"]'));
      const cats = ['Primary Care', 'Specialty Care', 'Doctor', 'Physician', 'Cardiologist', 'Mental Health'];
      for (const cat of cats) {
        const el = all.find(e => e.offsetParent !== null && e.textContent?.includes(cat));
        if (el) { el.click(); return 'clicked: ' + el.textContent.trim().substring(0, 60); }
      }
      const vis = all.filter(e => e.offsetParent !== null).map(e => e.textContent?.trim().substring(0, 40)).filter(Boolean).slice(0, 20);
      return 'nothing found. Visible: ' + JSON.stringify(vis);
    });
    console.log('Category click:', catClicked);
  }

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log('\nFinal URL:', page.url());

  const finalText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
  console.log('\nFinal page text:\n', finalText.replace(/\n+/g, '\n').substring(0, 2000));

  // Print all captured GraphQL responses
  console.log(`\n=== GraphQL responses (${apiResponses.length}) ===`);
  for (const r of apiResponses) {
    console.log('\nOperation:', r.op || r.url.substring(0, 80));
    try {
      const p = JSON.parse(r.body);
      const dataKeys = Object.keys(p?.data || {});
      console.log('Data keys:', dataKeys);
      // Look for provider data
      for (const k of dataKeys) {
        const val = p.data[k];
        if (Array.isArray(val) && val.length > 0) {
          console.log(`  ${k}: array of ${val.length}, first item keys:`, Object.keys(val[0]));
          console.log('  First item:', JSON.stringify(val[0], null, 2).substring(0, 1000));
        } else if (val && typeof val === 'object') {
          const subArrayKey = Object.keys(val).find(sk => Array.isArray(val[sk]) && val[sk].length > 0);
          if (subArrayKey) {
            console.log(`  ${k}.${subArrayKey}: array of ${val[subArrayKey].length}`);
            console.log('  First:', JSON.stringify(val[subArrayKey][0], null, 2).substring(0, 500));
          } else {
            console.log(`  ${k}:`, JSON.stringify(val, null, 2).substring(0, 300));
          }
        }
      }
    } catch { console.log('Raw:', r.body.substring(0, 200)); }
  }

  await browser.close();
})();
