// debug-aetna4.js
// Dump all inputs on the Aetna landing page to find the correct ZIP selector,
// then navigate through plan selection to providerSearch and capture the real API call.

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  // Capture all API calls that hit providersearch
  const captured = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('publicdse_providersearch') || url.includes('providersearch')) {
      try { captured.push({ url, status: res.status(), body: await res.text() }); } catch {}
    }
  });

  // ── Step 1: Go to the landing page and dump inputs ────────────────────────
  await page.goto('https://www.aetna.com/dsepublic/#/contentPage?page=providerSearchLanding&site_id=dse&language=en', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(2000);
  console.log('Landing URL:', page.url());

  const allInputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, button[type="submit"], select')).map(el => ({
      tag: el.tagName,
      id: el.id,
      name: el.name,
      type: el.type,
      placeholder: el.placeholder,
      class: el.className?.substring(0, 60),
      visible: el.offsetParent !== null,
      ariaLabel: el.getAttribute('aria-label'),
    }));
  });
  console.log('\nAll inputs on landing page:');
  console.log(JSON.stringify(allInputs, null, 2));

  // ── Step 2: Find and fill ZIP input ───────────────────────────────────────
  // Try multiple selectors
  const zipSelectors = ['#zip1', 'input[name="zip"]', 'input[placeholder*="zip" i]', 'input[placeholder*="ZIP" i]',
    'input[type="tel"]', 'input[type="number"]', 'input[maxlength="5"]', 'input[aria-label*="zip" i]'];

  let zipFilled = false;
  for (const sel of zipSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const visible = await el.isVisible();
        console.log(`\nFound ZIP selector "${sel}" - visible: ${visible}`);
        if (visible) {
          await el.fill('77041');
          zipFilled = true;
          console.log('Filled ZIP with selector:', sel);
          break;
        }
      }
    } catch {}
  }

  if (!zipFilled) {
    // Try by label text
    console.log('\nZip input not found by standard selectors, trying by label...');
    const zipFallback = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label'));
      const zipLabel = labels.find(l => l.textContent?.toLowerCase().includes('zip'));
      if (zipLabel) {
        const input = document.getElementById(zipLabel.htmlFor) || zipLabel.querySelector('input');
        if (input) { input.value = '77041'; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); return 'filled via label: ' + zipLabel.textContent; }
      }
      // Last resort: first visible text input
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="tel"], input:not([type])'));
      const visible = inputs.filter(el => el.offsetParent);
      if (visible[0]) { visible[0].value = '77041'; visible[0].dispatchEvent(new Event('input', {bubbles:true})); visible[0].dispatchEvent(new Event('change', {bubbles:true})); return 'filled first visible input: ' + visible[0].id; }
      return 'could not fill';
    });
    console.log('Fallback ZIP fill:', zipFallback);
  }

  await page.waitForTimeout(500);

  // Click search/submit button
  const submitResult = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
    const search = btns.find(b => b.textContent?.toLowerCase().includes('search') || b.value?.toLowerCase().includes('search') || b.type === 'submit');
    if (search) { search.click(); return 'clicked: ' + (search.textContent || search.value); }
    return 'no submit button found';
  });
  console.log('Submit:', submitResult);

  await page.waitForURL('**/providerSearchPlanList**', { timeout: 15000 }).catch(() => {
    console.log('Did not navigate to planList. Current URL:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('After ZIP submit URL:', page.url());

  // ── Step 3: Select MPPO plan ──────────────────────────────────────────────
  const radioResult = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    console.log('Radios found:', radios.length);
    const mppo = radios.find(r => (r.value || '').includes('MPPO'));
    if (mppo) { mppo.click(); return 'clicked MPPO: ' + mppo.value; }
    if (radios[0]) { radios[0].click(); return 'clicked first: ' + radios[0].value; }
    // Try labels
    const labels = Array.from(document.querySelectorAll('label')).filter(l => l.textContent?.includes('Open Choice') || l.textContent?.includes('PPO'));
    if (labels[0]) { labels[0].click(); return 'clicked label: ' + labels[0].textContent?.trim().substring(0,60); }
    return 'no radio found';
  });
  console.log('Radio select:', radioResult);
  await page.waitForTimeout(500);

  // Continue button
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const cont = btns.find(b => b.textContent?.trim() === 'Continue') || btns.find(b => b.textContent?.includes('Continue'));
    if (cont) cont.click();
  });
  await page.waitForURL('**/providerSearch**', { timeout: 15000 }).catch(() => {
    console.log('Did not navigate to providerSearch. URL:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('Provider search URL:', page.url());
  await page.waitForTimeout(1000);

  // ── Step 4: Type in search box FAST, press Enter before autocomplete ───────
  const searchInput = await page.$('#Doctors') || await page.$('input[id*="doctor" i]') || await page.$('input[placeholder*="search" i]');
  if (searchInput) {
    console.log('Found search input, typing quickly...');
    // Type so fast autocomplete can't fire a full selection
    await searchInput.click();
    await page.keyboard.type('Cardiology', { delay: 0 });
    // Immediately press Escape to dismiss any autocomplete, then Enter/Search
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    // Click Search button (not autocomplete item)
    const searchBtnClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const sb = btns.find(b => b.textContent?.trim() === 'Search') || btns.find(b => b.textContent?.includes('Search') && !b.textContent.includes('New'));
      if (sb) { sb.click(); return 'clicked Search button'; }
      // Try submit in form
      const form = document.querySelector('form');
      if (form) { form.requestSubmit(); return 'submitted form'; }
      return 'no search button';
    });
    console.log('Search button:', searchBtnClicked);
  } else {
    // Click "Medical Doctors & Specialists" category directly
    console.log('No #Doctors input, clicking category button...');
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a, button, li, div[role="button"]'));
      const med = els.find(el => el.textContent?.includes('Medical Doctors'));
      if (med) med.click();
    });
  }

  await page.waitForURL('**/providerResults**', { timeout: 20000 }).catch(() => {
    console.log('Results URL:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  if (captured.length > 0) {
    for (const c of captured) {
      console.log('\n=== CAPTURED PROVIDER SEARCH API ===');
      console.log('URL:', c.url.substring(0, 200));
      console.log('Status:', c.status);
      try {
        const parsed = JSON.parse(c.body);
        const arrKey = Object.keys(parsed).find(k => Array.isArray(parsed[k]) && parsed[k].length > 0);
        if (arrKey) {
          console.log(`✅ ${parsed[arrKey].length} results under "${arrKey}"`);
          console.log('Keys:', Object.keys(parsed[arrKey][0]));
          console.log('First result:\n', JSON.stringify(parsed[arrKey][0], null, 2).substring(0, 3000));
        } else {
          console.log(JSON.stringify(parsed, null, 2).substring(0, 3000));
        }
      } catch { console.log('Raw:', c.body.substring(0, 2000)); }
    }
  } else {
    const txt = await page.evaluate(() => document.body.innerText);
    console.log('\nNo API captured. Page text:', txt.substring(0, 1500));
  }

  await browser.close();
})();
