// 열달노트 — 임신 주차·몸무게·일정·기록 관리 (개인용 PWA, 부부 공유)
// 출처: [Claude] 설계·작성 / [사용자] 요구사항(2026-11-17 대화). 화면 뼈대는 같은 날 만든 '우리집노트' app.js를 재사용.
// 기록은 이 기기의 IndexedDB에 저장한다. '부부 공유'를 켠 경우에만 사용자가 만든 Firebase 실시간 데이터베이스로 기록을 보낸다.
// 주별 안내·검사 시기 내용과 그 출처는 data.js 참고.
'use strict';
const APP_VERSION = '1.0.0';
const DB_NAME = 'yeoldal-note';
const STORES = ['profile', 'weights', 'events', 'diary', 'kicks', 'contractions', 'checks'];
const DAY = 86400000;

const R = {};                       // 삭제 표시(tombstone)까지 포함한 원본 — 백업·공유용
const S = { meta: {} };             // 화면용 (삭제된 것 제외)
STORES.forEach(s => { R[s] = []; S[s] = []; });
const UI = { week: null, rec: 'weight', cat: Object.keys(CHECKLIST)[0], q: '', past: false };
let db, installEvt = null;
const $ = s => document.querySelector(s);
const view = $('#view'), sheet = $('#sheet'), sheetBg = $('#sheet-bg');

/* ---------- 공통 ---------- */
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(2, '0');
const pct = (a, b) => b > 0 ? Math.max(0, Math.min(100, Math.round(a / b * 100))) : 0;
const iso = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dnum = s => { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY); };
const fromNum = n => new Date(n * DAY).toISOString().slice(0, 10);
const fmtD = s => { if (!s) return ''; const [, m, d] = s.split('-').map(Number); return `${m}/${d}(${'일월화수목금토'[new Date(dnum(s) * DAY).getUTCDay()]})`; };
const hm = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
const kg1 = n => (Math.round(n * 10) / 10).toFixed(1);
function dday(s) { if (!s) return ''; const d = dnum(s) - dnum(iso()); return d === 0 ? 'D-DAY' : d > 0 ? 'D-' + d : 'D+' + (-d); }
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const cho = s => [...s].map(c => { const k = c.charCodeAt(0) - 0xAC00; return k >= 0 && k < 11172 ? CHO[Math.floor(k / 588)] : c; }).join('');
function match(text, q) {
  text = text.toLowerCase(); const ct = cho(text);
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => text.includes(w) || (/^[ㄱ-ㅎ]+$/.test(w) && ct.includes(w)));
}
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2400); }

/* ---------- 임신 주수 계산 (예정일 − 280일 = 0주 0일) ---------- */
const prof = () => S.profile[0] || {};
const lmpNum = () => dnum(prof().dueDate) - 280;
function ga(ds = iso()) {
  if (!prof().dueDate) return null;
  const days = dnum(ds) - lmpNum();
  return { days, w: Math.floor(days / 7), d: ((days % 7) + 7) % 7, left: 280 - days };
}
const gaLabel = ds => { const g = ga(ds); return g && g.days >= 0 && g.days < 301 ? `${g.w}주 ${g.d}일` : ''; };
const curWeek = () => { const g = ga(); return g ? Math.max(4, Math.min(40, g.w)) : 4; };
const weekData = w => { const r = WEEKS.find(x => x[0] === w); return r && { w: r[0], size: r[1], len: r[2], wt: r[3], baby: r[4], mom: r[5], todo: r[6] }; };
const trimester = w => w < 14 ? '임신 초기' : w < 28 ? '임신 중기' : '임신 후기';
function gainInfo() {
  const p = prof(); if (!(p.height > 0 && p.preWeight > 0)) return null;
  const bmi = p.preWeight / (p.height / 100) ** 2, g = GAIN.find(x => bmi < x[0]);
  return { bmi, lo: g[1], hi: g[2], label: g[3] };
}
// 주차별 참고 범위: 13주까지 0.5~2kg, 이후 40주의 권장 총 증가량까지 직선으로 이음 ([Claude] 단순화)
function band(w, gi) { const f = (a, b) => w <= 13 ? a * w / 13 : a + (b - a) * (Math.min(w, 40) - 13) / 27; return [f(0.5, gi.lo), f(2, gi.hi)]; }

/* ---------- 저장소 ---------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { const d = r.result; STORES.forEach(s => d.createObjectStore(s, { keyPath: 'id' })); d.createObjectStore('meta', { keyPath: 'key' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function tx(stores, fn) {
  return new Promise((res, rej) => { const t = db.transaction(stores, 'readwrite'); fn(t); t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });
}
function getAll(s) { return new Promise((res, rej) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function loadAll() {
  for (const s of STORES) {
    R[s] = await getAll(s);
    S[s] = R[s].filter(r => !r.deleted).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  S.meta = {}; (await getAll('meta')).forEach(m => S.meta[m.key] = m.value);
}
async function put(store, obj) {
  if (!obj.id) obj.id = uid();
  if (obj.order == null) obj.order = Date.now();
  obj.updatedAt = Date.now();
  await tx([store], t => t.objectStore(store).put(obj)); await loadAll();
  syncPush(store, obj);
  return obj;
}
// 삭제는 '삭제 표시'를 남긴다 — 상대 폰에도 삭제가 전달되도록
const del = (store, id) => put(store, { id, deleted: true });
async function setMeta(key, value) { await tx(['meta'], t => t.objectStore('meta').put({ key, value })); S.meta[key] = value; }
const hasData = () => STORES.some(s => S[s].length);

/* ---------- 백업 / 복원 ---------- */
function ymd(d = new Date()) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
function backupObj() { return { app: 'yeoldal-note', version: 1, exportedAt: Date.now(), data: Object.fromEntries(STORES.map(s => [s, R[s]])) }; }
function backupFile() { return new File([JSON.stringify(backupObj(), null, 1)], `열달노트_백업_${ymd()}.json`, { type: 'application/json' }); }
async function exportBackup() {
  const f = backupFile(), a = document.createElement('a');
  a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  await setMeta('lastBackup', Date.now()); toast('백업 파일을 저장했어요'); render();
}
async function shareBackup() {
  const f = backupFile();
  if (!(navigator.canShare && navigator.canShare({ files: [f] }))) return toast('이 브라우저는 파일 공유를 지원하지 않아요. 내보내기를 쓰세요');
  try { await navigator.share({ files: [f], title: '열달노트 백업' }); await setMeta('lastBackup', Date.now()); render(); } catch (e) { /* 취소 */ }
}
function validate(o) {
  if (!o || o.app !== 'yeoldal-note' || typeof o.data !== 'object' || !o.data) throw new Error('열달노트 백업 파일이 아니에요');
  for (const s of STORES) {
    const a = o.data[s] ?? [];
    if (!Array.isArray(a) || a.some(r => !r || typeof r.id !== 'string' || !r.id)) throw new Error(`백업 파일 형식 오류 (${s})`);
  }
}
async function importData(o, mode) {
  validate(o);
  let n = 0;
  await tx(STORES, t => {
    for (const s of STORES) {
      const st = t.objectStore(s);
      if (mode === 'replace') st.clear();
      const cur = new Map(R[s].map(r => [r.id, r]));
      for (const r of o.data[s] ?? []) {
        const old = mode === 'merge' ? cur.get(r.id) : null;
        if (!old || (r.updatedAt || 0) > (old.updatedAt || 0)) { st.put(r); n++; }
      }
    }
  });
  await loadAll();
  if (syncCfg()) syncStart();
  return n;
}
async function clearAll() { await tx(STORES, t => STORES.forEach(s => t.objectStore(s).clear())); await loadAll(); }
function pickFile() { const f = $('#file'); f.value = ''; f.click(); }
$('#file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  let o;
  try { o = JSON.parse(await f.text()); validate(o); } catch (err) { return toast(err.message.includes('JSON') ? 'JSON 파일을 읽을 수 없어요' : err.message); }
  let mode = 'replace';
  if (hasData()) {
    mode = await choose('백업 파일을 어떻게 불러올까요?\n· 합치기: 같은 항목은 더 최근에 수정한 쪽을 남김\n· 전체 바꾸기: 지금 기록을 지우고 파일 내용으로 교체',
      [{ label: '합치기', value: 'merge', cls: 'pri' }, { label: '전체 바꾸기', value: 'replace', cls: 'danger' }, { label: '취소', value: '' }]);
    if (!mode) return;
  }
  const n = await importData(o, mode);
  toast(`${n}개 항목을 불러왔어요`); render();
});

