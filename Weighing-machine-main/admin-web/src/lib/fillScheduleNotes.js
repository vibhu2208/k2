/** Night / morning / evening fill windows shown on Fill Blocked Slips. */

/** Short suffix → full plate for schedule notes. */
const KNOWN_PLATES = {
  7668: 'HR65A7668',
  8715: 'HR58D8715',
  3515: 'HR58E3515',
  3748: 'HR69E3748',
  5649: 'HR69D5649',
  3093: 'HR38AB3093',
  5656: 'UP14HT5656',
  7930: 'HR58E7930',
  9786: 'PB13BE9786',
  5799: 'HR58E5799',
  3336: 'HR38AC3336',
  3951: 'HR38X3951',
  4672: 'HR38X4672',
  7059: 'HR38X7059',
};

function cleanText(value) {
  return String(value || '').trim();
}

function expandPlate(value) {
  const plate = cleanText(value).toUpperCase().replace(/[\s-]/g, '');
  if (!plate) return '';
  if (KNOWN_PLATES[plate]) return KNOWN_PLATES[plate];
  const suffix = plate.replace(/\D/g, '').slice(-4);
  if (suffix && KNOWN_PLATES[suffix] && (plate === suffix || plate.endsWith(suffix))) {
    // Expand bare suffixes; leave already-full different plates alone.
    if (/^\d{4}$/.test(plate)) return KNOWN_PLATES[suffix];
  }
  return plate;
}

function cleanVehicles(raw) {
  const parts = Array.isArray(raw)
    ? raw
    : String(raw || '').split(/[\s,;/|]+/);
  return [...new Set(parts.map(expandPlate).filter(Boolean))];
}

function newWindowId() {
  return `win_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function defaultFillScheduleNotes() {
  return [
    {
      id: 'night-rounaq',
      label: 'Night RDF + Compost',
      time_start: '00:00',
      time_end: '04:00',
      rdf_owner: 'Rounaq Ali',
      rdf_vehicles: ['HR65A7668', 'HR58D8715', 'HR58E3515', 'HR69E3748', 'HR69D5649'],
      compost_vehicles: ['HR38AC3336', 'HR38X3951', 'HR38X4672', 'HR38X7059'],
      compost_note: 'Compost 1st trips (same window)',
      extra_note: '',
    },
    {
      id: 'morning-compost-2',
      label: 'Morning Compost 2nd trips',
      time_start: '05:00',
      time_end: '07:00',
      rdf_owner: '',
      rdf_vehicles: [],
      compost_vehicles: ['HR38AC3336', 'HR38X3951', 'HR38X4672', 'HR38X7059'],
      compost_note: 'Compost 2nd trips',
      extra_note: '',
    },
    {
      id: 'evening-aditya',
      label: 'Evening RDF + Compost',
      time_start: '19:00',
      time_end: '22:30',
      rdf_owner: 'Aditya Malik',
      rdf_vehicles: ['HR38AB3093', 'UP14HT5656', 'HR58E7930', 'PB13BE9786', 'HR58E5799'],
      compost_vehicles: ['HR38AC3336', 'HR38X3951', 'HR38X4672', 'HR38X7059'],
      compost_note: '',
      extra_note: '',
    },
  ];
}

export function normalizeFillScheduleNotes(items) {
  const source = Array.isArray(items) && items.length ? items : defaultFillScheduleNotes();
  const out = [];
  const seen = new Set();
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue;
    let id = cleanText(raw.id) || newWindowId();
    if (seen.has(id)) id = newWindowId();
    seen.add(id);
    out.push({
      id,
      label: cleanText(raw.label) || 'Schedule window',
      time_start: cleanText(raw.time_start || raw.start || '00:00') || '00:00',
      time_end: cleanText(raw.time_end || raw.end || '00:00') || '00:00',
      rdf_owner: cleanText(raw.rdf_owner || raw.rdfOwner || ''),
      rdf_vehicles: cleanVehicles(raw.rdf_vehicles || raw.rdfVehicles || []),
      compost_vehicles: cleanVehicles(raw.compost_vehicles || raw.compostVehicles || []),
      compost_note: cleanText(raw.compost_note || raw.compostNote || ''),
      extra_note: cleanText(raw.extra_note || raw.extraNote || raw.notes || ''),
    });
  }
  return out.length ? out : defaultFillScheduleNotes();
}

export function emptyFillScheduleWindow() {
  return {
    id: newWindowId(),
    label: 'New window',
    time_start: '00:00',
    time_end: '00:00',
    rdf_owner: '',
    rdf_vehicles: [],
    compost_vehicles: [],
    compost_note: '',
    extra_note: '',
  };
}

export function formatScheduleTimeRange(start, end) {
  const a = cleanText(start) || '—';
  const b = cleanText(end) || '—';
  return `${a} – ${b}`;
}
