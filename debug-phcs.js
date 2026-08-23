const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  });

  // Capture all XHR/fetch calls so we can find the search API
  const apiCalls = [];
  page.on('request', req => {
    if (['fetch','xhr'].includes(req.resourceType())) {
      apiCalls.push({ method: req.method(), url: req.url() });
    }
  });

  try {
    await page.goto('https://providersearch.multiplan.com/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000);

    // Try clicking whatever is on the page
    await page.evaluate(() => {
      // Click any button that isn't the language switch
      const btns = Array.from(document.querySelectorAll('button'));
      const search = btns.find(b => b.textContent && !b.textContent.includes('Español'));
      if (search) search.click();
    });
    await page.waitForTimeout(3000);

    console.log('URL after click:', page.url());

    // Dump ALL inputs regardless of visibility
    const all = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, button, select, [role="combobox"], [role="textbox"]')).map(el => ({
        tag: el.tagName, id: el.id, type: el.type || '',
        placeholder: el.placeholder || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        dataTestId: el.getAttribute('data-testid') || '',
        visible: el.offsetParent !== null,
        text: el.textContent?.trim().slice(0, 40),
      }))
    );
    console.log('\nAll form elements:');
    all.forEach(f => console.log(JSON.stringify(f)));

    console.log('\nAPI calls captured:');
    apiCalls.forEach(c => console.log(c.method, c.url));

    const txt = await page.evaluate(() => document.body.innerText.slice(0, 1000));
    console.log('\nPage text:\n', txt);
  } finally { await browser.close(); }
})();
