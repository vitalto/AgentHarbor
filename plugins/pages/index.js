const THUMBNAIL_VIEWPORT = { width: 1280, height: 800 };
// A cross-origin page's scrollbar cannot be styled away, so the thumbnail
// frame is this much wider than the clipped area and the scrollbar falls outside.
const THUMBNAIL_SCROLLBAR_ALLOWANCE = 24;
const REFRESH_INTERVAL_MS = 30_000;
const SELECTED_PAGE_KEY = 'agentharbor-pages:selected';
const SANDBOX_FOR_INLINE_PAGES = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads';

const STRINGS = {
  en: {
    title: 'Pages',
    pageCount: (count) => `${count} ${count === 1 ? 'page' : 'pages'}`,
    search: 'Search pages',
    refresh: 'Refresh',
    settings: 'Settings',
    back: 'All pages',
    reload: 'Reload page',
    openInNewTab: 'Open in a new tab',
    loading: 'Loading pages...',
    empty: (dir) => `No pages in ${dir} yet. A page is a folder with an index.html, or a single .html file.`,
    noMatches: (query) => `Nothing matches "${query}".`,
    folderMissing: (dir) => `Folder ${dir} does not exist. Point the tab at the folder that holds your pages.`,
    loadFailed: (message) => `Could not read the pages: ${message}`,
    settingsTitle: 'Where the pages live',
    pagesDirLabel: 'Pages folder',
    pagesDirHint: 'Every subfolder with an index.html and every .html file in it becomes a page. A Windows path like C:\\Users\\me\\pages works too.',
    pagesUrlLabel: 'Static server address (optional)',
    pagesUrlHint: 'If a web server already serves this folder, pages open from it, keep relative links and images working, and get an "open in a new tab" button. Without it pages are shown straight from the file, so they must be self-contained.',
    save: 'Save',
    cancel: 'Cancel',
    saving: 'Saving...',
    saveFailed: (message) => `Not saved: ${message}`,
  },
  ru: {
    title: 'Страницы',
    pageCount: (count) => {
      const form = new Intl.PluralRules('ru').select(count);
      return `${count} ${{ one: 'страница', few: 'страницы' }[form] ?? 'страниц'}`;
    },
    search: 'Поиск по страницам',
    refresh: 'Обновить',
    settings: 'Настройки',
    back: 'Все страницы',
    reload: 'Перезагрузить страницу',
    openInNewTab: 'Открыть в новой вкладке',
    loading: 'Загружаю страницы...',
    empty: (dir) => `В ${dir} пока нет страниц. Страница: папка с index.html или отдельный .html файл.`,
    noMatches: (query) => `По запросу "${query}" ничего нет.`,
    folderMissing: (dir) => `Папки ${dir} нет. Укажите папку, где лежат страницы.`,
    loadFailed: (message) => `Не удалось прочитать страницы: ${message}`,
    settingsTitle: 'Где лежат страницы',
    pagesDirLabel: 'Папка со страницами',
    pagesDirHint: 'Каждая подпапка с index.html и каждый .html файл в ней становятся страницей. Можно писать путь Windows, например C:\\Users\\me\\pages.',
    pagesUrlLabel: 'Адрес веб-сервера (необязательно)',
    pagesUrlHint: 'Если эту папку уже отдаёт веб-сервер, страницы открываются с него: работают относительные ссылки и картинки, появляется кнопка "открыть в новой вкладке". Без адреса страница показывается прямо из файла и должна быть самодостаточной.',
    save: 'Сохранить',
    cancel: 'Отмена',
    saving: 'Сохраняю...',
    saveFailed: (message) => `Не сохранено: ${message}`,
  },
};

const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
};

