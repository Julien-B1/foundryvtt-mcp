/**
 * @fileoverview Taverne: render_document — a screenshot of a document's sheet as the headless GM
 * sees it (actor and item sheets, journal pages, roll tables, macros, cards), so a GM using the
 * connector can check what was built without opening Foundry.
 */

import type { HeadlessGmSession } from '../foundry/headless-gm-session.js';
import { fail, type ImageResult, str } from './util.js';

/** Runs in the game page: opens the sheet and returns the selector of its window. */
const PREPARE = `async (a) => {
  let doc = await fromUuid(a.uuid);
  if (!doc) throw new Error('Document not found: ' + a.uuid);
  let pageId = a.pageId;
  if (doc.documentName === 'JournalEntryPage') { pageId = doc.id; doc = doc.parent; }
  if (doc.documentName === 'Token') doc = doc.actor;
  if (doc.documentName === 'JournalEntry' && !pageId && a.pageName) {
    const p = doc.pages.find((x) => x.name.toLowerCase().includes(a.pageName.toLowerCase()));
    if (!p) throw new Error('No page named ' + a.pageName + ' in ' + doc.name);
    pageId = p.id;
  }
  const app = doc.sheet;
  if (!app) throw new Error(doc.documentName + ' has no sheet');
  await app.render({ force: true, ...(pageId ? { pageId } : {}) });
  for (let i = 0; i < 50 && !app.rendered; i++) await new Promise((r) => setTimeout(r, 100));
  const el = app.element instanceof HTMLElement ? app.element : app.element?.[0];
  if (!el) throw new Error('The sheet did not render');
  if (a.tab) {
    const tabs = [...new Set([...el.querySelectorAll('nav [data-tab]')].map((t) => t.dataset.tab))];
    if (!tabs.includes(a.tab)) {
      await app.close({ animate: false });
      throw new Error('No tab "' + a.tab + '" on this sheet. Tabs: ' + tabs.join(', '));
    }
    app.changeTab?.(a.tab, a.tabGroup ?? 'primary', { force: true });
  }
  app.setPosition?.({ left: 20, top: 20, ...(a.width ? { width: a.width } : {}), ...(a.height ? { height: a.height } : {}) });
  window.__taverneRendered = app;
  // Images and fonts of the sheet.
  await Promise.all([...el.querySelectorAll('img')].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 3000); })));
  await new Promise((r) => setTimeout(r, a.settleMs ?? 600));
  // Notifications (hardware acceleration warning…) would cover the sheet.
  const notes = document.getElementById('notifications');
  if (notes) notes.style.visibility = 'hidden';
  el.setAttribute('data-taverne-render', '1');
  return '[data-taverne-render="1"]';
}`;

const CLEANUP = `async () => {
  const app = window.__taverneRendered;
  delete window.__taverneRendered;
  const notes = document.getElementById('notifications');
  if (notes) notes.style.visibility = '';
  const el = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
  el?.removeAttribute('data-taverne-render');
  await app?.close?.({ animate: false });
}`;

export async function handleRenderDocument(
  args: Record<string, unknown>,
  session: HeadlessGmSession | null,
): Promise<ImageResult> {
  if (!session) {
    fail('render_document needs the headless GM session (FOUNDRY_HEADLESS_GM_ENABLED)');
  }
  const type = str(args.type);
  const id = str(args.id);
  const uuid = str(args.uuid) ?? (type && id ? `${type}.${id}` : fail('Give uuid, or type and id'));
  const width = typeof args.width === 'number' ? args.width : undefined;
  const height = typeof args.height === 'number' ? args.height : undefined;
  const format = args.format === 'png' ? 'png' : 'jpeg';
  const image = await session.screenshotInPage(
    PREPARE,
    CLEANUP,
    {
      uuid,
      pageId: str(args.pageId),
      pageName: str(args.pageName),
      tab: str(args.tab),
      tabGroup: str(args.tabGroup),
      width,
      height,
    },
    {
      type: format,
      viewport: { width: (width ?? 900) + 80, height: (height ?? 900) + 80 },
    },
  );
  return {
    content: [
      {
        type: 'text',
        text: `🖼️ ${uuid} as the GM sees it${args.tab ? ` (tab ${String(args.tab)})` : ''}`,
      },
      { type: 'image', data: image.toString('base64'), mimeType: `image/${format}` },
    ],
  };
}
