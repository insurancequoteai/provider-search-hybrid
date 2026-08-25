// searchers/aetna.js
//
// ASA (Aetna Signature Administrators) flow:
//   1. Navigate to ASA landing → wait for input → enter ZIP → Search → category page
//   2. Type doctor name → typeahead dropdown appears with multiple providers
//   3. Click "X more Healthcare Providers" link → full results page
//   4a. Capture publicdse_providersearch API response  (if it fires)
//   4b. OR extract provider data from results page DOM / Angular scope
//   4c. OR parse provider names directly from typeahead dropdown items
//   5. Filter by name, dedup, return
//
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const ASA_URL      = 'https://www.aetna.com/dsepublic/#/contentPage?page=providerSearch&site_id=asa&language=en';
const NETWORK_NAME = 'Aetna Signature Administrators';

// ── Warm-page cache ───────────────────────────────────────────────────────────
const _h = { browser: null, page: null, zip: null, initPromise: null };

// ── Helpers ───────────────────────────────────────────────────────────────────
const decodeHtml = s => (s || '')
  .replace(/&#38;/g,'&').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');

function parseAetnaBody(body) {
  try {
    const data = JSON.parse(body);
    const raw  = data?.providersResponse?.readProvidersResponse?.providerInfoResponses;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
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
  } catch(e) { console.log('[Aetna] parseBody error:', e.message); return []; }
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
  let out = providers.filter(p => words.every(w => p.name.toLowerCase().includes(w)));
  if (!out.length) out = providers.filter(p => words.some(w => p.name.toLowerCase().includes(w)));
  return out.length ? out : providers;
}

// Parse "Ian Smith MD - Houston, TX" style entries from typeahead dropdown
function parseTypeaheadText(items) {
  return items.map(text => {
    // Format: "Name Credential - City, ST" or "Name - City, ST"
    const m = text.match(/^(.+?)\s*-\s*([^,]+),\s*([A-Z]{2})$/);
    if (!m) return null;
    const fullName = m[1].trim();
    const city     = m[2].trim();
    const state    = m[3];
    // Extract credential from end of name (MD, DO, MA, MC, etc.)
    const credMatch = fullName.match(/\s+(MD|DO|MA|MC|NP|PA|APRN|LSW|LCSW|DMD|DDS|DC|PT|OD|PMHNP|CNM)$/i);
    const name      = credMatch ? fullName.slice(0, -credMatch[0].length).trim() : fullName;
    const cred      = credMatch ? credMatch[1].toUpperCase() : '';
    return {
      network: NETWORK_NAME,
      name: fullName,
      npi: '',
      providerType: cred ? 'Individual' : '',
      specialty: cred,
      address: { street: '', city, state, zip: '' },
      phone: '',
      distance: null,
      acceptingNewPatients: false,
      virtualVisits: false,
      inNetwork: true,
      providerId: '',
      locationId: `typeahead|${fullName}|${city}|${state}`,
    };
  }).filter(Boolean);
}

const BROWSER_ARGS = [
  '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu',
  '--no-first-run','--no-zygote','--disable-background-networking',
  '--disable-default-apps','--disable-sync','--disable-translate','--mute-audio',
  '--disable-extensions','--disable-component-update','--safebrowsing-disable-auto-update',
];

// ── Broad listener: catches ANY aetna.com JSON response with provider data ────
function makeBroadListener(pg, timeoutMs) {
  return new Promise(resolve => {
    const t = setTimeout(() => { pg.off('response', h); resolve(null); }, timeoutMs);
    const h = async res => {
      const url = res.url();
      if (!url.includes('aetna.com')) return;
      if (/\.(js|css|png|jpg|gif|ico|svg|woff|ttf|html)(\?|$)/i.test(url)) return;
      const status = res.status();
      if (status >= 400) return;
      try {
        const body = await res.text();
        if (!body || body.length < 100) return;
        if (!body.trimStart().startsWith('{') && !body.trimStart().startsWith('[')) return;
        const ep = url.split('/').pop()?.split('?')[0] || '';
        console.log('[Aetna] Response:', status, ep, '| len:', body.length, '| prefix:', body.substring(0, 100));
        if (body.includes('"statusCode":"3000"')) return; // skip errors
        if (body.includes('providerInfoResponses') || body.includes('providerDisplayName')) {
          clearTimeout(t); pg.off('response', h);
          console.log('[Aetna] ✓ Provider JSON from:', ep);
          resolve(body);
        }
      } catch(e) {}
    };
    pg.on('response', h);
  });
}

// ── Navigate to ASA landing, enter ZIP, reach category page ──────────────────
async function navigateToASACategory(page, zip) {
  console.log('[Aetna] Navigating to ASA for ZIP', zip);
  await page.goto(ASA_URL, { waitUntil: 'domcontentloaded', timeout: 35000 });

  // WAIT for the location input to actually appear (Angular needs time to boot)
  const locSel = 'input[placeholder*="location" i], input[placeholder*="zip" i], input[placeholder*="Enter" i]';
  console.log('[Aetna] Waiting for location input...');
  await page.waitForSelector(locSel, { timeout: 20000 }).catch(e =>
    console.log('[Aetna] Location input wait failed:', e.message)
  );
  await page.waitForTimeout(400);

  const locEl = page.locator(locSel).first();
  if (await locEl.count().catch(() => 0) > 0) {
    await locEl.click({ clickCount: 3 });
    await locEl.fill(zip);
    await page.evaluate(s => {
      const el = document.querySelector(s);
      if (el) {
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '1' }));
      }
    }, locSel);
    await page.waitForTimeout(350);
    console.log('[Aetna] ZIP', zip, 'entered');
  } else {
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(el => ({
        id: el.id, placeholder: el.placeholder, ng: el.getAttribute('ng-model')
      }))
    );
    console.log('[Aetna] ⚠ No location input. Inputs:', JSON.stringify(inputs).substring(0, 300));
  }

  // Click Search
  const searchBtn = page.locator('button:has-text("Search"), button[type="submit"]').first();
  if (await searchBtn.count().catch(() => 0) > 0) {
    await searchBtn.click();
    console.log('[Aetna] Clicked Search');
  } else {
    await page.keyboard.press('Enter');
    console.log('[Aetna] Enter pressed');
  }

  // Wait for category page ("What do you want to search for" or "search term")
  await page.waitForFunction(
    () => document.body.textContent?.includes('What do you want to search for') ||
          document.body.textContent?.includes('search term') ||
          document.body.textContent?.includes('Medical Doctors'),
    { timeout: 20000 }
  ).catch(() => console.log('[Aetna] Category page wait timed out — proceeding'));

  await page.waitForTimeout(500);
  console.log('[Aetna] Category page URL:', page.url().substring(0, 120));
}

