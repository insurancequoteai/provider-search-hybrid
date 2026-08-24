// searchers/phcs.js
// PHCS / MultiPlan network provider search
// Intercepts the internal API call so we get clean JSON instead of scraping.
// When/if the API URL is captured and stable, replace browser path with a
// direct fetch (same pattern as aetna.js name search).

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePhcsApiBody(raw) {
  try {
    const data = JSON.parse(raw);
    // MultiPlan API wraps results in various shapes — try the common ones
    const list =
      data?.providers ||
      data?.searchResults?.providers ||
      data?.data?.providers ||
      data?.result?.providers ||
      data?.results ||
      [];
    if (!Array.isArray(list)) return [];
    return list.map(p => {
      const addr = p.address || p.location || p.practiceLocation || {};
      return {
        network: 'PHCS',
        name: p.providerName || p.name || p.displayName || '',
        npi: p.npi || p.nationalProviderId || '',
        providerType: p.providerType || p.type || '',
        specialty: p.specialty || p.specialtyDescription || p.primarySpecialty || '',
        address: {
          street: addr.address1 || addr.street || addr.streetLine1 || '',
          city: addr.city || '',
          state: addr.state || addr.stateCode || '',
          zip: addr.postalCode || addr.zip || '',
        },
        phone: p.phone || p.phoneNumber || addr.phone || '',
        distance: parseFloat(p.distance || p.distanceMiles) || null,
        acceptingNewPatients: p.acceptingNewPatients ?? p.acceptingPatients ?? true,
        inNetwork: true,
      };
    }).filter(p => p.name);
  } catch (e) {
    console.log('[PHCS] parseApiBody error:', e.message);
    return [];
  }
}

function parseDom(rows) {
  // Fallback: parse whatever DOM rows we scraped
  return rows.filter(r => r.name).map(r => ({
    network: 'PHCS',
    name: r.name,
    specialty: r.specialty || '',
    address: { street: r.address || '', city: '', state: '', zip: '' },
    phone: r.phone || '',
    distance: null,
    acceptingNewPatients: true,
    inNetwork: true,
    npi: '',
    providerType: '',
  }));
}

// ── Main search ───────────────────────────────────────────────────────────────

