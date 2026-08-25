// searchers/aetna.js
//
// Strategy:
//   Warm-up (once, ~50s): browser navigates to providerSearch, types one char → captures
//                          auth headers from the intercepted API request
//   Name search  (3-5s) : direct https.get() with cached URL template + auth headers
//   Token expired       : clear cache → re-warm automatically
//   Specialty search    : fresh browser (navigates to different sub-page)
//
const https = require('https');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

// ── Module-level auth cache ───────────────────────────────────────────────────
const _h = {
  urlTemplate   : null,   // full API URL captured from AngularJS request
  reqHeaders    : null,   // all request headers (incl. x-ibm-client-id)
  apiBase       : null,   // e.g. 'https://api01.aetna.com/healthcore/prod/v3'
  searchPageUrl : null,   // URL of the providerSearch page (for fast re-navigation)
  browser       : null,   // warm browser kept alive between Railway requests
  page          : null,
  zip           : null,
  initPromise   : null,
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
      const info   = p.providerInformation || {};
      const locRaw = p.providerLocations;
      const loc    = Array.isArray(locRaw) ? locRaw[0] : (locRaw || {});
      const addr   = loc.address   || {};
      const cont   = loc.contacts  || {};
      let spec = '';
      const sp = p.providerSpecialties;
      if (Array.isArray(sp)) spec = sp[0]?.specialty?.description || '';
      else if (sp?.specialty) spec = sp.specialty.description || '';
      spec = decodeHtml(spec);
      const desigs = Array.isArray(p.providerDesignations)
        ? p.providerDesignations
        : p.providerDesignations ? [p.providerDesignations] : [];
      return {
        network: 'Aetna Open Choice PPO',
        name:    decodeHtml(info.providerDisplayName?.full || ''),
        npi:     info.primaryNPI?.nationalProviderId || '',
        providerType: info.type || '',
        specialty: spec,
        address: {
          street: decodeHtml(addr.streetLine1   || ''),
          city:   decodeHtml(addr.city          || ''),
          state:  addr.state      || '',
          zip:    addr.postalCode || '',
        },
        phone:    cont.phonesVoice?.number || p.contacts?.primaryPhone?.number || '',
        distance: parseFloat(addr.distance)  || null,
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
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('https timeout')); });
  });
}

const BROWSER_ARGS = [
  '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu',
  '--no-first-run','--no-zygote','--disable-background-networking',
  '--disable-default-apps','--disable-sync','--disable-translate','--mute-audio',
  '--disable-extensions','--disable-component-update','--safebrowsing-disable-auto-update',
];

