// searchers/uhc.js
// UHC Choice Plus provider search — supports specialty AND name search
// Patches lat/lon from ZIP so Railway's CA IP doesn't skew results

const https = require('https');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

// Choice Plus Network deeplink (reciprocityId 10188)
const CHOICE_PLUS_DEEPLINK =
  'eyJsYW5ndWFnZSI6ImVuLVVTIiwibG9iIjoiRUkiLCJjb3ZlcmFnZVR5cGUiOiJNIiwicmVjaXByb2NpdHlJZCI6IjEwMTg4IiwicGxhbk5hbWUiOiJDaG9pY2UgUGx1cyBOZXR3b3JrIiwicG9ydGFsIjoicHN4In0=';

// Convert ZIP to lat/lon using free zippopotam.us API (no key required)
function zipToLatLon(zip) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.zippopotam.us/us/${zip}`, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const place = json.places?.[0];
          if (!place) return reject(new Error(`ZIP ${zip} not found`));
          resolve({
            latitude: place.latitude,
            longitude: place.longitude,
            stateCode: place['state abbreviation'],
          });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/**
 * @param {object} opts
 * @param {string} [opts.specialty]  - e.g. "Cardiologist" (search by specialty/condition)
 * @param {string} [opts.name]       - e.g. "Dr. Smith" or "John Smith" (search by provider name)
 * @param {string} [opts.zip]        - 5-digit ZIP code
 * @param {number} [opts.maxResults]
 */
async function searchUHC({ specialty, name, zip = '77041', maxResults = 50 } = {}) {
  const searchTerm = name ? name.trim() : (specialty || 'Primary Care').trim();
  const isNameSearch = !!name;

  // Resolve ZIP → lat/lon before launching browser
  let geoData;
  try {
    geoData = await zipToLatLon(zip);
    console.log(`[UHC] ZIP ${zip} → lat:${geoData.latitude} lon:${geoData.longitude} state:${geoData.stateCode}`);
  } catch (e) {
    console.warn(`[UHC] Geocode failed for ${zip}: ${e.message} — proceeding without patch`);
    geoData = null;
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    const providerBatches = [];

    // Intercept GraphQL ProviderSearch requests and patch lat/lon/state to match requested ZIP
    await page.route('**graphql**', async route => {
      const request = route.request();
      if (!request.url().includes('ProviderSearch') || !geoData) {
        return route.continue();
      }
      try {
        const body = request.postDataJSON();
        if (body?.variables) {
          const v = body.variables;
          if (v.latitude !== undefined)  v.latitude  = geoData.latitude;
          if (v.longitude !== undefined) v.longitude = geoData.longitude;
          if (v.stateCode !== undefined) v.stateCode = geoData.stateCode;
          if (v.searchLocation) {
            v.searchLocation.latitude  = geoData.latitude;
            v.searchLocation.longitude = geoData.longitude;
          }
          if (typeof v.uniqueSearch === 'string') {
            v.uniqueSearch = v.uniqueSearch.replace(
              /suggestion-[\d.-]+-[\d.-]+/,
              `suggestion-${geoData.latitude}-${geoData.longitude}`
            );
          }
          console.log(`[UHC] Patched lat/lon → ${geoData.latitude}, ${geoData.longitude}`);
        }
        await route.continue({ postData: JSON.stringify(body) });
      } catch (e) {
        console.log('[UHC] Route patch error:', e.message);
        route.continue();
      }
    });

    // Collect GraphQL responses: ProviderSearch (specialty) AND AutoComplete (name search)
    page.on('response', async res => {
      const url = res.url();
      if (url.includes('graphql')) console.log(`[UHC] GraphQL hit: ${url.substring(0, 120)}`);
      if (!url.includes('findcare.guest.uhc.com/api/graphql')) return;
      try {
        const body = await res.json();

        // ProviderSearch (specialty) — standard providers array
        const bySpecialty = body?.data?.providerSearch?.providers;
        if (Array.isArray(bySpecialty) && bySpecialty.length > 0) {
          console.log(`[UHC] Captured ${bySpecialty.length} providers from ProviderSearch`);
          providerBatches.push(bySpecialty);
          return;
        }

        // AutoComplete response — for name search, extract provider suggestions
        if (isNameSearch && url.includes('q=AutoComplete')) {
          // Log full body to understand structure
          console.log(`[UHC] AutoComplete body keys: ${JSON.stringify(Object.keys(body?.data || {}))}`);
          console.log(`[UHC] AutoComplete raw: ${JSON.stringify(body?.data).substring(0, 600)}`);

          // Try every known path for autocomplete suggestions
          const ac = body?.data?.autoComplete;
          const candidates = [
            ac,
            ac?.suggestions,
            ac?.searchSuggestions,
            ac?.results,
            ac?.providers,
            ac?.items,
            body?.data?.suggestions,
            body?.data?.providers,
          ];

          let list = null;
          for (const c of candidates) {
            if (Array.isArray(c) && c.length > 0) { list = c; break; }
          }

          // If ac itself is an object with sub-arrays, find first array
          if (!list && ac && typeof ac === 'object') {
            for (const k of Object.keys(ac)) {
              if (Array.isArray(ac[k]) && ac[k].length > 0) { list = ac[k]; break; }
            }
          }

          if (list && list.length > 0) {
            console.log(`[UHC] AutoComplete raw sample: ${JSON.stringify(list[0]).substring(0, 300)}`);
            const providerSuggestions = list.filter(s =>
              s?.type === 'PROVIDER' || s?.providerName || s?.npi ||
              s?.suggestionType === 'PROVIDER' || /provider/i.test(s?.type || '') ||
              s?.displayText || s?.name
            );
            console.log(`[UHC] AutoComplete providers found: ${providerSuggestions.length} of ${list.length}`);
            if (providerSuggestions.length > 0) {
              const normalized = providerSuggestions.map(s => ({
                providerName: s.providerName || s.displayText || s.name || s.text || s.label || '',
                npi: s.npi || s.nationalProviderId || '',
                providerId: s.providerId || s.id || '',
                locationId: s.locationId || '',
                providerType: s.providerType || s.type || '',
                speciality: s.specialty || s.speciality || '',
                specialities: s.specialties || s.specialities || [],
                address: s.address || {},
                phones: s.phones || {},
                distance: s.distance,
                latitude: s.latitude,
                longitude: s.longitude,
                acceptingNewPatients: s.acceptingNewPatients,
                networkStatus: s.networkStatus || 'INN',
                virtualIndicator: s.virtualCare ? 'Y' : 'N',
              }));
              providerBatches.push(normalized);
            }
          } else {
            console.log(`[UHC] AutoComplete: no list found — full body: ${JSON.stringify(body).substring(0, 400)}`);
          }
          return;
        }

        // Fallback: scan all data keys for any providers array
        const data = body?.data;
        if (data) {
          for (const key of Object.keys(data)) {
            const val = data[key];
            const arr = val?.providers || val?.providerList || (Array.isArray(val) ? val : null);
            if (Array.isArray(arr) && arr.length > 0 && arr[0]?.providerName) {
              console.log(`[UHC] Captured ${arr.length} providers from query key: ${key}`);
              providerBatches.push(arr);
              return;
            }
          }
        }
      } catch {}
    });

    // Step 1: Establish guest session (required before find-care URL works)
    await page.goto(
      'https://findcare.guest.uhc.com/guest-plan-selection/',
      { waitUntil: 'domcontentloaded', timeout: 25000 }
    ).catch(() => {});
    await page.waitForTimeout(2000);

    // Step 2: Navigate directly to find-care with ZIP (proven working URL)
    await page.goto(
      `https://findcare.guest.uhc.com/find-care?plan=s00001&zip=${encodeURIComponent(zip)}`,
      { waitUntil: 'domcontentloaded', timeout: 40000 }
    ).catch(() => {});
    await page.waitForTimeout(4000);
    console.log(`[UHC] find-care loaded: ${page.url()}`);

    // Step 3: Dismiss modal if present
    await page.evaluate(() => {
      const selectors = [
        'button[aria-label="close"]', 'button[aria-label="Close"]',
        '[data-testid="modal-close"]', '[aria-label="Close dialog"]',
        '.abyss-icon-button',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) { el.click(); return; }
      }
    });
    await page.waitForTimeout(1000);

    // Step 4: Find search combobox (avoid ZIP/location fields)
    await page.waitForSelector('input[role="combobox"]', { timeout: 20000 }).catch(() => {});

    const allComboboxes = await page.locator('input[role="combobox"]').all();
    let searchInput = null;

    for (const cb of allComboboxes) {
      const visible = await cb.isVisible().catch(() => false);
      if (!visible) continue;
      const ph = await cb.getAttribute('placeholder').catch(() => '') || '';
      const al = await cb.getAttribute('aria-label').catch(() => '') || '';
      if (ph.match(/zip|city|location|address/i) || al.match(/zip|city|location|address/i)) continue;
      searchInput = cb;
      break;
    }

    if (!searchInput) {
      const inputs = await page.locator('input[type="text"], input:not([type])').all();
      for (const inp of inputs) {
        const visible = await inp.isVisible().catch(() => false);
        if (!visible) continue;
        const ph = await inp.getAttribute('placeholder').catch(() => '') || '';
        if (ph.match(/zip|city|location|address/i)) continue;
        if (ph.match(/name|specialty|doctor|provider|search/i) || ph.length > 0) {
          searchInput = inp;
          break;
        }
      }
    }

    if (!searchInput) {
      throw new Error('UHC: could not find search input');
    }
    const inputPh = await searchInput.getAttribute('placeholder').catch(() => '') || '';
    const inputAl = await searchInput.getAttribute('aria-label').catch(() => '') || '';
    console.log(`[UHC] Search input found — placeholder:"${inputPh}" aria:"${inputAl}"`);

    // Step 5: Type search term and wait for GraphQL response
    const searchDone = new Promise(resolve => {
      setTimeout(resolve, 25000);
      const check = setInterval(() => {
        if (providerBatches.length > 0) { clearInterval(check); setTimeout(resolve, 2000); }
      }, 200);
    });

    // Use JS click + focus to bypass any overlay intercepting pointer events
    await page.evaluate(el => { el.click(); el.focus(); }, await searchInput.elementHandle());
    await page.waitForTimeout(300);
    await page.keyboard.type(searchTerm, { delay: 80 });
    await page.waitForTimeout(1500);

    // Step 6: Handle autocomplete dropdown via keyboard navigation
    // ArrowDown/Enter trigger React's synthetic handlers properly unlike JS el.click()
    await page.waitForSelector('[role="option"]', { timeout: 8000 }).catch(() => {});
    const options = await page.locator('[role="option"]').all();
    console.log(`[UHC] Autocomplete options found: ${options.length}`);

    if (options.length > 0) {
      if (isNameSearch) {
        // For name search: log the available options, then submit directly with Enter.
        // Picking an autocomplete option for a name navigates to one specific provider's
        // profile page rather than a ProviderSearch list, so we bypass the dropdown.
        for (let i = 0; i < Math.min(options.length, 5); i++) {
          const text = (await options[i].textContent().catch(() => '')) || '';
          console.log(`[UHC] Name autocomplete option ${i}: ${text.substring(0, 80)}`);
        }
        await page.keyboard.press('Escape'); // dismiss dropdown
        await page.waitForTimeout(200);
        await page.keyboard.press('Enter'); // submit name as free-text search
        console.log(`[UHC] Name search: dismissed autocomplete, submitted via Enter`);
      } else {
        // Specialty: arrow to first option and select
        const firstText = (await options[0].textContent().catch(() => '')) || '';
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(150);
        await page.keyboard.press('Enter');
        console.log(`[UHC] Specialty option selected via keyboard: ${firstText.substring(0, 60)}`);
      }
    } else {
      await page.keyboard.press('Enter');
      console.log(`[UHC] No autocomplete options; pressed Enter`);
    }

    // Wait for React to process the selection
    await page.waitForTimeout(800);

    // Step 7: Submit the search (button first, then Enter as fallback)
    const searchBtnFound = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => b.textContent?.trim().toLowerCase() === 'search' && b.offsetParent !== null)
        || btns.find(b => /search|find|go/i.test(b.textContent?.trim()) && b.offsetParent !== null && b.type !== 'reset')
        || btns.find(b => b.getAttribute('aria-label') && /search|find/i.test(b.getAttribute('aria-label')) && b.offsetParent !== null);
      if (btn) { btn.click(); return btn.textContent?.trim().substring(0, 30) || 'found'; }
      return null;
    });
    console.log(`[UHC] Search button: ${searchBtnFound}`);
    if (!searchBtnFound) {
      await page.keyboard.press('Enter');
      console.log('[UHC] No search button, pressed Enter to submit');
    }

    await searchDone;
    await page.waitForTimeout(2000);

    // Merge and dedupe providers from all captured GraphQL batches
    const seen = new Set();
    const all = [];
    for (const batch of providerBatches) {
      for (const p of batch) {
        const key = p.providerId + ':' + (p.locationId || '');
        if (!seen.has(key)) { seen.add(key); all.push(p); }
      }
    }

    console.log(`[UHC] Total providers captured: ${all.length}`);

    return all.slice(0, maxResults).map(p => ({
      network: 'UHC Choice Plus',
      name: p.providerName,
      npi: p.npi,
      providerType: p.providerType,
      specialty: p.speciality || p.specialities?.[0]?.value || '',
      specialties: (p.specialities || []).map(s => s.value),
      address: {
        street: (p.address?.line || []).join(', '),
        city: p.address?.city || '',
        state: p.address?.state || '',
        zip: p.address?.postalCode || '',
      },
      phone: p.phones?.phone?.[0] || '',
      distance: parseFloat(p.distance) || null,
      latitude: parseFloat(p.latitude) || null,
      longitude: parseFloat(p.longitude) || null,
      acceptingNewPatients: p.acceptingNewPatients === true,
      virtualVisits: p.virtualIndicator === 'Y',
      inNetwork: p.networkStatus === 'INN',
      smartChoiceScore: p.recommendationDetails?.totalRecommendationScore
        ? parseInt(p.recommendationDetails.totalRecommendationScore)
        : null,
      rating: p.healthGradeRating ? parseFloat(p.healthGradeRating) : null,
      providerId: p.providerId,
      locationId: p.locationId,
    }));

  } finally {
    await browser.close();
  }
}

