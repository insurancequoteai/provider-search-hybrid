const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'en-US',
  });
  const page = await context.newPage();
  const apiCalls = [];
  page.on('request', req => {
    const url = req.url();
    if (['fetch','xhr'].includes(req.resourceType()) && !url.includes('datadog') && !url.includes('demdex') && !url.includes('adobe') && !url.includes('launchdarkly') && !url.includes('qualtrics'))
      apiCalls.push(req.method() + ' ' + url);
  });
  try {
    await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(4000);

    // Click "Employer and Individual" Explore coverage (first button)
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      // Find button that follows "Employer and Individual" text
      const expBtns = btns.filter(b => b.textContent.includes('Explore coverage'));
      if (expBtns[0]) { expBtns[0].click(); return 'clicked first Explore coverage'; }
      return 'not found';
    });
    console.log('Click result:', clicked);

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(4000);
    console.log('URL:', page.url());
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 1000));
    console.log('Page text:\n', txt);

    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, button, select')).filter(e => e.offsetParent).map(e => ({
        tag: e.tagName, id: e.id, placeholder: e.placeholder || '',
        type: e.type || '', ariaLabel: e.getAttribute('aria-label') || '',
        text: e.textContent?.trim().slice(0,50),
      })).slice(0,15)
    );
    console.log('\nVisible inputs:\n', JSON.stringify(inputs, null, 2));
    console.log('\nAPI calls:\n', apiCalls.slice(0,15).join('\n'));
  } finally { await browser.close(); }
})();
