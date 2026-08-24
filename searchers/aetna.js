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

// ── Search via Angular $http inside the warm browser (~3-8s after warm-up) ───
// The Aetna WAF blocks direct Node.js https.get() calls to publicdse_providersearch,
// but allows browser-originated requests. We inject the search call via Angular's
// own $http service so it goes through the browser's networking stack with all the
// right session cookies, interceptors, and auth headers already in place.
async function searchViaAngular(name, zip, maxResults) {
  if (!_h.page || _h.page.isClosed()) throw new Error('No warm page available');

  const searchText = name + ' (any location)';
  console.log('[Aetna] ⚡ Injecting Angular $http search for:', searchText);

  // Set up response capture BEFORE injecting the request
  const bodyPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      _h.page.off('response', handler);
      resolve(null);
    }, 20000);
    const handler = async (res) => {
      if (!res.url().includes('publicdse_providersearch')) return;
      clearTimeout(timeout);
      _h.page.off('response', handler);
      try { resolve(await res.text()); } catch { resolve(null); }
    };
    _h.page.on('response', handler);
  });

  // Extract the x-ibm-client-id from captured headers — we'll pass it explicitly
  // since Angular's interceptor doesn't add it for direct $http.get() calls.
  const clientId = _h.reqHeaders?.['x-ibm-client-id'] || '';
  console.log('[Aetna] x-ibm-client-id present:', !!clientId);

  // Inject $http.get() call via Angular's own HTTP service.
  // Runs inside the browser (not blocked by WAF). We add the client-id explicitly
  // since the Angular interceptor only adds it for requests from UI controllers.
  const injected = await _h.page.evaluate(([searchText, postalCode, pipeName, clientId]) => {
    try {
      const el = document.querySelector('[ng-app],[data-ng-app],.ng-scope,[ng-controller]');
      if (!el) return { error: 'no Angular root element' };
      const inj = window.angular?.element(el)?.injector?.();
      if (!inj) return { error: 'no Angular injector' };
      const $http = inj.get('$http');
      if (!$http) return { error: 'no $http service' };

      // Direct $http.get() with explicit auth header — goes through browser networking stack
      $http.get('https://api01.aetna.com/healthcore/prod/v3/publicdse_providersearch', {
        headers: clientId ? { 'x-ibm-client-id': clientId } : {},
        params: {
          searchText,
          pipeName,
          responseLanguagePreference: 'en',
          siteId: 'dse',
          language: 'en',
          postalCode,
          suppressTypeAheadSearchQuery: 'true',
          radius: '75',
          maxResultCount: '25',
          pageNum: '1',
        },
      });
      return { method: '$http.get', hasClientId: !!clientId };
    } catch(e) {
      return { error: e.message };
    }
  }, [searchText, zip || '77041', 'Open Choice PPO', clientId]);

  console.log('[Aetna] Angular inject result:', JSON.stringify(injected));
  if (injected?.error) throw new Error('Angular inject failed: ' + injected.error);

  const body = await bodyPromise;
  console.log('[Aetna] Angular response length:', body?.length, '| prefix:', body?.substring(0, 150));
  if (!body) throw new Error('Angular $http: no response captured in 20s');

  const parsed = parseAetnaBody(body);
  if (!parsed.length) throw new Error(`Angular search returned 0 providers (body: ${body.substring(0, 200)})`);
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

  // Capture auth headers ONLY from api01.aetna.com (prod) — NOT from api01.int.aetna.com.
  // The int and prod environments use DIFFERENT x-ibm-client-id values.
  // We call prod endpoints, so we need the prod client-id.
  page.on('request', req => {
    const url = req.url();
    if (!url.includes('api01.aetna.com') && !url.includes('healthcore')) return;
    const hdrs = req.headers();
    const isProd = url.includes('api01.aetna.com') && !url.includes('int.aetna');
    const authKeys = Object.keys(hdrs).filter(k => /auth|ibm|key|token|secret/i.test(k)).join(',');
    console.log('[Aetna] API request:', url.substring(0, 180), '| prod:', isProd, '| auth keys:', authKeys);
    if (!_h.reqHeaders && isProd) {
      _h.reqHeaders = hdrs;
      console.log('[Aetna] ✓ Auth headers captured (PROD) from:', url.substring(0, 120));
    }
    if (!_h.apiBase && isProd) {
      const m = url.match(/^(https:\/\/[^/]+\/healthcore\/[^/]+\/v\d+)/);
      if (m) { _h.apiBase = m[1]; console.log('[Aetna] ✓ apiBase:', _h.apiBase); }
    }
    if (url.includes('publicdse_providersearch') && isProd && !_h.urlTemplate) {
      _h.urlTemplate = url;
      _h.reqHeaders  = hdrs;
      console.log('[Aetna] ✓ Search URL template captured');
    }
  });

  await navigateToSearch(page, zip);

  // Strategy 1: extract auth headers directly from AngularJS $http service
  // (AngularJS sets auth in $http.defaults.headers.common at app startup — no API call needed)
  const ngHeaders = await page.evaluate(() => {
    try {
      const el = document.querySelector('[ng-app], [data-ng-app], .ng-scope');
      if (!el) return null;
      const injector = window.angular?.element(el)?.injector();
      if (!injector) return null;
      const $http = injector.get('$http');
      const common = ($http?.defaults?.headers?.common) || {};
      // Also look inside registered interceptors for auth
      return Object.keys(common).length > 0 ? common : null;
    } catch (e) {
      return { __error: e.message };
    }
  });
  console.log('[Aetna] AngularJS $http headers:', JSON.stringify(ngHeaders));

  // Strategy 2: type 3+ chars into typeahead to trigger the API, capture via page.on('request')
  if (!_h.reqHeaders) {
    const inp = page.locator('#Doctors, input[ng-model="criteria.typeAheadSearch"]').first();
    if (await inp.count() > 0) {
      try {
        // Focus via JS, then dispatch events the way a real browser would
        await page.evaluate(() => {
          const el = document.querySelector('#Doctors, input[ng-model="criteria.typeAheadSearch"]');
          if (el) { el.focus(); el.click(); }
        });
        await page.waitForTimeout(300);
        // Type using fill() + input events — more reliable than keyboard.type in headless
        await inp.fill('smith');
        await page.evaluate(() => {
          const el = document.querySelector('#Doctors, input[ng-model="criteria.typeAheadSearch"]');
          if (!el) return;
          ['input', 'change', 'keyup'].forEach(t =>
            el.dispatchEvent(new Event(t, { bubbles: true }))
          );
          // Also trigger AngularJS's own digest
          try {
            const sc = window.angular?.element(el)?.scope();
            sc?.criteria && (sc.criteria.typeAheadSearch = 'smith');
            sc?.$apply?.();
          } catch {}
        });
        // Wait up to 10s for any publicdse_providersearch request
        await page.waitForResponse(
          r => r.url().includes('publicdse_providersearch'),
          { timeout: 10000 }
        ).catch(() => {});
        await page.waitForTimeout(500);
      } catch (e) {
        console.log('[Aetna] Typeahead trigger error:', e.message);
      }
    }
  }

  // If we got AngularJS headers but still need the URL template, we'll capture it
  // on the first real API call (fast path will trigger it via the cached headers approach)
  if (ngHeaders && !ngHeaders.__error && Object.keys(ngHeaders).length > 0 && !_h.reqHeaders) {
    // We have auth headers from AngularJS but no URL template yet
    // Store the headers; the URL template will be set when the first real request fires
    console.log('[Aetna] Got AngularJS headers (no URL template yet, will capture on first request)');
    _h.reqHeaders = ngHeaders; // partial — URL template still needed
  }

  _h.page = page;
  _h.zip  = zip;
  console.log(`[Aetna] Warm ready in ${Date.now() - t0}ms | headers: ${_h.reqHeaders ? 'captured ✓' : 'MISSING ✗'} | url: ${_h.urlTemplate ? 'captured ✓' : 'MISSING ✗'}`);
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
async function searchAetna({
  specialty  = 'All Medical Specialists',
  name       = '',
  zip        = '77041',
  maxResults = 25,
} = {}) {
  const isNameSearch = !!name;

  // ── Name search ─────────────────────────────────────────────────────────────
  if (isNameSearch) {

    // 1. If we have a warm browser page → inject Angular $http search (~3-8s)
    //    This runs the request INSIDE the browser so WAF/cookies are handled correctly.
    if (_h.page && !_h.page.isClosed()) {
      try {
        const results = await searchViaAngular(name, zip, maxResults);
        console.log(`[Aetna] ⚡ Angular fast success: ${results.length} providers`);
        return results;
      } catch (e) {
        console.log('[Aetna] Angular fast path failed:', e.message);
        // Page may have gone stale — clear it and fall through to re-warm
        _h.page = null;
      }
    }

    // 2. No warm page yet → warm browser, then Angular search
    console.log('[Aetna] Warming browser...');
    try {
      await getWarmPage(zip);
    } catch (e) {
      console.log('[Aetna] Warm-up failed:', e.message);
    }

    if (_h.page) {
      try {
        const results = await searchViaAngular(name, zip, maxResults);
        console.log(`[Aetna] ⚡ Angular fast success (after warm): ${results.length} providers`);
        return results;
      } catch (e) {
        console.log('[Aetna] Angular search failed after warm:', e.message);
      }
    }

    // 3. Last resort: use a fresh browser + typeahead click
    console.log('[Aetna] Falling back to full typeahead...');
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
