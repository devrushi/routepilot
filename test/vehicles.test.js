import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVehicleRegistry,
  validateVehicle,
  validateVin,
  computeVinCheckDigit,
  FUEL_TYPES,
  EV_CONNECTOR_TYPES,
  VEHICLE_STATUSES,
  VehicleError,
} from '../src/vehicles.js';

// Valid VINs (check digit spliced to match, verified against the NHTSA sample).
const HONDA = '1HGBH41JXMN109186'; // reference VIN, check digit X
const TESLA = '5YJ3E1EA6KF000000'; // BEV
const PRIUS = 'JTDKARFU3J3000000'; // gasoline/hybrid
const FORD = '1FTFW1ET6DFC00000'; // gasoline truck
const BMW = 'WBA3B5C50FF000000';

// A fixed clock so derived model-year bounds and timestamps are deterministic.
const FIXED_NOW = Date.UTC(2024, 0, 1);
const now = () => FIXED_NOW;

function gasCar(overrides = {}) {
  return { vin: HONDA, make: 'Honda', model: 'Accord', year: 2021, fuelType: 'gasoline', ...overrides };
}
function evCar(overrides = {}) {
  return {
    vin: TESLA, make: 'Tesla', model: 'Model 3', year: 2019,
    fuelType: 'battery_electric', batteryKwh: 75, connectorType: 'nacs', ...overrides,
  };
}

// --- VIN -----------------------------------------------------------------

test('computeVinCheckDigit matches the NHTSA reference VIN', () => {
  assert.equal(computeVinCheckDigit(HONDA), 'X');
  assert.equal(computeVinCheckDigit(TESLA), '6');
  assert.throws(() => computeVinCheckDigit('short'), (e) => e.code === 'VEHICLE_VIN_FORMAT');
});

test('validateVin normalizes and enforces the check digit', () => {
  assert.equal(validateVin(' 1hgbh41jx-mn109186 '), HONDA); // lower-case, spaces, dashes tolerated
  assert.throws(() => validateVin('1HGBH41J0MN109186'), (e) => e.code === 'VEHICLE_VIN_INVALID'); // wrong check digit
});

test('VINs with illegal characters or lengths are a format error', () => {
  for (const bad of ['1HGBH41JXMN10918', '1HGBH41JXMN1091866', '1HGBH41IXMN109186', 123]) {
    assert.throws(() => validateVin(bad), (e) => e instanceof VehicleError && e.code === 'VEHICLE_VIN_FORMAT', String(bad));
  }
});

// --- validateVehicle: core fields ----------------------------------------

test('validateVehicle normalizes a combustion vehicle and derives a display name', () => {
  const v = validateVehicle(gasCar({ make: '  honda  ', model: 'accord', plate: 'abc 1234' }), { now });
  assert.equal(v.vin, HONDA);
  assert.equal(v.make, 'honda');
  assert.equal(v.displayName, '2021 honda accord');
  assert.deepEqual(v.plate, { value: 'ABC 1234', region: null });
  assert.deepEqual(v.fuel, {
    id: 'gasoline', label: 'Gasoline', category: 'combustion', combustion: true, chargeable: false,
  });
  assert.equal(v.battery, null);
});

test('validateVehicle prefers an explicit nickname over the derived display name', () => {
  const v = validateVehicle(gasCar({ nickname: 'Daily Driver' }), { now });
  assert.equal(v.nickname, 'Daily Driver');
  assert.equal(v.displayName, 'Daily Driver');
});

test('validateVehicle rejects missing text fields and out-of-range years', () => {
  assert.throws(() => validateVehicle(gasCar({ make: '' }), { now }), (e) => e.code === 'VEHICLE_FIELD');
  assert.throws(() => validateVehicle(gasCar({ year: 1800 }), { now }), (e) => e.code === 'VEHICLE_YEAR');
  assert.throws(() => validateVehicle(gasCar({ year: 2099 }), { now }), (e) => e.code === 'VEHICLE_YEAR');
  assert.throws(() => validateVehicle(gasCar({ year: 20.5 }), { now }), (e) => e.code === 'VEHICLE_YEAR');
  // maxYear defaults to next year relative to `now`.
  assert.equal(validateVehicle(gasCar({ year: 2025 }), { now }).year, 2025);
});

