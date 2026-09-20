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

// PERF UPDATE: ตรวจสอบ app.js ทั้งไฟล์แล้วพบว่าฟังก์ชัน "get list" เกือบทุกตัว
// (getSubjects, getStudentsByClass, getUsers, getClasses, getActivities,
// getAllTeachingAssignments, getTeachingAvailability, getActivityAssignments,
// getAcademicPeriods, getClubCandidates ฯลฯ) ถูกเรียกซ้ำทันทีหลัง save/delete
// ของหน้าเดียวกันเสมอ (pattern: await call('saveXxx',...); await renderXxx($('page')))
// จึง "ห้ามแคช" เด็ดขาด — ถ้าแคชจะทำให้ผู้ใช้เห็นข้อมูลเก่าค้างหลังกดบันทึก
// เหมือนบันทึกไม่ติด รายการเดิม 8 ตัวด้านล่างถูกเช็กแล้วว่าเป็นหน้ารายงาน/พรีวิว/
// พิมพ์เอกสารล้วนๆ ไม่มีจุดไหนเรียกซ้ำทันทีหลัง save ของข้อมูลเดียวกัน จึงปลอดภัย
// และเพิ่ม getSchoolConfig เข้ามา (saveSchoolConfig ไม่มีการเรียก getSchoolConfig
// ซ้ำหลังบันทึกเลยในทั้งไฟล์ app.js — ตรวจสอบแล้ว) พร้อมขยาย TTL ให้เหมาะกับแต่ละ
// ฟังก์ชัน: รายงาน/พิมพ์เอกสารอายุนานขึ้นได้เพราะไม่ใช่หน้าที่กำลังแก้ไขข้อมูลสด
// ส่วนค่าตั้งค่าโรงเรียนแทบไม่เปลี่ยน ให้ TTL ยาวสุด
const CACHEABLE_FNS = new Map([
  ['apiPing', 20],
  ['getSetupStatus', 20],
  ['bootstrap', 20],
  ['getDashboard', 45],
  ['getPP6Data', 60],
  ['getClassSummaryData', 60],
  ['getClassActivitySummaryData', 60],
  ['getGradeHistory', 60],
  ['getSchoolConfig', 120]
]);
const CACHE_TTL_SEC_DEFAULT = 20; // เผื่ออนาคตเพิ่มฟังก์ชันแล้วลืมใส่ตัวเลข TTL

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
  const ttlSec = CACHEABLE_FNS.get(body.fn) || CACHE_TTL_SEC_DEFAULT;
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

  const upstream = await postFollowingRedirects_(APPS_SCRIPT_URL, bodyText);
  const resultText = await upstream.text();
  try { JSON.parse(resultText); }
  catch (e) {
    const snippet = resultText.replace(/\s+/g, ' ').replace(/<[^>]*>/g, ' ').trim().slice(0, 200);
    return jsonResponse({ ok: false, error: 'Apps Script ตอบกลับไม่ใช่ JSON (HTTP ' + upstream.status + '): ' + snippet }, 502);
  }

  const response = new Response(resultText, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheable ? `public, max-age=${ttlSec}` : 'no-store'
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
async function postFollowingRedirects_(url, bodyText, maxHops = 5) {
  let currentUrl = url;
  let method = 'POST';
  let body = bodyText;
  for (let i = 0; i < maxHops; i++) {
    const init = { method, redirect: 'manual' };
    if (method === 'POST') { init.headers = { 'Content-Type': 'application/json' }; init.body = body; }
    const res = await fetch(currentUrl, init);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) return res;
      currentUrl = new URL(location, currentUrl).toString();
      // Apps Script: doPost ทำงานตอน POST ครั้งแรกแล้ว และตอบ 302 ไปยัง URL ที่เก็บ "ผลลัพธ์" ซึ่งต้องเรียกด้วย GET
      // (ยิง POST ซ้ำไปที่ URL นั้นจะได้หน้า HTML error 405) — เฉพาะ 307/308 เท่านั้นที่ต้องคง POST เดิม
      if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; }
      continue;
    }
    return res;
  }
  throw new Error('redirect ไปเรื่อยๆ เกิน ' + maxHops + ' ครั้ง');
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