/* ---------- 부부 공유 (Firebase 실시간 데이터베이스 REST) ----------
   주소: <DB주소>/rooms/<공유코드>/<저장소>/<id>.json  — 기록 하나가 문서 하나.
   받기: EventSource(실시간 스트림). 보내기: PUT. 충돌은 updatedAt이 더 최근인 쪽을 남긴다. */
let es = null, syncState = 'off', syncRetry = null, renderT = null;
const syncCfg = () => S.meta.sync;
const syncBase = () => syncCfg().url.replace(/\/+$/, '') + '/rooms/' + syncCfg().code;
const SYNC_TXT = { off: '꺼짐', connecting: '연결 중…', on: '연결됨 — 실시간 공유 중', error: '연결 실패 — 주소·규칙·인터넷을 확인하세요' };
function setSync(st) {
  syncState = st;
  document.querySelectorAll('[data-sync]').forEach(el => { el.innerHTML = `<i class="dot ${st}"></i>${SYNC_TXT[st]}`; });
}
function syncStop() { clearTimeout(syncRetry); if (es) { es.close(); es = null; } }
function syncLater(ms) { clearTimeout(syncRetry); syncRetry = setTimeout(syncStart, ms); }
function syncStart() {
  syncStop();
  if (!syncCfg()) return setSync('off');
  setSync('connecting');
  es = new EventSource(syncBase() + '.json');
  es.onopen = () => setSync('on');
  es.addEventListener('put', e => onRemote(JSON.parse(e.data), true));
  es.addEventListener('patch', e => onRemote(JSON.parse(e.data), false));
  es.addEventListener('cancel', () => { setSync('error'); syncStop(); });
  es.addEventListener('auth_revoked', () => { setSync('error'); syncStop(); });
  es.onerror = () => { if (!es) return; if (es.readyState === 2) { setSync('error'); syncLater(30000); } else setSync('connecting'); };
}
async function syncPush(store, rec) {
  if (!syncCfg()) return;
  try {
    const r = await fetch(`${syncBase()}/${store}/${rec.id}.json`, { method: 'PUT', body: JSON.stringify(rec) });
    if (!r.ok) throw new Error(r.status);
  } catch (e) { syncLater(15000); }   // 다시 연결되면 전체를 비교해서 빠진 것을 보낸다
}
async function onRemote(m, isPut) {
  const parts = String(m.path || '/').split('/').filter(Boolean), d = m.data, recs = [];
  if (parts.length === 0) { for (const s of STORES) for (const r of Object.values(d?.[s] || {})) recs.push([s, r]); }
  else if (parts.length === 1) { for (const r of Object.values(d || {})) recs.push([parts[0], r]); }
  else if (parts.length === 2) recs.push([parts[0], d]);
  const fresh = recs.filter(([s, r]) => {
    if (!STORES.includes(s) || !r || typeof r.id !== 'string') return false;
    const old = R[s].find(x => x.id === r.id);
    return !old || (r.updatedAt || 0) > (old.updatedAt || 0);
  });
  if (fresh.length) {
    await tx(STORES, t => fresh.forEach(([s, r]) => t.objectStore(s).put(r)));
    await loadAll();
    clearTimeout(renderT); renderT = setTimeout(render, 120);
  }
  if (parts.length === 0 && isPut) {   // 처음 연결·재연결: 이 폰에만 있거나 더 최근인 기록을 올린다
    for (const s of STORES) for (const r of R[s]) {
      const rem = d?.[s]?.[r.id];
      if (!rem || (rem.updatedAt || 0) < (r.updatedAt || 0)) syncPush(s, r);
    }
  }
}
const newCode = () => [...crypto.getRandomValues(new Uint8Array(24))].map(b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
const syncKey = () => 'yd1.' + btoa(JSON.stringify({ u: syncCfg().url, c: syncCfg().code }));
function parseKey(k) {
  try { const o = JSON.parse(atob(String(k).trim().replace(/^yd1\./, ''))); if (okUrl(o.u) && /^[a-z0-9]{16,}$/.test(o.c)) return { url: o.u, code: o.c }; } catch (e) { /* 형식 오류 */ }
  return null;
}
const okUrl = u => /^https:\/\/[^\s/]+\.[^\s/]+/.test(u || '') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(u || '');
async function syncConnect(cfg) {
  try { const r = await fetch(`${cfg.url.replace(/\/+$/, '')}/rooms/${cfg.code}/profile.json`); if (!r.ok) throw new Error(r.status); }
  catch (e) { toast('연결하지 못했어요. 주소와 보안 규칙을 확인하세요'); return false; }
  await setMeta('sync', cfg); syncStart(); return true;
}
const RULES = '{\n  "rules": {\n    "rooms": {\n      "$code": {\n        ".read": "$code.length >= 16",\n        ".write": "$code.length >= 16"\n      }\n    }\n  }\n}';

/* ---------- 하단 시트 ---------- */
let sheetOnClose = null, afterPop = null;
function showSheet(html) {
  sheet.innerHTML = html; sheet.onclick = null; sheet.scrollTop = 0;
  if (sheet.hidden) { sheet.hidden = false; sheetBg.hidden = false; history.pushState({ sheet: 1 }, ''); }
}
function hideSheet() {
  sheet.hidden = true; sheetBg.hidden = true;
  const cb = sheetOnClose; sheetOnClose = null; if (cb) cb('');
}
function closeSheet() {
  return new Promise(res => {
    if (sheet.hidden) return res();
    if (history.state && history.state.sheet) { afterPop = res; history.back(); } else { hideSheet(); res(); }
  });
}
window.addEventListener('popstate', () => { hideSheet(); if (afterPop) { const f = afterPop; afterPop = null; f(); } });
sheetBg.addEventListener('click', () => closeSheet());
function choose(msg, opts, extra = '') {
  return new Promise(res => {
    showSheet(`<p>${h(msg)}</p>${extra}` + opts.map(o => `<button class="btn ${o.cls || ''}" data-v="${h(o.value)}">${h(o.label)}</button>`).join(''));
    sheetOnClose = res;
    sheet.onclick = async e => {
      const b = e.target.closest('[data-v]'); if (!b) return;
      sheetOnClose = null; const v = b.dataset.v; await closeSheet(); res(v);
    };
  });
}
const ask = async (msg, ok = '확인', cls = 'pri') => (await choose(msg, [{ label: ok, value: 'y', cls }, { label: '취소', value: '' }])) === 'y';

function openForm({ title, intro, fields, value, onSave, onDelete, check }) {
  const v = value || {};
  let html = `<h3>${h(title)}</h3>` + (intro ? `<p class="sub">${h(intro)}</p>` : '');
  for (const f of fields) {
    const val = v[f.key] ?? '', hint = f.hint ? `<div class="hint">${h(f.hint)}</div>` : '';
    if (f.type === 'check') html += `<label class="f ck"><input type="checkbox" data-k="${f.key}" ${val ? 'checked' : ''}><span>${h(f.label)}</span></label>`;
    else if (f.type === 'select') html += `<label class="f"><span>${h(f.label)}</span><select data-k="${f.key}">${f.options.map(o => `<option ${o === val ? 'selected' : ''}>${h(o)}</option>`).join('')}</select></label>`;
    else if (f.type === 'textarea') html += `<label class="f"><span>${h(f.label)}</span><textarea data-k="${f.key}" placeholder="${h(f.ph || '')}">${h(val)}</textarea>${hint}</label>`;
    else if (f.type === 'pick' || f.type === 'pick1') html += `<div class="f"><span>${h(f.label)}</span><div class="pick" data-k="${f.key}" data-one="${f.type === 'pick1' ? 1 : ''}">${f.options.map(o =>
      `<button type="button" data-p="${h(o)}" class="${(Array.isArray(val) ? val.includes(o) : val === o) ? 'on' : ''}">${h(o)}</button>`).join('')}</div></div>`;
    else if (f.type === 'number') html += `<label class="f"><span>${h(f.label)}</span><input type="number" inputmode="decimal" step="0.1" data-k="${f.key}" value="${h(val)}" placeholder="${h(f.ph || '')}">${hint}</label>`;
    else html += `<label class="f"><span>${h(f.label)}</span><input type="${f.type || 'text'}" data-k="${f.key}" value="${h(val)}" placeholder="${h(f.ph || '')}">${hint}</label>`;
  }
  html += `<div class="acts">${onDelete ? '<button class="btn danger" data-a="del">삭제</button>' : ''}<button class="btn" data-a="cancel">취소</button><button class="btn pri" data-a="save">저장</button></div>`;
  showSheet(html);
  sheet.onclick = async e => {
    const p = e.target.closest('[data-p]');
    if (p) { if (p.parentElement.dataset.one) p.parentElement.querySelectorAll('.on').forEach(x => x !== p && x.classList.remove('on')); p.classList.toggle('on'); return; }
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'cancel') return closeSheet();
    if (a === 'del') { if (await ask('이 기록을 삭제할까요?', '삭제', 'danger')) { await onDelete(); render(); toast('삭제했어요'); } return; }
    const out = { ...v };
    for (const f of fields) {
      const el = sheet.querySelector(`[data-k="${f.key}"]`);
      if (f.type === 'check') out[f.key] = el.checked;
      else if (f.type === 'pick') out[f.key] = [...el.querySelectorAll('.on')].map(x => x.dataset.p);
      else if (f.type === 'pick1') out[f.key] = el.querySelector('.on')?.dataset.p || '';
      else if (f.type === 'number') out[f.key] = el.value === '' ? null : Number(el.value);
      else out[f.key] = el.value.trim();
    }
    const err = check && check(out); if (err) return toast(err);
    await onSave(out); await closeSheet(); render();
  };
}

