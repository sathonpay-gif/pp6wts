/**
 * Cloudflare Pages Function
 * รับคำขอ POST ที่ /api แล้วส่งต่อไปยัง Google Apps Script Web App (doPost)
 * รูปแบบ body ที่ frontend (app.js) ส่งมา: {"fn":"ชื่อฟังก์ชัน","args":[...]}
 *
 * ตั้งค่าที่ต้องทำใน Cloudflare Pages:
 *   Settings > Environment variables > เพิ่มตัวแปรชื่อ APPS_SCRIPT_URL
 *   ค่า = URL ของ Apps Script Web App (ที่ deploy จากไฟล์ Code.gs) เช่น
 *   https://script.google.com/macros/s/XXXXXXXXXXXXXXXX/exec
 *
 * เรื่องแคช:
 *   เฉพาะฟังก์ชัน infrastructure ที่ปลอดภัยต่อการ cache เท่านั้นที่ถูกแคชไว้ที่
 *   Cloudflare Edge (20 วินาที) ส่วนข้อมูลธุรกรรม/คะแนน/แดชบอร์ดไม่ cache เพื่อ
 *   ป้องกันข้อมูลเก่าค้างหลังบันทึก แม้จะรีเฟรชหน้าเว็บหรือเปิดจากหลายอุปกรณ์
 */

const CACHEABLE_FNS = new Set([
  'apiPing',
  'getSetupStatus'
]);
const CACHE_TTL_SEC = 20;

export async function onRequestPost(context) {
  const { request, env } = context;
  const APPS_SCRIPT_URL = env.APPS_SCRIPT_URL;

  if (!APPS_SCRIPT_URL) {
    return jsonResponse({ ok: false, error: 'ยังไม่ได้ตั้งค่า APPS_SCRIPT_URL ใน Cloudflare Pages' }, 500);
  }

  const bodyText = await request.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid request body' }, 400);
  }

  const cacheable = CACHEABLE_FNS.has(body.fn);
  const cache = caches.default;
  let cacheKey = null;

  if (cacheable) {
    // Cache API เก็บได้เฉพาะ response ของ GET เท่านั้น จึงสร้าง "กุญแจแคช" เป็น
    // URL ปลอมที่มี hash ของเนื้อหาคำขอ (fn + args + token) ต่อท้าย แต่ยังคง
    // ยิงคำขอจริงแบบ POST ไปยัง Apps Script เหมือนเดิม
    const hash = await sha256Hex(bodyText);
    const keyUrl = new URL(request.url);
    keyUrl.searchParams.set('k', hash);
    cacheKey = new Request(keyUrl.toString(), { method: 'GET' });

    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  // FIX: บางครั้ง request ที่ยิงไป script.google.com จาก edge ของ Cloudflare (โดยเฉพาะ
  // edge ในยุโรป) จะถูก Google รีไดเรกต์ไปโผล่ที่หน้า "ขอความยินยอมเรื่องคุกกี้"
  // (consent.google.com — window['ppConfig'] = {productName: 'ConsentUi', ...}) แทนที่
  // จะถึง doPost จริง แล้วหน้านั้นเองก็ตอบกลับมาไม่ใช่ JSON (เช่น 404) ทำให้ผู้ใช้เจอ error
  // ทั้งที่ Code.gs ไม่มีปัญหาอะไรเลย — เกิดแบบสุ่ม/เป็นครั้งคราว ไม่ใช่ทุกครั้ง
  // แก้สองทาง: (1) แนบคุกกี้ SOCS จำลองว่ายอมรับ consent ไว้แล้ว ลดโอกาสโดนหน้านี้ตั้งแต่ต้น
  // (2) ถ้ายังโดนอยู่ ให้ลองยิงซ้ำอีกครั้งก่อนฟันธงว่า error เพราะปัญหานี้มักหายไปเองในครั้งถัดไป
  let upstream, trace, resultText;
  for (let attempt = 0; attempt < 2; attempt++) {
    ({ res: upstream, trace } = await postFollowingRedirects_(APPS_SCRIPT_URL, bodyText));
    resultText = await upstream.text();
    try { JSON.parse(resultText); break; } // ได้ JSON แล้ว ไม่ต้องลองซ้ำ
    catch (e) {
      if (attempt === 1) {
        const snippet = resultText.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
        return jsonResponse({ ok: false, error: 'Apps Script ตอบกลับไม่ใช่ JSON [' + (trace || []).join(' ; ') + ']: ' + snippet }, 502);
      }
      // ลองใหม่อีกครั้งหนึ่งแบบเงียบๆ ก่อนค่อยแจ้ง error จริง
    }
  }

  const response = new Response(resultText, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheable ? `public, max-age=${CACHE_TTL_SEC}` : 'no-store'
    }
  });

  if (cacheable && upstream.status === 200) {
    context.waitUntil(cache.put(cacheKey, response.clone()));
  }

  return response;
}