const STYLES = `
.ahp {
  --ahp-rail: 17rem;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  color: hsl(var(--foreground));
  background: hsl(var(--background));
  font-size: 14px;
  container-type: inline-size;
}
.ahp *, .ahp *::before, .ahp *::after { box-sizing: border-box; }
.ahp [hidden] { display: none !important; }
.ahp button, .ahp input { font: inherit; color: inherit; }
.ahp :focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }

.ahp-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 1rem;
  border-bottom: 1px solid hsl(var(--border));
  min-height: 3.25rem;
}
.ahp-count { color: hsl(var(--muted-foreground)); white-space: nowrap; font-variant-numeric: tabular-nums; }
.ahp-spacer { flex: 1; }
.ahp-viewer-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.ahp-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  height: 2rem;
  min-width: 2rem;
  padding: 0 0.5rem;
  border: 0;
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  color: hsl(var(--muted-foreground));
  text-decoration: none;
  cursor: pointer;
  flex-shrink: 0;
}
.ahp-icon-button:hover { background: hsl(var(--accent)); color: hsl(var(--accent-foreground)); }
.ahp-icon-button svg { width: 1rem; height: 1rem; }
.ahp-icon-button[data-busy] svg { animation: ahp-spin 0.5s steps(8) infinite; }
@keyframes ahp-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ahp-icon-button[data-busy] svg { animation: none; } }

.ahp-search {
  position: relative;
  width: min(16rem, 40cqw);
}
.ahp-search svg {
  position: absolute;
  left: 0.625rem;
  top: 50%;
  width: 0.875rem;
  height: 0.875rem;
  transform: translateY(-50%);
  color: hsl(var(--muted-foreground));
  pointer-events: none;
}
.ahp-search input {
  width: 100%;
  height: 2rem;
  padding: 0 0.625rem 0 1.875rem;
  border: 1px solid hsl(var(--input));
  border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--background));
}
.ahp-search input::placeholder { color: hsl(var(--muted-foreground)); }

.ahp-scroll { flex: 1; min-height: 0; overflow: auto; }
.ahp-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
  gap: 1.5rem 1.25rem;
  padding: 1.25rem 1rem 2rem;
}
.ahp-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.ahp-thumb {
  position: relative;
  aspect-ratio: ${THUMBNAIL_VIEWPORT.width} / ${THUMBNAIL_VIEWPORT.height};
  overflow: hidden;
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  background: hsl(var(--card));
  transition: border-color 120ms;
}
.ahp-card:hover .ahp-thumb { border-color: hsl(var(--muted-foreground) / 0.6); }
.ahp-thumb iframe {
  position: absolute;
  inset: 0 auto auto 0;
  width: ${THUMBNAIL_VIEWPORT.width + THUMBNAIL_SCROLLBAR_ALLOWANCE}px;
  height: ${THUMBNAIL_VIEWPORT.height}px;
  border: 0;
  transform: scale(var(--ahp-thumb-scale, 0.2));
  transform-origin: 0 0;
  pointer-events: none;
  background: white;
}
.ahp-card-title {
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.ahp-card-meta {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  margin-top: -0.25rem;
  font-size: 12.5px;
  color: hsl(var(--muted-foreground));
}
.ahp-card-meta span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ahp-card-meta span:last-child { white-space: nowrap; }
.ahp-card-fresh .ahp-card-meta span:last-child { color: hsl(var(--primary)); }

.ahp-message {
  max-width: 34rem;
  margin: 3rem auto;
  padding: 0 1rem;
  line-height: 1.5;
  color: hsl(var(--muted-foreground));
  text-align: center;
}
.ahp-message button {
  margin-top: 0.75rem;
}

.ahp-viewer { flex: 1; min-height: 0; display: flex; }
.ahp-rail {
  width: var(--ahp-rail);
  flex-shrink: 0;
  overflow: auto;
  border-right: 1px solid hsl(var(--border));
  padding: 0.5rem;
}
.ahp-rail-item {
  display: block;
  width: 100%;
  padding: 0.5rem 0.625rem;
  border: 0;
  border-radius: calc(var(--radius) - 2px);
  background: none;
  text-align: left;
  cursor: pointer;
}
.ahp-rail-item:hover { background: hsl(var(--accent)); }
.ahp-rail-item[aria-current="page"] { background: hsl(var(--muted)); }
.ahp-rail-item span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ahp-rail-item span + span { font-size: 12.5px; color: hsl(var(--muted-foreground)); }
.ahp-frame-wrap { flex: 1; min-width: 0; position: relative; background: white; }
.ahp-frame-wrap iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
@container (max-width: 56rem) { .ahp-rail { display: none; } }
@container (max-width: 34rem) {
  .ahp-search { width: auto; flex: 1; }
  .ahp-count, .ahp-spacer { display: none; }
  .ahp-gallery { grid-template-columns: 1fr; }
  .ahp-icon-button .ahp-label { display: none; }
}

.ahp-settings {
  max-width: 36rem;
  margin: 0 auto;
  padding: 1.5rem 1rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.ahp-settings h2 { margin: 0; font-size: 15px; font-weight: 600; }
.ahp-field { display: flex; flex-direction: column; gap: 0.375rem; }
.ahp-field label { font-weight: 500; }
.ahp-field input {
  height: 2.25rem;
  padding: 0 0.75rem;
  border: 1px solid hsl(var(--input));
  border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--background));
}
.ahp-field p { margin: 0; font-size: 12.5px; line-height: 1.45; color: hsl(var(--muted-foreground)); }
.ahp-actions { display: flex; gap: 0.5rem; align-items: center; }
.ahp-button {
  height: 2.25rem;
  padding: 0 1rem;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--background));
  cursor: pointer;
}
.ahp-button:hover { background: hsl(var(--accent)); }
.ahp-button-primary {
  border-color: hsl(var(--primary));
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
}
.ahp-button-primary:hover { background: hsl(var(--primary) / 0.9); }
.ahp-button:disabled { opacity: 0.6; cursor: default; }
.ahp-error { color: hsl(0 72% 51%); font-size: 13px; }
`;