/* ---------- 편집기 ---------- */
function editProfile() {
  const p = prof();
  openForm({
    title: '기본 정보', value: p,
    fields: [{ key: 'dueDate', label: '출산 예정일', type: 'date' },
      { key: 'lmp', label: '마지막 생리 시작일 (예정일을 모를 때만)', type: 'date', hint: '예정일이 비어 있으면 이 날짜 + 280일로 계산해요' },
      { key: 'babyName', label: '태명', ph: '예: 튼튼이' }, { key: 'height', label: '키 (cm)', type: 'number', ph: '예: 162' },
      { key: 'preWeight', label: '임신 전 몸무게 (kg)', type: 'number', ph: '예: 55.0', hint: '키와 임신 전 몸무게를 넣으면 권장 체중 증가 범위를 보여줘요' }],
    check: o => { if (!o.dueDate && o.lmp) o.dueDate = fromNum(dnum(o.lmp) + 280); return o.dueDate ? '' : '출산 예정일을 입력하세요'; },
    onSave: async o => { await put('profile', { ...o, id: 'main' }); if (route() !== 'set') location.hash = '#/home'; },
  });
}
function editWeight(r) {
  openForm({
    title: r ? '몸무게 수정' : '몸무게 기록', value: r || { date: iso() },
    fields: [{ key: 'date', label: '날짜', type: 'date' }, { key: 'kg', label: '몸무게 (kg)', type: 'number', ph: '예: 57.3' }, { key: 'note', label: '메모' }],
    check: o => !o.date ? '날짜를 입력하세요' : !(o.kg > 20 && o.kg < 250) ? '몸무게를 확인하세요' : '',
    onSave: o => put('weights', o), onDelete: r && (() => del('weights', r.id)),
  });
}
function editEvent(r, init) {
  openForm({
    title: r ? '일정 수정' : '일정 추가', value: r || { date: iso(), type: '검진', done: false, ...init },
    fields: [{ key: 'title', label: '제목', ph: '예: 정기 검진' }, { key: 'date', label: '날짜', type: 'date' }, { key: 'time', label: '시간', type: 'time' },
      { key: 'type', label: '종류', type: 'select', options: EVTYPES }, { key: 'place', label: '장소', ph: '예: ○○산부인과' },
      { key: 'memo', label: '메모 (물어볼 것, 들은 내용)', type: 'textarea' }, { key: 'done', label: '다녀왔어요', type: 'check' }],
    check: o => !o.title ? '제목을 입력하세요' : !o.date ? '날짜를 입력하세요' : '',
    onSave: o => put('events', o), onDelete: r && (() => del('events', r.id)),
  });
}
function editDiary(r) {
  openForm({
    title: r ? '일기 수정' : '오늘의 기록', value: r || { date: iso(), mood: '', symptoms: [] },
    fields: [{ key: 'date', label: '날짜', type: 'date' }, { key: 'mood', label: '컨디션', type: 'pick1', options: MOODS },
      { key: 'symptoms', label: '증상', type: 'pick', options: SYMPTOMS }, { key: 'memo', label: '메모', type: 'textarea', ph: '오늘 있었던 일, 병원에서 들은 말…' }],
    check: o => !o.date ? '날짜를 입력하세요' : !(o.mood || o.symptoms.length || o.memo) ? '내용을 입력하세요' : '',
    onSave: o => put('diary', o), onDelete: r && (() => del('diary', r.id)),
  });
}
function editCheck(r) {
  const cats = [...Object.keys(CHECKLIST), '내 항목'];
  openForm({
    title: r ? '항목 수정' : '항목 추가', value: r || { cat: UI.cat, custom: true, done: false },
    fields: [{ key: 'title', label: '할 일·준비물', ph: '예: 유축기 대여' }, { key: 'cat', label: '분류', type: 'select', options: cats }],
    check: o => o.title ? '' : '내용을 입력하세요',
    onSave: o => put('checks', o), onDelete: r && (() => del('checks', r.id)),
  });
}
const EDIT = { weights: editWeight, events: editEvent, diary: editDiary, checks: editCheck };
const ck = id => S.checks.find(c => c.id === id);
const toggleCheck = id => put('checks', { ...(ck(id) || { id }), done: !ck(id)?.done });

