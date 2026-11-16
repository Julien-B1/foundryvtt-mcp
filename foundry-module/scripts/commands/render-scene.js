/**
 * Taverne: renders a whole scene (or a region of it) at a chosen scale, tile by tile, with
 * optional overlays: walls coloured by kind, light radii, grid coordinates along the edges.
 * The headless session views the scene itself, so any scene can be rendered, not only the
 * active one.
 */

const WALL_COLORS = {
  door: 0x3cff6e, secret: 0xd04dff, locked: 0xffd23c, window: 0x3cd8ff, terrain: 0xffe14d,
  invisible: 0xffffff, ethereal: 0xff4dd2, oneway: 0xff8a1f, normal: 0xff2d2d,
};

/** Kind of a wall, for its overlay colour. */
function wallKind(w) {
  if (w.door === 2) return 'secret';
  if (w.door === 1) return w.ds === 2 ? 'locked' : 'door';
  if (w.dir) return 'oneway';
  if (w.move === 0) return 'ethereal';
  if (w.sight === 0) return 'invisible';
  if (w.sight === 30 || w.sight === 40) return 'window';
  if (w.sight === 10) return 'terrain';
  return 'normal';
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

function buildOverlay(opts, scale) {
  const scene = canvas.scene;
  const d = canvas.dimensions;
  const overlay = new PIXI.Container();
  overlay.name = 'taverneRenderOverlay';
  const px = (n) => n / scale;
  if (opts.walls !== false) {
    const g = new PIXI.Graphics();
    for (const w of scene.walls) {
      const [x1, y1, x2, y2] = w.c;
      const kind = wallKind(w);
      g.lineStyle(px(kind === 'invisible' ? 2 : 3), WALL_COLORS[kind], 0.95);
      g.moveTo(x1, y1).lineTo(x2, y2);
      if (kind === 'oneway') {
        // Tick on the blocking side.
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, len = Math.hypot(x2 - x1, y2 - y1) || 1;
        const nx = -(y2 - y1) / len, ny = (x2 - x1) / len, s = w.dir === 1 ? 1 : -1;
        g.moveTo(mx, my).lineTo(mx + s * nx * px(10), my + s * ny * px(10));
      }
    }
    for (const w of scene.walls) {
      const [x1, y1, x2, y2] = w.c;
      g.lineStyle(0).beginFill(0xffffff, 0.9).drawCircle(x1, y1, px(2.5)).drawCircle(x2, y2, px(2.5)).endFill();
    }
    overlay.addChild(g);
  }
  if (opts.lights !== false) {
    const g = new PIXI.Graphics();
    const unit = d.size / d.distance;
    for (const l of scene.lights) {
      const c = l.config.color ? Number(l.config.color) : 0xffffff;
      const col = l.config.negative ? 0x9b4dff : c;
      g.lineStyle(px(2), col, 0.9).drawCircle(l.x, l.y, l.config.dim * unit);
      g.lineStyle(px(1.5), col, 0.6).drawCircle(l.x, l.y, l.config.bright * unit);
      g.lineStyle(px(1.5), 0x000000, 1).beginFill(col, 1).drawCircle(l.x, l.y, px(6)).endFill();
    }
    overlay.addChild(g);
  }
  if (opts.grid !== false) {
    const g = new PIXI.Graphics();
    const r = d.sceneRect;
    const step = d.size * (opts.gridLabelEvery ?? 2);
    const style = new PIXI.TextStyle({ fontFamily: 'Arial', fontSize: px(13), fill: 0xffffff, stroke: 0x000000, strokeThickness: px(3) });
    g.lineStyle(px(1), 0xffffff, 0.35);
    for (let x = r.x, i = 0; x <= r.right + 1; x += step, i += opts.gridLabelEvery ?? 2) {
      g.moveTo(x, r.y).lineTo(x, r.bottom);
      const t = new PIXI.Text(String(i), style); t.x = x + px(2); t.y = r.y + px(2); overlay.addChild(t);
    }
    for (let y = r.y, j = 0; y <= r.bottom + 1; y += step, j += opts.gridLabelEvery ?? 2) {
      g.moveTo(r.x, y).lineTo(r.right, y);
      if (j > 0) { const t = new PIXI.Text(String(j), style); t.x = r.x + px(2); t.y = y + px(2); overlay.addChild(t); }
    }
    overlay.addChildAt(g, 0);
  }
  return overlay;
}

/**
 * @param {{sceneId?: string, region?: {x:number,y:number,width:number,height:number}, maxSize?: number,
 *   scale?: number, walls?: boolean, lights?: boolean, grid?: boolean, gridLabelEvery?: number,
 *   effects?: boolean, format?: string, quality?: number}} params
 *   region is in scene pixels (from the map's top-left corner, padding excluded).
 */
export async function renderScene(params = {}) {
  if (params.sceneId && canvas.scene?.id !== params.sceneId) {
    const scene = game.scenes.get(params.sceneId);
    if (!scene) throw new Error(`Scene not found: ${params.sceneId}`);
    await scene.view();
  }
  for (let i = 0; i < 100 && !canvas.ready; i++) await new Promise((r) => setTimeout(r, 100));
  if (!canvas.ready) throw new Error('Canvas not ready');
  const d = canvas.dimensions;
  const r = d.sceneRect;
  const region = params.region
    ? { x: r.x + params.region.x, y: r.y + params.region.y, width: params.region.width, height: params.region.height }
    : { x: r.x, y: r.y, width: r.width, height: r.height };
  const maxSize = Math.min(params.maxSize ?? 2048, 4096);
  const scale = params.scale ?? Math.min(2, maxSize / Math.max(region.width, region.height));
  const outW = Math.round(region.width * scale);
  const outH = Math.round(region.height * scale);

  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const ctx = out.getContext('2d');
  const view = canvas.app.view;
  const res = canvas.app.renderer.resolution;
  const screenW = view.width / res;
  const screenH = view.height / res;
  const tileW = screenW / scale;
  const tileH = screenH / scale;

  const saved = { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
  const effectsVisible = canvas.effects?.visible;
  if (params.effects === false && canvas.effects) canvas.effects.visible = false;
  const overlay = buildOverlay(params, scale);
  canvas.stage.addChild(overlay);
  try {
    for (let ty = region.y; ty < region.y + region.height; ty += tileH) {
      for (let tx = region.x; tx < region.x + region.width; tx += tileW) {
        await canvas.pan({ x: tx + tileW / 2, y: ty + tileH / 2, scale, duration: 0 });
        await frame(); await frame();
        canvas.app.renderer.render(canvas.app.stage);
        // Where the view actually is (pan may clamp near the edges).
        const left = canvas.stage.pivot.x - screenW / 2 / canvas.stage.scale.x;
        const top = canvas.stage.pivot.y - screenH / 2 / canvas.stage.scale.y;
        ctx.drawImage(view, 0, 0, view.width, view.height, (left - region.x) * scale, (top - region.y) * scale, screenW, screenH);
      }
    }
  } finally {
    canvas.stage.removeChild(overlay);
    overlay.destroy({ children: true });
    if (canvas.effects) canvas.effects.visible = effectsVisible;
    await canvas.pan({ x: saved.x, y: saved.y, scale: saved.scale, duration: 0 });
  }
  const mimeType = params.format === 'png' ? 'image/png' : 'image/jpeg';
  const dataUrl = out.toDataURL(mimeType, params.quality ?? 0.85);
  return {
    sceneId: canvas.scene.id,
    sceneName: canvas.scene.name,
    image: dataUrl.replace(/^data:[^;]+;base64,/, ''),
    mimeType,
    width: outW,
    height: outH,
    scale,
    region: { x: region.x - r.x, y: region.y - r.y, width: region.width, height: region.height },
    grid: { size: d.size, distance: d.distance, units: canvas.scene.grid.units },
    counts: { walls: canvas.scene.walls.size, lights: canvas.scene.lights.size },
  };
}
