// searchers/aetna.js
//
// Strategy:
//   1st name search : warm browser on providerSearch → typeahead → intercept headers → return results  (~55 s)
//   2nd+ name search: direct https.get() using cached URL template + auth headers                      (3-5 s)
//   Token expired   : clear cache → re-warm → fresh typeahead → re-capture headers
//   Specialty search: always fresh browser
//
const https = require('https');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

// ── Module-level auth/URL cache ───────────────────────────────────────────────
const _h = {                // "hot" cache
  urlTemplate : null,       // Full API URL from first real browser request
  reqHeaders  : null,       // ALL headers (incl. Authorization) from that request
  browser     : null,
  page        : null,
  zip         : null,
  initPromise : null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const decodeHtml = s => (s || '')
  .replace(/&#38;/g, '&').replace(/&amp;/g, '&')
  .replace(/&lt;/g,  '<').replace(/&gt;/g,  '>');

function parseAetnaBody(body) {
  try {
    const data = JSON.parse(body);
    const raw  = data?.providersResponse?.readProvidersResponse?.providerInfoResponses;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (!list.length) console.log('[Aetna] parseBody: empty, prefix:', body.slice(0, 200));
    return list.map(p => {
      const info     = p.providerInformation || {};
      const locRaw   = p.providerLocations;
      const loc      = Array.isArray(locRaw) ? locRaw[0] : (locRaw || {});
      const addr     = loc.address   || {};
      const contacts = loc.contacts  || {};
      let spec = '';
      const sp = p.providerSpecialties;
      if (Array.isArray(sp)) spec = sp[0]?.specialty?.description || '';
      else if (sp?.specialty) spec = sp.specialty.description || '';
      spec = decodeHtml(spec);
      const desigs = Array.isArray(p.providerDesignations) ? p.providerDesignations
        : p.providerDesignations ? [p.providerDesignations] : [];
      return {
        network: 'Aetna Open Choice PPO',
        name:    decodeHtml(info.providerDisplayName?.full || ''),
        npi:     info.primaryNPI?.nationalProviderId || '',
        providerType: info.type || '',
        specialty: spec,
        address: {
          street: decodeHtml(addr.streetLine1 || ''), building: decodeHtml(addr.buildingName || ''),
          city:   decodeHtml(addr.city || ''),        county:   decodeHtml(addr.county || ''),
          state:  addr.state || '',                   zip:      addr.postalCode || '',
        },
        phone:    contacts.phonesVoice?.number || p.contacts?.primaryPhone?.number || '',
        distance: parseFloat(addr.distance)  || null,
        latitude: parseFloat(addr.latitude)  || null,
        longitude:parseFloat(addr.longitude) || null,
        acceptingNewPatients: loc.acceptsNewPatients === 'Y',
        virtualVisits: desigs.some(d => ['TELEMED','VIDCONF'].includes(d.code)),
        inNetwork: true,
        providerId: info.providerID || '',
        locationId: loc.locationID  || '',
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

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const BROWSER_ARGS = [
  '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu',
  '--no-first-run','--no-zygote','--disable-background-networking',
  '--disable-default-apps','--disable-sync','--disable-translate','--mute-audio',
  '--disable-extensions','--disable-component-update','--safebrowsing-disable-auto-update',
];

// ── Direct https call using cached auth headers (~3-5 s) ──────────────────────
async function searchFastHttps(name, zip, maxResults) {
  if (!_h.urlTemplate || !_h.reqHeaders) throw new Error('No cached headers yet');

  // Swap searchText + timestamp; preserve all other params (pipeName, lat/lon, etc.)
  const apiUrl = _h.urlTemplate
    .replace(/searchText=[^&]*/,  `searchText=${encodeURIComponent(name + ' (any location)')}`)
    .replace(/tmstmp\d+tmstmp/,   `tmstmp${Date.now()}tmstmp`);

  console.log('[Aetna] ⚡ Fast https:', apiUrl.substring(0, 180));

  const { status, body } = await httpsGet(apiUrl, _h.reqHeaders);
  console.log('[Aetna] Fast https status:', status, 'body length:', body.length);

  if (status === 401 || status === 403) {
    // Auth token expired — clear cache so next call re-warms
    console.log('[Aetna] Auth expired — clearing cache, will re-warm');
    _h.urlTemplate = null; _h.reqHeaders = null;
    _h.page = null; _h.zip = null;
    throw new Error(`Auth expired (${status})`);
  }
  if (status !== 200) throw new Error(`API status ${status}`);

  const parsed = parseAetnaBody(body);
  if (!parsed.length) throw new Error('Fast https returned 0 providers');
  return dedup(parsed).slice(0, Math.min(maxResults, 8));
}

// ── Warm browser: navigate to providerSearch and wait ────────────────────────
async function initWarmPage(zip) {
  console.log(`[Aetna] Warming browser for ZIP ${zip}...`);
  const t0 = Date.now();

  // Safely close previous browser
  const old = _h.browser;
  _h.browser = null; _h.page = null;
  if (old) { try { await old.close(); } catch {} }

  const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
  _h.browser = browser;
  browser.on('disconnected', () => {
    if (_h.browser === browser) { _h.browser = null; _h.page = null; _h.zip = null; }
  });

  const page = await browser.newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  await page.route('**', route => {
    const type = route.request().resourceType();
    const url  = route.request().url();
    if (['image','media','font'].includes(type)) return route.abort();
    if (/google-analytics|googletagmanager|doubleclick|adobe|omniture|mbox/i.test(url)) return route.abort();
    return route.continue();
  });

  // THIS IS THE KEY: capture URL + auth headers from the first real API call
  page.on('request', req => {
    if (req.url().includes('publicdse_providersearch') && !_h.urlTemplate) {
      _h.urlTemplate = req.url();
      _h.reqHeaders  = req.headers();
      console.log('[Aetna] ✓ Captured URL template + auth headers');
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

  // Step 2: Open Choice PPO
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

  _h.page = page;
  _h.zip  = zip;
  console.log(`[Aetna] Warm browser ready in ${Date.now() - t0}ms`);
  return page;
}

async function getWarmPage(zip) {
  if (_h.page && _h.zip === zip) {
    try { if (!_h.page.isClosed()) { console.log('[Aetna] ♻️  Reusing warm page'); return _h.page; } }
    catch {}
  }
  if (_h.initPromise) { console.log('[Aetna] Waiting for browser init...'); return _h.initPromise; }
  _h.initPromise = initWarmPage(zip).finally(() => { _h.initPromise = null; });
  return _h.initPromise;
}

// ── Typeahead on warm page (captures headers as a side-effect) ────────────────
async function searchNameTypeahead(name, zip, maxResults, page) {
  const cap = Math.min(maxResults, 8);

  const inp = page.locator('#Doctors, input[ng-model="criteria.typeAheadSearch"]').first();
  await inp.waitFor({ timeout: 8000 });
  await inp.click();
  await page.waitForTimeout(100);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(name, { delay: 20 });
  await page.waitForSelector('li.typeahead_grouping, .viewMore a', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);

  // Click "More providers" if visible
  const moreClicked = await page.evaluate(() => {
    const a = document.querySelector('.viewMore a') ||
      Array.from(document.querySelectorAll('a[ng-click*="clickViewMore"]')).find(e => e.offsetParent);
    if (a && a.offsetParent) { a.click(); return a.textContent?.trim(); }
    return null;
  });
  if (moreClicked) {
    console.log('[Aetna] "More providers":', moreClicked);
    await page.waitForSelector('li.typeahead_grouping', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  const respPromise = page.waitForResponse(
    res => res.url().includes('publicdse_providersearch'), { timeout: 35000 }
  ).catch(() => null);

  const clicked = await page.evaluate(n => {
    const pat = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(any location\\)', 'i');
    const all = [...document.querySelectorAll(
      'li.typeahead_grouping, li[ng-repeat*="Filter"], .dropdown-menu li, li, a, span, div'
    )];
    const el = all.find(e => e.offsetParent !== null && pat.test(e.textContent || ''));
    if (el) { el.click(); return el.textContent?.trim(); }
    return null;
  }, name);
  console.log('[Aetna] Any-location click:', clicked);
  if (!clicked) throw new Error('Could not click any-location option');

  const resp = await respPromise;
  if (!resp) throw new Error('No API response captured');
  const body = await resp.text().catch(() => { throw new Error('Empty API response'); });
  const parsed = parseAetnaBody(body);
  console.log(`[Aetna] Typeahead → ${parsed.length} providers`);
  return dedup(parsed).slice(0, cap);
}

// ── Main export ───────────────────────────────────────────────────────────────
async function searchAetna({
  specialty  = 'All Medical Specialists',
  name       = '',
  zip        = '77041',
  maxResults = 25,
} = {}) {
  const isNameSearch = !!name;

  // ── Name search ─────────────────────────────────────────────────────────────
  if (isNameSearch) {

    // 1. Fast path: direct https with cached auth headers (~3-5 s)
    if (_h.urlTemplate && _h.reqHeaders) {
      try {
        const results = await searchFastHttps(name, zip, maxResults);
        console.log(`[Aetna] ⚡ Fast success: ${results.length} providers`);
        return results;
      } catch (e) {
        console.log('[Aetna] Fast failed:', e.message, '— falling back to warm typeahead');
      }
    }

    // 2. Typeahead on warm page (first search, or after cache cleared)
    let warmPage;
    try {
      warmPage = await getWarmPage(zip);
    } catch (e) {
      console.log('[Aetna] Warm page init failed:', e.message, '— fresh browser');
      warmPage = null;
    }

    if (warmPage) {
      try {
        const results = await searchNameTypeahead(name, zip, maxResults, warmPage);
        console.log(`[Aetna] Warm typeahead success: ${results.length} providers`);
        return results;
      } catch (e) {
        console.log('[Aetna] Warm typeahead failed:', e.message, '— invalidating warm page');
        _h.page = null; _h.zip = null;
        // fall through to fresh browser
      }
    }
  }

  // ── Fresh browser (specialty, or name double-fallback) ────────────────────
  const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    await page.route('**', route => {
      const t = route.request().resourceType(), u = route.request().url();
      if (['image','media','font'].includes(t)) return route.abort();
      if (/google-analytics|googletagmanager|doubleclick|adobe|omniture|mbox/i.test(u)) return route.abort();
      return route.continue();
    });
    let capturedBody = null;
    page.on('response', async res => {
      if (res.url().includes('publicdse_providersearch'))
        try { capturedBody = await res.text(); } catch {}
    });
    // Capture headers from fresh browser too (refreshes the cache)
    page.on('request', req => {
      if (req.url().includes('publicdse_providersearch')) {
        _h.urlTemplate = req.url();
        _h.reqHeaders  = req.headers();
        console.log('[Aetna] ✓ Refreshed URL template + auth headers (fresh browser)');
      }
    });

    // Navigate
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
    await page.waitForTimeout(300);
    const ppLabel = page.locator('label').filter({ hasText: 'Open Choice' }).first();
    if (await ppLabel.count() > 0) { await ppLabel.click(); }
    else { await page.locator('input[type="radio"][value*="MPPO"]').first().click().catch(() => {}); }
    await page.waitForTimeout(300);
    const cb = page.locator('button:not(.ng-hide):has-text("Continue")').first();
    if (await cb.count() > 0) { await cb.click(); }
    else {
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent?.includes('Continue') && !b.classList.contains('ng-hide') && b.offsetParent);
        if (b) b.click();
      });
    }
    await page.waitForURL('**/providerSearch**', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('#Doctors, input[ng-model="criteria.typeAheadSearch"]', { timeout: 10000 }).catch(() => {});

    if (isNameSearch) {
      const results = await searchNameTypeahead(name, zip, maxResults, page);
      // Keep this fresh browser as the new warm page
      if (_h.browser) { try { await _h.browser.close(); } catch {} }
      _h.browser = browser; _h.page = page; _h.zip = zip;
      return results;
    }

    // ── Specialty search ─────────────────────────────────────────────────────
    const medLink = page.locator('a, button, li').filter({ hasText: 'Medical Doctors' }).first();
    if (await medLink.count() > 0) { await medLink.click(); }
    else {
      await page.evaluate(() => {
        Array.from(document.querySelectorAll('a, button, li, span'))
          .find(e => e.offsetParent && e.textContent?.includes('Medical Doctors'))?.click();
      });
    }
    await page.waitForURL('**/providerMedical**', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const specLink = page.locator('a, button, li').filter({ hasText: 'Medical Specialists' }).first();
    if (await specLink.count() > 0) { await specLink.click(); }
    else {
      await page.evaluate(() => {
        Array.from(document.querySelectorAll('a, button, li, span'))
          .find(e => e.offsetParent && e.textContent?.includes('Medical Specialists') && !e.textContent?.includes('All'))?.click();
      });
    }
    await page.waitForURL('**/providerSearchSpecialists**', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);

    const respP = page.waitForResponse(
      res => res.url().includes('publicdse_providersearch'), { timeout: 25000 }
    ).catch(() => null);
    await page.evaluate(targetSpec => {
      const all = Array.from(document.querySelectorAll('a, button, li, span, div[role="button"]'));
      const exact   = all.find(e => e.offsetParent && e.textContent?.trim().toLowerCase() === targetSpec.toLowerCase());
      if (exact)   { exact.click(); return; }
      const partial = all.find(e => e.offsetParent && e.textContent?.toLowerCase().includes(targetSpec.toLowerCase()));
      if (partial) { partial.click(); return; }
      const allS    = all.find(e => e.offsetParent && e.textContent?.includes('All Medical Specialists'));
      if (allS) allS.click();
    }, specialty);

    await respP;
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);

    if (!capturedBody) throw new Error('Aetna: no API response captured');
    return parseAetnaBody(capturedBody).slice(0, maxResults);

  } finally {
    // Only close if we didn't promote it to the warm page
    if (_h.browser !== browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = searchAetna;
