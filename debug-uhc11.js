// debug-uhc11.js
// Fix: use React fiber to call the option's onClick handler directly.
// This bypasses all DOM event layers and calls React's synthetic event handler.
// Also try: dispatch full pointer event sequence as fallback.

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const graphqlResponses = [];
  page.on('response', async res => {
    if (res.url().includes('graphql') || res.url().includes('uhc.com')) {
      try { graphqlResponses.push({ url: res.url(), body: await res.text() }); } catch {}
    }
  });

  // Steps 1-4: get to plan-selection (working)
  await page.goto('https://findcare.guest.uhc.com/guest-plan-selection/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => document.querySelector('[aria-label="Close"]')?.click());
  await page.waitForTimeout(600);
  await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Explore coverage'))?.click());
  await page.waitForURL('**/select-coverage-type**', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim().startsWith('Explore'))?.click());
  await page.waitForURL('**/plan-selection**', { timeout: 12000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  console.log('Plan selection:', page.url());

  // Step 5: Type location
  const locInput = page.locator('input[role="combobox"]').first();
  await locInput.click();
  await locInput.fill('');
  await page.waitForTimeout(200);
  await locInput.type('77041', { delay: 80 });
  await page.waitForTimeout(1500);
  await page.waitForSelector('[role="option"]', { timeout: 8000 }).catch(() => {});
  const optCount = await page.locator('[role="option"]').count().catch(() => 0);
  console.log('Options visible:', optCount);

  if (optCount === 0) {
    console.log('No options — cannot continue');
    await browser.close();
    return;
  }

  // ── Approach 1: React fiber onClick ──────────────────────────────────────
  const fiberResult = await page.evaluate(() => {
    const option = document.querySelector('[role="option"]');
    if (!option) return 'no option element';

    // Find the React fiber key
    const fiberKey = Object.keys(option).find(k =>
      k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance') || k.startsWith('__reactEventHandlers')
    );
    if (!fiberKey) return 'no fiber key found. Keys: ' + Object.keys(option).filter(k => k.startsWith('__')).join(', ');

    let fiber = option[fiberKey];
    let depth = 0;
    let tried = [];

    while (fiber && depth < 30) {
      const props = fiber.memoizedProps || fiber.pendingProps || {};
      tried.push(`d${depth}:${fiber.type?.displayName || fiber.type?.name || typeof fiber.type}`);

      if (props.onClick) {
        try {
          props.onClick({
            preventDefault: () => {},
            stopPropagation: () => {},
            target: option,
            currentTarget: option,
            type: 'click',
            nativeEvent: new MouseEvent('click'),
          });
          return `✅ called onClick at depth ${depth} on ${fiber.type?.displayName || fiber.type?.name || fiber.type}`;
        } catch (e) { return `onClick threw: ${e.message}`; }
      }
      if (props.onMouseDown) {
        try {
          props.onMouseDown({
            preventDefault: () => {},
            stopPropagation: () => {},
            target: option,
            currentTarget: option,
            type: 'mousedown',
            nativeEvent: new MouseEvent('mousedown'),
          });
          return `called onMouseDown at depth ${depth}`;
        } catch (e) {}
      }
      fiber = fiber.return;
      depth++;
    }
    return 'no handler found. Walked: ' + tried.slice(0, 15).join(', ');
  });
  console.log('Fiber click result:', fiberResult);

  // Wait to see if fiber click worked
  await page.waitForTimeout(2000);
  let planText = await page.evaluate(() => document.body.innerText);
  const fiberWorked = planText.toLowerCase().includes('choice plus');
  console.log('Choice Plus after fiber click:', fiberWorked);

  if (!fiberWorked) {
    // ── Approach 2: Full pointer event sequence ──────────────────────────────
    console.log('Trying full pointer event sequence...');

    // Need to re-type since previous actions may have changed the state
    await locInput.click();
    await locInput.fill('');
    await page.waitForTimeout(200);
    await locInput.type('77041', { delay: 80 });
    await page.waitForTimeout(1500);
    await page.waitForSelector('[role="option"]', { timeout: 6000 }).catch(() => {});

    const pointerResult = await page.evaluate(() => {
      const option = document.querySelector('[role="option"]');
      if (!option) return 'no option';

      const eventTypes = [
        'pointerover', 'pointerenter', 'mouseover', 'mouseenter',
        'pointermove', 'mousemove',
        'pointerdown', 'mousedown',
        'focus',
        'pointerup', 'mouseup',
        'click',
        'pointerout', 'pointerleave', 'mouseout', 'mouseleave',
      ];

      for (const type of eventTypes) {
        const init = {
          bubbles: true, cancelable: true, view: window,
          clientX: option.getBoundingClientRect().x + option.getBoundingClientRect().width / 2,
          clientY: option.getBoundingClientRect().y + option.getBoundingClientRect().height / 2,
        };
        if (type.startsWith('pointer')) {
          option.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse' }));
        } else if (type === 'focus') {
          option.dispatchEvent(new FocusEvent(type, { bubbles: true }));
        } else {
          option.dispatchEvent(new MouseEvent(type, init));
        }
      }
      return 'dispatched ' + eventTypes.length + ' events';
    });
    console.log('Pointer events:', pointerResult);

    await page.waitForTimeout(3000);
    planText = await page.evaluate(() => document.body.innerText);
    const pointerWorked = planText.toLowerCase().includes('choice plus');
    console.log('Choice Plus after pointer events:', pointerWorked);

    if (!pointerWorked) {
      // ── Approach 3: Direct GraphQL call ─────────────────────────────────
      console.log('\nTrying direct GraphQL approach...');
      // Capture the search query by intercepting what happens when we force a state update
      // Let's check what GetLocation query params look like
      const locGql = graphqlResponses.find(r => r.url.includes('GetLocation'));
      if (locGql) {
        console.log('GetLocation URL:', locGql.url.substring(0, 200));
      }

      const planDefGql = graphqlResponses.filter(r => r.url.includes('GetPlanDefinitions')).pop();
      if (planDefGql) {
        console.log('GetPlanDefinitions URL:', planDefGql.url.substring(0, 200));
        // Try to extract session cookies and call the provider search API directly
      }

      // Last resort: try using page.evaluate to set React state directly via __REACT_STATE__
      const reactStateResult = await page.evaluate(() => {
        // Try to find the React root and set state
        const root = document.querySelector('#root, [data-reactroot], #app');
        if (!root) return 'no react root';
        const fiberKey = Object.keys(root).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (!fiberKey) return 'no fiber on root';

        // Navigate fiber tree to find location state
        let fiber = root[fiberKey];
        let depth = 0;
        while (fiber && depth < 50) {
          const state = fiber.memoizedState;
          if (state && typeof state.queue === 'object') {
            return `Found state at depth ${depth}: ${JSON.stringify(Object.keys(state)).substring(0, 100)}`;
          }
          fiber = fiber.child || fiber.return;
          depth++;
        }
        return 'traversed ' + depth + ' fiber nodes';
      });
      console.log('React state exploration:', reactStateResult);

      console.log('\nPage text (2000):\n', planText.substring(0, 2000));
    }
  }

  if (planText.toLowerCase().includes('choice plus')) {
    console.log('\nSuccess! Clicking Choice Plus...');
    const cpClicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button, a, li, div[role="button"], span, h3, h4'));
      const exact = all.find(el => el.textContent?.trim().toLowerCase() === 'choice plus' && el.offsetParent !== null);
      if (exact) { exact.click(); return 'exact: ' + exact.tagName; }
      const cp = all.find(el => {
        const t = el.textContent?.toLowerCase() || '';
        return t.includes('choice plus') && !t.includes('advanced') && !t.includes('premier') && !t.includes('hmo') && el.offsetParent !== null;
      });
      if (cp) { cp.click(); return 'contains: ' + cp.tagName + ' | ' + cp.textContent.trim().substring(0, 60); }
      return 'not found';
    });
    console.log('Choice Plus click:', cpClicked);
    await page.waitForTimeout(4000);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    console.log('URL after Choice Plus:', page.url());
    const afterText = await page.evaluate(() => document.body.innerText);
    console.log('Page after (5000):\n', afterText.substring(0, 5000));
  }

  console.log('\n=== All GraphQL ops ===');
  for (const r of graphqlResponses) {
    try { console.log(new URL(r.url).searchParams.get('q') || r.url.substring(0, 120)); }
    catch { console.log(r.url.substring(0, 120)); }
  }

  await browser.close();
})();