// ── Check if we're on the category page with a search box ────────────────────
async function isOnCategoryPage(page) {
  try {
    const text = await page.evaluate(() => document.body.textContent || '');
    return text.includes('What do you want to search for') ||
           text.includes('search term') ||
           text.includes('Medical Doctors');
  } catch { return false; }
}

// ── Extract providers from the results page DOM / Angular scope ───────────────
async function extractFromResultsPage(page) {
  return page.evaluate(() => {
    try {
      // Method 1: Angular scope on results controller
      const candidates = [
        ...document.querySelectorAll(
          '#providerResults, [ng-controller*="Provider"], [ng-controller*="provider"], ' +
          '[ng-controller*="Result"], [ng-controller*="result"]'
        )
      ];
      for (const el of candidates) {
        const scope = window.angular?.element(el)?.scope?.();
        if (!scope) continue;
        const ctrl = scope.ctrl || scope;
        const keys = Object.keys(ctrl).filter(k => !k.startsWith('$'));
        for (const k of keys) {
          const v = ctrl[k];
          if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
            const fk = Object.keys(v[0]).join(',');
            if (/provider|npi|location|specialty|address/i.test(fk)) {
              console.log('[Aetna] Found scope data key:', k, 'len:', v.length);
              return JSON.stringify({
                providersResponse: { readProvidersResponse: { providerInfoResponses: v.slice(0, 50) } }
              });
            }
          }
        }
      }

      // Method 2: ng-repeat provider cards
      const cards = document.querySelectorAll(
        '[ng-repeat*="provider"], [ng-repeat*="Provider"], .provider-card, .provider-result'
      );
      if (cards.length > 0) {
        const items = Array.from(cards).map(c => c.textContent?.trim()).filter(Boolean);
        console.log('[Aetna] Found', cards.length, 'provider card elements');
        return JSON.stringify({ typeaheadItems: items.slice(0, 20) });
      }

      // Method 3: Scan ALL <a> and <li> elements for "Name - City, ST" patterns
      // The ASA results page renders each provider as a clickable link
      const allEls = document.querySelectorAll('a, li, h2, h3, h4, span[class], div[class]');
      const namePattern = /^(.{3,60})\s*-\s*([A-Za-z\s]+),\s*([A-Z]{2})$/;
      const seen = new Set();
      const found = [];
      for (const el of allEls) {
        if (!el.offsetParent) continue; // skip hidden
        const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
        if (txt.length < 5 || txt.length > 120) continue;
        if (namePattern.test(txt) && !seen.has(txt)) {
          seen.add(txt);
          found.push(txt);
          if (found.length >= 20) break;
        }
      }
      if (found.length > 0) {
        console.log('[Aetna] Found', found.length, 'provider entries via text scan:', JSON.stringify(found).substring(0, 200));
        return JSON.stringify({ typeaheadItems: found });
      }

      return null;
    } catch(e) {
      console.log('[Aetna] DOM extract error:', e.message);
      return null;
    }
  });
}

