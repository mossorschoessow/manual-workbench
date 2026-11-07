'use strict';
/* 設備維修手冊工作臺
 * 純前端離線應用：手冊元資料與文件均存於本機 IndexedDB。
 */
const APP_VERSION = '1.3.0';
const $ = (s, el = document) => el.querySelector(s);

/* =========================================================
 * 安卓安裝包（APK）原生橋接
 * 在 APK 裡運行時，MainActivity 會注入 window.NativeApp。
 * WebView 不支持網頁的下載、分享和 BarcodeDetector，這幾項改由原生處理。
 * ========================================================= */
const NATIVE = window.NativeApp || null;
const nativePending = new Map();
let nativeSeq = 0;
window.__nativeResolve = (id, value) => {
  const done = nativePending.get(id);
  if (done) { nativePending.delete(id); done(value); }
};
function nativeWait(start) {
  const id = 'c' + (++nativeSeq);
  return new Promise((resolve) => { nativePending.set(id, resolve); start(id); });
}
const blobToB64 = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result.slice(fr.result.indexOf(',') + 1));
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(blob);
});
// 分塊把 Blob 交給原生端寫入文件，再保存（save，用戶選位置）或分享 / 用其他應用打開（share）。
// 返回 true 表示完成，false 表示用戶取消。
async function nativeFile(blob, name, mime, action) {
  const id = NATIVE.begin(name, mime || '');
  if (id.startsWith('error:')) throw new Error(id.slice(6));
  const CHUNK = 1 << 20;
  for (let o = 0; o < blob.size; o += CHUNK) {
    const err = NATIVE.chunk(id, await blobToB64(blob.slice(o, o + CHUNK)));
    if (err) throw new Error(err);
  }
  const r = await nativeWait((cb) => NATIVE.finish(id, action, cb));
  if (r.startsWith('error:')) throw new Error(r.slice(6));
  return r === 'ok';
}

/* =========================================================
 * 存儲層（IndexedDB）
 * manuals: 元資料（常駐記憶體以便即時搜索）
 * files:   文件本體 Blob（打開時才讀取）
 * kv:      最近查看、收藏等
 * exps:    維修經驗（1.3.0 起；按 manualId 歸屬到手冊，常駐記憶體）
 * expimgs: 經驗裡的圖片 { id, blob, thumb, w, h }（壓縮後的原圖 + 縮略圖，用到時才讀取）
 * ========================================================= */
const DB_NAME = 'manual-workbench';
let dbPromise;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 3);
      r.onupgradeneeded = (e) => {
        const db = r.result;
        if (e.oldVersion < 1) {
          db.createObjectStore('manuals', { keyPath: 'id' });
          db.createObjectStore('files', { keyPath: 'id' });
          db.createObjectStore('kv');
        }
        if (e.oldVersion < 2) db.createObjectStore('exps', { keyPath: 'id' });
        if (e.oldVersion < 3) db.createObjectStore('expimgs', { keyPath: 'id' });
      };
      r.onsuccess = () => {
        // 另一個分頁升級資料庫時讓出連接，避免它被卡住
        r.result.onversionchange = () => r.result.close();
        resolve(r.result);
      };
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
function txDone(t) {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('transaction aborted'));
  });
}
const store = {
  async allMeta() { const db = await openDB(); return reqP(db.transaction('manuals').objectStore('manuals').getAll()); },
  async file(id) { const db = await openDB(); const rec = await reqP(db.transaction('files').objectStore('files').get(id)); return rec ? rec.blob : null; },
  async put(meta, blob) {
    // 用戶選的 File 在安卓 WebView 裡只是指向 content:// 的引用，應用重啟後授權失效會讀成 0 字節，
    // 所以先把內容複製成獨立的 Blob 再存（必須在開事務之前，事務遇到 await 會自動提交）。
    if (blob instanceof File) blob = new Blob([await blob.arrayBuffer()], { type: blob.type });
    const db = await openDB();
    const t = db.transaction(['manuals', 'files'], 'readwrite');
    t.objectStore('manuals').put(meta);
    if (blob) t.objectStore('files').put({ id: meta.id, blob });
    return txDone(t);
  },
  async remove(id, expIds = [], imgIds = []) {
    const db = await openDB();
    const t = db.transaction(['manuals', 'files', 'exps', 'expimgs'], 'readwrite');
    t.objectStore('manuals').delete(id);
    t.objectStore('files').delete(id);
    for (const x of expIds) t.objectStore('exps').delete(x);
    for (const x of imgIds) t.objectStore('expimgs').delete(x);
    return txDone(t);
  },
  async allExps() { const db = await openDB(); return reqP(db.transaction('exps').objectStore('exps').getAll()); },
  /** 保存一條經驗，同時寫入新圖片、刪除被移除的圖片（同一個事務，要麼全成功要麼全不寫） */
  async putExp(x, addImgs = [], delImgIds = []) {
    const db = await openDB();
    const t = db.transaction(['exps', 'expimgs'], 'readwrite');
    t.objectStore('exps').put(x);
    for (const im of addImgs) t.objectStore('expimgs').put(im);
    for (const id of delImgIds) t.objectStore('expimgs').delete(id);
    return txDone(t);
  },
  async removeExp(id, imgIds = []) {
    const db = await openDB();
    const t = db.transaction(['exps', 'expimgs'], 'readwrite');
    t.objectStore('exps').delete(id);
    for (const x of imgIds) t.objectStore('expimgs').delete(x);
    return txDone(t);
  },
  async img(id) { const db = await openDB(); return reqP(db.transaction('expimgs').objectStore('expimgs').get(id)); },
  async putImg(im) { const db = await openDB(); const t = db.transaction('expimgs', 'readwrite'); t.objectStore('expimgs').put(im); return txDone(t); },
  async get(k) { const db = await openDB(); return reqP(db.transaction('kv').objectStore('kv').get(k)); },
  async set(k, v) { const db = await openDB(); const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); return txDone(t); },
};

/* =========================================================
 * 狀態
 * ========================================================= */
let manuals = [];          // 全部元資料
let byId = new Map();
let recent = [];           // 最近查看的 id
let favs = new Set();      // 收藏的 id

function setManuals(list) {
  manuals = list;
  byId = new Map(list.map((m) => [m.id, m]));
}

let exps = [];                // 全部維修經驗
let expsByManual = new Map(); // manualId → 經驗（新的在前）
const expNewer = (a, b) => (b.date - a.date) || (b.updatedAt - a.updatedAt);
function setExps(list) {
  for (const x of list) {
    // 搜索用的標準化文字，不可枚舉，不會寫進備份
    Object.defineProperty(x, '_hay', { value: normText([x.item, x.content, x.author].join(' ')), enumerable: false, configurable: true });
  }
  exps = list;
  expsByManual = new Map();
  for (const x of [...list].sort(expNewer)) {
    if (!expsByManual.has(x.manualId)) expsByManual.set(x.manualId, []);
    expsByManual.get(x.manualId).push(x);
  }
}
const expCount = (id) => (expsByManual.get(id) || []).length;

/* =========================================================
 * 工具函數
 * ========================================================= */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** 按當前語言排序 */
let collator = new Intl.Collator(LANG);
const cmp = (a, b) => collator.compare(a, b);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const fmtDate = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** 型號標準化：全形轉半形、大寫、去掉空格和常見分隔符 */
function norm(s) {
  return String(s || '').normalize('NFKC').toUpperCase().replace(/[\s\-_/\\.·・,，、:：()（）]+/g, '');
}
/** 文字標準化（用於標題等）：全形轉半形、小寫、去空白 */
const normText = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/** 拆分型號輸入：逗號、分號、頓號、換行 */
const splitModels = (s) => [...new Set(String(s || '').split(/[,，;；、\n\r]+/).map((x) => x.trim()).filter(Boolean))];

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function fileKind(m) {
  const t = (m.fileType || '').toLowerCase();
  const ext = (m.fileName || '').split('.').pop().toLowerCase();
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (t.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext)) return 'image';
  return 'other';
}
function fileBadge(m) {
  const k = fileKind(m);
  if (k === 'pdf') return ['pdf', 'PDF'];
  if (k === 'image') return ['img', t('ftype.image')];
  const ext = (m.fileName || '').split('.').pop().toUpperCase().slice(0, 4);
  return ['', ext || t('ftype.file')];
}

let toastTimer;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* =========================================================
 * 搜索
 * ========================================================= */
