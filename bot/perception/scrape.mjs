// The canvas-scraping perception hook, as a string injected via addInitScript.
// It wraps the 2D context so every frame we get: all text draws (HUD/scoreboard/names)
// and all circle draws (tank bodies, bullets, round shapes) in screen coordinates.
//
// Own tank is always at screen center in diep.io, so screen coords double as relative coords.
// We expose window.__diep.frame = the last completed frame's captured primitives.

export const SCRAPE_INIT = () => {
  const S = (window.__diep = {
    frame: { texts: [], circles: [], polys: [], t: 0 },
    _buf: { texts: [], circles: [], polys: [], t: 0 },
    frameCount: 0,
    W: 1280,
    H: 720,
  });

  // Frames are delimited by requestAnimationFrame: at the start of each animation frame we
  // publish the buffer that accumulated during the previous frame and start a fresh one.
  // This is robust regardless of how the game clears the canvas between layers.
  const publish = () => {
    if (S._buf.texts.length || S._buf.circles.length || S._buf.polys.length) {
      S.frame = S._buf;
      S.frameCount++;
      S._buf = { texts: [], circles: [], polys: [], t: S.frameCount };
    }
  };
  const origRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return origRAF((ts) => { publish(); return cb(ts); });
  };

  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    const ctx = origGetContext.call(this, type, ...args);
    if (type !== '2d' || !ctx || ctx.__diepHooked) return ctx;
    ctx.__diepHooked = true;
    const canvas = this;

    const proto = ctx;
    const origArc = proto.arc.bind(proto);
    const origFill = proto.fill.bind(proto);
    const origStroke = proto.stroke.bind(proto);
    const origFillText = proto.fillText.bind(proto);
    const origBeginPath = proto.beginPath.bind(proto);
    const origMoveTo = proto.moveTo.bind(proto);
    const origLineTo = proto.lineTo.bind(proto);

    // Track the current sub-path as polygon vertices (screen space) for shape/tank detection.
    let pathPts = [];
    let lastArc = null; // {x,y,r} in screen space, pending a fill/stroke

    const xf = (x, y) => {
      const m = proto.getTransform();
      return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f, s: Math.hypot(m.a, m.b) };
    };

    proto.beginPath = function () { pathPts = []; lastArc = null; return origBeginPath(); };
    proto.moveTo = function (x, y) { const p = xf(x, y); pathPts.push(p); return origMoveTo(x, y); };
    proto.lineTo = function (x, y) { const p = xf(x, y); pathPts.push(p); return origLineTo(x, y); };
    proto.arc = function (x, y, r, a0, a1, ccw) {
      const p = xf(x, y);
      lastArc = { x: p.x, y: p.y, r: r * p.s };
      return origArc(x, y, r, a0, a1, ccw);
    };

    const recordFill = (style) => {
      const fs = typeof style === 'string' ? style : '';
      if (lastArc && lastArc.r > 1) {
        S._buf.circles.push({ x: Math.round(lastArc.x), y: Math.round(lastArc.y), r: Math.round(lastArc.r), c: fs });
      } else if (pathPts.length >= 3) {
        // Polygon (shape body or tank barrel). Compute centroid + rough radius + vertex count.
        let cx = 0, cy = 0;
        for (const p of pathPts) { cx += p.x; cy += p.y; }
        cx /= pathPts.length; cy /= pathPts.length;
        let rmax = 0;
        for (const p of pathPts) rmax = Math.max(rmax, Math.hypot(p.x - cx, p.y - cy));
        if (rmax > 2 && rmax < 2000) {
          S._buf.polys.push({ x: Math.round(cx), y: Math.round(cy), r: Math.round(rmax), n: pathPts.length, c: fs });
        }
      }
      lastArc = null;
    };
    proto.fill = function (...a) { recordFill(proto.fillStyle); return origFill(...a); };
    proto.stroke = function (...a) { return origStroke(...a); };

    proto.fillText = function (text, x, y, ...rest) {
      const p = xf(x, y);
      if (text != null && String(text).length) {
        S._buf.texts.push({ t: String(text), x: Math.round(p.x), y: Math.round(p.y), font: proto.font, c: typeof proto.fillStyle === 'string' ? proto.fillStyle : '' });
      }
      return origFillText(text, x, y, ...rest);
    };

    return ctx;
  };
};
