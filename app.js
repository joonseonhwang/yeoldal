// 열달노트 — 임신 주차·몸무게·일정·기록 관리 (개인용 PWA, 부부 공유)
// 출처: [Claude] 설계·작성 / [사용자] 요구사항(2026-11-17 대화). 화면 뼈대는 같은 날 만든 '우리집노트' app.js를 재사용.
// 기록은 이 기기의 IndexedDB에 저장한다. '부부 공유'를 켠 경우에만 사용자가 만든 Firebase 실시간 데이터베이스로 기록을 보낸다.
// 주별 안내·검사 시기 내용과 그 출처는 data.js 참고.
'use strict';
const APP_VERSION = '1.2.4';
const DB_NAME = 'yeoldal-note';
const STORES = ['profile', 'weights', 'events', 'diary', 'kicks', 'contractions', 'checks'];
const DAY = 86400000;

const R = {};                       // 삭제 표시(tombstone)까지 포함한 원본 — 백업·공유용
const S = { meta: {} };             // 화면용 (삭제된 것 제외)
STORES.forEach(s => { R[s] = []; S[s] = []; });
const UI = { week: null, selW: null, rec: 'weight', cat: Object.keys(CHECKLIST)[0], q: '', past: false };
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
/* ---------- 체중 가이드 (baekdo 앱 계산 방식, data.js의 STDS·FETAL·HY) ---------- */
function catIn(key, bmi) { const s = STDS[key]; let i = 0; while (i < 3 && bmi >= s.cuts[i]) i++; return { name: s.names[i], total: s.totals[i], first: s.first[i] }; }
const bmiOf = () => { const p = prof(); return p.height > 100 && p.height < 230 && p.preWeight > 25 && p.preWeight < 250 ? p.preWeight / (p.height / 100) ** 2 : null; };
// 자동: 내 BMI에서 출산 무렵 권장 상한이 가장 낮은 기준을 고른다
function autoKey() {
  const bmi = bmiOf(); if (!bmi) return 'jp2021';
  return Object.keys(STDS).reduce((best, k) => { const a = catIn(best, bmi), c = catIn(k, bmi);
    return c.total[1] < a.total[1] || (c.total[1] === a.total[1] && c.total[0] < a.total[0]) ? k : best; }, 'jp2021');
}
const stdSel = () => STDS[prof().std] ? prof().std : 'auto';
const stdKey = () => stdSel() === 'auto' ? autoKey() : stdSel();
function stdNote() {
  if (stdSel() !== 'auto') return STDS[stdSel()].note;
  const bmi = bmiOf(); if (!bmi) return '자동: 키·임신 전 몸무게를 넣으면 상한이 가장 낮은 기준을 골라요.';
  return `자동: 상한이 가장 낮은 ${STDS[autoKey()].name} 기준 적용 (출산 무렵 상한 ${Object.keys(STDS).map(k => STDS[k].name.split(' ')[0] + ' +' + catIn(k, bmi).total[1]).join(' · ')}kg)`;
}
// 권장 기준 정보: 임신 전 몸무게(base), BMI, 구간(c)
function guide() { const bmi = bmiOf(); return bmi ? { bmi, base: Number(prof().preWeight), c: catIn(stdKey(), bmi) } : null; }
// w주의 임신 전 대비 권장 증가 [하한, 상한] — 0~13주는 1분기 증가량까지, 이후 40주 총 증가량까지 직선
function range(w, c) {
  if (w <= 13) return [c.first[0] * w / 13, c.first[1] * w / 13];
  const t = (Math.min(w, 40) - 13) / 27;
  return [c.first[0] + (c.total[0] - c.first[0]) * t, c.first[1] + (c.total[1] - c.first[1]) * t];
}
function statusOf(k, w, base, c) {
  const r = range(Math.min(w, 40), c);
  if (k < base + r[0] - 0.05) return { cls: 'lo', txt: '권장보다 적음' };
  if (k > base + r[1] + 0.05) return { cls: 'bad', txt: '권장보다 많음' };
  return { cls: 'ok', txt: '권장 범위' };
}
function lerpTbl(tbl, w) {
  const ks = Object.keys(tbl).map(Number).sort((a, b) => a - b);
  if (w <= ks[0]) return tbl[ks[0]];
  for (let i = 1; i < ks.length; i++) if (w <= ks[i]) { const a = ks[i - 1], b = ks[i]; return tbl[a] + (tbl[b] - tbl[a]) * (w - a) / (b - a); }
  return tbl[ks[ks.length - 1]];
}
function lerp5(arr, w) { const t = Math.max(0, Math.min(40, w)) / 10, i = Math.min(3, Math.floor(t)); return arr[i] + (arr[i + 1] - arr[i]) * (t - i); }
const comp = w => { const x = Math.min(w, 40); return { baby: lerpTbl(FETAL, x), pla: lerp5(HY.pla, x), mat: lerp5(HY.mat, x) }; };
const pregKg = w => { const p = comp(w); return p.baby + p.pla + p.mat; };
const fw = kg => kg < 1 ? Math.round(kg * 1000) + 'g' : kg1(kg) + 'kg';
const sg = n => (n >= 0 ? '+' : '') + kg1(n);
const wd = w => { const d = Math.round(w * 7); return `${Math.floor(d / 7)}주 ${d % 7}일`; };
// 몸무게 기록에 주수(w)를 붙여 오래된 순으로
const wlogs = () => prof().dueDate ? S.weights.filter(x => x.date && x.kg > 0).map(x => ({ ...x, kg: Number(x.kg), w: (dnum(x.date) - lmpNum()) / 7 })).filter(x => x.w >= 0 && x.w <= 42).sort((a, b) => a.w - b.w) : [];

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
  try { o = JSON.parse(await f.text()); if (o && o.app === 'baekdo-weight' && Array.isArray(o.logs)) return runBaekdoImport(o); validate(o); } catch (err) { return toast(err.message.includes('JSON') ? 'JSON 파일을 읽을 수 없어요' : err.message); }
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
  await setMeta('sync', cfg); syncStart();
  if (S.meta.notify?.on) pushOn().then(push => setMeta('notify', { ...S.meta.notify, push }));
  return true;
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
    check: o => { if (!o.dueDate && o.lmp) o.dueDate = fromNum(dnum(o.lmp) + 280); if (!o.dueDate) return '출산 예정일을 입력하세요';
      if (o.height != null && !(o.height > 100 && o.height < 230)) return '키를 확인하세요 (cm, 예: 160)';
      if (o.preWeight != null && !(o.preWeight > 25 && o.preWeight < 250)) return '임신 전 몸무게를 확인하세요 (kg, 예: 55.0)';
      return ''; },
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

/* ---------- 매일 체크리스트 + 알림 ----------
   항목 목록·알림 시각: profile.daily / profile.dailyTime (부부 공유됨, 없으면 data.js 기본값)
   하루 기록: checks 저장소의 'dd-<날짜>-<항목id>' = { kind:'daily', date, item, done } — 항목마다 따로라 두 폰이 동시에 체크해도 안 덮어씀
   알림 켜기·보낸 기록: meta 'notify' / 'notified' (이 폰에만). 서비스워커(sw.js)도 같은 규칙으로 백그라운드에서 확인한다. */
