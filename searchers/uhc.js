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

    // Collect all GraphQL responses that contain providers (ProviderSearch OR name search queries)
    page.on('response', async res => {
      const url = res.url();
      if (url.includes('graphql')) console.log(`[UHC] GraphQL hit: ${url.substring(0, 120)}`);
      if (!url.includes('findcare.guest.uhc.com/api/graphql')) return;
      try {
        const body = await res.json();
        // ProviderSearch (specialty) — providers array
        const bySpecialty = body?.data?.providerSearch?.providers;
        if (Array.isArray(bySpecialty) && bySpecialty.length > 0) {
          console.log(`[UHC] Captured ${bySpecialty.length} providers from ProviderSearch`);
          providerBatches.push(bySpecialty);
          return;
        }
        // Name search may use a different query key — scan all data keys
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

    // Step 6: Handle autocomplete dropdown
    await page.waitForSelector('[role="option"]', { timeout: 8000 }).catch(() => {});
    const options = await page.locator('[role="option"]').all();
    console.log(`[UHC] Autocomplete options found: ${options.length}`);

    let clicked = false;
    if (options.length > 0) {
      if (isNameSearch) {
        // For name search: look for an option that contains the name text
        // (as opposed to specialty/condition options which show category labels)
        const nameLower = searchTerm.toLowerCase();
        for (const opt of options) {
          const text = (await opt.textContent().catch(() => '')) || '';
          const textLower = text.toLowerCase();
          // Skip options that look like specialty categories
          if (/specialist|condition|specialty|all providers/i.test(text)) continue;
          // Prefer options that include parts of the typed name
          const parts = nameLower.split(/\s+/).filter(p => p.length > 2);
          if (parts.some(p => textLower.includes(p))) {
            const elHandle = await opt.elementHandle().catch(() => null);
            if (elHandle) await page.evaluate(el => el.click(), elHandle).catch(() => {});
            else await page.keyboard.press('Enter');
            clicked = true;
            console.log(`[UHC] Name option clicked: ${text.substring(0, 60)}`);
            break;
          }
        }
        // If no good name match, try the first option or press Enter
        if (!clicked) {
          const firstOpt = options[0];
          const firstText = (await firstOpt.textContent().catch(() => '')) || '';
          // If first option is a "search by name" or "provider" option, use it
          if (/provider|doctor|name|search for/i.test(firstText) || options.length === 1) {
            const elHandle = await firstOpt.elementHandle().catch(() => null);
            if (elHandle) await page.evaluate(el => el.click(), elHandle).catch(() => {});
            else await page.keyboard.press('Enter');
            clicked = true;
            console.log(`[UHC] Clicked first option for name search: ${firstText.substring(0, 60)}`);
          } else {
            // Press Enter to submit name search directly
            await page.keyboard.press('Enter');
            clicked = true;
            console.log(`[UHC] Pressed Enter for name search (no matching option found)`);
          }
        }
      } else {
        // For specialty search: click the first option (specialty/condition suggestion)
        const firstText = (await options[0].textContent().catch(() => '')) || '';
        const elHandle = await options[0].elementHandle().catch(() => null);
        if (elHandle) await page.evaluate(el => el.click(), elHandle).catch(() => {});
        else await page.keyboard.press('Enter');
        clicked = true;
        console.log(`[UHC] Specialty option clicked: ${firstText.substring(0, 60)}`);
      }
    } else {
      await page.keyboard.press('Enter');
      clicked = true;
      console.log(`[UHC] No autocomplete options; pressed Enter`);
    }

    await page.waitForTimeout(500);

    // Step 7: Click Search button if present
    const searchBtnFound = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent?.trim().toLowerCase() === 'search' && b.offsetParent !== null
      );
      if (btn) { btn.click(); return true; }
      return false;
    });
    console.log(`[UHC] Search button clicked: ${searchBtnFound}`);

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

module.exports = searchUHC;