test('validateVehicle rejects a malformed plate', () => {
  assert.throws(() => validateVehicle(gasCar({ plate: 'no!good' }), { now }), (e) => e.code === 'VEHICLE_PLATE');
  const v = validateVehicle(gasCar({ plate: { value: '7abc123', region: 'us-ca' } }), { now });
  assert.deepEqual(v.plate, { value: '7ABC123', region: 'US-CA' });
});

// --- validateVehicle: fuel / EV fields -----------------------------------

test('every catalogued fuel type is accepted and categorized', () => {
  for (const fuel of FUEL_TYPES) {
    const extra = fuel.chargeable ? { batteryKwh: 60, connectorType: 'ccs1' } : {};
    const v = validateVehicle(gasCar({ vin: PRIUS, fuelType: fuel.id, ...extra }), { now });
    assert.equal(v.fuel.id, fuel.id);
    assert.equal(v.fuel.category, fuel.category);
  }
});

test('validateVehicle rejects an unknown fuel type', () => {
  assert.throws(() => validateVehicle(gasCar({ fuelType: 'coal' }), { now }), (e) => e.code === 'VEHICLE_FUEL_TYPE');
  assert.throws(() => validateVehicle(gasCar({ fuelType: undefined }), { now }), (e) => e.code === 'VEHICLE_FUEL_TYPE');
});

test('chargeable vehicles carry a normalized battery + connector sub-record', () => {
  const v = validateVehicle(evCar({ connectorType: 'NACS' }), { now });
  assert.equal(v.fuel.chargeable, true);
  assert.equal(v.battery.capacityKwh, 75);
  assert.deepEqual(v.battery.connector, { id: 'nacs', label: 'NACS (Tesla)', current: 'AC/DC' });
});

test('chargeable vehicles require both a battery capacity and a connector', () => {
  assert.throws(() => validateVehicle(evCar({ connectorType: undefined }), { now }), (e) => e.code === 'VEHICLE_CONNECTOR');
  assert.throws(() => validateVehicle(evCar({ connectorType: 'wireless' }), { now }), (e) => e.code === 'VEHICLE_CONNECTOR');
  assert.throws(() => validateVehicle(evCar({ batteryKwh: undefined }), { now }), (e) => e.code === 'VEHICLE_BATTERY');
  assert.throws(() => validateVehicle(evCar({ batteryKwh: 0 }), { now }), (e) => e.code === 'VEHICLE_BATTERY');
  assert.throws(() => validateVehicle(evCar({ batteryKwh: 9000 }), { now }), (e) => e.code === 'VEHICLE_BATTERY');
});

test('battery/connector fields are rejected on a non-chargeable vehicle', () => {
  assert.throws(
    () => validateVehicle(gasCar({ batteryKwh: 50 }), { now }),
    (e) => e.code === 'VEHICLE_FIELD',
  );
  assert.throws(
    () => validateVehicle(gasCar({ fuelType: 'hybrid', connectorType: 'j1772' }), { now }),
    (e) => e.code === 'VEHICLE_FIELD',
  );
});

test('a plug-in hybrid is chargeable and combustion at once', () => {
  const v = validateVehicle(gasCar({ vin: PRIUS, fuelType: 'plug_in_hybrid', batteryKwh: 12, connectorType: 'j1772' }), { now });
  assert.equal(v.fuel.category, 'hybrid');
  assert.equal(v.fuel.combustion, true);
  assert.equal(v.fuel.chargeable, true);
  assert.equal(v.battery.capacityKwh, 12);
});

// --- registry: multiple active vehicles ----------------------------------

test('a driver can register and keep multiple active vehicles', async () => {
  const reg = createVehicleRegistry({ now });
  const a = await reg.add('drv_1', gasCar(), { id: 'v1' });
  const b = await reg.add('drv_1', evCar(), { id: 'v2' });
  const c = await reg.add('drv_1', gasCar({ vin: FORD, make: 'Ford', model: 'F-150' }), { id: 'v3' });

  const active = await reg.listActive('drv_1');
  assert.deepEqual(active.map((v) => v.id), ['v1', 'v2', 'v3']);
  assert.ok(active.every((v) => v.status === 'active'));
  assert.ok(Object.isFrozen(a) && Object.isFrozen(b) && Object.isFrozen(c));
});

test('exactly one active vehicle is primary and it is the first added', async () => {
  const reg = createVehicleRegistry({ now });
  await reg.add('drv_1', gasCar(), { id: 'v1' });
  await reg.add('drv_1', evCar(), { id: 'v2' });
  const primaries = (await reg.listActive('drv_1')).filter((v) => v.primary);
  assert.equal(primaries.length, 1);
  assert.equal((await reg.getPrimary('drv_1')).id, 'v1');
});