function search(query) {
  const raw = query.trim();
  const q = norm(raw);
  if (!q) return [];
  const qt = normText(raw);
  const tokens = raw.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
  const maxDist = q.length >= 8 ? 2 : q.length >= 4 ? 1 : 0;
  const out = [];

  for (const m of manuals) {
    let score = 0;
    const hits = new Set();
    for (const model of m.models) {
      const nm = m._norm?.get(model) ?? norm(model);
      let s = 0;
      if (nm === q) s = 100;
      else if (nm.startsWith(q)) s = 85 - Math.min(10, nm.length - q.length);
      else if (nm.includes(q)) s = 70;
      else if (nm.length >= 3 && q.includes(nm)) s = 60;
      else if (maxDist && levenshtein(nm, q, maxDist) <= maxDist) s = 50;
      if (s) { hits.add(model); score = Math.max(score, s); }
    }
    if (score < 40) {
      const hay = normText([m.title, m.brand, m.device, m.dept, m.notes, m.fileName].join(' '));
      if (hay.includes(qt) || (tokens.length > 1 && tokens.every((t) => hay.includes(t)))) score = Math.max(score, 30);
    }
    // 維修經驗：故障代碼、配件名等寫在經驗裡也能找到這台設備（顯示最新的一條命中）
    const expHit = (expsByManual.get(m.id) || []).find((x) => x._hay.includes(qt) || (tokens.length > 1 && tokens.every((t) => x._hay.includes(t))));
    if (expHit) score = Math.max(score, 35);
    if (score) out.push({ m, score, hits, expHit });
  }
  out.sort((a, b) => b.score - a.score || cmp(a.m.title, b.m.title));
  return out;
}

const BULB = '<svg class="ico" viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z"/></svg>';

/** 轉義並把 q 標記出來（不分大小寫） */
function markText(text, q) {
  const str = String(text || '');
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return esc(str);
  const low = str.toLowerCase();
  let out = '', i = 0, j;
  while ((j = low.indexOf(needle, i)) !== -1) {
    out += esc(str.slice(i, j)) + '<mark>' + esc(str.slice(j, j + needle.length)) + '</mark>';
    i = j + needle.length;
  }
  return out + esc(str.slice(i));
}

function cardHTML(m, hits, best, expHit, q) {
  const [cls, label] = fileBadge(m);
  const n = expCount(m.id);
  const expLine = expHit ? `<div class="card-exp"><b>${markText(expHit.item, q)}</b> ${markText(expHit.content, q)}</div>` : '';
  const pill = n ? `<button type="button" class="exp-pill" data-exps="${m.id}"${expHit ? ` data-exps-q="${esc(q)}"` : ''}>${BULB}${esc(t('exp.count', { n }))}</button>` : '';
  const chips = m.models.map((x) => `<span class="chip${hits && hits.has(x) ? ' hit' : ''}">${esc(x)}</span>`).join('');
  const sub = [m.brand, m.device, m.dept].filter(Boolean).map(esc).join(' · ');
  return `<div class="card${best ? ' best' : ''}" data-open="${m.id}">
    <div class="ftype ${cls}">${label}</div>
    <div class="card-body">
      <div class="card-title">${esc(m.title)}</div>
      <div class="chips">${chips}</div>
      ${sub ? `<div class="card-sub">${sub}</div>` : ''}
      ${expLine}${pill}
    </div>
    <div class="card-actions">
      <button type="button" class="icon-btn star${favs.has(m.id) ? ' on' : ''}" data-star="${m.id}" aria-label="${esc(t('card.fav'))}">
        <svg class="ico" viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>
      </button>
      <button type="button" class="icon-btn" data-edit="${m.id}" aria-label="${esc(t('card.edit'))}">
        <svg class="ico" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>
      </button>
    </div>
  </div>`;
}

let searchTimer;
function renderSearch() {
  const raw = $('#q').value;
  $('#clearQ').hidden = !raw;
  const home = $('#home');
  const results = $('#results');
  const meta = $('#searchMeta');

  if (!raw.trim()) {
    results.innerHTML = '';
    home.hidden = false;
    meta.textContent = manuals.length ? t('search.total', { n: manuals.length }) : '';
    renderHome();
    return;
  }
  home.hidden = true;
  const res = search(raw);
  if (!res.length) {
    meta.textContent = '';
    results.innerHTML = `<div class="empty">
      <p>${esc(t('search.none', { q: raw.trim() }))}</p>
      <p class="muted">${esc(t('search.noneHint'))}</p>
      <button type="button" class="btn primary" data-add-model="${esc(raw.trim())}">${esc(t('search.addForModel'))}</button>
    </div>`;
    return;
  }
  const exact = res.filter((r) => r.score === 100).length;
  meta.textContent = !exact ? t('search.near', { n: res.length }) : res.length > exact ? t('search.exactNear', { n: exact, m: res.length - exact }) : t('search.exact', { n: exact });
  results.innerHTML = res.slice(0, 100).map((r, i) => cardHTML(r.m, r.hits, i === 0 && r.score === 100, r.expHit, raw.trim())).join('');
}

function renderHome() {
  $('#emptyLib').hidden = manuals.length > 0;
  const favItems = manuals.filter((m) => favs.has(m.id)).sort((a, b) => cmp(a.title, b.title));
  $('#favWrap').hidden = !favItems.length;
  $('#favList').innerHTML = favItems.map((m) => cardHTML(m)).join('');
  const rec = recent.map((id) => byId.get(id)).filter(Boolean).slice(0, 8);
  $('#recentWrap').hidden = !rec.length;
  $('#recentList').innerHTML = rec.map((m) => cardHTML(m)).join('');
  const recExp = exps.filter((x) => byId.has(x.manualId)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  $('#recentExpWrap').hidden = !recExp.length;
  $('#recentExpList').innerHTML = recExp.map((x) => `<button type="button" class="exp-row" data-exps="${x.manualId}" data-exp-focus="${x.id}">
      <span class="exp-row-top">${resultTag(x.result)}<b>${esc(x.item)}</b></span>
      <span class="exp-row-text">${esc(x.content)}</span>
      <span class="exp-row-sub">${esc(byId.get(x.manualId).title)} · ${fmtDate(x.date)}${imgCount(x) ? ` · ${IMG_ICON}${imgCount(x)}` : ''}</span>
    </button>`).join('');
}

/* =========================================================
 * 手冊庫
 * ========================================================= */
function fillSelect(sel, values, allLabel) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option>${esc(v)}</option>`).join('');
  sel.value = values.includes(cur) ? cur : '';
}
const uniq = (key) => [...new Set(manuals.map((m) => m[key]).filter(Boolean))].sort(cmp);

function renderLibrary() {
  fillSelect($('#fltBrand'), uniq('brand'), t('lib.allBrands'));
  fillSelect($('#fltDept'), uniq('dept'), t('lib.allDepts'));
  const b = $('#fltBrand').value, d = $('#fltDept').value, sort = $('#fltSort').value;
  let list = manuals.filter((m) => (!b || m.brand === b) && (!d || m.dept === d));
  list.sort(sort === 'updated' ? (x, y) => y.updatedAt - x.updatedAt : (x, y) => cmp(x.title, y.title));
  $('#libMeta').textContent = list.length !== manuals.length ? t('lib.countOf', { n: list.length, total: manuals.length }) : t('lib.count', { n: list.length });
  $('#libList').innerHTML = list.length ? list.map((m) => cardHTML(m)).join('')
    : `<div class="empty"><p>${esc(t('lib.empty1'))}</p><p class="muted">${esc(t('lib.empty2'))}</p></div>`;
  for (const [id, key] of [['brandList', 'brand'], ['deviceList', 'device'], ['deptList', 'dept']]) {
    $('#' + id).innerHTML = uniq(key).map((v) => `<option value="${esc(v)}">`).join('');
  }
}

/* =========================================================
 * 設置頁
 * ========================================================= */
async function renderSettings() {
  const total = manuals.reduce((s, m) => s + (m.size || 0), 0);
  const rows = [[t('set.count'), t('set.countVal', { n: manuals.length })], [t('set.expCount'), t('set.expCountVal', { n: exps.length })], [t('set.size'), fmtSize(total)]];
  if (navigator.storage?.estimate) {
    try {
      const e = await navigator.storage.estimate();
      rows.push([t('set.quota'), fmtSize(Math.max(0, e.quota - e.usage))]);
    } catch { /* ignore */ }
  }
  if (NATIVE) {
    rows.push([t('set.persist'), t('set.persistOn')]);
  } else if (navigator.storage?.persisted) {
    try {
      const p = await navigator.storage.persisted();
      rows.push([t('set.persist'), p ? t('set.persistOn') : t('set.persistOff')]);
    } catch { /* ignore */ }
  }
  const last = await store.get('lastBackup');
  rows.push([t('set.lastBackup'), last ? fmtDate(last) : t('set.never')]);
  $('#storageInfo').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><span>${esc(v)}</span></div>`).join('');
  $('#versionInfo').textContent = t('set.version', { v: APP_VERSION });
}

