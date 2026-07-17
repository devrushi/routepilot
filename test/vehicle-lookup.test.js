import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVehicleLookup,
  normalizeRegistration,
  normalizeSpecification,
  resolveFuelDescription,
  VehicleLookupError,
} from '../src/vehicle-lookup.js';
import { FUEL_TYPES } from '../src/vehicles.js';

// A fixed clock so derived year bounds and `fetchedAt` are deterministic.
const FIXED_NOW = Date.UTC(2024, 0, 1);
const now = () => FIXED_NOW;

// A DVLA-style raw response keyed by canonical registration.
const AUTHORITY = {
  AB12CDE: {
    make: 'TOYOTA',
    model: 'PRIUS',
    yearOfManufacture: '2019',
    fuelType: 'PETROL/PLUG-IN ELECTRIC HYBRID',
    colour: 'BLUE',
    engineCapacity: '1798',
    co2Emissions: 78,
  },
  EV19XYZ: {
    make: 'TESLA', model: 'MODEL 3', year: 2022, fuel: 'ELECTRICITY', colour: 'WHITE',
  },
};

function stubProvider(overrides = {}) {
  const table = { ...AUTHORITY, ...overrides };
  return async (registration) => table[registration] ?? null;
}

// --- normalizeRegistration ----------------------------------------------

test('normalizeRegistration upper-cases and strips spaces/hyphens', () => {
  assert.equal(normalizeRegistration(' ab12 cde '), 'AB12CDE');
  assert.equal(normalizeRegistration('ab12-cde'), 'AB12CDE');
});

test('normalizeRegistration rejects empty and malformed input', () => {
  for (const bad of ['', '   ', 'AB!CD', 'TOO-LONG-PLATE-X', 123, null]) {
    assert.throws(() => normalizeRegistration(bad), (e) => e instanceof VehicleLookupError && e.code === 'VEHICLE_LOOKUP_PLATE', String(bad));
  }
});

// --- resolveFuelDescription ---------------------------------------------

test('resolveFuelDescription maps authority descriptions onto the catalogue', () => {
  assert.equal(resolveFuelDescription(FUEL_TYPES, 'PETROL').id, 'gasoline');
  assert.equal(resolveFuelDescription(FUEL_TYPES, 'Diesel').id, 'diesel');
  assert.equal(resolveFuelDescription(FUEL_TYPES, 'ELECTRICITY').id, 'battery_electric');
  assert.equal(resolveFuelDescription(FUEL_TYPES, 'PETROL/PLUG-IN ELECTRIC HYBRID').id, 'plug_in_hybrid');
  assert.equal(resolveFuelDescription(FUEL_TYPES, 'battery_electric').id, 'battery_electric'); // by id
  assert.equal(resolveFuelDescription(FUEL_TYPES, 'Gasoline').id, 'gasoline'); // by label
  assert.equal(resolveFuelDescription(FUEL_TYPES, 'coal'), null);
  assert.equal(resolveFuelDescription(FUEL_TYPES, 42), null);
});

// --- normalizeSpecification ---------------------------------------------

test('normalizeSpecification normalizes a full response and resolves fuel', () => {
  const spec = normalizeSpecification('AB12CDE', AUTHORITY.AB12CDE, { now });
  assert.equal(spec.registration, 'AB12CDE');
  assert.equal(spec.make, 'TOYOTA');
  assert.equal(spec.year, 2019);
  assert.equal(spec.fuel.id, 'plug_in_hybrid');
  assert.equal(spec.fuel.chargeable, true);
  assert.equal(spec.fuelDescription, 'PETROL/PLUG-IN ELECTRIC HYBRID');
  assert.equal(spec.colour, 'BLUE');
  assert.equal(spec.engineCapacityCc, 1798);
  assert.equal(spec.co2Emissions, 78);
});

test('normalizeSpecification tolerates partial/unmappable data with nulls', () => {
  const spec = normalizeSpecification('AB12CDE', { make: 'ACME', fuelType: 'coal', year: 1700 }, { now });
  assert.equal(spec.make, 'ACME');
  assert.equal(spec.model, null);
  assert.equal(spec.year, null); // out of range
  assert.equal(spec.fuel, null); // unmappable
  assert.equal(spec.fuelDescription, 'coal'); // raw preserved
  assert.equal(spec.engineCapacityCc, null);
});

test('normalizeSpecification rejects a non-object payload', () => {
  assert.throws(() => normalizeSpecification('AB12CDE', 'nope', { now }), (e) => e.code === 'VEHICLE_LOOKUP_PROVIDER');
});

// --- createVehicleLookup: config ----------------------------------------

