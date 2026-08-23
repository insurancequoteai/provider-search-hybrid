// debug-aetna3.js
// Intercepts the real publicdse_providersearch API call by clicking the
// "Medical Doctors & Specialists" category button, then captures the full JSON response.

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  // ── Step 1: Landing page → enter ZIP ──────────────────────────────────────
  await page.goto('https://www.aetna.com/dsepublic/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('#zip1', { timeout: 15000 });
  await page.fill('#zip1', '77041');
  console.log('Entered ZIP');

  await Promise.all([
    page.waitForURL('**/providerSearchPlanList**', { timeout: 15000 }),
    page.click('button[type="submit"], button:has-text("Search"), input[type="submit"]'),
  ]).catch(async () => {
    // fallback: JS click on submit
    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]') || document.querySelector('.btn-search');
      if (btn) btn.click();
    });
    await page.waitForURL('**/providerSearchPlanList**', { timeout: 15000 }).catch(() => {});
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  console.log('Plan list URL:', page.url());

  // ── Step 2: Select Open Choice PPO radio ──────────────────────────────────
  const radioClicked = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    const mppo = radios.find(r => r.value && r.value.includes('MPPO'));
    if (mppo) { mppo.click(); return 'clicked MPPO: ' + mppo.value; }
    if (radios[0]) { radios[0].click(); return 'clicked first radio: ' + radios[0].value; }
    return 'no radio found';
  });
  console.log('Radio:', radioClicked);
  await page.waitForTimeout(500);

  // Click Continue button
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const cont = btns.find(b => b.textContent?.trim() === 'Continue');
    if (cont) cont.click();
    else {
      const any = btns.find(b => b.textContent?.includes('Continue'));
      if (any) any.click();
    }
  });
  await page.waitForURL('**/providerSearch**', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  console.log('Provider search URL:', page.url());

  // ── Step 3: Set up response interceptor BEFORE clicking category ───────────
  const captured = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('publicdse_providersearch') || url.includes('providersearch')) {
      try {
        const body = await res.text();
        captured.push({ url, status: res.status(), body });
        console.log('\n>>> CAPTURED API RESPONSE:', url, 'status:', res.status());
      } catch (e) {
        captured.push({ url, status: res.status(), body: 'error reading: ' + e.message });
      }
    }
  });

  // Also dump all API calls for reference
  const allCalls = [];
  page.on('request', req => {
    if (req.url().includes('aetna.com') || req.url().includes('api01')) {
      allCalls.push(req.url());
    }
  });

  // ── Step 4: Click "Medical Doctors & Specialists" category ────────────────
  await page.waitForTimeout(1000);
  const categoryClicked = await page.evaluate(() => {
    // Try by text content
    const allEls = Array.from(document.querySelectorAll('a, button, div[role="button"], li[role="button"]'));
    const med = allEls.find(el => el.textContent && el.textContent.includes('Medical Doctors'));
    if (med) { med.click(); return 'clicked: ' + med.tagName + ' | ' + med.textContent.trim().substring(0, 60); }

    // Fallback: any element with "Medical" in text
    const any = allEls.find(el => el.textContent && el.textContent.includes('Medical') && !el.textContent.includes('Mental'));
    if (any) { any.click(); return 'fallback clicked: ' + any.tagName + ' | ' + any.textContent.trim().substring(0, 60); }
    return 'not found';
  });
  console.log('Category click:', categoryClicked);

  // Wait for results page and API response (up to 20s)
  await page.waitForURL('**/providerResults**', { timeout: 20000 }).catch(() => {
    console.log('Still on:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  console.log('\nFinal URL:', page.url());
  console.log('All aetna API calls:', allCalls.slice(-10));

  if (captured.length > 0) {
    for (const cap of captured) {
      console.log('\n=== PROVIDER SEARCH RESPONSE ===');
      console.log('URL:', cap.url);
      console.log('Status:', cap.status);
      try {
        const parsed = JSON.parse(cap.body);
        console.log('Top-level keys:', Object.keys(parsed));
        const arrKey = Object.keys(parsed).find(k => Array.isArray(parsed[k]) && parsed[k].length > 0);
        if (arrKey) {
          console.log(`\n${parsed[arrKey].length} providers under "${arrKey}"`);
          console.log('First provider keys:', Object.keys(parsed[arrKey][0]));
          console.log('First provider:\n', JSON.stringify(parsed[arrKey][0], null, 2).substring(0, 3000));
        } else {
          console.log(JSON.stringify(parsed, null, 2).substring(0, 4000));
        }
      } catch {
        console.log('Raw (first 3000):', cap.body.substring(0, 3000));
      }
    }
  } else {
    console.log('\nNo provider search API response captured.');
    // Dump page text to see what happened
    const txt = await page.evaluate(() => document.body.innerText);
    console.log('Page text:', txt.substring(0, 2000));
  }

  await browser.close();
})();
