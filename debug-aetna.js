const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'en-US',
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  const page = await context.newPage();
  const apiCalls = [];
  page.on('request', req => {
    const url = req.url();
    if (['fetch','xhr'].includes(req.resourceType()) && url.includes('providersearch'))
      apiCalls.push({ method: req.method(), url });
  });
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('providersearch')) {
      const body = await res.text().catch(() => '');
      console.log('\n=== PROVIDER SEARCH API RESPONSE ===');
      console.log('URL:', url.slice(0, 200));
      console.log('Body preview:', body.slice(0, 2000));
    }
  });
  try {
    // Steps 1-3
    await page.goto('https://www.aetna.com/dsepublic/#/contentPage?page=providerSearchLanding&site_id=dse&language=en', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.fill('#zip1', '77041');
    await page.click('#second-step-continue');
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const r = Array.from(document.querySelectorAll('input[type="radio"]')).find(r => r.id.includes('MPPO') && r.id.toLowerCase().includes('open choice'));
      if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); r.dispatchEvent(new Event('click', { bubbles: true })); }
    });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => /continue/i.test(b.textContent));
      if (btn) btn.click();
    });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    console.log('On search page:', page.url());

    // Click "Medical Doctors & Specialists" category link (not the typeahead)
    const clicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button, [role="button"], [onclick]'));
      const cat = links.find(l => /medical doctor|specialist/i.test(l.textContent));
      if (cat) { cat.click(); return 'clicked: ' + cat.textContent.trim().slice(0,50); }
      // Fallback: look for any clickable with "doctor" or "specialist"
      const all = Array.from(document.querySelectorAll('*')).find(el => /medical doctor/i.test(el.textContent) && el.children.length === 0);
      if (all) { all.click(); return 'clicked leaf: ' + all.textContent.trim().slice(0,50); }
      return 'not found';
    });
    console.log('Category click:', clicked);

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(4000);
    console.log('After category URL:', page.url());
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    console.log('Page text:\n', txt);
  } finally { await browser.close(); }
})();