// ── Extract names from typeahead dropdown ─────────────────────────────────────
async function extractTypeaheadItems(page) {
  return page.evaluate(() => {
    try {
      // Look for the typeahead dropdown list items
      const listItems = document.querySelectorAll('li, [role="option"], .search-result, .result-item');
      const texts = [];
      for (const item of listItems) {
        const t = item.textContent?.trim();
        if (!t) continue;
        if (t.includes('Can\'t find') || t.includes('Healthcare Providers') ||
            t.includes('Traveling?') || t.includes('any location') ||
            t.includes('more Healthcare') || t.length > 100) continue;
        // Must look like "Name - City, ST"
        if (t.includes(' - ') && /,\s*[A-Z]{2}$/.test(t)) {
          texts.push(t);
        }
      }
      return texts;
    } catch(e) { return []; }
  });
}

// ── Main name search on the category page ─────────────────────────────────────
async function searchNameOnCategoryPage(page, name, zip) {
  // Find the search box (screenshots show placeholder "Start typing your search term...")
  const inputSels = [
    'input[ng-model*="typeAhead"]',
    'input[ng-model*="typeahead"]',
    'input[ng-model*="search"]',
    'input[ng-model*="Search"]',
    'input[placeholder*="search term" i]',
    'input[placeholder*="Search" i]',
    'input[type="search"]',
  ];

  let searchInp = null;
  for (const sel of inputSels) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0) > 0) {
      searchInp = el;
      console.log('[Aetna] Search input via:', sel);
      break;
    }
  }

  if (!searchInp) {
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(el => ({
        placeholder: el.placeholder, ng: el.getAttribute('ng-model')
      }))
    );
    throw new Error('No search input on category page. Inputs: ' + JSON.stringify(inputs).substring(0, 200));
  }

  // Set up broad API listener BEFORE typing
  const apiPromise = makeBroadListener(page, 20000);

  // Type the name
  await searchInp.click({ clickCount: 3 });
  await searchInp.fill('');
  const query = name.substring(0, 30);
  await searchInp.type(query, { delay: 80 });
  console.log('[Aetna] Typed:', query);

  // Wait for typeahead dropdown
  const typeaheadReady = await page.waitForFunction(
    () => document.body.textContent?.includes('Healthcare Providers') ||
          document.body.textContent?.includes('more Healthcare') ||
          document.querySelectorAll('li').length > 3,
    { timeout: 10000 }
  ).catch(() => null);

  if (!typeaheadReady) {
    console.log('[Aetna] Typeahead did not appear — trying Enter');
    await page.keyboard.press('Enter');
    const body = await apiPromise;
    return body;
  }

  console.log('[Aetna] Typeahead visible ✓');
  await page.waitForTimeout(400);

  // Scrape typeahead items RIGHT NOW as fallback (before clicking away)
  const typeaheadItems = await extractTypeaheadItems(page);
  console.log('[Aetna] Typeahead items:', typeaheadItems.length, JSON.stringify(typeaheadItems).substring(0, 200));

  // Try to click the "more Healthcare Providers" link
  const moreClicked = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('a, button, span, li'));
    for (const el of els) {
      const txt = el.textContent?.trim() || '';
      if (txt.includes('more Healthcare') || txt.includes('more health')) {
        el.click();
        return 'more:' + txt.substring(0, 60);
      }
    }
    return null;
  });

  if (moreClicked) {
    console.log('[Aetna] Clicked:', moreClicked);
  } else {
    // Log all clickable elements for debugging, then press Enter
    const clickables = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a, button')).filter(e => e.offsetParent)
        .map(e => e.textContent?.trim()).filter(t => t && t.length < 80)
    );
    console.log('[Aetna] No "more" link. Clickables:', JSON.stringify(clickables).substring(0, 300));
    await page.keyboard.press('Enter');
  }

  // Wait for API body up to 15s
  const body = await apiPromise;
  if (body) {
    console.log('[Aetna] ✓ API body captured');
    return { type: 'api', body };
  }

  // No API body — try to extract from results page DOM
  console.log('[Aetna] No API body — waiting for results DOM...');
  await page.waitForTimeout(3000);

  const domResult = await extractFromResultsPage(page);
  if (domResult) {
    try {
      const parsed = JSON.parse(domResult);
      if (parsed.typeaheadItems) {
        return { type: 'typeahead-dom', items: parsed.typeaheadItems };
      }
      console.log('[Aetna] ✓ Got DOM scope result');
      return { type: 'scope', body: domResult };
    } catch {}
  }

  // Fall back to the typeahead items we scraped before clicking
  if (typeaheadItems.length > 0) {
    console.log('[Aetna] Using', typeaheadItems.length, 'typeahead items as fallback');
    return { type: 'typeahead', items: typeaheadItems };
  }

  return null;
}

