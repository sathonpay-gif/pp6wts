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

  const upstream = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bodyText,
    redirect: 'follow'
  });
  const resultText = await upstream.text();

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

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