// ── Search by typing into the warm browser's search box and capturing typeahead ─
// Angular fires the right API request with correct auth/params automatically.
// We listen for the response and capture it — no manual param guessing needed.
async function searchViaAngular(name, zip, maxResults) {
  if (!_h.page || _h.page.isClosed()) throw new Error('No warm page available');

  console.log('[Aetna] ⚡ Type-and-capture search for:', name);

  // Ensure we're on the search page (has the search input box)
  const inp = _h.page.locator('#Doctors, input[ng-model="criteria.typeAheadSearch"]').first();
  let inpCount = await inp.count().catch(() => 0);
  console.log('[Aetna] Search input found:', inpCount > 0, '| page URL:', _h.page.url().substring(0, 100));

  if (inpCount === 0) {
    // Navigate directly back to search page — much faster than full flow (~5-10s vs ~50s)
    const searchUrl = _h.searchPageUrl ||
      'https://www.aetna.com/dsepublic/#/contentPage?page=providerSearch&productIdentifier=~MPPO&siteId=dse&language=en';
    console.log('[Aetna] Re-navigating to search page:', searchUrl.substring(0, 120));
    await _h.page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(e =>
      console.log('[Aetna] Navigation error:', e.message));
    await _h.page.waitForSelector('#Doctors, input[ng-model="criteria.typeAheadSearch"]',
      { timeout: 12000 }).catch(() => {});
    inpCount = await inp.count().catch(() => 0);
    if (inpCount === 0) throw new Error('Search input not found after re-navigation');
  }

  // Helper: make a promise that resolves with the first provider-containing API body
  const makeProviderListener = (page, timeoutMs) => new Promise((resolve) => {
    const t = setTimeout(() => { page.off('response', h); resolve(null); }, timeoutMs);
    const h = async (res) => {
      const url = res.url();
      // Catch ANY aetna.com response — typeahead may not go to api01 specifically
      if (!url.includes('aetna.com')) return;
      if (/\.(js|css|png|jpg|gif|ico|svg|woff|ttf)(\?|$)/.test(url)) return;
      const ep = url.split('/').pop()?.split('?')[0] || '';
      if (ep === 'publicdse_pagecontent' || ep === 'publicdse_productcodes') return;
      const status = res.status();
      console.log('[Aetna] aetna.com response:', status, ep, '|', url.substring(0, 200));
      if (status >= 400) return;
      try {
        const body = await res.text();
        if (!body || body.length < 100) return;
        console.log('[Aetna] Body[' + ep + '] len=' + body.length + ' prefix:', body.substring(0, 120));
        if ((body.includes('providerInfoResponses') || body.includes('providerDisplayName')) &&
            !body.includes('"statusCode":"3000"') && !body.includes('"statusCode":3000')) {
          clearTimeout(t);
          page.off('response', h);
          console.log('[Aetna] ✓ Provider data found in:', ep);
          resolve(body);
        }
      } catch(e) { console.log('[Aetna] Read error for', ep, ':', e.message); }
    };
    page.on('response', h);
  });

  // Phase 1: type name and wait up to 8s for any typeahead/search response
  const typeaheadPromise = makeProviderListener(_h.page, 8000);

  await inp.click({ clickCount: 3 });
  await _h.page.waitForTimeout(80);
  // Use keyboard to clear + type so Angular's input watchers fire properly
  await _h.page.keyboard.press('Control+a');
  await _h.page.keyboard.press('Delete');
  const query = name.length >= 3 ? name.substring(0, 25) : name + ' aa';
  await inp.type(query, { delay: 70 });
  console.log('[Aetna] Typed:', query, '— waiting for typeahead response...');

  // Log Angular scope state right after typing (diagnostic)
  const scopeInfo = await _h.page.evaluate(() => {
    try {
      const input = document.querySelector('#Doctors') ||
                    document.querySelector('input[ng-model="criteria.typeAheadSearch"]');
      if (!input) return 'no input';
      const scope = window.angular?.element(input)?.scope?.();
      if (!scope) return 'no scope';
      const keys = Object.keys(scope).filter(k => !k.startsWith('$$'));
      return 'val="' + (input.value || '') + '" criteriaKeys=' +
             (scope.criteria ? Object.keys(scope.criteria).join(',') : 'none') +
             ' scopeKeys=' + keys.slice(0, 15).join(',');
    } catch(e) { return 'error: ' + e.message; }
  });
  console.log('[Aetna] Scope state after type:', scopeInfo);

  let body = await typeaheadPromise;

  // Phase 2: no typeahead data — press Enter to navigate to results page
  if (!body) {
    console.log('[Aetna] No typeahead data — pressing Enter for results page search...');
    const resultsPromise = makeProviderListener(_h.page, 20000);
    await _h.page.keyboard.press('Enter');
    // Wait for navigation + results to load
    await _h.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    body = await resultsPromise;
    if (body) {
      console.log('[Aetna] Got provider data from results page search');
      // Page has navigated; invalidate the search page cache
      _h.searchPageUrl = null;
    }
  }

  if (!body) throw new Error('No provider data from typeahead or results page in 28s');

  const parsed = parseAetnaBody(body);
  if (!parsed.length) throw new Error(`0 providers in response (body: ${body.substring(0, 200)})`);
  return dedup(parsed).slice(0, Math.min(maxResults, 8));
}

