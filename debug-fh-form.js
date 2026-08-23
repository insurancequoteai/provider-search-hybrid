const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  try {
    // Navigate through steps 1 & 2 to reach SearchIndex
    await page.goto('https://providerlocator.firsthealth.com/LocateProvider/LocateProviderSearch/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"][name="RadioButtonSelected"]'));
      const fh = radios.find(r => {
        const label = document.querySelector(`label[for="${r.id}"]`);
        return label && label.textContent.includes('First Health') && !label.textContent.includes('Choice');
      }) || radios[0];
      if (fh) fh.click();
      document.querySelector('#btnSubmit').click();
    });
    await page.waitForURL('**/ProviderTypeSelection/**', { timeout: 15000 });

    await page.locator('div#Physician label.btn').click();
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const cb = document.querySelector('#AcceptingNewPatients');
      if (cb && !cb.checked) cb.click();
    });
    await page.waitForTimeout(300);
    const sessionPromise = page.waitForResponse(res => res.url().includes('SaveSearchRequestToSession'), { timeout: 10000 });
    await page.locator('#btnSubmit').click();
    await sessionPromise;
    await page.waitForURL('**/SearchIndex/**', { timeout: 10000 });

    console.log('On SearchIndex. Dumping all form fields:\n');

    // Dump every input, select, textarea on the page
    const fields = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input, select, textarea, button'));
      return els.map(el => ({
        tag: el.tagName,
        id: el.id,
        name: el.name,
        type: el.type || '',
        placeholder: el.placeholder || '',
        value: el.value || '',
        label: (() => {
          // find associated label
          if (el.id) {
            const lbl = document.querySelector(`label[for="${el.id}"]`);
            if (lbl) return lbl.textContent.trim();
          }
          return el.closest('label')?.textContent?.trim() || '';
        })(),
        options: el.tagName === 'SELECT'
          ? Array.from(el.options).slice(0, 15).map(o => `${o.value}: ${o.text}`)
          : [],
      }));
    });

    fields.forEach(f => {
      if (f.type === 'hidden') return; // skip hidden
      console.log(`[${f.tag}#${f.id || f.name}] type="${f.type}" label="${f.label}" placeholder="${f.placeholder}"`);
      if (f.options.length) console.log('  options:', f.options.join(' | '));
    });

  } finally {
    await browser.close();
  }
})();
