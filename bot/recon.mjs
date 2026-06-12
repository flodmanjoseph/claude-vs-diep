// M2 recon: how is diep.io renderable/readable? Hook getContext + WebSocket BEFORE game scripts,
// spawn, play a few seconds, then report: canvas context type, WS url, inbound/outbound opcode
// histogram, and a sample of the dominant clientbound packet. This decides the perception strategy.
import { launch, spawn, evidence } from './lib/launch.mjs';

const { ctx, page } = await launch();

await page.addInitScript(() => {
  const R = (window.__recon = {
    ctxTypes: [],
    wsUrl: null,
    inCounts: {}, // opcode -> count
    outCounts: {},
    inSizes: {}, // opcode -> last byte length
    sample: {}, // opcode -> first 64 bytes hex (inbound)
    inTotal: 0,
    outTotal: 0,
  });

  const origGC = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    if (!R.ctxTypes.includes(type)) R.ctxTypes.push(type);
    return origGC.call(this, type, ...args);
  };

  const toBytes = (data) => {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  };
  const hex = (u8, n) => Array.from(u8.slice(0, n)).map((b) => b.toString(16).padStart(2, '0')).join(' ');

  const OrigWS = window.WebSocket;
  function WS(url, protocols) {
    const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    if (String(url).includes('diep') || /\d+\.\d+\.\d+\.\d+/.test(String(url)) || true) R.wsUrl = R.wsUrl || String(url);
    ws.addEventListener('message', (ev) => {
      const u8 = toBytes(ev.data);
      if (!u8 || !u8.length) return;
      const op = u8[0];
      R.inTotal++;
      R.inCounts[op] = (R.inCounts[op] || 0) + 1;
      R.inSizes[op] = u8.length;
      if (!R.sample[op]) R.sample[op] = hex(u8, 64);
    });
    const origSend = ws.send.bind(ws);
    ws.send = function (data) {
      const u8 = toBytes(data);
      if (u8 && u8.length) { R.outTotal++; R.outCounts[u8[0]] = (R.outCounts[u8[0]] || 0) + 1; }
      return origSend(data);
    };
    return ws;
  }
  WS.prototype = OrigWS.prototype;
  WS.OPEN = OrigWS.OPEN; WS.CLOSED = OrigWS.CLOSED; WS.CONNECTING = OrigWS.CONNECTING; WS.CLOSING = OrigWS.CLOSING;
  window.WebSocket = WS;
});

const ok = await spawn(page, { name: 'claude' });
console.log('spawned:', ok);

// Play passively for a bit so packets flow (hold no keys; just observe).
await page.waitForTimeout(8_000);

const report = await page.evaluate(() => {
  const R = window.__recon;
  const top = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([op, n]) => `0x${(+op).toString(16).padStart(2, '0')}:${n}`);
  return {
    ctxTypes: R.ctxTypes,
    wsUrl: R.wsUrl,
    inTotal: R.inTotal,
    outTotal: R.outTotal,
    inboundOpcodes: top(R.inCounts),
    outboundOpcodes: top(R.outCounts),
    inboundSizes: R.inSizes,
    dominantSample: (() => {
      const e = Object.entries(R.inCounts).sort((a, b) => b[1] - a[1])[0];
      return e ? { op: `0x${(+e[0]).toString(16)}`, count: e[1], hex64: R.sample[e[0]] } : null;
    })(),
    samples: R.sample,
  };
});
console.log('RECON REPORT:');
console.log(JSON.stringify(report, null, 2));

await page.screenshot({ path: evidence('m2-recon.png') });
await ctx.close();