const dailyItems = () => Array.isArray(prof().daily) ? prof().daily : DAILY_DEFAULT;
const dailyTime = () => ({ ...DAILY_TIME, ...(prof().dailyTime || {}) });
const dailyOn = () => ({ ...DAILY_ON, ...(prof().dailyOn || {}) });   // 아침·저녁 알림 따로 켜고 끄기 (profile.dailyOn, 부부 공유)
const ddId = (date, item) => `dd-${date}-${item}`;
const ddDone = (item, date = iso()) => !!ck(ddId(date, item))?.done;
const toggleDaily = (item, date = iso()) => put('checks', { id: ddId(date, item), kind: 'daily', date, item, done: !ddDone(item, date) });
// 아침/저녁 한 번에: 안 한 게 있으면 전부 체크, 다 했으면 전부 해제
async function slotAll(slot, date = iso()) {
  const its = dailyItems().filter(i => i.slot === slot), all = its.every(i => ddDone(i.id, date));
  for (const i of its) if (ddDone(i.id, date) === all) await put('checks', { id: ddId(date, i.id), kind: 'daily', date, item: i.id, done: !all });
  return !all;
}
const nowHM = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
// 알림 시각이 지났는데 안 한 항목 (slot별)
function dailyMissing(now = new Date()) {
  const date = iso(now), t = dailyTime(), out = [];
  for (const slot of ['am', 'pm']) {
    if (!dailyOn()[slot] || nowHM(now) < t[slot]) continue;
    const miss = dailyItems().filter(i => i.slot === slot && !ddDone(i.id, date));
    if (miss.length) out.push({ slot, date, miss });
  }
  return out;
}
const saveDaily = (daily, extra = {}) => put('profile', { ...prof(), id: 'main', daily, ...extra });
const notifyOn = () => !!S.meta.notify?.on && 'Notification' in window && Notification.permission === 'granted';
async function notifyCheck() {
  if (!db || !prof().dueDate && !Array.isArray(prof().daily)) return;
  const due = dailyMissing(); if (!due.length) return;
  // 서비스워커가 먼저 알렸을 수 있으니 저장소에서 다시 읽는다
  const sent = await new Promise(res => { const r = db.transaction('meta').objectStore('meta').get('notified'); r.onsuccess = () => res(r.result?.value || {}); r.onerror = () => res({}); });
  let changed = false;
  for (const d of due) {
    const key = `${d.date}-${d.slot}`; if (sent[key]) continue;
    const body = d.miss.map(i => i.name).join(', ') + ' — 아직 체크 안 했어요';
    if (!document.hidden) toast(`${SLOT_NAME[d.slot]}에 챙길 것 ${d.miss.length}개가 남았어요`);
    else if (notifyOn()) { try { const reg = await navigator.serviceWorker.ready; await reg.showNotification(`열달노트 · ${SLOT_NAME[d.slot]} 챙길 것`, { body, tag: 'daily-' + d.slot, icon: 'icons/icon-192.png', data: { url: './#/home' } }); } catch (e) { continue; } }
    else continue;
    sent[key] = Date.now(); changed = true;
  }
  if (changed) { for (const k of Object.keys(sent)) if (Date.now() - sent[k] > 7 * DAY) delete sent[k]; await setMeta('notified', sent); }
}
/* 정확한 시각 알림: 이 폰의 '알림 받을 주소'(웹 푸시 구독)를 공유 저장소 push/<기기id>에 올리면,
   24시간 켜 둔 PC의 발송 프로그램(yeoldal_push.py)이 정한 시각에 체크 기록을 보고 안 한 게 있으면 알림을 보낸다.
   아래는 공개 열쇠(공개돼도 됨). 짝이 되는 비밀 열쇠는 발송 PC에만 있다. */
