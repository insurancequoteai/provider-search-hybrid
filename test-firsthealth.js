const firsthealthSearch = require('./searchers/firsthealth');

async function test(label, params) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`TEST: ${label}`);
  console.log('='.repeat(50));
  try {
    const results = await firsthealthSearch(params);
    console.log(`Found ${results.length} providers`);
    results.slice(0, 2).forEach((p, i) => {
      console.log(`\n  [${i+1}] ${p.name}`);
      console.log(`      Specialty: ${p.specialty}`);
      console.log(`      Address:   ${p.address}`);
      console.log(`      Phone:     ${p.phone}`);
      console.log(`      Distance:  ${p.distance}`);
    });
  } catch (err) {
    console.error('ERROR:', err.message);
  }
}

(async () => {
  // Test 1: Specialty filter
  await test('Specialty filter — Family Medicine near 77041', {
    zip: '77041',
    specialty: 'Family Medicine',
  });

  // Test 2: Name lookup (in-network check)
  await test('Name lookup — Peters Douglas near 77041', {
    zip: '77041',
    name: 'Douglas Peters',
  });

  // Test 3: Name only (broader search)
  await test('Name only — Kobza near 77041', {
    zip: '77041',
    name: 'Kobza',
  });
})();
