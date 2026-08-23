const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
  const page = await context.newPage();

  const apiCalls = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('api') || url.includes('search') || url.includes('graphql')) {
      apiCalls.push({ method: req.method(), url, headers: req.headers()['content-type'] || '' });
    }
  });

  try {
    // Try the main page first
    await page.goto('https://www.zocdoc.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(5000);

    console.log('URL:', page.url());
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 400));
    console.log('Page text:', txt);

    console.log('\nAPI calls:');
    apiCalls.forEach(c => console.log(c.method, c.url));
  } finally { await browser.close(); }
})();