const VAPID_PUBLIC = 'BGLneECTpSbOg2liwse7zi2kBkCQjPjWgscqx6H0xGHB-mfGABV2_SzrjTs_HxqGPAXDhK_Dk6XNnTJxnJe8Pys';
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
async function devId() { if (!S.meta.devId) await setMeta('devId', 'p' + uid()); return S.meta.devId; }
async function pushOn() {
  if (!syncCfg()) return 'nosync';
  try {
    const reg = await swReady(); if (!reg?.pushManager) return 'unsupported';
    let sub = await reg.pushManager.getSubscription();
    if (sub && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey || []))).replace(/=+$/, '') !== btoa(String.fromCharCode(...b64u(VAPID_PUBLIC))).replace(/=+$/, '')) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(VAPID_PUBLIC) });
    const r = await fetch(`${syncBase()}/push/${await devId()}.json`, { method: 'PATCH', body: JSON.stringify({ sub: sub.toJSON(), updatedAt: Date.now() }) });
    return r.ok ? 'on' : 'fail';
  } catch (e) { return 'fail'; }
}
async function pushOff() {
  try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager?.getSubscription(); if (sub) await sub.unsubscribe(); } catch (e) { /* 없음 */ }
  if (syncCfg() && S.meta.devId) try { await fetch(`${syncBase()}/push/${S.meta.devId}.json`, { method: 'DELETE' }); } catch (e) { /* 오프라인 */ }
}
// 발송 PC가 5분마다 남기는 '살아 있음' 시각
let srvAt = null;
async function pushSrvCheck() {
  if (!syncCfg()) return;
  try { const r = await fetch(`${syncBase()}/pushsrv.json`); const o = r.ok ? await r.json() : null; srvAt = o?.at || 0; } catch (e) { srvAt = null; }
  const el = $('#pushsrv'); if (el) el.innerHTML = srvLine();
}
function srvLine() {
  if (srvAt === null) return '알림 보내는 PC: 확인 중…';
  if (!srvAt) return '<b class="bad">알림 보내는 PC: 아직 연결된 적 없음</b>';
  const m = Math.round((Date.now() - srvAt) / 60000);
  return m <= 12 ? `<b class="ok">알림 보내는 PC: 켜져 있음</b> <span class="sub">(${m}분 전 확인)</span>` : `<b class="bad">알림 보내는 PC: ${m >= 120 ? Math.round(m / 60) + '시간' : m + '분'} 동안 응답 없음 — 꺼져 있으면 정확한 시각 알림이 안 와요</b>`;
}
// 폰에서 응답 없이 멈추는 경우 대비: ms 안에 안 끝나면 fb를 돌려준다
const within = (p, ms, fb) => Promise.race([Promise.resolve(p).catch(() => fb), new Promise(r => setTimeout(() => r(fb), ms))]);
const swReady = (ms = 8000) => within(navigator.serviceWorker.ready, ms, null);
async function periodicOn() {
  try {
    const reg = await swReady(); if (!reg) return 'unsupported';
    if (!reg.periodicSync) return 'unsupported';
    const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (st.state !== 'granted') return 'denied';
    await reg.periodicSync.register('daily-check', { minInterval: 60 * 60 * 1000 });
    return 'on';
  } catch (e) { return 'unsupported'; }
}
async function periodicOff() { try { const reg = await navigator.serviceWorker.ready; await reg.periodicSync?.unregister('daily-check'); } catch (e) { /* 없음 */ } }
let notifyBusy = false;
async function enableNotify() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return toast('이 브라우저는 알림을 지원하지 않아요');
  if (notifyBusy) return toast('알림 켜는 중이에요…');
  notifyBusy = true; toast('알림 켜는 중…');
  try {
    const p = Notification.permission === 'granted' ? 'granted' : await within(Notification.requestPermission(), 60000, Notification.permission);
    if (p !== 'granted') return toast(p === 'denied' ? '알림이 막혀 있어요. 폰 설정 → 애플리케이션 → 열달노트(또는 Chrome) → 알림에서 허용해 주세요' : '알림 허용 창에서 "허용"을 눌러 주세요');
    const [bg, push] = await Promise.all([within(periodicOn(), 10000, 'unsupported'), within(pushOn(), 15000, 'fail')]);
    await setMeta('notify', { on: true, bg, push });
  toast(push === 'on' ? '알림을 켰어요. 앱을 꺼 둬도 정한 시각에 와요' : push === 'nosync' ? '알림을 켰어요. 정확한 시각 알림은 부부 공유를 켜야 돼요' : '알림을 켰어요 (정확한 시각 알림 등록은 실패 — 인터넷 확인 후 다시 켜 주세요)'); render(); pushSrvCheck();
  } catch (e) { toast('알림 켜기 실패 — 앱을 닫았다 다시 열고 한 번 더 눌러 주세요'); }
  finally { notifyBusy = false; }
}
async function testNotify() {
  if (!notifyOn()) return toast('먼저 알림을 켜 주세요');
  if (S.meta.notify.push === 'on' && syncCfg()) {
    try { const r = await fetch(`${syncBase()}/push/${await devId()}.json`, { method: 'PATCH', body: JSON.stringify({ testAt: Date.now() }) }); if (!r.ok) throw 0;
      return toast('PC에 테스트 알림을 요청했어요. 앱을 닫고 기다리면 30초 안에 와요'); } catch (e) { toast('요청 실패 — 이 폰에서 바로 띄워요'); }
  }
  const reg = await navigator.serviceWorker.ready, miss = dailyItems().filter(i => !ddDone(i.id));
  await reg.showNotification('열달노트 · 테스트 알림', { body: miss.length ? `오늘 남은 것: ${miss.map(i => i.name).join(', ')}` : '오늘 다 챙겼어요 👍', tag: 'daily-test', icon: 'icons/icon-192.png', data: { url: './#/home' } });
}
function dailyRows(slot) {
  const its = dailyItems().filter(i => i.slot === slot); if (!its.length) return '';
  const dn = its.filter(i => ddDone(i.id)).length, late = dailyOn()[slot] && dn < its.length && nowHM() >= dailyTime()[slot];
  return `<div class="lbl dslot"><span>${slot === 'am' ? '🌅' : '🌙'} ${SLOT_NAME[slot]} <span class="sub">${dn}/${its.length}${late ? ` · <b class="bad">${dailyTime()[slot]} 지남</b>` : (dailyOn()[slot] ? ` · ${dailyTime()[slot]}까지` : '')}</span></span>` +
    `<button class="dall ${dn === its.length ? 'off' : ''}" data-act="daily-all" data-id="${slot}">${dn === its.length ? '모두 해제' : `${SLOT_NAME[slot]} 모두 체크`}</button></div>` +
    its.map(i => { const on = ddDone(i.id); return `<div class="row ${on ? 'done' : ''}" data-act="daily" data-id="${h(i.id)}">${chkBtn(on, 'daily', i.id)}<div class="mid"><div class="nm">${h(i.name)}</div></div><div class="amt sub">${on ? hm(ck(ddId(iso(), i.id)).updatedAt) : ''}</div></div>`; }).join('');
}
function dailyWeek() {
  const its = dailyItems(), today = dnum(iso());
  return `<div class="dweek">${[6, 5, 4, 3, 2, 1, 0].map(k => { const ds = fromNum(today - k), n = its.filter(i => ddDone(i.id, ds)).length;
    return `<div class="${n === its.length && its.length ? 'all' : n ? 'some' : ''}"><span>${k ? '일월화수목금토'[new Date((today - k) * DAY).getUTCDay()] : '오늘'}</span><b>${n}/${its.length}</b></div>`; }).join('')}</div>`;
}
function vDailyCard() {
  const its = dailyItems(), dn = its.filter(i => ddDone(i.id)).length;
  return `<div class="card" id="daily"><h2>오늘 챙길 것 <small>${dn}/${its.length}</small><button class="add" data-act="daily-set">항목·알림 ›</button></h2>
    <div class="bar"><i class="g" style="width:${pct(dn, its.length)}%"></i></div>
    ${its.length ? dailyRows('am') + dailyRows('pm') : '<div class="empty">항목이 없어요. 항목·알림에서 추가하세요</div>'}
    ${dailyWeek()}${notifyOn() ? '' : '<div class="note">안 챙겼을 때 폰 알림을 받으려면 <b>항목·알림 ›</b>에서 알림을 켜세요.</div>'}</div>`;
}
function vDailySet() {
  const t = dailyTime(), n = S.meta.notify, on = notifyOn(), perm = 'Notification' in window ? Notification.permission : 'none';
  const st = on ? (n.push === 'on' ? '켜짐 — 앱을 꺼 둬도 정한 시각에 와요' : n.push === 'nosync' ? '켜짐 — 앱을 열 때만 확인 (정확한 시각 알림은 부부 공유가 필요해요)' : '켜짐 — 정확한 시각 알림 등록 안 됨 (알림 끄기 → 켜기로 다시 시도)') : perm === 'denied' ? '차단됨 — 폰 설정에서 알림을 허용해 주세요' : '꺼짐';
  return `<div class="card" id="dailyset"><h2>매일 체크리스트 · 알림</h2>
    ${['am', 'pm'].map(s => `<div class="kv dslot"><span>${s === 'am' ? '🌅' : '🌙'} ${SLOT_NAME[s]} 알림 <b class="${dailyOn()[s] ? '' : 'sub'}">${h(t[s])}</b></span><button class="dall ${dailyOn()[s] ? '' : 'off'}" data-act="daily-on" data-id="${s}">${dailyOn()[s] ? '켜짐' : '꺼짐'}</button></div>`).join('')}
    <button class="btn" data-act="daily-time">알림 시각 바꾸기</button>
    <div class="sub" style="margin-top:10px">이 폰 알림: <b class="${on ? 'ok' : ''}">${st}</b></div>
    ${on && n.push === 'on' ? `<div class="sub" id="pushsrv">${srvLine()}</div>` : ''}
    ${on ? '<div class="btns"><button class="btn" data-act="notify-test">테스트 알림</button><button class="btn" data-act="notify-off">알림 끄기</button></div>' : '<button class="btn pri" data-act="notify-on">알림 켜기</button>'}
    <div class="lbl">항목 <span class="sub">(누르면 수정)</span></div>
    ${dailyItems().map(i => `<div class="row" data-act="daily-edit" data-id="${h(i.id)}"><span class="tag">${SLOT_NAME[i.slot]}</span><div class="mid"><div class="nm">${h(i.name)}</div></div><div class="amt sub">수정 ›</div></div>`).join('') || '<div class="empty">항목이 없어요</div>'}
    <button class="btn" data-act="daily-add">＋ 항목 추가</button>
    <button class="btn" data-act="daily-ics">폰 달력에 매일 알람 넣기</button>
    <div class="note">알림은 정한 시각까지 체크하지 않은 항목이 있을 때만 와요. 아침·저녁 알림은 오른쪽 버튼으로 따로 켜고 끌 수 있어요(부부가 같이 바뀜). 앱을 꺼 둬도 집 PC가 정한 시각에 보내 줘요(그 PC가 켜져 있고 인터넷이 될 때). PC가 꺼져 있을 때를 대비하려면 '폰 달력에 매일 알람 넣기'를 같이 쓰세요(달력 알람은 체크해도 울려요).</div></div>`;
}
function editDaily(item) {
  openForm({
    title: item ? '항목 수정' : '항목 추가', value: item ? { ...item, slotName: SLOT_NAME[item.slot] } : { slotName: '저녁' },
    fields: [{ key: 'name', label: '이름', ph: '예: 유산균' }, { key: 'slotName', label: '언제', type: 'select', options: ['아침', '저녁'] }],
    check: o => o.name ? '' : '이름을 입력하세요',
    onSave: o => { const it = { id: item?.id || 'd' + uid(), name: o.name, slot: o.slotName === '아침' ? 'am' : 'pm' };
      const list = dailyItems().slice(), k = list.findIndex(x => x.id === it.id); if (k >= 0) list[k] = it; else list.push(it); return saveDaily(list); },
    onDelete: item && (() => saveDaily(dailyItems().filter(x => x.id !== item.id))),
  });
}
function editDailyTime() {
  openForm({
    title: '알림 시각', intro: '이 시각까지 다 체크하지 않으면 알림을 보내요.', value: dailyTime(),
    fields: [{ key: 'am', label: '🌅 아침', type: 'time' }, { key: 'pm', label: '🌙 저녁', type: 'time' }],
    check: o => /^\d\d:\d\d$/.test(o.am) && /^\d\d:\d\d$/.test(o.pm) ? '' : '시각을 입력하세요',
    onSave: o => saveDaily(dailyItems(), { dailyTime: { am: o.am, pm: o.pm } }),
  });
}
// 폰 달력(삼성·구글 캘린더)에 매일 반복 알람 일정 파일(.ics)
function dailyIcs() {
  const t = dailyTime(), d0 = iso().replace(/-/g, ''), stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
  const until = prof().dueDate ? `;UNTIL=${fromNum(dnum(prof().dueDate) + 60).replace(/-/g, '')}T235959` : ';COUNT=300';
  const esc = s => String(s).replace(/[\\;,]/g, c => '\\' + c).replace(/\n/g, '\\n');
  const ev = slot => { const its = dailyItems().filter(i => i.slot === slot); if (!its.length || !dailyOn()[slot]) return '';
    return ['BEGIN:VEVENT', `UID:yeoldal-daily-${slot}-${d0}@yeoldal`, `DTSTAMP:${stamp}`, `DTSTART:${d0}T${t[slot].replace(':', '')}00`, 'DURATION:PT10M',
      `RRULE:FREQ=DAILY${until}`, `SUMMARY:${esc(`열달노트 · ${SLOT_NAME[slot]} 챙길 것`)}`, `DESCRIPTION:${esc(its.map(i => i.name).join(', '))}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(`${SLOT_NAME[slot]} 챙길 것`)}`, 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT'].join('\r\n') + '\r\n'; };
  return 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//yeoldal-note//KO\r\nCALSCALE:GREGORIAN\r\n' + ev('am') + ev('pm') + 'END:VCALENDAR\r\n';
}
async function shareIcs() {
  const f = new File([dailyIcs()], `열달노트_매일알람_${ymd()}.ics`, { type: 'text/calendar' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  showSheet(`<h3>달력 알람 파일을 받았어요</h3><p>1. 알림창이나 '내 파일 → 다운로드'에서 <b>${h(f.name)}</b>을 누르세요
2. 캘린더 앱(삼성 캘린더·구글 캘린더)을 고르고 저장
3. 매일 ${['am', 'pm'].filter(s => dailyOn()[s]).map(s => h(dailyTime()[s])).join(' / ') || '(켜진 알림 없음)'}에 알람이 울려요</p>
<p class="note">항목이나 시각을 바꾸면 달력의 예전 일정을 지우고 파일을 다시 받으세요. 달력 알람은 체크 여부와 상관없이 울려요.</p><button class="btn pri" data-a="x">닫기</button>`);
  sheet.onclick = e => { if (e.target.closest('[data-a]')) closeSheet(); };
}

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
  o += vDailyCard();
  o += `<div class="card"><h2>${w}주차 안내 <a class="add" href="#/week">자세히 ›</a></h2><div class="lbl">아기</div><div>${h(W.baby)}</div><div class="lbl">엄마</div><div>${h(W.mom)}</div>
    <div class="lbl">이번 주 할 일</div>${todoRows(w)}</div>`;
  const next = S.events.filter(e => !e.done && e.date >= today).sort(sortEv).slice(0, 3);
  const nowEx = EXAMS.filter(x => examState(x).st === 'now' && !ck(x.id)?.done);
  o += `<div class="card"><h2>다가오는 일정 <button class="add" data-act="ev-add">＋ 추가</button></h2>${next.map(evRow).join('') || '<div class="empty">등록된 일정이 없어요</div>'}
    ${nowEx.map(x => `<div class="row" data-act="go-cal"><div class="mid"><div class="nm">${h(x.name)}</div><div class="sub"><span class="tag now">지금 시기</span>${examState(x).range}</div></div></div>`).join('')}</div>`;
  const ws = [...S.weights].sort((a, b) => a.date.localeCompare(b.date)), last = ws[ws.length - 1], gd = guide();
  const lw = last && (dnum(last.date) - lmpNum()) / 7, lst = gd && last && lw >= 0 && lw <= 42 ? statusOf(Number(last.kg), lw, gd.base, gd.c) : null;
  const tr = gd && g.days > 0 && g.days <= 280 ? range(g.days / 7, gd.c) : null;
  o += `<div class="card"><h2>몸무게 <span><button class="add" data-act="go-weight">가이드 ›</button> <button class="add" data-act="w-add">＋ 기록</button></span></h2>` + (last
    ? `<div class="big">${kg1(last.kg)}kg ${p.preWeight > 0 ? `<span class="sub">임신 전보다 ${sg(last.kg - p.preWeight)}kg</span>` : ''}</div><div class="sub">${fmtD(last.date)} 기록${lst ? ` · <b class="${lst.cls}">${lst.txt}</b>` : ''}</div>`
    : `<div class="empty">아직 기록이 없어요</div>`) + (gd
    ? `<div class="note">${tr ? `오늘(${g.w}주 ${g.d}일) 권장 <b>${kg1(gd.base + tr[0])}~${kg1(gd.base + tr[1])}kg</b> · ` : ''}임신 전 BMI ${kg1(gd.bmi)} ${gd.c.name} · 출산 무렵 목표 ${kg1(gd.base + gd.c.total[0])}~${kg1(gd.base + gd.c.total[1])}kg (${STDS[stdKey()].name} 기준)</div>`
    : `<div class="note">설정에서 키와 임신 전 몸무게를 넣으면 주수별 권장 범위를 보여줘요.</div>`) + `</div>`;
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
/* 몸무게 = 체중 가이드 화면. 그래프 배경은 render 때 그리고, 선택 주수(커서·수치·구성·표)는 updSel()만 다시 그린다 */
const G = { W: 360, H: 250, pl: 36, pr: 12, pt: 22, pb: 26 };
let gx = null;   // 현재 그래프 좌표 변환
const f1 = n => n.toFixed(1);
function chartSvg(gd, logs, cw) {
  const { base, c } = gd, { W, H, pl, pr, pt, pb } = G;
  let lo = base - 1, hi = base + c.total[1] + 1;
  logs.forEach(l => { lo = Math.min(lo, l.kg - 1); hi = Math.max(hi, l.kg + 1); });
  lo = Math.floor(lo); hi = Math.ceil(hi);
  const step = hi - lo <= 12 ? 2 : hi - lo <= 24 ? 4 : 5;
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = w => pl + w / 40 * (W - pl - pr), y = k => pt + (hi - k) / (hi - lo) * (H - pt - pb);
  gx = { x, y, base, c };
  let o = `<svg class="chart" id="wchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="주수별 권장 체중 그래프 (눌러서 주수 선택)">`;
  o += `<rect x="${f1(x(13))}" y="${pt}" width="${f1(x(27) - x(13))}" height="${H - pt - pb}" fill="#ffffff" fill-opacity=".04"/>`;
  [[0, 13, '1분기'], [13, 27, '2분기'], [27, 40, '3분기']].forEach(t => { o += `<text x="${f1((x(t[0]) + x(t[1])) / 2)}" y="${pt - 8}" text-anchor="middle">${t[2]}</text>`; });
  for (let k = lo; k <= hi; k += step) o += `<line x1="${pl}" x2="${W - pr}" y1="${f1(y(k))}" y2="${f1(y(k))}" stroke="#383146" stroke-width=".8"/><text x="${pl - 5}" y="${f1(y(k) + 3.5)}" text-anchor="end">${k}</text>`;
  [0, 10, 20, 30, 40].forEach(w => { o += `<text x="${f1(x(w))}" y="${H - pb + 17}" text-anchor="middle">${w}주</text>`; });
  const up = [], dn = [], mid = [];
  for (let w = 0; w <= 40; w += 0.5) { const r = range(w, c); up.push(f1(x(w)) + ',' + f1(y(base + r[1]))); dn.unshift(f1(x(w)) + ',' + f1(y(base + r[0]))); mid.push(f1(x(w)) + ',' + f1(y(base + (r[0] + r[1]) / 2))); }
  o += `<polygon points="${up.concat(dn).join(' ')}" fill="#8fb8ff" fill-opacity=".22"/><polyline points="${mid.join(' ')}" fill="none" stroke="#8fb8ff" stroke-width="1.6" stroke-linejoin="round"/>`;
  o += `<line x1="${pl}" x2="${W - pr}" y1="${f1(y(base))}" y2="${f1(y(base))}" stroke="#a59db5" stroke-width=".9" stroke-dasharray="2 3"/><text x="${W - pr}" y="${f1(y(base) + 13)}" text-anchor="end">임신 전 ${kg1(base)}</text>`;
  const rE = range(40, c);
  o += `<text x="${W - pr - 2}" y="${f1(y(base + rE[1]) - 6)}" text-anchor="end" style="fill:#8fb8ff;font-weight:700">${kg1(base + rE[0])}~${kg1(base + rE[1])}</text>`;
  if (cw != null && cw <= 40) {
    const tr = range(cw, c), r = cw > 34;
    o += `<line x1="${f1(x(cw))}" x2="${f1(x(cw))}" y1="${pt}" y2="${H - pb}" stroke="#ff9db0" stroke-width="1.2" stroke-dasharray="3 3"/>
      <text x="${f1(x(cw) + (r ? -4 : 4))}" y="${H - pb - 5}" text-anchor="${r ? 'end' : 'start'}" style="fill:#ff9db0;font-weight:700">오늘</text>
      <circle cx="${f1(x(cw))}" cy="${f1(y(base + (tr[0] + tr[1]) / 2))}" r="3" fill="#1f1b27" stroke="#ff9db0" stroke-width="1.5"/>`;
  }
  const pts = logs.filter(l => l.w <= 40);
  if (pts.length > 1) o += `<polyline points="${pts.map(l => f1(x(l.w)) + ',' + f1(y(l.kg))).join(' ')}" fill="none" stroke="#ff9db0" stroke-width="1.5" stroke-linejoin="round" opacity=".75"/>`;
  o += pts.map(l => `<circle cx="${f1(x(l.w))}" cy="${f1(y(l.kg))}" r="4.2" fill="#ff9db0" stroke="#1f1b27" stroke-width="1.5"/>`).join('');
  return o + '<g id="wcur"></g></svg>';
}
// 선택 주수(UI.selW)에 따라 바뀌는 부분
function updSel() {
  const gd = guide(); if (!gd || !gx || !$('#wcur')) return;
  const { base, c } = gd, w = UI.selW, r = range(w, c), md = (r[0] + r[1]) / 2, { x, y } = gx;
  const cx = x(w), yU = y(base + r[1]), yL = y(base + r[0]), yM = y(base + md), right = w < 30, bw = 46;
  const bx = right ? cx + 6 : cx - bw - 6; let by = yU - 26; if (by < G.pt + 2) by = yL + 8;
  $('#wcur').innerHTML = `<line x1="${f1(cx)}" x2="${f1(cx)}" y1="${G.pt}" y2="${G.H - G.pb}" stroke="#8fb8ff" stroke-width="1.3" opacity=".85"/>
    <rect x="${f1(cx - 4)}" y="${f1(yU)}" width="8" height="${f1(Math.max(1.5, yL - yU))}" rx="2" fill="#8fb8ff" opacity=".35"/>
    <circle cx="${f1(cx)}" cy="${f1(yM)}" r="4" fill="#8fb8ff" stroke="#1f1b27" stroke-width="1.5"/>
    <rect x="${f1(bx)}" y="${f1(by)}" width="${bw}" height="18" rx="9" fill="#8fb8ff"/><text x="${f1(bx + bw / 2)}" y="${f1(by + 13)}" text-anchor="middle" style="fill:#15121a;font-weight:700">${kg1(base + md)}</text>`;
  $('#wsel').innerHTML = `<div class="sub">${w}주 권장 체중</div><div class="big">${kg1(base + r[0])} ~ ${kg1(base + r[1])} kg</div><div class="sub">임신 전 +${kg1(r[0])}~${kg1(r[1])}kg · 중앙 ${kg1(base + md)}kg</div>`;
  $('#wsl').value = w;
  const g = ga(), cw = g && g.days >= 0 && g.days <= 294 ? g.days / 7 : null;
  $('#wtoday').classList.toggle('on', cw != null && w === Math.min(40, Math.round(cw)));
  const near = wlogs().filter(l => Math.abs(l.w - w) < 0.5), l = near[near.length - 1];
  let s1 = '<span class="sub">이 주수에는 기록이 없어요</span>', s2 = '';
  if (l) { const s = statusOf(l.kg, l.w, base, c), lr = range(Math.min(l.w, 40), c); s1 = `<i class="lg" style="background:#ff9db0"></i>${wd(l.w)} 기록 <b>${kg1(l.kg)}kg</b> · <b class="${s.cls}">${s.txt}</b> · 중앙 대비 ${sg(l.kg - base - (lr[0] + lr[1]) / 2)}`; }
  if (cw != null && cw <= 40) { const tr = range(cw, c); s2 = `<i class="lg" style="border:1.5px dashed #ff9db0"></i>오늘 ${g.w}주 ${g.d}일 정상 ${kg1(base + tr[0])}~${kg1(base + tr[1])}kg · 중앙 <b>${kg1(base + (tr[0] + tr[1]) / 2)}kg</b>`; }
  $('#wst').innerHTML = `<div>${s1}</div><div>${s2 || '&nbsp;'}</div>`;
  // 무게 구성
  const p = comp(w), rest = Math.max(0, md - p.baby - p.pla - p.mat), parts = [[p.baby, '#ff9db0', '아기'], [p.pla, '#e9a23b', '태반·양수'], [p.mat, '#b9a7f0', '자궁·혈액 등'], [rest, '#8fb8ff', '엄마 순수']];
  const tot = Math.max(0.001, parts.reduce((a, b) => a + b[0], 0));
  $('#wcomp').innerHTML = `<div class="sub">${w}주 · 권장 중앙 +${kg1(md)}kg 기준</div><div class="cbar">${parts.map(q => `<i style="width:${q[0] / tot * 100}%;background:${q[1]}"></i>`).join('')}</div>
    <div class="clg">${parts.map(q => `<span><i class="lg" style="background:${q[1]}"></i>${q[2]} ${fw(q[0])}</span>`).join('')}</div>` +
    (l ? `<div class="note">${wd(l.w)} 기록 <b>${kg1(l.kg)}kg</b> − 임신 관련 ${kg1(pregKg(l.w))}kg = 순수 몸무게 <b>${kg1(l.kg - pregKg(l.w))}kg</b> (임신 전 대비 ${sg(l.kg - pregKg(l.w) - base)}kg)</div>` : '');
  $('#wtbl').innerHTML = '<tr><th>주수</th><th>권장 증가</th><th>권장 체중</th></tr>' + [4, 8, 12, 16, 20, 24, 28, 32, 36, 40].map(t => { const q = range(t, c);
    return `<tr class="${Math.abs(t - w) < 2 ? 'cur' : ''}"><td>${t}주</td><td>+${kg1(q[0])}~${kg1(q[1])}</td><td>${kg1(base + q[0])}~${kg1(base + q[1])}</td></tr>`; }).join('');
}
function setSelW(w) { w = Math.max(0, Math.min(40, Math.round(w))); if (w !== UI.selW) { UI.selW = w; updSel(); } }
function weekFromEvent(e) { const r = $('#wchart').getBoundingClientRect(), xx = (e.clientX - r.left) / (r.width / G.W); return (xx - G.pl) / (G.W - G.pl - G.pr) * 40; }
function stdChips() {
  return `<div class="pick std">${[['auto', '자동'], ...Object.keys(STDS).map(k => [k, STDS[k].name])].map(([k, n]) => `<button type="button" class="${stdSel() === k ? 'on' : ''}" data-act="std" data-id="${k}">${n}</button>`).join('')}</div><div class="note">${h(stdNote())}</div>`;
}
function weightRows(gd) {
  const ls = wlogs(), byId = new Map(ls.map(l => [l.id, l])), ws = [...S.weights].sort((a, b) => b.date.localeCompare(a.date));
  return ws.map(r => { const l = byId.get(r.id); let info = '';
    if (gd && l) { const { base, c } = gd, s = statusOf(l.kg, l.w, base, c), lr = range(Math.min(l.w, 40), c), md = base + (lr[0] + lr[1]) / 2;
      info = `<div class="sub"><b class="${s.cls}">${s.txt}</b> · 정상 ${kg1(base + lr[0])}~${kg1(base + lr[1])}kg · 중앙 대비 ${sg(l.kg - md)}</div><div class="sub">아기 약 ${fw(comp(l.w).baby)} · 순수 몸무게 ${kg1(l.kg - pregKg(l.w))}kg (${sg(l.kg - pregKg(l.w) - base)})</div>`; }
    return `<div class="row" data-act="edit" data-store="weights" data-id="${h(r.id)}"><div class="mid"><div class="nm">${fmtD(r.date)} <span class="sub">${l ? wd(l.w) : gaLabel(r.date)}</span></div>${info}${r.note ? `<div class="sub">${h(r.note)}</div>` : ''}</div>
      <div class="amt">${kg1(r.kg)}kg<small>${gd ? '임신 전 ' + sg(r.kg - gd.base) : ''}</small></div></div>`; }).join('') || '<div class="empty">오른쪽 위 ＋ 버튼으로 기록하세요</div>';
}
function vWeight() {
  const p = prof();
  if (!p.dueDate) return `<div class="card"><div class="empty">출산 예정일을 먼저 입력하세요</div><button class="btn pri" data-act="profile">기본 정보 입력</button></div>`;
  const gd = guide(), ls = wlogs();
  if (!gd) return `<div class="card"><h2>체중 가이드</h2><p class="sub">키와 임신 전 몸무게를 넣으면 주수별 권장 체중 범위, 무게 구성(아기·태반·양수 등), 기록별 상태를 보여줘요.</p>
    <button class="btn pri" data-act="profile">키·임신 전 몸무게 입력</button><button class="btn" data-act="bd-import">체중 가이드 앱 기록 가져오기</button></div>
    <div class="card"><h2>기록 <small>${S.weights.length}개</small></h2>${weightRows(null)}</div>`;
  const { base, c, bmi } = gd, g = ga(), cw = g.days >= 0 && g.days <= 294 ? g.days / 7 : null;
  if (UI.selW == null) UI.selW = cw == null ? 20 : Math.min(40, Math.round(cw));
  return `<div class="card"><h2>권장 기준</h2>${stdChips()}</div>
    <div class="tiles"><div><span>임신 전 BMI</span><b>${kg1(bmi)}</b><small>${h(c.name)}</small></div>
      <div><span>총 권장 증가</span><b>${c.total[0] === 0 ? c.total[1] + 'kg↓' : '+' + c.total[0] + '~' + c.total[1]}</b><small>kg</small></div>
      <div><span>출산 무렵 목표</span><b>${kg1(base + c.total[0])}~${kg1(base + c.total[1])}</b><small>kg</small></div></div>
    <div class="card"><div id="wsel"></div>${chartSvg(gd, ls, cw)}
      <div class="slrow"><input type="range" id="wsl" min="0" max="40" step="1" value="${UI.selW}" aria-label="주수 선택">${cw != null && cw <= 40 ? `<button class="btn sm" id="wtoday" data-act="w-today">오늘</button>` : '<span id="wtoday"></span>'}</div>
      <div id="wst" class="wst"></div>
      <div class="note">그래프를 누르거나 밀면 주수를 고를 수 있어요 · 파란 띠: 권장 범위 · 분홍 점: 내 기록</div></div>
    <div class="card"><h2>무게 구성</h2><div id="wcomp"></div><div class="note">아기: Hadlock 50백분위 · 태반·양수, 자궁·유방·혈액·체액: Hytten 값. 순수 몸무게 = 기록 체중 − 임신으로 늘어난 무게(추정)</div></div>
    <div class="card"><h2>기록 <small>${S.weights.length}개</small></h2>${weightRows(gd)}</div>
    <div class="card"><h2>주요 주수별 권장 체중</h2><table class="wtbl" id="wtbl"></table></div>
    <div class="card"><h2>요약 공유</h2><div class="btns"><button class="btn" data-act="w-text">카톡용 글</button><button class="btn" data-act="w-img">요약 이미지</button></div><div id="wimg"></div></div>
    <div class="note" style="padding:0 4px 8px">미국 IOM 기준은 2009년 이후 공식 개정이 없고, 한국은 별도 공식 기준 없이 주로 IOM을 따라요. 단태아 기준이에요. 권장 범위는 참고용이며 담당 의사 안내가 우선이에요.</div>`;
}
// 카톡용 글 요약
function summaryText() {
  const gd = guide(); if (!gd) return '';
  const { base, c, bmi } = gd, g = ga(), t = new Date(), ls = wlogs();
  const L = [`[임신 체중 요약] ${t.getFullYear()}.${t.getMonth() + 1}.${t.getDate()}${g.days >= 0 && g.days <= 294 ? ` · ${g.w}주 ${g.d}일` : ''}`];
  L.push(`임신 전 ${kg1(base)}kg · BMI ${kg1(bmi)} ${c.name} (${STDS[stdKey()].name}${stdSel() === 'auto' ? ', 상한 최소 자동' : ''} 기준)`);
  if (g.days >= 0 && g.days <= 280) { const r = range(g.days / 7, c); L.push(`오늘 정상 범위 ${kg1(base + r[0])}~${kg1(base + r[1])}kg (중앙 ${kg1(base + (r[0] + r[1]) / 2)}kg)`); }
  const l = ls[ls.length - 1];
  if (l) { const s = statusOf(l.kg, l.w, base, c), lr = range(Math.min(l.w, 40), c);
    L.push(`최근 ${wd(l.w)} ${kg1(l.kg)}kg → ${s.txt} (임신 전 ${sg(l.kg - base)}kg, 중앙 대비 ${sg(l.kg - base - (lr[0] + lr[1]) / 2)})`);
    L.push(`  └ 예상 아기 ${fw(comp(l.w).baby)} · 순수 몸무게 ${kg1(l.kg - pregKg(l.w))}kg (${sg(l.kg - pregKg(l.w) - base)})`); }
  L.push(`출산 무렵 목표 ${kg1(base + c.total[0])}~${kg1(base + c.total[1])}kg`);
  if (ls.length > 1) { L.push('', '기록'); ls.slice(-6).forEach(x => L.push(`· ${wd(x.w)} ${kg1(x.kg)}kg`)); }
  return L.join('\n');
}
// 요약 이미지 1080×1350 (카톡 공유용, baekdo와 같은 배치)
function makeSummaryImage() {
  const gd = guide(); if (!gd) return null;
  const { base, c, bmi } = gd, gg = ga(), cw = gg.days >= 0 && gg.days <= 294 ? gg.days / 7 : null, logs = wlogs();
  const W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const C = { bg: '#F3F5F8', card: '#FFFFFF', ink: '#1D2540', muted: '#6B7390', line: '#DDE2EC', band: '#D9D3F5', accent: '#5A47C9', rose: '#D9466F', ok: '#2F8F6B', bad: '#C46A17', lo: '#5A47C9', tint: '#F6F4FD', amber: '#E9A23B' };
  const SANS = '"Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",sans-serif', SERIF = 'Georgia,serif';
  const font = (sz, wt, fam) => { g.font = (wt || 400) + ' ' + sz + 'px ' + (fam || SANS); };
  const txt = (t, x, y, col, al) => { g.fillStyle = col; g.textAlign = al || 'left'; g.fillText(t, x, y); };
  const rr = (x, y, w, hh, r, col) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hh, r); g.arcTo(x + w, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fillStyle = col; g.fill(); };
  g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
  const t = new Date();
  font(64, 700, SERIF); txt('임신 체중 요약', 72, 130, C.ink);
  font(30, 500); txt(`${t.getFullYear()}.${t.getMonth() + 1}.${t.getDate()}${cw != null ? `  ·  ${gg.w}주 ${gg.d}일` : ''}  ·  ${STDS[stdKey()].name} 기준`, 72, 186, C.muted);
  rr(56, 228, W - 112, 300, 32, C.card);
  const last = logs[logs.length - 1];
  if (last) {
    const st = statusOf(last.kg, last.w, base, c), col = C[st.cls], lr = range(Math.min(last.w, 40), c);
    font(28, 500); txt('최근 기록 · ' + wd(last.w), 104, 292, C.muted);
    font(96, 700, SERIF); txt(kg1(last.kg), 104, 400, C.ink);
    const wk = g.measureText(kg1(last.kg)).width; font(40, 500); txt('kg', 114 + wk, 400, C.muted);
    font(30, 600); const pw = g.measureText(st.txt).width + 48; rr(104, 428, pw, 56, 28, col); txt(st.txt, 104 + pw / 2, 467, '#fff', 'center');
    font(28, 500); txt(`정상 ${kg1(base + lr[0])}~${kg1(base + lr[1])}kg · 중앙 대비 ${sg(last.kg - base - (lr[0] + lr[1]) / 2)}`, 104 + pw + 20, 466, C.muted);
  } else { font(34, 500); txt('아직 기록이 없어요', 104, 360, C.muted); }
  if (cw != null && cw <= 40) {
    const tr = range(cw, c);
    font(26, 500); txt('오늘 정상 범위', W - 104, 292, C.muted, 'right');
    font(44, 700); txt(`${kg1(base + tr[0])}~${kg1(base + tr[1])}`, W - 104, 350, C.accent, 'right');
    font(26, 500); txt(`중앙 ${kg1(base + (tr[0] + tr[1]) / 2)}kg`, W - 104, 392, C.muted, 'right');
  }
  const tiles = [['임신 전', kg1(base) + 'kg', `BMI ${kg1(bmi)} ${c.name}`], ['출산 무렵 상한', kg1(base + c.total[1]) + 'kg', `증가 +${c.total[1]}kg 이내`]];
  if (last) { const pure = last.kg - pregKg(last.w); tiles.push(['순수 몸무게', kg1(pure) + 'kg', '임신 전 대비 ' + sg(pure - base)]); }
  else tiles.push(['총 권장 증가', `+${c.total[0]}~${c.total[1]}`, 'kg']);
  const tw = (W - 112 - 32) / 3;
  tiles.forEach((tl, i) => { const x = 56 + i * (tw + 16); rr(x, 552, tw, 170, 24, C.card);
    font(26, 500); txt(tl[0], x + 32, 600, C.muted); font(44, 700); txt(tl[1], x + 32, 658, i === 1 ? C.rose : C.ink); font(24, 400); txt(tl[2], x + 32, 698, C.muted); });
  rr(56, 746, W - 112, 380, 32, C.card);
  const pl = 140, pr = 100, pt = 790, pb = 1070;
  let lo = base - 1, hi = base + c.total[1] + 1;
  logs.forEach(l => { lo = Math.min(lo, l.kg - 1); hi = Math.max(hi, l.kg + 1); });
  const step = hi - lo <= 12 ? 2 : hi - lo <= 24 ? 4 : 5; lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const X = w => pl + w / 40 * (W - pl - pr), Y = k => pt + (hi - k) / (hi - lo) * (pb - pt);
  g.fillStyle = C.tint; g.fillRect(X(13), pt, X(27) - X(13), pb - pt);
  font(22, 400);
  for (let k = lo; k <= hi; k += step) { g.strokeStyle = C.line; g.lineWidth = 1.5; g.beginPath(); g.moveTo(pl, Y(k)); g.lineTo(W - pr, Y(k)); g.stroke(); txt(String(k), pl - 14, Y(k) + 8, C.muted, 'right'); }
  [0, 10, 20, 30, 40].forEach(w => txt(w + '주', X(w), pb + 36, C.muted, 'center'));
  g.beginPath();
  for (let w = 0; w <= 40; w += 0.5) { const r = range(w, c); g[w ? 'lineTo' : 'moveTo'](X(w), Y(base + r[1])); }
  for (let w = 40; w >= 0; w -= 0.5) { const r = range(w, c); g.lineTo(X(w), Y(base + r[0])); }
  g.closePath(); g.fillStyle = C.band; g.fill();
  g.beginPath(); for (let w = 0; w <= 40; w += 0.5) { const r = range(w, c); g[w ? 'lineTo' : 'moveTo'](X(w), Y(base + (r[0] + r[1]) / 2)); }
  g.strokeStyle = C.accent; g.lineWidth = 4; g.stroke();
  const rE = range(40, c); font(24, 700); txt('상한 ' + kg1(base + rE[1]), W - pr, Y(base + rE[1]) - 16, C.rose, 'right');
  if (cw != null && cw <= 40) { g.setLineDash([8, 8]); g.strokeStyle = C.rose; g.lineWidth = 2.5; g.beginPath(); g.moveTo(X(cw), pt); g.lineTo(X(cw), pb); g.stroke(); g.setLineDash([]); font(22, 700); txt('오늘', X(cw) + 8, pb - 10, C.rose); }
  const pts = logs.filter(l => l.w <= 40);
  if (pts.length > 1) { g.beginPath(); pts.forEach((l, i) => g[i ? 'lineTo' : 'moveTo'](X(l.w), Y(l.kg))); g.strokeStyle = C.rose; g.lineWidth = 3; g.stroke(); }
  pts.forEach(l => { g.beginPath(); g.arc(X(l.w), Y(l.kg), 10, 0, 7); g.fillStyle = C.rose; g.fill(); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke(); });
  const cwk = cw != null ? Math.min(cw, 40) : last ? last.w : 20, p = comp(cwk), rc = range(cwk, c), mid = (rc[0] + rc[1]) / 2;
  const rest = Math.max(0, mid - p.baby - p.pla - p.mat), parts = [[p.baby, C.rose, '아기'], [p.pla, C.amber, '태반·양수'], [p.mat, C.band, '자궁·혈액 등'], [rest, C.accent, '엄마 순수']];
  const tot = parts.reduce((a, b) => a + b[0], 0) || 1;
  rr(56, 1150, W - 112, 150, 32, C.card);
  font(26, 600); txt(`무게 구성 · ${wd(cwk)} 권장 중앙 +${kg1(mid)}kg`, 96, 1198, C.ink);
  const bx = 96, bw = W - 192; let x0 = bx;
  g.save(); rr(bx, 1218, bw, 22, 11, C.line); g.clip();
  parts.forEach(pp => { const ww = pp[0] / tot * bw; g.fillStyle = pp[1]; g.fillRect(x0, 1218, ww, 22); x0 += ww; });
  g.restore();
  font(23, 500); let lx = 96;
  parts.forEach(pp => { g.fillStyle = pp[1]; g.fillRect(lx, 1258, 18, 18); const s2 = pp[2] + ' ' + fw(pp[0]); txt(s2, lx + 26, 1275, C.muted); lx += 26 + g.measureText(s2).width + 26; });
  return cv;
}
async function shareSummaryImage() {
  const cv = makeSummaryImage(); if (!cv) return;
  const blob = await new Promise(r => cv.toBlob(r, 'image/png')); if (!blob) return toast('이미지를 만들지 못했어요');
  const name = `임신체중요약_${ymd()}.png`, url = URL.createObjectURL(blob), box = $('#wimg');
  if (box) box.innerHTML = `<img src="${url}" alt="임신 체중 요약 이미지" class="wimg"><div class="note">이미지를 길게 눌러 저장하거나 공유할 수도 있어요.</div>`;
  let file = null; try { file = new File([blob], name, { type: 'image/png' }); } catch (e) { /* 미지원 */ }
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); } catch (e) { /* 취소 */ } return; }
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  toast('이미지를 저장했어요');
}
function shareSummaryText() {
  const t = summaryText(); if (!t) return;
  showSheet(`<h3>카톡용 요약</h3><div class="code">${h(t)}</div><button class="btn pri" data-a="send">보내기 (카톡 등)</button><button class="btn" data-a="copy">복사</button><button class="btn" data-a="x">닫기</button>`);
  sheet.onclick = e => { const b = e.target.closest('[data-a]')?.dataset.a;
    if (b === 'copy') copyText(t); else if (b === 'send') navigator.share ? navigator.share({ text: t }).catch(() => {}) : copyText(t); else if (b === 'x') closeSheet(); };
}