test('createVehicleLookup validates its config', () => {
  assert.throws(() => createVehicleLookup({}), (e) => e.code === 'VEHICLE_LOOKUP_CONFIG');
  assert.throws(() => createVehicleLookup({ provider: stubProvider(), fuelTypes: [] }), (e) => e.code === 'VEHICLE_LOOKUP_CONFIG');
  assert.throws(() => createVehicleLookup({ provider: stubProvider(), cache: {} }), (e) => e.code === 'VEHICLE_LOOKUP_CONFIG');
});

// --- createVehicleLookup: lookup ----------------------------------------

test('lookup fetches, normalizes and freezes a specification', async () => {
  const lookup = createVehicleLookup({ provider: stubProvider(), now });
  const spec = await lookup.lookup('ab12 cde'); // normalized to AB12CDE
  assert.equal(spec.registration, 'AB12CDE');
  assert.equal(spec.make, 'TOYOTA');
  assert.equal(spec.fuel.id, 'plug_in_hybrid');
  assert.equal(spec.source, 'provider');
  assert.equal(spec.fetchedAt, FIXED_NOW);
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.fuel));
  assert.throws(() => { spec.make = 'X'; }, TypeError);
});

test('lookup throws NOT_FOUND for an unknown plate', async () => {
  const lookup = createVehicleLookup({ provider: stubProvider(), now });
  await assert.rejects(() => lookup.lookup('ZZ99ZZZ'), (e) => e.code === 'VEHICLE_LOOKUP_NOT_FOUND');
});

test('lookup surfaces a provider failure as VEHICLE_LOOKUP_PROVIDER', async () => {
  const lookup = createVehicleLookup({
    provider: async () => { throw new Error('upstream 503'); },
    now,
  });
  await assert.rejects(() => lookup.lookup('AB12CDE'), (e) => e.code === 'VEHICLE_LOOKUP_PROVIDER' && /upstream 503/.test(e.message));
});

test('lookup validates the registration before calling the provider', async () => {
  let called = false;
  const lookup = createVehicleLookup({ provider: async () => { called = true; return {}; }, now });
  await assert.rejects(() => lookup.lookup('!!'), (e) => e.code === 'VEHICLE_LOOKUP_PLATE');
  assert.equal(called, false);
});

// --- caching -------------------------------------------------------------

test('lookup caches results and serves them without re-querying', async () => {
  let calls = 0;
  const provider = async (reg) => { calls += 1; return AUTHORITY[reg] ?? null; };
  const cache = new Map();
  const lookup = createVehicleLookup({ provider, cache, now });

  const first = await lookup.lookup('AB12 CDE');
  assert.equal(first.source, 'provider');
  const second = await lookup.lookup('ab12cde'); // same canonical key
  assert.equal(second.source, 'cache');
  assert.equal(calls, 1);
  assert.equal(cache.size, 1);

  // force bypasses the cache.
  const forced = await lookup.lookup('AB12CDE', { force: true });
  assert.equal(forced.source, 'provider');
  assert.equal(calls, 2);
});

test('cache entries expire after ttlMs', async () => {
  let clock = 1000;
  let calls = 0;
  const provider = async (reg) => { calls += 1; return AUTHORITY[reg] ?? null; };
  const lookup = createVehicleLookup({ provider, cache: new Map(), ttlMs: 500, now: () => clock });

  await lookup.lookup('AB12CDE');
  clock = 1400; // within ttl
  assert.equal((await lookup.lookup('AB12CDE')).source, 'cache');
  assert.equal(calls, 1);
  clock = 1600; // past ttl (1000 + 500)
  assert.equal((await lookup.lookup('AB12CDE')).source, 'provider');
  assert.equal(calls, 2);
});

// --- handle (HTTP-shaped adapter) ---------------------------------------

test('handle returns 200 with the vehicle on success', async () => {
  const lookup = createVehicleLookup({ provider: stubProvider(), now });
  const res = await lookup.handle({ registration: 'EV19XYZ' });
  assert.equal(res.status, 200);
  assert.equal(res.body.vehicle.fuel.id, 'battery_electric');
  assert.equal(res.body.vehicle.make, 'TESLA');
});

test('handle accepts a bare registration string', async () => {
  const lookup = createVehicleLookup({ provider: stubProvider(), now });
  const res = await lookup.handle('AB12CDE');
  assert.equal(res.status, 200);
  assert.equal(res.body.vehicle.registration, 'AB12CDE');
});

test('handle maps expected failures to status codes', async () => {
  const ok = createVehicleLookup({ provider: stubProvider(), now });
  assert.equal((await ok.handle({ registration: 'bad!' })).status, 400);
  assert.equal((await ok.handle({ registration: 'ZZ99ZZZ' })).status, 404);

  const failing = createVehicleLookup({ provider: async () => { throw new Error('down'); }, now });
  const res = await failing.handle({ plate: 'AB12CDE' });
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'VEHICLE_LOOKUP_PROVIDER');
});