/* =========================================================
 * 視圖切換
 * ========================================================= */
const titleKeys = { search: 'app.title', library: 'tab.library', settings: 'tab.settings' };
let currentView = 'search';
function showView(v) {
  currentView = v;
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + v));
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.view === v));
  $('#pageTitle').textContent = t(titleKeys[v]);
  refresh();
  window.scrollTo(0, 0);
}
function refresh() {
  if (currentView === 'search') renderSearch();
  else if (currentView === 'library') renderLibrary();
  else renderSettings();
}

/* =========================================================
 * 遮罩層 + Android 返回鍵
 * 打開遮罩時壓入一條歷史記錄，按返回鍵只關閉遮罩，不退出應用。
 * ========================================================= */
const overlays = [];
let skipPop = 0;
function openOverlay(el, onClose) {
  el.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
  overlays.push({ el, onClose });
  history.pushState({ overlay: overlays.length }, '');
}
function closeOverlay(fromPop = false, count = 1) {
  let n = 0;
  while (n < count && overlays.length) {
    const top = overlays.pop();
    top.el.classList.remove('open');
    top.el.hidden = true;
    top.onClose && top.onClose();
    n++;
  }
  if (n && !fromPop) { skipPop++; history.go(-n); }
}
window.addEventListener('popstate', () => {
  if (skipPop) { skipPop--; return; }
  if (overlays.length) closeOverlay(true);
});

/* =========================================================
 * 新增 / 編輯
 * ========================================================= */
let editing = null;      // 正在編輯的 meta；null 表示新增
let pickedFile = null;

function openEditor(m, preset = {}) {
  editing = m || null;
  pickedFile = null;
  const f = $('#editForm');
  f.querySelectorAll('.invalid').forEach((x) => x.classList.remove('invalid'));
  $('#editTitle').textContent = m ? t('edit.edit') : t('edit.new');
  $('#fModels').value = (m ? m.models : splitModels(preset.models)).join(', ');
  $('#fTitle').value = m?.title || '';
  $('#fBrand').value = m?.brand || '';
  $('#fDevice').value = m?.device || '';
  $('#fDept').value = m?.dept || '';
  $('#fNotes').value = m?.notes || '';
  $('#fileInfo').textContent = m ? t('edit.fileExisting', { name: m.fileName, size: fmtSize(m.size) }) : t('edit.noFile');
  $('#deleteBtn').hidden = !m;
  $('#fileInput').value = '';
  openOverlay($('#editSheet'));
}

$('#pickFile').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pickedFile = file;
  $('#fileInfo').textContent = `${file.name} · ${fmtSize(file.size)}`;
  $('#fileInput').closest('.field').classList.remove('invalid');
  if (!$('#fTitle').value.trim()) $('#fTitle').placeholder = stripExt(file.name);
  if (!$('#fModels').value.trim()) {
    const g = guessFromName(file.name);
    if (g.fromRule) $('#fModels').value = g.models.join(', ');
  }
};

const stripExt = (n) => n.replace(/\.[^.]+$/, '');
/** 文件名規則：型號1,型號2__標題.pdf */
function guessFromName(name) {
  const stem = stripExt(name).trim();
  const i = stem.indexOf('__');
  if (i > 0) return { models: splitModels(stem.slice(0, i)), title: stem.slice(i + 2).trim() || stem, fromRule: true };
  return { models: [stem], title: stem, fromRule: false };
}

function withNorm(m) {
  Object.defineProperty(m, '_norm', { value: new Map(m.models.map((x) => [x, norm(x)])), enumerable: false, configurable: true });
  return m;
}

$('#editForm').onsubmit = async (e) => {
  e.preventDefault();
  const models = splitModels($('#fModels').value);
  let ok = true;
  const fileField = $('#fileInput').closest('.field');
  const modelField = $('#fModels').closest('.field');
  fileField.classList.toggle('invalid', !editing && !pickedFile);
  modelField.classList.toggle('invalid', !models.length);
  if (!editing && !pickedFile) ok = false;
  if (!models.length) ok = false;
  if (!ok) { toast(t('edit.required')); return; }

  const now = Date.now();
  const base = editing ? { ...editing } : { id: uid(), createdAt: now };
  const meta = {
    ...base,
    models,
    title: $('#fTitle').value.trim() || (pickedFile ? stripExt(pickedFile.name) : base.title),
    brand: $('#fBrand').value.trim(),
    device: $('#fDevice').value.trim(),
    dept: $('#fDept').value.trim(),
    notes: $('#fNotes').value.trim(),
    updatedAt: now,
  };
  if (pickedFile) Object.assign(meta, { fileName: pickedFile.name, fileType: pickedFile.type, size: pickedFile.size });

  const btn = $('#saveBtn');
  btn.disabled = true;
  btn.textContent = t('edit.saving');
  try {
    await store.put(meta, pickedFile);
    withNorm(meta);
    const list = manuals.filter((x) => x.id !== meta.id);
    list.push(meta);
    setManuals(list);
    requestPersist();
    closeOverlay();
    toast(editing ? t('edit.saved') : t('edit.added'));
    refresh();
    if (viewerMeta && viewerMeta.id === meta.id) $('#vTitle').textContent = meta.title;
  } catch (err) {
    console.error(err);
    toast(isQuota(err) ? t('edit.quota') : t('edit.saveFail', { e: err.message || err }), 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = t('edit.save');
  }
};

$('#deleteBtn').onclick = async () => {
  if (!editing) return;
  const id = editing.id;
  const expIds = (expsByManual.get(id) || []).map((x) => x.id);
  if (!confirm(expIds.length ? t('edit.delConfirmExp', { t: editing.title, n: expIds.length }) : t('edit.delConfirm', { t: editing.title }))) return;
  const imgIds = (expsByManual.get(id) || []).flatMap((x) => x.images || []);
  await store.remove(id, expIds, imgIds);
  imgIds.forEach(dropThumb);
  setManuals(manuals.filter((x) => x.id !== id));
  setExps(exps.filter((x) => x.manualId !== id));
  favs.delete(id);
  recent = recent.filter((x) => x !== id);
  store.set('favs', [...favs]);
  store.set('recent', recent);
  closeOverlay(false, viewerMeta && viewerMeta.id === id ? 2 : 1);
  toast(t('edit.deleted'));
  refresh();
};

const isQuota = (err) => err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''));

async function requestPersist() {
  if (NATIVE) return;
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* ignore */ }
}

/* =========================================================
 * 批量導入
 * ========================================================= */
$('#batchBtn').onclick = () => $('#batchInput').click();
$('#batchInput').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const btn = $('#batchBtn');
  btn.disabled = true;
  let done = 0, failed = 0;
  const added = [];
  for (const file of files) {
    btn.textContent = t('set.batchProgress', { i: done + failed + 1, n: files.length });
    const g = guessFromName(file.name);
    const now = Date.now();
    const meta = { id: uid(), createdAt: now, updatedAt: now, models: g.models, title: g.title, brand: '', device: '', dept: '', notes: '', fileName: file.name, fileType: file.type, size: file.size };
    try { await store.put(meta, file); added.push(withNorm(meta)); done++; }
    catch (err) { console.error(err); failed++; if (isQuota(err)) break; }
  }
  setManuals(manuals.concat(added));
  requestPersist();
  btn.disabled = false;
  btn.textContent = t('set.batchBtn');
  toast(failed ? t('set.batchDoneFail', { n: done, f: failed }) : t('set.batchDone', { n: done }), 3000);
  refresh();
};

/* =========================================================
 * 備份 / 恢復
 * 格式：'MANLIB1\n' + 12 位長度 + JSON 頭 + 依次拼接的文件原始字節
 * 直接拼接 Blob，不會把文件讀進記憶體，大手冊庫也能導出。
 * ========================================================= */
