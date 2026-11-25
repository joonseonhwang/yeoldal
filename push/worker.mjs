// 열달노트 '정확한 시각 알림' 예비 발송기 — GitHub 예약 실행(push/run.mjs)에서 돌린다. 집 PC(yeoldal_push.py)가 꺼져 있어도 알림이 오게 한다.
// 출처: [Claude] 2026-11-25 작성. yeoldal_push.py(v1.2.4)의 동작을 그대로 옮김. 웹 푸시 암호화는 RFC 8291(aes128gcm)·RFC 8292(VAPID) 방식.
// 비밀 값(코드에 넣지 않음, Worker 비밀 설정에만): DB_URL(Firebase 주소), ROOM_CODE(공유 방 코드), VAPID_JWK(VAPID 비밀 열쇠 JWK JSON)
// 보낸 기록은 공유 저장소 rooms/<코드>/pushsrv/sent/<날짜-슬롯> 에 남겨 두 번 보내지 않는다(노트북판과 같이 돌아도 중복 없음).
export const VER = '1.3.0-cloud';
// 2026-11-25: Cloudflare·Deno 가입이 막혀 GitHub 예약 실행(push/run.mjs)에서 돌린다. 살아 있음 표시는 노트북판(at)과 따로 cloudAt에 남긴다.
const DEF_ITEMS = [['dvitd', '비타민D', 'am'], ['dfolic', '엽산', 'am'], ['domega3', '오메가3', 'am'], ['dmag', '마그네슘', 'am'],
  ['dstretch', '튼살크림', 'pm'], ['dwhite', '미백크림', 'pm'], ['dneck', '목크림', 'pm'], ['diron', '철분제', 'pm'], ['dfoot', '발 크림', 'pm']]
  .map(([id, name, slot]) => ({ id, name, slot }));   // 앱 data.js DAILY_DEFAULT와 같게
export const DEF_TIME = { am: '10:00', pm: '21:30' };
export const DEF_ON = { am: false, pm: true };                // 앱 data.js DAILY_ON과 같게
const WINDOW_MIN = 180;                                // 시각 지나고 3시간 안에만 보냄
export const KST = 9 * 60;                                    // 한국 시간 = UTC+9 (서머타임 없음)
const SUBJ = 'mailto:joonseonhwang@users.noreply.github.com';

const te = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const pad = n => String(n).padStart(2, '0');

