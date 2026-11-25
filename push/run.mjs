// 열달노트 예비 발송기 실행 — GitHub 예약 실행(.github/workflows/push.yml)이 15분마다 부른다.
// 출처: [Claude] 2026-11-25 작성.
// 1) 바로 한 번 확인(테스트 요청·놓친 알림 처리)
// 2) 앞으로 AHEAD 안에 켜진 알림 시각이 있으면 그 시각 + LAG까지 기다렸다가 다시 확인하고 끝낸다.
//    LAG(90초): 집 PC가 켜져 있으면 PC가 먼저 보내게 양보 → 공유 저장소 pushsrv/sent 표시를 보고 중복 없이 건너뜀.
// 비밀 값은 환경 변수(저장소 Secrets)로만 받는다: DB_URL, ROOM_CODE, VAPID_JWK. 기록에는 긴 ID를 앞 4글자만 남긴다.
import { tick, DEF_TIME, DEF_ON, KST } from './worker.mjs';

const LAG = +(process.env.LAG_MS || 90e3), AHEAD = +(process.env.AHEAD_MS || 20 * 60e3);
const env = process.env;
for (const k of ['DB_URL', 'ROOM_CODE', 'VAPID_JWK']) if (!env[k]) { console.log('설정 없음:', k); process.exit(1); }
const log = s => console.log(new Date().toISOString().slice(11, 19), String(s).split(env.ROOM_CODE).join('***').replace(/[A-Za-z0-9_-]{16,}/g, m => m.slice(0, 4) + '…'));
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const root = `${env.DB_URL.replace(/\/+$/, '')}/rooms/${env.ROOM_CODE}`;
const get = async p => { const r = await fetch(`${root}/${p}.json`); if (!r.ok) throw new Error(`DB GET ${r.status}`); return r.json(); };

async function once() { const r = await tick(env, Date.now() - LAG, log); log(`확인 완료 (폰 ${r.subs}대)`); }

// 앞으로 기다릴 알림 시각(밀리초) 목록
async function upcoming() {
  const [prof, sent] = await Promise.all([get('profile/main'), get('pushsrv/sent')]);
  if (!prof || prof.deleted) return [];
  const tm = { ...DEF_TIME, ...(prof.dailyTime || {}) }, on = { ...DEF_ON, ...(prof.dailyOn || {}) };
  const now = Date.now(), out = [];
  for (const dayOff of [0, 1]) {
    const k = new Date(now + KST * 60000 + dayOff * 864e5);
    const date = k.toISOString().slice(0, 10);
    const mid = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - KST * 60000;   // 그날 한국 0시
    for (const slot of ['am', 'pm']) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(tm[slot] || '');
      if (!on[slot] || !m || (sent && sent[`${date}-${slot}`])) continue;
      const t = mid + (+m[1] * 60 + +m[2]) * 60000 + LAG + 5000;
      if (t > now && t - now <= AHEAD) out.push(t);
    }
  }
  return out.sort((a, b) => a - b);
}

try {
  await once();
  for (const t of await upcoming()) {
    log(`알림 시각까지 ${Math.round((t - Date.now()) / 1000)}초 기다림`);
    await sleep(t - Date.now());
    await once();
  }
} catch (e) { log('오류: ' + (e && e.message)); process.exit(1); }
