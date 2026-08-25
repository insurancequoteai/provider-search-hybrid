// searchers/aetna.js
//
// ASA (Aetna Signature Administrators) flow:
//   1. Navigate to ASA landing → enter ZIP → Search → lands on category page
//   2. Type doctor name in search box → typeahead appears with multiple results
//   3. Click "X more Healthcare Providers & Practices »" link → full results page
//   4. Capture publicdse_providersearch API response (multiple providers)
//   5. Filter by name client-side and return
//
//   Warm page stays on the category page between searches.
//   Subsequent searches just type + click → ~3-8s
//
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const ASA_URL       = 'https://www.aetna.com/dsepublic/#/contentPage?page=providerSearch&site_id=asa&language=en';
const NETWORK_NAME  = 'Aetna Signature Administrators';

// ── Module-level warm-page cache ──────────────────────────────────────────────
const _h = {
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
    if (!list.length) console.log('[Aetna] parseBody: empty. prefix:', body.slice(0, 200));
    return list.map(p => {
      const info   = p.providerInformation || {};
      const locRaw = p.providerLocations;
      const loc    = Array.isArray(locRaw) ? locRaw[0] : (locRaw || {});
      const addr   = loc.address  || {};
      const cont   = loc.contacts || {};
      let spec = '';
      const sp = p.providerSpecialties;
      if (Array.isArray(sp)) spec = sp[0]?.specialty?.description || '';
      else if (sp?.specialty) spec = sp.specialty.description || '';
      const desigs = Array.isArray(p.providerDesignations)
        ? p.providerDesignations
        : p.providerDesignations ? [p.providerDesignations] : [];
      return {
        network: NETWORK_NAME,
        name:    decodeHtml(info.providerDisplayName?.full || ''),
        npi:     info.primaryNPI?.nationalProviderId || '',
        providerType: info.type || '',
        specialty: decodeHtml(spec),
        address: {
          street: decodeHtml(addr.streetLine1 || ''),
          city:   decodeHtml(addr.city        || ''),
          state:  addr.state      || '',
          zip:    addr.postalCode || '',
        },
        phone:    cont.phonesVoice?.number || '',
        distance: parseFloat(addr.distance) || null,
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

function filterByName(providers, name) {
  if (!name) return providers;
  const words = name.toLowerCase().trim().split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return providers;
  // All words match
  let out = providers.filter(p => words.every(w => p.name.toLowerCase().includes(w)));
  // Fall back to any word
  if (!out.length) out = providers.filter(p => words.some(w => p.name.toLowerCase().includes(w)));
  return out.length ? out : providers;
}

const BROWSER_ARGS = [
  '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu',
  '--no-first-run','--no-zygote','--disable-background-networking',
  '--disable-default-apps','--disable-sync','--disable-translate','--mute-audio',
  '--disable-extensions','--disable-component-update','--safebrowsing-disable-auto-update',
];

// ── Listen for provider search API response ───────────────────────────────────
function makeProviderListener(pg, timeoutMs) {
  return new Promise(resolve => {
    const t = setTimeout(() => { pg.off('response', h); resolve(null); }, timeoutMs);
    const h = async res => {
      const url = res.url();
      if (!url.includes('publicdse_providersearch')) return;
      if (res.status() >= 400) {
        console.log('[Aetna] API status', res.status(), 'on', url.substring(0, 150));
        return;
      }
      try {
        const body = await res.text();
        if (!body || !body.trimStart().startsWith('{')) return;
        console.log('[Aetna] API body prefix:', body.substring(0, 160));
        if (body.includes('"statusCode":"3000"')) {
          console.log('[Aetna] ⚠ statusCode 3000 — will keep waiting');
          return;
        }
        if (body.includes('providerInfoResponses') || body.includes('providerDisplayName')) {
          clearTimeout(t); pg.off('response', h);
          console.log('[Aetna] ✓ Provider JSON captured, len=', body.length);
          resolve(body);
        }
      } catch(e) { console.log('[Aetna] Response read error:', e.message); }
    };
    pg.on('response', h);
  });
}

// ── Step 1: Navigate ASA landing → enter ZIP → land on category page ──────────
async function navigateToASACategory(page, zip) {
  console.log('[Aetna] Loading ASA landing for ZIP', zip);
  await page.goto(ASA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => !!window.angular, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(700);

  // Landing page has input with placeholder "Enter location here"
  const locInput = page.locator(
    'input[placeholder*="location" i], input[placeholder*="zip" i], input[placeholder*="Enter" i], input[ng-model*="location"], input[ng-model*="zip"]'
  ).first();

  const found = await locInput.count().catch(() => 0);
  if (found > 0) {
    await locInput.click({ clickCount: 3 });
    await locInput.fill(zip);
    await page.evaluate(() => {
      const sel = 'input[placeholder*="location" i], input[placeholder*="zip" i], input[placeholder*="Enter" i]';
      const el  = document.querySelector(sel);
      if (el) {
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '1' }));
      }
    });
    await page.waitForTimeout(400);
    console.log('[Aetna] ZIP', zip, 'entered');
  } else {
    // Debug: log all inputs
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(el => ({
        id: el.id, placeholder: el.placeholder, ngModel: el.getAttribute('ng-model')
      }))
    );
    console.log('[Aetna] ⚠ No location input. Inputs on page:', JSON.stringify(inputs));
  }

  // Click Search button
  const searchBtn = page.locator('button:has-text("Search"), input[value="Search"], button[type="submit"]').first();
  if (await searchBtn.count() > 0) {
    await searchBtn.click();
    console.log('[Aetna] Clicked Search');
  } else {
    await page.keyboard.press('Enter');
    console.log('[Aetna] Pressed Enter to search');
  }

  // Wait for category page — look for "What do you want to search for" text or the search input
  await page.waitForFunction(
    () => document.body.textContent?.includes('What do you want to search for') ||
          document.body.textContent?.includes('search term') ||
          document.body.textContent?.includes('Medical Doctors'),
    { timeout: 18000 }
  ).catch(() => console.log('[Aetna] Category page timeout — proceeding'));
  await page.waitForTimeout(600);

  console.log('[Aetna] Category page ready | URL:', page.url().substring(0, 120));
  return true;
}

// ── Step 2: Type name → click "more results" link → capture API response ──────
async function searchNameOnCategoryPage(page, name, zip) {
  // Find the search box on the category page
  // Screenshot shows: input placeholder "Start typing your search term..."
  const searchSelectors = [
    'input[placeholder*="search term" i]',
    'input[placeholder*="Search" i]',
    'input[ng-model*="typeAhead"]',
    'input[ng-model*="search"]',
    'input[ng-model*="Search"]',
    'input[type="search"]',
    'input[type="text"]',
  ];

  let searchInp = null;
  for (const sel of searchSelectors) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0) > 0) {
      searchInp = el;
      console.log('[Aetna] Search input found via:', sel);
      break;
    }
  }

  if (!searchInp) {
    // Log what's on page
    const html = await page.evaluate(() => document.body.innerHTML.substring(0, 1000));
    console.log('[Aetna] ⚠ No search input. Page snippet:', html.substring(0, 400));
    throw new Error('No search input on category page');
  }

  // Set up API listener BEFORE typing (responses arrive fast)
  const apiPromise = makeProviderListener(page, 25000);

  // Type the doctor's name
  await searchInp.click({ clickCount: 3 });
  await searchInp.fill('');
  const query = name.substring(0, 30);
  await searchInp.type(query, { delay: 80 });
  console.log('[Aetna] Typed:', query, '— waiting for typeahead dropdown...');

  // Wait for typeahead dropdown to appear
  // The dropdown has "Healthcare Providers & Practices" header and individual results
  const typeaheadVisible = await page.waitForFunction(
    () => {
      const texts = ['Healthcare Providers', 'more Healthcare', 'any location'];
      return texts.some(t => document.body.textContent?.includes(t));
    },
    { timeout: 10000 }
  ).catch(() => null);

  if (typeaheadVisible) {
    console.log('[Aetna] Typeahead visible — looking for "more results" link');
    await page.waitForTimeout(300); // let dropdown fully render

    // Try to click "X more Healthcare Providers & Practices »" link first
    const moreLink = page.locator(
      'a:has-text("more Healthcare"), a:has-text("more health"), [href*="providerResults"][href*="more"]'
    ).first();

    if (await moreLink.count() > 0) {
      await moreLink.click();
      console.log('[Aetna] ✓ Clicked "more Healthcare Providers" link');
    } else {
      // Fall back: click "Smith (any location)" row — last item in typeahead
      const anyLocClicked = await page.evaluate((q) => {
        const allEls = document.querySelectorAll('li, a, div[ng-click], span[ng-click], [role="option"]');
        for (const el of allEls) {
          const txt = el.textContent?.trim() || '';
          if (txt.includes('any location') || txt.toLowerCase().startsWith(q.toLowerCase() + ' (')) {
            el.click();
            return txt;
          }
        }
        // Try clicking the "more" text if visible
        for (const el of allEls) {
          if (el.textContent?.includes('more Healthcare') || el.textContent?.includes('more health')) {
            el.click();
            return el.textContent?.trim();
          }
        }
        return null;
      }, query);

      if (anyLocClicked) {
        console.log('[Aetna] ✓ Clicked typeahead option:', anyLocClicked.substring(0, 60));
      } else {
        console.log('[Aetna] ⚠ No "more" link found. Pressing Enter...');
        await page.keyboard.press('Enter');
      }
    }
  } else {
    console.log('[Aetna] No typeahead visible — pressing Enter');
    await page.keyboard.press('Enter');
  }

  // Wait for results page API
  console.log('[Aetna] Waiting for results API...');
  const body = await apiPromise;

  if (!body) {
    // Try extracting from DOM / Angular scope as fallback
    console.log('[Aetna] No API body — trying Angular scope extraction');
    await page.waitForTimeout(3000);
    const scopeJson = await page.evaluate(() => {
      try {
        const candidates = [
          ...document.querySelectorAll('#providerResults, [ng-controller*="Provider"], [ng-controller*="provider"]')
        ];
        for (const el of candidates) {
          const scope = window.angular?.element(el)?.scope?.();
          if (!scope) continue;
          const ctrl = scope.ctrl || scope;
          for (const k of Object.keys(ctrl).filter(k => !k.startsWith('$'))) {
            const v = ctrl[k];
            if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
              const keys = Object.keys(v[0]).join(',');
              if (/provider|npi|location/i.test(keys)) {
                return JSON.stringify({ providersResponse: { readProvidersResponse: { providerInfoResponses: v.slice(0, 50) } } });
              }
            }
          }
        }
      } catch(e) {}
      return null;
    });
    if (scopeJson) {
      console.log('[Aetna] ✓ Got providers from Angular scope');
      return scopeJson;
    }
  }

  return body;
}

