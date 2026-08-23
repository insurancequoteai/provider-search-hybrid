// searchers/aetna.js
// Aetna Open Choice PPO provider search via Playwright + stealth

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

// Normalize common user search terms to Aetna's specialty page labels
const SPECIALTY_ALIASES = {
  'cardiologist':       'cardiology',
  'dermatologist':      'dermatology',
  'neurologist':        'neurology',
  'oncologist':         'oncology',
  'ophthalmologist':    'ophthalmology',
  'orthopedic':         'orthopedic',
  'orthopedist':        'orthopedic',
  'psychiatrist':       'psychiatry',
  'psychologist':       'psychology',
  'urologist':          'urology',
  'endocrinologist':    'endocrinology',
  'gastroenterologist': 'gastroenterology',
  'hematologist':       'hematology',
  'nephrologist':       'nephrology',
  'pulmonologist':      'pulmonology',
  'rheumatologist':     'rheumatology',
  'allergist':          'allergy',
  'immunologist':       'immunology',
  'obstetrician':       'obstetrics',
  'gynecologist':       'gynecology',
  'pediatrician':       'pediatrics',
  'radiologist':        'radiology',
  'anesthesiologist':   'anesthesiology',
};

function normalizeSpecialty(raw) {
  const lower = raw.toLowerCase().trim();
  return SPECIALTY_ALIASES[lower] || lower;
}

// True if element text matches the specialty (tries exact, alias, stem, reverse)
function specialtyMatches(elText, targetLower, normalizedTarget) {
  const el = elText.toLowerCase().trim();
  return (
    el === targetLower ||
    el === normalizedTarget ||
    el.includes(normalizedTarget) ||
    el.includes(targetLower) ||
    normalizedTarget.includes(el) ||
    targetLower.includes(el)
  );
}

async function searchAetna({ specialty = 'All Medical Specialists', zip = '77041', maxResults = 25 } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
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

    const targetLower = specialty.toLowerCase().trim();
    const normalizedTarget = normalizeSpecialty(specialty);

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

    // ── Step 3: Click Continue ────────────────────────────────────────────────
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

    // ── Step 4: Medical Doctors ───────────────────────────────────────────────
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

    // ── Step 5: Medical Specialists ───────────────────────────────────────────
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

    // ── Step 6: Click specialty ───────────────────────────────────────────────
    const responsePromise = page.waitForResponse(
      res => res.url().includes('publicdse_providersearch'),
      { timeout: 25000 }
    ).catch(() => null);

    const specialtyClicked = await page.evaluate(([tLower, nTarget]) => {
      const all = Array.from(document.querySelectorAll('a, button, li, span, div[role="button"]'))
        .filter(el => el.offsetParent !== null && el.textContent?.trim());

      // 1. Exact match on normalized target (e.g. "cardiology")
      const exact = all.find(el => el.textContent.trim().toLowerCase() === nTarget);
      if (exact) { exact.click(); return 'exact: ' + exact.textContent.trim(); }

      // 2. Element text starts with or equals the target
      const startsWith = all.find(el => el.textContent.trim().toLowerCase().startsWith(nTarget));
      if (startsWith) { startsWith.click(); return 'startsWith: ' + startsWith.textContent.trim(); }

      // 3. Normalized target is contained in element text
      const inEl = all.find(el => el.textContent.trim().toLowerCase().includes(nTarget));
      if (inEl) { inEl.click(); return 'inEl: ' + inEl.textContent.trim(); }

      // 4. Element text is contained in normalized target (e.g. el="cardio", target="cardiology")
      const elInTarget = all.find(el => nTarget.includes(el.textContent.trim().toLowerCase()) && el.textContent.trim().length > 3);
      if (elInTarget) { elInTarget.click(); return 'elInTarget: ' + elInTarget.textContent.trim(); }

      // 5. Original (non-normalized) term search
      const original = all.find(el => el.textContent.trim().toLowerCase().includes(tLower));
      if (original) { original.click(); return 'original: ' + original.textContent.trim(); }

      // 6. Fallback: All Medical Specialists
      const allSpec = all.find(el => el.textContent?.includes('All Medical Specialists'));
      if (allSpec) { allSpec.click(); return 'fallback: All Medical Specialists'; }

      return 'not found';
    }, [targetLower, normalizedTarget]);

    console.log(`[Aetna] Specialty click result: ${specialtyClicked}`);

    await responsePromise;
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);

    if (!providerApiBody) {
      throw new Error('Aetna: no provider search API response captured');
    }

    // ── Parse response ─────────────────────────────────────────────────────────
    const data = JSON.parse(providerApiBody);
    const providers = data?.providersResponse?.readProvidersResponse?.providerInfoResponses || [];

    const results = providers.slice(0, maxResults).map(p => {
      const info = p.providerInformation || {};
      const loc = p.providerLocations || {};
      const addr = loc.address || {};
      const contacts = loc.contacts || {};

      let specialtyDesc = '';
      const spec = p.providerSpecialties;
      if (Array.isArray(spec)) {
        specialtyDesc = spec[0]?.specialty?.description || '';
      } else if (spec?.specialty) {
        specialtyDesc = spec.specialty.description || '';
      }
      specialtyDesc = specialtyDesc.replace(/&#38;/g, '&').replace(/&amp;/g, '&');

      const designations = Array.isArray(p.providerDesignations)
        ? p.providerDesignations
        : p.providerDesignations ? [p.providerDesignations] : [];
      const telemedicine = designations.some(d => d.code === 'TELEMED' || d.code === 'VIDCONF');

      return {
        network: 'Aetna Open Choice PPO',
        name: info.providerDisplayName?.full || '',
        npi: info.primaryNPI?.nationalProviderId || '',
        providerType: info.type || '',
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
        inNetwork: true,
        providerId: info.providerID || '',
        locationId: loc.locationID || '',
      };
    });

    // Post-filter: if we didn't fall back, filter results to match specialty
    if (!specialtyClicked.includes('fallback')) {
      const filtered = results.filter(r =>
        r.specialty.toLowerCase().includes(normalizedTarget) ||
        normalizedTarget.includes(r.specialty.toLowerCase())
      );
      // Only apply filter if it returns something meaningful
      if (filtered.length > 0) return filtered;
    }

    return results;
  } finally {
    await browser.close();
  }
}

module.exports = searchAetna;
