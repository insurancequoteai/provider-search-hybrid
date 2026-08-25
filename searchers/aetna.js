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
  urlTemplate : null,   // full API URL captured from AngularJS request (best case)
  reqHeaders  : null,   // all request headers (incl. x-ibm-client-id) from that request
  apiBase     : null,   // e.g. 'https://api01.aetna.com/healthcore/prod/v3' (from first captured request)
  browser     : null,   // warm browser kept alive between Railway requests
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

// ── Search via Angular $http injected directly into the warm browser (~3-8s) ──
// Uses page.evaluate() to call Angular's $http.get() and AWAIT the promise inside
// the browser — the resolved response body is returned directly to Node.js.
// No external response listener = no race condition with the results page's own
// publicdse_providersearch requests.
async function searchViaAngular(name, zip, maxResults) {
  if (!_h.page || _h.page.isClosed()) throw new Error('No warm page available');

  console.log('[Aetna] ⚡ Angular $http direct search for:', name);

  const clientId = _h.reqHeaders?.['x-ibm-client-id'] || '';
  const apiBase  = _h.apiBase || 'https://api01.aetna.com/healthcore/prod/v3';
  const apiUrl   = apiBase + '/publicdse_providersearch';

  console.log('[Aetna] Angular inject: clientId:', clientId ? clientId.substring(0, 8) + '...' : 'NONE', '| apiUrl:', apiUrl);

  // Await the Angular $http promise INSIDE the browser — returns the body directly.
  // This works whether we're on the search page or results page.
  const result = await _h.page.evaluate(
    ([name, zip, clientId, apiUrl]) => {
      return new Promise((resolve) => {
        try {
          // Find Angular root — try multiple selectors
          const el = document.querySelector('[ng-app],[data-ng-app],.ng-scope,[ng-controller],[ui-view]')
                  || document.body;
          if (!el) return resolve({ error: 'no DOM element found' });
          const inj = window.angular?.element(el)?.injector?.()
                   || window.angular?.element(document.body)?.injector?.();
          if (!inj) return resolve({ error: 'no Angular injector (angular not ready?)' });
          const $http = inj.get('$http');
          if (!$http) return resolve({ error: 'no $http service' });

          const params = {
            searchText: name,
            productIdentifier: '~MPPO',
            postalCode: zip,
            language: 'en',
            siteId: 'dse',
            responseLanguagePreference: 'en',
            radius: '75',
            maxResultCount: '25',
            pageNum: '1',
          };

          const t = setTimeout(() => resolve({ error: 'angular $http timeout after 22s' }), 22000);

          $http.get(apiUrl, {
            headers: clientId ? { 'x-ibm-client-id': clientId } : {},
            params,
          }).then(
            resp => {
              clearTimeout(t);
              resolve({ ok: true, body: JSON.stringify(resp.data) });
            },
            err => {
              clearTimeout(t);
              const errBody = err.data ? JSON.stringify(err.data).substring(0, 300) : '';
              resolve({ error: 'http_' + err.status, body: errBody });
            }
          );

          // Force Angular $digest so the $http request actually fires
          setTimeout(() => {
            try {
              const $rootScope = inj.get('$rootScope');
              if (!$rootScope.$$phase) $rootScope.$apply(() => {});
            } catch(e) { /* digest already running — ok */ }
          }, 50);
        } catch(e) { resolve({ error: e.message }); }
      });
    },
    [name, zip || '77041', clientId, apiUrl]
  );

  console.log('[Aetna] Angular $http result:', result?.ok ? 'ok' : ('ERR: ' + result?.error),
    '| body length:', result?.body?.length, '| prefix:', result?.body?.substring(0, 80));

  if (result?.error) {
    throw new Error('Angular $http: ' + result.error
      + (result.body ? ' | ' + result.body.substring(0, 120) : ''));
  }
  if (!result?.body) throw new Error('Angular $http: no body returned');

  const parsed = parseAetnaBody(result.body);
  if (!parsed.length) throw new Error(`0 providers in Angular response (body: ${result.body.substring(0, 200)})`);
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

  // Always trigger typeahead to: (1) confirm search box is available, (2) capture any
  // publicdse_providersearch request and its auth headers if we don't have them yet.
  const inp = page.locator('#Doctors, input[ng-model="criteria.typeAheadSearch"]').first();
  const inpCount = await inp.count().catch(() => 0);
  console.log('[Aetna] Search input available after navigation:', inpCount > 0);
  if (inpCount > 0) {
    try {
      await inp.click();
      await page.waitForTimeout(200);
      await inp.fill('smith');
      await page.waitForTimeout(200);
      // Press Enter to trigger actual provider search (typing alone only opens dropdown)
      await page.keyboard.press('Enter');
      // Wait up to 12s for actual provider SEARCH response (not ratings/reviews)
      await page.waitForResponse(
        r => r.url().includes('publicdse_providersearch'),
        { timeout: 12000 }
      ).catch(() => console.log('[Aetna] No provider search response during warm-up (ok, will search on demand)'));
      await page.waitForTimeout(300);
    } catch (e) {
      console.log('[Aetna] Typeahead trigger error:', e.message);
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

    // 1. Warm browser if we don't have a live page + auth headers yet
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