// ── Warm browser: navigate to ASA category page for ZIP ──────────────────────
async function initWarmPage(zip) {
  const t0 = Date.now();
  console.log(`[Aetna] Warming browser for ZIP ${zip}...`);

  const old = _h.browser;
  _h.browser = null; _h.page = null; _h.zip = null;
  if (old) { try { await old.close(); } catch {} }

  const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
  _h.browser = browser;
  browser.on('disconnected', () => {
    if (_h.browser === browser) { _h.browser = null; _h.page = null; _h.zip = null; }
  });

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1024, height: 768 });
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

  await navigateToASACategory(page, zip);

  _h.browser = browser;
  _h.page    = page;
  _h.zip     = zip;
  console.log(`[Aetna] Warm done in ${Date.now() - t0}ms | page on category for ZIP ${zip}`);
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

// ── Ensure warm page is on the category page (not results) ───────────────────
async function ensureCategoryPage(page, zip) {
  const bodyText = await page.evaluate(() => document.body.textContent || '').catch(() => '');
  const onCategory = bodyText.includes('What do you want to search for') ||
                     bodyText.includes('search term') ||
                     bodyText.includes('Medical Doctors');
  if (onCategory) {
    console.log('[Aetna] Already on category page ✓');
    return;
  }
  console.log('[Aetna] Not on category page — re-navigating...');
  await navigateToASACategory(page, zip);
}

