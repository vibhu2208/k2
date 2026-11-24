import React, { useEffect, useMemo, useState } from 'react';

const BOOT_LINES = [
  '[SYS] weighbridge-supervisor v2.4.1 — secure console',
  '[SYS] privilege gate: ENGINEERING / LICENSING',
  '[OK ] integrity check ……………………………… PASS',
  '[OK ] crypto envelope ……………………………… AES-256-GCM',
  '[OK ] module seal …………………………………… signed',
  '[WRN] interactive session — audit trail enabled',
  '',
  '╔══════════════════════════════════════════════════════════╗',
  '║   RESTRICTED ENGINEERING CONSOLE — ADMIN USE ONLY        ║',
  '╚══════════════════════════════════════════════════════════╝',
  '',
  'LICENSE / AUTHORIZATION NOTICE',
  '────────────────────────────────────────────────────────────',
  'This interface is licensed solely for authorized plant',
  'administrators and field engineers. Unauthorized access,',
  'modification, reverse engineering, or redistribution of',
  'weighbridge control software is prohibited.',
  '',
  'Site licence class ……… INDUSTRIAL / PRODUCTION',
  'Entitlement …………… supervisory diagnostics (read-only)',
  'Operator class ………… ENGINEERING',
  'Session policy ………… no writable process controls',
  '',
  'STATUS  ·  supervisory plane idle',
  'ACTION  ·  no mutable endpoints exposed in this shell',
  'NOTE   ·  weight-offset controls remain on the admin PIN gate',
  '',
  '>>> end of clearance brief — lock console when finished',
];

function padHex(n, width = 4) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

export default function EngineeringConsolePanel({ onLock }) {
  const [visibleCount, setVisibleCount] = useState(0);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    if (visibleCount >= BOOT_LINES.length) return undefined;
    const t = setTimeout(() => setVisibleCount((n) => n + 1), 55);
    return () => clearTimeout(t);
  }, [visibleCount]);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const telemetry = useMemo(() => {
    const epoch = Math.floor(Date.now() / 1000);
    return {
      node: `WB-NODE-${padHex((epoch >> 8) & 0xffff)}`,
      channel: `CH-${padHex(epoch & 0xff, 2)}`,
      seal: `0x${padHex((epoch * 7) & 0xffff)}${padHex((epoch * 13) & 0xffff)}`,
      uptime: clock.toLocaleTimeString('en-GB', { hour12: false }),
    };
  }, [clock]);

  const lines = BOOT_LINES.slice(0, visibleCount);
  const bootDone = visibleCount >= BOOT_LINES.length;

  return (
    <div className="mt-2 overflow-hidden rounded-md border border-emerald-900/70 bg-[#050805] shadow-[inset_0_0_40px_rgba(16,185,129,0.08)]">
      <div className="flex items-center justify-between border-b border-emerald-900/60 bg-[#0a120c] px-3 py-1.5">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-400/90">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          ENG · SECURE TTY
        </div>
        <div className="font-mono text-[10px] text-emerald-600/90">
          {telemetry.node} · {telemetry.channel}
        </div>
      </div>

      <div
        className="relative max-h-[340px] overflow-auto px-3 py-3 font-mono text-[11px] leading-relaxed text-emerald-400/95"
        style={{
          backgroundImage:
            'linear-gradient(rgba(16,185,129,0.04) 1px, transparent 1px)',
          backgroundSize: '100% 4px',
        }}
      >
        <pre className="whitespace-pre-wrap break-words">
          {lines.map((line, i) => (
            <div key={`${i}-${line.slice(0, 12)}`}>{line || ' '}</div>
          ))}
          {!bootDone && <span className="animate-pulse">█</span>}
        </pre>

        {bootDone && (
          <div className="mt-3 space-y-1 border-t border-emerald-900/50 pt-3 text-emerald-500/90">
            <div>LIC-SEAL …… {telemetry.seal}</div>
            <div>CLK ……… {telemetry.uptime} IST · session audited</div>
            <div className="text-amber-400/90">
              ⚠ ADMIN USE ONLY — no operational controls in this console
            </div>
            <div className="text-emerald-600">
              eng@weighbridge:~$ <span className="animate-pulse">_</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-emerald-900/60 bg-[#0a120c] px-3 py-2">
        <p className="font-mono text-[10px] text-emerald-700">
          clearance: engineering · writable: none
        </p>
        <button type="button" className="btn-ghost text-xs shrink-0" onClick={onLock}>
          Lock console
        </button>
      </div>
    </div>
  );
}