/* ---------- 체중 가이드(baekdo) 앱 기록 가져오기 ----------
   백업 파일 {app:'baekdo-weight', base, height, due, std, logs:[{w,k}]} 또는 같은 주소(joonseonhwang.github.io)의 baekdo 저장소에서 읽는다.
   주수 w → 날짜 = (체중 가이드의 예정일 − 280일) + round(w×7)일. 같은 날짜에 이미 기록이 있으면 건너뛴다. */
async function readBaekdoLocal() {
  try {
    if (indexedDB.databases && (await indexedDB.databases()).some(d => d.name === 'baekdo-weight')) {
      const st = await new Promise(res => { const r = indexedDB.open('baekdo-weight');
        r.onsuccess = () => { const d = r.result; if (!d.objectStoreNames.contains('meta')) { d.close(); return res(null); }
          const q = d.transaction('meta').objectStore('meta').get('state'); q.onsuccess = () => { d.close(); res(q.result || null); }; q.onerror = () => { d.close(); res(null); }; };
        r.onerror = () => res(null); });
      if (st && Array.isArray(st.logs)) return st;
    }
  } catch (e) { /* 읽기 실패 → localStorage 확인 */ }
  try { const s = JSON.parse(localStorage.getItem('preg-weight-v1') || 'null'); if (s && Array.isArray(s.logs)) return s; } catch (e) { /* 없음 */ }
  return null;
}
async function importBaekdo(o) {
  const due = /^\d{4}-\d{2}-\d{2}$/.test(o.due || '') ? o.due : prof().dueDate;
  if (!due) { toast('출산 예정일을 먼저 입력하세요'); return null; }
  const lmp = dnum(due) - 280, have = new Set(S.weights.map(x => x.date));
  const logs = (o.logs || []).filter(l => l && l.w >= 0 && l.w <= 42 && l.k > 20 && l.k < 300);
  let n = 0, skip = 0;
  for (const l of logs) {
    const date = fromNum(lmp + Math.round(l.w * 7));
    if (have.has(date)) { skip++; continue; }
    have.add(date); await put('weights', { id: 'bd_' + date.replace(/-/g, ''), date, kg: Math.round(l.k * 10) / 10, note: '' }); n++;
  }
  const p = prof(), add = {};
  if (!p.dueDate) add.dueDate = due;
  if (!(p.height > 100 && p.height < 230) && parseFloat(o.height) > 100 && parseFloat(o.height) < 230) add.height = parseFloat(o.height);
  if (!(p.preWeight > 0) && parseFloat(o.base) > 0) add.preWeight = parseFloat(o.base);
  if (!p.std && (o.std === 'auto' || STDS[o.std])) add.std = o.std;
  if (Object.keys(add).length) await put('profile', { ...p, ...add, id: 'main' });
  return { n, skip, prof: Object.keys(add).length, dueDiff: !!(p.dueDate && o.due && p.dueDate !== o.due) };
}
async function runBaekdoImport(o) {
  const cnt = (o.logs || []).length;
  if (!(await ask(`체중 가이드 기록 ${cnt}개를 열달노트 몸무게로 가져올까요?\n같은 날짜에 이미 기록이 있으면 건너뛰어요. 키·임신 전 몸무게가 비어 있으면 함께 채워요.`, '가져오기'))) return;
  const r = await importBaekdo(o); if (!r) return;
  toast(`몸무게 ${r.n}개를 가져왔어요${r.skip ? ` (같은 날짜 ${r.skip}개 건너뜀)` : ''}`);
  if (r.dueDiff) setTimeout(() => toast('체중 가이드의 예정일이 열달노트와 달라요. 날짜는 체중 가이드 예정일 기준으로 맞췄어요'), 2600);
  UI.rec = 'weight'; location.hash = '#/rec'; render();
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
    ${vDailySet()}
    <div class="card"><h2>부부 공유</h2><div class="sub" data-sync><i class="dot ${syncState}"></i>${SYNC_TXT[syncState]}</div>` + (sc
      ? `<button class="btn pri" data-act="sync-key">공유 키 보기 (배우자 폰에 전달)</button><button class="btn danger" data-act="sync-off">이 폰의 공유 끊기</button>`
      : `<p class="note">두 폰에서 같은 기록을 실시간으로 보려면 공유 저장소(Firebase, 무료)가 한 번 필요해요.</p>
         <button class="btn pri" data-act="sync-new">새 공유 시작 (저장소 주소 입력)</button><button class="btn" data-act="sync-join">공유 키로 연결 (배우자가 이미 시작함)</button><button class="btn" data-act="sync-help">저장소 만드는 방법</button>`) + `</div>
    <div class="card"><h2>백업</h2><div class="sub">마지막 백업: ${lb ? new Date(lb).toLocaleDateString('ko-KR') : '없음'}</div>
      <button class="btn pri" data-act="export">백업 파일 내보내기</button><button class="btn" data-act="share">백업 파일 공유 (카톡 등)</button><button class="btn" data-act="import">백업 파일 불러오기</button>
      <button class="btn" data-act="bd-import">체중 가이드 앱 기록 가져오기</button><div class="note">이 폰에 설치된 '주수별 체중 가이드' 앱의 기록을 몸무게로 옮겨요. 그 앱의 백업 파일(체중기록_백업_….json)은 '백업 파일 불러오기'로 넣어도 돼요.</div></div>
    <div class="card"><h2>저장공간</h2><div class="sub" id="persist">확인 중…</div><button class="btn" data-act="persist">저장공간 보호 요청</button></div>
    <div class="card"><h2>데이터</h2><div class="sub">몸무게 ${S.weights.length} · 일정 ${S.events.length} · 일기 ${S.diary.length} · 태동 ${S.kicks.length} · 진통 ${S.contractions.length}</div>
      <button class="btn danger" data-act="wipe">이 폰의 기록 전체 삭제</button></div>
    <div class="card"><h2>정보 출처</h2><ul class="plain sub">
      <li>태아 발달(4~29주): MSD 매뉴얼 일반인용 「태아 발달 단계」</li><li>진료 간격·임신성 당뇨 검사·예방접종·엽산: MSD 매뉴얼 일반인용 「임신 중 치료」</li>
      <li>권장 체중 증가 기준: 일본산부인과학회 2021 · 중국 국가표준 2022 · 미국 IOM 2009 (기준값·계산 방식은 '주수별 체중 가이드' 앱 v1.3.1에서 옮김)</li><li>태아 체중: Hadlock 50백분위 · 태반·양수, 자궁·유방·혈액·체액 증가량: Hytten</li><li>임신성 당뇨 검사 시기: 서울아산병원 「임신성 당뇨검사」</li>
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
  view.innerHTML = fn(); if (r === 'rec' && UI.rec === 'weight') updSel(); scrollTo(0, y);
  if (q) { const el = $('#q'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  if (r === 'week') { const c = $('#wchips .on'); if (c) $('#wchips').scrollLeft = c.offsetLeft - $('#wchips').clientWidth / 2 + c.clientWidth / 2; }
  if (r === 'set' && S.meta.notify?.push === 'on') pushSrvCheck();
  if (r === 'set' && navigator.storage?.persisted) navigator.storage.persisted().then(p => { const el = $('#persist'); if (el) el.textContent = p ? '보호됨 — 브라우저가 임의로 지우지 않아요' : '보호 안 됨 — 저장공간이 부족하면 지워질 수 있어요'; });
}
window.addEventListener('hashchange', () => { scrollTo(0, 0); render(); });
setInterval(() => document.querySelectorAll('[data-el]').forEach(el => { el.textContent = mmss(Date.now() - Number(el.dataset.el)); }), 1000);

/* ---------- 이벤트 ---------- */
$('#topact').addEventListener('click', e => {
  const t = e.target.closest('[data-top]')?.dataset.top;
  if (t === 'w') editWeight(); else if (t === 'd') editDiary(); else if (t === 'e') editEvent(); else if (t === 'c') editCheck();
});
view.addEventListener('input', e => { if (e.target.id === 'q') { UI.q = e.target.value; $('#dlist').innerHTML = diaryList(); } else if (e.target.id === 'wsl') setSelW(Number(e.target.value)); });
// 그래프를 누르거나 옆으로 밀어 주수 선택 (세로로 밀면 화면 스크롤)
let wdrag = false;
view.addEventListener('pointerdown', e => { if (!e.target.closest('#wchart')) return; wdrag = true; setSelW(weekFromEvent(e)); });
view.addEventListener('pointermove', e => { if (wdrag && $('#wchart')) setSelW(weekFromEvent(e)); });
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => view.addEventListener(t, () => { wdrag = false; }));
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
  if (a === 'daily') { await toggleDaily(id); return render(); }
  if (a === 'daily-all') { const on = await slotAll(id); toast(`${SLOT_NAME[id]} 항목을 ${on ? '모두 체크했어요' : '모두 해제했어요'}`); return render(); }
  if (a === 'daily-set') { location.hash = '#/set'; setTimeout(() => $('#dailyset')?.scrollIntoView({ block: 'start' }), 50); return; }
  if (a === 'daily-edit') return editDaily(dailyItems().find(x => x.id === id));
  if (a === 'daily-add') return editDaily(null);
  if (a === 'daily-time') return editDailyTime();
  if (a === 'daily-on') { const on = { ...dailyOn(), [id]: !dailyOn()[id] }; await saveDaily(dailyItems(), { dailyOn: on }); toast(`${SLOT_NAME[id]} 알림을 ${on[id] ? '켰어요' : '껐어요'}`); return render(); }
  if (a === 'daily-ics') return shareIcs();
  if (a === 'notify-on') return enableNotify();
  if (a === 'notify-test') return testNotify();
  if (a === 'notify-off') { await periodicOff(); await pushOff(); await setMeta('notify', { on: false }); toast('이 폰의 알림을 껐어요'); return render(); }
  if (a === 'ev-toggle') { const r = S.events.find(x => x.id === id); await put('events', { ...r, done: !r.done }); return render(); }
  if (a === 'edit') { const r = S[el.dataset.store].find(x => x.id === id); return r && EDIT[el.dataset.store](r); }
  if (a === 'profile') return editProfile();
  if (a === 'week') { UI.week = Number(id); scrollTo(0, 0); return render(); }
  if (a === 'rec') { UI.rec = id; return render(); }
  if (a === 'cat') { UI.cat = id; return render(); }
  if (a === 'past') { UI.past = !UI.past; return render(); }
  if (a === 'go-cal') { location.hash = '#/cal'; return; }
  if (a === 'go-weight') { UI.rec = 'weight'; location.hash = '#/rec'; return render(); }
  if (a === 'std') { await put('profile', { ...prof(), id: 'main', std: id }); return render(); }
  if (a === 'w-today') { const g = ga(); return setSelW(g.days / 7); }
  if (a === 'w-text') return shareSummaryText();
  if (a === 'w-img') return shareSummaryImage();
  if (a === 'bd-import') { const o = await readBaekdoLocal(); if (!o || !o.logs.length) return toast('이 폰의 체중 가이드 앱에 기록이 없어요. 체중 가이드 백업 파일은 "백업 파일 불러오기"로 넣을 수 있어요'); return runBaekdoImport(o); }
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (syncCfg() && syncState !== 'on') syncStart(); render(); } notifyCheck(); });
setInterval(() => notifyCheck(), 60000);

