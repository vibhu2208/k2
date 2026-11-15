import React, { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import {
  defaultFillScheduleNotes,
  emptyFillScheduleWindow,
  formatScheduleTimeRange,
  normalizeFillScheduleNotes,
} from '../lib/fillScheduleNotes.js';

function vehiclesToText(list) {
  return (Array.isArray(list) ? list : []).join(' ');
}

function textToVehicles(text) {
  return String(text || '')
    .split(/[\s,;/|]+/)
    .map((v) => v.toUpperCase().replace(/[\s-]/g, ''))
    .filter(Boolean);
}

function VehicleChips({ items, tone = 'slate' }) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return <span className="text-slate-500 text-sm">None</span>;
  }
  const toneClass =
    tone === 'amber'
      ? 'border-amber-800/60 bg-amber-950/40 text-amber-100'
      : tone === 'emerald'
        ? 'border-emerald-800/60 bg-emerald-950/40 text-emerald-100'
        : 'border-slate-700 bg-slate-800/80 text-slate-100';
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((v) => (
        <span
          key={v}
          className={`rounded border px-2 py-0.5 font-mono text-xs tracking-wide ${toneClass}`}
        >
          {v}
        </span>
      ))}
    </div>
  );
}

function ScheduleWindowCard({ window: win }) {
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-950/40 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-base font-semibold text-white">{win.label}</h4>
          <p className="text-sm text-brand-300 mt-0.5 font-medium">
            {formatScheduleTimeRange(win.time_start, win.time_end)}
          </p>
        </div>
        {win.rdf_owner ? (
          <span className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-200">
            RDF · {win.rdf_owner}
          </span>
        ) : null}
      </div>

      {win.rdf_vehicles?.length ? (
        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            RDF vehicles{win.rdf_owner ? ` (${win.rdf_owner})` : ''}
          </p>
          <VehicleChips items={win.rdf_vehicles} tone="amber" />
        </div>
      ) : null}

      {win.compost_vehicles?.length ? (
        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            Compost vehicles
            {win.compost_note ? ` · ${win.compost_note}` : ''}
          </p>
          <VehicleChips items={win.compost_vehicles} tone="emerald" />
        </div>
      ) : null}

      {win.extra_note ? (
        <p className="text-sm text-slate-300 border-t border-slate-800 pt-3">{win.extra_note}</p>
      ) : null}
    </article>
  );
}

function ScheduleWindowEditor({ window: win, onChange, onRemove }) {
  function patch(partial) {
    onChange({ ...win, ...partial });
  }

  return (
    <div className="rounded-lg border border-slate-800 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <input
          className="field-input text-sm font-medium min-w-[12rem] flex-1"
          value={win.label}
          placeholder="Window label"
          onChange={(e) => patch({ label: e.target.value })}
        />
        <button type="button" className="btn-ghost text-red-300" onClick={onRemove}>
          Remove
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Start
          <input
            type="time"
            className="field-input text-sm"
            value={win.time_start}
            onChange={(e) => patch({ time_start: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          End
          <input
            type="time"
            className="field-input text-sm"
            value={win.time_end}
            onChange={(e) => patch({ time_end: e.target.value })}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        RDF owner / contractor
        <input
          className="field-input text-sm"
          value={win.rdf_owner}
          placeholder="e.g. Rounaq Ali"
          onChange={(e) => patch({ rdf_owner: e.target.value })}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        RDF vehicle numbers (space or comma separated)
        <textarea
          className="field-input text-sm min-h-[2.75rem] font-mono"
          value={vehiclesToText(win.rdf_vehicles)}
          placeholder="HR65A7668 HR58D8715 HR58E3515"
          onChange={(e) => patch({ rdf_vehicles: textToVehicles(e.target.value) })}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        Compost vehicle numbers
        <textarea
          className="field-input text-sm min-h-[2.75rem] font-mono"
          value={vehiclesToText(win.compost_vehicles)}
          placeholder="HR38AC3336 HR38X3951 HR38X4672 HR38X7059"
          onChange={(e) => patch({ compost_vehicles: textToVehicles(e.target.value) })}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        Compost note
        <input
          className="field-input text-sm"
          value={win.compost_note}
          placeholder="e.g. Compost 2nd trips"
          onChange={(e) => patch({ compost_note: e.target.value })}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        Extra note
        <textarea
          className="field-input text-sm min-h-[2.5rem]"
          value={win.extra_note}
          placeholder="Anything else for this window"
          onChange={(e) => patch({ extra_note: e.target.value })}
        />
      </label>
    </div>
  );
}

export default function FillScheduleNotesModal({ open, notes, onClose, onSaved }) {
  const [tab, setTab] = useState('view');
  const [draft, setDraft] = useState(() => normalizeFillScheduleNotes(notes));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setDraft(normalizeFillScheduleNotes(notes));
    setTab('view');
    setError('');
  }, [open, notes]);

  if (!open) return null;

  async function save() {
    setSaving(true);
    setError('');
    try {
      const next = normalizeFillScheduleNotes(draft);
      if (!next.length) throw new Error('Add at least one schedule window');
      await api.putList('fill_schedule_notes', next);
      onSaved?.(next);
      setDraft(next);
      setTab('view');
    } catch (err) {
      setError(err.message || 'Could not save schedule notes');
    } finally {
      setSaving(false);
    }
  }

  function resetDefaults() {
    setDraft(defaultFillScheduleNotes());
    setError('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-6">
      <div className="card flex w-full max-w-4xl max-h-[95vh] flex-col overflow-hidden p-5 sm:p-7 space-y-4">
        <div className="flex shrink-0 items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-semibold sm:text-2xl">Fill schedule notes</h3>
            <p className="text-sm text-slate-400 mt-1 max-w-2xl">
              RDF / compost windows used when filling blocked slips. Edit anytime from Configuration.
            </p>
          </div>
          <button type="button" className="btn-ghost shrink-0" onClick={onClose} disabled={saving}>
            Close
          </button>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            className={tab === 'view' ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setTab('view')}
          >
            Notes
          </button>
          <button
            type="button"
            className={tab === 'config' ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setTab('config')}
          >
            Configuration
          </button>
        </div>

        {error ? <p className="shrink-0 text-sm text-red-400">{error}</p> : null}

        <div className="min-h-0 flex-1 overflow-y-auto space-y-3 pr-1">
          {tab === 'view' ? (
            draft.map((win) => <ScheduleWindowCard key={win.id} window={win} />)
          ) : (
            <>
              <p className="text-sm text-slate-400">
                Change times, owners, vehicle lists, or add another window. Vehicle numbers can be
                short suffixes (7668) or full plates.
              </p>
              {draft.map((win, index) => (
                <ScheduleWindowEditor
                  key={win.id}
                  window={win}
                  onChange={(next) =>
                    setDraft((prev) => prev.map((w, i) => (i === index ? next : w)))
                  }
                  onRemove={() => setDraft((prev) => prev.filter((_, i) => i !== index))}
                />
              ))}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setDraft((prev) => [...prev, emptyFillScheduleWindow()])}
                >
                  Add window
                </button>
                <button type="button" className="btn-ghost" onClick={resetDefaults}>
                  Reset to defaults
                </button>
              </div>
            </>
          )}
        </div>

        {tab === 'config' ? (
          <div className="flex shrink-0 justify-end gap-2 border-t border-slate-800 pt-3">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save schedule'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
