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
      const decodeHtml = s => (s || '').replace(/&#38;/g,'&').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
      const parseBody = (body) => {
        try {
          const data = JSON.parse(body);
          // Handle both array and single-object providerInfoResponses
          const raw = data?.providersResponse?.readProvidersResponse?.providerInfoResponses;
          const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
          if (list.length === 0) {
            // Log first 300 chars of body to help diagnose structure issues
            console.log('[Aetna] parseBody: empty list, body prefix:', body.substring(0, 300));
          }
          return list.map(p => {
            const info = p.providerInformation || {};
            // providerLocations can be array or single object
            const locRaw = p.providerLocations;
            const loc  = Array.isArray(locRaw) ? locRaw[0] : (locRaw || {});
            const addr = loc.address   || {};
            const contacts = loc.contacts || {};
            let specialtyDesc = '';
            const spec = p.providerSpecialties;
            if (Array.isArray(spec)) specialtyDesc = spec[0]?.specialty?.description || '';
            else if (spec?.specialty) specialtyDesc = spec.specialty.description || '';
            specialtyDesc = decodeHtml(specialtyDesc);
            const desigs = Array.isArray(p.providerDesignations) ? p.providerDesignations
              : p.providerDesignations ? [p.providerDesignations] : [];
            return {
              network: 'Aetna Open Choice PPO',
              name: decodeHtml(info.providerDisplayName?.full || ''),
              npi:  info.primaryNPI?.nationalProviderId || '',
              providerType: info.type || '',
              specialty: specialtyDesc,
              address: {
                street: decodeHtml(addr.streetLine1 || ''), building: decodeHtml(addr.buildingName || ''),
                city: decodeHtml(addr.city || ''), county: decodeHtml(addr.county || ''),
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
        } catch(e) { console.log('[Aetna] parseBody error:', e.message); return []; }
      };

      // ── Main search: expand full list then iterate all suggestions ──────────────
      await typeAndGetSuggestions(); // type and wait for dropdown to appear
      const cap = Math.min(maxResults, 8);

      // Step A: click the AngularJS "viewMore" link to expand full suggestion list
      // The link lives in <div class="viewMore"><a ng-click="clickViewMore(...)">
      const moreClicked = await page.evaluate(() => {
        // Prefer the exact CSS class used by Aetna's AngularJS template
        const byClass = document.querySelector('.viewMore a');
        if (byClass && byClass.offsetParent !== null) {
          byClass.click();
          return byClass.textContent?.trim();
        }
        // Fallback: any visible <a> whose ng-click calls clickViewMore
        const byAttr = Array.from(document.querySelectorAll('a[ng-click*="clickViewMore"]'))
          .find(el => el.offsetParent !== null);
        if (byAttr) { byAttr.click(); return byAttr.textContent?.trim(); }
        return null;
      });
      console.log(`[Aetna] "More providers" link: ${moreClicked}`);
      if (moreClicked) {
        await page.waitForTimeout(1400); // let expanded list render
      }

      // Step B: try clicking "{name} (any location)" for a single broad-radius call
      const respPromise = page.waitForResponse(
        res => res.url().includes('publicdse_providersearch'),
        { timeout: 35000 }
      ).catch(() => null);

      const anyLocationClicked = await page.evaluate((searchName) => {
        const pattern = new RegExp(searchName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\s*\\(any location\\)', 'i');
        // Check typeahead_grouping li items (Aetna's AngularJS rendered suggestion rows)
        const candidates = [
          ...document.querySelectorAll('li.typeahead_grouping'),
          ...document.querySelectorAll('li[ng-repeat*="Filter"]'),
          ...document.querySelectorAll('.dropdown-menu li'),
        ];
        const el = candidates.find(el => el.offsetParent !== null && pattern.test(el.textContent || ''));
        if (el) { el.click(); return el.textContent?.trim(); }
        // Broader fallback
        const anyEl = Array.from(document.querySelectorAll('li, a, span, div'))
          .find(el => el.offsetParent !== null && pattern.test(el.textContent || ''));
        if (anyEl) { anyEl.click(); return anyEl.textContent?.trim(); }
        return null;
      }, name);
      console.log(`[Aetna] Any-location option: ${anyLocationClicked}`);

      if (anyLocationClicked) {
        // Wait for the broad search results
        const resp = await respPromise;
        if (!resp) throw new Error('Aetna: no provider search API response captured');
        const body = await resp.text().catch(() => null);
        if (!body) throw new Error('Aetna: empty API response');
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(600);

        const parsed = parseBody(body);
        console.log(`[Aetna] Any-location → ${parsed.length} providers`);
        const seenKeys = new Set();
        const result = [];
        for (const p of parsed) {
          const key = p.locationId || `${p.npi}|${p.address.street}`;
          if (!seenKeys.has(key)) { seenKeys.add(key); result.push(p); }
        }
        return result.slice(0, cap);

      } else {
        // Fallback: iterate individual typeahead suggestion items
        // Use AngularJS class "typeahead_grouping" which is the actual rendered row class
        console.log('[Aetna] No any-location found, iterating typeahead_grouping suggestions');
        const suggCount = await page.evaluate(() =>
          Array.from(document.querySelectorAll('li.typeahead_grouping, li[ng-repeat*="specFilter"], li[ng-repeat*="hospFilter"]'))
            .filter(el => el.offsetParent !== null).length
        );
        console.log(`[Aetna] Visible suggestion items: ${suggCount}`);

        const allProviders = [];
        const seenKeys = new Set();

        for (let i = 0; i < suggCount && allProviders.length < cap; i++) {
          if (i > 0) {
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(800);
            await typeAndGetSuggestions();
            // re-expand if "more" was visible
            await page.evaluate(() => {
              const el = document.querySelector('.viewMore a, a[ng-click*="clickViewMore"]');
              if (el && el.offsetParent !== null) el.click();
            });
            await page.waitForTimeout(1000);
          }
          const iterResp = page.waitForResponse(
            res => res.url().includes('publicdse_providersearch'), { timeout: 20000 }
          ).catch(() => null);
          const clicked = await page.evaluate((idx) => {
            const items = Array.from(document.querySelectorAll(
              'li.typeahead_grouping, li[ng-repeat*="specFilter"], li[ng-repeat*="hospFilter"]'
            )).filter(el => el.offsetParent !== null);
            if (items[idx]) { items[idx].click(); return items[idx].textContent?.trim().substring(0, 60); }
            return null;
          }, i);
          if (!clicked) continue;
          console.log(`[Aetna] Clicked item ${i}: ${clicked}`);
          const resp = await iterResp;
          if (resp) {
            const body = await resp.text().catch(() => null);
            if (body) {
              const parsed = parseBody(body);
              for (const p of parsed) {
                const key = p.locationId || `${p.npi}|${p.address.street}`;
                if (!seenKeys.has(key)) { seenKeys.add(key); allProviders.push(p); }
              }
            }
          }
          if (i < suggCount - 1 && allProviders.length < cap) {
            await page.goBack({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(600);
          }
        }
        console.log(`[Aetna] Name search total: ${allProviders.length} unique providers`);
        return allProviders.slice(0, cap);
      }

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