/* ---------- 화면 공통 ---------- */
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
function installBanner() {
  if (standalone()) return '';
  return `<div class="banner"><b>홈 화면에 설치</b>하면 앱처럼 쓸 수 있어요. ` + (installEvt
    ? `<button class="btn sm pri" data-act="install" style="margin-top:8px">설치</button>`
    : `메뉴(⋮) → 'Chrome에서 열기' → '홈 화면에 추가' → '설치'`) + `</div>`;
}
const chkBtn = (on, act, id) => `<button class="chk ${on ? 'on' : ''}" data-act="${act}" data-id="${h(id)}" aria-label="완료 표시">✓</button>`;
function todoRows(w) {
  return weekData(w).todo.map((t, i) => { const id = `w${w}_${i}`, on = ck(id)?.done;
    return `<div class="row ${on ? 'done' : ''}" data-act="check" data-id="${id}">${chkBtn(on, 'check', id)}<div class="mid"><div class="nm">${h(t)}</div></div></div>`; }).join('');
}
function examState(x) {
  const g = ga(); if (!g || x.from == null) return { st: '', range: '' };
  const range = `${fmtD(fromNum(lmpNum() + x.from))} ~ ${fmtD(fromNum(lmpNum() + x.to))}`;
  return { st: g.days < x.from ? 'soon' : g.days <= x.to ? 'now' : 'past', range, start: fromNum(lmpNum() + x.from) };
}
const ST_TXT = { soon: '예정', now: '지금 시기', past: '지남' };
function evRow(e) {
  return `<div class="row ${e.done ? 'done' : ''}" data-act="edit" data-store="events" data-id="${h(e.id)}">${chkBtn(e.done, 'ev-toggle', e.id)}
    <div class="mid"><div class="nm">${h(e.title)}</div><div class="sub"><span class="tag">${h(e.type || '기타')}</span>${fmtD(e.date)} ${h(e.time || '')}${gaLabel(e.date) ? ' · ' + gaLabel(e.date) : ''}${e.place ? ' · ' + h(e.place) : ''}</div></div>
    <div class="amt">${e.done ? '' : dday(e.date)}</div></div>`;
}
const sortEv = (a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''));

/* ---------- 홈 ---------- */
function vHome() {
  const p = prof();
  if (!p.dueDate) return `<div class="card hero"><h2>열달노트에 오신 걸 환영해요 🤍</h2>
    <p class="sub">출산 예정일만 넣으면 지금 몇 주인지, 이번 주에 뭘 하면 되는지, 검사 시기가 언제인지 알려줘요. 몸무게·일정·일기·태동·진통도 기록할 수 있어요.</p>
    <button class="btn pri" data-act="profile">출산 예정일 입력하고 시작</button><button class="btn" data-act="import">백업 파일 불러오기</button>
    <button class="btn" data-act="sync-join">배우자 폰의 공유 키로 연결</button></div>` + installBanner();
  const g = ga(), w = curWeek(), W = weekData(w), today = iso();
  let o = installBanner();
  const base = S.meta.lastBackup || S.meta.firstUse || Date.now();
  if (!syncCfg() && Date.now() - base > 14 * DAY) o += `<div class="banner"><b>백업한 지 2주가 넘었어요.</b> 폰을 바꾸거나 브라우저 데이터를 지우면 사라지니 백업해 두세요.<button class="btn sm pri" data-act="export" style="margin-top:8px">지금 백업</button></div>`;
  const dtxt = g.left > 0 ? 'D-' + g.left : g.left === 0 ? 'D-DAY' : 'D+' + (-g.left);
  o += `<div class="card hero"><div class="sub">${p.babyName ? h(p.babyName) + ' · ' : ''}${g.days < 0 ? '임신 전' : trimester(g.w)}</div>
    <div class="big">${g.days < 0 ? '아직 0주 전이에요' : `임신 ${g.w}주 ${g.d}일`}</div>
    <div class="bar"><i style="width:${pct(g.days, 280)}%"></i></div>
    <div class="kv"><span>출산 예정일 ${fmtD(p.dueDate)} <span class="sub">${h(p.dueDate.slice(0, 4))}</span></span><b class="acc">${dtxt}</b></div>
    <div class="sub">지금 아기는 <b>${h(W.size)}</b> 정도 크기${W.len ? ` · 약 ${W.len}cm, ${W.wt >= 1000 ? kg1(W.wt / 1000) + 'kg' : W.wt + 'g'}` : ''} <span class="sub">(참고용 대략값)</span></div></div>`;
  o += `<div class="card"><h2>${w}주차 안내 <a class="add" href="#/week">자세히 ›</a></h2><div class="lbl">아기</div><div>${h(W.baby)}</div><div class="lbl">엄마</div><div>${h(W.mom)}</div>
    <div class="lbl">이번 주 할 일</div>${todoRows(w)}</div>`;
  const next = S.events.filter(e => !e.done && e.date >= today).sort(sortEv).slice(0, 3);
  const nowEx = EXAMS.filter(x => examState(x).st === 'now' && !ck(x.id)?.done);
  o += `<div class="card"><h2>다가오는 일정 <button class="add" data-act="ev-add">＋ 추가</button></h2>${next.map(evRow).join('') || '<div class="empty">등록된 일정이 없어요</div>'}
    ${nowEx.map(x => `<div class="row" data-act="go-cal"><div class="mid"><div class="nm">${h(x.name)}</div><div class="sub"><span class="tag now">지금 시기</span>${examState(x).range}</div></div></div>`).join('')}</div>`;
  const ws = [...S.weights].sort((a, b) => a.date.localeCompare(b.date)), last = ws[ws.length - 1], gi = gainInfo();
  o += `<div class="card"><h2>몸무게 <button class="add" data-act="w-add">＋ 기록</button></h2>` + (last
    ? `<div class="big">${kg1(last.kg)}kg ${p.preWeight > 0 ? `<span class="sub">임신 전보다 ${last.kg - p.preWeight >= 0 ? '+' : ''}${kg1(last.kg - p.preWeight)}kg</span>` : ''}</div><div class="sub">${fmtD(last.date)} 기록</div>`
    : `<div class="empty">아직 기록이 없어요</div>`) + (gi
    ? `<div class="note">임신 전 BMI ${kg1(gi.bmi)}(${gi.label}) → 출산까지 권장 증가 ${gi.lo}~${gi.hi}kg${g.days > 0 ? ` · 지금 주수 참고 범위 +${kg1(band(g.days / 7, gi)[0])}~${kg1(band(g.days / 7, gi)[1])}kg` : ''}</div>`
    : `<div class="note">설정에서 키와 임신 전 몸무게를 넣으면 권장 범위를 보여줘요.</div>`) + `</div>`;
  o += `<div class="card"><h2>빠른 기록</h2><div class="btns"><button class="btn" data-act="d-add">일기·증상</button><button class="btn" data-act="go-kick">태동 세기</button><button class="btn" data-act="go-con">진통 재기</button></div></div>`;
  return o;
}

