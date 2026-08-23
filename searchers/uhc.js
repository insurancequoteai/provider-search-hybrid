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
 * Returns a sort priority for a specialty string.
 * Higher = shown first. Dental/Vision/Chiropractic sink to the bottom.
 */
function specialtyPriority(spec) {
  if (!spec) return 1;
  const s = spec.toLowerCase();
  // Deprioritize non-medical specialties
  if (/dental|dentist|orthodont|periodont|endodont|prosthodont|oral surgery/i.test(s)) return 0;
  if (/chiropractic|optom|ophthalmol|vision|audiol/i.test(s)) return 1;
  // Prioritize primary care and medical specialists
  if (/hospital|medical center|health system|health network|urgent care|emergency/i.test(s)) return 4;
  if (/family|internal medicine|primary care|general practice|pediatric|geriatric/i.test(s)) return 4;
  if (/cardiol|oncol|neurolog|orthopedic|gastro|pulmonol|endocrinol|nephrol|rheumatol|urolog|dermatol|psychiatr|psycholog/i.test(s)) return 3;
  // Other medical
  if (/medical|physician|nurse|pa |assistant|surgery|surgeon/i.test(s)) return 2;
  return 1;
}

/**
 * Normalize a UHC AutoComplete provData entry to the standard provider shape.
 * AutoComplete fields: displayName, displayAddress (string), locationId, providerId,
 * providerType, speciality (array of {description, providerType, category}).
 */
