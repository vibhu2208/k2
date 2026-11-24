import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import Badge from '../components/Badge.jsx';
import { fmtDate, fmtKg } from '../lib/format.js';

export default function OffsetData() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (from) params.from = new Date(from).toISOString();
      if (to) params.to = new Date(to).toISOString();
      const result = await api.getOffsetAudit(params);
      setData(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const pending = data?.lastCommand?.status === 'pending';
    if (!pending) return undefined;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [data?.lastCommand?.status, load]);

  async function onFetchFromPc() {
    setFetching(true);
    setError('');
    setMessage('');
    try {
      const body = {};
      if (from) body.from = new Date(from).toISOString();
      if (to) body.to = new Date(to).toISOString();
      const result = await api.fetchOffsetAudit(body);
      setMessage(
        result.message ||
          'Queued fetch — PC will push offset rows within ~30s if it has the updated app.',
      );
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setFetching(false);
    }
  }

  const rows = data?.rows || [];
  const lastCmd = data?.lastCommand;

  function commandTone(status) {
    if (status === 'applied') return 'success';
    if (status === 'failed') return 'danger';
    if (status === 'pending') return 'warning';
    return 'default';
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-semibold">Offset Data</h2>
          <p className="mt-1 text-sm text-slate-400">
            Weight increase audit from the weighbridge PC. Nothing is stored as Excel on the PC —
            click Fetch to pull the latest rows.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary text-xs"
            onClick={onFetchFromPc}
            disabled={fetching || loading}
          >
            {fetching ? 'Queuing…' : 'Fetch from PC'}
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
        <label className="text-xs text-slate-400">
          From
          <input
            type="datetime-local"
            className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-200"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="text-xs text-slate-400">
          To
          <input
            type="datetime-local"
            className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-200"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button type="button" className="btn-ghost text-xs" onClick={load} disabled={loading}>
          Apply filter
        </button>
      </div>

      {(data?.lastFetchAt || lastCmd) && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
          {data?.lastFetchAt && (
            <span>
              Last fetch: {fmtDate(data.lastFetchAt)}
              {data.lastFetchCount != null ? ` (${data.lastFetchCount} rows)` : ''}
            </span>
          )}
          {lastCmd && (
            <span className="inline-flex items-center gap-2">
              Last command: <Badge tone={commandTone(lastCmd.status)}>{lastCmd.status}</Badge>
              {lastCmd.error ? <span className="text-rose-400">{lastCmd.error}</span> : null}
            </span>
          )}
          <span>
            Showing {rows.length} of {data?.totalCount ?? 0} · total offset{' '}
            {fmtKg(data?.totalOffsetKg)} ({data?.totalOffsetTons ?? 0} t)
          </span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
          {message}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-900/80 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Slip</th>
              <th className="px-3 py-2">Truck</th>
              <th className="px-3 py-2">Pass</th>
              <th className="px-3 py-2">Offset</th>
              <th className="px-3 py-2">Raw → Adj</th>
              <th className="px-3 py-2">Net</th>
              <th className="px-3 py-2">Operator</th>
              <th className="px-3 py-2">Material</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-slate-500">
                  No offset rows yet. Click <span className="text-slate-300">Fetch from PC</span> to
                  pull data from the weighbridge.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="hover:bg-slate-900/50">
                  <td className="whitespace-nowrap px-3 py-2 text-slate-300">
                    {fmtDate(row.created_at)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-200">
                    {row.slip_number || '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-200">
                    {row.truck_number || '—'}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{row.pass || '—'}</td>
                  <td className="px-3 py-2 text-amber-300">
                    {fmtKg(row.offset_kg)}
                    {row.offset_tons != null ? (
                      <span className="ml-1 text-xs text-slate-500">({row.offset_tons} t)</span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-300">
                    {fmtKg(row.raw_weight_kg)} → {fmtKg(row.adjusted_weight_kg)}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{fmtKg(row.net_weight)}</td>
                  <td className="px-3 py-2 text-slate-300">{row.operator_name || '—'}</td>
                  <td className="px-3 py-2 text-slate-400">{row.material || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
