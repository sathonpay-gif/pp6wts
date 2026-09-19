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
 *   เฉพาะฟังก์ชันใน CACHEABLE_FNS เท่านั้นที่จะถูกแคชไว้ที่ Cloudflare Edge
 *   (20 วินาที) เพื่อความเร็ว โดยเลือกเฉพาะฟังก์ชันที่ "อ่านอย่างเดียว" และ
 *   ไม่ใช่ข้อมูลที่หน้าเว็บโหลดซ้ำทันทีหลังกดบันทึก (ตรวจสอบจาก app.js แล้วว่า
 *   getClasses/getSubjects/getStudentsByClass/getScoreEntry ฯลฯ ถูกเรียกซ้ำทันที
 *   หลัง save จึงไม่ใส่ในแคช เพื่อไม่ให้เห็นข้อมูลเก่าค้างหลังบันทึก)
 *   ฟังก์ชันที่ไม่อยู่ในลิสต์นี้จะยิงไปหา Apps Script สดทุกครั้งเหมือนเดิม
 */

const CACHEABLE_FNS = new Set([
  'apiPing',
  'getSetupStatus',
  'bootstrap',
  'getDashboard',
  'getPP6Data',
  'getClassSummaryData',
  'getClassActivitySummaryData',
  'getGradeHistory'
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

  const { res: upstream, finalUrl, trace } = await postFollowingRedirects_(APPS_SCRIPT_URL, bodyText);
  const resultText = await upstream.text();
  try { JSON.parse(resultText); }
  catch (e) {
    const snippet = resultText.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    return jsonResponse({ ok: false, error: 'Apps Script ตอบกลับไม่ใช่ JSON [' + (trace || []).join(' ; ') + ']: ' + snippet }, 502);
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
  for (let i = 0; i < maxHops; i++) {
    const init = { method, redirect: 'manual' };
    if (method === 'POST') { init.headers = { 'Content-Type': 'application/json' }; init.body = body; }
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
