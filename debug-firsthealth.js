const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  try {
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

    const sessionPromise = page.waitForResponse(
      res => res.url().includes('SaveSearchRequestToSession'),
      { timeout: 10000 }
    );
    await page.locator('#btnSubmit').click();
    await sessionPromise;
    await page.waitForURL('**/SearchIndex/**', { timeout: 10000 });

    await page.click('#txtboxZipCode', { clickCount: 3 });
    await page.type('#txtboxZipCode', '77041', { delay: 80 });
    await page.dispatchEvent('#txtboxZipCode', 'change');
    await page.dispatchEvent('#txtboxZipCode', 'blur');
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1000);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }),
      page.evaluate(() => document.querySelector('#SearchNow').click()),
    ]);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Find all divs/sections with provider-looking content and print their ids/classes
    const structure = await page.evaluate(() => {
      const info = [];
      // Top-level divs with id or meaningful class
      document.querySelectorAll('body > * [id], body > * [class]').forEach(el => {
        const id = el.id;
        const cls = el.className;
        const text = el.innerText?.slice(0, 60).replace(/\n/g, ' ');
        if (text && text.trim().length > 5) {
          info.push(`<${el.tagName.toLowerCase()}> id="${id}" class="${cls}" → "${text}"`);
        }
      });
      return info.slice(0, 60).join('\n');
    });
    console.log('=== DOM STRUCTURE ===\n', structure);

    // Try to find the repeating provider card pattern
    const cards = await page.evaluate(() => {
      // Look for repeated elements that contain a name + address pattern
      const allDivs = Array.from(document.querySelectorAll('div'));
      const candidates = allDivs.filter(d => {
        const t = d.innerText || '';
        return t.includes('miles') && t.includes('Specialty Type');
      });
      if (!candidates.length) return 'No card container found with miles+Specialty';
      // Return outerHTML of first candidate
      return candidates[0].outerHTML.slice(0, 4000);
    });
    console.log('\n=== FIRST PROVIDER CARD HTML ===\n', cards);

  } finally {
    await browser.close();
  }
})();