/* ---------- 주별 ---------- */
function vWeek() {
  const cw = curWeek(), w = UI.week ?? cw, W = weekData(w), has = !!prof().dueDate;
  const exams = EXAMS.filter(x => x.from != null && x.from < (w + 1) * 7 && x.to >= w * 7);
  return `<div class="chips" id="wchips">${WEEKS.map(x => `<button class="chip ${x[0] === w ? 'on' : ''} ${has && x[0] === cw ? 'cur' : ''}" data-act="week" data-id="${x[0]}">${x[0]}주</button>`).join('')}</div>
    <div class="card hero"><div class="sub">${trimester(w)}${has ? ` · ${fmtD(fromNum(lmpNum() + w * 7))} ~ ${fmtD(fromNum(lmpNum() + w * 7 + 6))}` : ''}${has && w === cw ? ' · <b class="acc">이번 주</b>' : ''}</div>
      <div class="big">${w}주차</div><div>아기 크기: <b>${h(W.size)}</b>${W.len ? ` · 약 ${W.len}cm, ${W.wt >= 1000 ? kg1(W.wt / 1000) + 'kg' : W.wt + 'g'}` : ''}</div>
      <div class="note">크기·무게는 참고용 대략값이에요. 실제는 초음파 측정값이 기준이고 개인차가 커요.</div></div>
    <div class="card"><div class="lbl" style="margin-top:0">아기</div><div>${h(W.baby)}</div><div class="lbl">엄마</div><div>${h(W.mom)}</div></div>
    <div class="card"><h2>이번 주 할 일</h2>${todoRows(w)}</div>
    ${exams.length ? `<div class="card"><h2>이 시기 검사·접종</h2>${exams.map(x => `<div class="row" data-act="go-cal"><div class="mid"><div class="nm">${h(x.name)}</div><div class="sub">${h(x.desc)}</div></div></div>`).join('')}<div class="note">${VISIT_RULE}</div></div>` : ''}
    <div class="btns"><button class="btn" data-act="week" data-id="${Math.max(4, w - 1)}">‹ 이전 주</button><button class="btn" data-act="week" data-id="${Math.min(40, w + 1)}">다음 주 ›</button></div>
    <div class="card" style="margin-top:12px"><h2 class="bad">이럴 땐 바로 병원에 연락하세요</h2><ul class="plain">${WARN.map(x => `<li>${h(x)}</li>`).join('')}</ul>
      <div class="note">이 앱의 안내는 일반적인 참고 정보예요. 진료·검사 일정과 판단은 담당 의사 안내가 우선이에요.</div></div>`;
}

/* ---------- 기록: 몸무게 / 일기 / 태동 / 진통 ---------- */
function weightChart() {
  const p = prof(); if (!p.dueDate) return '';
  const gi = gainInfo(), pre = Number(p.preWeight) || 0;
  const pts = S.weights.filter(x => x.date && x.kg > 0).map(x => ({ w: (dnum(x.date) - lmpNum()) / 7, kg: Number(x.kg) })).filter(x => x.w >= 0 && x.w <= 42).sort((a, b) => a.w - b.w);
  if (pre) pts.unshift({ w: 0, kg: pre });
  if (pts.length < 2 && !gi) return '';
  const ys = pts.map(x => x.kg); if (gi) ys.push(pre, pre + gi.hi);
  const lo = Math.floor(Math.min(...ys) - 1), hi = Math.ceil(Math.max(...ys) + 1), step = hi - lo <= 8 ? 2 : hi - lo <= 20 ? 4 : 10;
  const Wd = 320, H = 190, L = 30, Rt = 10, T = 10, B = 24;
  const X = w => L + (Wd - L - Rt) * Math.min(w, 42) / 42, Y = k => T + (H - T - B) * (hi - k) / (hi - lo), f = n => n.toFixed(1);
  let s = `<svg class="chart" viewBox="0 0 ${Wd} ${H}" role="img" aria-label="임신 주수별 몸무게 그래프">`;
  for (let k = Math.ceil(lo / step) * step; k <= hi; k += step) s += `<line x1="${L}" x2="${Wd - Rt}" y1="${f(Y(k))}" y2="${f(Y(k))}" stroke="#383146" stroke-width="1"/><text x="${L - 4}" y="${f(Y(k) + 3)}" text-anchor="end">${k}</text>`;
  for (const w of [0, 10, 20, 30, 40]) s += `<text x="${f(X(w))}" y="${H - 8}" text-anchor="middle">${w}주</text>`;
  if (gi) {
    const ws = Array.from({ length: 41 }, (_, i) => i);
    s += `<polygon fill="#5fd39a" fill-opacity=".18" points="${ws.map(w => f(X(w)) + ',' + f(Y(pre + band(w, gi)[1]))).join(' ')} ${ws.reverse().map(w => f(X(w)) + ',' + f(Y(pre + band(w, gi)[0]))).join(' ')}"/>
      <text x="${f(X(40))}" y="${f(Y(pre + gi.hi) - 4)}" text-anchor="end" style="fill:#5fd39a">권장 범위(참고)</text>`;
  }
  const g = ga(); if (g.days >= 0 && g.days <= 294) s += `<line x1="${f(X(g.days / 7))}" x2="${f(X(g.days / 7))}" y1="${T}" y2="${H - B}" stroke="#a59db5" stroke-dasharray="3 3" stroke-width="1"/>`;
  if (pts.length > 1) s += `<polyline fill="none" stroke="#ff9db0" stroke-width="2" stroke-linejoin="round" points="${pts.map(q => f(X(q.w)) + ',' + f(Y(q.kg))).join(' ')}"/>`;
  s += pts.map(q => `<circle cx="${f(X(q.w))}" cy="${f(Y(q.kg))}" r="3" fill="#ff9db0" stroke="#1f1b27" stroke-width="1.5"/>`).join('');
  return s + `</svg><div class="note">분홍 선: 내 몸무게(kg) · 점선: 오늘${gi ? ' · 초록 띠: 임신 전 BMI 기준 참고 범위' : ''}</div>`;
}
function vWeight() {
  const p = prof(), ws = [...S.weights].sort((a, b) => b.date.localeCompare(a.date));
  return `<div class="card"><h2>몸무게 변화</h2>${weightChart() || '<div class="empty">기록이 2개 이상 쌓이면 그래프가 보여요</div>'}</div>
    <div class="card"><h2>기록 <small>${ws.length}개</small></h2>${ws.map((r, i) => { const prev = ws[i + 1];
      return `<div class="row" data-act="edit" data-store="weights" data-id="${h(r.id)}"><div class="mid"><div class="nm">${fmtD(r.date)} <span class="sub">${gaLabel(r.date)}</span></div>${r.note ? `<div class="sub">${h(r.note)}</div>` : ''}</div>
        <div class="amt">${kg1(r.kg)}kg<small>${prev ? (r.kg - prev.kg >= 0 ? '+' : '') + kg1(r.kg - prev.kg) : p.preWeight > 0 ? '임신 전 ' + (r.kg - p.preWeight >= 0 ? '+' : '') + kg1(r.kg - p.preWeight) : ''}</small></div></div>`; }).join('') || '<div class="empty">오른쪽 위 ＋ 버튼으로 기록하세요</div>'}</div>`;
}
function diaryList() {
  const a = [...S.diary].sort((x, y) => y.date.localeCompare(x.date)).filter(r => !UI.q || match([r.date, r.mood, (r.symptoms || []).join(' '), r.memo].join(' '), UI.q));
  return `<div class="card">${a.map(r => `<div class="row" data-act="edit" data-store="diary" data-id="${h(r.id)}"><div class="mid"><div class="nm">${fmtD(r.date)} <span class="sub">${gaLabel(r.date)}</span></div>
    <div class="sub">${r.mood ? `<span class="tag now">${h(r.mood)}</span>` : ''}${(r.symptoms || []).map(x => `<span class="tag">${h(x)}</span>`).join('')}</div>${r.memo ? `<div style="white-space:pre-line;overflow-wrap:anywhere">${h(r.memo)}</div>` : ''}</div></div>`).join('') || '<div class="empty">기록이 없어요</div>'}</div>`;
}
const vDiary = () => `<input class="search" id="q" type="search" placeholder="검색 (초성 가능: ㅂㅁㅊ)" value="${h(UI.q)}"><div id="dlist">${diaryList()}</div>`;
function vKick() {
  const k = S.meta.kick, ks = [...S.kicks].sort((a, b) => b.start - a.start);
  return `<div class="card"><h2>태동 세기</h2>` + (k
    ? `<div class="kick"><div class="count">${k.count}<span class="sub"> 번</span></div><div class="sub">경과 <b data-el="${k.start}">${mmss(Date.now() - k.start)}</b></div>
       <button class="kickbtn" data-act="kick-tap">움직였어요!</button></div><div class="btns"><button class="btn" data-act="kick-cancel">취소</button><button class="btn pri" data-act="kick-save">끝내고 저장</button></div>`
    : `<p class="sub">편하게 눕거나 앉아서 시작을 누르고, 아기가 움직일 때마다 버튼을 누르세요.</p><button class="btn pri" data-act="kick-start">세기 시작</button>`) +
    `<div class="note">보통 임신 28주 이후에 세고, 2시간 안에 10번 움직이면 잘 지내는 것으로 봐요. 평소보다 눈에 띄게 줄면 병원에 연락하세요. (일반적인 기준 — 병원 안내가 우선)</div></div>
    <div class="card"><h2>기록 <small>${ks.length}개</small></h2>${ks.map(r => `<div class="row" data-act="kick-del" data-id="${h(r.id)}"><div class="mid"><div class="nm">${fmtD(iso(new Date(r.start)))} ${hm(r.start)}</div><div class="sub">${gaLabel(iso(new Date(r.start)))} · ${mmss(r.end - r.start)} 동안</div></div><div class="amt">${r.count}번</div></div>`).join('') || '<div class="empty">기록이 없어요</div>'}</div>`;
}
function vCon() {
  const on = S.meta.con, cs = [...S.contractions].sort((a, b) => b.start - a.start);
  const recent = cs.filter(c => Date.now() - c.start < 2 * 3600000).slice(0, 6);
  let avg = '';
  if (recent.length >= 3) {
    const gaps = recent.slice(0, -1).map((c, i) => c.start - recent[i + 1].start), durs = recent.map(c => c.end - c.start), m = a => a.reduce((x, y) => x + y, 0) / a.length;
    avg = `<div class="kv"><span>최근 ${recent.length}번 평균 간격</span><b>${mmss(m(gaps))}</b></div><div class="kv"><span>평균 지속 시간</span><b>${mmss(m(durs))}</b></div>`;
  }
  return `<div class="card"><h2>진통 재기</h2><div class="kick">${on ? `<div class="count" data-el="${on}">${mmss(Date.now() - on)}</div><div class="sub">진통 중…</div>` : `<div class="sub">배가 아프기 시작하면 누르세요</div>`}
      <button class="kickbtn ${on ? 'stop' : ''}" data-act="con-tap">${on ? '진통 끝' : '진통 시작'}</button></div>${avg}
      <div class="note">간격 = 진통 시작부터 다음 진통 시작까지. 첫 출산은 보통 진통이 5분 간격으로 규칙적일 때, 양수가 새거나 출혈이 있으면 간격과 상관없이 바로 병원에 연락하세요. (일반적인 기준 — 병원에서 알려준 기준이 우선)</div></div>
    <div class="card"><h2>기록 <small>${cs.length}개</small>${cs.length ? '<button class="add" data-act="con-clear">모두 지우기</button>' : ''}</h2>${cs.slice(0, 40).map((c, i) => `<div class="row"><div class="mid"><div class="nm">${fmtD(iso(new Date(c.start)))} ${hm(c.start)}</div>
      <div class="sub">지속 ${mmss(c.end - c.start)}${cs[i + 1] && c.start - cs[i + 1].start < 3600000 ? ' · 간격 ' + mmss(c.start - cs[i + 1].start) : ''}</div></div></div>`).join('') || '<div class="empty">기록이 없어요</div>'}</div>`;
}
const RECS = { weight: ['몸무게', vWeight], diary: ['일기·증상', vDiary], kick: ['태동', vKick], con: ['진통', vCon] };
const vRec = () => `<div class="chips">${Object.entries(RECS).map(([k, v]) => `<button class="chip ${UI.rec === k ? 'on' : ''}" data-act="rec" data-id="${k}">${v[0]}</button>`).join('')}</div>` + RECS[UI.rec][1]();