// ── Warm browser ──────────────────────────────────────────────────────────────
async function initWarmPage(zip) {
  const t0 = Date.now();
  console.log('[Aetna] Warming browser for ZIP', zip);

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
  console.log(`[Aetna] Warm done in ${Date.now() - t0}ms`);
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
  let page = await getWarmPage(zip).catch(e => {
    throw new Error('Aetna warm-up failed: ' + e.message);
  });

  if (!name) {
    return searchBySpecialty(page, specialty, zip, maxResults);
  }

  try {
    // Ensure we're on the category page
    const onCat = await isOnCategoryPage(page);
    if (!onCat) {
      console.log('[Aetna] Not on category page — re-navigating');
      await navigateToASACategory(page, zip);
    }

    const t0 = Date.now();
    const result = await searchNameOnCategoryPage(page, name, zip);
    console.log(`[Aetna] Search done in ${Date.now() - t0}ms | type: ${result?.type || 'null'}`);

    if (!result) throw new Error('No provider data from any method');

    let providers;

    if (result.type === 'api' || result.type === 'scope') {
      providers = parseAetnaBody(result.body);
    } else if (result.type === 'typeahead' || result.type === 'typeahead-dom') {
      providers = parseTypeaheadText(result.items);
    } else if (result.body) {
      providers = parseAetnaBody(result.body);
    }

    if (!providers?.length) throw new Error(`0 providers parsed from type=${result.type}`);

    const filtered = filterByName(providers, name);
    console.log(`[Aetna] ✓ ${providers.length} total → ${filtered.length} match "${name}"`);
    return dedup(filtered).slice(0, Math.min(maxResults, 10));

  } catch(e) {
    console.log('[Aetna] Search failed:', e.message);
    // Re-warm and retry once
    try {
      _h.page = null; _h.zip = null;
      page = await initWarmPage(zip);
      const result = await searchNameOnCategoryPage(page, name, zip);
      if (!result) throw new Error('No data on retry');
      const providers = (result.type === 'typeahead' || result.type === 'typeahead-dom')
        ? parseTypeaheadText(result.items)
        : parseAetnaBody(result.body || '{}');
      const filtered = filterByName(providers, name);
      return dedup(filtered).slice(0, Math.min(maxResults, 10));
    } catch(e2) {
      throw new Error('Aetna failed after retry: ' + e2.message);
    }
  }
}

