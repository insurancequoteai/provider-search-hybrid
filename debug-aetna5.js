// debug-aetna5.js
// Fix: use page.type() so Angular registers the input change,
// click "Continue as guest" first, then find the Search button by text.

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const captured = [];
  page.on('response', async res => {
    if (res.url().includes('publicdse_providersearch')) {
      try { captured.push({ url: res.url(), status: res.status(), body: await res.text() }); } catch {}
    }
  });

  await page.goto('https://www.aetna.com/dsepublic/#/contentPage?page=providerSearchLanding&site_id=dse&language=en', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(2000);

  // Step 0: Click "Continue as a guest" if present
  const guestClicked = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a, button, span[role="button"]'));
    const guest = links.find(el => el.textContent?.toLowerCase().includes('continue as a guest') || el.textContent?.toLowerCase().includes('guest'));
    if (guest) { guest.click(); return 'clicked: ' + guest.textContent.trim(); }
    return 'not found';
  });
  console.log('Continue as guest:', guestClicked);
  await page.waitForTimeout(1000);

  // Step 1: Clear and type into #zip1 (page.type triggers Angular events)
  await page.waitForSelector('#zip1', { timeout: 10000 });
  await page.click('#zip1', { clickCount: 3 }); // select all
  await page.type('#zip1', '77041', { delay: 80 });

  // Dispatch Angular-compatible events
  await page.evaluate(() => {
    const el = document.querySelector('#zip1');
    if (!el) return;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  });
  await page.waitForTimeout(600);
  console.log('ZIP typed. Input value:', await page.$eval('#zip1', el => el.value));

  // Step 2: Click the Search button (find by text content)
  const searchClicked = await page.evaluate(() => {
    // Try: button with text "Search"
    const allBtns = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"]'));
    const search = allBtns.find(b => b.textContent?.trim().toLowerCase() === 'search');
    if (search) { search.click(); return 'clicked Search (exact): ' + search.outerHTML.substring(0, 100); }

    // Try: button containing "Search"
    const search2 = allBtns.find(b => b.textContent?.toLowerCase().includes('search'));
    if (search2) { search2.click(); return 'clicked Search (contains): ' + search2.outerHTML.substring(0, 100); }

    // Try: submit button near the zip field
    const zipForm = document.querySelector('#zip1')?.closest('form');
    if (zipForm) {
      const formBtn = zipForm.querySelector('button, input[type="submit"]');
      if (formBtn) { formBtn.click(); return 'clicked form button: ' + formBtn.outerHTML.substring(0, 100); }
      zipForm.submit();
      return 'submitted form';
    }

    return 'no search button found. Available buttons: ' + Array.from(document.querySelectorAll('button')).map(b => JSON.stringify(b.textContent?.trim().substring(0,20))).join(', ');
  });
  console.log('Search click:', searchClicked);

  await page.waitForURL('**/providerSearchPlanList**', { timeout: 20000 }).catch(() => {
    console.log('Still on:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('After search URL:', page.url());

  if (!page.url().includes('providerSearchPlanList')) {
    // Try pressing Enter on the zip field
    console.log('Trying Enter key on ZIP field...');
    await page.focus('#zip1');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/providerSearchPlanList**', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    console.log('After Enter URL:', page.url());
  }

  // Step 3: Select MPPO plan
  await page.waitForTimeout(500);
  const radioResult = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    const mppo = radios.find(r => (r.value || '').includes('MPPO'));
    if (mppo) { mppo.click(); return 'MPPO: ' + mppo.value; }
    // Try label click
    const labels = Array.from(document.querySelectorAll('label'));
    const ppol = labels.find(l => l.textContent?.includes('Open Choice') || l.textContent?.includes('PPO'));
    if (ppol) { ppol.click(); return 'label: ' + ppol.textContent.trim().substring(0,60); }
    if (radios[0]) { radios[0].click(); return 'first radio: ' + radios[0].value; }
    // Dump all options
    const opts = Array.from(document.querySelectorAll('input[type="radio"], label')).map(el => el.textContent?.trim() || el.value).filter(Boolean).slice(0,10);
    return 'no radio. Options: ' + JSON.stringify(opts);
  });
  console.log('Plan select:', radioResult);
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const cont = btns.find(b => b.textContent?.trim() === 'Continue') || btns.find(b => b.textContent?.includes('Continue'));
    if (cont) cont.click();
  });
  await page.waitForURL('**/providerSearch**', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('Provider search URL:', page.url());
  await page.waitForTimeout(1000);

  // Step 4: Type quickly + press Escape + click Search (no autocomplete selection)
  const doctorInput = await page.$('#Doctors');
  if (doctorInput) {
    await doctorInput.click();
    await page.keyboard.type('Cardiology', { delay: 0 }); // type fast
    await page.keyboard.press('Escape'); // close autocomplete
    await page.waitForTimeout(200);
    // Click the Search button explicitly
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const sb = btns.find(b => b.textContent?.trim() === 'Search') || btns.find(b => b.ariaLabel === 'Search');
      if (sb) sb.click();
    });
    console.log('Typed Cardiology + pressed Escape + clicked Search');
  } else {
    console.log('No #Doctors input. Clicking Medical Doctors category...');
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('a, button, li'));
      const med = all.find(el => el.textContent?.includes('Medical Doctors'));
      if (med) med.click();
    });
  }

  await page.waitForURL('**/providerResults**', { timeout: 20000 }).catch(() => console.log('Results URL:', page.url()));
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log('Final URL:', page.url());

  if (captured.length > 0) {
    for (const c of captured) {
      console.log('\n=== PROVIDER SEARCH API CAPTURED ===');
      console.log('URL:', c.url.substring(0, 300));
      console.log('Status:', c.status);
      try {
        const p = JSON.parse(c.body);
        const key = Object.keys(p).find(k => Array.isArray(p[k]) && p[k].length > 0);
        if (key) {
          console.log(`✅ ${p[key].length} results under "${key}"`);
          console.log('Keys:', Object.keys(p[key][0]));
          console.log('\nFirst result:\n', JSON.stringify(p[key][0], null, 2).substring(0, 3000));
        } else console.log(JSON.stringify(p, null, 2).substring(0, 3000));
      } catch { console.log('Raw:', c.body.substring(0, 2000)); }
    }
  } else {
    const txt = await page.evaluate(() => document.body.innerText);
    console.log('\nNo API captured. Page:', txt.substring(0, 1500));
  }

  await browser.close();
})();