const MAGIC = 'MANLIB1\n';
$('#exportBtn').onclick = async () => {
  if (!manuals.length) { toast(t('set.exportEmpty')); return; }
  const btn = $('#exportBtn');
  btn.disabled = true;
  btn.textContent = t('set.packing');
  try {
    const entries = [];
    const blobs = [];
    let offset = 0;
    for (const m of manuals) {
      const blob = await store.file(m.id);
      if (!blob) continue;
      entries.push({ meta: { ...m }, offset, size: blob.size });
      blobs.push(blob);
      offset += blob.size;
    }
    // version 2 起加入 exps，version 3 起加入經驗圖片；舊版應用恢復時會忽略不認識的欄位，仍能恢復手冊
    const saved = new Set(entries.map((en) => en.meta.id));
    const backupExps = exps.filter((x) => saved.has(x.manualId));
    const images = [];
    for (const x of backupExps) {
      for (const id of x.images || []) {
        const im = await store.img(id);
        if (!im) continue;
        images.push({ id, w: im.w, h: im.h, offset, size: im.blob.size, thumbOffset: offset + im.blob.size, thumbSize: im.thumb.size });
        blobs.push(im.blob, im.thumb);
        offset += im.blob.size + im.thumb.size;
      }
    }
    const header = new TextEncoder().encode(JSON.stringify({ app: 'manual-workbench', version: 3, exportedAt: Date.now(), entries, exps: backupExps, images }));
    const len = String(header.length).padStart(12, '0');
    const out = new Blob([MAGIC, len, header, ...blobs], { type: 'application/octet-stream' });
    const fileName = `${t('set.backupFile')}_${fmtDate(Date.now())}.manlib`;
    if (NATIVE) {
      if (!(await nativeFile(out, fileName, 'application/octet-stream', 'save'))) return;
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(out);
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
    await store.set('lastBackup', Date.now());
    toast(t(NATIVE ? 'set.exportSaved' : 'set.exportDone', { n: entries.length, size: fmtSize(out.size) }), 4000);
    if (currentView === 'settings') renderSettings();
  } catch (err) {
    console.error(err);
    toast(t('set.exportFail', { e: err.message || err }), 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = t('set.export');
  }
};

$('#importBtn').onclick = () => $('#importInput').click();
$('#importInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const btn = $('#importBtn');
  try {
    const magic = await file.slice(0, 8).text();
    if (magic !== MAGIC) throw new Error(t('set.importInvalid'));
    const hlen = parseInt(await file.slice(8, 20).text(), 10);
    const header = JSON.parse(await file.slice(20, 20 + hlen).text());
    const start = 20 + hlen;
    const n = header.entries.length;
    const dup = header.entries.filter((x) => byId.has(x.meta.id)).length;
    if (!confirm(dup ? t('set.importConfirmDup', { n, d: dup }) : t('set.importConfirm', { n }))) return;
    btn.disabled = true;
    const list = new Map(byId);
    let i = 0;
    for (const ent of header.entries) {
      btn.textContent = t('set.importProgress', { i: ++i, n });
      const meta = ent.meta;
      const blob = file.slice(start + ent.offset, start + ent.offset + ent.size, meta.fileType || 'application/octet-stream');
      // 複製成獨立 Blob，避免依賴原備份文件
      const own = new Blob([await blob.arrayBuffer()], { type: meta.fileType || '' });
      await store.put(meta, own);
      list.set(meta.id, withNorm(meta));
    }
    setManuals([...list.values()]);
    if (Array.isArray(header.images)) {
      for (const im of header.images) {
        const at = (o, n) => file.slice(start + o, start + o + n).arrayBuffer();
        await store.putImg({
          id: im.id, w: im.w, h: im.h,
          blob: new Blob([await at(im.offset, im.size)], { type: 'image/jpeg' }),
          thumb: new Blob([await at(im.thumbOffset, im.thumbSize)], { type: 'image/jpeg' }),
        });
        dropThumb(im.id);
      }
    }
    if (Array.isArray(header.exps)) {
      const merged = new Map(exps.map((x) => [x.id, x]));
      for (const x of header.exps) {
        if (!x || !x.id || !list.has(x.manualId)) continue;
        await store.putExp(x);
        merged.set(x.id, x);
      }
      setExps([...merged.values()]);
    }
    requestPersist();
    toast(t('set.importDone', { n }), 3000);
    refresh();
  } catch (err) {
    console.error(err);
    toast(isQuota(err) ? t('set.importQuota') : t('set.importFail', { e: err.message || err }), 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = t('set.import');
  }
};

/* =========================================================
 * 收藏 / 最近
 * ========================================================= */
function toggleFav(id) {
  favs.has(id) ? favs.delete(id) : favs.add(id);
  store.set('favs', [...favs]);
  refresh();
}
function pushRecent(id) {
  recent = [id, ...recent.filter((x) => x !== id)].slice(0, 20);
  store.set('recent', recent);
}

/* =========================================================
 * 掃碼（Android Chrome 支持 BarcodeDetector）
 * ========================================================= */
let scanStream = null, scanTimer = null;
async function startScan() {
  let detector;
  try {
    detector = new BarcodeDetector();
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (err) {
    toast(t('scan.camErr', { e: err.message || err }), 3500);
    return;
  }
  const video = $('#scanVideo');
  video.srcObject = scanStream;
  openOverlay($('#scanner'), stopScan);
  await video.play().catch(() => {});
  const tick = async () => {
    if (!scanStream) return;
    try {
      const codes = await detector.detect(video);
      if (codes.length) {
        const v = codes[0].rawValue.trim();
        closeOverlay();
        $('#q').value = v;
        renderSearch();
        if (navigator.vibrate) navigator.vibrate(60);
        return;
      }
    } catch { /* 畫面未就緒 */ }
    scanTimer = setTimeout(tick, 250);
  };
  tick();
}
function stopScan() {
  clearTimeout(scanTimer);
  if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
  scanStream = null;
  $('#scanVideo').srcObject = null;
}

/* =========================================================
 * 閱讀器
 * ========================================================= */
let viewerMeta = null;
let viewerBlob = null;
let viewerUrl = null;
const V = {
  kind: null, doc: null, zoom: 1, ratio: 1.414, pages: [], visible: new Set(), io: null,
  textCache: new Map(), findTerm: '', findToken: 0,
};
const vBody = $('#vBody');
const vPages = $('#vPages');

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}
async function ensurePdfJs() {
  if (window.pdfjsLib) return;
  await loadScript('vendor/pdfjs/pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
}

async function openManual(id) {
  const m = byId.get(id);
  if (!m) return;
  viewerMeta = m;
  pushRecent(id);
  $('#vTitle').textContent = m.title;
  updateViewerExpCount();
  $('#vMenu').hidden = true;
  $('#vFindBar').hidden = true;
  $('#vFindResults').hidden = true;
  $('#vFindInput').value = '';
  vPages.innerHTML = `<div class="vmsg">${esc(t('v.opening'))}</div>`;
  openOverlay($('#viewer'), closeViewer);

  const blob = await store.file(id);
  if (!blob) { vPages.innerHTML = `<div class="vmsg">${esc(t('v.missing'))}</div>`; return; }
  viewerBlob = blob;
  viewerUrl = URL.createObjectURL(blob);
  const kind = fileKind(m);
  V.kind = kind;
  $('#vFindBtn').hidden = kind !== 'pdf';
  $('#vFoot').hidden = kind === 'other';
  try {
    if (kind === 'pdf') await openPdf();
    else if (kind === 'image') await openImage();
    else showOtherFile();
  } catch (err) {
    console.error(err);
    vPages.innerHTML = `<div class="vmsg">${esc(t('v.cantShow', { e: err.message || err }))}
      <br><button type="button" class="btn primary" data-share>${esc(t('v.openWith'))}</button></div>`;
  }
}

function closeViewer() {
  V.io && V.io.disconnect();
  V.io = null;
  V.findToken++;
  if (V.doc) { V.doc.destroy(); V.doc = null; }
  V.pages = []; V.visible.clear(); V.textCache.clear(); V.findTerm = '';
  vPages.innerHTML = '';
  vPages.style.transform = '';
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = null; viewerBlob = null; viewerMeta = null;
  refresh();
}

function showOtherFile() {
  const m = viewerMeta;
  vPages.innerHTML = `<div class="vmsg">
    <p>${esc(m.fileName)} · ${fmtSize(m.size)}</p>
    <p>${esc(t('v.otherNeed'))}</p>
    <button type="button" class="btn primary" data-share>${esc(t('v.openWith'))}</button></div>`;
}

async function openImage() {
  const img = new Image();
  img.src = viewerUrl;
  await img.decode();
  V.ratio = img.naturalHeight / img.naturalWidth;
  V.zoom = 1;
  vPages.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'page';
  el._ratio = V.ratio;
  el.appendChild(img);
  vPages.appendChild(el);
  V.pages = [el];
  layoutPages();
  updatePageInd();
}

async function openPdf() {
  await ensurePdfJs();
  const task = pdfjsLib.getDocument({
    url: viewerUrl,
    cMapUrl: 'vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'vendor/pdfjs/standard_fonts/',
    isEvalSupported: false,
  });
  task.onPassword = (cb, reason) => {
    const pw = prompt(reason === 2 ? t('v.wrongPw') : t('v.password'));
    if (pw === null) task.destroy(); else cb(pw);
  };
  const doc = await task.promise;
  if (!viewerMeta) { doc.destroy(); return; } // 已關閉
  V.doc = doc;
  const p1 = await doc.getPage(1);
  const vp = p1.getViewport({ scale: 1 });
  V.ratio = vp.height / vp.width;
  V.zoom = 1;
  vPages.innerHTML = '';
  const frag = document.createDocumentFragment();
  V.pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.n = i;
    el.innerHTML = `<span class="pno">${i}</span>`;
    frag.appendChild(el);
    V.pages.push(el);
  }
  vPages.appendChild(frag);
  layoutPages();
  vBody.scrollTop = 0;
  V.io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) { V.visible.add(en.target); renderPage(en.target); }
      else { V.visible.delete(en.target); releasePage(en.target); }
    }
  }, { root: vBody, rootMargin: '120% 40% 120% 40%' });
  V.pages.forEach((el) => V.io.observe(el));
  updatePageInd();
}

