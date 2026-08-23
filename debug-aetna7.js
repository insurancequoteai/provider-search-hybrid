// debug-aetna7.js
// Fix: use page.evaluate() for the Continue button to find the VISIBLE one (not ng-hide).

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
    const url = res.url();
    if (url.includes('aetna.com') && (url.includes('providersearch') || url.includes('publicdse'))) {
      try { captured.push({ url, status: res.status(), body: await res.text() }); } catch {}
    }
  });

  // ── Step 1: Landing → type ZIP → press Enter ───────────────────────────────
  await page.goto('https://www.aetna.com/dsepublic/#/contentPage?page=providerSearchLanding&site_id=dse&language=en', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(2000);
  await page.waitForSelector('#zip1', { timeout: 10000 });
  await page.click('#zip1', { clickCount: 3 });
  await page.type('#zip1', '77041', { delay: 80 });
  await page.waitForTimeout(300);
  // Press Enter — Angular handles form submit via keydown/keyup
  await page.keyboard.press('Enter');
  await page.waitForURL('**/providerSearchPlanList**', { timeout: 20000 }).catch(() => {
    console.log('Plan list URL not reached. Current:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('Plan list URL:', page.url());

  // ── Step 2: Click Open Choice PPO label ────────────────────────────────────
  await page.waitForTimeout(800);
  const labelClicked = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label'));
    const ppol = labels.find(l => l.textContent?.includes('Open Choice'));
    if (ppol) { ppol.click(); return 'clicked: ' + ppol.textContent.trim().substring(0, 60); }
    // Fallback: radio with MPPO
    const radio = Array.from(document.querySelectorAll('input[type="radio"]')).find(r => (r.value || '').includes('MPPO'));
    if (radio) { radio.click(); return 'radio: ' + radio.value; }
    return 'not found';
  });
  console.log('Plan label:', labelClicked);
  await page.waitForTimeout(800); // wait for Angular to update ng-show

  // ── Step 3: Click the VISIBLE Continue button (skip ng-hide ones) ──────────
  const contClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    // Find visible Continue button: not ng-hide, offsetParent not null, display not none
    const cont = btns.find(b => {
      if (!b.textContent?.includes('Continue')) return false;
      if (b.classList.contains('ng-hide')) return false;
      if (b.offsetParent === null) return false;
      const style = window.getComputedStyle(b);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    });
    if (cont) { cont.click(); return 'clicked: ' + cont.id + ' | ' + cont.textContent.trim(); }
    // Dump all Continue buttons for debugging
    const all = btns.filter(b => b.textContent?.includes('Continue')).map(b => ({
      id: b.id, text: b.textContent.trim(), hidden: b.classList.contains('ng-hide'), visible: b.offsetParent !== null,
    }));
    return 'not found. All Continue btns: ' + JSON.stringify(all);
  });
  console.log('Continue click:', contClicked);

  await page.waitForURL('**/providerSearch**', { timeout: 15000 }).catch(() => {
    console.log('Provider search not reached:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('Provider search URL:', page.url());
  await page.waitForTimeout(1000);

  // ── Step 4: Click "Medical Doctors & Specialists" category ─────────────────
  const catClicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, button, li, div[role="button"], span'));
    const med = all.find(el => el.offsetParent !== null && el.textContent?.includes('Medical Doctors'));
    if (med) { med.click(); return 'clicked: ' + med.tagName + ' | ' + med.textContent.trim().substring(0, 60); }
    // Dump visible clickable items for debugging
    const visible = all.filter(el => el.offsetParent !== null).map(el => el.textContent?.trim().substring(0, 40)).filter(Boolean).slice(0, 20);
    return 'not found. Visible items: ' + JSON.stringify(visible);
  });
  console.log('Category click:', catClicked);

  await page.waitForURL('**/providerResults**', { timeout: 20000 }).catch(() => {
    console.log('Results URL:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log('Final URL:', page.url());

  if (captured.length > 0) {
    for (const c of captured) {
      console.log('\n=== PROVIDER SEARCH API ===');
      console.log('URL:', c.url.substring(0, 250));
      console.log('Status:', c.status);
      try {
        const p = JSON.parse(c.body);
        const key = Object.keys(p).find(k => Array.isArray(p[k]) && p[k].length > 0);
        if (key) {
          console.log(`✅ ${p[key].length} providers under "${key}"`);
          console.log('Keys:', Object.keys(p[key][0]));
          console.log('\nFirst provider:\n', JSON.stringify(p[key][0], null, 2).substring(0, 3000));
        } else {
          console.log(JSON.stringify(p, null, 2).substring(0, 3000));
        }
      } catch { console.log('Raw:', c.body.substring(0, 1000)); }
    }
  } else {
    const txt = await page.evaluate(() => document.body.innerText);
    console.log('\nNo API. Page text:', txt.substring(0, 1500));
  }

  await browser.close();
})();
