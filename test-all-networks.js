/**
 * Full 4-network parallel test — mirrors what server.js does on POST /api/search
 */
const zocdoc      = require('./searchers/zocdoc');
const phcs        = require('./searchers/phcs');
const firsthealth = require('./searchers/firsthealth');

const params = { zip: '77041', name: '', specialty: '' };
const start  = Date.now();

console.log('Searching all 4 networks in parallel for ZIP 77041...\n');

Promise.all([
  zocdoc(params, ['uhc', 'aetna'])
    .then(r  => ({ net: 'UHC + Aetna (ZocDoc)', results: r,  error: null }))
    .catch(e => ({ net: 'UHC + Aetna (ZocDoc)', results: {}, error: e.message })),

  phcs(params)
    .then(r  => ({ net: 'PHCS/MultiPlan', results: { phcs: r }, error: null }))
    .catch(e => ({ net: 'PHCS/MultiPlan', results: {},          error: e.message })),

  firsthealth(params)
    .then(r  => ({ net: 'FirstHealth',    results: { fh: r },  error: null }))
    .catch(e => ({ net: 'FirstHealth',    results: {},         error: e.message })),

]).then(all => {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`All done in ${elapsed}s\n`);

  all.forEach(({ net, results, error }) => {
    if (error) {
      console.log(`❌ ${net}: ERROR — ${error}\n`);
      return;
    }
    Object.entries(results).forEach(([key, providers]) => {
      const list = Array.isArray(providers) ? providers : [];
      console.log(`✅ ${net} [${key}]: ${list.length} providers`);
      list.slice(0, 2).forEach(p =>
        console.log(`   • ${p.name} — ${p.specialty || 'N/A'} — ${p.phone || 'no phone'}`)
      );
      console.log();
    });
  });
});