function pageWidth() {
  return Math.max(120, Math.round((vBody.clientWidth - 16) * V.zoom));
}
function layoutPages() {
  const w = pageWidth();
  for (const el of V.pages) {
    el.style.width = w + 'px';
    el.style.height = Math.round(w * (el._ratio || V.ratio)) + 'px';
  }
}

async function renderPage(el) {
  if (V.kind !== 'pdf' || !V.doc) return;
  const w = el.clientWidth;
  if (el._rw === w || el._rendering === w) return;
  el._rendering = w;
  const doc = V.doc;
  try {
    const page = await doc.getPage(+el.dataset.n);
    if (doc !== V.doc) return;
    const vp1 = page.getViewport({ scale: 1 });
    const ratio = vp1.height / vp1.width;
    if (Math.abs(ratio - (el._ratio || V.ratio)) > 0.005) {
      el._ratio = ratio;
      el.style.height = Math.round(w * ratio) + 'px';
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    let scale = (w / vp1.width) * dpr;
    const MAX_PX = 9e6; // 手機 canvas 上限保護
    if (vp1.width * vp1.height * scale * scale > MAX_PX) scale = Math.sqrt(MAX_PX / (vp1.width * vp1.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    if (el._task) el._task.cancel();
    const task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp });
    el._task = task;
    await task.promise;
    if (el._task === task) el._task = null;
    if (doc !== V.doc || !V.visible.has(el)) return;
    const old = el.querySelector('canvas');
    old ? old.replaceWith(canvas) : el.prepend(canvas);
    el._rw = w;
    if (V.findTerm) drawMarks(el, page);
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.warn('render', err);
  } finally {
    if (el._rendering === w) el._rendering = 0;
  }
}

function releasePage(el) {
  if (el._task) { el._task.cancel(); el._task = null; }
  const c = el.querySelector('canvas');
  if (c) { c.width = 0; c.height = 0; c.remove(); }
  el._rw = 0;
  el._rendering = 0;
}

function currentPageIndex() {
  const mid = vBody.scrollTop + vBody.clientHeight / 3;
  let lo = 0, hi = V.pages.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (V.pages[m].offsetTop <= mid) lo = m; else hi = m - 1;
  }
  return lo;
}
function updatePageInd() {
  $('#pageInd').textContent = V.pages.length ? `${currentPageIndex() + 1} / ${V.pages.length}` : '– / –';
}
let scrollRaf = 0;
vBody.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updatePageInd(); });
}, { passive: true });

function goToPage(n, flash) {
  const el = V.pages[n - 1];
  if (!el) return;
  vBody.scrollTop = el.offsetTop - 8;
  vBody.scrollLeft = Math.max(0, el.offsetLeft + el.offsetWidth / 2 - vBody.clientWidth / 2);
  if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
}

/** 縮放並保持 (ax, ay) 這一點（相對 vBody 可視區）位置不變 */
function setZoom(z, ax = vBody.clientWidth / 2, ay = vBody.clientHeight / 2) {
  z = Math.min(5, Math.max(0.5, z));
  if (Math.abs(z - V.zoom) < 0.001 || !V.pages.length) return;
  const f = z / V.zoom;
  const cx = vBody.scrollLeft + ax, cy = vBody.scrollTop + ay;
  V.zoom = z;
  layoutPages();
  vBody.scrollLeft = cx * f - ax;
  vBody.scrollTop = cy * f - ay;
  V.visible.forEach((el) => renderPage(el));
  updatePageInd();
}
$('#zIn').onclick = () => setZoom(V.zoom * 1.25);
$('#zOut').onclick = () => setZoom(V.zoom / 1.25);
$('#zFit').onclick = () => setZoom(1, 0, vBody.clientHeight / 3);
$('#pageInd').onclick = () => {
  if (V.pages.length < 2) return;
  const v = prompt(t('v.jump', { n: V.pages.length }), String(currentPageIndex() + 1));
  const n = parseInt(v, 10);
  if (n >= 1 && n <= V.pages.length) goToPage(n);
};

// 雙指縮放
let pinch = null;
const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
vBody.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 2 || !V.pages.length) return;
  const r = vBody.getBoundingClientRect();
  const ax = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
  const ay = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
  pinch = { d0: dist(e.touches), ax, ay, ratio: 1 };
  vPages.style.transformOrigin = `${vBody.scrollLeft + ax}px ${vBody.scrollTop + ay}px`;
}, { passive: true });
vBody.addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const z = Math.min(5, Math.max(0.5, V.zoom * dist(e.touches) / pinch.d0));
  pinch.ratio = z / V.zoom;
  vPages.style.transform = `scale(${pinch.ratio})`;
}, { passive: false });
vBody.addEventListener('touchend', (e) => {
  if (!pinch || e.touches.length >= 2) return;
  const { ratio, ax, ay } = pinch;
  pinch = null;
  vPages.style.transform = '';
  setZoom(V.zoom * ratio, ax, ay);
});
// 雙擊切換縮放
let lastTap = 0;
vBody.addEventListener('click', (e) => {
  const now = Date.now();
  if (now - lastTap < 300) {
    const r = vBody.getBoundingClientRect();
    setZoom(V.zoom > 1.1 ? 1 : 2, e.clientX - r.left, e.clientY - r.top);
    lastTap = 0;
  } else lastTap = now;
});

/* ---------- 文內搜索 ---------- */
async function pageText(n) {
  if (V.textCache.has(n)) return V.textCache.get(n);
  const page = await V.doc.getPage(n);
  const tc = await page.getTextContent();
  const items = tc.items.filter((it) => typeof it.str === 'string');
  const str = items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('');
  const rec = { items, str, low: str.normalize('NFKC').toLowerCase() };
  V.textCache.set(n, rec);
  return rec;
}

$('#vFindBtn').onclick = () => {
  const bar = $('#vFindBar');
  bar.hidden = !bar.hidden;
  $('#vMenu').hidden = true;
  if (!bar.hidden) $('#vFindInput').focus();
  else { $('#vFindResults').hidden = true; clearFind(); }
};
$('#vFindInput').addEventListener('focus', () => { if ($('#vFindResults').innerHTML) $('#vFindResults').hidden = false; });

function clearFind() {
  V.findTerm = '';
  V.findToken++;
  vPages.querySelectorAll('.mark').forEach((x) => x.remove());
}

