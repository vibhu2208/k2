import React, { useState } from 'react';
import { api } from '../api/client.js';

const JOBS = [
  { pass: 'arrival', slot: 1, label: 'Arrival cam 1', timeField: 'timestamp_in' },
  { pass: 'arrival', slot: 2, label: 'Arrival cam 2', timeField: 'timestamp_in' },
  { pass: 'departure', slot: 1, label: 'Departure cam 1', timeField: 'timestamp_out' },
  { pass: 'departure', slot: 2, label: 'Departure cam 2', timeField: 'timestamp_out' },
];

const STOP_RE = /GEMINI_API_KEY|not in the fill vehicle list|S3 not configured|free tier|Enable billing/i;

/** Map API errors to UI-safe text (avoid leaking config/key hints). */
function publicImageError(message) {
  const raw = String(message || '').trim() || 'Could not create image';
  if (/GEMINI_API_KEY/i.test(raw)) return 'Image generation is not configured';
  if (/S3 not configured/i.test(raw)) return 'Photo storage is not configured';
  if (/free tier|Enable billing/i.test(raw)) return 'Image generation quota exceeded';
  if (/Too many image generation requests/i.test(raw)) return 'Image generation rate limit hit — try again shortly';
  return raw;
}

/**
 * Create AI fill images for one remote trip (arrival/departure cams with times).
 * Shared by the per-row button and bulk "Create images for all".
 */
export async function createTripImages(trip, { onStatus } = {}) {
  const notes = [];
  let changed = false;
  let toldDeparture = false;
  let fatal = null;

  if (!trip?.id) {
    return { changed: false, notes: ['Missing trip id'], fatal: 'Missing trip id', note: 'Missing trip id' };
  }

  for (const job of JOBS) {
    if (!trip?.[job.timeField]) {
      if (job.timeField === 'timestamp_out' && !toldDeparture) {
        notes.push('Departure is waiting for an out time');
        toldDeparture = true;
      }
      if (job.timeField === 'timestamp_in') {
        notes.push(`${job.label}: this trip has no in time`);
      }
      continue;
    }
    onStatus?.(`${job.label}…`);
    try {
      // eslint-disable-next-line no-await-in-loop
      await api.generateRemoteTripPhoto(trip.id, { pass: job.pass, slot: job.slot });
      changed = true;
    } catch (err) {
      const safe = publicImageError(err.message);
      const stop = STOP_RE.test(err.message || '') || /rate limit/i.test(safe);
      notes.push(stop ? safe : `${job.label}: ${safe}`);
      if (stop) {
        fatal = safe;
        break;
      }
    }
  }

  return { changed, notes, fatal, note: notes.join(' · ') };
}

export default function CreateTripImagesButton({ trip, disabled, onBusy, onDone }) {
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const busy = Boolean(status);

  async function run() {
    setNote('');
    onBusy?.(true);
    try {
      const result = await createTripImages(trip, { onStatus: setStatus });
      setNote(result.note);
      if (result.changed) onDone?.();
    } finally {
      setStatus('');
      onBusy?.(false);
    }
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        className="text-brand-300 hover:underline text-xs disabled:opacity-50 whitespace-nowrap"
        disabled={disabled || busy || !trip?.id}
        onClick={run}
      >
        {busy ? status : 'Create images'}
      </button>
      {note && <div className="text-[10px] text-amber-300 max-w-[16rem]">{note}</div>}
    </div>
  );
}