function pickStrings() {
  const language = (document.documentElement.lang || navigator.language || 'en').toLowerCase();
  return language.startsWith('ru') ? STRINGS.ru : STRINGS.en;
}

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

function icon(name) {
  const wrapper = document.createElement('span');
  wrapper.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return wrapper.firstChild;
}

function iconButton(name, label, onclick, { showLabel = false } = {}) {
  return element('button', { type: 'button', class: 'ahp-icon-button', title: label, 'aria-label': label, onclick }, [
    icon(name),
    showLabel ? element('span', { class: 'ahp-label', text: label }) : null,
  ]);
}

function readStoredSelection() {
  try { return localStorage.getItem(SELECTED_PAGE_KEY); } catch { return null; }
}

function storeSelection(pageId) {
  try {
    if (pageId) localStorage.setItem(SELECTED_PAGE_KEY, pageId);
    else localStorage.removeItem(SELECTED_PAGE_KEY);
  } catch { /* private window or blocked storage: the selection simply is not remembered */ }
}

function pageUrl(pagesUrl, pageId) {
  const encoded = pageId.endsWith('/')
    ? `${encodeURIComponent(pageId.slice(0, -1))}/`
    : encodeURIComponent(pageId);
  return `${pagesUrl}/${encoded}`;
}

function displayTitle(page) {
  return page.title || page.name;
}