/* ---------- 일정 ---------- */
function vCal() {
  const today = iso(), up = S.events.filter(e => e.date >= today && !e.done).sort(sortEv), past = S.events.filter(e => e.date < today || e.done).sort((a, b) => sortEv(b, a));
  let o = `<div class="card"><h2>다가오는 일정 <small>${up.length}개</small></h2>${up.map(evRow).join('') || '<div class="empty">오른쪽 위 ＋ 버튼으로 검진·검사 일정을 넣으세요</div>'}</div>`;
  o += `<div class="card"><h2>권장 검사·접종 시기</h2>${EXAMS.map(x => { const e = examState(x), on = ck(x.id)?.done;
    return `<div class="row ${on ? 'done' : ''}">${chkBtn(on, 'check', x.id)}<div class="mid"><div class="nm">${h(x.name)}</div>
      <div class="sub">${e.st && !on ? `<span class="tag ${e.st}">${ST_TXT[e.st]}</span>` : ''}${e.range}</div><div class="sub">${h(x.desc)}</div></div>
      ${on ? '' : `<button class="btn sm" data-act="ex-add" data-id="${x.id}">일정 추가</button>`}</div>`; }).join('')}
    <div class="note">${VISIT_RULE}<br>시기는 일반적인 기준이에요. 병원·개인 상황에 따라 달라지니 담당 의사 안내를 따르세요.${prof().dueDate ? '' : '<br>예정일을 입력하면 날짜로 보여줘요.'}</div></div>`;
  if (past.length) o += `<div class="card"><h2>지난 일정 <small>${past.length}개</small><button class="add" data-act="past">${UI.past ? '접기' : '펼치기'}</button></h2>${UI.past ? past.map(evRow).join('') : ''}</div>`;
  return o;
}