module.exports = async function phcsSearch({ zip = '77041', name = '', specialty = '' } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--no-first-run', '--no-zygote',
      '--disable-background-networking',
      '--disable-default-apps', '--disable-sync',
      '--disable-translate', '--mute-audio',
      '--disable-extensions',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    // Block images/fonts/analytics
    await page.route('**', route => {
      const type = route.request().resourceType();
      const url  = route.request().url();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      if (/google-analytics|googletagmanager|doubleclick|adobe|omniture|analytics/i.test(url)) return route.abort();
      return route.continue();
    });

    // Capture any API response that looks like provider search results
    let apiBody = null;
    const searchUrls = [];

    page.on('request', req => {
      const url = req.url();
      // Log non-static requests for debugging
      if (!/\.(js|css|png|svg|ico|woff|ttf)/.test(url)) {
        console.log('[PHCS] →', req.method(), url.substring(0, 200));
      }
    });

    page.on('response', async res => {
      const url = res.url();
      const ct  = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json')) return;
      // Look for any URL path that resembles a provider/search endpoint
      if (/search|provider|network/i.test(url) && !apiBody) {
        try {
          const text = await res.text();
          if (text.length > 100 && /provider|name|specialty|address/i.test(text)) {
            searchUrls.push(url);
            console.log('[PHCS] ★ Captured API response:', url.substring(0, 250));
            apiBody = text;
          }
        } catch {}
      }
    });

    // ── Step 1: Load the site ─────────────────────────────────────────────────
    console.log('[PHCS] Loading providersearch.multiplan.com...');
    await page.goto('https://providersearch.multiplan.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(2500);
    console.log('[PHCS] Page title:', await page.title());

    // ── Step 2: Network selection — type "PHCS" ───────────────────────────────
    // Try various selectors for the network input field
    const networkInputSelectors = [
      'input[placeholder*="network" i]',
      'input[placeholder*="plan" i]',
      'input[aria-label*="network" i]',
      'input[data-testid*="network" i]',
      '#network-search',
      '#networkSearch',
      'input[name*="network" i]',
    ];

    let networkFound = false;
    for (const sel of networkInputSelectors) {
      if (await page.locator(sel).count() > 0) {
        console.log('[PHCS] Found network input:', sel);
        await page.locator(sel).first().click();
        await page.waitForTimeout(200);
        await page.keyboard.type('PHCS', { delay: 40 });
        await page.waitForTimeout(800);
        networkFound = true;

        // Select first suggestion
        const suggestionSel = '[role="option"]:first-child, .suggestion:first-child, li[data-testid*="option"]:first-child, .dropdown-item:first-child';
        if (await page.locator(suggestionSel).count() > 0) {
          await page.locator(suggestionSel).first().click();
          console.log('[PHCS] Selected PHCS from dropdown');
        } else {
          // Try pressing Enter or clicking the first li
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(200);
          await page.keyboard.press('Enter');
        }
        break;
      }
    }

    if (!networkFound) {
      // Maybe the network is already selected or displayed as buttons/cards
      const phcsBtn = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, a, li, [role="button"], label'));
        const el = all.find(e => e.offsetParent !== null && /\bPHCS\b/.test(e.textContent));
        if (el) { el.click(); return el.textContent?.trim(); }
        return null;
      });
      console.log('[PHCS] PHCS button/card click:', phcsBtn);
    }

    await page.waitForTimeout(1000);

    // ── Step 3: Enter ZIP ─────────────────────────────────────────────────────
    const zipSelectors = [
      'input[placeholder*="ZIP" i]',
      'input[placeholder*="zip" i]',
      'input[placeholder*="postal" i]',
      'input[name*="zip" i]',
      'input[name*="postal" i]',
      'input[aria-label*="zip" i]',
      '#zipCode',
      '#zip',
      '#postalCode',
    ];

    for (const sel of zipSelectors) {
      if (await page.locator(sel).count() > 0) {
        console.log('[PHCS] Found ZIP input:', sel);
        await page.locator(sel).first().click({ clickCount: 3 });
        await page.keyboard.type(zip, { delay: 40 });
        break;
      }
    }
    await page.waitForTimeout(400);

    // ── Step 4: Provider name (for name search) ───────────────────────────────
    if (name && name.trim()) {
      // Convert "First Last" → "Last, First" for better results
      let nameQuery = name.trim();
      if (!nameQuery.includes(',')) {
        const parts = nameQuery.split(/\s+/);
        if (parts.length >= 2) {
          nameQuery = `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`;
        }
      }
      console.log('[PHCS] Searching for name:', nameQuery);

      const nameSelectors = [
        'input[placeholder*="provider name" i]',
        'input[placeholder*="doctor" i]',
        'input[placeholder*="physician" i]',
        'input[placeholder*="name" i]',
        'input[aria-label*="provider" i]',
        'input[name*="providerName" i]',
        'input[name*="provider_name" i]',
        '#providerName',
        '#provider-name',
      ];

      for (const sel of nameSelectors) {
        if (await page.locator(sel).count() > 0) {
          console.log('[PHCS] Found name input:', sel);
          await page.locator(sel).first().click({ clickCount: 3 });
          await page.keyboard.type(nameQuery, { delay: 40 });
          break;
        }
      }
    }

    // ── Step 5: Specialty (for specialty search) ──────────────────────────────
    if (specialty && specialty.trim() && !name) {
      console.log('[PHCS] Searching for specialty:', specialty);
      const specSelectors = [
        'input[placeholder*="specialty" i]',
        'select[name*="specialty" i]',
        '#specialty',
        '#specialtyId',
      ];
      for (const sel of specSelectors) {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          const tag = await el.evaluate(e => e.tagName.toLowerCase());
          if (tag === 'select') {
            await el.selectOption({ label: specialty });
          } else {
            await el.click();
            await page.keyboard.type(specialty, { delay: 40 });
            await page.waitForTimeout(600);
            // Pick first suggestion
            const suggestion = '[role="option"]:first-child, li:first-child';
            if (await page.locator(suggestion).count() > 0) {
              await page.locator(suggestion).first().click();
            }
          }
          break;
        }
      }
    }

    await page.waitForTimeout(400);

    // ── Step 6: Click Search ──────────────────────────────────────────────────
    const apiRespPromise = page.waitForResponse(
      res => {
        const url = res.url();
        return /search|provider/i.test(url) && !url.endsWith('.js') && !url.endsWith('.css');
      },
      { timeout: 25000 }
    ).catch(() => null);

    const searchClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
        .find(b => b.offsetParent !== null && /search|find|submit/i.test(b.textContent || b.value));
      if (btn) { btn.click(); return btn.textContent?.trim() || 'clicked'; }
      return null;
    });
    console.log('[PHCS] Search button clicked:', searchClicked);

    await page.waitForTimeout(500);
    const resp = await apiRespPromise;
    if (resp && !apiBody) {
      try {
        apiBody = await resp.text();
        console.log('[PHCS] Got API response from search click, url:', resp.url().substring(0, 200));
      } catch {}
    }

    // Wait for results to render
    await page.waitForTimeout(3000);

    // ── Step 7: Parse results ─────────────────────────────────────────────────
    if (apiBody) {
      const parsed = parsePhcsApiBody(apiBody);
      if (parsed.length > 0) {
        console.log(`[PHCS] API parse: ${parsed.length} providers`);
        return parsed.slice(0, 25);
      }
    }

    // DOM fallback
    const domResults = await page.evaluate(() => {
      // Try common result card patterns
      const selectors = [
        '.provider-card',
        '.provider-result',
        '[class*="provider-item"]',
        '[class*="ProviderCard"]',
        '[class*="result-card"]',
        '[data-testid*="provider"]',
        'tr[class*="result"]',
      ];
      for (const sel of selectors) {
        const rows = Array.from(document.querySelectorAll(sel));
        if (rows.length > 0) {
          return rows.slice(0, 25).map(el => ({
            name:      (el.querySelector('.name, h2, h3, [class*="name" i]')?.textContent || '').trim(),
            specialty: (el.querySelector('.specialty, [class*="specialty" i]')?.textContent || '').trim(),
            address:   (el.querySelector('.address, [class*="address" i], [class*="location" i]')?.textContent || '').trim(),
            phone:     (el.querySelector('.phone, [href^="tel:"], [class*="phone" i]')?.textContent || '').trim(),
          }));
        }
      }
      // Last resort: look for any structured text
      return [];
    });

    if (domResults.length > 0) {
      console.log(`[PHCS] DOM parse: ${domResults.length} providers`);
      return parseDom(domResults);
    }

    // Log page state for debugging
    const url = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    console.log('[PHCS] Final URL:', url);
    console.log('[PHCS] Body preview:', bodyText);
    console.log('[PHCS] No results found — check logs above for API URLs to implement direct call');

    return [];

  } finally {
    await browser.close();
  }
};
