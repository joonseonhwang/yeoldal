// 열달노트 서비스워커 — 출처: [Claude] 작성
// 배포할 때마다 CACHE 이름과 app.js의 APP_VERSION을 함께 올린다.
const CACHE = 'yeoldal-note-v1.1.1';
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