/**
 * Fast autocomplete — returns provider name suggestions for a partial name.
 * Uses UHC's AutoComplete GraphQL endpoint (no full ProviderSearch needed).
 */
async function suggestUHC({ name, zip = '77041' } = {}) {
  let geoData;
  try { geoData = await zipToLatLon(zip); } catch (e) { geoData = null; }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    let suggestions = [];

    page.on('response', async res => {
      if (!res.url().includes('findcare.guest.uhc.com/api/graphql')) return;
      if (!res.url().includes('q=AutoComplete')) return;
      try {
        const body = await res.json();
        const ac = body?.data?.autoComplete;
        const candidates = [ac, ac?.suggestions, ac?.searchSuggestions, ac?.results, ac?.items, body?.data?.suggestions];
        let list = null;
        for (const c of candidates) {
          if (Array.isArray(c) && c.length > 0) { list = c; break; }
        }
        if (!list && ac && typeof ac === 'object') {
          for (const k of Object.keys(ac)) {
            if (Array.isArray(ac[k]) && ac[k].length > 0) { list = ac[k]; break; }
          }
        }
        if (list) {
          console.log(`[UHC suggest] AutoComplete raw: ${JSON.stringify(list[0]).substring(0, 200)}`);
          suggestions = list.map(s => ({
            providerName: s.providerName || s.displayText || s.name || s.text || s.label || '',
            npi: s.npi || '',
            providerId: s.providerId || s.id || '',
            locationId: s.locationId || '',
            specialty: s.specialty || s.speciality || '',
            type: s.type || s.suggestionType || '',
            address: s.address || {},
          })).filter(s => s.providerName);
        } else {
          console.log(`[UHC suggest] AutoComplete body: ${JSON.stringify(body?.data).substring(0, 400)}`);
        }
      } catch {}
    });

    await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.goto(`https://findcare.guest.uhc.com/find-care?plan=s00001&zip=${encodeURIComponent(zip)}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    await page.evaluate(() => {
      const selectors = ['button[aria-label="close"]','button[aria-label="Close"]','[data-testid="modal-close"]','.abyss-icon-button'];
      for (const sel of selectors) { const el = document.querySelector(sel); if (el && el.offsetParent !== null) { el.click(); return; } }
    });
    await page.waitForTimeout(500);

    await page.waitForSelector('input[role="combobox"]', { timeout: 15000 }).catch(() => {});
    const allComboboxes = await page.locator('input[role="combobox"]').all();
    let searchInput = null;
    for (const cb of allComboboxes) {
      const visible = await cb.isVisible().catch(() => false);
      if (!visible) continue;
      const ph = await cb.getAttribute('placeholder').catch(() => '') || '';
      if (ph.match(/zip|city|location|address/i)) continue;
      searchInput = cb; break;
    }
    if (!searchInput) throw new Error('UHC suggest: no search input found');

    await page.evaluate(el => { el.click(); el.focus(); }, await searchInput.elementHandle());
    await page.waitForTimeout(200);
    await page.keyboard.type(name, { delay: 80 });

    // Wait up to 6s for AutoComplete response
    await page.waitForTimeout(6000);

    console.log(`[UHC suggest] Returning ${suggestions.length} suggestions for "${name}"`);
    return suggestions;
  } finally {
    await browser.close();
  }
}

module.exports = searchUHC;
module.exports.suggest = suggestUHC;