// ── Navigate browser to providerSearch page ───────────────────────────────────
async function navigateToSearch(page, zip) {
  // Step 1: landing
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

  // Step 2: select Open Choice PPO
  await page.waitForSelector('label, input[type="radio"]', { timeout: 8000 }).catch(() => {});
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
      const b = Array.from(document.querySelectorAll('button'))
        .find(b => b.textContent?.includes('Continue') && !b.classList.contains('ng-hide') && b.offsetParent);
      if (b) b.click();
    });
  }
  await page.waitForURL('**/providerSearch**', { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('#Doctors, input[ng-model="criteria.typeAheadSearch"]', { timeout: 10000 }).catch(() => {});
}

// ── Warm browser: navigate + type one char to capture auth headers ────────────
async function initWarmPage(zip) {
  console.log(`[Aetna] Warming browser for ZIP ${zip}...`);
  const t0 = Date.now();

  // Safely close previous browser
  const old = _h.browser;
  _h.browser = null; _h.page = null; _h.searchPageUrl = null;
  if (old) { try { await old.close(); } catch {} }

  const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
  _h.browser = browser;
  browser.on('disconnected', () => {
    if (_h.browser === browser) { _h.browser = null; _h.page = null; _h.zip = null; _h.searchPageUrl = null; }
  });

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

  // Log ALL aetna API requests (both prod + int) to understand routing.
  // Capture auth headers only from the prod host (api01.aetna.com, NOT api01.int.aetna.com).
  page.on('request', req => {
    const url = req.url();
    if (!url.includes('aetna.com') || !url.includes('healthcore')) return;
    const hdrs = req.headers();
    const host = url.match(/https?:\/\/([^/]+)/)?.[1] || '';
    const isProd = host === 'api01.aetna.com';
    const endpoint = url.split('/').pop()?.split('?')[0] || '';
    const authKeys = Object.keys(hdrs).filter(k => /auth|ibm|key|token|secret/i.test(k)).join(',');
    console.log('[Aetna] API req:', endpoint, '| host:', host, '| prod:', isProd, '| auth:', authKeys || 'none');
    if (!_h.reqHeaders && isProd) {
      _h.reqHeaders = hdrs;
      console.log('[Aetna] ✓ Auth headers captured (PROD) clientId:', hdrs['x-ibm-client-id']?.substring(0, 8) + '...');
    }
    if (!_h.apiBase && isProd) {
      const m = url.match(/^(https:\/\/[^/]+\/healthcore\/[^/]+\/v\d+)/);
      if (m) { _h.apiBase = m[1]; console.log('[Aetna] ✓ apiBase:', _h.apiBase); }
    }
    if (url.includes('publicdse_providersearch') && isProd && !_h.urlTemplate) {
      _h.urlTemplate = url;
      _h.reqHeaders  = hdrs;
      console.log('[Aetna] ✓ Search URL template captured from PROD');
    }
  });

  await navigateToSearch(page, zip);

  // Trigger typeahead to confirm the search box works and capture any auth headers.
  // IMPORTANT: Do NOT press Enter — that navigates to the results page and breaks
  // subsequent searches. We stay on the search page so searchViaAngular can reuse it.
  const inp = page.locator('#Doctors, input[ng-model="criteria.typeAheadSearch"]').first();
  const inpCount = await inp.count().catch(() => 0);
  console.log('[Aetna] Search input available after navigation:', inpCount > 0);

  // Store the search page URL for fast re-navigation if we ever get navigated away
  _h.searchPageUrl = page.url();
  console.log('[Aetna] Search page URL stored:', _h.searchPageUrl);

  if (inpCount > 0) {
    try {
      await inp.click();
      await page.waitForTimeout(200);
      await inp.fill('smith');
      await page.waitForTimeout(600);
      // Wait for any api01.aetna.com response (typeahead fires immediately when typing)
      await page.waitForResponse(
        r => r.url().includes('api01.aetna.com') && !r.url().includes('pagecontent') && !r.url().includes('productcodes'),
        { timeout: 8000 }
      ).catch(() => console.log('[Aetna] No typeahead response during warm-up (ok)'));
      await page.waitForTimeout(200);
    } catch (e) {
      console.log('[Aetna] Warm-up typeahead error:', e.message);
    }
  } else {
    console.log('[Aetna] ⚠ Search input NOT found after navigation — page may be in wrong state');
  }

  _h.page = page;
  _h.zip  = zip;
  console.log(`[Aetna] Warm ready in ${Date.now() - t0}ms | page: SET | headers: ${_h.reqHeaders ? 'captured ✓' : 'MISSING ✗'} | urlTemplate: ${_h.urlTemplate ? 'captured ✓' : 'n/a'}`);
  return page;
}

async function getWarmPage(zip) {
  if (_h.page && _h.zip === zip) {
    try { if (!_h.page.isClosed()) return _h.page; } catch {}
  }
  if (_h.initPromise) return _h.initPromise;
  _h.initPromise = initWarmPage(zip).finally(() => { _h.initPromise = null; });
  return _h.initPromise;
}

// ── Main export ───────────────────────────────────────────────────────────────
// ── Direct HTTPS using ALL captured headers (cookies + x-ibm-client-id) ──────
// After warm-up, _h.reqHeaders has every header the browser sent including session
// cookies. Sending them all bypasses the WAF that blocked header-stripped requests.
async function searchFastHttps(name, zip, maxResults) {
  if (!_h.reqHeaders) throw new Error('No captured headers');

  // Extract productIdentifier from the captured URL template (e.g. "~MPPO") —
  // but DON'T copy the rest of the template params which are specific-provider-scoped
  // (the warm-up search selects a typeahead suggestion, so the URL is for one exact provider).
  // Build a clean general name-search URL instead.
  let productId = '~MPPO';
  if (_h.urlTemplate) {
    try {
      const t = new URL(_h.urlTemplate);
      productId = t.searchParams.get('productIdentifier') || productId;
    } catch {}
  }
  const base = _h.apiBase || 'https://api01.aetna.com/healthcore/prod/v3';
  const u = new URL(base + '/publicdse_providersearch');
  u.searchParams.set('searchText', name);
  u.searchParams.set('productIdentifier', productId);
  u.searchParams.set('postalCode', zip || '77041');
  u.searchParams.set('language', 'en');
  u.searchParams.set('siteId', 'dse');
  u.searchParams.set('responseLanguagePreference', 'en');
  u.searchParams.set('radius', '75');
  u.searchParams.set('maxResultCount', '25');
  u.searchParams.set('pageNum', '1');

  // Send ALL captured headers — session cookie is the key WAF bypass
  const hdrs = { ..._h.reqHeaders };
  delete hdrs['content-length']; delete hdrs['transfer-encoding'];
  delete hdrs['connection']; delete hdrs['host'];

  console.log('[Aetna] ⚡ Direct HTTPS search:', u.toString().substring(0, 200));
  const { status, body } = await httpsGet(u.toString(), hdrs);
  console.log('[Aetna] Direct HTTPS status:', status, '| body:', body.substring(0, 120));
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const parsed = parseAetnaBody(body);
  if (!parsed.length) throw new Error(`0 providers (body: ${body.substring(0, 150)})`);
  return dedup(parsed).slice(0, Math.min(maxResults, 8));
}

async function searchAetna({
  specialty  = 'All Medical Specialists',
  name       = '',
  zip        = '77041',
  maxResults = 25,
} = {}) {
  const isNameSearch = !!name;

  // ── Name search ─────────────────────────────────────────────────────────────
  if (isNameSearch) {

    // 1. Warm browser if we don't have a live page yet
    if (!_h.page || !_h.reqHeaders) {
      console.log('[Aetna] Warming browser...');
      try { await getWarmPage(zip); } catch (e) { console.log('[Aetna] Warm-up failed:', e.message); }
      console.log('[Aetna] Post-warm: page=', _h.page ? 'SET' : 'NULL', '| urlTemplate:', !!_h.urlTemplate, '| headers:', !!_h.reqHeaders);
    }

    // 2. Angular $http injection inside warm browser (~5-10s)
    //    (Direct HTTPS removed — Aetna WAF always returns 403 from Node.js)
    if (_h.page && !_h.page.isClosed()) {
      try {
        const results = await searchViaAngular(name, zip, maxResults);
        console.log(`[Aetna] ⚡ Angular injection success: ${results.length} providers`);
        return results;
      } catch (e) {
        console.log('[Aetna] Angular injection failed:', e.message);
      }
    }

    // 3. Last resort: full fresh browser (~60s)
    console.log('[Aetna] Falling back to full browser typeahead...');
    return searchAetnaFreshBrowserTypeahead(name, zip, maxResults);
  }

  // ── Specialty search (always fresh browser) ──────────────────────────────
  return searchAetnaSpecialty(specialty, zip, maxResults);
}

// ── Last-resort: fresh browser with typeahead (name search) ──────────────────
async function searchAetnaFreshBrowserTypeahead(name, zip, maxResults) {
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

    // Capture headers ONLY from prod (api01.aetna.com) — int has a different x-ibm-client-id
    page.on('request', req => {
      const url = req.url();
      if (!url.includes('api01.aetna.com') && !url.includes('healthcore')) return;
      const hdrs = req.headers();
      const isProd = url.includes('api01.aetna.com') && !url.includes('int.aetna');
      console.log('[Aetna] Fresh browser API req:', url.substring(0, 150), '| prod:', isProd, '| auth:', Object.keys(hdrs).filter(k => /auth|ibm|key|token|secret/i.test(k)).join(','));
      if (!_h.reqHeaders && isProd) { _h.reqHeaders = hdrs; }
      if (!_h.apiBase && isProd) {
        const m = url.match(/^(https:\/\/[^/]+\/healthcore\/[^/]+\/v\d+)/);
        if (m) _h.apiBase = m[1];
      }
      if (url.includes('publicdse_providersearch') && isProd && !_h.urlTemplate) {
        _h.urlTemplate = url; _h.reqHeaders = hdrs;
        console.log('[Aetna] ✓ Search URL template captured (fresh browser)');
      }
    });

    let capturedBody = null;
    page.on('response', async res => {
      const url = res.url();
      if (url.includes('publicdse_providersearch') || url.includes('api01.aetna.com'))
        try { capturedBody = await res.text(); } catch {}
    });

    await navigateToSearch(page, zip);

    // Type name and wait for a response — AngularJS needs 3+ chars to fire the API
    const inp = page.locator('#Doctors, input[ng-model="criteria.typeAheadSearch"]').first();
    await inp.waitFor({ timeout: 8000 });
    await inp.click();
    // Type enough chars to trigger the typeahead (need ≥3 alphanumeric)
    const typeQuery = name.length >= 3 ? name : name + 'aa';
    await page.keyboard.type(typeQuery, { delay: 30 });

    // Wait for ANY api01.aetna.com response (typeahead or search)
    const resp = await page.waitForResponse(
      r => r.url().includes('api01.aetna.com') || r.url().includes('healthcore'),
      { timeout: 15000 }
    ).catch(() => null);

    if (resp) {
      const body = await resp.text().catch(() => null);
      if (body) capturedBody = body;
    }

    // Promote this browser as the warm page, then try Angular search
    if (_h.browser && _h.browser !== browser) { try { await _h.browser.close(); } catch {} }
    _h.browser = browser; _h.page = page; _h.zip = zip;
    try {
      const results = await searchViaAngular(name, zip, maxResults);
      console.log('[Aetna] Angular search succeeded in fresh browser fallback');
      return results;
    } catch (e) {
      console.log('[Aetna] Angular search failed in fresh browser fallback:', e.message);
    }

    // Use the captured body directly if we have it
    if (capturedBody) {
      const parsed = parseAetnaBody(capturedBody);
      if (parsed.length) return dedup(parsed).slice(0, Math.min(maxResults, 8));
    }

    throw new Error('Aetna: could not get results via any method');
  } finally {
    if (_h.browser !== browser) await browser.close().catch(() => {});
  }
}