test('setPrimary moves the flag and requires an active vehicle', async () => {
  const reg = createVehicleRegistry({ now });
  await reg.add('drv_1', gasCar(), { id: 'v1' });
  await reg.add('drv_1', evCar(), { id: 'v2' });
  await reg.setPrimary('drv_1', 'v2');
  assert.equal((await reg.getPrimary('drv_1')).id, 'v2');
  assert.equal((await reg.get('drv_1', 'v1')).primary, false);

  await reg.deactivate('drv_1', 'v2');
  await assert.rejects(() => reg.setPrimary('drv_1', 'v2'), (e) => e.code === 'VEHICLE_STATUS');
});

test('deactivating the primary re-assigns primary to another active vehicle', async () => {
  const reg = createVehicleRegistry({ now });
  await reg.add('drv_1', gasCar(), { id: 'v1' });
  await reg.add('drv_1', evCar(), { id: 'v2' });
  assert.equal((await reg.getPrimary('drv_1')).id, 'v1');

  await reg.deactivate('drv_1', 'v1');
  assert.equal((await reg.get('drv_1', 'v1')).status, 'inactive');
  assert.equal((await reg.get('drv_1', 'v1')).primary, false);
  assert.equal((await reg.getPrimary('drv_1')).id, 'v2'); // promoted

  // Reactivating does not steal primary back.
  await reg.activate('drv_1', 'v1');
  assert.equal((await reg.getPrimary('drv_1')).id, 'v2');
});

test('removing the primary promotes the next active vehicle', async () => {
  const reg = createVehicleRegistry({ now });
  await reg.add('drv_1', gasCar(), { id: 'v1' });
  await reg.add('drv_1', evCar(), { id: 'v2' });
  assert.equal(await reg.remove('drv_1', 'v1'), true);
  assert.equal((await reg.getPrimary('drv_1')).id, 'v2');
  assert.equal(await reg.remove('drv_1', 'nope'), false);
});

test('getPrimary is null when no vehicle is active', async () => {
  const reg = createVehicleRegistry({ now });
  await reg.add('drv_1', gasCar(), { id: 'v1' });
  await reg.deactivate('drv_1', 'v1');
  assert.equal(await reg.getPrimary('drv_1'), null);
  assert.deepEqual(await reg.listActive('drv_1'), []);
});

// --- registry: status, listing, isolation --------------------------------

test('vehicles are isolated per driver', async () => {
  const reg = createVehicleRegistry({ now });
  await reg.add('drv_1', gasCar(), { id: 'v1' });
  await reg.add('drv_2', evCar(), { id: 'v1' }); // same id, different driver
  assert.equal((await reg.list('drv_1')).length, 1);
  assert.equal((await reg.list('drv_2')).length, 1);
  assert.equal((await reg.getPrimary('drv_1')).fuel.id, 'gasoline');
  assert.equal((await reg.getPrimary('drv_2')).fuel.id, 'battery_electric');
  assert.deepEqual(await reg.list('unknown'), []);
});

test('list can filter by status and fuel category', async () => {
  const reg = createVehicleRegistry({ now });
  await reg.add('drv_1', gasCar(), { id: 'v1' });
  await reg.add('drv_1', evCar(), { id: 'v2' });
  await reg.retire('drv_1', 'v1');
  assert.deepEqual((await reg.list('drv_1', { status: 'retired' })).map((v) => v.id), ['v1']);
  assert.deepEqual((await reg.list('drv_1', { fuelCategory: 'electric' })).map((v) => v.id), ['v2']);
  await assert.rejects(() => reg.list('drv_1', { status: 'scrapped' }), (e) => e.code === 'VEHICLE_STATUS');
});

test('add rejects a duplicate active VIN but allows re-registering a retired one', async () => {
  const reg = createVehicleRegistry({ now });
  await reg.add('drv_1', gasCar(), { id: 'v1' });
  await assert.rejects(() => reg.add('drv_1', gasCar({ make: 'Honda2' }), { id: 'v2' }), (e) => e.code === 'VEHICLE_DUPLICATE');
  await reg.retire('drv_1', 'v1');
  const v3 = await reg.add('drv_1', gasCar(), { id: 'v3' }); // same VIN, previous retired
  assert.equal(v3.vin, HONDA);
});

