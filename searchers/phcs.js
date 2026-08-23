/**
 * PHCS / MultiPlan Searcher
 *
 * TO SPEED UP: Open providersearch.multiplan.com in Chrome DevTools →
 * Network → Fetch/XHR → run a search → find the API call → replace
 * the Playwright code below with a direct fetch().
 */

const { chromium } = require('playwright');

module.exports = async function phcsSearch({ zip, name, specialty }) {
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();

  try {
    await page.goto('https://providersearch.multiplan.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    // Plan field — type "PHCS" to identify the network
    const planField = 'input[placeholder*="plan"], input[placeholder*="Plan"], [data-testid="plan-input"]';
    if (await page.isVisible(planField)) {
      await page.fill(planField, 'PHCS');
      await page.waitForTimeout(600);
      const suggestion = '[role="option"]:first-child, .suggestion:first-child, li:first-child';
      if (await page.isVisible(suggestion)) await page.click(suggestion);
    }

    // ZIP
    const zipField = 'input[placeholder*="ZIP"], input[placeholder*="zip"], input[name="zip"]';
    if (await page.isVisible(zipField) && zip) await page.fill(zipField, zip);

    // Provider name or specialty
    const searchField = 'input[placeholder*="provider"], input[placeholder*="doctor"], input[placeholder*="specialty"]';
    if (await page.isVisible(searchField) && (name || specialty)) {
      await page.fill(searchField, name || specialty);
    }

    await page.click('button[type="submit"], button:has-text("Search"), input[type="submit"]');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    return await page.$$eval(
      '.provider-card, .provider-result, [class*="provider-item"], tr[class*="result"]',
      rows => rows.slice(0, 25).map(el => ({
        name:      el.querySelector('.name, h3, td:first-child')?.textContent?.trim() || '',
        specialty: el.querySelector('.specialty, td:nth-child(2)')?.textContent?.trim() || '',
        address:   el.querySelector('.address, .location, td:nth-child(3)')?.textContent?.trim() || '',
        phone:     el.querySelector('.phone, [href^="tel:"]')?.textContent?.trim() || '',
        distance:  el.querySelector('.distance')?.textContent?.trim() || '',
        accepting: true,
        npi:       '',
        network:   'phcs',
        alsoInNetwork: [],
      })).filter(p => p.name)
    );

  } finally {
    await browser.close();
  }
};