// ---------- 웹 푸시 ----------
async function vapidHeader(env, endpoint) {
  const jwk = JSON.parse(env.VAPID_JWK);
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const u = new URL(endpoint);
  const h = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const c = b64u(te.encode(JSON.stringify({ aud: `${u.protocol}//${u.host}`, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJ })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${h}.${c}`));
  const pub = b64u(cat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y)));
  return `vapid t=${h}.${c}.${b64u(sig)}, k=${pub}`;
}

async function hkdf(salt, ikm, info, bits) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bits));
}

export async function encrypt(sub, text) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(te.encode('WebPush: info\0'), uaPub, asPub), 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 96);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, cat(te.encode(text), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPub.length]), asPub, ct);   // rs=4096
}

async function send(env, db, dev, sub, payload, log) {
  try {
    const r = await fetch(sub.endpoint, { method: 'POST', body: await encrypt(sub, JSON.stringify(payload)), headers: {
      Authorization: await vapidHeader(env, sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high' } });
    if (r.ok) return 'ok';
    if (r.status === 404 || r.status === 410) { await db('DELETE', `push/${dev}`).catch(() => {}); log(`구독 만료로 삭제: ${dev} (${r.status})`); return 'gone'; }
    log(`보내기 실패 ${dev}: ${r.status} ${(await r.text()).slice(0, 200)}`); return 'fail';
  } catch (e) { log(`보내기 실패 ${dev}: ${e && e.message}`); return 'fail'; }
}

// ---------- 한 번 확인 ----------
export async function tick(env, nowMs = Date.now(), log = console.log) {
  const root = `${env.DB_URL.replace(/\/+$/, '')}/rooms/${env.ROOM_CODE}`;
  const db = async (m, path, body, q) => {
    const r = await fetch(`${root}/${path}.json${q || ''}`, { method: m, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error(`DB ${m} ${path.split('/')[0]} ${r.status}`);
    return r.json();
  };
  const [prof, subsRaw, srv] = await Promise.all([db('GET', 'profile/main'), db('GET', 'push'), db('GET', 'pushsrv')]);
  const subs = subsRaw && typeof subsRaw === 'object' ? subsRaw : {};
  const sent = (srv && srv.sent) || {};
  const valid = v => v && typeof v === 'object' && v.sub && v.sub.endpoint;

  // 1) 테스트 요청
  for (const [dev, v] of Object.entries(subs)) {
    if (v && typeof v === 'object' && (v.testAt || 0) > (v.testDone || 0)) {
      const r = valid(v) ? await send(env, db, dev, v.sub, { type: 'test' }, log) : 'fail';
      if (r !== 'gone') await db('PATCH', `push/${dev}`, { testDone: v.testAt, testResult: r });
      log(`테스트 알림 ${dev}: ${r}`);
    }
  }

  // 2) 아침·저녁 알림 (한국 시각 기준)
  const k = new Date(nowMs + KST * 60000);
  const date = `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())}`, mins = k.getUTCHours() * 60 + k.getUTCMinutes();
  const patch = { cloudAt: Date.now(), cloudVer: VER };
  if (prof && !prof.deleted && Object.keys(subs).length) {
    const items = Array.isArray(prof.daily) ? prof.daily : DEF_ITEMS;
    const tm = { ...DEF_TIME, ...(prof.dailyTime || {}) }, on = { ...DEF_ON, ...(prof.dailyOn || {}) };
    for (const slot of ['am', 'pm']) {
      const key = `${date}-${slot}`;
      if (sent[key] || !on[slot]) continue;
      const m = /^(\d{1,2}):(\d{2})$/.exec(tm[slot] || ''); if (!m) continue;
      const at = +m[1] * 60 + +m[2];
      if (!(mins >= at && mins < at + WINDOW_MIN)) continue;
      const q = `?orderBy=${encodeURIComponent('"$key"')}&startAt=${encodeURIComponent(`"dd-${date}-"`)}&endAt=${encodeURIComponent(`"dd-${date}-"`)}`;
      const recs = (await db('GET', 'checks', undefined, q)) || {};
      const done = new Set(Object.entries(recs).filter(([id, r]) => id.startsWith(`dd-${date}-`) && r && r.done && !r.deleted).map(([, r]) => r.item));
      const miss = items.filter(i => i && i.slot === slot && !done.has(i.id)).map(i => ({ id: i.id, name: i.name }));
      const res = {};
      if (miss.length) {
        // 먼저 '보냄' 표시를 남겨 다음 실행과 겹쳐도 두 번 안 보냄
        await db('PATCH', 'pushsrv/sent', { [key]: { at: nowMs, miss: miss.length, by: 'cloud' } });
        for (const [dev, v] of Object.entries(subs)) if (valid(v)) res[dev] = await send(env, db, dev, v.sub, { type: 'daily', date, slot, items: miss }, log);
        log(`${key} 알림 보냄 (${miss.length}개 안 함): ${JSON.stringify(res)}`);
      } else log(`${key} 다 체크함 — 안 보냄`);
      patch[`sent/${key}`] = { at: nowMs, miss: miss.length, res, by: 'cloud' };
    }
  }
  // 14일 지난 보낸 기록 정리
  const cut = new Date(nowMs + KST * 60000 - 14 * 864e5).toISOString().slice(0, 10);
  for (const key of Object.keys(sent)) if (key.slice(0, 10) < cut) patch[`sent/${key}`] = null;
  // 3) 살아 있음 표시
  await db('PATCH', 'pushsrv', patch);
  return { subs: Object.keys(subs).length };
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env, event.scheduledTime)); },
  async fetch() { return new Response('yeoldal push ' + VER, { headers: { 'content-type': 'text/plain; charset=utf-8' } }); },
};