$('#vFindBar').onsubmit = async (e) => {
  e.preventDefault();
  const term = $('#vFindInput').value.trim();
  const box = $('#vFindResults');
  clearFind();
  if (!term || !V.doc) { box.hidden = true; box.innerHTML = ''; return; }
  $('#vFindInput').blur();
  V.findTerm = term.normalize('NFKC').toLowerCase();
  const tight = V.findTerm.replace(/\s+/g, '');
  const token = ++V.findToken;
  box.hidden = false;
  box.innerHTML = `<div class="fr-status">${esc(t('find.searching'))}</div>`;
  const results = [];
  const N = V.doc.numPages;
  for (let n = 1; n <= N; n++) {
    if (token !== V.findToken) return;
    let pt;
    try { pt = await pageText(n); } catch { continue; }
    let idx = pt.low.indexOf(V.findTerm);
    let count = 0, first = idx;
    while (idx !== -1) { count++; idx = pt.low.indexOf(V.findTerm, idx + V.findTerm.length); }
    if (!count && tight && pt.low.replace(/\s+/g, '').includes(tight)) { count = 1; first = -1; }
    if (count) results.push({ n, count, snippet: snippet(pt.str, first, V.findTerm.length) });
    if (n % 10 === 0 || n === N) {
      box.innerHTML = resultsHTML(results) + (n < N ? `<div class="fr-status">${esc(t('find.progress', { i: n, n: N }))}</div>` : '');
    }
  }
  if (token !== V.findToken) return;
  if (!results.length) {
    box.innerHTML = `<div class="fr-status">${esc(t('find.none', { q: term }))}<br>${esc(t('find.noneHint'))}</div>`;
  } else {
    box.innerHTML = `<div class="fr-status">${esc(t('find.summary', { c: results.reduce((s, r) => s + r.count, 0), p: results.length }))}</div>` + resultsHTML(results);
  }
  // 已渲染頁面補上高亮
  V.visible.forEach((el) => { if (el._rw) V.doc.getPage(+el.dataset.n).then((p) => drawMarks(el, p)); });
};

function snippet(str, idx, len) {
  if (idx < 0) return esc(str.slice(0, 60).replace(/\s+/g, ' '));
  const a = Math.max(0, idx - 24), b = Math.min(str.length, idx + len + 36);
  const clean = (s) => esc(s.replace(/\s+/g, ' '));
  return (a > 0 ? '…' : '') + clean(str.slice(a, idx)) + '<mark>' + clean(str.slice(idx, idx + len)) + '</mark>' + clean(str.slice(idx + len, b)) + (b < str.length ? '…' : '');
}
const resultsHTML = (rs) => rs.map((r) => `<button type="button" class="fr" data-page="${r.n}"><b>${esc(t('find.page', { n: r.n }))}</b>${r.count > 1 ? `<span class="muted">${esc(t('find.count', { n: r.count }))}</span> ` : ''}${r.snippet}</button>`).join('');

$('#vFindResults').addEventListener('click', (e) => {
  const b = e.target.closest('[data-page]');
  if (!b) return;
  $('#vFindResults').hidden = true;
  const n = +b.dataset.page;
  goToPage(n, true);
  // 頁面在高倍縮放時，把第一個高亮滾到可視區
  setTimeout(() => {
    const mk = V.pages[n - 1].querySelector('.mark');
    if (mk && V.zoom > 1) {
      const el = V.pages[n - 1];
      vBody.scrollTop = el.offsetTop + mk.offsetTop - vBody.clientHeight / 3;
      vBody.scrollLeft = el.offsetLeft + mk.offsetLeft - 24;
    }
  }, 400);
});

async function drawMarks(el, page) {
  el.querySelectorAll('.mark').forEach((x) => x.remove());
  const term = V.findTerm;
  if (!term) return;
  const t = await pageText(+el.dataset.n);
  if (term !== V.findTerm) return;
  const vp = page.getViewport({ scale: 1 });
  const frag = document.createDocumentFragment();
  for (const it of t.items) {
    const low = it.str.normalize('NFKC').toLowerCase();
    let i = low.indexOf(term);
    while (i !== -1) {
      const tr = pdfjsLib.Util.transform(vp.transform, it.transform);
      const fh = Math.hypot(tr[2], tr[3]);
      const w = it.width * vp.scale;
      const L = low.length || 1;
      const x = tr[4] + (w * i) / L;
      const mw = Math.max((w * term.length) / L, 4);
      const d = document.createElement('div');
      d.className = 'mark';
      d.style.left = (x / vp.width) * 100 + '%';
      d.style.top = ((tr[5] - fh) / vp.height) * 100 + '%';
      d.style.width = (mw / vp.width) * 100 + '%';
      d.style.height = ((fh * 1.2) / vp.height) * 100 + '%';
      frag.appendChild(d);
      i = low.indexOf(term, i + term.length);
    }
  }
  el.appendChild(frag);
}

/* ---------- 更多選單 ---------- */
$('#vMoreBtn').onclick = (e) => { e.stopPropagation(); $('#vMenu').hidden = !$('#vMenu').hidden; };
document.addEventListener('click', (e) => { if (!e.target.closest('#vMenu, #vMoreBtn')) $('#vMenu').hidden = true; });
$('#vInfo').onclick = () => { $('#vMenu').hidden = true; if (viewerMeta) openEditor(viewerMeta); };
$('#vShare').onclick = () => { $('#vMenu').hidden = true; shareFile(); };

async function shareFile() {
  if (!viewerBlob || !viewerMeta) return;
  if (NATIVE) {
    try { await nativeFile(viewerBlob, viewerMeta.fileName || 'manual', viewerMeta.fileType || viewerBlob.type, 'share'); }
    catch (err) { toast(err.message || String(err), 3500); }
    return;
  }
  const file = new File([viewerBlob], viewerMeta.fileName || 'manual', { type: viewerMeta.fileType || viewerBlob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: viewerMeta.title }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  // 退回：下載到手機「下載」目錄
  const a = document.createElement('a');
  a.href = viewerUrl;
  a.download = viewerMeta.fileName || 'manual';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(t('v.savedDownload'));
}

window.addEventListener('resize', () => {
  if (!V.pages.length || $('#viewer').hidden) return;
  layoutPages();
  V.visible.forEach((el) => renderPage(el));
});

/* =========================================================
 * 維修經驗
 * 同一台設備（手冊）下按「維修項目」歸組，每個項目可以累積多條經驗，新的在前。
 * ========================================================= */
const RESULTS = ['ok', 'partial', 'fail'];
const resultTag = (r) => { const k = RESULTS.includes(r) ? r : 'ok'; return `<span class="res res-${k}">${esc(t('exp.' + k))}</span>`; };
const itemKey = (s) => normText(s);
let expManual = null;
let expEditing = null;

function updateViewerExpCount() {
  if (!viewerMeta) return;
  const n = expCount(viewerMeta.id);
  $('#vExpCount').hidden = !n;
  $('#vExpCount').textContent = n > 99 ? '99+' : String(n);
}

function openExps(manualId, { q = '', focus = null } = {}) {
  expManual = byId.get(manualId);
  if (!expManual) return;
  $('#expSub').textContent = [expManual.title, expManual.models.join(', ')].filter(Boolean).join(' · ');
  $('#expFilter').value = q;
  renderExps(focus);
  openOverlay($('#expSheet'));
}

function renderExps(focus) {
  if (!expManual) return;
  const list = expsByManual.get(expManual.id) || [];
  const body = $('#expBody');
  $('#expFilterWrap').hidden = !list.length;
  if (!list.length) {
    body.innerHTML = `<div class="empty"><p>${esc(t('exp.empty1'))}</p><p class="muted">${esc(t('exp.empty2'))}</p>
      <button type="button" class="btn primary" data-exp-add="">${esc(t('exp.add'))}</button></div>`;
    return;
  }
  const raw = $('#expFilter').value.trim();
  const fq = normText(raw);
  const groups = new Map();
  for (const x of list) {
    const k = itemKey(x.item);
    if (!groups.has(k)) groups.set(k, { name: x.item, all: [] });
    groups.get(k).all.push(x);
  }
  const html = [];
  for (const g of groups.values()) {
    // 項目名命中時整組都顯示，否則只顯示內容命中的經驗
    const shown = !fq || itemKey(g.name).includes(fq) ? g.all : g.all.filter((x) => x._hay.includes(fq));
    if (!shown.length) continue;
    html.push(`<section class="exp-group">
      <div class="exp-ghead"><h3>${markText(g.name, raw)}</h3><span>${esc(t('exp.groupMeta', { n: g.all.length, d: fmtDate(g.all[0].date) }))}</span></div>
      ${shown.map((x) => `<article class="exp${x.id === focus ? ' flash' : ''}" data-exp-id="${x.id}">
        <div class="exp-meta">${resultTag(x.result)}<span>${fmtDate(x.date)}</span>${x.author ? `<span>${esc(x.author)}</span>` : ''}
          <button type="button" class="icon-btn" data-exp-edit="${x.id}" aria-label="${esc(t('exp.edit'))}"><svg class="ico" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
        </div>
        ${x.content ? `<div class="exp-text">${markText(x.content, raw)}</div>` : ''}
        ${imgCount(x) ? `<div class="exp-imgs">${x.images.map((id, i) => `<button type="button" class="exp-img" data-img-view="${x.id}" data-img-idx="${i}" aria-label="${esc(t('img.open'))}"><img data-thumb="${id}" alt=""></button>`).join('')}</div>` : ''}
      </article>`).join('')}
      <button type="button" class="btn sm ghost exp-more" data-exp-add="${esc(g.name)}">+ ${esc(t('exp.addMore'))}</button>
    </section>`);
  }
  body.innerHTML = html.length ? html.join('') : `<div class="empty"><p class="muted">${esc(t('exp.noMatch', { q: raw }))}</p></div>`;
  hydrateThumbs(body);
  if (focus) {
    const el = body.querySelector(`[data-exp-id="${focus}"]`);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'center' }));
  }
}
$('#expFilter').addEventListener('input', () => renderExps());
$('#expAddBtn').onclick = () => openExpEditor(null);
$('#expSheet').addEventListener('click', (e) => { if (e.target.id === 'expSheet') closeOverlay(); });
$('#expEdit').addEventListener('click', (e) => { if (e.target.id === 'expEdit') closeOverlay(); });

