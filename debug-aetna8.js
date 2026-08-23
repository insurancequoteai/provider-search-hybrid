// debug-aetna8.js
// Fix: re-add explicit Angular event dispatch after typing ZIP (input/change/keyup).
// Continue button fix from aetna7 (ng-hide filter) is kept.

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
    if (url.includes('aetna.com') && (url.includes('providersearch') || url.includes('publicdse_provider'))) {
      try { captured.push({ url, status: res.status(), body: await res.text() }); } catch {}
    }
  });

  // ── Step 1: Landing page ───────────────────────────────────────────────────
  await page.goto('https://www.aetna.com/dsepublic/#/contentPage?page=providerSearchLanding&site_id=dse&language=en', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(2000);
  await page.waitForSelector('#zip1', { timeout: 10000 });

  // Click, clear, type with delay (triggers Angular keydown/keypress/keyup per char)
  await page.click('#zip1', { clickCount: 3 });
  await page.type('#zip1', '77041', { delay: 100 });

  // Dispatch Angular-compatible events explicitly
  await page.evaluate(() => {
    const el = document.querySelector('#zip1');
    if (!el) return;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '1', keyCode: 49 }));
  });
  await page.waitForTimeout(500);

  const zipVal = await page.$eval('#zip1', el => el.value);
  console.log('ZIP value in field:', zipVal);

  // Press Enter to submit
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  await page.waitForURL('**/providerSearchPlanList**', { timeout: 20000 }).catch(() => {
    console.log('Plan list not reached after Enter. URL:', page.url());
  });

  // If Enter didn't work, try clicking Search button
  if (!page.url().includes('providerSearchPlanList')) {
    console.log('Trying Search button click...');
    const searchClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const sb = btns.find(b => b.textContent?.trim().toLowerCase() === 'search' || b.value?.toLowerCase() === 'search');
      if (sb) { sb.click(); return 'clicked: ' + (sb.textContent || sb.value); }
      // Try form submit
      const form = document.querySelector('#zip1')?.closest('form');
      if (form) { form.submit(); return 'submitted form'; }
      return 'no search btn. Buttons: ' + btns.map(b => b.textContent?.trim().substring(0, 20)).filter(Boolean).join(' | ');
    });
    console.log('Search btn:', searchClicked);
    await page.waitForURL('**/providerSearchPlanList**', { timeout: 15000 }).catch(() => {});
  }

  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('Plan list URL:', page.url());

  if (!page.url().includes('providerSearchPlanList')) {
    const txt = await page.evaluate(() => document.body.innerText);
    console.log('Still on landing. Page text:', txt.substring(0, 1000));
    await browser.close();
    return;
  }

  // ── Step 2: Select Open Choice PPO ────────────────────────────────────────
  await page.waitForTimeout(800);
  const labelClicked = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label'));
    const ppol = labels.find(l => l.textContent?.includes('Open Choice'));
    if (ppol) { ppol.click(); return 'clicked: ' + ppol.textContent.trim().substring(0, 60); }
    const radio = Array.from(document.querySelectorAll('input[type="radio"]')).find(r => (r.value || '').includes('MPPO'));
    if (radio) { radio.click(); return 'radio: ' + radio.value; }
    // Dump what's available
    const allLabels = labels.map(l => l.textContent?.trim().substring(0, 50)).filter(Boolean);
    return 'not found. Labels: ' + JSON.stringify(allLabels.slice(0, 10));
  });
  console.log('Plan label:', labelClicked);
  await page.waitForTimeout(800);

  // ── Step 3: Click VISIBLE Continue button (not ng-hide) ───────────────────
  const contClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const cont = btns.find(b => {
      if (!b.textContent?.includes('Continue')) return false;
      if (b.classList.contains('ng-hide')) return false;
      if (b.offsetParent === null) return false;
      const style = window.getComputedStyle(b);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    });
    if (cont) { cont.click(); return 'clicked: ' + cont.id + ' | ' + cont.textContent.trim(); }
    const all = btns.filter(b => b.textContent?.includes('Continue')).map(b => ({
      id: b.id, text: b.textContent.trim().substring(0, 40),
      ngHide: b.classList.contains('ng-hide'), visible: b.offsetParent !== null,
    }));
    return 'not found. All: ' + JSON.stringify(all);
  });
  console.log('Continue click:', contClicked);

  await page.waitForURL('**/providerSearch**', { timeout: 15000 }).catch(() => {
    console.log('providerSearch not reached:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('Provider search URL:', page.url());
  await page.waitForTimeout(1000);

  // ── Step 4: Click "Medical Doctors & Specialists" ─────────────────────────
  const catClicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, button, li, div[role="button"], span'));
    const med = all.find(el => el.offsetParent !== null && el.textContent?.includes('Medical Doctors'));
    if (med) { med.click(); return 'clicked: ' + med.tagName + ' | ' + med.textContent.trim().substring(0, 60); }
    const visible = all.filter(el => el.offsetParent !== null).map(el => el.textContent?.trim().substring(0, 40)).filter(Boolean).slice(0, 25);
    return 'not found. Visible: ' + JSON.stringify(visible);
  });
  console.log('Category click:', catClicked);

  await page.waitForURL('**/providerResults**', { timeout: 20000 }).catch(() => {
    console.log('Results URL:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log('Final URL:', page.url());

  // ── Print captured API calls ───────────────────────────────────────────────
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
          console.log(JSON.stringify(p, null, 2).substring(0, 2000));
        }
      } catch { console.log('Raw:', c.body.substring(0, 1000)); }
    }
  } else {
    const txt = await page.evaluate(() => document.body.innerText);
    console.log('\nNo API captured. Page text:', txt.substring(0, 2000));
  }

  await browser.close();
})();