// ── Main export ───────────────────────────────────────────────────────────────
async function searchAetna({
  specialty  = 'All Medical Specialists',
  name       = '',
  zip        = '77041',
  maxResults = 25,
} = {}) {
  // Ensure warm page exists
  let page;
  try {
    page = await getWarmPage(zip);
  } catch (e) {
    console.log('[Aetna] Warm-up error:', e.message);
    throw new Error('Aetna warm-up failed: ' + e.message);
  }

  if (!name) {
    // Specialty search: navigate to Medical Doctors category
    return searchBySpecialty(page, specialty, zip, maxResults);
  }

  // Name search
  try {
    // Make sure we're on the category page (not a previous results page)
    await ensureCategoryPage(page, zip);

    const t0 = Date.now();
    const body = await searchNameOnCategoryPage(page, name, zip);
    console.log(`[Aetna] Name search took ${Date.now() - t0}ms | got body: ${!!body}`);

    if (!body) throw new Error('No provider data returned from ASA search');

    const all = parseAetnaBody(body);
    if (!all.length) throw new Error(`0 providers parsed (body: ${body.substring(0, 200)})`);

    const filtered = filterByName(all, name);
    console.log(`[Aetna] ✓ ${all.length} total → ${filtered.length} match "${name}"`);

    // After getting results, we may be on results page — reset on next call
    // Don't re-navigate now; ensureCategoryPage handles it next time
    return dedup(filtered).slice(0, Math.min(maxResults, 10));

  } catch (e) {
    console.log('[Aetna] Name search failed:', e.message);
    // Re-warm from scratch and retry once
    console.log('[Aetna] Re-warming and retrying...');
    try {
      _h.page = null; _h.zip = null;
      page = await initWarmPage(zip);
      const body = await searchNameOnCategoryPage(page, name, zip);
      if (!body) throw new Error('No body on retry');
      const all = parseAetnaBody(body);
      const filtered = filterByName(all, name);
      return dedup(filtered).slice(0, Math.min(maxResults, 10));
    } catch (e2) {
      throw new Error('Aetna search failed after retry: ' + e2.message);
    }
  }
}

// ── Specialty search via category tiles ──────────────────────────────────────
async function searchBySpecialty(page, specialty, zip, maxResults) {
  await ensureCategoryPage(page, zip);

  const apiPromise = makeProviderListener(page, 30000);

  // Click "Medical Doctors & Specialists" tile
  const medDocsClicked = await page.evaluate(() => {
    const els = document.querySelectorAll('a, button, div[ng-click], h3, h4');
    for (const el of els) {
      if (el.textContent?.includes('Medical Doctors') && el.offsetParent) {
        el.click();
        return true;
      }
    }
    return false;
  });
  console.log('[Aetna] Medical Doctors clicked:', medDocsClicked);

  const body = await apiPromise;
  if (!body) throw new Error('No API response from specialty search');

  const all = parseAetnaBody(body);
  // Filter by specialty name
  const specLower = specialty.toLowerCase();
  const filtered = all.filter(p =>
    p.specialty.toLowerCase().includes(specLower) ||
    p.providerType.toLowerCase().includes(specLower) ||
    specLower.includes('all')
  );
  return dedup(filtered.length ? filtered : all).slice(0, maxResults);
}

module.exports = searchAetna;
