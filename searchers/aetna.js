// searchers/aetna.js
// Aetna Open Choice PPO provider search via Playwright + stealth
// Full navigation: landing → zip → plan → Medical Doctors → Medical Specialists → results

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

/**
 * @param {object} opts
 * @param {string} [opts.specialty]  - e.g. "Cardiologist", "All Medical Specialists"
 * @param {string} [opts.name]       - provider name for name search
 * @param {string} opts.zip          - 5-digit ZIP code
 * @param {number} [opts.maxResults=25]
 * @returns {Promise<Array>} normalized provider objects
 */
async function searchAetna({ specialty = 'All Medical Specialists', name = '', zip = '77041', maxResults = 25 } = {}) {
  const isNameSearch = !!name;
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    let providerApiBody = null;

    page.on('response', async res => {
      if (res.url().includes('publicdse_providersearch')) {
        try { providerApiBody = await res.text(); } catch {}
      }
    });

    // ── Step 1: Landing page → enter ZIP ──────────────────────────────────────
    await page.goto(
      'https://www.aetna.com/dsepublic/#/contentPage?page=providerSearchLanding&site_id=dse&language=en',
      { waitUntil: 'networkidle', timeout: 30000 }
    );
    await page.waitForTimeout(2000);
    await page.waitForSelector('#zip1', { timeout: 10000 });
    await page.click('#zip1', { clickCount: 3 });
    await page.type('#zip1', zip, { delay: 100 });
    await page.evaluate(() => {
      const el = document.querySelector('#zip1');
      el?.dispatchEvent(new Event('input', { bubbles: true }));
      el?.dispatchEvent(new Event('change', { bubbles: true }));
      el?.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    });
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForURL('**/providerSearchPlanList**', { timeout: 20000 }).catch(() => {});
    if (!page.url().includes('providerSearchPlanList')) {
      await page.locator('button:has-text("Search")').first().click().catch(() => {});
      await page.waitForURL('**/providerSearchPlanList**', { timeout: 15000 }).catch(() => {});
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // ── Step 2: Select Open Choice PPO ────────────────────────────────────────
    await page.waitForTimeout(800);
    const ppLabel = page.locator('label').filter({ hasText: 'Open Choice' }).first();
    if (await ppLabel.count() > 0) {
      await ppLabel.click();
    } else {
      await page.locator('input[type="radio"][value*="MPPO"]').first().click().catch(() => {});
    }
    await page.waitForTimeout(800);

    // ── Step 3: Click Continue (not hidden by ng-hide) ────────────────────────
    const contBtn = page.locator('button:not(.ng-hide):has-text("Continue")').first();
    if (await contBtn.count() > 0) {
      await contBtn.click();
    } else {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          b.textContent?.includes('Continue') && !b.classList.contains('ng-hide') && b.offsetParent !== null
        );
        if (btn) btn.click();
      });
    }
    await page.waitForURL('**/providerSearch**', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    if (isNameSearch) {
      // ── Name search ───────────────────────────────────────────────────────────
      // The providerSearch page already has a typeahead input (id="Doctors",
      // ng-model="criteria.typeAheadSearch"). Type the name there and submit.
      await page.waitForTimeout(1200);

      const responsePromise = page.waitForResponse(
        res => res.url().includes('publicdse_providersearch'),
        { timeout: 30000 }
      ).catch(() => null);

      // Type name into the main search box
      const nameInputFound = await page.evaluate((providerName) => {
        const inp = document.getElementById('Doctors') ||
          document.querySelector('input[ng-model="criteria.typeAheadSearch"]') ||
          Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
            .find(el => el.offsetParent !== null);
        if (!inp) return null;
        inp.value = providerName;
        inp.dispatchEvent(new Event('input',  { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        return inp.id || inp.getAttribute('ng-model') || 'found';
      }, name);
      console.log(`[Aetna] Name input: ${nameInputFound}`);

      if (!nameInputFound) throw new Error('Aetna: could not find provider name input');

      await page.waitForTimeout(500);
      // Click the Search button
      const searchClicked = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
          .find(el => el.offsetParent !== null &&
            /search|find|go|submit/i.test(el.textContent?.trim() || el.value || ''));
        if (btn) { btn.click(); return btn.textContent?.trim() || btn.value || 'clicked'; }
        return null;
      });
      if (!searchClicked) await page.keyboard.press('Enter');
      console.log(`[Aetna] Search submitted: ${searchClicked || 'Enter'}`);

      await page.waitForTimeout(400);
      // Click Search button or press Enter
      const searchClicked = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
          .find(el => el.offsetParent !== null && /search|find|go/i.test(el.textContent || el.value || ''));
        if (btn) { btn.click(); return btn.textContent?.trim() || 'submit'; }
        return null;
      });
      if (!searchClicked) await page.keyboard.press('Enter');
      console.log(`[Aetna] Name search submitted: ${searchClicked || 'Enter'}`);

      await responsePromise;
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(800);

    } else {
      // ── Specialty search (existing flow) ─────────────────────────────────────
      // Step 4: Medical Doctors
      const medLink = page.locator('a, button, li').filter({ hasText: 'Medical Doctors' }).first();
      if (await medLink.count() > 0) {
        await medLink.click();
      } else {
        await page.evaluate(() => {
          Array.from(document.querySelectorAll('a, button, li, span'))
            .find(el => el.offsetParent !== null && el.textContent?.includes('Medical Doctors'))?.click();
        });
      }
      await page.waitForURL('**/providerMedical**', { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      // Step 5: Medical Specialists
      const specLink = page.locator('a, button, li').filter({ hasText: 'Medical Specialists' }).first();
      if (await specLink.count() > 0) {
        await specLink.click();
      } else {
        await page.evaluate(() => {
          Array.from(document.querySelectorAll('a, button, li, span'))
            .find(el => el.offsetParent !== null && el.textContent?.includes('Medical Specialists') && !el.textContent?.includes('All'))?.click();
        });
      }
      await page.waitForURL('**/providerSearchSpecialists**', { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(800);

      // Step 6: Click specialty (or "All Medical Specialists")
      const responsePromise = page.waitForResponse(
        res => res.url().includes('publicdse_providersearch'),
        { timeout: 25000 }
      ).catch(() => null);

      const specialtyClicked = await page.evaluate((targetSpecialty) => {
        const all = Array.from(document.querySelectorAll('a, button, li, span, div[role="button"]'));
        const exact = all.find(el => el.offsetParent !== null &&
          el.textContent?.trim().toLowerCase() === targetSpecialty.toLowerCase());
        if (exact) { exact.click(); return 'exact: ' + exact.textContent.trim(); }
        const partial = all.find(el => el.offsetParent !== null &&
          el.textContent?.toLowerCase().includes(targetSpecialty.toLowerCase()));
        if (partial) { partial.click(); return 'partial: ' + partial.textContent.trim().substring(0, 50); }
        const allSpec = all.find(el => el.offsetParent !== null &&
          el.textContent?.includes('All Medical Specialists'));
        if (allSpec) { allSpec.click(); return 'fallback: All Medical Specialists'; }
        return 'not found';
      }, specialty);

      await responsePromise;
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }

    if (!providerApiBody) {
      throw new Error('Aetna: no provider search API response captured');
    }

    // ── Parse response ─────────────────────────────────────────────────────────
    const data = JSON.parse(providerApiBody);
    const providers = data?.providersResponse?.readProvidersResponse?.providerInfoResponses || [];

    return providers.slice(0, maxResults).map(p => {
      const info = p.providerInformation || {};
      const loc = p.providerLocations || {};
      const addr = loc.address || {};
      const contacts = loc.contacts || {};

      // specialty can be a single object or array
      let specialtyDesc = '';
      const spec = p.providerSpecialties;
      if (Array.isArray(spec)) {
        specialtyDesc = spec[0]?.specialty?.description || '';
      } else if (spec?.specialty) {
        specialtyDesc = spec.specialty.description || '';
      }
      // decode HTML entities
      specialtyDesc = specialtyDesc.replace(/&#38;/g, '&').replace(/&amp;/g, '&');

      const designations = Array.isArray(p.providerDesignations)
        ? p.providerDesignations
        : p.providerDesignations ? [p.providerDesignations] : [];
      const telemedicine = designations.some(d => d.code === 'TELEMED' || d.code === 'VIDCONF');

      return {
        network: 'Aetna Open Choice PPO',
        name: info.providerDisplayName?.full || '',
        npi: info.primaryNPI?.nationalProviderId || '',
        providerType: info.type || '', // "Individual" | "Organization"
        specialty: specialtyDesc,
        address: {
          street: addr.streetLine1 || '',
          building: addr.buildingName || '',
          city: addr.city || '',
          county: addr.county || '',
          state: addr.state || '',
          zip: addr.postalCode || '',
        },
        phone: contacts.phonesVoice?.number || p.contacts?.primaryPhone?.number || '',
        distance: parseFloat(addr.distance) || null,
        latitude: parseFloat(addr.latitude) || null,
        longitude: parseFloat(addr.longitude) || null,
        acceptingNewPatients: loc.acceptsNewPatients === 'Y',
        virtualVisits: telemedicine,
        inNetwork: true, // by definition — we searched within plan network
        providerId: info.providerID || '',
        locationId: loc.locationID || '',
      };
    });
  } finally {
    await browser.close();
  }
}

module.exports = searchAetna;