function lastAuthor() { try { return localStorage.getItem('expAuthor') || ''; } catch { return ''; } }

function openExpEditor(x, item = '') {
  if (!expManual) return;
  expEditing = x || null;
  $('#expForm').querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  $('#expEditTitle').textContent = x ? t('exp.edit') : t('exp.new');
  $('#xItem').value = x ? x.item : item;
  $('#xContent').value = x ? x.content : '';
  $('#xDate').value = fmtDate(x ? x.date : Date.now());
  $('#xAuthor').value = x ? (x.author || '') : lastAuthor();
  const r = x && RESULTS.includes(x.result) ? x.result : 'ok';
  $('#expForm').querySelectorAll('[name=xResult]').forEach((el) => { el.checked = el.value === r; });
  const names = new Map();
  for (const e of expsByManual.get(expManual.id) || []) if (!names.has(itemKey(e.item))) names.set(itemKey(e.item), e.item);
  $('#expItemList').innerHTML = [...names.values()].map((v) => `<option value="${esc(v)}">`).join('');
  $('#xDelete').hidden = !x;
  releaseNewImgs();
  xImgs = (x && x.images ? x.images : []).map((id) => ({ id }));
  $('#xImgHint').textContent = t('exp.imgHint', { n: IMG_LIMIT });
  renderXImgs();
  openOverlay($('#expEdit'), releaseNewImgs);
}

$('#expForm').onsubmit = async (e) => {
  e.preventDefault();
  const item = $('#xItem').value.trim();
  const content = $('#xContent').value.trim();
  $('#xItem').closest('.field').classList.toggle('invalid', !item);
  $('#xContent').closest('.field').classList.toggle('invalid', !content);
  if (xImgBusy) return;
  if (!item || (!content && !xImgs.length)) { toast(t('exp.required')); return; }
  // 同一項目沿用已有的寫法，避免「E03堵塞」「e03 堵塞」分成兩組
  const same = (expsByManual.get(expManual.id) || []).find((x) => x !== expEditing && itemKey(x.item) === itemKey(item));
  const [y, mo, d] = $('#xDate').value.split('-').map(Number);
  const date = y ? new Date(y, mo - 1, d, 12).getTime() : Date.now();
  const now = Date.now();
  const rec = {
    ...(expEditing || { id: uid(), createdAt: now }),
    manualId: expManual.id,
    item: same ? same.item : item,
    result: $('#expForm').querySelector('[name=xResult]:checked')?.value || 'ok',
    content,
    date,
    author: $('#xAuthor').value.trim(),
    images: xImgs.map((im) => im.id),
    updatedAt: now,
  };
  const addImgs = xImgs.filter((im) => im.blob).map(({ id, blob, thumb, w, h }) => ({ id, blob, thumb, w, h }));
  const delImgIds = ((expEditing && expEditing.images) || []).filter((id) => !rec.images.includes(id));
  const btn = $('#expSaveBtn');
  btn.disabled = true;
  try {
    await store.putExp(rec, addImgs, delImgIds);
    // 新圖片的縮略圖 URL 交給緩存繼續用；被移除的圖片釋放掉
    for (const im of xImgs) if (im.blob) { thumbUrls.set(im.id, im.url); im.blob = null; }
    delImgIds.forEach(dropThumb);
    setExps(exps.filter((x) => x.id !== rec.id).concat(rec));
    try { localStorage.setItem('expAuthor', rec.author); } catch { /* ignore */ }
    requestPersist();
    closeOverlay();
    $('#expFilter').value = '';
    renderExps(rec.id);
    updateViewerExpCount();
    refresh();
    toast(t('exp.saved'));
  } catch (err) {
    console.error(err);
    toast(isQuota(err) ? t('edit.quota') : t('edit.saveFail', { e: err.message || err }), 4000);
  } finally {
    btn.disabled = false;
  }
};

$('#xDelete').onclick = async () => {
  if (!expEditing || !confirm(t('exp.delConfirm'))) return;
  const id = expEditing.id;
  const imgIds = expEditing.images || [];
  await store.removeExp(id, imgIds);
  imgIds.forEach(dropThumb);
  setExps(exps.filter((x) => x.id !== id));
  closeOverlay();
  renderExps();
  updateViewerExpCount();
  refresh();
  toast(t('exp.deleted'));
};
$('#vExpBtn').onclick = () => { if (viewerMeta) openExps(viewerMeta.id); };

/* ---------- 經驗圖片 ----------
 * 選進來的照片先壓縮（長邊 1600px 的 JPEG + 360px 縮略圖），手機拍的幾 MB 照片一般會變成 200–400 KB。
 * 新圖片在點「保存」之前只放在記憶體裡，取消編輯就丟掉。 */
const IMG_LIMIT = 9, IMG_MAX = 1600, THUMB_MAX = 360;
const IMG_ICON = '<svg class="ico tiny" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-8 8"/></svg>';
const imgCount = (x) => (x.images ? x.images.length : 0);
const thumbUrls = new Map(); // 圖片 id → 縮略圖 object URL
let xImgs = [];              // 編輯中的圖片 [{ id, blob?, thumb?, url? }]，有 blob 的是還沒保存的新圖片
let xImgBusy = false;

function dropThumb(id) {
  const u = thumbUrls.get(id);
  if (u) { URL.revokeObjectURL(u); thumbUrls.delete(id); }
}
async function thumbUrl(id) {
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  const im = await store.img(id);
  if (!im) return null;
  const u = URL.createObjectURL(im.thumb);
  thumbUrls.set(id, u);
  return u;
}
function hydrateThumbs(root) {
  root.querySelectorAll('img[data-thumb]').forEach(async (img) => {
    const u = await thumbUrl(img.dataset.thumb);
    if (u) img.src = u; else img.closest('.exp-img, .ximg')?.remove();
  });
}
function releaseNewImgs() {
  for (const im of xImgs) if (im.blob && im.url) URL.revokeObjectURL(im.url);
  xImgs = xImgs.filter((im) => !im.blob);
}

async function decodeImage(file) {
  try { return await createImageBitmap(file); } catch { /* 部分格式退回用 <img> 解碼 */ }
  const url = URL.createObjectURL(file);
  try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { URL.revokeObjectURL(url); }
}
function scaleTo(src, max, quality) {
  const w = src.width, h = src.height, k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; // 透明 PNG 轉 JPEG 時墊白底
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', quality));
}
async function prepImage(file) {
  const src = await decodeImage(file);
  try {
    const blob = await scaleTo(src, IMG_MAX, 0.82);
    const thumb = await scaleTo(src, THUMB_MAX, 0.72);
    const k = Math.min(1, IMG_MAX / Math.max(src.width, src.height));
    return { id: uid(), blob, thumb, w: Math.round(src.width * k), h: Math.round(src.height * k), url: URL.createObjectURL(thumb) };
  } finally { if (src.close) src.close(); }
}

