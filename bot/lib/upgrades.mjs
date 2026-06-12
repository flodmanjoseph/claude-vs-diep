// Class-upgrade helpers. The upgrade tiles are canvas-drawn in a top-left grid; diep requires
// TRUSTED clicks for UI, and overlays (#dimmer/#screen-holder) intercept clicks, so we neutralize
// their pointer-events once, then use Playwright's real mouse to move+click the tile.

// Tile grid geometry (1280x720 viewport): two columns, rows step ~73px.
export const tileXY = (index) => ({ x: 64 + (index % 2) * 78, y: 81 + Math.floor(index / 2) * 73 });

export async function enableTrustedCanvasClicks(page) {
  await page.evaluate(() => {
    for (const id of ['dimmer', 'screen-holder']) { const e = document.getElementById(id); if (e) e.style.pointerEvents = 'none'; }
  }).catch(() => {});
}

export async function clickTile(page, index) {
  const { x, y } = tileXY(index);
  await page.mouse.move(x, y, { steps: 5 }).catch(() => {});
  await page.waitForTimeout(90);
  await page.mouse.down().catch(() => {});
  await page.waitForTimeout(70);
  await page.mouse.up().catch(() => {});
}

// Read "Lvl N <Class>" from the canvas text hook (captured intermittently). Returns {level,cls} or null.
export async function readLevelClass(page) {
  return page.evaluate(() => {
    const f = window.__diep?.frame; if (!f) return null;
    for (const t of f.texts) { const m = /^Lvl\s+(\d+)\s+(.+)$/.exec(t.t.trim()); if (m) return { level: +m[1], cls: m[2].trim() }; }
    return null;
  }).catch(() => null);
}
