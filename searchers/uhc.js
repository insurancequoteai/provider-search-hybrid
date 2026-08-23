// searchers/uhc.js
// UHC Choice Plus provider search — patches lat/lon from ZIP in GraphQL request

const https = require('https');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

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

async function searchUHC({ specialty = 'Cardiologist', zip = '77041', maxResults = 50 } = {}) {
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
          // Patch location fields
          if (v.latitude !== undefined)  v.latitude  = geoData.latitude;
          if (v.longitude !== undefined) v.longitude = geoData.longitude;
          if (v.stateCode !== undefined) v.stateCode = geoData.stateCode;
          // Patch nested searchLocation if present
          if (v.searchLocation) {
            v.searchLocation.latitude  = geoData.latitude;
            v.searchLocation.longitude = geoData.longitude;
          }
          // Patch uniqueSearch (contains old coords)
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

    // Collect all ProviderSearch GraphQL responses
    page.on('response', async res => {
      const url = res.url();
      if (url.includes('findcare.guest.uhc.com/api/graphql') && url.includes('q=ProviderSearch')) {
        try {
          const body = await res.json();
          const providers = body?.data?.providerSearch?.providers;
          if (Array.isArray(providers) && providers.length > 0) {
            providerBatches.push(providers);
          }
        } catch {}
      }
    });

    // Step 1: Establish guest session
    try {
      await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', {
        waitUntil: 'domcontentloaded', timeout: 20000,
      });
      await page.waitForTimeout(2000);
    } catch {}

    // Step 2: Navigate to find-care with zip
    await page.goto(
      `https://findcare.guest.uhc.com/find-care?plan=s00001&zip=${encodeURIComponent(zip)}`,
      { waitUntil: 'domcontentloaded', timeout: 40000 }
    );
    await page.waitForTimeout(4000);

    // Step 3: Dismiss any modal
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
      document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]').forEach(d => {
        const btn = Array.from(d.querySelectorAll('button')).find(b =>
          b.getAttribute('aria-label')?.toLowerCase().includes('close') ||
          b.textContent?.toLowerCase().trim() === 'close'
        );
        if (btn) btn.click();
      });
    });
    await page.waitForTimeout(1000);

    // Step 4: Wait for specialty input
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
      throw new Error('UHC: could not find specialty search input');
    }

    // Step 5: Type specialty and wait for GraphQL response
    const searchDone = new Promise(resolve => {
      setTimeout(resolve, 25000);
      const check = setInterval(() => {
        if (providerBatches.length > 0) { clearInterval(check); setTimeout(resolve, 2000); }
      }, 200);
    });

    await searchInput.click();
    await searchInput.type(specialty, { delay: 80 });
    await page.waitForTimeout(1500);

    await page.waitForSelector('[role="option"]', { timeout: 8000 }).catch(() => {});
    const firstOption = page.locator('[role="option"]').first();
    if (await firstOption.count() > 0) {
      await firstOption.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent?.trim().toLowerCase() === 'search' && b.offsetParent !== null
      );
      if (btn) btn.click();
    });

    await searchDone;
    await page.waitForTimeout(2000);

    // Merge and dedupe
    const seen = new Set();
    const all = [];
    for (const batch of providerBatches) {
      for (const p of batch) {
        const key = p.providerId + ':' + (p.locationId || '');
        if (!seen.has(key)) { seen.add(key); all.push(p); }
      }
    }

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