function renderXImgs() {
  const box = $('#xImgs');
  box.innerHTML = xImgs.map((im, i) => `<div class="ximg">
      <button type="button" class="ximg-open" data-ximg-view="${i}" aria-label="${esc(t('img.open'))}"><img ${im.url ? `src="${im.url}"` : `data-thumb="${im.id}"`} alt=""></button>
      <button type="button" class="ximg-del" data-ximg-del="${i}" aria-label="${esc(t('exp.imgRemove'))}"><svg class="ico" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>`).join('');
  box.hidden = !xImgs.length;
  hydrateThumbs(box);
  $('#xAddImg').hidden = xImgs.length >= IMG_LIMIT;
}
$('#xAddImg').onclick = () => $('#xImgInput').click();
$('#xImgInput').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const room = IMG_LIMIT - xImgs.length;
  if (files.length > room) toast(t('exp.imgMax', { n: IMG_LIMIT }), 3000);
  const btn = $('#xAddImg');
  xImgBusy = true;
  btn.disabled = true;
  $('#expSaveBtn').disabled = true;
  let failed = 0;
  for (const file of files.slice(0, Math.max(0, room))) {
    btn.lastElementChild.textContent = t('exp.imgProcessing');
    try { xImgs.push(await prepImage(file)); renderXImgs(); }
    catch (err) { console.error(err); failed++; }
  }
  xImgBusy = false;
  btn.disabled = false;
  $('#expSaveBtn').disabled = false;
  btn.lastElementChild.textContent = t('exp.addImage');
  if (failed) toast(t('exp.imgFail', { n: failed }), 3500);
};
$('#xImgs').addEventListener('click', (e) => {
  const del = e.target.closest('[data-ximg-del]');
  if (del) {
    const [im] = xImgs.splice(+del.dataset.ximgDel, 1);
    if (im && im.blob && im.url) URL.revokeObjectURL(im.url);
    renderXImgs();
    return;
  }
  const v = e.target.closest('[data-ximg-view]');
  if (v) openImgViewer(xImgs.map((im) => (im.blob ? { blob: im.blob } : { id: im.id })), +v.dataset.ximgView);
});

/* ---------- 全屏看圖：左右滑動切換，雙擊放大 ---------- */
const IV = { items: [], i: 0, url: null, token: 0 };
function openImgViewer(items, index) {
  IV.items = items;
  openOverlay($('#imgViewer'), () => { if (IV.url) URL.revokeObjectURL(IV.url); IV.url = null; $('#ivImg').removeAttribute('src'); });
  showImg(index);
}
async function showImg(i) {
  const n = IV.items.length;
  if (!n) return;
  IV.i = (i + n) % n;
  const token = ++IV.token;
  $('#ivBody').classList.remove('zoomed');
  $('#ivCount').textContent = n > 1 ? `${IV.i + 1} / ${n}` : '';
  $('#ivPrev').hidden = $('#ivNext').hidden = n < 2;
  const it = IV.items[IV.i];
  const blob = it.blob || (await store.img(it.id))?.blob;
  if (token !== IV.token || !blob) return;
  if (IV.url) URL.revokeObjectURL(IV.url);
  IV.url = URL.createObjectURL(blob);
  $('#ivImg').src = IV.url;
}
$('#ivPrev').onclick = () => showImg(IV.i - 1);
$('#ivNext').onclick = () => showImg(IV.i + 1);
$('#ivBody').addEventListener('dblclick', (e) => {
  const body = $('#ivBody');
  const zoomed = body.classList.toggle('zoomed');
  if (zoomed) {
    // 以點擊位置為中心放大
    const r = body.getBoundingClientRect();
    requestAnimationFrame(() => {
      body.scrollLeft = (e.clientX - r.left) / r.width * body.scrollWidth - r.width / 2;
      body.scrollTop = (e.clientY - r.top) / r.height * body.scrollHeight - r.height / 2;
    });
  }
});
let ivTouch = null;
$('#ivBody').addEventListener('touchstart', (e) => { ivTouch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
$('#ivBody').addEventListener('touchend', (e) => {
  if (!ivTouch || $('#ivBody').classList.contains('zoomed')) return;
  const dx = e.changedTouches[0].clientX - ivTouch.x, dy = e.changedTouches[0].clientY - ivTouch.y;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 80) showImg(IV.i + (dx < 0 ? 1 : -1));
  ivTouch = null;
});
document.addEventListener('keydown', (e) => {
  if ($('#imgViewer').hidden) return;
  if (e.key === 'ArrowLeft') showImg(IV.i - 1);
  else if (e.key === 'ArrowRight') showImg(IV.i + 1);
});

/* =========================================================
 * 全局事件
 * ========================================================= */
document.addEventListener('click', (e) => {
  const t = e.target;
  const star = t.closest('[data-star]');
  if (star) { e.stopPropagation(); toggleFav(star.dataset.star); return; }
  const ed = t.closest('[data-edit]');
  if (ed) { e.stopPropagation(); openEditor(byId.get(ed.dataset.edit)); return; }
  const ex = t.closest('[data-exps]');
  if (ex) { e.stopPropagation(); openExps(ex.dataset.exps, { q: ex.dataset.expsQ || '', focus: ex.dataset.expFocus || null }); return; }
  const iv = t.closest('[data-img-view]');
  if (iv) {
    const x = exps.find((e2) => e2.id === iv.dataset.imgView);
    if (x) openImgViewer(x.images.map((id) => ({ id })), +iv.dataset.imgIdx);
    return;
  }
  const xe = t.closest('[data-exp-edit]');
  if (xe) { openExpEditor(exps.find((x) => x.id === xe.dataset.expEdit)); return; }
  const xa = t.closest('[data-exp-add]');
  if (xa) { openExpEditor(null, xa.dataset.expAdd); return; }
  const op = t.closest('[data-open]');
  if (op) { openManual(op.dataset.open); return; }
  const add = t.closest('[data-add-model]');
  if (add) { openEditor(null, { models: add.dataset.addModel }); return; }
  const go = t.closest('[data-goto]');
  if (go) { showView(go.dataset.goto); return; }
  if (t.closest('[data-share]')) { shareFile(); return; }
  if (t.closest('[data-close]')) { closeOverlay(); return; }
  const tab = t.closest('.tab');
  if (tab) showView(tab.dataset.view);
});
// 點遮罩空白處關閉表單
$('#editSheet').addEventListener('click', (e) => { if (e.target.id === 'editSheet') closeOverlay(); });

$('#q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearch, 80); });
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const first = $('#results .card');
    // 只有唯一精確結果時，回車直接打開
    if (first && first.classList.contains('best') && $('#results').querySelectorAll('.best').length === 1) openManual(first.dataset.open);
    else $('#q').blur();
  }
});
$('#clearQ').onclick = () => { $('#q').value = ''; renderSearch(); $('#q').focus(); };
$('#addBtn').onclick = () => openEditor(null);
['fltBrand', 'fltDept', 'fltSort'].forEach((id) => { $('#' + id).onchange = renderLibrary; });

/* =========================================================
 * 啟動
 * ========================================================= */
/* ---------- 語言 ---------- */
function applyLanguage() {
  collator = new Intl.Collator(LANG);
  applyI18n();
  // 標題同時顯示英文，方便誤選了看不懂的語言時找回來
  $('#langHeading').textContent = t('set.language') + (LANG === 'en' ? '' : ' · Language');
  $('#langSelect').value = LANG;
  $('#pageTitle').textContent = t(titleKeys[currentView]);
}
const langSelect = $('#langSelect');
langSelect.innerHTML = LANGS.map(([code, name]) => `<option value="${code}">${esc(name)}</option>`).join('');
langSelect.onchange = () => {
  setLang(langSelect.value, true);
  applyLanguage();
  refresh();
};

async function init() {
  applyLanguage();
  if (NATIVE) {
    $('#scanBtn').hidden = false;
    $('#scanBtn').onclick = async () => {
      const v = (await nativeWait((cb) => NATIVE.scan(t('scan.tip'), cb))).trim();
      if (!v) return;
      $('#q').value = v;
      renderSearch();
    };
  } else if ('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) {
    $('#scanBtn').hidden = false;
    $('#scanBtn').onclick = startScan;
  }
  try {
    const [list, r, f, xs] = await Promise.all([store.allMeta(), store.get('recent'), store.get('favs'), store.allExps()]);
    setManuals(list.map(withNorm));
    setExps(xs);
    recent = r || [];
    favs = new Set(f || []);
  } catch (err) {
    console.error(err);
    toast(t('db.err', { e: err.message || err }), 5000);
  }
  refresh();
  // APK 的文件本來就在安裝包裡，不需要離線緩存
  if (!NATIVE && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
}
init();
