// debug-aetna10.js
// Based on debug-aetna8.js (which worked through providerMedical).
// Adds Step 5: click "Medical Specialists" on providerMedical to reach providerResults + API.

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

  // ── Step 1: ZIP → Search ──────────────────────────────────────────────────
  await page.goto('https://www.aetna.com/dsepublic/#/contentPage?page=providerSearchLanding&site_id=dse&language=en', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(2000);
  await page.waitForSelector('#zip1', { timeout: 10000 });
  await page.click('#zip1', { clickCount: 3 });
  await page.type('#zip1', '77041', { delay: 100 });
  await page.evaluate(() => {
    const el = document.querySelector('#zip1');
    if (!el) return;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForURL('**/providerSearchPlanList**', { timeout: 20000 }).catch(() => {});
  if (!page.url().includes('providerSearchPlanList')) {
    const searchClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const sb = btns.find(b => b.textContent?.trim().toLowerCase() === 'search' || b.value?.toLowerCase() === 'search');
      if (sb) { sb.click(); return 'clicked: ' + (sb.textContent || sb.value); }
      const form = document.querySelector('#zip1')?.closest('form');
      if (form) { form.submit(); return 'submitted form'; }
      return 'no search btn';
    });
    console.log('Search btn:', searchClicked);
    await page.waitForURL('**/providerSearchPlanList**', { timeout: 15000 }).catch(() => {});
  }
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('Plan list URL:', page.url());

  // ── Step 2: Select Open Choice PPO ───────────────────────────────────────
  await page.waitForTimeout(800);
  const labelClicked = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label'));
    const ppol = labels.find(l => l.textContent?.includes('Open Choice'));
    if (ppol) { ppol.click(); return 'clicked: ' + ppol.textContent.trim().substring(0, 60); }
    const radio = Array.from(document.querySelectorAll('input[type="radio"]')).find(r => (r.value || '').includes('MPPO'));
    if (radio) { radio.click(); return 'radio: ' + radio.value; }
    const allLabels = Array.from(document.querySelectorAll('label')).map(l => l.textContent?.trim().substring(0, 50)).filter(Boolean);
    return 'not found. Labels: ' + JSON.stringify(allLabels.slice(0, 10));
  });
  console.log('Plan label:', labelClicked);
  await page.waitForTimeout(800);

  // ── Step 3: Click VISIBLE Continue button (not ng-hide) ──────────────────
  const contClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const cont = btns.find(b => {
      if (!b.textContent?.includes('Continue')) return false;
      if (b.classList.contains('ng-hide')) return false;
      if (b.offsetParent === null) return false;
      const s = window.getComputedStyle(b);
      return s.display !== 'none' && s.visibility !== 'hidden';
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

  if (!page.url().includes('providerSearch')) {
    const txt = await page.evaluate(() => document.body.innerText);
    console.log('Stuck. Page text:', txt.substring(0, 1000));
    await browser.close();
    return;
  }

  // ── Step 4: Click "Medical Doctors & Specialists" → providerMedical ──────
  const cat1Clicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, button, li, div[role="button"], span'));
    const med = all.find(el => el.offsetParent !== null && el.textContent?.includes('Medical Doctors'));
    if (med) { med.click(); return 'clicked: ' + med.tagName + ' | ' + med.textContent.trim().substring(0, 60); }
    const vis = all.filter(el => el.offsetParent !== null).map(el => el.textContent?.trim().substring(0, 40)).filter(Boolean).slice(0, 25);
    return 'not found. Visible: ' + JSON.stringify(vis);
  });
  console.log('Category click:', cat1Clicked);

  await page.waitForURL('**/providerMedical**', { timeout: 15000 }).catch(() => {
    console.log('providerMedical not reached:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('Sub-menu URL:', page.url());
  await page.waitForTimeout(800);

  // ── Step 5: Click sub-category on providerMedical ─────────────────────────
  const cat2Clicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, button, li, span, div[role="button"]'));
    // Try "Medical Specialists"
    const spec = all.find(el => el.offsetParent !== null && el.textContent?.includes('Medical Specialists') && !el.textContent?.includes('All'));
    if (spec) { spec.click(); return 'clicked: ' + spec.tagName + ' | ' + spec.textContent.trim().substring(0, 60); }
    // Try "All Medical Professionals"
    const allMed = all.find(el => el.offsetParent !== null && el.textContent?.includes('All Medical'));
    if (allMed) { allMed.click(); return 'all medical: ' + allMed.textContent.trim().substring(0, 60); }
    // Dump what's on the page
    const vis = all.filter(el => el.offsetParent !== null).map(el => el.textContent?.trim().substring(0, 50)).filter(Boolean).slice(0, 25);
    return 'not found. Visible: ' + JSON.stringify(vis);
  });
  console.log('Sub-category click:', cat2Clicked);

  await page.waitForURL('**/providerResults**', { timeout: 25000 }).catch(() => {
    console.log('providerResults not reached:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log('Final URL:', page.url());

  // ── Print results ─────────────────────────────────────────────────────────
  const providerCalls = captured.filter(c => c.url.includes('providersearch') || c.url.includes('publicdse_provider'));
  if (providerCalls.length > 0) {
    for (const c of providerCalls) {
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
    console.log('\nAll captured URLs:');
    captured.forEach(c => console.log(' ', c.status, c.url.substring(0, 120)));
    const txt = await page.evaluate(() => document.body.innerText);
    console.log('\nPage text:\n', txt.substring(0, 2000));
  }

  await browser.close();
})();