test('add rejects a duplicate id and an unknown status', async () => {
  const reg = createVehicleRegistry({ now });
  await reg.add('drv_1', gasCar(), { id: 'v1' });
  await assert.rejects(() => reg.add('drv_1', evCar(), { id: 'v1' }), (e) => e.code === 'VEHICLE_DUPLICATE');
  await assert.rejects(() => reg.add('drv_1', evCar({ vin: BMW }), { status: 'wrecked' }), (e) => e.code === 'VEHICLE_STATUS');
});

test('a vehicle added inactive is not primary', async () => {
  const reg = createVehicleRegistry({ now });
  const v = await reg.add('drv_1', gasCar(), { id: 'v1', status: 'inactive' });
  assert.equal(v.primary, false);
  assert.equal(await reg.getPrimary('drv_1'), null);
});

// --- registry: update ----------------------------------------------------

test('update merges a patch and re-validates the whole vehicle', async () => {
  const reg = createVehicleRegistry({ now });
  await reg.add('drv_1', gasCar(), { id: 'v1' });
  const updated = await reg.update('drv_1', 'v1', { nickname: 'Old Reliable', plate: 'xyz789' });
  assert.equal(updated.nickname, 'Old Reliable');
  assert.equal(updated.displayName, 'Old Reliable');
  assert.deepEqual(updated.plate, { value: 'XYZ789', region: null });
  assert.equal(updated.fuel.id, 'gasoline'); // untouched fields preserved
});

test('update to a chargeable fuel type requires the EV fields in the same patch', async () => {
  const reg = createVehicleRegistry({ now });
  await reg.add('drv_1', gasCar({ vin: PRIUS }), { id: 'v1' });
  await assert.rejects(
    () => reg.update('drv_1', 'v1', { fuelType: 'battery_electric' }),
    (e) => e.code === 'VEHICLE_CONNECTOR',
  );
  const ev = await reg.update('drv_1', 'v1', { fuelType: 'battery_electric', batteryKwh: 50, connectorType: 'ccs1' });
  assert.equal(ev.fuel.id, 'battery_electric');
  assert.equal(ev.battery.capacityKwh, 50);

  // Switching back to combustion drops the battery record.
  const back = await reg.update('drv_1', 'v1', { fuelType: 'gasoline', batteryKwh: null, connectorType: null });
  assert.equal(back.battery, null);
});

test('update rejects changing a VIN to one already registered', async () => {
  const reg = createVehicleRegistry({ now });
  await reg.add('drv_1', gasCar(), { id: 'v1' });
  await reg.add('drv_1', evCar(), { id: 'v2' });
  await assert.rejects(() => reg.update('drv_1', 'v2', { vin: HONDA }), (e) => e.code === 'VEHICLE_DUPLICATE');
});

test('get and update on a missing vehicle throw VEHICLE_NOT_FOUND', async () => {
  const reg = createVehicleRegistry({ now });
  await assert.rejects(() => reg.get('drv_1', 'nope'), (e) => e.code === 'VEHICLE_NOT_FOUND');
  await assert.rejects(() => reg.update('drv_1', 'nope', {}), (e) => e.code === 'VEHICLE_NOT_FOUND');
});

test('registry surfaces stored records as frozen snapshots', async () => {
  const reg = createVehicleRegistry({ now });
  const v = await reg.add('drv_1', evCar(), { id: 'v1' });
  assert.ok(Object.isFrozen(v));
  assert.ok(Object.isFrozen(v.battery));
  assert.throws(() => { v.status = 'retired'; }, TypeError);
  // Mutating a snapshot does not affect the store.
  assert.equal((await reg.get('drv_1', 'v1')).status, 'active');
});

// --- config --------------------------------------------------------------

test('createVehicleRegistry validates its catalogue config', () => {
  assert.throws(() => createVehicleRegistry({ fuelTypes: [] }), (e) => e.code === 'VEHICLE_CONFIG');
  assert.throws(() => createVehicleRegistry({ connectorTypes: [] }), (e) => e.code === 'VEHICLE_CONFIG');
  assert.ok(VEHICLE_STATUSES.includes('active'));
  assert.ok(EV_CONNECTOR_TYPES.length > 0);
});

test('add requires a driverId', async () => {
  const reg = createVehicleRegistry({ now });
  await assert.rejects(() => reg.add('', gasCar()), (e) => e.code === 'VEHICLE_DRIVER');
});
