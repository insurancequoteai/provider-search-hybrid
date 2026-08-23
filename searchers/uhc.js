// searchers/uhc.js
// UHC Choice Plus provider search via direct URL bypass + GraphQL ProviderSearch

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

/**
 * @param {object} opts
 * @param {string} opts.specialty  - e.g. "Cardiologist", "Primary Care"
 * @param {string} opts.zip        - 5-digit ZIP code
 * @param {number} [opts.maxResults=50]
 * @returns {Promise<Array>} normalized provider objects
 */
async function searchUHC({ specialty = 'Cardiologist', zip = '77041', maxResults = 50 } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(45000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const providerBatches = [];

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

    // Step 1: Navigate directly to find-care with Choice Plus plan + ZIP
    // Use 'load' instead of 'networkidle' — UHC's SPA has persistent connections
    // that prevent networkidle from ever firing.
    await page.goto(
      `https://findcare.guest.uhc.com/find-care?plan=s00001&zip=${encodeURIComponent(zip)}`,
      { waitUntil: 'load', timeout: 40000 }
    );
    await page.waitForTimeout(2500);

    // Step 2: Confirm the page loaded with the right ZIP.
    // UHC renders a location input; check it and correct if needed.
    const locationInput = page.locator(
      'input[placeholder*="City" i], input[placeholder*="Zip" i], input[placeholder*="Location" i], input[aria-label*="location" i], input[aria-label*="zip" i]'
    ).first();

    if (await locationInput.count() > 0 && await locationInput.isVisible()) {
      const currentVal = await locationInput.inputValue().catch(() => '');
      if (!currentVal.includes(zip)) {
        // ZIP wasn't applied from URL — set it manually
        await locationInput.click({ clickCount: 3 });
        await locationInput.type(zip, { delay: 60 });
        await page.waitForTimeout(1200);
        // Click first suggestion if dropdown appears
        const locOpt = page.locator('[role="option"]').first();
        if (await locOpt.count() > 0) {
          await locOpt.click();
        } else {
          await page.keyboard.press('Tab');
        }
        await page.waitForTimeout(800);
      }
    }

    // Step 3: Dismiss Smart Choice / modal if present
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
    await page.waitForTimeout(800);

    // Step 4: Find the specialty / provider-name search input.
    // UHC renders two comboboxes: specialty (first) and location (second).
    // We want the FIRST visible combobox.
    await page.waitForSelector('input[role="combobox"]', { timeout: 15000 }).catch(() => {});

    const allComboboxes = await page.locator('input[role="combobox"]').all();
    let searchInput = null;
    for (const cb of allComboboxes) {
      const ph = await cb.getAttribute('placeholder').catch(() => '');
      const al = await cb.getAttribute('aria-label').catch(() => '');
      const visible = await cb.isVisible().catch(() => false);
      if (!visible) continue;
      // The specialty box usually mentions "name", "specialty", "doctor", or is generic
      if (ph.match(/name|specialty|doctor|provider|search/i) ||
          al.match(/name|specialty|doctor|provider|search/i) ||
          (!ph.match(/zip|city|location|address/i) && !al.match(/zip|city|location|address/i))) {
        searchInput = cb;
        break;
      }
    }
    if (!searchInput && allComboboxes.length > 0) {
      searchInput = allComboboxes[0]; // fallback to first
    }

    if (!searchInput) throw new Error('UHC: could not find specialty search input');

    // Step 5: Type specialty and wait for providers
    const searchDone = new Promise(resolve => {
      setTimeout(resolve, 20000); // max wait
      const check = setInterval(() => {
        if (providerBatches.length > 0) { clearInterval(check); setTimeout(resolve, 2000); }
      }, 200);
    });

    await searchInput.click();
    await searchInput.type(specialty, { delay: 80 });
    await page.waitForTimeout(1500);

    // Wait for and click first autocomplete option
    await page.waitForSelector('[role="option"]', { timeout: 8000 }).catch(() => {});
    const firstOption = page.locator('[role="option"]').first();
    if (await firstOption.count() > 0) {
      await firstOption.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(300);

    // Click Search button if visible
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent?.trim().toLowerCase() === 'search' && b.offsetParent !== null
      );
      if (btn) btn.click();
    });

    await searchDone;
    await page.waitForTimeout(1500); // let extra batches arrive

    // Merge all batches, dedupe by providerId + locationId
    const seen = new Set();
    const all = [];
    for (const batch of providerBatches) {
      for (const p of batch) {
        const key = p.providerId + ':' + (p.locationId || '');
        if (!seen.has(key)) {
          seen.add(key);
          all.push(p);
        }
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
