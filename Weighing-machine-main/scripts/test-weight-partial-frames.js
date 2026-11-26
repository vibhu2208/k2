'use strict';

/**
 * Unit-style checks for weighbridge partial-frame rejection (no serial port).
 */
const WeightBridgeService = require('../backend/services/WeightBridgeService');

const bridge = new WeightBridgeService({ port: 'COM_TEST' });
let accepted = [];

bridge.onWeightChanged((p) => {
  accepted.push({ weight: p.weight, stable: p.stableWeight, isStable: p.isStable });
});

function feed(chunks) {
  accepted = [];
  bridge.latestWeight = 0;
  bridge.latestStableWeight = 0;
  bridge.latestRawWeight = 0;
  bridge.buffer = [];
  bridge.isStable = false;
  bridge.textBuffer = '';
  bridge.lastEmittedWeight = null;
  bridge.lastEmittedIsStable = false;
  for (const chunk of chunks) {
    bridge._handleData(Buffer.from(chunk, 'utf8'));
  }
  return accepted.map((a) => a.weight);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Full frames with newlines
{
  const weights = feed(['011160\r\n', '011160\r\n', '011160\r\n', '011160\r\n', '011160\r\n']);
  assert(weights.includes(11160), `expected 11160, got ${weights}`);
  assert(!weights.includes(60), `should not accept fragment 60, got ${weights}`);
}

// Interleaved fragments while full weight is present
{
  const weights = feed([
    '011160\r\n',
    '011160\r\n',
    '011160\r\n',
    '011160\r\n',
    '011160\r\n',
    '60\r\n',
    '160\r\n',
    '0111\r\n',
    '011160\r\n',
  ]);
  assert(weights.every((w) => w === 11160 || w === 0), `unexpected weights ${weights}`);
  assert(bridge.latestStableWeight === 11160, `stable should stay 11160, got ${bridge.latestStableWeight}`);
}

// Undelimited stream split across chunks (the real bug)
{
  accepted = [];
  bridge.latestWeight = 0;
  bridge.latestStableWeight = 0;
  bridge.buffer = [];
  bridge.isStable = false;
  bridge.textBuffer = '';
  bridge.lastEmittedWeight = null;
  bridge.lastEmittedIsStable = false;
  bridge._handleData(Buffer.from('0111', 'utf8'));
  bridge._handleData(Buffer.from('60', 'utf8'));
  bridge._handleData(Buffer.from('011160', 'utf8'));
  const weights = accepted.map((a) => a.weight);
  assert(weights.includes(11160), `undelimited should parse 11160, got ${weights}`);
  assert(!weights.includes(60) || bridge.latestWeight === 11160, `should end at 11160, got ${weights}`);
}

// Idle near-zero full frames still accepted
{
  const weights = feed(['-000100\r\n', '-000100\r\n', '-000100\r\n', '-000100\r\n', '-000100\r\n']);
  assert(
    weights.includes(-100) || weights.includes(100),
    `expected idle ±100, got ${weights}`,
  );
}

// Continuous STX stream split across chunks (site indicator pattern)
{
  accepted = [];
  bridge.latestWeight = 0;
  bridge.latestStableWeight = 0;
  bridge.buffer = [];
  bridge.isStable = false;
  bridge.textBuffer = '';
  bridge.stxFrameBuffer = null;
  bridge.lastEmittedWeight = null;
  bridge.lastEmittedIsStable = false;
  bridge._handleData(Buffer.from('\x02', 'utf8'));
  bridge._handleData(Buffer.from('   52', 'utf8'));
  bridge._handleData(Buffer.from('450 ', 'utf8'));
  bridge._handleData(Buffer.from('\x02   52460 ', 'utf8'));
  const weights = accepted.map((a) => a.weight);
  assert(weights.includes(52450), `STX chunked should parse 52450, got ${weights}`);
  assert(weights.includes(52460), `STX chunked should parse 52460, got ${weights}`);
  assert(!weights.includes(52), `should not accept fragment 52, got ${weights}`);
  assert(!weights.includes(524), `should not accept fragment 524, got ${weights}`);
}

// Next STX must not flush incomplete digit fragments
{
  accepted = [];
  bridge.latestWeight = 0;
  bridge.latestStableWeight = 0;
  bridge.buffer = [];
  bridge.isStable = false;
  bridge.textBuffer = '';
  bridge.stxFrameBuffer = null;
  bridge.lastEmittedWeight = null;
  bridge.lastEmittedIsStable = false;
  bridge._handleData(Buffer.from('\x02   52', 'utf8'));
  bridge._handleData(Buffer.from('\x02   18980 ', 'utf8'));
  const weights = accepted.map((a) => a.weight);
  assert(weights.includes(18980), `expected 18980, got ${weights}`);
  assert(!weights.includes(52), `incomplete STX fragment must not emit, got ${weights}`);
}

// Empty-scale STX leftovers ("0") must clear a stuck positive weight
{
  accepted = [];
  bridge.latestWeight = 1180;
  bridge.latestStableWeight = 1180;
  bridge.buffer = [1180, 1180, 1180, 1180, 1180];
  bridge.isStable = true;
  bridge.textBuffer = '';
  bridge.stxFrameBuffer = null;
  bridge.lastEmittedWeight = 1180;
  bridge.lastEmittedIsStable = true;
  bridge.zeroCandidateSince = Date.now() - 10000;
  bridge._handleData(Buffer.from('\x020', 'utf8'));
  bridge._handleData(Buffer.from('\x02', 'utf8'));
  const weights = accepted.map((a) => a.weight);
  assert(weights.includes(0), `zero-like STX should clear stuck weight, got ${weights}`);
  assert(bridge.latestWeight === 0, `latestWeight should be 0, got ${bridge.latestWeight}`);
  assert(bridge.latestStableWeight === 0, `stable should clear, got ${bridge.latestStableWeight}`);
}

// Stale watchdog forces empty when frames stop arriving
{
  accepted = [];
  bridge.latestWeight = 12290;
  bridge.latestStableWeight = 12290;
  bridge.buffer = [12290, 12290, 12290, 12290, 12290];
  bridge.isStable = true;
  bridge.lastEmittedWeight = 12290;
  bridge.zeroCandidateSince = null;
  bridge._onStaleWeightTimeout();
  const weights = accepted.map((a) => a.weight);
  assert(weights.includes(0), `stale timeout should force 0, got ${weights}`);
  assert(bridge.latestWeight === 0, `stale latestWeight 0, got ${bridge.latestWeight}`);
}

console.log('WeightBridge partial-frame tests OK');
