// debug-aetna11.js
// Three-level navigation: providerSearch → providerMedical → providerSearchSpecialists → results
// Step 6: click "All Medical Specialists" to trigger the actual provider search API.

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
    await page.evaluate(() => {
      const sb = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim().toLowerCase() === 'search');
      if (sb) sb.click();
    });
    await page.waitForURL('**/providerSearchPlanList**', { timeout: 15000 }).catch(() => {});
  }
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('Plan list URL:', page.url());

  // ── Step 2: Select Open Choice PPO ───────────────────────────────────────
  await page.waitForTimeout(800);
  const labelClicked = await page.evaluate(() => {
    const ppol = Array.from(document.querySelectorAll('label')).find(l => l.textContent?.includes('Open Choice'));
    if (ppol) { ppol.click(); return 'label: ' + ppol.textContent.trim().substring(0, 60); }
    const radio = Array.from(document.querySelectorAll('input[type="radio"]')).find(r => (r.value || '').includes('MPPO'));
    if (radio) { radio.click(); return 'radio: ' + radio.value; }
    return 'not found';
  });
  console.log('Plan label:', labelClicked);
  await page.waitForTimeout(800);

  // ── Step 3: Click visible Continue button ────────────────────────────────
  const contClicked = await page.evaluate(() => {
    const cont = Array.from(document.querySelectorAll('button')).find(b => {
      if (!b.textContent?.includes('Continue')) return false;
      if (b.classList.contains('ng-hide')) return false;
      if (b.offsetParent === null) return false;
      const s = window.getComputedStyle(b);
      return s.display !== 'none' && s.visibility !== 'hidden';
    });
    if (cont) { cont.click(); return 'clicked: ' + cont.id; }
    return 'not found';
  });
  console.log('Continue:', contClicked);
  await page.waitForURL('**/providerSearch**', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('providerSearch:', page.url());
  await page.waitForTimeout(1000);

  // ── Step 4: Click "Medical Doctors & Specialists" → providerMedical ──────
  await page.evaluate(() => {
    const med = Array.from(document.querySelectorAll('a, button, li, span')).find(el => el.offsetParent !== null && el.textContent?.includes('Medical Doctors'));
    if (med) med.click();
  });
  await page.waitForURL('**/providerMedical**', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('providerMedical:', page.url());
  await page.waitForTimeout(800);

  // ── Step 5: Click "Medical Specialists" → providerSearchSpecialists ───────
  await page.evaluate(() => {
    const spec = Array.from(document.querySelectorAll('a, button, li, span')).find(el =>
      el.offsetParent !== null && el.textContent?.includes('Medical Specialists') && !el.textContent?.includes('All'));
    if (spec) spec.click();
  });
  await page.waitForURL('**/providerSearchSpecialists**', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  console.log('providerSearchSpecialists:', page.url());
  await page.waitForTimeout(800);

  // ── Step 6: Click "All Medical Specialists" → actual results ─────────────
  const allSpecClicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, button, li, span, div[role="button"]'));
    // "All Medical Specialists" is the top option
    const allSpec = all.find(el => el.offsetParent !== null && el.textContent?.includes('All Medical Specialists'));
    if (allSpec) { allSpec.click(); return 'clicked: ' + allSpec.tagName + ' | ' + allSpec.textContent.trim().substring(0, 60); }
    // Fallback: try Cardiologist
    const cardio = all.find(el => el.offsetParent !== null && el.textContent?.includes('Cardiologist'));
    if (cardio) { cardio.click(); return 'fallback cardiologist: ' + cardio.textContent.trim().substring(0, 40); }
    // Dump visible
    const vis = all.filter(el => el.offsetParent !== null).map(el => el.textContent?.trim().substring(0, 50)).filter(Boolean).slice(0, 25);
    return 'not found. Visible: ' + JSON.stringify(vis);
  });
  console.log('All specialists click:', allSpecClicked);

  // Wait for final results page
  await page.waitForURL('**/providerResults**', { timeout: 25000 }).catch(() => {
    console.log('Final URL:', page.url());
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log('Final URL:', page.url());

  // ── Print results ─────────────────────────────────────────────────────────
  const providerCalls = captured.filter(c => c.url.includes('providersearch') || c.url.includes('publicdse_provider'));
  if (providerCalls.length > 0) {
    for (const c of providerCalls) {
      console.log('\n=== PROVIDER SEARCH API ===');
      console.log('URL:', c.url.substring(0, 300));
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
    captured.forEach(c => console.log(' ', c.status, c.url.substring(0, 150)));
    const txt = await page.evaluate(() => document.body.innerText);
    console.log('\nPage text:\n', txt.substring(0, 2000));
  }

  await browser.close();
})();