export function mount(container, host) {
  const strings = pickStrings();
  const relativeTime = new Intl.RelativeTimeFormat(strings === STRINGS.ru ? 'ru' : 'en', { numeric: 'auto' });

  const state = {
    view: 'gallery',
    pages: [],
    config: null,
    folderMissing: false,
    loadError: '',
    loaded: false,
    query: '',
    selectedId: readStoredSelection(),
    viewerVersion: '',
    inlineHtml: new Map(),
  };

  const cardsById = new Map();

  function formatAge(isoDate) {
    const seconds = (new Date(isoDate).getTime() - Date.now()) / 1000;
    const steps = [[60, 'second'], [3600, 'minute'], [86400, 'hour'], [604800, 'day'], [2629800, 'week'], [31557600, 'month']];
    let unit = 'year';
    let divisor = 31557600;
    for (const [limit, name] of steps) {
      if (Math.abs(seconds) < limit) {
        unit = name;
        break;
      }
      divisor = limit;
    }
    if (unit === 'second') return relativeTime.format(0, 'second');
    return relativeTime.format(Math.round(seconds / divisor), unit);
  }

  function isFresh(isoDate) {
    return Date.now() - new Date(isoDate).getTime() < 3600_000;
  }

  async function rpc(method, path, body) {
    const result = await host.rpc(method, path, body);
    if (result?.error) throw new Error(result.error);
    return result;
  }

  async function inlineHtml(pageId) {
    if (!state.inlineHtml.has(pageId)) {
      state.inlineHtml.set(pageId, rpc('GET', `page?id=${encodeURIComponent(pageId)}`).then((result) => result.html));
    }
    return state.inlineHtml.get(pageId);
  }

  function showPageInFrame(frame, page) {
    const pagesUrl = state.config?.pagesUrl;
    if (pagesUrl) {
      frame.removeAttribute('sandbox');
      frame.removeAttribute('srcdoc');
      frame.src = pageUrl(pagesUrl, page.id);
      return;
    }
    // Without a sandbox an inline page would share AgentHarbor's origin and could read its login token.
    frame.setAttribute('sandbox', SANDBOX_FOR_INLINE_PAGES);
    frame.removeAttribute('src');
    inlineHtml(page.id)
      .then((html) => { frame.srcdoc = html; })
      .catch((error) => { frame.srcdoc = `<p style="font:14px system-ui;padding:1rem">${String(error.message).replace(/</g, '&lt;')}</p>`; });
  }

  const style = element('style', { text: STYLES });

  const count = element('span', { class: 'ahp-count' });
  const searchInput = element('input', {
    type: 'search',
    placeholder: strings.search,
    'aria-label': strings.search,
    oninput: () => {
      state.query = searchInput.value.trim();
      renderGallery();
    },
  });
  const refreshButton = iconButton('refresh', strings.refresh, () => loadPages({ userAsked: true }));
  const galleryBar = element('div', { class: 'ahp-bar' }, [
    count,
    element('div', { class: 'ahp-spacer' }),
    element('div', { class: 'ahp-search' }, [icon('search'), searchInput]),
    refreshButton,
    iconButton('settings', strings.settings, () => openSettings()),
  ]);
  const gallery = element('div', { class: 'ahp-gallery', role: 'list' });
  const galleryMessage = element('div', { class: 'ahp-message', hidden: true });
  const galleryScroll = element('div', { class: 'ahp-scroll' }, [gallery, galleryMessage]);
  const galleryView = element('div', { class: 'ahp-view', style: 'display:contents' }, [galleryBar, galleryScroll]);

  const viewerTitle = element('div', { class: 'ahp-viewer-title' });
  const openExternal = element('a', {
    class: 'ahp-icon-button',
    target: '_blank',
    rel: 'noopener',
    title: strings.openInNewTab,
    'aria-label': strings.openInNewTab,
  }, [icon('external')]);
  const viewerFrame = element('iframe', { title: '', allow: 'fullscreen; clipboard-write' });
  const rail = element('nav', { class: 'ahp-rail', 'aria-label': strings.title });
  const viewerBar = element('div', { class: 'ahp-bar' }, [
    iconButton('back', strings.back, () => closeViewer(), { showLabel: true }),
    viewerTitle,
    iconButton('refresh', strings.reload, () => {
      const page = selectedPage();
      if (!page) return;
      state.inlineHtml.delete(page.id);
      showPageInFrame(viewerFrame, page);
    }),
    openExternal,
  ]);
  const viewerView = element('div', { class: 'ahp-view', style: 'display:contents', hidden: true }, [
    viewerBar,
    element('div', { class: 'ahp-viewer' }, [rail, element('div', { class: 'ahp-frame-wrap' }, [viewerFrame])]),
  ]);

  const pagesDirInput = element('input', { id: 'ahp-pages-dir', type: 'text', spellcheck: 'false', autocomplete: 'off' });
  const pagesUrlInput = element('input', { id: 'ahp-pages-url', type: 'url', spellcheck: 'false', autocomplete: 'off', placeholder: 'http://192.168.1.10:8088' });
  const settingsError = element('div', { class: 'ahp-error', role: 'alert', hidden: true });
  const saveButton = element('button', { type: 'submit', class: 'ahp-button ahp-button-primary', text: strings.save });
  const cancelButton = element('button', { type: 'button', class: 'ahp-button', text: strings.cancel, onclick: () => closeSettings() });
  const settingsForm = element('form', {
    class: 'ahp-settings',
    onsubmit: (event) => {
      event.preventDefault();
      saveSettings();
    },
  }, [
    element('h2', { text: strings.settingsTitle }),
    element('div', { class: 'ahp-field' }, [
      element('label', { for: 'ahp-pages-dir', text: strings.pagesDirLabel }),
      pagesDirInput,
      element('p', { text: strings.pagesDirHint }),
    ]),
    element('div', { class: 'ahp-field' }, [
      element('label', { for: 'ahp-pages-url', text: strings.pagesUrlLabel }),
      pagesUrlInput,
      element('p', { text: strings.pagesUrlHint }),
    ]),
    settingsError,
    element('div', { class: 'ahp-actions' }, [saveButton, cancelButton]),
  ]);
  const settingsView = element('div', { class: 'ahp-scroll', hidden: true }, [settingsForm]);

  const root = element('div', { class: 'ahp' }, [style, galleryView, viewerView, settingsView]);
  container.append(root);

  const thumbnailResize = new ResizeObserver(() => updateThumbnailScale());
  thumbnailResize.observe(gallery);

  function selectedPage() {
    return state.pages.find((page) => page.id === state.selectedId) ?? null;
  }

  function visiblePages() {
    const query = state.query.toLowerCase();
    if (!query) return state.pages;
    return state.pages.filter((page) => `${page.title} ${page.name} ${page.description}`.toLowerCase().includes(query));
  }

  function createCard(page) {
    const frame = element('iframe', { tabindex: '-1', 'aria-hidden': 'true', loading: 'lazy', title: '' });
    const title = element('span', { class: 'ahp-card-title' });
    const name = element('span');
    const age = element('span');
    const card = element('button', {
      type: 'button',
      class: 'ahp-card',
      role: 'listitem',
      onclick: () => openViewer(card.dataset.pageId),
    }, [
      element('div', { class: 'ahp-thumb' }, [frame]),
      title,
      element('div', { class: 'ahp-card-meta' }, [name, age]),
    ]);
    card.dataset.pageId = page.id;
    return { card, frame, title, name, age, shownVersion: '' };
  }

  function updateCard(entry, page) {
    entry.title.textContent = displayTitle(page);
    entry.name.textContent = page.name;
    entry.age.textContent = formatAge(page.modifiedAt);
    entry.age.title = new Date(page.modifiedAt).toLocaleString();
    entry.card.title = page.description || displayTitle(page);
    entry.card.classList.toggle('ahp-card-fresh', isFresh(page.modifiedAt));
    const version = `${page.modifiedAt}|${state.config?.pagesUrl ?? ''}`;
    if (entry.shownVersion !== version) {
      entry.shownVersion = version;
      state.inlineHtml.delete(page.id);
      showPageInFrame(entry.frame, page);
    }
  }

  function updateThumbnailScale() {
    const thumb = [...gallery.querySelectorAll('.ahp-thumb')].find((candidate) => candidate.clientWidth > 0);
    if (thumb) gallery.style.setProperty('--ahp-thumb-scale', String(thumb.clientWidth / THUMBNAIL_VIEWPORT.width));
  }

  // Cards are reused by page id and only moved when their position changes:
  // replacing or moving an iframe reloads it, and a periodic refresh must not
  // reload every live thumbnail. Search hides cards instead of removing them.
  function renderGallery() {
    count.textContent = state.loaded ? strings.pageCount(state.pages.length) : '';
    const pageIds = new Set(state.pages.map((page) => page.id));
    for (const [id, entry] of cardsById) {
      if (!pageIds.has(id)) {
        entry.card.remove();
        cardsById.delete(id);
      }
    }
    const visibleIds = new Set(visiblePages().map((page) => page.id));
    state.pages.forEach((page, index) => {
      let entry = cardsById.get(page.id);
      if (!entry) {
        entry = createCard(page);
        cardsById.set(page.id, entry);
      }
      if (gallery.children[index] !== entry.card) {
        gallery.insertBefore(entry.card, gallery.children[index] ?? null);
      }
      entry.card.hidden = !visibleIds.has(page.id);
      updateCard(entry, page);
    });
    updateThumbnailScale();

    const message = galleryMessageText();
    galleryMessage.hidden = !message;
    galleryMessage.replaceChildren();
    if (message) {
      galleryMessage.append(element('div', { text: message }));
      if (state.folderMissing || state.loadError) {
        galleryMessage.append(element('button', { type: 'button', class: 'ahp-button', text: strings.settings, onclick: () => openSettings() }));
      }
    }
  }

  function galleryMessageText() {
    const dir = state.config?.pagesDir ?? '';
    if (state.loadError) return strings.loadFailed(state.loadError);
    if (!state.loaded) return strings.loading;
    if (state.folderMissing) return strings.folderMissing(dir);
    if (state.pages.length === 0) return strings.empty(dir);
    if (visiblePages().length === 0) return strings.noMatches(state.query);
    return '';
  }

  function renderRail() {
    rail.replaceChildren(...state.pages.map((page) => element('button', {
      type: 'button',
      class: 'ahp-rail-item',
      'aria-current': page.id === state.selectedId ? 'page' : false,
      title: page.description || displayTitle(page),
      onclick: () => openViewer(page.id),
    }, [
      element('span', { text: displayTitle(page) }),
      element('span', { text: formatAge(page.modifiedAt) }),
    ])));
  }

  function showView(view) {
    state.view = view;
    galleryView.hidden = view !== 'gallery';
    viewerView.hidden = view !== 'viewer';
    settingsView.hidden = view !== 'settings';
    if (view === 'gallery') {
      renderGallery();
      return;
    }
    // Live thumbnails only run while the gallery is on screen.
    for (const entry of cardsById.values()) {
      entry.frame.removeAttribute('src');
      entry.frame.removeAttribute('srcdoc');
      entry.shownVersion = '';
    }
  }

  function openViewer(pageId) {
    const page = state.pages.find((candidate) => candidate.id === pageId);
    if (!page) return;
    const version = `${page.id}|${page.modifiedAt}|${state.config?.pagesUrl ?? ''}`;
    const pageChanged = state.viewerVersion !== version || state.view !== 'viewer';
    state.viewerVersion = version;
    state.selectedId = pageId;
    storeSelection(pageId);
    viewerTitle.textContent = displayTitle(page);
    viewerFrame.title = displayTitle(page);
    const pagesUrl = state.config?.pagesUrl;
    openExternal.hidden = !pagesUrl;
    if (pagesUrl) openExternal.href = pageUrl(pagesUrl, page.id);
    if (pageChanged) {
      state.inlineHtml.delete(page.id);
      showPageInFrame(viewerFrame, page);
    }
    renderRail();
    if (state.view !== 'viewer') showView('viewer');
  }

  function closeViewer() {
    state.selectedId = null;
    state.viewerVersion = '';
    storeSelection(null);
    viewerFrame.removeAttribute('src');
    viewerFrame.removeAttribute('srcdoc');
    showView('gallery');
  }

  function openSettings() {
    pagesDirInput.value = state.config?.pagesDir ?? '';
    pagesUrlInput.value = state.config?.pagesUrl ?? '';
    settingsError.hidden = true;
    showView('settings');
    pagesDirInput.focus();
  }

  function closeSettings() {
    showView(selectedPage() ? 'viewer' : 'gallery');
  }

  async function saveSettings() {
    saveButton.disabled = true;
    saveButton.textContent = strings.saving;
    settingsError.hidden = true;
    try {
      const result = await rpc('PUT', 'config', { pagesDir: pagesDirInput.value, pagesUrl: pagesUrlInput.value });
      state.config = result.config;
      state.inlineHtml.clear();
      state.selectedId = null;
      storeSelection(null);
      showView('gallery');
      await loadPages({ userAsked: true });
    } catch (error) {
      settingsError.textContent = strings.saveFailed(error.message);
      settingsError.hidden = false;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = strings.save;
    }
  }

  let loadSequence = 0;
  async function loadPages({ userAsked = false } = {}) {
    const sequence = ++loadSequence;
    if (userAsked) refreshButton.dataset.busy = '';
    try {
      const result = await rpc('GET', 'pages');
      if (sequence !== loadSequence) return;
      state.config = result.config;
      state.pages = result.pages;
      state.folderMissing = Boolean(result.folderMissing);
      state.loadError = '';
    } catch (error) {
      if (sequence !== loadSequence) return;
      state.loadError = error.message;
    } finally {
      if (sequence === loadSequence) delete refreshButton.dataset.busy;
    }
    state.loaded = true;

    if (state.view === 'settings') return;
    const page = selectedPage();
    if (page) {
      openViewer(page.id);
    } else {
      if (state.view === 'viewer') state.selectedId = null;
      showView('gallery');
    }
  }

  function refreshWhenVisible() {
    if (document.visibilityState === 'visible') loadPages();
  }
  const refreshTimer = setInterval(refreshWhenVisible, REFRESH_INTERVAL_MS);
  document.addEventListener('visibilitychange', refreshWhenVisible);

  function closeOnEscape(event) {
    if (event.key !== 'Escape') return;
    if (state.view === 'viewer') closeViewer();
    else if (state.view === 'settings') closeSettings();
  }
  root.addEventListener('keydown', closeOnEscape);

  renderGallery();
  loadPages();

  container.__ahpCleanup = () => {
    clearInterval(refreshTimer);
    document.removeEventListener('visibilitychange', refreshWhenVisible);
    thumbnailResize.disconnect();
    root.remove();
  };
}

export function unmount(container) {
  container.__ahpCleanup?.();
  delete container.__ahpCleanup;
}
