'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { updateRemoteTrip } = require('./remoteTripService');

const LISTS = {
  materials: ['RDF'],
  customers: ['MCG'],
  destinations: ['PALI'],
  operators: ['MANISH'],
};

function mockQuery(initial) {
  let current = initial ? { ...initial } : null;
  const queryFn = async (sql, params) => {
    if (/information_schema\.columns/.test(sql)) {
      return {
        rows: [
          { column_name: 'release_at', is_nullable: 'YES' },
          { column_name: 'ticket_status', is_nullable: 'NO' },
          { column_name: 'tare_weight', is_nullable: 'YES' },
          { column_name: 'gross_weight', is_nullable: 'YES' },
          { column_name: 'timestamp_out', is_nullable: 'YES' },
          { column_name: 'company', is_nullable: 'NO' },
        ],
      };
    }
    if (/SELECT \* FROM remote_trips WHERE id/.test(sql)) {
      return { rows: current ? [current] : [] };
    }
    if (/UPDATE remote_trips[\s\S]*SET/.test(sql)) {
      current = {
        ...current,
        truck_number: params[1],
        customer_name: params[2],
        destination: params[3],
        material: params[4],
        operator_name: params[5],
        company: params[6],
        tare_weight: params[7],
        gross_weight: params[8],
        timestamp_in: params[9],
        timestamp_out: params[10],
        ticket_status: params[11],
        status: params[12],
        rfid_tag: params[13],
        transporter: params[14],
        vehicle_type: params[15],
        synced_to_local: params[16],
        release_at: params[17],
        synced_at: params[18],
        mcg_status: params[19],
      };
      return { rows: [current] };
    }
    if (/DELETE FROM transactions_mirror|INSERT INTO transactions_mirror|pg_notify/.test(sql)) {
      return { rows: [] };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 140)}`);
  };
  return { queryFn, getCurrent: () => current };
}

test('update keeps Waiting hold when close time stays in the future', async () => {
  const futureOut = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const futureIn = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { queryFn } = mockQuery({
    id: 'rt-wait',
    slip_number: 'WB1276',
    truck_number: 'HR38AL1111',
    vehicle_type: 'HYWA',
    ticket_status: 'CLOSED',
    status: 'captured',
    material: 'RDF',
    customer_name: 'MCG',
    destination: 'PALI',
    operator_name: 'MANISH',
    tare_weight: 12000,
    gross_weight: 28000,
    timestamp_in: futureIn,
    timestamp_out: futureOut,
    synced_to_local: true,
    release_at: futureOut,
    synced_at: null,
    local_id: null,
    mcg_status: 'waiting',
    rfid_tag: null,
    transporter: null,
    arrival_photo_1: null,
    arrival_photo_2: null,
    arrival_photo_3: null,
    departure_photo_1: null,
    departure_photo_2: null,
    departure_photo_3: null,
  });

  const out = await updateRemoteTrip(
    queryFn,
    'rt-wait',
    {
      truck_number: 'HR38AL2222',
      customer_name: 'MCG',
      destination: 'PALI',
      material: 'RDF',
      operator_name: 'MANISH',
      vehicle_type: 'HYWA',
      ticket_status: 'CLOSED',
      tare_weight: 12100,
      gross_weight: 28100,
      timestamp_in: futureIn,
      timestamp_out: futureOut,
    },
    { lists: LISTS, siteId: 'WB-04' },
  );

  assert.equal(out.trip.truck_number, 'HR38AL2222');
  assert.equal(out.trip.company, 'MKG GREEN ENERGY');
  assert.equal(out.trip.mcg_status, 'waiting');
  assert.equal(out.trip.synced_to_local, true);
  assert.equal(out.needsLocalEdit, false);
  assert.ok(out.trip.release_at);
});

test('update keeps Pending trips editable without PC edit command', async () => {
  const pastIn = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const pastOut = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { queryFn } = mockQuery({
    id: 'rt-pending',
    slip_number: 'WB1277',
    truck_number: 'HR38AL3333',
    vehicle_type: 'HYWA',
    ticket_status: 'CLOSED',
    status: 'captured',
    material: 'RDF',
    customer_name: 'MCG',
    destination: 'PALI',
    operator_name: 'MANISH',
    tare_weight: 12000,
    gross_weight: 28000,
    timestamp_in: pastIn,
    timestamp_out: pastOut,
    synced_to_local: false,
    release_at: null,
    synced_at: null,
    local_id: null,
    mcg_status: 'pending',
    rfid_tag: null,
    transporter: null,
    arrival_photo_1: null,
    arrival_photo_2: null,
    arrival_photo_3: null,
    departure_photo_1: null,
    departure_photo_2: null,
    departure_photo_3: null,
  });

  const out = await updateRemoteTrip(
    queryFn,
    'rt-pending',
    {
      truck_number: 'HR38AL3333',
      customer_name: 'MCG',
      destination: 'PALI',
      material: 'RDF',
      operator_name: 'MANISH',
      vehicle_type: 'HYWA',
      ticket_status: 'CLOSED',
      tare_weight: 12500,
      gross_weight: 29000,
      timestamp_in: pastIn,
      timestamp_out: pastOut,
    },
    { lists: LISTS, siteId: 'WB-04' },
  );

  assert.equal(out.trip.tare_weight, 12500);
  assert.equal(out.trip.synced_to_local, false);
  assert.equal(out.needsLocalEdit, false);
});

test('update rejects cancelled trips', async () => {
  const { queryFn } = mockQuery({
    id: 'rt-c',
    slip_number: 'WB1278',
    ticket_status: 'CANCELLED',
    synced_to_local: false,
  });
  await assert.rejects(
    () => updateRemoteTrip(queryFn, 'rt-c', {}, { lists: LISTS, siteId: 'WB-04' }),
    /cancelled/i,
  );
});