// ── Map specialty string → ASA category tile text ────────────────────────────
const CATEGORY_MAP = [
  [['urgent care','emergency room','emergenc'],          'Urgent Care'],
  [['walk-in','walk in','walkin'],                       'Walk-In Clinics'],
  [['mental health','psychiatr','psycholog','behavioral','counseling','substance','eap'], 'Mental Health'],
  [['hospital','medical center','skilled nursing','dialysis','surgery center','rehab'], 'Hospitals & Facilities'],
  [['vision','optometrist','optician','contact lens','eye exam'],                       'Vision'],
  [['lab','laboratory','bloodwork','imaging','radiology','diagnostic','sleep center','testing'], 'Labs & Testing'],
  [['chiropractor','acupunct','massage','alternative','dietician','nutritionist'],      'Alternative Medicine'],
  [['hearing aid','prosthetic','wheelchair','durable medical','dme','breast pump'],    'Durable Medical Equipment'],
];

function getASACategory(specialty) {
  const s = (specialty || '').toLowerCase();
  for (const [keywords, tile] of CATEGORY_MAP) {
    if (keywords.some(k => s.includes(k))) return tile;
  }
  return 'Medical Doctors'; // default for any physician/specialist
}

// ── Scrape results page DOM for provider data ─────────────────────────────────
async function scrapeSpecialtyResultsPage(page) {
  return page.evaluate(() => {
    // Provider name links end with " »" on ASA results pages
    const nameLinks = Array.from(document.querySelectorAll('a')).filter(a => {
      const t = (a.textContent || '').trim();
      return t.endsWith('»') && t.length > 5 && t.length < 120;
    });

    return nameLinks.slice(0, 30).map(link => {
      const name = link.textContent.trim().replace(/\s*»\s*$/, '').trim();

      // Walk up to find the row container
      let row = link.closest('tr') || link.closest('td')?.parentElement;
      if (!row) {
        // Try generic container walk-up
        let el = link.parentElement;
        for (let i = 0; i < 6 && el; i++) {
          const t = el.textContent || '';
          if ((t.includes('miles') || t.includes('Specialties')) && t.includes('In Network')) { row = el; break; }
          el = el.parentElement;
        }
      }

      const rowText = row ? (row.textContent || '') : '';
      const distMatch  = rowText.match(/(\d+\.\d+)\s*miles?/);
      const phoneMatch = rowText.match(/\(?(\d{3})\)?[\s.-](\d{3})[\s.-](\d{4})/);
      const specMatch  = rowText.match(/Specialties?:\s*([^\n]{3,120})/i);
      const streetMatch= rowText.match(/(\d+\s+[A-Z][a-zA-Z0-9\s]+(?:St|Ave|Blvd|Dr|Ln|Rd|Way|Pkwy|Fwy|Hwy|NW|NE|SW|SE|Ste)[^,\n]{0,30})/i);
      const cityMatch  = rowText.match(/([A-Za-z\s]{2,30}),\s*([A-Z]{2})\s+(\d{5})/);

      return {
        name,
        inNetwork: rowText.includes('In Network'),
        distance:  distMatch  ? parseFloat(distMatch[1]) : null,
        phone:     phoneMatch ? `(${phoneMatch[1]}) ${phoneMatch[2]}-${phoneMatch[3]}` : '',
        specialty: specMatch  ? specMatch[1].replace(/;.*/, '').trim().substring(0, 80) : '',
        street:    streetMatch? streetMatch[0].trim() : '',
        city:      cityMatch  ? cityMatch[1].trim() : '',
        state:     cityMatch  ? cityMatch[2] : '',
        zip:       cityMatch  ? cityMatch[3] : '',
      };
    }).filter(p => p.name && p.name.length > 3);
  });
}