// ── Specialty search ──────────────────────────────────────────────────────────
async function searchAetnaSpecialty(specialty, zip, maxResults) {
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
    // Refresh auth headers from specialty search too
    page.on('request', req => {
      if (req.url().includes('publicdse_providersearch')) {
        _h.urlTemplate = req.url();
        _h.reqHeaders  = req.headers();
      }
    });

    await navigateToSearch(page, zip);

    // Navigate to Medical Specialists
    const medLink = page.locator('a, button, li').filter({ hasText: 'Medical Doctors' }).first();
    if (await medLink.count() > 0) await medLink.click();
    else await page.evaluate(() => {
      Array.from(document.querySelectorAll('a, button, li, span'))
        .find(e => e.offsetParent && e.textContent?.includes('Medical Doctors'))?.click();
    });
    await page.waitForURL('**/providerMedical**', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const specLink = page.locator('a, button, li').filter({ hasText: 'Medical Specialists' }).first();
    if (await specLink.count() > 0) await specLink.click();
    else await page.evaluate(() => {
      Array.from(document.querySelectorAll('a, button, li, span'))
        .find(e => e.offsetParent && e.textContent?.includes('Medical Specialists')
          && !e.textContent?.includes('All'))?.click();
    });
    await page.waitForURL('**/providerSearchSpecialists**', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);

    const respP = page.waitForResponse(
      r => r.url().includes('publicdse_providersearch'), { timeout: 25000 }
    ).catch(() => null);

    await page.evaluate(sp => {
      const all = [...document.querySelectorAll('a, button, li, span, div[role="button"]')];
      const match = all.find(e => e.offsetParent && e.textContent?.trim().toLowerCase() === sp.toLowerCase())
        || all.find(e => e.offsetParent && e.textContent?.toLowerCase().includes(sp.toLowerCase()))
        || all.find(e => e.offsetParent && e.textContent?.includes('All Medical Specialists'));
      if (match) match.click();
    }, specialty);

    await respP;
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);

    if (!capturedBody) throw new Error('Aetna specialty: no API response captured');
    return parseAetnaBody(capturedBody).slice(0, maxResults);

  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = searchAetna;
