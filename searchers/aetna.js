// searchers/aetna.js
// Aetna Open Choice PPO provider search
// Name search: direct REST API call (no browser) ~5-10s
// Specialty search: Playwright browser automation

const https = require('https');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

// ── Shared helpers ────────────────────────────────────────────────────────────
const decodeHtml = s => (s || '').replace(/&#38;/g,'&').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');

function parseAetnaBody(body) {
  try {
    const data = JSON.parse(body);
    const raw = data?.providersResponse?.readProvidersResponse?.providerInfoResponses;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (list.length === 0) console.log('[Aetna] parseBody: empty list, prefix:', body.substring(0, 200));
    return list.map(p => {
      const info   = p.providerInformation || {};
      const locRaw = p.providerLocations;
      const loc    = Array.isArray(locRaw) ? locRaw[0] : (locRaw || {});
      const addr   = loc.address   || {};
      const contacts = loc.contacts || {};
      let specialtyDesc = '';
      const spec = p.providerSpecialties;
      if (Array.isArray(spec)) specialtyDesc = spec[0]?.specialty?.description || '';
      else if (spec?.specialty) specialtyDesc = spec.specialty.description || '';
      specialtyDesc = decodeHtml(specialtyDesc);
      const desigs = Array.isArray(p.providerDesignations) ? p.providerDesignations
        : p.providerDesignations ? [p.providerDesignations] : [];
      return {
        network: 'Aetna Open Choice PPO',
        name: decodeHtml(info.providerDisplayName?.full || ''),
        npi:  info.primaryNPI?.nationalProviderId || '',
        providerType: info.type || '',
        specialty: specialtyDesc,
        address: {
          street: decodeHtml(addr.streetLine1 || ''), building: decodeHtml(addr.buildingName || ''),
          city: decodeHtml(addr.city || ''), county: decodeHtml(addr.county || ''),
          state: addr.state || '', zip: addr.postalCode || '',
        },
        phone: contacts.phonesVoice?.number || p.contacts?.primaryPhone?.number || '',
        distance: parseFloat(addr.distance) || null,
        latitude:  parseFloat(addr.latitude)  || null,
        longitude: parseFloat(addr.longitude) || null,
        acceptingNewPatients: loc.acceptsNewPatients === 'Y',
        virtualVisits: desigs.some(d => d.code === 'TELEMED' || d.code === 'VIDCONF'),
        inNetwork: true,
        providerId: info.providerID || '',
        locationId: loc.locationID  || '',
      };
    });
  } catch(e) { console.log('[Aetna] parseBody error:', e.message); return []; }
}

function dedup(providers) {
  const seen = new Set();
  return providers.filter(p => {
    const k = p.locationId || `${p.npi}|${p.address.street}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

// ── Direct API name search (no browser) ──────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function geocodeZip(zip) {
  const { body } = await httpsGet(
    `https://api.zippopotam.us/us/${zip}`,
    { 'User-Agent': 'InsuranceQuoteAI/1.0' }
  );
  const data = JSON.parse(body);
  const place = data.places?.[0];
  if (!place) throw new Error(`geocode failed for ${zip}`);
  return {
    lat: parseFloat(place.latitude),
    lon: parseFloat(place.longitude),
    state: place['state abbreviation'],
  };
}

async function searchAetnaNameDirect(name, zip, maxResults) {
  const geo = await geocodeZip(zip);
  const ts  = Date.now();
  const qs  = [
    `searchText=${encodeURIComponent(name + ' (any location)')}`,
    `productIdentifier=~MPPO`,
    `listFieldSelections=acceptedVersion_jgegs,tmstmp${ts}tmstmp,affiliations,VisitType_NoPreference`,
    `isGuidedSearch=false`,
    `state=${geo.state}`,
    `distance=25`,
    `latitude=${geo.lat}`,
    `longitude=${geo.lon}`,
    `postalCode=${zip}`,
    `firstRecordOnPage=1`,
    `lastRecordOnPage=0`,
    `pipeName=OpenChoicePPO`,
  ].join('&');
  const url = `https://api01.aetna.com/healthcore/prod/v3/publicdse_providersearch?${qs}`;
  console.log('[Aetna] Direct API →', url.substring(0, 250));
  const { status, body } = await httpsGet(url, {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.aetna.com/',
    'Origin': 'https://www.aetna.com',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  console.log('[Aetna] Direct API status:', status, 'body length:', body.length);
  if (status !== 200) throw new Error(`API status ${status}`);
  const parsed = parseAetnaBody(body);
  if (parsed.length === 0) throw new Error('Direct API returned 0 providers');
  return dedup(parsed).slice(0, Math.min(maxResults, 8));
}

/**
 * @param {object} opts
 * @param {string} [opts.specialty]
 * @param {string} [opts.name]
 * @param {string} opts.zip
 * @param {number} [opts.maxResults=25]
 */
async function searchAetna({ specialty = 'All Medical Specialists', name = '', zip = '77041', maxResults = 25 } = {}) {
  const isNameSearch = !!name;

  // ── Name search: try direct API first (no browser, ~5-10s) ──────────────────
  if (isNameSearch) {
    try {
      const results = await searchAetnaNameDirect(name, zip, maxResults);
      console.log(`[Aetna] Direct API success: ${results.length} providers`);
      return results;
    } catch(e) {
      console.log('[Aetna] Direct API failed:', e.message, '— falling back to browser');
    }
  }

  // ── Browser path (specialty search, or name search fallback) ─────────────────
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--no-first-run', '--no-zygote',
      '--disable-background-networking',
      '--disable-default-apps', '--disable-sync',
      '--disable-translate', '--mute-audio',
      '--disable-extensions', '--disable-component-update',
      '--safebrowsing-disable-auto-update',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    // Block images, fonts, analytics
    await page.route('**', route => {
      const type = route.request().resourceType();
      const url  = route.request().url();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      if (/google-analytics|googletagmanager|doubleclick|adobe|omniture|mbox/i.test(url)) return route.abort();
      return route.continue();
    });

    let providerApiBody = null;
    page.on('response', async res => {
      if (res.url().includes('publicdse_providersearch')) {
        try { providerApiBody = await res.text(); } catch {}
      }
    });
    // Log full API URL for debugging (capture pipeName etc.)
    page.on('request', req => {
      if (req.url().includes('publicdse_providersearch')) {
        console.log('[Aetna] Browser API URL:', req.url());
      }
    });

    // ── Step 1: Landing page → enter ZIP ──────────────────────────────────────
    await page.goto(
      'https://www.aetna.com/dsepublic/#/contentPage?page=providerSearchLanding&site_id=dse&language=en',
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await page.waitForSelector('#zip1', { timeout: 15000 });
    await page.click('#zip1', { clickCount: 3 });
    await page.type('#zip1', zip, { delay: 30 });
    await page.evaluate(() => {
      const el = document.querySelector('#zip1');
      el?.dispatchEvent(new Event('input', { bubbles: true }));
      el?.dispatchEvent(new Event('change', { bubbles: true }));
      el?.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    });
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await page.waitForURL('**/providerSearchPlanList**', { timeout: 20000 }).catch(() => {});
    if (!page.url().includes('providerSearchPlanList')) {
      await page.locator('button:has-text("Search")').first().click().catch(() => {});
      await page.waitForURL('**/providerSearchPlanList**', { timeout: 15000 }).catch(() => {});
    }
    await page.waitForSelector('label, input[type="radio"]', { timeout: 8000 }).catch(() => {});

    // ── Step 2: Select Open Choice PPO ────────────────────────────────────────
    await page.waitForTimeout(300);
    const ppLabel = page.locator('label').filter({ hasText: 'Open Choice' }).first();
    if (await ppLabel.count() > 0) {
      await ppLabel.click();
    } else {
      await page.locator('input[type="radio"][value*="MPPO"]').first().click().catch(() => {});
    }
    await page.waitForTimeout(300);

    // ── Step 3: Click Continue ────────────────────────────────────────────────
    const contBtn = page.locator('button:not(.ng-hide):has-text("Continue")').first();
    if (await contBtn.count() > 0) {
      await contBtn.click();
    } else {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          b.textContent?.includes('Continue') && !b.classList.contains('ng-hide') && b.offsetParent !== null
        );
        if (btn) btn.click();
      });
    }
    await page.waitForURL('**/providerSearch**', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('#Doctors, input[ng-model="criteria.typeAheadSearch"]', { timeout: 10000 }).catch(() => {});

    if (isNameSearch) {
      // ── Name search browser fallback ─────────────────────────────────────────
      await page.waitForTimeout(400);
      const cap = Math.min(maxResults, 8);

      const typeAndGetSuggestions = async () => {
        const inp = page.locator('#Doctors, input[ng-model="criteria.typeAheadSearch"]').first();
        await inp.waitFor({ timeout: 8000 }).catch(() => {});
        await inp.click();
        await page.waitForTimeout(100);
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Delete');
        await page.keyboard.type(name, { delay: 20 });
        await page.waitForSelector('li.typeahead_grouping, .viewMore a', { timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(300);
      };

      await typeAndGetSuggestions();

      const moreClicked = await page.evaluate(() => {
        const byClass = document.querySelector('.viewMore a');
        if (byClass && byClass.offsetParent !== null) { byClass.click(); return byClass.textContent?.trim(); }
        const byAttr = Array.from(document.querySelectorAll('a[ng-click*="clickViewMore"]')).find(el => el.offsetParent !== null);
        if (byAttr) { byAttr.click(); return byAttr.textContent?.trim(); }
        return null;
      });
      console.log(`[Aetna] "More providers" link: ${moreClicked}`);
      if (moreClicked) {
        await page.waitForSelector('li.typeahead_grouping', { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);
      }

      const respPromise = page.waitForResponse(
        res => res.url().includes('publicdse_providersearch'), { timeout: 35000 }
      ).catch(() => null);

      const anyLocationClicked = await page.evaluate((searchName) => {
        const pattern = new RegExp(searchName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\s*\\(any location\\)', 'i');
        const candidates = [...document.querySelectorAll('li.typeahead_grouping, li[ng-repeat*="Filter"], .dropdown-menu li')];
        const el = candidates.find(el => el.offsetParent !== null && pattern.test(el.textContent || ''));
        if (el) { el.click(); return el.textContent?.trim(); }
        const anyEl = Array.from(document.querySelectorAll('li, a, span, div')).find(el => el.offsetParent !== null && pattern.test(el.textContent || ''));
        if (anyEl) { anyEl.click(); return anyEl.textContent?.trim(); }
        return null;
      }, name);
      console.log(`[Aetna] Any-location option: ${anyLocationClicked}`);

      if (anyLocationClicked) {
        const resp = await respPromise;
        if (!resp) throw new Error('Aetna: no provider search API response captured');
        const body = await resp.text().catch(() => null);
        if (!body) throw new Error('Aetna: empty API response');
        const parsed = parseAetnaBody(body);
        console.log(`[Aetna] Browser fallback any-location → ${parsed.length} providers`);
        return dedup(parsed).slice(0, cap);
      } else {
        throw new Error('Aetna: could not click any-location option');
      }

    } else {
      // ── Specialty search ──────────────────────────────────────────────────────
      const medLink = page.locator('a, button, li').filter({ hasText: 'Medical Doctors' }).first();
      if (await medLink.count() > 0) {
        await medLink.click();
      } else {
        await page.evaluate(() => {
          Array.from(document.querySelectorAll('a, button, li, span'))
            .find(el => el.offsetParent !== null && el.textContent?.includes('Medical Doctors'))?.click();
        });
      }
      await page.waitForURL('**/providerMedical**', { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      const specLink = page.locator('a, button, li').filter({ hasText: 'Medical Specialists' }).first();
      if (await specLink.count() > 0) {
        await specLink.click();
      } else {
        await page.evaluate(() => {
          Array.from(document.querySelectorAll('a, button, li, span'))
            .find(el => el.offsetParent !== null && el.textContent?.includes('Medical Specialists') && !el.textContent?.includes('All'))?.click();
        });
      }
      await page.waitForURL('**/providerSearchSpecialists**', { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(800);

      const responsePromise = page.waitForResponse(
        res => res.url().includes('publicdse_providersearch'), { timeout: 25000 }
      ).catch(() => null);

      await page.evaluate((targetSpecialty) => {
        const all = Array.from(document.querySelectorAll('a, button, li, span, div[role="button"]'));
        const exact = all.find(el => el.offsetParent !== null && el.textContent?.trim().toLowerCase() === targetSpecialty.toLowerCase());
        if (exact) { exact.click(); return; }
        const partial = all.find(el => el.offsetParent !== null && el.textContent?.toLowerCase().includes(targetSpecialty.toLowerCase()));
        if (partial) { partial.click(); return; }
        const allSpec = all.find(el => el.offsetParent !== null && el.textContent?.includes('All Medical Specialists'));
        if (allSpec) allSpec.click();
      }, specialty);

      await responsePromise;
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }

    if (!providerApiBody) throw new Error('Aetna: no provider search API response captured');

    const data = JSON.parse(providerApiBody);
    const providers = data?.providersResponse?.readProvidersResponse?.providerInfoResponses || [];

    return providers.slice(0, maxResults).map(p => {
      const info = p.providerInformation || {};
      const loc  = p.providerLocations || {};
      const addr = loc.address || {};
      const contacts = loc.contacts || {};
      let specialtyDesc = '';
      const spec = p.providerSpecialties;
      if (Array.isArray(spec)) specialtyDesc = spec[0]?.specialty?.description || '';
      else if (spec?.specialty) specialtyDesc = spec.specialty.description || '';
      specialtyDesc = specialtyDesc.replace(/&#38;/g, '&').replace(/&amp;/g, '&');
      const designations = Array.isArray(p.providerDesignations) ? p.providerDesignations
        : p.providerDesignations ? [p.providerDesignations] : [];
      return {
        network: 'Aetna Open Choice PPO',
        name: info.providerDisplayName?.full || '',
        npi: info.primaryNPI?.nationalProviderId || '',
        providerType: info.type || '',
        specialty: specialtyDesc,
        address: {
          street: addr.streetLine1 || '', building: addr.buildingName || '',
          city: addr.city || '', county: addr.county || '',
          state: addr.state || '', zip: addr.postalCode || '',
        },
        phone: contacts.phonesVoice?.number || p.contacts?.primaryPhone?.number || '',
        distance: parseFloat(addr.distance) || null,
        latitude: parseFloat(addr.latitude) || null,
        longitude: parseFloat(addr.longitude) || null,
        acceptingNewPatients: loc.acceptsNewPatients === 'Y',
        virtualVisits: designations.some(d => d.code === 'TELEMED' || d.code === 'VIDCONF'),
        inNetwork: true,
        providerId: info.providerID || '',
        locationId: loc.locationID || '',
      };
    });
  } finally {
    await browser.close();
  }
}

module.exports = searchAetna;