/* ---------- 체크리스트 ---------- */
function checkItems(cat) {
  const base = (CHECKLIST[cat] || []).map(([id, title]) => ({ id, title, done: ck(id)?.done }));
  return [...base, ...S.checks.filter(c => c.custom && c.cat === cat)];
}
function vChk() {
  const cats = [...Object.keys(CHECKLIST), '내 항목'], items = checkItems(UI.cat), dn = items.filter(i => i.done).length;
  return `<div class="chips">${cats.map(c => { const a = checkItems(c); return `<button class="chip ${UI.cat === c ? 'on' : ''}" data-act="cat" data-id="${h(c)}">${h(c)} ${a.filter(i => i.done).length}/${a.length}</button>`; }).join('')}</div>
    <div class="card"><h2>${h(UI.cat)} <small>${dn}/${items.length} 완료</small></h2><div class="bar"><i class="g" style="width:${pct(dn, items.length)}%"></i></div>
    ${items.map(i => `<div class="row ${i.done ? 'done' : ''}" data-act="check" data-id="${h(i.id)}">${chkBtn(i.done, 'check', i.id)}<div class="mid"><div class="nm">${h(i.title)}</div></div>
      ${i.custom ? `<button class="add" data-act="edit" data-store="checks" data-id="${h(i.id)}">수정</button>` : ''}</div>`).join('') || '<div class="empty">오른쪽 위 ＋ 버튼으로 항목을 추가하세요</div>'}
    ${UI.cat === '행정·지원' ? '<div class="note">지원 제도 이름·조건은 지역과 시기에 따라 달라요. 보건소·정부24에서 확인하세요.</div>' : ''}</div>`;
}

/* ---------- 설정 ---------- */
function vSet() {
  const p = prof(), lb = S.meta.lastBackup, sc = syncCfg();
  return `<div class="card"><h2>기본 정보 <button class="add" data-act="profile">수정</button></h2>
      <div class="kv"><span>출산 예정일</span><b>${h(p.dueDate || '미입력')}</b></div><div class="kv"><span>태명</span><b>${h(p.babyName || '-')}</b></div>
      <div class="kv"><span>키 / 임신 전 몸무게</span><b>${p.height ? h(p.height) + 'cm' : '-'} / ${p.preWeight ? h(p.preWeight) + 'kg' : '-'}</b></div></div>
    <div class="card"><h2>부부 공유</h2><div class="sub" data-sync><i class="dot ${syncState}"></i>${SYNC_TXT[syncState]}</div>` + (sc
      ? `<button class="btn pri" data-act="sync-key">공유 키 보기 (배우자 폰에 전달)</button><button class="btn danger" data-act="sync-off">이 폰의 공유 끊기</button>`
      : `<p class="note">두 폰에서 같은 기록을 실시간으로 보려면 공유 저장소(Firebase, 무료)가 한 번 필요해요.</p>
         <button class="btn pri" data-act="sync-new">새 공유 시작 (저장소 주소 입력)</button><button class="btn" data-act="sync-join">공유 키로 연결 (배우자가 이미 시작함)</button><button class="btn" data-act="sync-help">저장소 만드는 방법</button>`) + `</div>
    <div class="card"><h2>백업</h2><div class="sub">마지막 백업: ${lb ? new Date(lb).toLocaleDateString('ko-KR') : '없음'}</div>
      <button class="btn pri" data-act="export">백업 파일 내보내기</button><button class="btn" data-act="share">백업 파일 공유 (카톡 등)</button><button class="btn" data-act="import">백업 파일 불러오기</button></div>
    <div class="card"><h2>저장공간</h2><div class="sub" id="persist">확인 중…</div><button class="btn" data-act="persist">저장공간 보호 요청</button></div>
    <div class="card"><h2>데이터</h2><div class="sub">몸무게 ${S.weights.length} · 일정 ${S.events.length} · 일기 ${S.diary.length} · 태동 ${S.kicks.length} · 진통 ${S.contractions.length}</div>
      <button class="btn danger" data-act="wipe">이 폰의 기록 전체 삭제</button></div>
    <div class="card"><h2>정보 출처</h2><ul class="plain sub">
      <li>태아 발달(4~29주): MSD 매뉴얼 일반인용 「태아 발달 단계」</li><li>진료 간격·임신성 당뇨 검사·예방접종·엽산: MSD 매뉴얼 일반인용 「임신 중 치료」</li>
      <li>권장 체중 증가: MSD 매뉴얼 표 「임신 중 체중 증가」</li><li>임신성 당뇨 검사 시기: 서울아산병원 「임신성 당뇨검사」</li>
      <li>기형아 검사·정밀 초음파·GBS 검사 시기: 닥터나우 건강정보 「산전검사 시기와 항목」</li>
      <li>아기 크기 비유·길이·무게, 엄마 몸 변화·할 일 문구, 위험 증상, 태동·진통 기준, 체크리스트: 앱 제작 시 Claude가 일반 지식으로 작성 (외부 자료로 검증하지 않은 참고값)</li></ul>
      <div class="note">이 앱은 의료 기기가 아니에요. 진단·치료 판단은 담당 의사와 상의하세요. (2026-11-17 확인)</div></div>
    <div class="sub" style="text-align:center">열달노트 v${APP_VERSION} · 기록은 이 폰${sc ? '과 공유 저장소' : ''}에 저장돼요</div>`;
}

/* ---------- 라우팅·렌더 ---------- */
const VIEWS = { home: ['열달노트', vHome], week: ['주별 안내', vWeek], rec: ['기록', vRec], cal: ['일정', vCal], chk: ['체크리스트', vChk], set: ['설정', vSet] };
const TOP = { home: () => '<a class="ghost" href="#/set">⚙ 설정</a>', rec: () => UI.rec === 'weight' ? '<button data-top="w">＋ 몸무게</button>' : UI.rec === 'diary' ? '<button data-top="d">＋ 일기</button>' : '',
  cal: () => '<button data-top="e">＋ 일정</button>', chk: () => '<button data-top="c">＋ 항목</button>' };