/* ---------- 시작 ---------- */
(async () => {
  db = await openDB(); await loadAll();
  if (!S.meta.firstUse) await setMeta('firstUse', Date.now());
  render();
  if (syncCfg()) syncStart();
  if ('serviceWorker' in navigator) {
    // 새 버전이 배포되면 바로 받아서 한 번만 다시 연다(옛 화면이 남는 문제 방지)
    const hadCtl = !!navigator.serviceWorker.controller; let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadCtl && !reloaded) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {});
  }
  if (S.meta.notify?.on && 'Notification' in window && Notification.permission === 'granted')
    Promise.all([within(periodicOn(), 10000, S.meta.notify.bg), within(pushOn(), 15000, S.meta.notify.push)]).then(([bg, push]) => { if (bg !== S.meta.notify.bg || push !== S.meta.notify.push) setMeta('notify', { ...S.meta.notify, bg, push }).then(() => route() === 'set' && render()); });
  setTimeout(notifyCheck, 1500);
  window.X = { dailyOn, within, S, R, UI, guide, range, statusOf, comp, pregKg, wlogs, stdKey, autoKey, summaryText, makeSummaryImage, importBaekdo, readBaekdoLocal, importData, clearAll, backupObj, loadAll, render, match, put, del, setMeta, ga, syncConnect, syncStart, syncKey, parseKey, get syncState() { return syncState; }, dailyItems, dailyTime, dailyMissing, toggleDaily, slotAll, ddDone, dailyIcs, notifyCheck, pushOn, pushOff, VAPID_PUBLIC, APP_VERSION };
})();