function normalizeAutoCompleteProvider(p) {
  const spec = Array.isArray(p.speciality) ? p.speciality : [];
  // displayAddress: "8821 Valley View St, Buena Park, Orange County, CA, 90620"
  const addrParts = (p.displayAddress || '').split(',').map(s => s.trim());
  const zip   = addrParts.slice(-1)[0] || '';
  const state = addrParts.slice(-2, -1)[0] || '';
  const city  = addrParts.slice(-3, -2)[0] || '';
  const street = addrParts.slice(0, -3).join(', ');
  return {
    providerName: p.displayName || '',
    npi: p.npi || '',
    providerId: p.providerId || '',
    locationId: p.locationId || '',
    providerType: p.providerType || '',
    speciality: spec[0]?.description || '',
    specialities: spec.map(s => ({ value: s.description })),
    address: { street, city, state, zip },
    phones: p.phones || {},
    distance: parseFloat(p.distance) || null,
    latitude: parseFloat(p.latitude) || null,
    longitude: parseFloat(p.longitude) || null,
    acceptingNewPatients: p.acceptingNewPatients === true,
    networkStatus: 'INN',
    virtualIndicator: 'N',
  };
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
    let paginatedResolved = false; // set true when GetCareTeamPaginated is captured

    // Intercept GraphQL requests and patch lat/lon/state to match requested ZIP
    await page.route('**graphql**', async route => {
      const request = route.request();
      if (!geoData) return route.continue();
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

        // AutoComplete response — for name search, extract provider/facility suggestions
        // Structure: body.data.autoComplete.practitioners_uhc.provData[]
        //            body.data.autoComplete.facilities_uhc.provData[]
        if (isNameSearch && url.includes('q=AutoComplete')) {
          const ac = body?.data?.autoComplete;
          const combined = [];

          // Practitioners
          const provData = ac?.practitioners_uhc?.provData;
          if (Array.isArray(provData) && provData.length > 0) {
            console.log(`[UHC] AutoComplete practitioners: ${provData.length}`);
            combined.push(...provData.map(p => normalizeAutoCompleteProvider(p)));
          }

          // Facilities / hospitals — check all keys ending in _uhc for provData
          if (ac && typeof ac === 'object') {
            for (const key of Object.keys(ac)) {
              if (key === 'practitioners_uhc' || key === 'lang_provider') continue;
              const facData = ac[key]?.provData;
              if (Array.isArray(facData) && facData.length > 0) {
                console.log(`[UHC] AutoComplete ${key}: ${facData.length}`);
                combined.push(...facData.map(p => normalizeAutoCompleteProvider(p)));
              }
            }
          }

          if (combined.length > 0) providerBatches.push(combined);
          return;
        }

        // GetCareTeamPaginated — fires after name free-text Enter; contains full provider list
        if (isNameSearch && url.includes('q=GetCareTeamPaginated')) {
          const data = body?.data;
          if (data) {
            // Try known paths
            const section = data.getCareTeamPaginated || data.careTeam || data.providerSearch;
            if (section) {
              const providers = section.providers || section.providerList;
              if (Array.isArray(providers) && providers.length > 0) {
                console.log(`[UHC] GetCareTeamPaginated: ${providers.length} providers`);
                providerBatches.push(providers);
                paginatedResolved = true;
                return;
              }
            }
            // Fallback: scan all keys for a providers array
            for (const key of Object.keys(data)) {
              const val = data[key];
              const arr = val?.providers || val?.providerList;
              if (Array.isArray(arr) && arr.length > 0) {
                console.log(`[UHC] GetCareTeamPaginated via "${key}": ${arr.length} providers`);
                providerBatches.push(arr);
                paginatedResolved = true;
                return;
              }
            }
            // Deep scan: log structure so we can fix it, and try any array with 2+ items
            const section = data.getCareTeamPaginated || data.careTeam || data.providerSearch || {};
            const sectionKeys = Object.keys(section);
            console.log(`[UHC] GetCareTeamPaginated inner keys: ${sectionKeys.join(', ')}`);
            for (const k of sectionKeys) {
              const v = section[k];
              if (Array.isArray(v) && v.length > 0) {
                console.log(`[UHC] GetCareTeamPaginated found array at "${k}": ${v.length} items, first keys: ${Object.keys(v[0] || {}).slice(0, 6).join(', ')}`);
                if (v[0]?.providerName || v[0]?.displayName || v[0]?.npi) {
                  providerBatches.push(v);
                  paginatedResolved = true;
                  return;
                }
              }
            }
            console.log(`[UHC] GetCareTeamPaginated: still unmatched. data keys: ${Object.keys(data).join(', ')}`);
          }
          paginatedResolved = true; // mark done even if empty so we don't hang
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
        // Wait up to 12s for GetCareTeamPaginated to fire and be captured
        await new Promise(resolve => {
          const t = setTimeout(resolve, 12000);
          const iv = setInterval(() => { if (paginatedResolved) { clearInterval(iv); clearTimeout(t); resolve(); } }, 200);
        });
        console.log(`[UHC] GetCareTeamPaginated wait done. paginatedResolved=${paginatedResolved}`);
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

    // For name searches: filter out dental (separate UHC product, not Choice Plus medical)
    // For specialty searches: keep all, just sort medical first
    let filtered = all;
    if (isNameSearch) {
      const nonDental = all.filter(p => {
        const spec = (p.speciality || p.specialities?.[0]?.value || '').toLowerCase();
        return !/dental|dentist|orthodont|periodont|endodont|prosthodont|oral surgery/i.test(spec);
      });
      filtered = nonDental.length > 0 ? nonDental : all; // fallback to all if nothing else
    }

    filtered.sort((a, b) => {
      const sa = a.speciality || a.specialities?.[0]?.value || '';
      const sb = b.speciality || b.specialities?.[0]?.value || '';
      return specialtyPriority(sb) - specialtyPriority(sa);
    });

    return filtered.slice(0, maxResults).map(p => ({
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

    // Patch AutoComplete requests to use the correct ZIP lat/lon
    await page.route('**graphql**', async route => {
      const request = route.request();
      if (!geoData) return route.continue();
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
          await route.continue({ postData: JSON.stringify(body) });
          return;
        }
      } catch {}
      route.continue();
    });

    page.on('response', async res => {
      if (!res.url().includes('findcare.guest.uhc.com/api/graphql')) return;
      if (!res.url().includes('q=AutoComplete')) return;
      try {
        const body = await res.json();
        const ac = body?.data?.autoComplete;
        const combined = [];

        const provData = ac?.practitioners_uhc?.provData;
        if (Array.isArray(provData)) combined.push(...provData);

        if (ac && typeof ac === 'object') {
          for (const key of Object.keys(ac)) {
            if (key === 'practitioners_uhc' || key === 'lang_provider') continue;
            const facData = ac[key]?.provData;
            if (Array.isArray(facData) && facData.length > 0) combined.push(...facData);
          }
        }

        if (combined.length > 0) {
          console.log(`[UHC suggest] total entries found: ${combined.length} for "${name}"`);
          suggestions = combined.map(p => {
            const norm = normalizeAutoCompleteProvider(p);
            return {
              providerName: norm.providerName,
              npi: norm.npi,
              providerId: norm.providerId,
              locationId: norm.locationId,
              specialty: norm.speciality,
              address: norm.address,
            };
          }).filter(s => s.providerName);
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

    // Wait up to 6s for AutoComplete response (page may have closed if request was cancelled)
    await page.waitForTimeout(6000).catch(() => {});

    // Filter out dental from suggestions (separate product, not medical Choice Plus)
    const nonDental = suggestions.filter(s =>
      !/dental|dentist|orthodont|periodont|endodont|prosthodont|oral surgery/i.test(s.specialty || '')
    );
    const finalSuggestions = nonDental.length > 0 ? nonDental : suggestions;
    finalSuggestions.sort((a, b) => specialtyPriority(b.specialty) - specialtyPriority(a.specialty));
    console.log(`[UHC suggest] Returning ${finalSuggestions.length} suggestions for "${name}" (${suggestions.length - finalSuggestions.length} dental filtered)`);
    return finalSuggestions;
  } finally {
    await browser.close();
  }
}

module.exports = searchUHC;
module.exports.suggest = suggestUHC;