function route() { const r = location.hash.replace(/^#\//, ''); return VIEWS[r] ? r : 'home'; }
function render() {
  const r = route(), [title, fn] = VIEWS[r];
  $('#title').textContent = title;
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === r));
  $('#topact').innerHTML = TOP[r] ? TOP[r]() : '';
  const y = scrollY, q = document.activeElement?.id === 'q';
  view.innerHTML = fn(); scrollTo(0, y);
  if (q) { const el = $('#q'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  if (r === 'week') { const c = $('#wchips .on'); if (c) $('#wchips').scrollLeft = c.offsetLeft - $('#wchips').clientWidth / 2 + c.clientWidth / 2; }
  if (r === 'set' && navigator.storage?.persisted) navigator.storage.persisted().then(p => { const el = $('#persist'); if (el) el.textContent = p ? '보호됨 — 브라우저가 임의로 지우지 않아요' : '보호 안 됨 — 저장공간이 부족하면 지워질 수 있어요'; });
}
window.addEventListener('hashchange', () => { scrollTo(0, 0); render(); });
setInterval(() => document.querySelectorAll('[data-el]').forEach(el => { el.textContent = mmss(Date.now() - Number(el.dataset.el)); }), 1000);

/* ---------- 이벤트 ---------- */
$('#topact').addEventListener('click', e => {
  const t = e.target.closest('[data-top]')?.dataset.top;
  if (t === 'w') editWeight(); else if (t === 'd') editDiary(); else if (t === 'e') editEvent(); else if (t === 'c') editCheck();
});
view.addEventListener('input', e => { if (e.target.id === 'q') { UI.q = e.target.value; $('#dlist').innerHTML = diaryList(); } });
function syncJoinForm() {
  openForm({ title: '공유 키로 연결', intro: '배우자 폰의 설정 → 부부 공유 → "공유 키 보기"에서 복사한 키를 붙여 넣으세요.', fields: [{ key: 'key', label: '공유 키', type: 'textarea', ph: 'yd1.…' }],
    check: o => parseKey(o.key) ? '' : '공유 키 형식이 맞지 않아요',
    onSave: async o => { if (await syncConnect(parseKey(o.key))) toast('연결했어요. 기록을 불러오는 중…'); } });
}
function syncHelp() {
  showSheet(`<h3>공유 저장소 만드는 방법 (한 번만)</h3><p>1. console.firebase.google.com 에서 구글 계정으로 로그인 → 프로젝트 만들기
2. 왼쪽 메뉴 빌드 → Realtime Database → 데이터베이스 만들기 (위치는 아무 곳, "잠금 모드")
3. "규칙" 탭에 아래 내용을 붙여 넣고 "게시"
4. "데이터" 탭 위쪽의 주소(https://…firebasedatabase.app 또는 …firebaseio.com)를 복사
5. 이 앱에서 "새 공유 시작"에 주소를 붙여 넣기 → "공유 키 보기"로 나온 키를 배우자 폰에 전달</p>
<div class="code">${h(RULES)}</div><button class="btn" data-a="copy">규칙 복사</button><button class="btn pri" data-a="x">닫기</button>
<p class="note">공유 키(긴 암호)를 아는 사람만 기록을 읽고 쓸 수 있는 방식이에요. 키는 배우자에게만 전달하세요.</p>`);
  sheet.onclick = e => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'copy') copyText(RULES); else if (a === 'x') closeSheet(); };
}
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('복사했어요'); } catch (e) { toast('복사하지 못했어요. 길게 눌러 직접 복사하세요'); } }
view.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act, id = el.dataset.id;
  if (a === 'check') { await toggleCheck(id); return render(); }
  if (a === 'ev-toggle') { const r = S.events.find(x => x.id === id); await put('events', { ...r, done: !r.done }); return render(); }
  if (a === 'edit') { const r = S[el.dataset.store].find(x => x.id === id); return r && EDIT[el.dataset.store](r); }
  if (a === 'profile') return editProfile();
  if (a === 'week') { UI.week = Number(id); scrollTo(0, 0); return render(); }
  if (a === 'rec') { UI.rec = id; return render(); }
  if (a === 'cat') { UI.cat = id; return render(); }
  if (a === 'past') { UI.past = !UI.past; return render(); }
  if (a === 'go-cal') { location.hash = '#/cal'; return; }
  if (a === 'go-kick' || a === 'go-con') { UI.rec = a === 'go-kick' ? 'kick' : 'con'; location.hash = '#/rec'; return render(); }
  if (a === 'ev-add') return editEvent();
  if (a === 'w-add') return editWeight();
  if (a === 'd-add') return editDiary();
  if (a === 'ex-add') { const x = EXAMS.find(q => q.id === id), s = examState(x); return editEvent(null, { title: x.name, type: x.id === 'exam_tdap' || x.id === 'exam_flu' ? '접종' : '검사', date: s.st === 'soon' ? s.start : iso() }); }
  if (a === 'kick-start') { await setMeta('kick', { start: Date.now(), count: 0 }); return render(); }
  if (a === 'kick-tap') { const k = S.meta.kick; await setMeta('kick', { ...k, count: k.count + 1 }); navigator.vibrate?.(30); return render(); }
  if (a === 'kick-cancel') { if (await ask('세던 기록을 버릴까요?', '버리기', 'danger')) { await setMeta('kick', null); render(); } return; }
  if (a === 'kick-save') { const k = S.meta.kick; await put('kicks', { start: k.start, end: Date.now(), count: k.count }); await setMeta('kick', null); toast('저장했어요'); return render(); }
  if (a === 'kick-del') { if (await ask('이 태동 기록을 삭제할까요?', '삭제', 'danger')) { await del('kicks', id); render(); } return; }
  if (a === 'con-tap') { const on = S.meta.con; if (on) { await put('contractions', { start: on, end: Date.now() }); await setMeta('con', null); } else await setMeta('con', Date.now()); return render(); }
  if (a === 'con-clear') { if (await ask('진통 기록을 모두 지울까요?', '모두 지우기', 'danger')) { for (const c of [...S.contractions]) await del('contractions', c.id); render(); } return; }
  if (a === 'import') return pickFile();
  if (a === 'export') return exportBackup();
  if (a === 'share') return shareBackup();
  if (a === 'install' && installEvt) { installEvt.prompt(); installEvt = null; return; }
  if (a === 'persist') { const ok = navigator.storage?.persist ? await navigator.storage.persist() : false; toast(ok ? '저장공간 보호가 켜졌어요' : '보호를 켜지 못했어요 (홈 화면에 설치 후 다시 시도)'); return render(); }
  if (a === 'sync-help') return syncHelp();
  if (a === 'sync-join') return syncJoinForm();
  if (a === 'sync-new') return openForm({ title: '새 공유 시작', intro: 'Firebase Realtime Database 주소를 붙여 넣으세요. 지금 이 폰의 기록이 공유 저장소로 올라가요.', fields: [{ key: 'url', label: '저장소 주소', type: 'url', ph: 'https://….firebasedatabase.app' }],
    check: o => okUrl(o.url) ? '' : 'https:// 로 시작하는 주소를 넣으세요',
    onSave: async o => { if (await syncConnect({ url: o.url.replace(/\/+$/, ''), code: newCode() })) toast('공유를 시작했어요. 공유 키를 배우자에게 전달하세요'); } });
  if (a === 'sync-key') {
    showSheet(`<h3>공유 키</h3><p>이 키를 배우자 폰의 열달노트 → "공유 키로 연결"에 붙여 넣으면 같은 기록을 함께 봐요. 다른 사람에게는 알려 주지 마세요.</p><div class="code">${h(syncKey())}</div>
      <button class="btn pri" data-a="copy">복사</button><button class="btn" data-a="send">카톡 등으로 보내기</button><button class="btn" data-a="x">닫기</button>`);
    sheet.onclick = ev => { const b = ev.target.closest('[data-a]')?.dataset.a; if (b === 'copy') copyText(syncKey()); else if (b === 'send') navigator.share ? navigator.share({ text: syncKey() }).catch(() => {}) : copyText(syncKey()); else if (b === 'x') closeSheet(); };
    return;
  }
  if (a === 'sync-off') { if (await ask('이 폰의 공유를 끊을까요?\n기록은 이 폰에 그대로 남고, 공유 저장소의 기록도 지워지지 않아요.', '공유 끊기', 'danger')) { syncStop(); await setMeta('sync', null); setSync('off'); render(); } return; }
  if (a === 'wipe') { if (await ask('이 폰의 기록을 모두 삭제하고 공유도 끊을까요?\n먼저 백업 파일을 내보내 두세요. 되돌릴 수 없어요.', '전체 삭제', 'danger')) { syncStop(); await setMeta('sync', null); await setMeta('kick', null); await setMeta('con', null); await clearAll(); setSync('off'); toast('전체 삭제했어요'); location.hash = '#/home'; render(); } }
});
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (route() === 'home') render(); });
window.addEventListener('appinstalled', () => { installEvt = null; navigator.storage?.persist?.(); render(); });
window.addEventListener('online', () => { if (syncCfg()) syncStart(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (syncCfg() && syncState !== 'on') syncStart(); render(); } });

/* ---------- 시작 ---------- */
(async () => {
  db = await openDB(); await loadAll();
  if (!S.meta.firstUse) await setMeta('firstUse', Date.now());
  render();
  if (syncCfg()) syncStart();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.X = { S, R, UI, importData, clearAll, backupObj, loadAll, render, match, put, del, setMeta, ga, syncConnect, syncStart, syncKey, parseKey, get syncState() { return syncState; }, APP_VERSION };
})();
