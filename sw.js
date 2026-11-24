// 열달노트 서비스워커 — 출처: [Claude] 작성
// 배포할 때마다 CACHE 이름과 app.js의 APP_VERSION을 함께 올린다.
const CACHE = 'yeoldal-note-v1.2.1';
const FILES = ['./', 'index.html', 'styles.css', 'data.js', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('yeoldal-note-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  // 다른 주소(부부 공유용 Firebase 등)는 건드리지 않는다
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // 화면 요청: 네트워크 우선, 실패하면 캐시된 index.html
    e.respondWith(fetch(req).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put('index.html', copy));
      return r;
    }).catch(() => caches.match('index.html')));
    return;
  }
  // 정적 파일: 캐시 우선 + 백그라운드 갱신
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return r;
    }).catch(() => hit);
    return hit || net;
  }));
});

/* ---------- 매일 체크리스트 알림 (app.js의 '매일 체크리스트 + 알림'과 같은 규칙) ----------
   폰(크롬)이 가끔 앱을 깨울 때(periodicsync) 알림 시각이 지났는데 체크 안 한 항목이 있으면 알린다. 하루 한 번(아침·저녁 각각). */
const DEF_ITEMS = [['dvitd', '비타민D', 'am'], ['dfolic', '엽산', 'am'], ['domega3', '오메가3', 'am'], ['dmag', '마그네슘', 'am'],
  ['dstretch', '튼살크림', 'pm'], ['dwhite', '미백크림', 'pm'], ['dneck', '목크림', 'pm'], ['diron', '철분제', 'pm'], ['dfoot', '발 크림', 'pm']]
  .map(([id, name, slot]) => ({ id, name, slot }));   // data.js의 DAILY_DEFAULT와 같게 유지
const DEF_TIME = { am: '10:00', pm: '21:30' }, SLOT = { am: '아침', pm: '저녁' };
const p2 = n => String(n).padStart(2, '0');
function openDb() {
  return new Promise(res => {
    const r = indexedDB.open('yeoldal-note');
    // 앱을 아직 한 번도 안 연 경우: 빈 DB를 만들지 않도록 취소
    r.onupgradeneeded = () => r.transaction.abort();
    r.onsuccess = () => res(r.result); r.onerror = () => res(null);
  });
}
const req = q => new Promise(res => { q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
async function checkDaily() {
  const db = await openDb(); if (!db) return;
  try {
    const t = db.transaction(['profile', 'checks', 'meta']);
    const [prof, notify, sentRec] = await Promise.all([req(t.objectStore('profile').get('main')), req(t.objectStore('meta').get('notify')), req(t.objectStore('meta').get('notified'))]);
    if (!notify?.value?.on || !prof || (!prof.dueDate && !Array.isArray(prof.daily))) return;
    const now = new Date(), date = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`, hm = `${p2(now.getHours())}:${p2(now.getMinutes())}`;
    const items = Array.isArray(prof.daily) ? prof.daily : DEF_ITEMS, time = { ...DEF_TIME, ...(prof.dailyTime || {}) };
    const recs = await req(db.transaction('checks').objectStore('checks').getAll(IDBKeyRange.bound(`dd-${date}-`, `dd-${date}-￿`))) || [];
    const done = new Set(recs.filter(r => r.done && !r.deleted).map(r => r.item));
    const sent = sentRec?.value || {};
    let changed = false;
    for (const slot of ['am', 'pm']) {
      if (hm < time[slot] || sent[`${date}-${slot}`]) continue;
      const miss = items.filter(i => i.slot === slot && !done.has(i.id)); if (!miss.length) continue;
      await self.registration.showNotification(`열달노트 · ${SLOT[slot]} 챙길 것`, { body: miss.map(i => i.name).join(', ') + ' — 아직 체크 안 했어요', tag: 'daily-' + slot, icon: 'icons/icon-192.png', data: { url: './#/home' } });
      sent[`${date}-${slot}`] = Date.now(); changed = true;
    }
    if (changed) await new Promise(res => { const w = db.transaction('meta', 'readwrite'); w.objectStore('meta').put({ key: 'notified', value: sent }); w.oncomplete = w.onerror = () => res(); });
  } finally { db.close(); }
}
self.addEventListener('periodicsync', e => { if (e.tag === 'daily-check') e.waitUntil(checkDaily()); });

/* ---------- 정확한 시각 알림 (집 PC의 yeoldal_push.py가 보낸 푸시) ----------
   보낸 내용: {type:'daily', date, slot, items:[{id,name}]} 또는 {type:'test'}.
   폰에 남은 기록으로 한 번 더 확인해서, 그사이 체크한 항목은 빼고 알린다. */
async function onPush(d) {
  const notif = (title, body, tag) => self.registration.showNotification(title, { body, tag, icon: 'icons/icon-192.png', data: { url: './#/home' } });
  if (d.type === 'test') return notif('열달노트 · 테스트 알림', '앱을 꺼 둬도 정한 시각에 이렇게 알림이 와요', 'daily-test');
  if (d.type !== 'daily' || !['am', 'pm'].includes(d.slot) || !Array.isArray(d.items)) return;
  let items = d.items, db = null, sent = null;
  try {
    db = await openDb();
    if (db) {
      const t = db.transaction(['checks', 'meta']);
      const [recs, notify, sentRec] = await Promise.all([req(t.objectStore('checks').getAll(IDBKeyRange.bound(`dd-${d.date}-`, `dd-${d.date}-￿`))), req(t.objectStore('meta').get('notify')), req(t.objectStore('meta').get('notified'))]);
      if (notify?.value && !notify.value.on) return;   // 이 폰에서 알림을 끔
      const done = new Set((recs || []).filter(r => r.done && !r.deleted).map(r => r.item));
      items = items.filter(i => !done.has(i.id));
      sent = sentRec?.value || {};
    }
    if (!items.length) return;   // 그사이 다 체크함
    await notif(`열달노트 · ${SLOT[d.slot]} 챙길 것`, items.map(i => i.name).join(', ') + ' — 아직 체크 안 했어요', 'daily-' + d.slot);
    if (db && sent) { sent[`${d.date}-${d.slot}`] = Date.now(); await new Promise(res => { const w = db.transaction('meta', 'readwrite'); w.objectStore('meta').put({ key: 'notified', value: sent }); w.oncomplete = w.onerror = () => res(); }); }
  } finally { db?.close(); }
}
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { /* 형식 오류 */ }
  e.waitUntil(onPush(d));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './#/home', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => x.url.startsWith(self.registration.scope));
    return c ? c.navigate(url).then(w => (w || c).focus()).catch(() => c.focus()) : self.clients.openWindow(url);
  }));
});