// ── Specialty search ──────────────────────────────────────────────────────────
async function searchBySpecialty(page, specialty, zip, maxResults) {
  const onCat = await isOnCategoryPage(page);
  if (!onCat) await navigateToASACategory(page, zip);

  const category = getASACategory(specialty);
  console.log(`[Aetna] Specialty "${specialty}" → tile "${category}"`);

  // Set up API listener in parallel (bonus if it fires)
  const apiPromise = makeBroadListener(page, 30000);

  // Use Playwright locator for reliable Angular click
  // Try the exact category first, then "Medical Doctors" as fallback
  const tryLabels = [category, 'Medical Doctors'];
  let clicked = false;
  for (const label of tryLabels) {
    const loc = page.locator(`a, h3, h4, button, [ng-click]`).filter({ hasText: label }).first();
    if (await loc.count().catch(() => 0) > 0) {
      await loc.click({ timeout: 5000 }).catch(() => {});
      console.log(`[Aetna] Clicked tile: ${label}`);
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    console.log('[Aetna] No tile found — pressing Enter');
    await page.keyboard.press('Enter');
  }

  // Step 1: Wait for the category page text to DISAPPEAR (Angular routing started)
  await page.waitForFunction(
    () => !(document.body.textContent || '').includes('What do you want to search for'),
    { timeout: 15000 }
  ).catch(() => console.log('[Aetna] Category page still visible after 15s'));

  // Step 2: Wait for provider links (end with " »") to appear in DOM
  const hasProviders = await page.waitForFunction(
    () => Array.from(document.querySelectorAll('a')).some(a => {
      const t = (a.textContent || '').trim();
      return t.endsWith('»') && t.length > 5 && t.length < 150;
    }),
    { timeout: 35000 }
  ).catch(() => null);

  if (!hasProviders) {
    console.log('[Aetna] Provider links never appeared — dumping body snippet');
    const snippet = await page.evaluate(() =>
      (document.body.textContent || '').replace(/\s+/g, ' ').substring(0, 500)
    ).catch(() => '');
    console.log('[Aetna] Page text:', snippet);
  }

  await page.waitForTimeout(600);

  // Primary: scrape results from DOM
  const domProviders = await scrapeSpecialtyResultsPage(page);
  console.log(`[Aetna] DOM scrape found ${domProviders.length} providers`);

  if (domProviders.length > 0) {
    const normalized = domProviders.map(p => ({
      network:  NETWORK_NAME,
      name:     p.name,
      npi:      '',
      providerType: '',
      specialty: p.specialty,
      address:  { street: p.street, city: p.city, state: p.state, zip: p.zip },
      phone:    p.phone,
      distance: p.distance,
      acceptingNewPatients: false,
      virtualVisits: false,
      inNetwork: p.inNetwork,
      providerId: '',
      locationId: `dom|${p.name}|${p.city}`,
    }));
    return dedup(normalized).slice(0, maxResults);
  }

  // Fallback: API body if it came in
  const body = await Promise.race([
    apiPromise,
    new Promise(r => setTimeout(() => r(null), 5000)),
  ]);
  if (body) {
    console.log('[Aetna] Using API body as fallback for specialty');
    const all = parseAetnaBody(body);
    return dedup(all).slice(0, maxResults);
  }

  throw new Error('No specialty results from DOM or API');
}

module.exports = searchAetna;
