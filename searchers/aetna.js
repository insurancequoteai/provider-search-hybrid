// searchers/aetna.js
// Name search strategy:
//   1st request: full browser navigation → capture API URL template → page.evaluate(fetch())
//   Subsequent : reuse warm browser session → page.evaluate(fetch()) ≈ 3-5 s
// Specialty   : always fresh browser (navigates away from providerSearch page)

const https = require('https');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

// ── Module-level warm browser state ──────────────────────────────────────────
const _warm = {
  browser:      null,
  page:         null,
  zip:          null,
  urlTemplate:  null,   // full API URL captured from AngularJS request (inc. pipeName, lat/lon)
  initPromise:  null,   // dedup concurrent init calls
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const decodeHtml = s => (s || '')
  .replace(/&#38;/g, '&').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function parseAetnaBody(body) {
  try {
    const data = JSON.parse(body);
    const raw  = data?.providersResponse?.readProvidersResponse?.providerInfoResponses;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (list.length === 0) console.log('[Aetna] parseBody: empty list, prefix:', body.substring(0, 200));
    return list.map(p => {
      const info     = p.providerInformation || {};
      const locRaw   = p.providerLocations;
      const loc      = Array.isArray(locRaw) ? locRaw[0] : (locRaw || {});
      const addr     = loc.address   || {};
      const contacts = loc.contacts  || {};
      let specialtyDesc = '';
      const spec = p.providerSpecialties;
      if (Array.isArray(spec)) specialtyDesc = spec[0]?.specialty?.description || '';
      else if (spec?.specialty) specialtyDesc = spec.specialty.description || '';
      specialtyDesc = decodeHtml(specialtyDesc);
      const desigs = Array.isArray(p.providerDesignations) ? p.providerDesignations
        : p.providerDesignations ? [p.providerDesignations] : [];
      return {
        network: 'Aetna Open Choice PPO',
        name:    decodeHtml(info.providerDisplayName?.full || ''),
        npi:     info.primaryNPI?.nationalProviderId || '',
        providerType: info.type || '',
        specialty: specialtyDesc,
        address: {
          street:   decodeHtml(addr.streetLine1 || ''),
          building: decodeHtml(addr.buildingName || ''),
          city:     decodeHtml(addr.city || ''),
          county:   decodeHtml(addr.county || ''),
          state:    addr.state || '',
          zip:      addr.postalCode || '',
        },
        phone:              contacts.phonesVoice?.number || p.contacts?.primaryPhone?.number || '',
        distance:           parseFloat(addr.distance) || null,
        latitude:           parseFloat(addr.latitude)  || null,
        longitude:          parseFloat(addr.longitude) || null,
        acceptingNewPatients: loc.acceptsNewPatients === 'Y',
        virtualVisits:      desigs.some(d => d.code === 'TELEMED' || d.code === 'VIDCONF'),
        inNetwork:  true,
        providerId: info.providerID  || '',
        locationId: loc.locationID   || '',
      };
    });
  } catch (e) { console.log('[Aetna] parseBody error:', e.message); return []; }
}

function dedup(providers) {
  const seen = new Set();
  return providers.filter(p => {
    const k = p.locationId || `${p.npi}|${p.address.street}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

function browserArgs() {
  return [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', '--disable-gpu',
    '--no-first-run', '--no-zygote',
    '--disable-background-networking', '--disable-default-apps',
    '--disable-sync', '--disable-translate', '--mute-audio',
    '--disable-extensions', '--disable-component-update',
    '--safebrowsing-disable-auto-update',
  ];
}

// ── Warm browser: navigate to Aetna providerSearch, capture URL template ──────
async function initWarmPage(zip) {
  console.log(`[Aetna] Warming browser for ZIP ${zip}...`);
  const t0 = Date.now();

  // Close any old browser
  if (_warm.browser) {
    try { await _warm.browser.close(); } catch {}
    _warm.browser = null; _warm.page = null; _warm.urlTemplate = null;
  }

  const browser = await chromium.launch({ headless: true, args: browserArgs() });
  _warm.browser = browser;

  const page = await browser.newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  // Block images/fonts/analytics
  await page.route('**', route => {
    const type = route.request().resourceType();
    const url  = route.request().url();
    if (['image', 'media', 'font'].includes(type)) return route.abort();
    if (/google-analytics|googletagmanager|doubleclick|adobe|omniture|mbox/i.test(url))
      return route.abort();
    return route.continue();
  });

  // Capture the FULL API URL from AngularJS's own request (correct pipeName, lat/lon, etc.)
  page.on('request', req => {
    if (req.url().includes('publicdse_providersearch') && !_warm.urlTemplate) {
      _warm.urlTemplate = req.url();
      console.log('[Aetna] Captured URL template:', _warm.urlTemplate);
    }
  });

  // Step 1: landing → ZIP
  await page.goto(
    'https://www.aetna.com/dsepublic/#/contentPage?page=providerSearchLanding&site_id=dse&language=en',
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );
  await page.waitForSelector('#zip1', { timeout: 15000 });
  await page.click('#zip1', { clickCount: 3 });
  await page.type('#zip1', zip, { delay: 30 });
  await page.evaluate(() => {
    const el = document.querySelector('#zip1');
    el?.dispatchEvent(new Event('input',  { bubbles: true }));
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

  // Step 2: Select Open Choice PPO
  await page.waitForTimeout(300);
  const ppLabel = page.locator('label').filter({ hasText: 'Open Choice' }).first();
  if (await ppLabel.count() > 0) {
    await ppLabel.click();
  } else {
    await page.locator('input[type="radio"][value*="MPPO"]').first().click().catch(() => {});
  }
  await page.waitForTimeout(300);

  // Step 3: Continue
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

  // Wait for AngularJS to fire its initial API request (so we capture the URL template)
  await page.waitForTimeout(2000);

  _warm.page = page;
  _warm.zip  = zip;
  console.log(`[Aetna] Warm browser ready in ${Date.now() - t0}ms, template=${_warm.urlTemplate ? 'captured' : 'MISSING'}`);
  return page;
}

async function getWarmPage(zip) {
  // Reuse if valid and same ZIP
  if (_warm.page && _warm.zip === zip) {
    try {
      if (!_warm.page.isClosed()) {
        console.log('[Aetna] ♻️  Reusing warm browser session');
        return _warm.page;
      }
    } catch {}
  }

  // Dedup concurrent inits
  if (_warm.initPromise) {
    console.log('[Aetna] Waiting for concurrent browser init...');
    return _warm.initPromise;
  }

  _warm.initPromise = initWarmPage(zip).finally(() => { _warm.initPromise = null; });
  return _warm.initPromise;
}

// ── Fast name search via browser fetch (uses browser's session cookies) ───────
async function searchAetnaNameFast(name, zip, maxResults) {
  const page = await getWarmPage(zip);

  let apiUrl;
  if (_warm.urlTemplate) {
    // Slot in the new searchText and a fresh timestamp — everything else (pipeName, coords) stays
    apiUrl = _warm.urlTemplate
      .replace(/searchText=[^&]*/,  `searchText=${encodeURIComponent(name + ' (any location)')}`)
      .replace(/tmstmp\d+tmstmp/,   `tmstmp${Date.now()}tmstmp`);
    console.log('[Aetna] Fast fetch (template):', apiUrl.substring(0, 180));
  } else {
    throw new Error('No URL template captured yet — will fall back to typeahead');
  }

  // Call fetch() from inside the browser page → carries cookies automatically
  const text = await page.evaluate(async (url) => {
    try {
      const r = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' },
      });
      return r.text();
    } catch (e) {
      return JSON.stringify({ __fetchError: e.message });
    }
  }, apiUrl);

  if (!text || text.includes('__fetchError')) {
    throw new Error('Browser fetch failed: ' + (text || '').substring(0, 100));
  }

  const parsed = parseAetnaBody(text);
  if (parsed.length === 0) throw new Error('Fast fetch returned 0 providers');

  return dedup(parsed).slice(0, Math.min(maxResults, 8));
}

// ── Name search browser fallback (typeahead on warm page) ─────────────────────
async function searchAetnaNameTypeahead(name, zip, maxResults, page) {
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
    const byAttr = Array.from(document.querySelectorAll('a[ng-click*="clickViewMore"]'))
      .find(el => el.offsetParent !== null);
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
    const pattern = new RegExp(
      searchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(any location\\)', 'i'
    );
    const candidates = [
      ...document.querySelectorAll('li.typeahead_grouping, li[ng-repeat*="Filter"], .dropdown-menu li'),
    ];
    const el = candidates.find(el => el.offsetParent !== null && pattern.test(el.textContent || ''));
    if (el) { el.click(); return el.textContent?.trim(); }
    const anyEl = Array.from(document.querySelectorAll('li, a, span, div'))
      .find(el => el.offsetParent !== null && pattern.test(el.textContent || ''));
    if (anyEl) { anyEl.click(); return anyEl.textContent?.trim(); }
    return null;
  }, name);
  console.log(`[Aetna] Any-location option: ${anyLocationClicked}`);

  if (!anyLocationClicked) throw new Error('Could not click any-location option');

  const resp = await respPromise;
  if (!resp) throw new Error('No provider search API response captured');
  const body = await resp.text().catch(() => null);
  if (!body) throw new Error('Empty API response');
  const parsed = parseAetnaBody(body);
  console.log(`[Aetna] Typeahead → ${parsed.length} providers`);
  return dedup(parsed).slice(0, cap);
}

// ── Main export ───────────────────────────────────────────────────────────────
async function searchAetna({
  specialty = 'All Medical Specialists',
  name      = '',
  zip       = '77041',
  maxResults = 25,
} = {}) {
  const isNameSearch = !!name;

  // ── Name search: warm browser + fast fetch ────────────────────────────────
  if (isNameSearch) {
    // 1. Try the fast fetch path (page.evaluate with browser cookies)
    try {
      const results = await searchAetnaNameFast(name, zip, maxResults);
      console.log(`[Aetna] ⚡ Fast search success: ${results.length} providers`);
      return results;
    } catch (e) {
      console.log('[Aetna] Fast search failed:', e.message);
    }

    // 2. Fallback: typeahead on the warm page (avoids full re-navigation)
    if (_warm.page && _warm.zip === zip) {
      try {
        const results = await searchAetnaNameTypeahead(name, zip, maxResults, _warm.page);
        console.log(`[Aetna] Typeahead fallback success: ${results.length} providers`);
        return results;
      } catch (e) {
        console.log('[Aetna] Typeahead fallback failed:', e.message, '— full browser');
        // Invalidate the warm page so it re-inits next time
        _warm.page = null; _warm.zip = null;
      }
    }
  }

  // ── Full browser path (specialty search, or name search double-fallback) ──
  const browser = await chromium.launch({ headless: true, args: browserArgs() });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    await page.route('**', route => {
      const type = route.request().resourceType();
      const url  = route.request().url();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      if (/google-analytics|googletagmanager|doubleclick|adobe|omniture|mbox/i.test(url))
        return route.abort();
      return route.continue();
    });

    let providerApiBody = null;
    page.on('response', async res => {
      if (res.url().includes('publicdse_providersearch')) {
        try { providerApiBody = await res.text(); } catch {}
      }
    });
    page.on('request', req => {
      if (req.url().includes('publicdse_providersearch'))
        console.log('[Aetna] Browser API URL:', req.url());
    });

    // Step 1
    await page.goto(
      'https://www.aetna.com/dsepublic/#/contentPage?page=providerSearchLanding&site_id=dse&language=en',
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await page.waitForSelector('#zip1', { timeout: 15000 });
    await page.click('#zip1', { clickCount: 3 });
    await page.type('#zip1', zip, { delay: 30 });
    await page.evaluate(() => {
      const el = document.querySelector('#zip1');
      el?.dispatchEvent(new Event('input',  { bubbles: true }));
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

    // Step 2
    await page.waitForTimeout(300);
    const ppLabel = page.locator('label').filter({ hasText: 'Open Choice' }).first();
    if (await ppLabel.count() > 0) {
      await ppLabel.click();
    } else {
      await page.locator('input[type="radio"][value*="MPPO"]').first().click().catch(() => {});
    }
    await page.waitForTimeout(300);

    // Step 3
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
      return searchAetnaNameTypeahead(name, zip, maxResults, page);
    }

    // ── Specialty search ────────────────────────────────────────────────────
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
          .find(el => el.offsetParent !== null &&
            el.textContent?.includes('Medical Specialists') &&
            !el.textContent?.includes('All'))?.click();
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
      const exact   = all.find(el => el.offsetParent !== null &&
        el.textContent?.trim().toLowerCase() === targetSpecialty.toLowerCase());
      if (exact) { exact.click(); return; }
      const partial = all.find(el => el.offsetParent !== null &&
        el.textContent?.toLowerCase().includes(targetSpecialty.toLowerCase()));
      if (partial) { partial.click(); return; }
      const allSpec = all.find(el => el.offsetParent !== null &&
        el.textContent?.includes('All Medical Specialists'));
      if (allSpec) allSpec.click();
    }, specialty);

    await responsePromise;
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);

    if (!providerApiBody) throw new Error('Aetna: no provider search API response captured');

    const data      = JSON.parse(providerApiBody);
    const providers = data?.providersResponse?.readProvidersResponse?.providerInfoResponses || [];
    return providers.slice(0, maxResults).map(p => {
      const info  = p.providerInformation || {};
      const loc   = p.providerLocations   || {};
      const addr  = loc.address   || {};
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
        name:    info.providerDisplayName?.full || '',
        npi:     info.primaryNPI?.nationalProviderId || '',
        providerType: info.type || '',
        specialty: specialtyDesc,
        address: {
          street: addr.streetLine1 || '', building: addr.buildingName || '',
          city:   addr.city || '',       county:   addr.county || '',
          state:  addr.state || '',      zip:      addr.postalCode || '',
        },
        phone:    contacts.phonesVoice?.number || p.contacts?.primaryPhone?.number || '',
        distance: parseFloat(addr.distance) || null,
        latitude: parseFloat(addr.latitude)  || null,
        longitude: parseFloat(addr.longitude) || null,
        acceptingNewPatients: loc.acceptsNewPatients === 'Y',
        virtualVisits: designations.some(d => d.code === 'TELEMED' || d.code === 'VIDCONF'),
        inNetwork:  true,
        providerId: info.providerID  || '',
        locationId: loc.locationID   || '',
      };
    });

  } finally {
    await browser.close();
  }
}

module.exports = searchAetna;