// เผื่อมีใครเปิด /api ด้วย GET ตรงๆ (เช่นทดสอบ) ให้ตอบข้อความอธิบายแทนที่จะ error เฉยๆ
export async function onRequestGet() {
  return jsonResponse({ ok: false, error: 'ต้องเรียกด้วย POST พร้อม {fn, args} เท่านั้น' }, 405);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Apps Script exec URL มักตอบกลับด้วย HTTP 302 ไปยัง URL เนื้อหาจริง
// ถ้าใช้ redirect:'follow' ปกติ ตัว fetch จะเปลี่ยน POST เป็น GET ให้เองตาม
// spec (ทำให้ body หาย และไปโดน doGet แทน doPost) ฟังก์ชันนี้จึงตามลิงก์เอง
// พร้อมคงเมธอด POST และ body เดิมไว้ทุกครั้งที่เจอ redirect
async function postFollowingRedirects_(url, bodyText, maxHops = 6) {
  let currentUrl = url;
  let method = 'POST';
  let body = bodyText;
  const trace = [];
  const short = u => { try { const x = new URL(u); return x.hostname + x.pathname.replace(/\/s\/[^/]+/, '/s/…').slice(0, 40); } catch (e) { return String(u).slice(0, 40); } };
  // FIX: แนบคุกกี้ SOCS (คุกกี้ที่ Google ใช้เก็บว่าเคยกด "ยอมรับ" คุกกี้แล้ว) ไปกับทุก
  // request เพื่อลดโอกาสที่ Google จะแทรกหน้า consent.google.com เข้ามาแทนผลลัพธ์จริง
  // ค่านี้เป็นค่าที่ใช้กันทั่วไปเวลา fetch จากฝั่งเซิร์ฟเวอร์ (ไม่มี browser/session)
  const CONSENT_COOKIE = 'SOCS=CAESHAgBEhJnd3NfMjAyNDAxMDEtMF9SQzIaAmVuIAEaBgiA_LyaBg';
  for (let i = 0; i < maxHops; i++) {
    const init = { method, redirect: 'manual', headers: { 'Cookie': CONSENT_COOKIE } };
    if (method === 'POST') { init.headers['Content-Type'] = 'application/json'; init.body = body; }
    const res = await fetch(currentUrl, init);
    trace.push(method + ' ' + short(currentUrl) + ' → ' + res.status);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) return { res, finalUrl: currentUrl, trace };
      currentUrl = new URL(location, currentUrl).toString();
      // - ถ้าปลายทางเป็น script.google.com (เช่น /a/macros/<โดเมน>/s/.../exec ของบัญชี Workspace) ต้องคง POST + body เดิม
      //   ไม่งั้นจะไปตก doGet แล้วได้หน้า HTML กลับมา
      // - ถ้าปลายทางเป็น *.googleusercontent.com นั่นคือลิงก์เก็บ "ผลลัพธ์" ที่ doPost ทำเสร็จแล้ว ต้องเรียกด้วย GET
      const host = new URL(currentUrl).hostname;
      if (host.endsWith('googleusercontent.com')) { method = 'GET'; body = undefined; }
      continue;
    }
    return { res, finalUrl: currentUrl, trace };
  }
  throw new Error('redirect ไปเรื่อยๆ เกิน ' + maxHops + ' ครั้ง');
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
