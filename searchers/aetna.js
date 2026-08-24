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
      // ── Name search: iterate each typeahead suggestion ────────────────────────
      // Each suggestion click navigates to a provider-result page and fires
      // publicdse_providersearch. We go back after each and repeat for all
      // suggestions, then return the combined list.
      await page.waitForTimeout(1000);

      // Helper: type name into search box and return provider suggestions
      const typeAndGetSuggestions = async () => {
        const inp = page.locator('#Doctors, input[ng-model="criteria.typeAheadSearch"]').first();
        await inp.waitFor({ timeout: 8000 }).catch(() => {});
        await inp.click();
        await page.waitForTimeout(200);
        // Clear existing text then type fresh
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Delete');
        await page.keyboard.type(name, { delay: 80 });
        await page.waitForTimeout(1600); // let AngularJS fire the typeahead
        return await page.evaluate(() => {
          // Provider suggestions look like "First Last Cred - City, ST"
          return Array.from(document.querySelectorAll('li[ng-repeat], .dropdown-menu li, ul.typeahead li'))
            .filter(el => el.offsetParent !== null && / - .+, [A-Z]{2}/.test(el.textContent || ''))
            .map(el => el.textContent?.trim());
        });
      };

      // Helper: parse a captured API body into normalized providers
      const parseBody = (body) => {
        try {
          const data = JSON.parse(body);
          const list = data?.providersResponse?.readProvidersResponse?.providerInfoResponses || [];
          return list.map(p => {
            const info = p.providerInformation || {};
            const loc  = p.providerLocations  || {};
            const addr = loc.address   || {};
            const contacts = loc.contacts || {};
            let specialtyDesc = '';
            const spec = p.providerSpecialties;
            if (Array.isArray(spec)) specialtyDesc = spec[0]?.specialty?.description || '';
            else if (spec?.specialty) specialtyDesc = spec.specialty.description || '';
            specialtyDesc = specialtyDesc.replace(/&#38;/g,'&').replace(/&amp;/g,'&');
            const desigs = Array.isArray(p.providerDesignations) ? p.providerDesignations
              : p.providerDesignations ? [p.providerDesignations] : [];
            return {
              network: 'Aetna Open Choice PPO',
              name: info.providerDisplayName?.full || '',
              npi:  info.primaryNPI?.nationalProviderId || '',
              providerType: info.type || '',
              specialty: specialtyDesc,
              address: {
                street: addr.streetLine1 || '', building: addr.buildingName || '',
                city: addr.city || '', county: addr.county || '',
                state: addr.state || '', zip: addr.postalCode || '',
              },
              phone: contacts.phonesVoice?.number || p.contacts?.primaryPhone?.number || '',
              distance: parseFloat(addr.distance) || null,
              latitude:  parseFloat(addr.latitude)  || null,
              longitude: parseFloat(addr.longitude) || null,
              acceptingNewPatients: loc.acceptsNewPatients === 'Y',
              virtualVisits: desigs.some(d => d.code === 'TELEMED' || d.code === 'VIDCONF'),
              inNetwork: true,
              providerId: info.providerID  || '',
              locationId: loc.locationID   || '',
            };
          });
        } catch { return []; }
      };

      // ── Main iteration ────────────────────────────────────────────────────────
      const suggestions = await typeAndGetSuggestions();
      console.log(`[Aetna] Suggestions found: ${JSON.stringify(suggestions)}`);

      const allProviders = [];
      const seenKeys = new Set();
      const cap = Math.min(maxResults, 8);

      for (let i = 0; i < suggestions.length && allProviders.length < cap; i++) {
        // Re-type to get fresh dropdown (needed after each navigation)
        if (i > 0) {
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(800);
          const fresh = await typeAndGetSuggestions();
          console.log(`[Aetna] Re-typed, got ${fresh.length} suggestions`);
        }

        const respPromise = page.waitForResponse(
          res => res.url().includes('publicdse_providersearch'),
          { timeout: 20000 }
        ).catch(() => null);

        // Click suggestion at index i
        const clicked = await page.evaluate((idx) => {
          const items = Array.from(document.querySelectorAll(
            'li[ng-repeat], .dropdown-menu li, ul.typeahead li'
          )).filter(el => el.offsetParent !== null && / - .+, [A-Z]{2}/.test(el.textContent || ''));
          if (items[idx]) { items[idx].click(); return items[idx].textContent?.trim(); }
          return null;
        }, i);

        if (!clicked) { console.log(`[Aetna] Suggestion ${i} not found, skipping`); continue; }
        console.log(`[Aetna] Clicked suggestion ${i}: ${clicked}`);

        const resp = await respPromise;
        if (resp) {
          const body = await resp.text().catch(() => null);
          if (body) {
            const parsed = parseBody(body);
            console.log(`[Aetna] Suggestion ${i} → ${parsed.length} locations`);
            for (const p of parsed) {
              const key = `${p.npi}|${p.address.street}`;
              if (!seenKeys.has(key)) { seenKeys.add(key); allProviders.push(p); }
            }
          }
        }

        // Go back for the next iteration (unless we're done)
        if (i < suggestions.length - 1 && allProviders.length < cap) {
          await page.goBack({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(600);
        }
      }

      console.log(`[Aetna] Name search total: ${allProviders.length} unique providers`);
      return allProviders.slice(0, cap);

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
