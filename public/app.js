const APP_CLIENT_VERSION='2.3.0';
const SCHOOL_LOGO_SRC=new URL('/logo.png',location.origin).href;
const state={token:localStorage.getItem('pp6_token')||'',me:null,dashboard:null,dashboardDirty:false,route:'dashboard',period:{year:'',term:''},periods:[],subjectEdit:null};
const pendingCalls=new Map();
const MUTATING_FNS=new Set(['saveScores','clearScores','saveActivityResults','clearActivityResults','saveAssessments','clearAssessments','saveClass','deleteClass','saveSubject','deleteSubject','assignTeacher','deleteTeachingAssignment','registerMyTeaching','registerMyTeachingBatch','saveActivity','deleteActivity','saveActivityAssignment','deleteActivityAssignment','registerMyClub','setClubMembers','saveUser','deleteUser','adminResetPassword','importStudents','importSubjectsCsv','importTeachersCsv','importTeachingAssignmentsCsv','importClassesCsv','importActivityAssignmentsCsv','saveAcademicPeriod','setCurrentAcademicPeriod','deleteAcademicPeriod','saveSchoolConfig','updateStudent','addStudent','removeClassMember','clearClassStudents']);
// หลักสูตร (ระดับชั้น → ภาคเรียน → [รหัส,ชื่อ,ประเภท,นก.,ชม.]) โหลดจากเซิร์ฟเวอร์ตอนเข้าระบบ
// แหล่งข้อมูลจริงอยู่ที่ CURRICULUM_ ใน Code.gs ที่เดียว — ห้ามแก้ที่นี่
let CURRICULUM={};
/* ---- Curriculum-based subject ordering (shared by all ปพ.6 prints) ----
   ทุกเอกสาร ปพ.6 (รายบุคคล / ทั้งห้อง / แบบสรุปผลการเรียน) จะเรียงรายวิชา
   ตามลำดับที่กำหนดไว้ใน CURRICULUM ของระดับชั้น+ภาคเรียนนั้น ๆ
   วิชาที่ไม่อยู่ในหลักสูตร จะถูกต่อท้าย โดยเรียง พื้นฐาน→เพิ่มเติม
   แล้วตามกลุ่มสาระ (ท ค ว ส พ ศ ง อ) และรหัสวิชา */
const SUBJECT_GROUP_ORDER=['ท','ค','ว','ส','พ','ศ','ง','อ'];
// ใช้จับคู่รหัสวิชาระหว่างหลักสูตร (CURRICULUM) กับ SUBJECTS จริงในฐานข้อมูล ให้เป็นกติกาเดียวกับ
// ฝั่ง Code.gs (saveSubject ตรวจรหัสซ้ำแบบ trim + ไม่สนตัวพิมพ์เล็ก/ใหญ่) — เดิม curriculumRows()
// เทียบรหัสแบบตรงตัวเป๊ะๆ ถ้าในชีตมีช่องว่างเกินติดมา (พบบ่อยจากการพิมพ์/คัดลอก) จะจับคู่ไม่เจอ
// ตารางเลยขึ้น "ไม่พบในฐานข้อมูล" ทั้งที่จริงมีวิชานี้อยู่แล้ว พอกด ➕ เพื่อเพิ่มใหม่จึงชนกับของเดิม
// เกิด error "รหัสวิชานี้มีอยู่แล้ว" ทั้งที่หน้าเว็บไม่ได้โชว์ให้แก้ไขวิชานั้นอยู่เลย
function normCode_(v){return String(v==null?'':v).trim().toLowerCase();}
// เซตรหัสวิชาทั้งหมดของหลักสูตรมาตรฐาน (ทุกระดับชั้น/ทุกภาคเรียนรวมกัน) — ใช้แยกว่าวิชาไหนเป็น
// วิชาหลักสูตรมาตรฐานออกจากวิชาที่เพิ่มเองในโรงเรียน
function allCurriculumCodes_(){const set=new Set();Object.values(CURRICULUM||{}).forEach(byTerm=>Object.values(byTerm||{}).forEach(list=>(list||[]).forEach(x=>set.add(normCode_(x[0])))));return set;}
function untaggedSubjects_(subs){const off=allCurriculumCodes_();return (subs||[]).filter(s=>!s.level && !off.has(normCode_(s.subjectCode)) && !s.curriculumCode);}
function curriculumBaseMeta_(code){
  const wanted=normCode_(code);
  for(const level of Object.keys(CURRICULUM||{}))for(const term of Object.keys(CURRICULUM[level]||{})){
    const list=CURRICULUM[level][term]||[];
    for(let i=0;i<list.length;i++)if(normCode_(list[i][0])===wanted)return {code:list[i][0],level:String(level),term:String(term),index:i,row:list[i]};
  }
  return null;
}
function curriculumOrderIndex_(level,term,subjects){
  const map={};
  ((CURRICULUM[String(level)]||{})[String(term)]||[]).forEach((x,i)=>{
    map[normCode_(x[0])]=i;
  });
  // วิชามาตรฐานที่ถูกเปลี่ยนรหัสยังคงใช้ลำดับเดิมของหลักสูตร
  (subjects||[]).filter(s=>s.curriculumCode).forEach(s=>{
    const cc=curriculumBaseMeta_(s.curriculumCode);
    if(!cc)return;
    const lv=String(s.level||cc.level),tm=String(s.term||cc.term);
    if(lv===String(level)&&(!s.term||tm===String(term)))map[normCode_(s.subjectCode)]=cc.index;
  });
  return map;
}
function levelFromClassName_(name){const m=String(name||'').match(/ม\s*\.?\s*([1-3])/);return m?m[1]:'';}
function subjectSortKey_(s,orderMap){
  const code=String((s&&s.code)||'').trim();
  const idx=orderMap[code];
  if(idx!=null)return [0,idx,0,code];
  const g=SUBJECT_GROUP_ORDER.indexOf(code.charAt(0));
  const typeRank=String((s&&s.type)||'').indexOf('เพิ่ม')>=0?1:0;
  return [1,typeRank,(g<0?99:g),code];
}
function compareSortKeys_(a,b){for(let i=0;i<a.length;i++){if(a[i]<b[i])return -1;if(a[i]>b[i])return 1;}return 0;}
/* คืนลำดับ index ของรายวิชาหลังเรียงตามหลักสูตร (ใช้จัดเรียงคอลัมน์/เซลล์ให้ตรงกัน) */
function curriculumSubjectOrder(subjects,className,term){
  const orderMap=curriculumOrderIndex_(levelFromClassName_(className),term,subjects);
  return (subjects||[]).map((s,i)=>({i,k:subjectSortKey_(s,orderMap)}))
    .sort((a,b)=>compareSortKeys_(a.k,b.k)||(a.i-b.i)).map(x=>x.i);
}
function sortSubjectsByCurriculum(subjects,className,term){
  return curriculumSubjectOrder(subjects,className,term).map(i=>subjects[i]);
}
function orderedClasses(rows){return [...rows].sort((a,b)=>{const ka=String(a.className||'').match(/ม\.([1-3])\/(\d+)/),kb=String(b.className||'').match(/ม\.([1-3])\/(\d+)/);if(ka&&kb)return (Number(ka[1])-Number(kb[1]))|| (Number(ka[2])-Number(kb[2]));return String(a.className||'').localeCompare(String(b.className||''),'th');});}
// รวมวิชาจากหลักสูตรมาตรฐาน (CURRICULUM) กับวิชาที่แอดมิน "เพิ่มเอง" นอกหลักสูตร (ผ่านฟอร์ม
// เพิ่มรายวิชา แล้วระบุ ระดับชั้น/ภาคเรียน ไว้) — วิชานอกหลักสูตรจะถูกต่อท้ายให้ level/term ตรงกับ
// ที่เรียกฟังก์ชันนี้ ทำให้โผล่ในตาราง CURRICULUM ของระดับชั้น/ภาคเรียนนั้น และใช้ในลิสต์มอบหมาย
// ผู้สอนได้ทันที (availableSubjectsForLevel/renderTeacherSubjectChecks ฯลฯ เรียกฟังก์ชันนี้อยู่แล้ว)
function curriculumRows(level,term,subs){
  const byCode={};const byCurriculumCode={};
  (subs||[]).forEach(s=>{
    byCode[normCode_(s.subjectCode)]=s;
    if(s.curriculumCode)byCurriculumCode[normCode_(s.curriculumCode)]=s;
  });
  const baseCodes=new Set();
  const official=[];
  ((CURRICULUM[level]||{})[String(term)]||[]).forEach(x=>{
    const canonical=normCode_(x[0]);baseCodes.add(canonical);
    const db=byCurriculumCode[canonical]||byCode[canonical];
    // ถ้ามีการแก้รายวิชามาตรฐานและย้ายไปอีกชั้น/เทอม ไม่ให้แถวเดิมซ้ำในตำแหน่งเก่า
    if(db && db.curriculumCode && String(db.level||level)!==String(level))return;
    if(db && db.curriculumCode && db.term && String(db.term)!==String(term))return;
    official.push({
      code:db?.subjectCode||x[0],name:db?.subjectName||x[1],type:db?.subjectType||x[2],
      credit:db?.credit??x[3],hours:db?.hours??x[4],subjectId:db?.subjectId||'',
      level:String(db?.level||level),term:String(db?.term||term),curriculumCode:db?.curriculumCode||x[0],extra:false
    });
  });
  // วิชามาตรฐานที่ถูกย้ายมาจากคนละชั้น/ภาคเรียน ให้แสดง ณ ตำแหน่งใหม่
  const movedStandard=(subs||[]).filter(s=>s.curriculumCode&&String(s.level||'')===String(level)&&(!s.term||String(s.term)===String(term))&&curriculumBaseMeta_(s.curriculumCode)&&!baseCodes.has(normCode_(s.curriculumCode)))
    .map(s=>({code:s.subjectCode,name:s.subjectName,type:s.subjectType,credit:s.credit,hours:s.hours,subjectId:s.subjectId,level:String(level),term:String(s.term||term),curriculumCode:s.curriculumCode,extra:false}));
  const extra=(subs||[]).filter(s=>!s.curriculumCode&&String(s.level||'')===String(level)&&(!s.term||String(s.term)===String(term))&&!baseCodes.has(normCode_(s.subjectCode)))
    .map(s=>({code:s.subjectCode,name:s.subjectName,type:s.subjectType,credit:s.credit,hours:s.hours,subjectId:s.subjectId,level:String(level),term:String(term),curriculumCode:'',extra:true}));
  return official.concat(movedStandard,extra);
}
function isTeachingOccupied(subjectId,classId){return (window._teachingAvailability||[]).some(x=>String(x.subjectId)===String(subjectId)&&String(x.classId)===String(classId));}
function availableSubjectsForLevel(level,term,subs,classes){const cls=(classes||[]).filter(c=>getClassLevelKey_(c)===String(level));return curriculumRows(level,term,subs).filter(s=>s.subjectId&&cls.some(c=>!isTeachingOccupied(s.subjectId,c.classId)));}
// ข้อความเมื่อไม่มีวิชาให้เลือก: แยกกรณี "ยังไม่มีห้องของระดับชั้นนี้ในช่วงการศึกษา" ออกจาก "วิชาถูกมอบหมายครบแล้ว"
function noSubjectHint_(level,classes){const has=(classes||[]).some(c=>getClassLevelKey_(c)===String(level));return has?null:`ยังไม่มีห้อง ม.${level} ในปีการศึกษา ${state.period.year} ภาคเรียนที่ ${state.period.term} — ให้ผู้ดูแลระบบตั้งค่าห้องก่อน`;}

const $=id=>document.getElementById(id);
function call(name,...args){
  const payload={fn:name,args:args};
  const key=name+'|'+JSON.stringify(args);
  if(pendingCalls.has(key)) return pendingCalls.get(key);
  const started=performance.now();
  const p=fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(async r=>{
    const t=await r.text();let res;
    try{res=JSON.parse(t);}catch(e){throw new Error('เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ (HTTP '+r.status+') — ถ้าเห็นข้อความนี้ให้ตรวจ /api บน Cloudflare Pages และลิงก์ Apps Script: '+t.replace(/\s+/g,' ').slice(0,100));}
    if(!res.ok)throw new Error(res.error||'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
    if(MUTATING_FNS.has(name))state.dashboardDirty=true;
    const ms=Math.round(performance.now()-started);
    if(ms>1000)console.debug('[PP6] API slow',name,ms+'ms');
    return res.result;
  }).finally(()=>pendingCalls.delete(key));
  pendingCalls.set(key,p); return p;
}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
// แถวหัวตารางแสดงปีการศึกษา/ภาคเรียนปัจจุบัน แทรกเป็นแถวบนสุดใน <thead> ของตารางกรอกคะแนน/ข้อมูล
// เพื่อกันครูสับสนว่ากำลังกรอก/แก้ไขข้อมูลของช่วงการศึกษาใดอยู่ (โดยเฉพาะเวลาสลับปี/เทอมแล้วลืมเช็ค)
function periodHeadRow(colspan){return `<tr class="period-head-row"><th colspan="${colspan}">📅 ปีการศึกษา ${escapeHtml(state.period.year)} · ภาคเรียนที่ ${escapeHtml(state.period.term)}</th></tr>`;}
function periodBannerHtml(){return `<div class="period-banner">📅 ปีการศึกษา <b>${escapeHtml(state.period.year)}</b> · ภาคเรียนที่ <b>${escapeHtml(state.period.term)}</b></div>`;}

function ensureToastHost(){let h=$('toastHost');if(!h){h=document.createElement('div');h.id='toastHost';h.className='toast-host';document.body.appendChild(h);}return h;}
function toast(msg,ok=false){const host=ensureToastHost();const el=document.createElement('div');el.className='alert '+(ok?'alert-ok':'alert-danger');el.textContent=msg;host.appendChild(el);requestAnimationFrame(()=>el.classList.add('show'));setTimeout(()=>{el.classList.remove('show');setTimeout(()=>el.remove(),200);},2800);}

function showSpinner(msg){const el=document.createElement('div');el.className='card muted';el.textContent=msg||'กำลังโหลด...';return el;}

function showLogin(){state.route='login';$('appView').classList.add('hidden');$('loginView').classList.remove('hidden');$('loginView').innerHTML=`<div class="login-wrap"><div class="login-card"><img class="login-school-logo" src="${SCHOOL_LOGO_SRC}" alt="ตราโรงเรียนวัดไตรสามัคคี"><div class="login-kicker">WAT TRISAMAKKEE SCHOOL</div><h1>ระบบ ปพ.6</h1><p>ระบบจัดการผลการเรียนและงานทะเบียน</p><div class="field"><label>ชื่อผู้ใช้</label><input id="loginUser" autocomplete="username"></div><div class="field"><label>รหัสผ่าน</label><input id="loginPass" type="password" autocomplete="current-password"></div><button class="btn btn-primary" id="loginBtn" style="width:100%;margin-top:8px" onclick="doLogin()">เข้าสู่ระบบ</button><div id="loginMsg"></div></div></div>`;
  $('loginPass').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
}
async function doLogin(){const btn=$('loginBtn');try{$('loginMsg').innerHTML='';btn.disabled=true;btn.textContent='กำลังเข้าสู่ระบบ...';const r=await call('login',$('loginUser').value,$('loginPass').value);state.token=r.token;state.me=r.user;localStorage.setItem('pp6_token',state.token);await openApp();}catch(e){$('loginMsg').innerHTML=`<div class="alert-inline alert-danger">${escapeHtml(e.message)}</div>`;btn.disabled=false;btn.textContent='เข้าสู่ระบบ';}}
async function logout(){await call('logout',state.token).catch(()=>{});state.token='';state.me=null;localStorage.removeItem('pp6_token');showLogin();}
async function openApp(){try{const saved=JSON.parse(localStorage.getItem('pp6_period')||'null');const r=await call('bootstrap',state.token,saved?saved.year:'',saved?saved.term:'');state.me=r.me;state.periods=r.periods;state.period=r.period;state.dashboard=r.dashboard;CURRICULUM=r.curriculum||await call('getCurriculum',state.token);localStorage.setItem('pp6_period',JSON.stringify(state.period));renderShell();if(state.me.forceChangePassword) toast('กรุณาเปลี่ยนรหัสผ่านในการใช้งานครั้งแรก');renderRoute();}catch(e){localStorage.removeItem('pp6_token');state.token='';showLogin();}}
async function changeAcademicPeriod(){const y=$('periodYear')?.value||'',t=$('periodTerm')?.value||'';if(!y||!t)return;state.period={year:y,term:t};localStorage.setItem('pp6_period',JSON.stringify(state.period));try{state.dashboard=await call('getDashboard',state.token,y,t);state.dashboardDirty=false;await renderRoute();}catch(e){toast(e.message);}}
function changePeriodYear(){const y=$('periodYear').value;const terms=(state.periods||[]).filter(x=>String(x.year)===String(y)).map(x=>String(x.term));$('periodTerm').innerHTML=terms.map(t=>`<option value="${escapeHtml(t)}">ภาคเรียน ${escapeHtml(t)}</option>`).join('');if(terms.length){$('periodTerm').value=terms[0];changeAcademicPeriod();}}

const MENU=[
  {route:'dashboard',icon:'📊',label:'Dashboard'},
  {route:'scores',icon:'📝',label:'กรอกคะแนนรายวิชา'},
  {route:'myTeaching',icon:'📚',label:'ลงทะเบียนวิชาที่สอน'},
  {route:'activities',icon:'🎯',label:'กิจกรรมพัฒนาผู้เรียน'},
  {route:'clubRegister',icon:'🧑‍🤝‍🧑',label:'ลงทะเบียนนักเรียนชุมนุม'},
  {route:'assessment',icon:'📖',label:'ประเมินอ่านคิดฯ / คุณลักษณะ / สมรรถนะ'},
  {route:'students',icon:'👨‍🎓',label:'ลงทะเบียนนักเรียน'},
  {route:'print',icon:'🖨',label:'พิมพ์ ปพ.6 / สรุปผลการเรียน'},
  {route:'summary',icon:'📈',label:'อันดับผลการเรียน (GPA)'},
  {route:'history',icon:'🗂️',label:'ดูเกรดย้อนหลัง'}
];
const ADMIN_MENU=[
  {route:'subjects',icon:'⚙',label:'ตั้งค่าวิชา / ผู้สอน'},
  {route:'classes',icon:'🏫',label:'ตั้งค่าห้อง / ครูประจำชั้น'},
  {route:'activitiesAdmin',icon:'🎯',label:'ตั้งค่ากิจกรรม / ผู้รับผิดชอบ'},
  {route:'users',icon:'👥',label:'ผู้ใช้งาน'},
  {route:'validation',icon:'✅',label:'ตรวจสอบข้อมูล'}
];
function renderShell(){
  $('loginView').classList.add('hidden');$('appView').classList.remove('hidden');
  const iconLabel=(icon,label)=>`<span class="menu-icon">${icon}</span><span class="menu-text">${label}</span>`;
  const makeMenu=items=>items.map(m=>`<button class="menu-btn" data-route="${m.route}" onclick="go('${m.route}')">${iconLabel(m.icon,m.label)}</button>`).join('');
  const adminHtml=state.me.roles.includes('ADMIN')?`<div class="sidebar-section admin-title">การจัดการระบบ</div>${makeMenu(ADMIN_MENU)}`:'';
  const initial=String(state.me.fullName||'').trim().charAt(0)||'U';
  const roleText=escapeHtml((state.me.roles||[]).join(' / '));
  const years=[...new Set((state.periods||[]).map(x=>String(x.year)))];
  const terms=(state.periods||[]).filter(x=>String(x.year)===String(state.period.year)).map(x=>String(x.term));
  const termOptions=terms.map(t=>`<option value="${escapeHtml(t)}" ${String(t)===String(state.period.term)?'selected':''}>ภาคเรียน ${escapeHtml(t)}</option>`).join('');
  $('appView').innerHTML=`<div class="topbar"><div class="brand-wrap"><div class="brand-logo brand-logo-large"><img src="${SCHOOL_LOGO_SRC}" alt="ตราโรงเรียน"></div><div class="brand"><strong>ระบบ ปพ.6</strong><small>โรงเรียนวัดไตรสามัคคี</small></div></div><div class="topbar-right"><div class="period-picker"><span class="period-icon">📅</span><div><label>ช่วงการศึกษา</label><div class="period-controls"><select id="periodYear" onchange="changePeriodYear()">${years.map(y=>`<option value="${escapeHtml(y)}" ${String(y)===String(state.period.year)?'selected':''}>${escapeHtml(y)}</option>`).join('')}</select><select id="periodTerm" onchange="changeAcademicPeriod()">${termOptions}</select></div></div></div><div class="system-status"><span class="status-dot"></span> ระบบพร้อมใช้งาน</div><div class="user-pill"><span class="user-avatar">${escapeHtml(initial)}</span><span class="user-meta"><span class="user-name">${escapeHtml(state.me.fullName)}</span><span class="user-role">${roleText}</span></span></div><button class="menu-toggle" onclick="toggleSidebar()" aria-label="เมนู">☰</button><button class="btn btn-secondary top-logout" onclick="logout()">ออกจากระบบ</button></div></div><div class="layout"><aside class="sidebar" id="sidebar"><div class="sidebar-school"><img src="${SCHOOL_LOGO_SRC}" alt="ตราโรงเรียน"><div><b>โรงเรียนวัดไตรสามัคคี</b><small>ระบบ ปพ.6</small></div></div><div class="sidebar-section">เมนูหลัก</div>${makeMenu(MENU)}${adminHtml}<div class="sidebar-spacer"></div><button class="menu-btn" onclick="showPasswordModal()">${iconLabel('⚿','เปลี่ยนรหัสผ่าน')}</button><div class="sidebar-footer">โรงเรียนวัดไตรสามัคคี · ระบบทะเบียนผลการเรียน</div></aside><main id="page" class="content"></main></div>`;
}

function toggleSidebar(){$('sidebar').classList.toggle('open');}
function go(route){state.route=route;$('sidebar')?.classList.remove('open');renderRoute();}
async function renderRoute(){
  document.querySelectorAll('.menu-btn[data-route]').forEach(b=>b.classList.toggle('active',b.dataset.route===state.route));
  const p=$('page');p.innerHTML='';p.appendChild(showSpinner());
  try{
    switch(state.route){
      case'dashboard':await renderDashboard(p);break;
      case'scores':await renderScores(p);break;
      case'myTeaching':await renderMyTeaching(p);break;
      case'activities':await renderActivities(p);break;
      case'clubRegister':await renderClubRegister(p);break;
      case'assessment':await renderAssessment(p);break;
      case'students':await renderStudents(p);break;
      case'print':await renderPrint(p);break;
      case'summary':await renderSummary(p);break;
      case'history':await renderGradeHistory(p);break;
      case'subjects':await renderSubjects(p);break;
      case'users':await renderUsers(p);break;
      case'classes':await renderClasses(p);break;
      case'activitiesAdmin':await renderActivitiesAdmin(p);break;
      case'validation':await renderValidation(p);break;
      default:await renderDashboard(p);
    }
  }catch(e){
    if(String(e.message).includes('SESSION')){await logout();return;}
    p.innerHTML=`<div class="alert-inline alert-danger">${escapeHtml(e.message)}</div>`;
  }
}

async function renderDashboard(p){
  const dashMatchesPeriod=state.dashboard&&String(state.dashboard.year)===String(state.period.year)&&String(state.dashboard.term)===String(state.period.term);
  if(!dashMatchesPeriod||state.dashboardDirty) state.dashboard=await call('getDashboard',state.token,state.period.year,state.period.term);
  state.dashboardDirty=false;
  const d=state.dashboard||{}, pct=Math.max(0,Math.min(100,Number(d.percent||0)));
  const total=Number(d.totalEntries||0), done=Number(d.doneEntries||0), pending=Math.max(total-done,0), classes=d.classes||[];
  const stats=[{label:'วิชาที่รับผิดชอบ',value:Number(d.teachingCount||0),icon:'📚',tone:'blue'},{label:'ห้องที่เกี่ยวข้อง',value:Number(d.classCount||0),icon:'🏫',tone:'green'},{label:'รายการคะแนนทั้งหมด',value:total,icon:'📝',tone:'gold'},{label:'กรอกคะแนนแล้ว',value:done,icon:'✓',tone:'red'}];
  const donutStyle=`background:conic-gradient(var(--school-green) 0 ${pct}%, #e9eef5 ${pct}% 100%)`;
  p.innerHTML=`<div class="dashboard-head"><div><div class="eyebrow">SCHOOL ACADEMIC MANAGEMENT</div><h2>แดชบอร์ด</h2><p class="sub">ภาพรวมการจัดทำผลการเรียนของ ${escapeHtml(state.me.fullName)}</p></div><div class="head-chips"><span class="meta-chip">ปี ${escapeHtml(d.year||'')}</span><span class="meta-chip">ภาคเรียน ${escapeHtml(d.term||'')}</span></div></div>
  <section class="welcome-banner"><div class="welcome-copy"><div class="welcome-brand"><span>ระบบ ปพ.6</span><span class="welcome-dot">•</span><span>โรงเรียนวัดไตรสามัคคี</span></div><h1>จัดการผลการเรียนอย่างเป็นระบบ<br><span>ครบ จบ ในหน้าจอเดียว</span></h1><p>กรอกคะแนน ตรวจสอบข้อมูล ประเมินผล และจัดพิมพ์เอกสารได้อย่างรวดเร็ว พร้อมสถิติความคืบหน้าแบบเรียลไทม์</p><div class="welcome-actions"><button class="btn btn-primary" onclick="go('scores')">📝 กรอกคะแนนทันที</button><button class="btn btn-light" onclick="go('print')">⎙ พิมพ์ ปพ.6</button></div></div><div class="welcome-emblem"><div class="emblem-ring"><img src="${SCHOOL_LOGO_SRC}" alt="ตราโรงเรียนวัดไตรสามัคคี"></div><div class="emblem-caption"><b>WAT TRISAMAKKEE</b><span>SMART ACADEMIC SYSTEM</span></div></div></section>
  <section class="grid grid-4 dashboard-kpis">${stats.map(s=>`<div class="kpi-card tone-${s.tone}"><div class="kpi-top"><div><div class="kpi-label">${s.label}</div><div class="kpi">${s.value.toLocaleString('th-TH')}</div></div><div class="kpi-icon">${s.icon}</div></div><div class="kpi-line"></div></div>`).join('')}</section>
  <section class="dashboard-grid"><div class="card progress-card"><div class="section-heading"><div><span class="section-kicker">PROGRESS</span><h3>ความคืบหน้าการกรอกคะแนน</h3></div><span class="soft-badge">${pct}%</span></div><div class="progress-main"><div class="donut" style="${donutStyle}"><div class="donut-inner"><strong>${pct}%</strong><span>เสร็จแล้ว</span></div></div><div class="progress-copy"><div class="progress-value">${done.toLocaleString('th-TH')} <span>/ ${total.toLocaleString('th-TH')} รายการ</span></div><div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div><div class="legend-row"><span><i class="legend-dot done"></i>กรอกแล้ว ${done.toLocaleString('th-TH')}</span><span><i class="legend-dot pending"></i>คงเหลือ ${pending.toLocaleString('th-TH')}</span></div></div></div></div>
  <div class="card stats-card"><div class="section-heading"><div><span class="section-kicker">STATISTICS</span><h3>สถิติภาพรวมการทำงาน</h3></div><span class="soft-badge soft-blue">ปี ${escapeHtml(d.year||'')}</span></div><div class="bar-chart">${stats.map(s=>{const max=Math.max(...stats.map(x=>x.value),1),w=Math.round((s.value/max)*100);return `<div class="bar-row"><div class="bar-label"><span>${s.icon} ${s.label}</span><b>${s.value.toLocaleString('th-TH')}</b></div><div class="bar-track"><div class="bar-fill tone-${s.tone}" style="width:${w}%"></div></div></div>`}).join('')}</div></div></section>
  <section class="dashboard-bottom"><div class="card"><div class="section-heading"><div><span class="section-kicker">QUICK ACCESS</span><h3>เมนูที่ใช้บ่อย</h3></div><span class="muted">เลือกเมนูเพื่อทำงานต่อทันที</span></div><div class="quick-grid modern-quick"><button class="quick-btn" onclick="go('scores')"><span class="q-icon">📝</span><span><b>กรอกคะแนนรายวิชา</b><small>บันทึกคะแนนและเกรด</small></span><em>→</em></button><button class="quick-btn" onclick="go('print')"><span class="q-icon">⎙</span><span><b>พิมพ์ ปพ.6</b><small>จัดทำเอกสารรายบุคคล</small></span><em>→</em></button><button class="quick-btn" onclick="go('summary')"><span class="q-icon">▥</span><span><b>สรุปผลการเรียน</b><small>ดูภาพรวมของชั้นเรียน</small></span><em>→</em></button></div></div><div class="card responsibility-card"><div class="section-heading"><div><span class="section-kicker">RESPONSIBILITY</span><h3>ห้องเรียนที่รับผิดชอบ</h3></div><span class="soft-badge soft-green">${Number(d.classCount||0)} ห้อง</span></div><div class="class-chips">${classes.length?classes.map(c=>`<span>${escapeHtml(c)}</span>`).join(''):'<span class="muted">ยังไม่มีข้อมูลห้องเรียน</span>'}</div></div></section>`;
}

/* ---------------- Scores ---------------- */
async function renderScores(p){
  const assigns=await call('getTeacherAssignments',state.token,state.period.year,state.period.term);
  if(!assigns.length){p.innerHTML='<div class="card"><h2>กรอกคะแนนรายวิชา</h2><p class="muted">ยังไม่มีรายวิชาที่กำหนดให้บัญชีนี้</p></div>';return;}
  p.innerHTML=`<h2>กรอกคะแนนรายวิชา</h2>${periodBannerHtml()}<div class="card"><div class="toolbar score-toolbar"><select id="assignSelect" onchange="loadScoreGrid()"><option value="">-- เลือกวิชา / ห้อง --</option>${assigns.map(a=>`<option value="${a.assignmentId}">${escapeHtml(a.subjectCode+' '+a.subjectName+' · '+a.className)}</option>`).join('')}</select><button id="pasteScoreBtn" class="btn btn-secondary" onclick="openPasteScoreModal()">📋 วางคะแนนจาก Excel</button><button id="editScoreBtn" class="btn btn-secondary" onclick="enableScoreEditing()" disabled>✏️ แก้ไขคะแนน</button><button id="saveScoreBtn" class="btn btn-primary" onclick="saveScoreGrid()" disabled>💾 บันทึกคะแนน</button><button id="clearScoreBtn" class="btn btn-danger" onclick="clearScoreGrid()" disabled>🧹 ล้างคะแนน</button></div><div id="scoreModeInfo"></div><div id="scoreInfo"></div><div id="scoreGrid" class="table-wrap"></div></div>`;
  window._assignments=assigns;
}

function scoreRowsHaveData(rows){
  return (rows||[]).some(r=>String(r.score??'').trim()!==''||String(r.status??'').trim()!==''||String(r.retakeScore??'').trim()!==''||String(r.finalGrade??'').trim()!=='');
}
function setScoreInputsDisabled(disabled){
  document.querySelectorAll('#scoreGrid .score,#scoreGrid .retake,#scoreGrid .status').forEach(el=>{el.disabled=disabled;el.classList.toggle('score-locked',disabled);});
}
function updateScoreModeUi(hasSaved){
  const edit=$('editScoreBtn'),save=$('saveScoreBtn'),clear=$('clearScoreBtn');
  if(!edit||!save||!clear)return;
  if(hasSaved){
    edit.disabled=false;edit.textContent='✏️ แก้ไขคะแนน';
    save.disabled=true;
    clear.disabled=false;
    setScoreInputsDisabled(true);
    if($('scoreModeInfo')) $('scoreModeInfo').innerHTML='<div class="alert-inline alert-ok score-mode-badge">🔒 บันทึกแล้ว — กด “แก้ไขคะแนน” ก่อนปรับข้อมูล</div>';
  }else{
    edit.disabled=true;
    save.disabled=false;
    clear.disabled=false;
    setScoreInputsDisabled(false);
    if($('scoreModeInfo')) $('scoreModeInfo').innerHTML='<div class="alert-inline alert-ok score-mode-badge">✍️ พร้อมกรอก/แก้ไขคะแนน</div>';
  }
}
function enableScoreEditing(showMessage=true){
  if(!$('assignSelect')||!$('assignSelect').value)return toast('กรุณาเลือกวิชาก่อน');
  if(!$('scoreGrid')||!$('scoreGrid').querySelector('tbody tr'))return toast('ยังไม่มีรายชื่อนักเรียน');
  setScoreInputsDisabled(false);
  if($('editScoreBtn'))$('editScoreBtn').disabled=true;
  if($('saveScoreBtn'))$('saveScoreBtn').disabled=false;
  if($('clearScoreBtn'))$('clearScoreBtn').disabled=false;
  if($('scoreModeInfo'))$('scoreModeInfo').innerHTML='<div class="alert-inline alert-ok score-mode-badge">✏️ อยู่ในโหมดแก้ไข — ตรวจข้อมูลแล้วกด “บันทึกคะแนน”</div>';
  if(showMessage)toast('เปิดโหมดแก้ไขคะแนนแล้ว',true);
}
async function loadScoreGrid(){
  const id=$('assignSelect').value;if(!id){$('scoreGrid').innerHTML='';$('saveScoreBtn').disabled=true;if($('editScoreBtn'))$('editScoreBtn').disabled=true;if($('clearScoreBtn'))$('clearScoreBtn').disabled=true;return;}
  $('scoreGrid').innerHTML='';$('scoreGrid').appendChild(showSpinner());
  const data=await call('getScoreEntry',state.token,id);window._scoreData=data;
  const hasSaved=scoreRowsHaveData(data.rows);
  $('scoreInfo').innerHTML=`<div class="alert-inline alert-ok">${escapeHtml(data.assignment.subjectCode+' '+data.assignment.subjectName)} · ${escapeHtml(data.assignment.className)} · คะแนนเต็ม ${data.assignment.scoreMax}${hasSaved?' · มีข้อมูลที่บันทึกแล้ว':''}</div>`;
  $('scoreGrid').innerHTML=`<table class="data-table"><thead>${periodHeadRow(7)}<tr><th>ที่</th><th>เลขประจำตัว</th><th>ชื่อ-สกุล</th><th>คะแนน</th><th>ร/มส</th><th>แก้ตัว</th><th>เกรด</th></tr></thead><tbody>${data.rows.map((r,i)=>`<tr data-enr="${escapeHtml(r.enrollmentId)}"><td>${r.classNo}</td><td>${escapeHtml(r.studentCode)}</td><td>${escapeHtml(r.prefix+r.firstName+' '+r.lastName)}</td><td><input class="score-input score" type="number" min="0" max="${data.assignment.scoreMax}" step="0.01" value="${r.score??''}"></td><td><select class="status-select status"><option value="">ปกติ</option><option value="ร" ${r.status==='ร'?'selected':''}>ร</option><option value="มส" ${r.status==='มส'?'selected':''}>มส</option></select></td><td><input class="score-input retake" type="number" min="0" max="${data.assignment.scoreMax}" step="0.01" value="${r.retakeScore??''}"></td><td class="grade">${r.finalGrade??''}</td></tr>`).join('')}</tbody></table>`;
  document.querySelectorAll('#scoreGrid .score,#scoreGrid .retake,#scoreGrid .status').forEach(el=>el.addEventListener('input',updateVisibleGrades));
  updateVisibleGrades();
  updateScoreModeUi(hasSaved);
}
function updateVisibleGrades(){document.querySelectorAll('#scoreGrid tbody tr').forEach(tr=>{const score=tr.querySelector('.score').value,ret=tr.querySelector('.retake').value,status=tr.querySelector('.status').value;let g='';if(!status&&score!=='')g=calcLocalGrade(Number(ret!==''?ret:score));tr.querySelector('.grade').textContent=g??'';});}
function calcLocalGrade(n){if(n>=80)return 4;if(n>=75)return 3.5;if(n>=70)return 3;if(n>=65)return 2.5;if(n>=60)return 2;if(n>=55)return 1.5;if(n>=50)return 1;return 0;}
async function saveScoreGrid(){
  const id=$('assignSelect').value;if(!id)return;
  const btn=$('saveScoreBtn');btn.disabled=true;const orig=btn.textContent;btn.textContent='กำลังบันทึก...';
  const rows=[...document.querySelectorAll('#scoreGrid tbody tr')].map(tr=>({enrollmentId:tr.dataset.enr,score:tr.querySelector('.score').value,status:tr.querySelector('.status').value,retakeScore:tr.querySelector('.retake').value,remark:''}));
  try{const r=await call('saveScores',state.token,{assignmentId:id,rows});toast('บันทึก '+r.saved+' รายการเรียบร้อย',true);await loadScoreGrid();}
  catch(e){toast(e.message);}finally{btn.disabled=false;btn.textContent=orig;}
}
async function clearScoreGrid(){
  const id=$('assignSelect')?.value;if(!id)return toast('กรุณาเลือกวิชาก่อน');
  const name=$('assignSelect').options[$('assignSelect').selectedIndex]?.text||'วิชาที่เลือก';
  const ok=confirm(`ต้องการล้างคะแนนทั้งหมดของ ${name} ใช่หรือไม่?\n\nระบบจะล้างคะแนน, ร/มส, คะแนนแก้ตัว และเกรดของนักเรียนในวิชานี้ แล้วคงรายชื่อนักเรียนไว้`);
  if(!ok)return;
  const btn=$('clearScoreBtn'); if(btn){btn.disabled=true;btn.textContent='กำลังล้าง...';}
  try{const r=await call('clearScores',state.token,id);toast('ล้างคะแนนแล้ว '+(r.cleared||0)+' รายการ',true);await loadScoreGrid();}
  catch(e){toast(e.message);}
  finally{if(btn){btn.disabled=false;btn.textContent='🧹 ล้างคะแนน';}}
}
function openPasteScoreModal(){
  if(!$('assignSelect')||!$('assignSelect').value)return toast('กรุณาเลือกวิชาก่อน');
  enableScoreEditing(false);
  $('page').insertAdjacentHTML('beforeend',`<div class="modal" id="pasteModal"><div class="modal-card"><h3>วางคะแนนจาก Excel</h3><p class="muted">รองรับ: คะแนนอย่างเดียว 1 คอลัมน์ หรือ เลขที่ + คะแนน หรือ เลขประจำตัว + คะแนน</p><textarea id="pasteText" class="paste-box" placeholder="ตัวอย่าง&#10;68&#10;75&#10;82"></textarea><div class="toolbar" style="margin-top:12px"><button class="btn btn-primary" onclick="applyPasteScores()">ตรวจสอบและนำไปใส่ตาราง</button><button class="btn btn-secondary" onclick="closeModal('pasteModal')">ยกเลิก</button></div><div id="pastePreview"></div></div></div>`);
}
function applyPasteScores(){
  const text=$('pasteText').value.replace(/\r/g,'');
  const rows=text.split('\n').map(x=>x.split('\t')).filter(r=>r.some(c=>c.trim()!==''));
  const grid=[...document.querySelectorAll('#scoreGrid tbody tr')];
  const data=window._scoreData?.rows||[];
  let applied=0;const errors=[];
  if(rows.length===0)return toast('ไม่มีข้อมูล');
  if(rows[0].length===1){
    rows.forEach((r,i)=>{if(i<grid.length){grid[i].querySelector('.score').value=r[0].trim();applied++;}else errors.push('เกินจำนวนรายชื่อนักเรียน');});
  }else if(rows[0].length>=2){
    const mapByNo={},mapByCode={};
    data.forEach((x,i)=>{mapByNo[String(x.classNo)]=grid[i];mapByCode[String(x.studentCode)]=grid[i];});
    rows.forEach(r=>{const key=String(r[0]).trim(),line=mapByNo[key]||mapByCode[key];if(line){line.querySelector('.score').value=String(r[1]).trim();applied++;}else errors.push('ไม่พบ '+key);});
  }
  updateVisibleGrades();
  $('pastePreview').innerHTML=`<div class="alert-inline ${errors.length?'alert-danger':'alert-ok'}">ใส่คะแนนแล้ว ${applied} คน${errors.length?'<br>'+errors.join('<br>'):''}</div>`;
  if(applied)toast('นำคะแนนเข้าตารางแล้ว',true);
}

function closeModal(id){const el=$(id);if(el)el.remove();}

/* ---------------- Generic bulk-select helpers (checkbox columns) ---------------- */
// Each table gets its own bulk bar, ids derived from the grid's id:
//   grid id "studentGrid" -> bar id "studentGrid_bulkBar", count "studentGrid_bulkCount"
function toggleAllBulk(headerCb,gridId){document.querySelectorAll('#'+gridId+' .bulk-check').forEach(cb=>cb.checked=headerCb.checked);updateBulkBar(gridId);}
function getBulkSelected(gridId){return [...document.querySelectorAll('#'+gridId+' .bulk-check:checked')].map(cb=>cb.value);}
function updateBulkBar(gridId){
  const ids=getBulkSelected(gridId);const bar=$(gridId+'_bulkBar');if(!bar)return;
  if(ids.length){bar.classList.remove('hidden');$(gridId+'_bulkCount').textContent=`เลือกแล้ว ${ids.length} รายการ`;}
  else bar.classList.add('hidden');
}
function clearBulkSelection(gridId){
  const scope=gridId?document.getElementById(gridId):document;
  if(scope) scope.querySelectorAll('.bulk-check').forEach(cb=>cb.checked=false);
  if(scope){const h=scope.querySelector('thead input[type=checkbox]');if(h)h.checked=false;}
  if(gridId){const bar=$(gridId+'_bulkBar');if(bar)bar.classList.add('hidden');}
  else document.querySelectorAll('.bulk-bar').forEach(b=>b.classList.add('hidden'));
}
function bulkBarHtml(gridId,label){return `<div id="${gridId}_bulkBar" class="bulk-bar hidden"><span id="${gridId}_bulkCount"></span><button class="btn btn-danger" onclick="${label}">ลบที่เลือก</button><button class="btn btn-secondary" onclick="clearBulkSelection('${gridId}')">ยกเลิกเลือก</button></div>`;}
// Loops the existing single-item delete function over each selected id — simple
// and safe for the list sizes a school actually has (tens of rows, not thousands).
// FIX: the old version did `catch(e){fail++}` and threw the message away, so a
// failed bulk delete showed "ล้มเหลว N รายการ" with no reason at all. Errors are
// now collected and shown, and the list is refreshed even when everything failed.
function reportBulkResult(ok,errors,unit){
  if(!errors.length){toast(`ลบสำเร็จ ${ok} ${unit}`,true);return;}
  const uniq=[...new Set(errors)];
  toast(`สำเร็จ ${ok} ${unit}, ล้มเหลว ${errors.length} ${unit} — ${uniq[0]}${uniq.length>1?` (และอีก ${uniq.length-1} สาเหตุ)`:''}`);
  console.error('bulk delete errors:',errors);
}
async function bulkDeleteWith(gridId,deleteFnName,refreshFn){
  const ids=getBulkSelected(gridId);
  if(!ids.length){toast('ยังไม่ได้เลือกรายการ');return;}
  if(!confirm(`ลบ ${ids.length} รายการที่เลือก?`))return;
  let ok=0;const errors=[];
  for(const id of ids){
    try{await call(deleteFnName,state.token,id);ok++;}
    catch(e){errors.push(e&&e.message?e.message:String(e));}
  }
  reportBulkResult(ok,errors,'รายการ');
  await refreshFn();
}
async function bulkRemoveStudents(){
  const ids=getBulkSelected('studentGrid');
  if(!ids.length){toast('ยังไม่ได้เลือกนักเรียน');return;}
  if(!confirm(`นำนักเรียน ${ids.length} คนที่เลือกออกจากห้องนี้?`))return;
  let ok=0;const errors=[];
  for(const id of ids){
    try{await call('removeClassMember',state.token,window._studentClassId,id);ok++;}
    catch(e){errors.push(e&&e.message?e.message:String(e));}
  }
  reportBulkResult(ok,errors,'คน');
  await loadStudentsGrid();
}

/* ---------------- Students ---------------- */
async function renderStudents(p){
  // สิทธิ์ครูประจำชั้นเชื่อมจากหน้า “ตั้งค่าห้อง / ครูประจำชั้น” โดยตรง
  // Admin เห็นทุกห้อง ส่วนครูทั่วไปเห็นเฉพาะห้องที่ถูกกำหนดเป็น HomeroomUser1/2
  const isAdmin=state.me.roles.includes('ADMIN');
  let cls=[];
  try{
    cls=isAdmin?await call('getClasses',state.token,state.period.year,state.period.term):await call('getMyHomeroomClasses',state.token,state.period.year,state.period.term);
  }catch(e){
    p.innerHTML=`<div class="card"><div class="alert-inline alert-danger">${escapeHtml(e.message||'ไม่มีสิทธิ์')}</div></div>`;
    return;
  }
  cls=orderedClasses(cls);
  if(!isAdmin && !cls.length){
    p.innerHTML=`<h2>ลงทะเบียนนักเรียน</h2><div class="card"><div class="alert-inline alert-danger"><b>ยังไม่มีห้องที่ได้รับสิทธิ์ครูประจำชั้น</b><br>ผู้ดูแลระบบสามารถเชื่อมสิทธิ์ได้ที่เมนู <b>“ตั้งค่าห้อง / ครูประจำชั้น”</b> โดยเลือกชื่อครูในช่อง <b>ครูประจำชั้น 1</b> หรือ <b>ครูประจำชั้น 2</b> ของห้อง เมื่อบันทึกแล้ว ห้องจะปรากฏที่นี่อัตโนมัติสำหรับปีการศึกษา ${escapeHtml(state.period.year)} ภาคเรียน ${escapeHtml(state.period.term)}</div></div>`;
    return;
  }
  p.innerHTML=`<h2>ลงทะเบียนนักเรียน</h2>${periodBannerHtml()}<p class="section-note">สิทธิ์การจัดการรายชื่อนักเรียนเชื่อมจากหน้า “ตั้งค่าห้อง / ครูประจำชั้น” โดยตรง จึงไม่ต้องกำหนด Role เพิ่มให้ครู</p><div class="card"><div class="toolbar"><select id="classStudentSelect" onchange="loadStudentsGrid()"><option value="">-- เลือกห้อง --</option>${cls.map(c=>`<option value="${c.classId}">${escapeHtml(c.className)}</option>`).join('')}</select><button class="btn btn-primary" onclick="openAddStudentModal()">➕ เพิ่มนักเรียน</button><button class="btn btn-secondary" onclick="openStudentPasteModal()">📋 นำเข้า/วางจาก Excel</button><button class="btn btn-secondary" onclick="downloadCsv('เทมเพลต_นักเรียน.csv',CSV_TEMPLATES.students)">⬇ เทมเพลต CSV</button><button class="btn btn-danger" onclick="clearAllStudents()">🧹 ล้างข้อมูลนักเรียนทั้งห้อง</button></div>${bulkBarHtml('studentGrid','bulkRemoveStudents()')}<div id="studentGrid" class="table-wrap"></div></div>`;
}
async function loadStudentsGrid(){
  const id=$('classStudentSelect').value;if(!id)return;
  $('studentGrid').innerHTML='';$('studentGrid').appendChild(showSpinner());
  const rows=await call('getStudentsByClass',state.token,id);
  window._studentClassId=id;window._studentRows=rows;
  $('studentGrid').innerHTML=`<table class="data-table student-data-table"><thead>${periodHeadRow(8)}<tr><th><input type="checkbox" onchange="toggleAllBulk(this,'studentGrid')"></th><th>ที่</th><th>เลขประจำตัว</th><th>คำนำหน้า</th><th>ชื่อ</th><th>นามสกุล</th><th>เพศ</th><th>จัดการ</th></tr></thead><tbody>${rows.map(r=>`<tr><td><input type="checkbox" class="bulk-check" value="${r.studentId}" onchange="updateBulkBar('studentGrid')"></td><td>${r.classNo}</td><td>${escapeHtml(r.studentCode)}</td><td>${escapeHtml(r.prefix||'-')}</td><td>${escapeHtml(r.firstName)}</td><td>${escapeHtml(r.lastName)}</td><td>${escapeHtml(r.gender||'ไม่ระบุ')}</td><td class="row-actions"><button class="btn-icon" title="แก้ไขข้อมูลนักเรียน" onclick="editStudentModal('${r.studentId}')">✏️</button><button class="btn-icon" title="นำออกจากห้อง" onclick="removeStudentNow('${r.studentId}')">🗑️</button></td></tr>`).join('')}</tbody></table>`;
  clearBulkSelection('studentGrid');
}
async function clearAllStudents(){
  const id=$('classStudentSelect').value;if(!id)return toast('กรุณาเลือกห้องก่อน');
  if(!confirm('ล้างข้อมูลนักเรียนทั้งห้องนี้? นักเรียนทุกคนจะถูกนำออกจากห้อง (ประวัติคะแนนเดิมยังอยู่ในระบบ) การกระทำนี้ยกเลิกไม่ได้ผ่านหน้าจอนี้'))return;
  try{const r=await call('clearClassStudents',state.token,id);toast(`ล้างข้อมูลแล้ว (${r.removed} คน)`,true);await loadStudentsGrid();}catch(e){toast(e.message);}
}
function openAddStudentModal(){
  const cid=$('classStudentSelect')?.value;if(!cid)return toast('กรุณาเลือกห้องก่อน');
  $('page').insertAdjacentHTML('beforeend',`<div class="modal" id="addStudentModal"><div class="modal-card"><h3>เพิ่มนักเรียนเข้าห้อง</h3><p class="muted">กรอกข้อมูลนักเรียน 1 คน ระบบจะลงทะเบียนเข้าห้องที่เลือกให้ทันที</p><div class="grid grid-2"><div class="field"><label>เลขที่ในห้อง *</label><input id="asClassNo" type="number" min="1" placeholder="เช่น 1"></div><div class="field"><label>เลขประจำตัวนักเรียน *</label><input id="asCode" placeholder="เช่น 10201"></div><div class="field"><label>คำนำหน้า</label><input id="asPrefix" placeholder="เช่น เด็กชาย"></div><div class="field"><label>ชื่อ *</label><input id="asFirst"></div><div class="field"><label>นามสกุล *</label><input id="asLast"></div><div class="field"><label>เพศ *</label><select id="asGender"><option value="ชาย">ชาย</option><option value="หญิง">หญิง</option><option value="อื่นๆ">อื่นๆ</option><option value="ไม่ระบุ">ไม่ระบุ</option></select></div></div><div class="toolbar" style="margin-top:12px"><button class="btn btn-primary" onclick="saveNewStudent()">บันทึกนักเรียน</button><button class="btn btn-secondary" onclick="closeModal('addStudentModal')">ยกเลิก</button></div></div></div>`);
  $('asClassNo')?.focus();
}
async function saveNewStudent(){
  const classId=$('classStudentSelect')?.value;if(!classId)return toast('กรุณาเลือกห้องก่อน');
  try{await call('addStudent',state.token,{classId,classNo:$('asClassNo').value,studentCode:$('asCode').value,prefix:$('asPrefix').value,firstName:$('asFirst').value,lastName:$('asLast').value,gender:$('asGender').value});closeModal('addStudentModal');toast('เพิ่มนักเรียนและลงทะเบียนเข้าห้องแล้ว',true);await loadStudentsGrid();}catch(e){toast(e.message);}
}

function editStudentModal(studentId){
  const s=(window._studentRows||[]).find(x=>x.studentId===studentId);if(!s)return;
  $('page').insertAdjacentHTML('beforeend',`<div class="modal" id="editStudentModal"><div class="modal-card"><h3>แก้ไขข้อมูลนักเรียน</h3><div class="grid grid-2"><div class="field"><label>เลขที่ในห้อง</label><input id="esClassNo" type="number" min="1" value="${escapeHtml(s.classNo)}"></div><div class="field"><label>เลขประจำตัวนักเรียน</label><input id="esCode" value="${escapeHtml(s.studentCode)}"></div><div class="field"><label>คำนำหน้า</label><input id="esPrefix" value="${escapeHtml(s.prefix||'')}"></div><div class="field"><label>ชื่อ</label><input id="esFirst" value="${escapeHtml(s.firstName)}"></div><div class="field"><label>นามสกุล</label><input id="esLast" value="${escapeHtml(s.lastName)}"></div><div class="field"><label>เพศ</label><select id="esGender"><option value="ชาย" ${s.gender==='ชาย'?'selected':''}>ชาย</option><option value="หญิง" ${s.gender==='หญิง'?'selected':''}>หญิง</option><option value="อื่นๆ" ${s.gender==='อื่นๆ'?'selected':''}>อื่นๆ</option><option value="ไม่ระบุ" ${(!s.gender||s.gender==='ไม่ระบุ')?'selected':''}>ไม่ระบุ</option></select></div></div><div class="toolbar" style="margin-top:12px"><button class="btn btn-primary" onclick="saveStudentEdit('${studentId}')">บันทึกการแก้ไข</button><button class="btn btn-secondary" onclick="closeModal('editStudentModal')">ยกเลิก</button></div></div></div>`);
}
async function saveStudentEdit(studentId){
  try{
    await call('updateStudent',state.token,{studentId,classId:window._studentClassId,classNo:$('esClassNo').value,studentCode:$('esCode').value,prefix:$('esPrefix').value,firstName:$('esFirst').value,lastName:$('esLast').value,gender:$('esGender').value});
    closeModal('editStudentModal');toast('บันทึกข้อมูลนักเรียนแล้ว',true);await loadStudentsGrid();
  }catch(e){toast(e.message);}
}
async function removeStudentNow(studentId){
  if(!confirm('นำนักเรียนคนนี้ออกจากห้องนี้? (ประวัติคะแนนเดิมจะยังอยู่)'))return;
  try{await call('removeClassMember',state.token,window._studentClassId,studentId);toast('นำออกจากห้องแล้ว',true);await loadStudentsGrid();}catch(e){toast(e.message);}
}
function openStudentPasteModal(){
  $('page').insertAdjacentHTML('beforeend',`<div class="modal" id="studentModal"><div class="modal-card"><h3>นำเข้ารายชื่อนักเรียน</h3><p class="muted">รองรับการวางจาก Excel (Tab) หรือไฟล์ .csv (Comma) รูปแบบ: เลขที่ | เลขประจำตัว | คำนำหน้า | ชื่อ | นามสกุล | เพศ (ชาย/หญิง/อื่นๆ/ไม่ระบุ)</p><textarea id="studentPaste" class="paste-box"></textarea><div class="toolbar" style="margin-top:12px"><input type="file" id="studentCsvFile" accept=".csv,text/csv" onchange="readFileInto('studentCsvFile','studentPaste')"><button class="btn btn-primary" onclick="importStudentsNow()">ตรวจสอบและบันทึก</button><button class="btn btn-secondary" onclick="closeModal('studentModal')">ยกเลิก</button></div></div></div>`);
}
async function importStudentsNow(){
  const cls=$('classStudentSelect').value;if(!cls)return toast('เลือกห้องก่อน');
  try{const r=await call('importStudents',state.token,cls,$('studentPaste').value);closeModal('studentModal');toast(`นำเข้า ${r.processed} คน`,true);await loadStudentsGrid();}catch(e){toast(e.message);}
}

/* ---------------- Subjects / Teaching assignments (admin) ---------------- */
async function renderSubjects(p){
  if(!state.me.roles.includes('ADMIN')){p.innerHTML='<div class="card">ไม่มีสิทธิ์</div>';return;}
  const [subs,users,classes,assigns,availability]=await Promise.all([call('getSubjects',state.token),call('getUsers',state.token),call('getClasses',state.token,state.period.year,state.period.term),call('getAllTeachingAssignments',state.token,state.period.year,state.period.term),call('getTeachingAvailability',state.token,state.period.year,state.period.term)]); window._teachingAvailability=availability||[];
  classes.splice(0,classes.length,...orderedClasses(classes));
  window._adminData={subs,users,classes};
  const teachers=users.filter(u=>u.roles.includes('TEACHER')||u.roles.includes('ADMIN'));
  const levelNames=['1','2','3'];
  const levelOptions=levelNames.map(l=>`<option value="${l}">ม.${l}</option>`).join('');
  const term1=levelNames.map(l=>renderCurriculumTable(l,'1',subs)).join('');
  const term2=levelNames.map(l=>renderCurriculumTable(l,'2',subs)).join('');
  const untagged=untaggedSubjects_(subs);
  const untaggedCard=untagged.length?`<div class="card" style="border-left:4px solid #e9c46a"><h3>⚠ วิชาที่ยังไม่ได้ระบุระดับชั้น/ภาคเรียน (${untagged.length})</h3><p class="section-note">วิชาพวกนี้ถูกสร้างไว้ใน SUBJECTS แล้วแต่ยังไม่รู้ว่าสังกัดระดับชั้น/ภาคเรียนไหน จึงยังไม่โผล่ในตาราง CURRICULUM ด้านล่างและเลือกมอบหมายผู้สอนไม่ได้ — กด "แก้ไข" แล้วเลือกระดับชั้น/ภาคเรียนให้ครบ</p><div class="table-wrap"><table class="data-table"><thead><tr><th>รหัส</th><th>ชื่อวิชา</th><th>ประเภท</th><th></th></tr></thead><tbody>${untagged.map(s=>`<tr><td>${escapeHtml(s.subjectCode)}</td><td class="l">${escapeHtml(s.subjectName)}</td><td>${escapeHtml(s.subjectType)}</td><td class="row-actions"><button class="btn-icon" title="แก้ไข" onclick='loadSubjectForEdit(${JSON.stringify(s).replace(/'/g,"&#39;")})'>✏️</button></td></tr>`).join('')}</tbody></table></div></div>`:'';
  const subjectOptions=availableSubjectsForLevel(state._assignLevel||'1',state.period.term,subs,classes).map(s=>`<option value="${s.subjectId}">${escapeHtml(s.code+' '+s.name)}</option>`).join('');
  p.innerHTML=`<h2>ตั้งค่าวิชาเรียน / มอบหมายผู้สอน</h2>
  <div class="period-banner">📅 ปีการศึกษา <b>${escapeHtml(state.period.year)}</b> · ภาคเรียน <b>${escapeHtml(state.period.term)}</b></div>
  <div class="card"><h3 id="subjectFormTitle">เพิ่มรายวิชา</h3><p class="muted" style="margin-top:-4px">รายวิชาในหลักสูตรก็สามารถแก้ไขได้: รหัสวิชา ชื่อวิชา ประเภท หน่วยกิต เวลาเรียน ระดับชั้น และภาคเรียน โดยระบบจะคงความเชื่อมโยงกับหลักสูตรเดิมไว้</p><input type="hidden" id="subId"><input type="hidden" id="subCurriculumCode"><div class="grid grid-2"><div class="field"><label>รหัสวิชา</label><input id="subCode"></div><div class="field"><label>ชื่อวิชา</label><input id="subName"></div><div class="field"><label>ประเภท</label><select id="subType"><option>พื้นฐาน</option><option>เพิ่มเติม</option></select></div><div class="field"><label>หน่วยกิต</label><input id="subCredit" type="number" step="0.5"></div><div class="field"><label>เวลาเรียน</label><input id="subHours" type="number"></div><div class="field"><label>ระดับชั้น</label><select id="subLevel"><option value="">- ใช้รหัสหลักสูตรมาตรฐานอยู่แล้ว -</option><option value="1">ม.1</option><option value="2">ม.2</option><option value="3">ม.3</option></select></div><div class="field"><label>ภาคเรียน</label><select id="subTerm"><option value="">ทั้ง 2 ภาคเรียน</option><option value="1">ภาคเรียนที่ 1</option><option value="2">ภาคเรียนที่ 2</option></select></div></div><p class="section-note">รายวิชามาตรฐานที่กดแก้ไขจะยังเชื่อมกับหลักสูตรเดิม แม้เปลี่ยนรหัสหรือชื่อ และสามารถย้ายภาคเรียนได้; ส่วนวิชาที่เพิ่มเอง ให้ระบุระดับชั้นและภาคเรียนเพื่อให้แสดงในตารางหลักสูตรและใช้มอบหมายผู้สอนได้</p><div class="toolbar"><button class="btn btn-primary" id="subSaveBtn" onclick="saveSubjectForm()">เพิ่มวิชา</button><button class="btn btn-secondary" id="subCancelBtn" onclick="resetSubjectForm()" style="display:none">ยกเลิกแก้ไข</button></div></div>
  <div class="card curriculum-card"><div class="section-heading curriculum-toggle" onclick="toggleCurriculumCard(this)"><div><span class="section-kicker">CURRICULUM</span><h3>รายวิชา ภาคเรียนที่ 1</h3></div><span class="soft-badge">ม.1 · ม.2 · ม.3</span><span class="curriculum-chevron">▾</span></div><div class="curriculum-grid">${term1}</div></div>
  <div class="card curriculum-card"><div class="section-heading curriculum-toggle" onclick="toggleCurriculumCard(this)"><div><span class="section-kicker">CURRICULUM</span><h3>รายวิชา ภาคเรียนที่ 2</h3></div><span class="soft-badge">ม.1 · ม.2 · ม.3</span><span class="curriculum-chevron">▾</span></div><div class="curriculum-grid">${term2}</div></div>
  ${untaggedCard}
  <div class="card"><h3>มอบหมายครูผู้สอน (แบบเร็ว)</h3><p class="muted">เลือกวิธีที่สะดวกกว่า — ไม่ต้องมอบหมายทีละห้อง</p>
    <div class="tabs"><button class="tab-btn active" id="tabBySubjectBtn" onclick="switchAssignTab('bySubject')">📘 วิชาเป็นตัวตั้ง · ทั้งระดับชั้น</button><button class="tab-btn" id="tabByTeacherBtn" onclick="switchAssignTab('byTeacher')">👤 ครูเป็นตัวตั้ง · หลายวิชา × หลายห้อง</button></div>
    <div id="tabBySubject"><div class="grid grid-2"><div class="field"><label>ระดับชั้น</label><select id="baLevel" onchange="updateQuickSubjectList()">${levelOptions}</select></div><div class="field"><label>วิชาในระดับชั้น</label><select id="baSubject">${subjectOptions}</select></div><div class="field"><label>ครูผู้สอน</label><select id="baTeacher">${teachers.map(u=>`<option value="${u.userId}">${escapeHtml(u.fullName)}</option>`).join('')}</select></div><div class="field"><label>คะแนนเต็ม</label><input id="baScoreMax" type="number" value="100"></div></div><p class="muted quick-note">ระบบจะมอบหมายวิชาที่เลือกให้ทุกห้องของระดับชั้นนั้นในปี/เทอมที่เลือกด้านบน</p><div class="toolbar"><button class="btn btn-primary" onclick="doBulkAssignSubjectToLevel()">มอบหมายทั้งระดับชั้น</button></div></div>
    <div id="tabByTeacher" class="hidden"><div class="field"><label>ครูผู้สอน</label><select id="btTeacher">${teachers.map(u=>`<option value="${u.userId}">${escapeHtml(u.fullName)}</option>`).join('')}</select></div><div class="grid grid-2"><div class="field"><label>ระดับชั้น</label><select id="btLevel" onchange="updateTeacherQuickLists()">${levelOptions}</select></div><div class="field"><label>วิชาที่สอน (เลือกได้หลายวิชา)</label><div id="btSubjectList" class="check-list">${renderTeacherSubjectChecks('1',state.period.term,subs)}</div></div><div class="field"><label>ห้องที่สอน (เลือกได้หลายห้อง)</label><div id="btClassList" class="check-list">${orderedClasses(classes).filter(c=>getClassLevelKey_(c)==='1').map(c=>`<label class="check-item"><input type="checkbox" class="bt-class" value="${c.classId}"> ${escapeHtml(c.className)}</label>`).join('')}</div></div></div><div class="field" style="max-width:200px"><label>คะแนนเต็ม</label><input id="btScoreMax" type="number" value="100"></div><div class="toolbar"><button class="btn btn-primary" onclick="doBulkAssignTeacherToClasses()">มอบหมายตามที่เลือก</button></div></div>
    <div class="toolbar"><span class="spacer"></span><button class="btn btn-secondary" onclick="downloadCsv('เทมเพลต_มอบหมายผู้สอน.csv',CSV_TEMPLATES.teaching)">⬇ เทมเพลต CSV</button><button class="btn btn-secondary" onclick="openCsvImportModal('มอบหมายผู้สอน','importTeachingAssignmentsCsv',()=>renderSubjects($('page')))">⬆ นำเข้า CSV</button></div>
    ${bulkBarHtml('assignTable',"bulkDeleteWith('assignTable','deleteTeachingAssignment',()=>renderSubjects($('page')))" )}
    <div class="table-wrap" style="margin-top:10px"><table class="data-table" id="assignTable"><thead><tr><th><input type="checkbox" onchange="toggleAllBulk(this,'assignTable')"></th><th>ห้อง</th><th>วิชา</th><th>ครูผู้สอน</th><th>เต็ม</th><th></th></tr></thead><tbody>${assigns.map(a=>`<tr><td><input type="checkbox" class="bulk-check" value="${a.assignmentId}" onchange="updateBulkBar('assignTable')"></td><td>${escapeHtml(a.className)}</td><td>${escapeHtml(a.subjectCode+' '+a.subjectName)}</td><td>${escapeHtml(a.teacherName)}</td><td>${a.scoreMax}</td><td class="row-actions"><button class="btn-icon" title="แก้ไขครู/คะแนนเต็ม" onclick='editAssignmentModal(${JSON.stringify(a).replace(/'/g,"&#39;")})'>✏️</button><button class="btn-icon" title="ลบ" onclick="deleteAssignmentNow('${a.assignmentId}')">🗑️</button></td></tr>`).join('')||'<tr><td colspan="6" class="muted center">ยังไม่มีการมอบหมายในช่วงการศึกษานี้</td></tr>'}</tbody></table></div>
  </div>`;
  state._assignLevel='1';
}
function toggleCurriculumCard(headerEl){const card=headerEl.closest('.curriculum-card');if(card)card.classList.toggle('collapsed');}
function renderCurriculumTable(level,term,subs){const rows=curriculumRows(level,term,subs);return `<div class="curriculum-table-card"><div class="curriculum-title">ม.${level}</div><div class="table-wrap"><table class="data-table curriculum-table"><thead><tr><th>รหัส</th><th>รายวิชา</th><th>ประเภท</th><th>นก.</th><th>ชม.</th><th>จัดการ</th></tr></thead><tbody>${rows.map(r=>`<tr${r.extra?' class="curriculum-extra-row"':''}><td>${escapeHtml(r.code)}</td><td class="l">${escapeHtml(r.name)}${r.extra?' <span class="soft-badge" title="วิชาที่เพิ่มเองนอกหลักสูตรมาตรฐาน">ใหม่</span>':''}</td><td>${escapeHtml(r.type)}</td><td>${r.credit}</td><td>${r.hours}</td><td class="row-actions">${r.subjectId?`<button class="btn-icon" title="แก้ไข" onclick='loadSubjectForEdit(${JSON.stringify({subjectId:r.subjectId,subjectCode:r.code,subjectName:r.name,subjectType:r.type,credit:r.credit,hours:r.hours,level:r.level,term:r.term,curriculumCode:r.curriculumCode||''}).replace(/'/g,"&#39;")})'>✏️</button><button class="btn-icon" title="ลบ" onclick="deleteSubjectNow('${r.subjectId}')">🗑️</button>`:`<button class="btn-icon" title="ยังไม่มีวิชานี้ในฐานข้อมูล — กดเพื่อเพิ่มตามหลักสูตรนี้" onclick='quickAddCurriculumSubject(${JSON.stringify({subjectCode:r.code,subjectName:r.name,subjectType:r.type,credit:r.credit,hours:r.hours,level:r.level,term:r.term,curriculumCode:r.curriculumCode||r.code}).replace(/'/g,"&#39;")})'>➕</button>`}</td></tr>`).join('')}</tbody></table></div></div>`;}
function renderTeacherSubjectChecks(level,term,subs){const classes=window._adminData?.classes||[];return availableSubjectsForLevel(level,term,subs,classes).map(s=>`<label class="check-item"><input type="checkbox" class="bt-subject" value="${s.subjectId}"> ${escapeHtml(s.code+' '+s.name)}</label>`).join('')||`<span class="muted">${noSubjectHint_(level,classes)||'ไม่พบวิชาที่ว่างในระดับชั้นนี้'}</span>`;}
function updateQuickSubjectList(){const level=$('baLevel').value;state._assignLevel=level;const subs=window._adminData.subs||[];const classes=window._adminData.classes||[];$('baSubject').innerHTML=availableSubjectsForLevel(level,state.period.term,subs,classes).map(s=>`<option value="${s.subjectId}">${escapeHtml(s.code+' '+s.name)}</option>`).join('')||'<option value="">ไม่มีวิชาที่ว่าง</option>';updateTeacherQuickLists();}
function getClassLevelKey_(c){
  const lv=String(c&&c.level||'').trim();
  if(/^ม\.[1-3]$/.test(lv)) return lv.slice(2);
  const nm=String(c&&c.className||'').trim();
  const m=nm.match(/^ม\.([1-3])\/\d+/);
  return m?m[1]:lv.replace(/\D/g,'');
}
function updateTeacherQuickLists(){const level=String($('btLevel').value||'');const subs=window._adminData.subs||[];const classes=orderedClasses(window._adminData.classes||[]);$('btSubjectList').innerHTML=renderTeacherSubjectChecks(level,state.period.term,subs);const available=availableSubjectsForLevel(level,state.period.term,subs,classes);const filtered=classes.filter(c=>getClassLevelKey_(c)===level&&available.some(s=>!isTeachingOccupied(s.subjectId,c.classId)));$('btClassList').innerHTML=filtered.map(c=>`<label class="check-item"><input type="checkbox" class="bt-class" value="${c.classId}"> ${escapeHtml(c.className)}</label>`).join('')||'<span class="muted">ไม่พบห้องที่ยังว่าง</span>';}
function switchAssignTab(which){
  $('tabBySubject').classList.toggle('hidden',which!=='bySubject');
  $('tabByTeacher').classList.toggle('hidden',which!=='byTeacher');
  $('tabBySubjectBtn').classList.toggle('active',which==='bySubject');
  $('tabByTeacherBtn').classList.toggle('active',which==='byTeacher');
}
async function doBulkAssignSubjectToLevel(){
  try{const r=await call('bulkAssignSubjectToLevel',state.token,{level:$('baLevel').value,subjectId:$('baSubject').value,teacherUserId:$('baTeacher').value,scoreMax:$('baScoreMax').value,academicYear:state.period.year,term:state.period.term});toast(`มอบหมายแล้ว ${r.count} ห้อง`,true);await renderSubjects($('page'));}catch(e){toast(e.message);}
}
async function doBulkAssignTeacherToClasses(){
  const subjectIds=[...document.querySelectorAll('.bt-subject:checked')].map(cb=>cb.value);
  const classIds=[...document.querySelectorAll('.bt-class:checked')].map(cb=>cb.value);
  if(!subjectIds.length||!classIds.length)return toast('กรุณาเลือกอย่างน้อย 1 วิชา และ 1 ห้อง');
  try{const r=await call('bulkAssignTeacherToClasses',state.token,{teacherUserId:$('btTeacher').value,subjectIds,classIds,scoreMax:$('btScoreMax').value,academicYear:state.period.year,term:state.period.term});toast(`มอบหมายแล้ว ${r.count} รายการ`,true);await renderSubjects($('page'));}catch(e){toast(e.message);}
}
function editAssignmentModal(a){
  const teachers=(window._adminData.users||[]).filter(u=>u.roles.includes('TEACHER')||u.roles.includes('ADMIN'));
  $('page').insertAdjacentHTML('beforeend',`<div class="modal" id="editAssignModal"><div class="modal-card"><h3>แก้ไข: ${escapeHtml(a.subjectCode+' '+a.subjectName)} · ${escapeHtml(a.className)}</h3><div class="field"><label>ครูผู้สอน</label><select id="eaTeacher">${teachers.map(u=>`<option value="${u.userId}" ${u.userId===a.teacherUserId?'selected':''}>${escapeHtml(u.fullName)}</option>`).join('')}</select></div><div class="field"><label>คะแนนเต็ม</label><input id="eaScoreMax" type="number" value="${a.scoreMax}"></div><div class="toolbar"><button class="btn btn-primary" onclick="saveAssignmentEdit('${a.assignmentId}','${a.classId}','${a.subjectId}')">บันทึก</button><button class="btn btn-secondary" onclick="closeModal('editAssignModal')">ยกเลิก</button></div></div></div>`);
}
async function saveAssignmentEdit(assignmentId,classId,subjectId){
  try{await call('assignTeacher',state.token,{assignmentId,classId,subjectId,teacherUserId:$('eaTeacher').value,scoreMax:$('eaScoreMax').value,academicYear:state.period.year,term:state.period.term});closeModal('editAssignModal');toast('บันทึกแล้ว',true);await renderSubjects($('page'));}catch(e){toast(e.message);}
}
function loadSubjectForEdit(s){
  const subjectId=String(s&&s.subjectId||'').trim();
  if(!subjectId)return toast('ไม่พบรหัสอ้างอิงของวิชานี้ — ไม่สามารถเปิดโหมดแก้ไขได้');
  state.subjectEdit={id:subjectId,curriculumCode:String(s.curriculumCode||'').trim()};
  $('subId').value=subjectId;$('subCurriculumCode').value=String(s.curriculumCode||'');$('subCode').value=s.subjectCode||'';$('subName').value=s.subjectName||'';$('subType').value=s.subjectType||'พื้นฐาน';$('subCredit').value=s.credit??'';$('subHours').value=s.hours??'';$('subLevel').value=s.level||'';$('subTerm').value=s.term||'';
  $('subjectFormTitle').textContent='แก้ไขรายวิชา: '+(s.subjectName||'');$('subSaveBtn').textContent='บันทึกการแก้ไข';$('subCancelBtn').style.display='';
  window.scrollTo({top:0,behavior:'smooth'});
}
function resetSubjectForm(){['subId','subCurriculumCode','subCode','subName','subCredit','subHours'].forEach(id=>$(id).value='');$('subType').value='พื้นฐาน';$('subLevel').value='';$('subTerm').value='';$('subjectFormTitle').textContent='เพิ่มรายวิชา';$('subSaveBtn').textContent='เพิ่มวิชา';$('subCancelBtn').style.display='none';state.subjectEdit=null;}
async function saveSubjectForm(){
  try{
    const editId=String(state.subjectEdit?.id||$('subId').value||'').trim();
    const isEdit=!!state.subjectEdit;
    if(isEdit&&!editId)return toast('ไม่พบ SubjectID ของวิชาที่กำลังแก้ไข — ยกเลิกการบันทึกเพื่อป้องกันการสร้างวิชาใหม่');
    const payload={mode:isEdit?'update':'create',subjectId:editId||undefined,subjectCode:$('subCode').value,subjectName:$('subName').value,subjectType:$('subType').value,credit:$('subCredit').value,hours:$('subHours').value,level:$('subLevel').value,term:$('subTerm').value,curriculumCode:$('subCurriculumCode')?.value||state.subjectEdit?.curriculumCode||undefined};
    await call('saveSubject',state.token,payload);
    toast(isEdit?'แก้ไขวิชาเดิมเรียบร้อยแล้ว':'เพิ่มวิชาแล้ว',true);
    state.subjectEdit=null;
    await renderSubjects($('page'));
  }catch(e){toast(e.message);}
}
// วิชาในตาราง CURRICULUM ที่ขึ้น "ไม่พบในฐานข้อมูล" คือวิชาที่มีอยู่ในหลักสูตร (CURRICULUM_ ฝั่ง
// Code.gs) แต่ยังไม่เคยถูกสร้างเป็นแถวจริงในชีต SUBJECTS จึงไม่มี subjectId ให้กดแก้ไข/ลบได้ —
// ปุ่มนี้สร้างวิชานั้นเข้า SUBJECTS ทันทีโดยใช้รหัส/ชื่อ/ประเภท/หน่วยกิต/ชม. ตามหลักสูตร แล้ว
// รีเฟรชหน้า เพื่อให้แถวนั้นมี subjectId และใช้งาน (มอบหมายผู้สอน ฯลฯ) ได้ทันที
async function quickAddCurriculumSubject(s){
  try{
    await call('saveSubject',state.token,{subjectCode:s.subjectCode,subjectName:s.subjectName,subjectType:s.subjectType,credit:s.credit,hours:s.hours,level:s.level||'',term:s.term||'',curriculumCode:s.curriculumCode||undefined});
    toast('เพิ่มวิชา '+s.subjectName+' เข้าระบบแล้ว',true);
    await renderSubjects($('page'));
  }catch(e){
    // "รหัสวิชานี้มีอยู่แล้ว" = รหัสนี้มีแถวจริงใน SUBJECTS อยู่แล้ว (เช่น เคยพิมพ์/นำเข้ามาก่อน
    // ด้วยช่องว่าง/ตัวพิมพ์ต่างไปเล็กน้อยจนตาราง CURRICULUM จับคู่อัตโนมัติไม่เจอ) แทนที่จะปล่อยเป็น
    // ทางตัน ให้ค้นหาวิชานั้นจริงๆ แล้วเปิดฟอร์ม "แก้ไข" ของวิชาเดิมให้เลย ถือเป็นการซิงค์เข้าด้วยกัน
    // ครูจะเห็นค่าปัจจุบันแล้วกดบันทึกเพื่อปรับชื่อ/หน่วยกิต/ชม. ให้ตรงหลักสูตรได้ทันที
    if(String(e.message||'').includes('มีอยู่แล้ว')){
      try{
        const subs=await call('getSubjects',state.token);
        const match=subs.find(x=>String(x.subjectCode).trim().toLowerCase()===String(s.subjectCode).trim().toLowerCase());
        if(match){
          toast('รหัส '+s.subjectCode+' มีวิชานี้อยู่แล้วในระบบ — เปิดฟอร์มแก้ไขให้เลือกปรับ/ซิงค์ค่าตามหลักสูตรนี้',true);
          await renderSubjects($('page'));
          loadSubjectForEdit(match);
          return;
        }
      }catch(e2){/* fall through to raw error below */}
    }
    toast(e.message);
  }
}
async function deleteSubjectNow(subjectId){
  if(!confirm('ลบรายวิชานี้?'))return;
  try{await call('deleteSubject',state.token,subjectId);toast('ลบวิชาแล้ว',true);await renderSubjects($('page'));}catch(e){toast(e.message);}
}
async function deleteAssignmentNow(assignmentId){
  if(!confirm('ยกเลิกการมอบหมายนี้?'))return;
  try{await call('deleteTeachingAssignment',state.token,assignmentId);toast('ยกเลิกการมอบหมายแล้ว',true);await renderSubjects($('page'));}catch(e){toast(e.message);}
}

/* ---------------- Teacher self-registration ---------------- */
function teacherLevelOptions(){
  return ['1','2','3'].map(l=>`<option value="${l}">ม.${l}</option>`).join('');
}
function renderMyTeachingSubjectChecks(level,term,subs){const classes=window._myTeachingData?.classes||[];const selected=[...document.querySelectorAll('.my-teach-class:checked')].map(x=>x.value);return curriculumRows(level,term,subs).filter(s=>s.subjectId&&classes.some(c=>getClassLevelKey_(c)===String(level)&&(!selected.length||selected.includes(String(c.classId)))&&!isTeachingOccupied(s.subjectId,c.classId))).map(s=>`<label class="check-item"><input type="checkbox" class="my-teach-subject" value="${s.subjectId}"> ${escapeHtml(s.code+' '+s.name)}</label>`).join('')||`<span class="muted">${noSubjectHint_(level,classes)||'ไม่พบวิชาที่ว่างในห้องที่เลือก'}</span>`;}
function renderTeacherClassChecks(level,classes){const selected=[...document.querySelectorAll('.my-teach-subject:checked')].map(x=>x.value);return orderedClasses(classes).filter(c=>getClassLevelKey_(c)===String(level)&&(!selected.length||selected.some(sid=>!isTeachingOccupied(sid,c.classId)))).map(c=>`<label class="check-item"><input type="checkbox" class="my-teach-class" value="${c.classId}"> ${escapeHtml(c.className)}</label>`).join('')||'<span class="muted">ไม่พบห้องที่ยังว่างสำหรับวิชาที่เลือก</span>';}
function updateMyTeachingLists(){
  const level=String($('myTeachLevel').value||'1');
  const subs=window._myTeachingData?.subs||[];
  const classes=orderedClasses(window._myTeachingData?.classes||[]);
  $('myTeachSubjectList').innerHTML=renderMyTeachingSubjectChecks(level,state.period.term,subs);
  $('myTeachClassList').innerHTML=renderTeacherClassChecks(level,classes);
  updateMyTeachingCounts();
}
function updateMyTeachingCounts(){
  const sc=document.querySelectorAll('.my-teach-subject:checked').length;
  const cc=document.querySelectorAll('.my-teach-class:checked').length;
  const el=$('myTeachSelectionInfo');
  if(el) el.textContent=`เลือก ${sc} วิชา × ${cc} ห้อง = ${sc*cc} รายการ`;
}
function toggleMyTeachingChecks(selector,checked){document.querySelectorAll(selector).forEach(cb=>cb.checked=checked);updateMyTeachingCounts();}
async function renderMyTeaching(p){
  if(state.me.roles.includes('ADMIN')){p.innerHTML='<div class="card"><h2>ลงทะเบียนวิชาที่สอน</h2><p class="muted">ผู้ดูแลระบบใช้เมนูตั้งค่าวิชา / ผู้สอนได้โดยตรง</p></div>';return;}
  const [subs,classes,assigns,availability,activityAssigns]=await Promise.all([call('getSubjects',state.token),call('getClasses',state.token,state.period.year,state.period.term),call('getTeacherAssignments',state.token,state.period.year,state.period.term),call('getTeachingAvailability',state.token,state.period.year,state.period.term),call('getActivityAssignments',state.token,state.period.year,state.period.term)]); window._teachingAvailability=availability||[];
  window._myTeachingData={subs,classes,assigns};
  const myClubs=(activityAssigns||[]).filter(a=>a.crossClass);
  const level='1';
  const myName=escapeHtml(state.me.fullName||'');
  const clubRows=myClubs.map(c=>`<tr><td>${escapeHtml(c.activityName)}${c.groupName?' — '+escapeHtml(c.groupName):''}</td><td class="row-actions"><button class="btn btn-secondary" onclick="go('clubRegister')">👥 จัดการสมาชิก</button> <button class="btn btn-secondary" onclick="go('activities')">📝 กรอกผลกิจกรรม</button></td></tr>`).join('')||'<tr><td colspan="2" class="muted center">ยังไม่มีชุมนุมที่ท่านลงทะเบียน</td></tr>';
  p.innerHTML=`<h2>ลงทะเบียนวิชาที่สอน</h2>
  <p class="sub">เลือกช่วงการศึกษาจากด้านบน แล้วเลือกวิชาและชั้น/ห้องที่ท่านรับผิดชอบ</p>
  <div class="card">
    <div class="section-heading"><div><span class="section-kicker">TEACHER SELF REGISTRATION</span><h3>มอบหมายวิชาที่สอน (แบบเร็ว)</h3></div><span class="soft-badge">ปี ${escapeHtml(state.period.year)} · เทอม ${escapeHtml(state.period.term)}</span></div>
    <p class="muted quick-note">เลือกวิธีที่สะดวกกว่า — ไม่ต้องลงทะเบียนทีละห้อง</p>
    <div class="tabs teacher-self-tabs">
      <button class="tab-btn active" type="button">👤 ครูเป็นตัวตั้ง · หลายวิชา × หลายห้อง</button>
    </div>
    <div class="teacher-self-summary"><span>👤 ครูผู้สอน</span><b>${myName}</b><span class="summary-divider">•</span><span id="myTeachSelectionInfo">เลือก 0 วิชา × 0 ห้อง = 0 รายการ</span></div>
    <div class="grid grid-2 teacher-self-grid">
      <div class="field"><label>ระดับชั้น</label><select id="myTeachLevel" onchange="updateMyTeachingLists()">${teacherLevelOptions()}</select></div>
      <div class="field"><label>คะแนนเต็ม</label><input id="myTeachScoreMax" type="number" value="100" min="1"></div>
    </div>
    <div class="grid grid-2 teacher-check-columns">
      <div class="field"><label>📘 วิชาที่สอน (เลือกได้หลายวิชา)</label><div class="selection-head"><span class="muted">เลือกวิชาในระดับชั้นที่กำหนด</span><button class="link-btn" type="button" onclick="toggleMyTeachingChecks('.my-teach-subject',true)">เลือกทั้งหมด</button><button class="link-btn" type="button" onclick="toggleMyTeachingChecks('.my-teach-subject',false)">ล้าง</button></div><div id="myTeachSubjectList" class="check-list">${renderMyTeachingSubjectChecks(level,state.period.term,subs)}</div></div>
      <div class="field"><label>🏫 ห้องที่สอน (เลือกได้หลายห้อง)</label><div class="selection-head"><span class="muted">เรียง ม.1/1 → ม.3/3</span><button class="link-btn" type="button" onclick="toggleMyTeachingChecks('.my-teach-class',true)">เลือกทั้งหมด</button><button class="link-btn" type="button" onclick="toggleMyTeachingChecks('.my-teach-class',false)">ล้าง</button></div><div id="myTeachClassList" class="check-list">${renderTeacherClassChecks(level,classes)}</div></div>
    </div>
    <div class="toolbar" style="margin-top:14px"><button class="btn btn-primary btn-lg" onclick="registerMyTeachingBatch()">＋ ลงทะเบียนตามที่เลือก</button></div>
  </div>
  <div class="card" style="margin-top:16px"><div class="section-heading"><h3>รายการที่ลงทะเบียนแล้ว</h3><span class="soft-badge">${assigns.length} รายการ</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>ปี</th><th>ภาคเรียน</th><th>ชั้น/ห้อง</th><th>วิชา</th><th>เต็ม</th></tr></thead><tbody>${assigns.map(a=>`<tr><td>${escapeHtml(a.academicYear)}</td><td>${escapeHtml(a.term)}</td><td>${escapeHtml(a.className)}</td><td>${escapeHtml(a.subjectCode+' '+a.subjectName)}</td><td>${a.scoreMax}</td></tr>`).join('')||'<tr><td colspan="5" class="muted center">ยังไม่มีรายการ</td></tr>'}</tbody></table></div></div>
  <div class="card" style="margin-top:16px">
    <div class="section-heading"><div><span class="section-kicker">CLUB / ชุมนุม</span><h3>ชุมนุมของฉัน</h3></div><span class="soft-badge">ปี ${escapeHtml(state.period.year)} · เทอม ${escapeHtml(state.period.term)}</span></div>
    <p class="muted quick-note">เพิ่มชุมนุมที่ท่านรับผิดชอบเองได้จากที่นี่ โดยไม่ต้องรอผู้ดูแลระบบ (ชุมนุมเป็นกิจกรรมคละห้อง สมาชิกเลือกได้จากทุกชั้น)</p>
    <div class="grid grid-2">
      <div class="field"><label>ชื่อชุมนุม</label><input id="myClubName" placeholder="เช่น ชุมนุมคอมพิวเตอร์"></div>
    </div>
    <div class="toolbar"><button class="btn btn-primary" onclick="registerMyClub()">➕ เพิ่มชุมนุมของฉัน</button></div>
    <div class="table-wrap" style="margin-top:10px"><table class="data-table"><thead><tr><th>ชุมนุม</th><th>จัดการต่อ</th></tr></thead><tbody>${clubRows}</tbody></table></div>
  </div>`;
  updateMyTeachingCounts();
}
async function registerMyClub(){
  const groupName=$('myClubName').value.trim();
  if(!groupName)return toast('กรุณากรอกชื่อชุมนุม');
  try{
    await call('registerMyClub',state.token,{groupName,academicYear:state.period.year,term:state.period.term});
    toast('เพิ่มชุมนุมแล้ว ไปที่ "ลงทะเบียนนักเรียนชุมนุม" เพื่อเลือกสมาชิก',true);
    await renderMyTeaching($('page'));
  }catch(e){toast(e.message);}
}
async function registerMyTeachingBatch(){
  const subjectIds=[...document.querySelectorAll('.my-teach-subject:checked')].map(cb=>cb.value);
  const classIds=[...document.querySelectorAll('.my-teach-class:checked')].map(cb=>cb.value);
  if(!subjectIds.length||!classIds.length)return toast('กรุณาเลือกอย่างน้อย 1 วิชา และ 1 ห้อง');
  try{
    const r=await call('registerMyTeachingBatch',state.token,{subjectIds,classIds,scoreMax:$('myTeachScoreMax').value,academicYear:state.period.year,term:state.period.term});
    toast(`ลงทะเบียนแล้ว ${r.count} รายการ${r.skipped?` · ข้าม ${r.skipped} รายการที่มีครูแล้ว`:''}`,true);
    await renderMyTeaching($('page'));
  }catch(e){toast(e.message);}
}
async function registerMyTeaching(){return registerMyTeachingBatch();}

/* ---------------- Activities (teacher entry) ---------------- */
async function renderActivities(p){
  const aas=await call('getActivityAssignments',state.token,state.period.year,state.period.term);
  p.innerHTML=`<h2>กิจกรรมพัฒนาผู้เรียน</h2>${periodBannerHtml()}<div class="card"><div class="toolbar score-toolbar entry-toolbar"><select id="activitySelect" onchange="loadActivityGrid()"><option value="">-- เลือกกิจกรรม / ห้อง --</option>${aas.map(a=>`<option value="${a.activityAssignmentId}">${escapeHtml(a.activityName+(a.groupName?' ('+a.groupName+')':'')+(a.className?' · '+a.className:' · คละห้อง'))}</option>`).join('')}</select><button id="pasteActivityBtn" class="btn btn-secondary" onclick="openActivityPasteModal()">📋 นำเข้า/วางผลจาก Excel</button><button id="editActivityBtn" class="btn btn-secondary" onclick="enableActivityEditing()" disabled>✏️ แก้ไขผลกิจกรรม</button><button id="saveActivityBtn" class="btn btn-primary" onclick="saveActivityGrid()" disabled>💾 บันทึกผล</button><button id="clearActivityBtn" class="btn btn-danger" onclick="clearActivityGrid()" disabled>🧹 ล้างผล</button></div><div id="activityModeInfo"></div><div id="activityInfo"></div><div id="activityGrid" class="table-wrap"></div></div>`;
  window._activityAssignments=aas;
}
function activityRowsHaveData(rows){return (rows||[]).some(r=>String(r.result??'').trim()!==''||String(r.score??'').trim()!=='');}
function setActivityInputsDisabled(disabled){document.querySelectorAll('#activityGrid .act-result,#activityGrid .act-score').forEach(el=>{el.disabled=disabled;el.classList.toggle('score-locked',disabled);});}
function updateActivityModeUi(hasSaved){
  const edit=$('editActivityBtn'),save=$('saveActivityBtn'),clear=$('clearActivityBtn'); if(!edit||!save||!clear)return;
  if(hasSaved){edit.disabled=false;save.disabled=true;clear.disabled=false;setActivityInputsDisabled(true);if($('activityModeInfo'))$('activityModeInfo').innerHTML='<div class="alert-inline alert-ok score-mode-badge">🔒 บันทึกแล้ว — กด “แก้ไขผลกิจกรรม” ก่อนปรับข้อมูล</div>';}
  else{edit.disabled=true;save.disabled=false;clear.disabled=false;setActivityInputsDisabled(false);if($('activityModeInfo'))$('activityModeInfo').innerHTML='<div class="alert-inline alert-ok score-mode-badge">✍️ พร้อมกรอก/แก้ไขผลกิจกรรม</div>';}
}
function enableActivityEditing(showMessage=true){
  if(!$('activitySelect')?.value)return toast('กรุณาเลือกกิจกรรมก่อน');
  if(!$('activityGrid')?.querySelector('tbody tr'))return toast('ยังไม่มีรายชื่อนักเรียนในกิจกรรม');
  setActivityInputsDisabled(false);if($('editActivityBtn'))$('editActivityBtn').disabled=true;if($('saveActivityBtn'))$('saveActivityBtn').disabled=false;if($('clearActivityBtn'))$('clearActivityBtn').disabled=false;
  if($('activityModeInfo'))$('activityModeInfo').innerHTML='<div class="alert-inline alert-ok score-mode-badge">✏️ อยู่ในโหมดแก้ไข — ตรวจข้อมูลแล้วกด “บันทึกผล”</div>';
  if(showMessage)toast('เปิดโหมดแก้ไขผลกิจกรรมแล้ว',true);
}
async function loadActivityGrid(){
  const id=$('activitySelect').value;if(!id){$('activityGrid').innerHTML='';if($('saveActivityBtn'))$('saveActivityBtn').disabled=true;if($('editActivityBtn'))$('editActivityBtn').disabled=true;if($('clearActivityBtn'))$('clearActivityBtn').disabled=true;return;}
  $('activityGrid').innerHTML='';$('activityGrid').appendChild(showSpinner());
  const d=await call('getActivityEntry',state.token,id);window._activityData=d;
  const hasSaved=activityRowsHaveData(d.rows);
  const showClass=d.assignment.crossClass;
  $('activityInfo').innerHTML=`<div class="alert-inline alert-ok">${escapeHtml(d.assignment.activityName)}${d.assignment.className?' · '+escapeHtml(d.assignment.className):' · คละห้อง'}${hasSaved?' · มีข้อมูลที่บันทึกแล้ว':''}</div>`;
  $('activityGrid').innerHTML=`<table class="data-table"><thead>${periodHeadRow(showClass?6:5)}<tr><th>ที่</th>${showClass?'<th>ห้อง</th>':''}<th>เลขประจำตัว</th><th>ชื่อ-สกุล</th><th>ผล</th><th>คะแนน</th></tr></thead><tbody>${d.rows.map(r=>`<tr data-aeid="${r.activityEnrollmentId}"><td>${r.classNo}</td>${showClass?`<td>${escapeHtml(r.className)}</td>`:''}<td>${escapeHtml(r.studentCode)}</td><td>${escapeHtml(r.name)}</td><td><select class="act-result"><option value="">-</option><option value="ผ" ${r.result==='ผ'?'selected':''}>ผ</option><option value="มผ" ${r.result==='มผ'?'selected':''}>มผ</option></select></td><td><input class="act-score score-input" type="number" min="0" step="0.01" value="${r.score??''}"></td></tr>`).join('')}</tbody></table>`;
  updateActivityModeUi(hasSaved);
}
async function saveActivityGrid(){
  const id=$('activitySelect').value;if(!id)return toast('กรุณาเลือกกิจกรรมก่อน');
  const btn=$('saveActivityBtn');if(btn){btn.disabled=true;btn.textContent='กำลังบันทึก...';}
  const rows=[...document.querySelectorAll('#activityGrid tbody tr')].map(tr=>({activityEnrollmentId:tr.dataset.aeid,result:tr.querySelector('.act-result').value,score:tr.querySelector('.act-score').value,remark:''}));
  try{const r=await call('saveActivityResults',state.token,{activityAssignmentId:id,rows});toast('บันทึก '+r.saved+' รายการเรียบร้อย',true);await loadActivityGrid();}catch(e){toast(e.message);}finally{if(btn){btn.disabled=false;btn.textContent='💾 บันทึกผล';}}
}
async function clearActivityGrid(){
  const id=$('activitySelect')?.value;if(!id)return toast('กรุณาเลือกกิจกรรมก่อน');
  const name=$('activitySelect').options[$('activitySelect').selectedIndex]?.text||'กิจกรรมที่เลือก';
  if(!confirm(`ต้องการล้างผลกิจกรรมทั้งหมดของ ${name} ใช่หรือไม่?\n\nระบบจะล้างผล ผ/มผ คะแนน และหมายเหตุของนักเรียนในกิจกรรมนี้ แต่จะไม่ลบรายชื่อสมาชิก`))return;
  const btn=$('clearActivityBtn');if(btn){btn.disabled=true;btn.textContent='กำลังล้าง...';}
  try{const r=await call('clearActivityResults',state.token,id);toast('ล้างผลกิจกรรมแล้ว '+(r.cleared||0)+' รายการ',true);await loadActivityGrid();}catch(e){toast(e.message);}finally{if(btn){btn.disabled=false;btn.textContent='🧹 ล้างผล';}}
}
function openActivityPasteModal(){
  if(!$('activitySelect')||!$('activitySelect').value)return toast('กรุณาเลือกกิจกรรมก่อน');
  enableActivityEditing(false);
  $('page').insertAdjacentHTML('beforeend',`<div class="modal" id="actPasteModal"><div class="modal-card"><h3>นำเข้า/วางผลจาก Excel</h3><p class="muted">รองรับการวางจาก Excel (Tab) หรือไฟล์ .csv (Comma) รูปแบบ: เลขที่/เลขประจำตัว, ผล(ผ/มผ), คะแนน — หรือวางเฉพาะคะแนน 1 คอลัมน์</p><input type="file" id="actCsvFile" accept=".csv,text/csv" onchange="readFileInto('actCsvFile','actPasteText')"><textarea id="actPasteText" class="paste-box" placeholder="ตัวอย่าง&#10;1&#9;ผ&#9;80&#10;2&#9;ผ&#9;75"></textarea><div class="toolbar" style="margin-top:12px"><button class="btn btn-primary" onclick="applyActivityPaste()">ตรวจสอบและนำไปใส่ตาราง</button><button class="btn btn-secondary" onclick="closeModal('actPasteModal')">ยกเลิก</button></div><div id="actPastePreview"></div></div></div>`);
}
function applyActivityPaste(){
  const rows=parseClientDelimited_($('actPasteText').value).filter(r=>!isCsvHeaderOrNote_(r));
  const grid=[...document.querySelectorAll('#activityGrid tbody tr')];
  const data=window._activityData?.rows||[];
  let applied=0;const errors=[];
  if(!rows.length)return toast('ไม่มีข้อมูล');
  if(rows[0].length===1){
    rows.forEach((r,i)=>{if(i<grid.length){grid[i].querySelector('.act-score').value=r[0].trim();applied++;}else errors.push('เกินจำนวนรายชื่อนักเรียน');});
  }else{
    const mapByNo={},mapByCode={};
    data.forEach((x,i)=>{mapByNo[String(x.classNo)]=grid[i];mapByCode[String(x.studentCode)]=grid[i];});
    rows.forEach(r=>{
      const key=String(r[0]).trim(),line=mapByNo[key]||mapByCode[key];
      if(!line){errors.push('ไม่พบ '+key);return;}
      if(r.length>=3){line.querySelector('.act-result').value=r[1].trim();line.querySelector('.act-score').value=r[2].trim();}
      else{line.querySelector('.act-result').value=r[1].trim();}
      applied++;
    });
  }
  $('actPastePreview').innerHTML=`<div class="alert-inline ${errors.length?'alert-danger':'alert-ok'}">ใส่ผลแล้ว ${applied} คน${errors.length?'<br>'+errors.join('<br>'):''}</div>`;
  if(applied)toast('นำผลเข้าตารางแล้ว',true);
}

/* ---------------- Assessment (อ่านคิดฯ/คุณลักษณะ/สมรรถนะ) ---------------- */
async function renderAssessment(p){
  // สิทธิ์เชื่อมจาก HomeroomUser1/2 ของห้องโดยตรง เหมือนหน้า "ลงทะเบียนนักเรียน"
  const isAdmin=state.me.roles.includes('ADMIN');
  let cls=[];
  try{
    cls=isAdmin?await call('getClasses',state.token,state.period.year,state.period.term):await call('getMyHomeroomClasses',state.token,state.period.year,state.period.term);
  }catch(e){
    p.innerHTML=`<div class="card"><div class="alert-inline alert-danger">${escapeHtml(e.message||'ไม่มีสิทธิ์')}</div></div>`;
    return;
  }
  cls=orderedClasses(cls);
  if(!isAdmin && !cls.length){
    p.innerHTML=`<h2>อ่านคิดวิเคราะห์เขียน / คุณลักษณะ / สมรรถนะ</h2><div class="card"><div class="alert-inline alert-danger"><b>ยังไม่มีห้องที่ได้รับสิทธิ์ครูประจำชั้น</b><br>ผู้ดูแลระบบสามารถเชื่อมสิทธิ์ได้ที่เมนู <b>“ตั้งค่าห้อง / ครูประจำชั้น”</b> โดยเลือกชื่อครูในช่อง <b>ครูประจำชั้น 1</b> หรือ <b>ครูประจำชั้น 2</b> ของห้อง</div></div>`;
    return;
  }
  p.innerHTML=`<h2>อ่านคิดวิเคราะห์เขียน / คุณลักษณะ / สมรรถนะ</h2>${periodBannerHtml()}<div class="card"><div class="toolbar score-toolbar entry-toolbar"><select id="assessClass" onchange="loadAssessmentGrid()"><option value="">-- เลือกห้อง --</option>${cls.map(c=>`<option value="${c.classId}">${escapeHtml(c.className)}</option>`).join('')}</select><button id="pasteAssessBtn" class="btn btn-secondary" onclick="openAssessPasteModal()">📋 นำเข้า/วางผลจาก Excel</button><button class="btn btn-secondary" onclick="downloadCsv('เทมเพลต_ประเมินคุณลักษณะ.csv',CSV_TEMPLATES.assessment)">⬇ เทมเพลต CSV</button><button id="editAssessBtn" class="btn btn-secondary" onclick="enableAssessmentEditing()" disabled>✏️ แก้ไขผลประเมิน</button><button id="saveAssessBtn" class="btn btn-primary" onclick="saveAssessmentGrid()" disabled>💾 บันทึกผล</button><button id="clearAssessBtn" class="btn btn-danger" onclick="clearAssessmentGrid()" disabled>🧹 ล้างผล</button></div><div id="assessmentModeInfo"></div><div id="assessmentInfo"></div><div id="assessmentGrid" class="table-wrap"></div></div>`;
}
async function loadAssessmentGrid(){
  const id=$('assessClass').value;if(!id){$('assessmentGrid').innerHTML='';if($('saveAssessBtn'))$('saveAssessBtn').disabled=true;if($('editAssessBtn'))$('editAssessBtn').disabled=true;if($('clearAssessBtn'))$('clearAssessBtn').disabled=true;return;}
  $('assessmentGrid').innerHTML='';$('assessmentGrid').appendChild(showSpinner());
  const d=await call('getAssessmentEntry',state.token,id);window._assessData=d;
  const hasSaved=assessmentRowsHaveData(d.students);
  $('assessmentInfo').innerHTML=`<div class="alert-inline alert-ok">ห้อง ${escapeHtml((d.students[0]&&d.students[0].className)||id)}${hasSaved?' · มีผลประเมินที่บันทึกแล้ว':''}</div>`;
  $('assessmentGrid').innerHTML=`<table class="data-table"><thead>${periodHeadRow(6)}<tr><th>ที่</th><th>เลขประจำตัว</th><th>ชื่อ-สกุล</th><th>อ่านฯ</th><th>คุณลักษณะฯ</th><th>สมรรถนะ</th></tr></thead><tbody>${d.students.map(r=>`<tr data-sid="${r.studentId}"><td>${r.classNo}</td><td>${escapeHtml(r.studentCode)}</td><td>${escapeHtml(r.name)}</td><td><select class="read"><option value="">-</option>${[1,2,3].map(x=>`<option ${String(r.reading)===String(x)?'selected':''}>${x}</option>`).join('')}</select></td><td><select class="char"><option value="">-</option>${[1,2,3].map(x=>`<option ${String(r.characteristics)===String(x)?'selected':''}>${x}</option>`).join('')}</select></td><td><select class="comp"><option value="">-</option>${[1,2,3].map(x=>`<option ${String(r.competencies)===String(x)?'selected':''}>${x}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table>`;
  updateAssessmentModeUi(hasSaved);
}
function assessmentRowsHaveData(rows){return (rows||[]).some(r=>String(r.reading??'').trim()!==''||String(r.characteristics??'').trim()!==''||String(r.competencies??'').trim()!=='');}
function setAssessmentInputsDisabled(disabled){document.querySelectorAll('#assessmentGrid .read,#assessmentGrid .char,#assessmentGrid .comp').forEach(el=>{el.disabled=disabled;el.classList.toggle('score-locked',disabled);});}
function updateAssessmentModeUi(hasSaved){
  const edit=$('editAssessBtn'),save=$('saveAssessBtn'),clear=$('clearAssessBtn');if(!edit||!save||!clear)return;
  if(hasSaved){edit.disabled=false;save.disabled=true;clear.disabled=false;setAssessmentInputsDisabled(true);if($('assessmentModeInfo'))$('assessmentModeInfo').innerHTML='<div class="alert-inline alert-ok score-mode-badge">🔒 บันทึกแล้ว — กด “แก้ไขผลประเมิน” ก่อนปรับข้อมูล</div>';}
  else{edit.disabled=true;save.disabled=false;clear.disabled=false;setAssessmentInputsDisabled(false);if($('assessmentModeInfo'))$('assessmentModeInfo').innerHTML='<div class="alert-inline alert-ok score-mode-badge">✍️ พร้อมกรอก/แก้ไขผลประเมิน</div>';}
}
function enableAssessmentEditing(showMessage=true){
  if(!$('assessClass')?.value)return toast('กรุณาเลือกห้องก่อน');
  if(!$('assessmentGrid')?.querySelector('tbody tr'))return toast('ยังไม่มีรายชื่อนักเรียน');
  setAssessmentInputsDisabled(false);if($('editAssessBtn'))$('editAssessBtn').disabled=true;if($('saveAssessBtn'))$('saveAssessBtn').disabled=false;if($('clearAssessBtn'))$('clearAssessBtn').disabled=false;
  if($('assessmentModeInfo'))$('assessmentModeInfo').innerHTML='<div class="alert-inline alert-ok score-mode-badge">✏️ อยู่ในโหมดแก้ไข — ตรวจข้อมูลแล้วกด “บันทึกผล”</div>';
  if(showMessage)toast('เปิดโหมดแก้ไขผลประเมินแล้ว',true);
}
async function saveAssessmentGrid(){
  const id=$('assessClass').value;if(!id)return toast('กรุณาเลือกห้องก่อน');
  const btn=$('saveAssessBtn');if(btn){btn.disabled=true;btn.textContent='กำลังบันทึก...';}
  const rows=[...document.querySelectorAll('#assessmentGrid tbody tr')].map(tr=>({studentId:tr.dataset.sid,reading:tr.querySelector('.read').value,characteristics:tr.querySelector('.char').value,competencies:tr.querySelector('.comp').value,remark:''}));
  try{const r=await call('saveAssessments',state.token,{classId:id,rows});toast('บันทึก '+r.saved+' รายการเรียบร้อย',true);await loadAssessmentGrid();}catch(e){toast(e.message);}finally{if(btn){btn.disabled=false;btn.textContent='💾 บันทึกผล';}}
}
async function clearAssessmentGrid(){
  const id=$('assessClass')?.value;if(!id)return toast('กรุณาเลือกห้องก่อน');
  const name=$('assessClass').options[$('assessClass').selectedIndex]?.text||'ห้องที่เลือก';
  if(!confirm(`ต้องการล้างผลประเมินทั้งหมดของ ${name} ใช่หรือไม่?\n\nระบบจะล้าง อ่านคิดวิเคราะห์เขียน, คุณลักษณะอันพึงประสงค์, สมรรถนะ และหมายเหตุ แต่จะไม่ลบรายชื่อนักเรียน`))return;
  const btn=$('clearAssessBtn');if(btn){btn.disabled=true;btn.textContent='กำลังล้าง...';}
  try{const r=await call('clearAssessments',state.token,id);toast('ล้างผลประเมินแล้ว '+(r.cleared||0)+' รายการ',true);await loadAssessmentGrid();}catch(e){toast(e.message);}finally{if(btn){btn.disabled=false;btn.textContent='🧹 ล้างผล';}}
}
function openAssessPasteModal(){
  if(!$('assessClass')||!$('assessClass').value)return toast('กรุณาเลือกห้องก่อน');
  enableAssessmentEditing(false);
  $('page').insertAdjacentHTML('beforeend',`<div class="modal" id="assessPasteModal"><div class="modal-card"><h3>นำเข้า/วางผลจาก Excel</h3><p class="muted">รองรับการวางจาก Excel (Tab) หรือไฟล์ .csv (Comma) และข้ามหัวตารางให้อัตโนมัติ รูปแบบ: เลขที่/เลขประจำตัว, อ่านฯ, คุณลักษณะฯ, สมรรถนะ — ค่าที่รองรับ: 1, 2, 3 หรือ ดี/พอใช้/ปรับปรุง</p><input type="file" id="assessCsvFile" accept=".csv,text/csv" onchange="readFileInto('assessCsvFile','assessPasteText')"><textarea id="assessPasteText" class="paste-box" style="margin-top:10px" placeholder="ตัวอย่าง&#10;1&#9;3&#9;3&#9;2&#10;2&#9;2&#9;3&#9;3"></textarea><div class="toolbar" style="margin-top:12px"><button class="btn btn-primary" onclick="applyAssessPaste()">ตรวจสอบและนำไปใส่ตาราง</button><button class="btn btn-secondary" onclick="closeModal('assessPasteModal')">ยกเลิก</button></div><div id="assessPastePreview"></div></div></div>`);
}
function assessLevelFromText_(v){
  const s=String(v||'').trim();
  if(['1','2','3'].includes(s))return s;
  const map={'ดีเยี่ยม':'3','ดี':'3','พอใช้':'2','ปรับปรุง':'1'};
  return map[s]||'';
}
function applyAssessPaste(){
  const rows=parseClientDelimited_($('assessPasteText').value).filter(r=>!isCsvHeaderOrNote_(r));
  const grid=[...document.querySelectorAll('#assessmentGrid tbody tr')];
  const data=window._assessData?.students||[];
  const mapByNo={},mapByCode={};
  data.forEach((x,i)=>{mapByNo[String(x.classNo)]=grid[i];mapByCode[String(x.studentCode)]=grid[i];});
  let applied=0;const errors=[];
  if(!rows.length)return toast('ไม่มีข้อมูล');
  rows.forEach(r=>{
    const key=String(r[0]).trim(),line=mapByNo[key]||mapByCode[key];
    if(!line){errors.push('ไม่พบ '+key);return;}
    if(r[1]!==undefined)line.querySelector('.read').value=assessLevelFromText_(r[1]);
    if(r[2]!==undefined)line.querySelector('.char').value=assessLevelFromText_(r[2]);
    if(r[3]!==undefined)line.querySelector('.comp').value=assessLevelFromText_(r[3]);
    applied++;
  });
  $('assessPastePreview').innerHTML=`<div class="alert-inline ${errors.length?'alert-danger':'alert-ok'}">ใส่ผลแล้ว ${applied} คน${errors.length?'<br>'+errors.join('<br>'):''}</div>`;
  if(applied)toast('นำผลเข้าตารางแล้ว',true);
}

/* ---------------- Grade history ---------------- */
async function renderGradeHistory(p){
  // สิทธิ์ดูเกรดย้อนหลัง จำกัดเฉพาะครูประจำชั้นของห้องตัวเอง (เหมือนหน้าลงทะเบียนนักเรียน)
  const isAdmin=state.me.roles.includes('ADMIN');
  let classes=[];
  try{
    classes=isAdmin?await call('getClasses',state.token,state.period.year,state.period.term):await call('getMyHomeroomClasses',state.token,state.period.year,state.period.term);
  }catch(e){
    p.innerHTML=`<div class="card"><div class="alert-inline alert-danger">${escapeHtml(e.message||'ไม่มีสิทธิ์')}</div></div>`;
    return;
  }
  classes=orderedClasses(classes);
  if(!isAdmin && !classes.length){
    p.innerHTML=`<h2>ดูเกรดย้อนหลัง</h2><div class="card"><div class="alert-inline alert-danger"><b>ยังไม่มีห้องที่ได้รับสิทธิ์ครูประจำชั้น</b><br>ผู้ดูแลระบบสามารถเชื่อมสิทธิ์ได้ที่เมนู <b>“ตั้งค่าห้อง / ครูประจำชั้น”</b></div></div>`;
    return;
  }
  p.innerHTML=`<h2>ดูเกรดย้อนหลัง</h2>${periodBannerHtml()}<p class="sub">ค้นหาโดยใช้ปีการศึกษา/ภาคเรียนที่เลือกไว้ด้านบน + ห้อง + นักเรียน — ถ้าจะดูภาคเรียน/ปีการศึกษาอื่น ให้เปลี่ยนตัวเลือกปี/ภาคเรียนที่แถบด้านบนของหน้าจอก่อน แล้วค่อยเลือกห้อง/นักเรียนใหม่อีกครั้ง</p><div class="card"><div class="grid grid-2"><div class="field"><label>ชั้น / ห้อง</label><select id="histClass" onchange="loadHistoryStudents()"><option value="">-- เลือกห้อง --</option>${classes.map(c=>`<option value="${c.classId}">${escapeHtml(c.className)}</option>`).join('')}</select></div><div class="field"><label>นักเรียน</label><select id="histStudent"><option value="">-- เลือกห้องก่อน --</option></select></div></div><div class="toolbar"><button class="btn btn-primary btn-lg" onclick="loadGradeHistory()">🔎 แสดงผลการเรียน</button><button class="btn btn-secondary" onclick="go('print')">🖨 ไปหน้าพิมพ์ ปพ.6</button></div></div><div id="historyResult"></div>`;
}
async function loadHistoryStudents(){const cid=$('histClass').value;if(!cid)return;$('histStudent').innerHTML='<option value="">กำลังโหลด...</option>';try{const rows=await call('getStudentsByClass',state.token,cid);$('histStudent').innerHTML='<option value="">-- เลือกนักเรียน --</option>'+rows.map(r=>`<option value="${r.studentId}">${r.classNo}. ${escapeHtml(r.prefix+r.firstName+' '+r.lastName)}</option>`).join('');}catch(e){toast(e.message);}}
async function loadGradeHistory(){const cid=$('histClass').value,sid=$('histStudent').value;if(!cid||!sid)return toast('กรุณาเลือกห้องและนักเรียน');$('historyResult').innerHTML='';$('historyResult').appendChild(showSpinner());try{const d=await call('getGradeHistory',state.token,sid,cid);const rows=d.subjects.map(s=>`<tr><td>${escapeHtml(s.year)}</td><td>${escapeHtml(s.term)}</td><td>${escapeHtml(s.code)}</td><td class="l">${escapeHtml(s.name)}</td><td>${s.score??''}</td><td>${escapeHtml(s.status||s.grade||'')}</td><td>${s.credit??''}</td></tr>`).join('');$('historyResult').innerHTML=`<div class="card" style="margin-top:16px"><div class="history-head"><div><span class="section-kicker">GRADE HISTORY</span><h3>${escapeHtml(d.student.name)}</h3><p class="muted">${escapeHtml(d.className)} · ปีการศึกษา ${escapeHtml(state.period.year)} ภาคเรียนที่ ${escapeHtml(state.period.term)}</p></div><span class="soft-badge">${d.subjects.length} รายการ</span></div><div class="table-wrap"><table class="data-table history-table"><thead><tr><th>ปีการศึกษา</th><th>ภาคเรียน</th><th>รหัส</th><th>รายวิชา</th><th>คะแนน</th><th>เกรด/สถานะ</th><th>นก.</th></tr></thead><tbody>${rows||'<tr><td colspan="7" class="muted center">ไม่พบผลการเรียนย้อนหลัง</td></tr>'}</tbody></table></div></div>`;}catch(e){$('historyResult').innerHTML=`<div class="alert-inline alert-danger">${escapeHtml(e.message)}</div>`;}}

/* ---------------- Print ---------------- */
async function renderPrint(p){
  // สิทธิ์พิมพ์ ปพ.6 / สรุปผลการเรียน จำกัดเฉพาะครูประจำชั้นของห้องตัวเอง (เหมือนหน้าลงทะเบียนนักเรียน)
  const isAdmin=state.me.roles.includes('ADMIN');
  let cls=[];
  try{
    cls=isAdmin?await call('getClasses',state.token,state.period.year,state.period.term):await call('getMyHomeroomClasses',state.token,state.period.year,state.period.term);
  }catch(e){
    p.innerHTML=`<div class="card"><div class="alert-inline alert-danger">${escapeHtml(e.message||'ไม่มีสิทธิ์')}</div></div>`;
    return;
  }
  cls=orderedClasses(cls);
  if(!isAdmin && !cls.length){
    p.innerHTML=`<h2>พิมพ์ ปพ.6</h2><div class="card"><div class="alert-inline alert-danger"><b>ยังไม่มีห้องที่ได้รับสิทธิ์ครูประจำชั้น</b><br>ผู้ดูแลระบบสามารถเชื่อมสิทธิ์ได้ที่เมนู <b>“ตั้งค่าห้อง / ครูประจำชั้น”</b></div></div>`;
    return;
  }
  p.innerHTML=`<h2>พิมพ์ ปพ.6</h2><div class="period-banner">📅 ช่วงการศึกษาที่เลือก: <b>${escapeHtml(state.period.year)}</b> · ภาคเรียน <b>${escapeHtml(state.period.term)}</b></div><div class="card"><div class="grid grid-2"><div class="field"><label>ห้อง</label><select id="printClass" onchange="loadPrintStudents()"><option value="">-- เลือกห้อง --</option>${cls.map(c=>`<option value="${c.classId}">${escapeHtml(c.className)}</option>`).join('')}</select></div><div class="field"><label>นักเรียน</label><select id="printStudent"><option value="">-- เลือกห้องก่อน --</option></select></div><div class="field"><label>รูปแบบ</label><select id="printMode"><option value="with">มี 0 / ร / มส</option><option value="without">ไม่มี 0 / ร / มส</option></select></div></div><div class="toolbar"><button class="btn btn-primary" onclick="printStudentPP6()">🖨 พิมพ์นักเรียน</button><button class="btn btn-secondary" onclick="previewStudentPP6()">👁 ดูตัวอย่าง</button><button class="btn btn-secondary" onclick="printWholeClassPP6()">🖨 พิมพ์ทั้งห้อง</button></div></div>
  <div class="card" style="margin-top:14px"><h3>พิมพ์แบบสรุปผลการเรียน (ทั้งห้อง)</h3><p class="muted">ตารางรวมคะแนน/เกรดทุกวิชาของทั้งห้องในหน้าเดียว พร้อมคะแนนรวม ร้อยละ เกรดเฉลี่ย และลำดับที่</p><div class="field" style="max-width:360px"><label>ห้อง</label><select id="summaryPrintClass"><option value="">-- เลือกห้อง --</option>${cls.map(c=>`<option value="${c.classId}">${escapeHtml(c.className)}</option>`).join('')}</select></div><div class="toolbar"><button class="btn btn-primary" onclick="printClassSummary('with')">🖨 แบบมี ร,มส</button><button class="btn btn-secondary" onclick="printClassSummary('without')">🖨 แบบไม่มี ร,มส</button></div></div>`;
}
async function loadPrintStudents(){
  const id=$('printClass').value;if(!id)return;
  const rows=await call('getStudentsByClass',state.token,id);
  $('printStudent').innerHTML=rows.map(r=>`<option value="${r.studentId}">${r.classNo}. ${escapeHtml(r.prefix+r.firstName+' '+r.lastName)}</option>`).join('');
}
async function previewStudentPP6(){const cid=$('printClass').value,sid=$('printStudent').value;if(!cid||!sid)return toast('เลือกห้องและนักเรียน');const d=await call('getPP6Data',state.token,sid,cid,$('printMode').value,state.period.year,state.period.term);openPP6Window(d,false);}
async function printStudentPP6(){const cid=$('printClass').value,sid=$('printStudent').value;if(!cid||!sid)return toast('เลือกห้องและนักเรียน');const d=await call('getPP6Data',state.token,sid,cid,$('printMode').value,state.period.year,state.period.term);openPP6Window(d,true);}
function openPP6Window(d,doPrint){
  const w=window.open('','_blank');
  w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>ปพ.6 ${escapeHtml(d.student.firstName)}</title></head><body>${renderPP6PageHtml(d)}</body></html>`);
  w.document.close();if(doPrint)setTimeout(()=>w.print(),400);
}
async function printWholeClassPP6(){
  const cid=$('printClass').value;if(!cid)return toast('เลือกห้องก่อน');
  const students=await call('getStudentsByClass',state.token,cid);if(!students.length)return toast('ไม่พบรายชื่อนักเรียน');
  const mode=$('printMode').value;
  try{const pages=await call('getPP6BulkData',state.token,cid,mode,state.period.year,state.period.term);openPP6BulkWindow(pages);}catch(e){toast(e.message);}
}
function openPP6BulkWindow(items){
  const w=window.open('','_blank');
  const html=items.map(d=>renderPP6PageHtml(d)).join('<div style="page-break-after:always"></div>');
  w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>ปพ.6 ทั้งห้อง</title></head><body>${html}</body></html>`);
  w.document.close();setTimeout(()=>w.print(),500);
}
// Single template used for both "one student" and "whole class" printing, so
// the two always look identical — built to match the school's official ปพ.6
// layout (seal, two-row result header, boxed เลขที่, stacked signatures).
// Fixed category labels for กิจกรรมพัฒนาผู้เรียน — shown as a prefix instead of
// whatever the activity/club was actually named (club names are intentionally
// dropped so the printed row always reads just "กิจกรรมชุมนุม").
const ACTIVITY_TYPE_LABELS={GUIDANCE:'กิจกรรมแนะแนว',SCOUT:'กิจกรรมลูกเสือ-เนตรนารี',SERVICE:'กิจกรรมสาธารณประโยชน์',CLUB:'กิจกรรมชุมนุม'};
function activityDisplayName_(a){return ACTIVITY_TYPE_LABELS[a.type]||a.name;}
function teacherDisplayName_(fullName){
  let s=String(fullName||'').trim();
  if(!s)return '';
  // เปลี่ยนคำนำหน้าเป็น “ครู” และใช้เฉพาะชื่อ ไม่แสดงนามสกุล
  s=s.replace(/^(นาย|นางสาว|นาง|เด็กชาย|เด็กหญิง|ด\.ช\.|ด\.ญ\.|คุณ|ครู|อาจารย์|ดร\.)\s*/,'').trim();
  const firstName=s.split(/\s+/)[0]||'';
  return firstName?`ครู${firstName}`:'';
}
// แปลง "ม.2/1" -> "มัธยมศึกษาปีที่ 2/1" สำหรับหัวกระดาษ ปพ.6 รายบุคคล
function classNameFull_(name){
  const m=String(name||'').match(/^ม\.?\s*([1-3])\s*\/\s*(\d+)/);
  return m ? `มัธยมศึกษาปีที่ ${m[1]}/${m[2]}` : name;
}
function renderPP6PageHtml(d){
  const orderedSubjects=sortSubjectsByCurriculum(d.subjects||[],d.className,d.term);
  const rows=orderedSubjects.map(s=>`<tr><td>${escapeHtml(s.code)}</td><td class="l">${escapeHtml(s.name)}</td><td>${escapeHtml(s.type)}</td><td>${s.credit??''}</td><td>${s.scoreMax}</td><td>${s.score??''}</td><td>${s.status||s.finalGrade||''}</td><td>${s.retakeScore||''}</td><td>${s.rank||''}</td></tr>`).join('');
  const actLabelRow = d.activities.length ? `<tr><td></td><td class="l"><b>กิจกรรมพัฒนาผู้เรียน</b></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>` : '';
  const acts=d.activities.map(a=>`<tr><td></td><td class="l">${escapeHtml(activityDisplayName_(a))}</td><td>กิจกรรม</td><td>-</td><td>-</td><td>${escapeHtml(a.score||'')}</td><td>${a.result==='มผ'?'ไม่ผ่าน':(a.result?'ผ่าน':'')}</td><td></td><td></td></tr>`).join('');
  const sig=(name,role)=>`<div class="sig-block">ลงชื่อ ................................................<br>${name?`(${escapeHtml(name)})`:''}<br>${role}</div>`;
  return `<div class="pp6-page"><style>
    @page{size:A4 portrait;margin:0}
    .pp6-page{width:210mm;min-height:297mm;padding:6mm 10mm 5mm;box-sizing:border-box;font-family:'TH Sarabun New','TH SarabunPSK',Sarabun,Tahoma,sans-serif;font-size:14pt;position:relative}
    .pp6-tag{position:absolute;top:5mm;right:10mm;font-weight:700}
    .center{text-align:center;font-size:14pt}
    .seal{display:block;margin:0 auto 1mm;height:14mm}
    .title{font-weight:700;font-size:14pt}
    .info{display:flex;justify-content:space-between;align-items:center;margin:4px 0 3px;gap:10px;font-size:14pt}
    .info .box{background:#e5e7eb;border:1px solid #94a3b8;border-radius:4px;padding:1px 12px;font-weight:700}
    .tbl{width:100%;border-collapse:collapse}
    .tbl th,.tbl td{border:1px solid #000;padding:calc(0.47mm + 0.02cm) 3px;line-height:1;font-size:14pt;text-align:center;vertical-align:middle}
    .tbl td.l,.tbl th.l{text-align:left}
    .summary-wrap{display:flex;gap:14px;margin-top:0.448cm;align-items:flex-start}
    .summary-tbl{flex:1.3;border-collapse:collapse}
    .summary-tbl th,.summary-tbl td{border:1px solid #000;padding:calc(2px + 0.04cm) 5px;line-height:1.1;font-size:14pt;text-align:center}
    .summary-tbl th{background:#f1f5f9}
    .summary-tbl td.l{text-align:left}
    .sig-col{flex:1;display:flex;flex-direction:column;gap:2mm;text-align:center;font-size:14pt;padding-top:1mm}
    .sig-block{line-height:1.2}
    @media print{button{display:none}}
  </style>
  <div class="pp6-tag">ปพ. 6</div>
  <div class="center"><img class="seal" src="${SCHOOL_LOGO_SRC}"><div class="title">แบบรายงานผลการพัฒนาคุณภาพผู้เรียนรายบุคคล</div>ระดับชั้น${escapeHtml(classNameFull_(d.className))} &nbsp;ภาคเรียนที่ ${escapeHtml(d.term)} &nbsp;ปีการศึกษา ${escapeHtml(d.academicYear)}<br>${escapeHtml(d.school.name)} จังหวัด${escapeHtml(d.school.province)}</div>
  <div class="info"><div>ชื่อ ${escapeHtml(d.student.prefix+d.student.firstName+' '+d.student.lastName)}</div><div>เลขประจำตัว ${escapeHtml(d.student.studentCode)}</div><div>เลขที่ <span class="box">${escapeHtml(d.student.classNo)}</span></div></div>
  <table class="tbl"><thead><tr><th rowspan="2">รหัส</th><th rowspan="2" class="l">รายวิชา</th><th rowspan="2">ประเภท</th><th rowspan="2">นก.</th><th colspan="4">ผลการประเมิน</th><th rowspan="2">ลำดับ<br>ที่</th></tr><tr><th>เต็ม</th><th>ได้</th><th>ระดับผล</th><th>แก้ตัว</th></tr></thead><tbody>${rows}${actLabelRow}${acts}</tbody></table>
  <div class="summary-wrap">
    <table class="summary-tbl"><tr><th class="l">สรุปผลการประเมิน</th><th>ผลการเรียน</th></tr>
      <tr><td class="l">ผลการเรียนเฉลี่ย</td><td>${d.gpa??''}</td></tr>
      <tr><td class="l">ผลการประเมินการอ่าน คิดวิเคราะห์และเขียน</td><td>${escapeHtml(d.assessment.reading||'')}</td></tr>
      <tr><td class="l">ผลการประเมินคุณลักษณะอันพึงประสงค์</td><td>${escapeHtml(d.assessment.characteristics||'')}</td></tr>
      <tr><td class="l">ผลการประเมินสมรรถนะสำคัญของผู้เรียน</td><td>${escapeHtml(d.assessment.competencies||'')}</td></tr>
      <tr><td class="l">ผลการประเมินกิจกรรมพัฒนาผู้เรียน</td><td>${escapeHtml(d.status)}</td></tr>
    </table>
    <div class="sig-col">
      ${sig(d.homeroom1,'ครูที่ปรึกษา')}
      ${d.homeroom2?sig(d.homeroom2,'ครูที่ปรึกษา'):''}
      ${sig(d.principalName,'ผู้อำนวยการโรงเรียน')}
      ${sig('','ผู้ปกครอง')}
    </div>
  </div>
  </div>`;
}
// Width (in "ch") just wide enough for the longest student name in this class,
// clamped to a sane range — frees up the horizontal space that used to be
// wasted on an oversized ชื่อ-สกุล column so it can go to the teacher-name row.
function nameColWidthCh_(students){
  // ปรับตามชื่อที่ยาวที่สุดของห้อง โดยเผื่อพื้นที่สำหรับขอบเซลล์/ช่องว่าง
  // และคุมช่วงไม่ให้คอลัมน์แคบจนตัดชื่อ หรือกว้างจนเบียดคอลัมน์วิชา
  const maxLen=Math.max(8,...(students||[]).map(st=>String(st.name||'').trim().length));
  return Math.max(12,Math.min(Math.ceil(maxLen*0.95)+2,28));
}
// Same idea for เลขประจำตัว — width just fits however many digits the
// student codes in this class actually have, instead of a fixed guess.
// (+2 instead of +1: leaves room for the cell's own padding/border so the
// digits never get clipped by the ellipsis rule below.)
function codeColWidthCh_(students){
  const maxLen=Math.max(4,...(students||[]).map(st=>String(st.studentCode||'').length));
  return Math.min(maxLen+2,14);
}
async function printClassSummary(mode){
  const cid=$('summaryPrintClass').value;if(!cid)return toast('เลือกห้องก่อน');
  const [d,d2]=await Promise.all([call('getClassSummaryData',state.token,cid,mode,state.period.year,state.period.term),call('getClassActivitySummaryData',state.token,cid,state.period.year,state.period.term)]);
  // เรียงคอลัมน์รายวิชาตาม CURRICULUM แล้วสลับเซลล์ของนักเรียนให้ตรงคอลัมน์เดิม
  const subjOrder=curriculumSubjectOrder(d.subjects||[],d.className,d.term);
  const subjCols=subjOrder.map(i=>d.subjects[i]);
  d.students.forEach(st=>{st.cells=subjOrder.map(i=>st.cells[i]);});
  const nameCh1=nameColWidthCh_(d.students);
  const codeCh1=codeColWidthCh_(d.students);
  const colgroup1=`<colgroup><col style="width:22px"><col style="width:${codeCh1}ch"><col style="width:${nameCh1+8}ch">${subjCols.map(()=>'<col><col>').join('')}<col style="width:38px"><col style="width:34px"><col style="width:34px"><col style="width:30px"></colgroup>`;
  const subjHeadCols=subjCols.map(s=>`<th colspan="2" class="wrap-head">${escapeHtml(s.name)}</th>`).join('');
  const teacherRow=subjCols.map(s=>`<td colspan="2" class="teacher-cell">${escapeHtml(teacherDisplayName_(s.teacherName))}</td>`).join('');
  const subHeadRow=subjCols.map(()=>`<th>เต็ม</th><th>เกรด</th>`).join('');
  const maxRow=subjCols.map(s=>`<td>${s.scoreMax}</td><td>4</td>`).join('');
  const gradeClass_=grade=>{
    const g=String(grade??'').trim().toLowerCase();
    if(g==='0') return ' grade-0';
    if(g==='ร') return ' grade-r';
    if(g==='มส') return ' grade-ms';
    return '';
  };
  const bodyRows=d.students.map(st=>{
    const cells=st.cells.map(c=>`<td>${c.score}</td><td class="${gradeClass_(c.grade).trim()}">${escapeHtml(c.grade)}</td>`).join('');
    return `<tr><td>${st.classNo}</td><td class="code">${escapeHtml(st.studentCode)}</td><td class="l">${escapeHtml(st.name)}</td>${cells}<td>${st.total}</td><td>${st.percent}</td><td>${st.rank}</td><td>${st.gpa??''}</td></tr>`;
  }).join('');
  const sigLine_=name=>name?`${escapeHtml(name)} (ลายมือชื่อ)....................................`:'';
  const homeroomLine=[d.homeroom1,d.homeroom2].filter(Boolean).map(sigLine_).join(' , ');
  const page1=`<div class="summary-page page1"><div class="center"><b>แบบสรุปผลการเรียน ภาคเรียนที่ ${escapeHtml(d.term)} ปีการศึกษา ${escapeHtml(d.academicYear)} ชั้น${escapeHtml(classNameFull_(d.className))}</b><br>ครูประจำชั้น ${homeroomLine}<br><i>แผ่นที่ 1 — คะแนน/เกรดรายวิชา</i></div><table class="tbl">${colgroup1}<thead><tr><th rowspan="3">ที่</th><th rowspan="3" class="wrap-head">เลขประจำตัว</th><th rowspan="3">ชื่อ-สกุล</th>${subjHeadCols}<th rowspan="3">คะแนน<br>รวม</th><th rowspan="3">ร้อยละ</th><th rowspan="3">ลำดับที่</th><th rowspan="3">เกรด<br>เฉลี่ย</th></tr><tr class="teacher-row">${teacherRow}</tr><tr>${subHeadRow}</tr></thead><tbody><tr><td colspan="3">เต็ม / เกรดสูงสุด</td>${maxRow}<td></td><td></td><td></td><td></td></tr>${bodyRows}</tbody></table>`;

  const nameCh2=nameCh1+8;
  const codeCh2=codeColWidthCh_(d2.students);
  const colgroup2=`<colgroup><col style="width:22px"><col style="width:${codeCh2}ch"><col style="width:${nameCh2}ch">${d2.types.map(()=>'<col><col>').join('')}<col style="width:70px"><col style="width:70px"><col style="width:70px"><col style="width:90px"></colgroup>`;
  const typeHeadCols=d2.types.map(t=>`<th colspan="2" class="wrap-head">${escapeHtml(t.label)}</th>`).join('');
  const typeSubHeadRow=d2.types.map(()=>`<th>คะแนน</th><th>ผ/มผ</th>`).join('');
  const body2=d2.students.map(st=>{
    const cells=d2.types.map(t=>{const c=st.cells[t.type]||{}; return `<td>${c.score??''}</td><td>${c.result==='มผ'?'ไม่ผ่าน':(c.result?'ผ่าน':'')}</td>`;}).join('');
    return `<tr><td>${st.classNo}</td><td class="code">${escapeHtml(st.studentCode)}</td><td class="l">${escapeHtml(st.name)}</td>${cells}<td>${escapeHtml(st.reading)}</td><td>${escapeHtml(st.characteristics)}</td><td>${escapeHtml(st.competencies)}</td><td>${escapeHtml(st.remark||'')}</td></tr>`;
  }).join('');
  const page2=`<div class="summary-page page2"><div class="center"><b>แบบสรุปผลการเรียน ภาคเรียนที่ ${escapeHtml(d2.term)} ปีการศึกษา ${escapeHtml(d2.academicYear)} ชั้น${escapeHtml(classNameFull_(d2.className))}</b><br><i>แผ่นที่ 2 — กิจกรรมพัฒนาผู้เรียน / การประเมินคุณลักษณะ-สมรรถนะ-การอ่านคิดวิเคราะห์เขียน</i></div><table class="tbl">${colgroup2}<thead><tr><th rowspan="2">ที่</th><th rowspan="2" class="wrap-head">เลขประจำตัว</th><th rowspan="2">ชื่อ-สกุล</th>${typeHeadCols}<th rowspan="2">อ่าน คิดวิเคราะห์<br>และเขียน</th><th rowspan="2">คุณลักษณะ<br>อันพึงประสงค์</th><th rowspan="2">สมรรถนะ<br>สำคัญ</th><th rowspan="2">หมายเหตุ</th></tr><tr>${typeSubHeadRow}</tr></thead><tbody>${body2}</tbody></table></div>`;

  const w=window.open('','_blank');
  // A4 landscape (297×210mm) ตามที่ขอ — ก่อนหน้านี้ตั้งเป็น A3 โดยไม่ได้ตั้งใจ.
  // table-layout:fixed + colgroup ด้านบนทำให้คอลัมน์ชื่อ-สกุลแคบพอดีตัวอักษร
  // ส่วนความสูงที่ประหยัดได้ถูกโยกไปให้แถวชื่อครูผู้สอน (.teacher-row) แทน
  // เพื่อให้ชื่อครูที่ยาวขึ้นบรรทัดใหม่ได้โดยไม่ดันตารางล้นหน้า A4
  w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>สรุปผลการเรียน ${escapeHtml(d.className)}</title><style>@page{size:A4 landscape;margin:6mm}body{font-family:'TH Sarabun New','TH SarabunPSK',Sarabun,Tahoma,sans-serif;font-size:8.5pt}.summary-page{padding-top:6mm}.center{text-align:center;margin-bottom:4px}.tbl{border-collapse:collapse;width:100%;table-layout:fixed}.tbl th,.tbl td{border:1px solid #000;padding:1px 2px;line-height:1.05;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tbl td.l{text-align:left;white-space:normal;overflow-wrap:break-word}.tbl td.code{overflow:visible;text-overflow:clip}.tbl th.wrap-head{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:break-word;line-height:1.15}.tbl .teacher-row td.teacher-cell{white-space:normal;overflow-wrap:break-word;line-height:1.15;padding:3px 2px;height:9mm}.tbl td.grade-0{color:#c2410c;font-weight:800}.tbl td.grade-r{color:#b91c1c;font-weight:800}.tbl td.grade-ms{color:#6b21a8;font-weight:800}.pagebreak{page-break-after:always;break-after:page}.page2{page-break-before:always;break-before:page}@media print{button{display:none}}</style></head><body><div class="pagebreak">${page1}</div>${page2}<div class="toolbar" style="margin-top:10px"><button onclick="window.print()">พิมพ์</button></div></body></html>`);
  w.document.close();setTimeout(()=>w.print(),500);
}

/* ---------------- GPA ranking ---------------- */
async function renderSummary(p){
  // สิทธิ์ดูอันดับ GPA จำกัดเฉพาะครูประจำชั้นของห้องตัวเอง (เหมือนหน้าลงทะเบียนนักเรียน)
  const isAdmin=state.me.roles.includes('ADMIN');
  let cls=[];
  try{
    cls=isAdmin?await call('getClasses',state.token,state.period.year,state.period.term):await call('getMyHomeroomClasses',state.token,state.period.year,state.period.term);
  }catch(e){
    p.innerHTML=`<div class="card"><div class="alert-inline alert-danger">${escapeHtml(e.message||'ไม่มีสิทธิ์')}</div></div>`;
    return;
  }
  cls=orderedClasses(cls);
  if(!isAdmin && !cls.length){
    p.innerHTML=`<h2>อันดับผลการเรียน (GPA)</h2><div class="card"><div class="alert-inline alert-danger"><b>ยังไม่มีห้องที่ได้รับสิทธิ์ครูประจำชั้น</b><br>ผู้ดูแลระบบสามารถเชื่อมสิทธิ์ได้ที่เมนู <b>“ตั้งค่าห้อง / ครูประจำชั้น”</b></div></div>`;
    return;
  }
  p.innerHTML=`<h2>อันดับผลการเรียน (GPA)</h2>${periodBannerHtml()}<div class="card"><div class="toolbar"><select id="sumClass" onchange="loadSummary()"><option value="">-- เลือกห้อง --</option>${cls.map(c=>`<option value="${c.classId}">${escapeHtml(c.className)}</option>`).join('')}</select></div><div id="summaryOut"></div></div>`;
}
async function loadSummary(){
  const cid=$('sumClass').value;if(!cid)return;
  $('summaryOut').innerHTML='';$('summaryOut').appendChild(showSpinner());
  const students=await call('getStudentsByClass',state.token,cid);
  // FIX: เดิมไม่ส่งปี/ภาคเรียนที่เลือก จึงคำนวณ GPA ของช่วงปัจจุบันของระบบเสมอ และเรียกทีละคน — ตอนนี้ส่งช่วงที่เลือกและเรียกทีละ 4 คนพร้อมกัน
  const rows=[];for(let i=0;i<students.length;i+=4){const chunk=await Promise.all(students.slice(i,i+4).map(s=>call('getPP6Data',state.token,s.studentId,cid,'with',state.period.year,state.period.term).catch(()=>null)));chunk.forEach(x=>{if(x)rows.push(x);});}
  rows.sort((a,b)=>(b.gpa||0)-(a.gpa||0));
  $('summaryOut').innerHTML=`<div class="table-wrap"><table class="data-table"><thead>${periodHeadRow(6)}<tr><th>อันดับ</th><th>เลขที่</th><th>เลขประจำตัว</th><th>ชื่อ-สกุล</th><th>GPA</th><th>สถานะ</th></tr></thead><tbody>${rows.map((r,i)=>`<tr><td>${i+1}</td><td>${r.student.classNo}</td><td>${escapeHtml(r.student.studentCode)}</td><td>${escapeHtml(r.student.prefix+r.student.firstName+' '+r.student.lastName)}</td><td>${r.gpa??''}</td><td>${escapeHtml(r.status)}</td></tr>`).join('')}</tbody></table></div>`;
}

/* ---------------- Validation ---------------- */
async function renderValidation(p){
  const cls=await call('getClasses',state.token,state.period.year,state.period.term);
  p.innerHTML=`<h2>ตรวจสอบข้อมูลก่อนพิมพ์</h2><div class="card"><div class="toolbar"><select id="valClass"><option value="">-- เลือกห้อง --</option>${cls.map(c=>`<option value="${c.classId}">${escapeHtml(c.className)}</option>`).join('')}</select><button class="btn btn-primary" onclick="runValidation()">ตรวจสอบ</button></div><div id="valOut"></div></div>`;
}
async function runValidation(){
  const d=await call('validateClassData',state.token,$('valClass').value);
  $('valOut').innerHTML=`<div class="alert-inline ${d.missingCount?'alert-danger':'alert-ok'}">นักเรียน ${d.studentCount} คน · รายวิชา ${d.subjectCount} วิชา · รายการที่ยังไม่ครบ ${d.missingCount} รายการ</div>`;
}

/* ---------------- Classes (admin) ---------------- */
async function renderClasses(p){
  if(!state.me.roles.includes('ADMIN')){p.innerHTML='<div class="card">ไม่มีสิทธิ์</div>';return;}
  const [cls,users]=await Promise.all([call('getClasses',state.token,state.period.year,state.period.term),call('getUsers',state.token)]);
  const opts=users.map(u=>`<option value="${u.userId}">${escapeHtml(u.fullName)}</option>`).join('');
  p.innerHTML=`<h2>ตั้งค่าห้อง / ครูประจำชั้น</h2>${periodBannerHtml()}<p class="section-note">หน้านี้แสดงเฉพาะห้องเรียนของภาคเรียน/ปีการศึกษาที่เลือกไว้ด้านบนเท่านั้น — ${String(state.period.term)==='1'?'ปีการศึกษาใหม่ให้กด "＋เพิ่มห้องเรียน" สร้างห้องใหม่':'ภาคเรียนนี้ดึงห้อง ครูประจำชั้น และรายชื่อนักเรียนจากภาคเรียนที่ 1 ของปีการศึกษาเดียวกันมาให้อัตโนมัติ แก้ไขได้ด้วยปุ่ม ✏️ (ห้องที่ลบออกแล้วจะไม่ถูกดึงกลับมาอีก)'} (ห้องของภาคเรียนอื่นยังอยู่ครบ ดูได้โดยสลับปี/ภาคเรียนด้านบน)</p><div class="card"><h3 id="classFormTitle">เพิ่มห้องเรียน</h3><input type="hidden" id="clId"><div class="grid grid-2"><div class="field"><label>ระดับชั้น</label><input id="clLevel" placeholder="ม.2"></div><div class="field"><label>ห้อง</label><input id="clRoom" placeholder="3"></div><div class="field"><label>ครูประจำชั้น 1</label><select id="clHome1"><option value="">-</option>${opts}</select></div><div class="field"><label>ครูประจำชั้น 2</label><select id="clHome2"><option value="">-</option>${opts}</select></div></div><div class="toolbar"><button class="btn btn-primary" onclick="saveClassNow()">บันทึกห้องเรียน</button><button class="btn btn-secondary" id="clCancelBtn" onclick="resetClassForm()" style="display:none">ยกเลิกแก้ไข</button><span class="spacer"></span><button class="btn btn-secondary" onclick="downloadCsv('เทมเพลต_ห้องเรียน.csv',CSV_TEMPLATES.classes)">⬇ เทมเพลต CSV</button><button class="btn btn-secondary" onclick="openCsvImportModal('ห้องเรียน','importClassesCsv',()=>renderClasses($(\`page\`)))">⬆ นำเข้า CSV</button></div></div>
  <div class="card" style="margin-top:14px">${bulkBarHtml('classTable',"bulkDeleteWith('classTable','deleteClass',()=>renderClasses($('page')))")}<div class="table-wrap"><table class="data-table" id="classTable"><thead><tr><th><input type="checkbox" onchange="toggleAllBulk(this,'classTable')"></th><th>ห้อง</th><th>ครูประจำชั้น 1</th><th>ครูประจำชั้น 2</th><th></th></tr></thead><tbody>${cls.map(c=>`<tr><td><input type="checkbox" class="bulk-check" value="${c.classId}" onchange="updateBulkBar('classTable')"></td><td>${escapeHtml(c.className)}</td><td>${escapeHtml((users.find(u=>u.userId===c.homeroomUser1)||{}).fullName||'')}</td><td>${escapeHtml((users.find(u=>u.userId===c.homeroomUser2)||{}).fullName||'')}</td><td class="row-actions"><button class="btn-icon" title="แก้ไข" onclick='loadClassForEdit(${JSON.stringify(c).replace(/'/g,"&#39;")})'>✏️</button><button class="btn-icon" title="ลบ" onclick="deleteClassNow('${c.classId}')">🗑️</button></td></tr>`).join('')}</tbody></table></div></div>`;
}
function openStudentsForClass(classId){
  go('students');
  setTimeout(()=>{
    const sel=$('classStudentSelect');
    if(sel){ sel.value=classId; loadStudentsGrid(); }
  },120);
}
function loadClassForEdit(c){
  $('clId').value=c.classId;$('clLevel').value=c.level;$('clRoom').value=c.room;$('clHome1').value=c.homeroomUser1||'';$('clHome2').value=c.homeroomUser2||'';
  $('classFormTitle').textContent='แก้ไขห้องเรียน: '+c.className;$('clCancelBtn').style.display='';
  window.scrollTo({top:0,behavior:'smooth'});
}
function resetClassForm(){['clId','clLevel','clRoom'].forEach(id=>$(id).value='');$('clHome1').value='';$('clHome2').value='';$('classFormTitle').textContent='เพิ่มห้องเรียน';$('clCancelBtn').style.display='none';}
async function saveClassNow(){
  try{await call('saveClass',state.token,{classId:$('clId').value||undefined,academicYear:state.period.year,term:state.period.term,level:$('clLevel').value,room:$('clRoom').value,homeroomUser1:$('clHome1').value,homeroomUser2:$('clHome2').value});toast('บันทึกห้องเรียนแล้ว',true);await renderClasses($('page'));}catch(e){toast(e.message);}
}
async function deleteClassNow(classId){
  if(!confirm('ลบห้องเรียนนี้?'))return;
  try{await call('deleteClass',state.token,classId);toast('ลบห้องเรียนแล้ว',true);await renderClasses($('page'));}catch(e){toast(e.message);}
}

/* ---------------- Activities admin ---------------- */
async function renderActivitiesAdmin(p){
  if(!state.me.roles.includes('ADMIN')){p.innerHTML='<div class="card">ไม่มีสิทธิ์</div>';return;}
  const [acts,cls,users]=await Promise.all([call('getActivities',state.token),call('getClasses',state.token,state.period.year,state.period.term),call('getUsers',state.token)]);
  const aas=await call('getActivityAssignments',state.token,state.period.year,state.period.term);
  p.innerHTML=`<h2>ตั้งค่ากิจกรรม / ผู้รับผิดชอบ</h2>
  <div class="card"><h3 id="actTypeFormTitle">เพิ่มประเภทกิจกรรม</h3><input type="hidden" id="atId"><div class="grid grid-2"><div class="field"><label>ชื่อกิจกรรม</label><input id="atName" placeholder="เช่น ชุมนุม, แนะแนว, ลูกเสือ-เนตรนารี"></div><div class="field"><label>รหัสประเภท (ภายใน)</label><select id="atType"><option value="GUIDANCE">แนะแนว (GUIDANCE)</option><option value="SCOUT">ลูกเสือ-เนตรนารี (SCOUT)</option><option value="SERVICE">สาธารณประโยชน์ (SERVICE)</option><option value="CLUB">ชุมนุม (CLUB)</option><option value="OTHER">อื่นๆ (OTHER)</option></select></div><div class="field"><label>เวลาเรียน (ชม.)</label><input id="atHours" type="number"></div><div class="field" style="align-self:end"><label><input type="checkbox" id="atCrossClass"> คละห้อง (สมาชิกมาจากหลายห้อง เช่น ชุมนุม)</label></div></div><div class="toolbar"><button class="btn btn-primary" onclick="saveActivityType()">บันทึกกิจกรรม</button><button class="btn btn-secondary" id="atCancelBtn" onclick="resetActivityTypeForm()" style="display:none">ยกเลิกแก้ไข</button></div></div>
  <div class="card" style="margin-top:14px"><h3>ประเภทกิจกรรม</h3>${bulkBarHtml('actTypeTable',"bulkDeleteWith('actTypeTable','deleteActivity',()=>renderActivitiesAdmin($('page')))")}<div class="table-wrap"><table class="data-table" id="actTypeTable"><thead><tr><th><input type="checkbox" onchange="toggleAllBulk(this,'actTypeTable')"></th><th>ชื่อ</th><th>รหัส</th><th>ชม.</th><th>คละห้อง</th><th></th></tr></thead><tbody>${acts.map(a=>`<tr><td><input type="checkbox" class="bulk-check" value="${a.activityId}" onchange="updateBulkBar('actTypeTable')"></td><td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.type)}</td><td>${a.hours??''}</td><td>${a.crossClass?'✅':''}</td><td class="row-actions"><button class="btn-icon" title="แก้ไข" onclick='loadActivityTypeForEdit(${JSON.stringify(a).replace(/'/g,"&#39;")})'>✏️</button><button class="btn-icon" title="ลบ" onclick="deleteActivityTypeNow('${a.activityId}')">🗑️</button></td></tr>`).join('')}</tbody></table></div></div>
  <div class="card" style="margin-top:14px"><h3>มอบหมายผู้รับผิดชอบ</h3>${periodBannerHtml()}<p class="section-note">รายการมอบหมายด้านล่างเป็นของภาคเรียน/ปีการศึกษาที่เลือกไว้ด้านบนเท่านั้น (ประเภทกิจกรรมด้านบนใช้ร่วมกันได้ทุกภาคเรียน)</p><div class="grid grid-2"><div class="field"><label>กิจกรรม</label><select id="aaAct" onchange="toggleAaClassField()">${acts.map(a=>`<option value="${a.activityId}" data-cross="${a.crossClass?1:0}">${escapeHtml(a.name)}</option>`).join('')}</select></div><div class="field" id="aaClassWrap"><label>ห้อง</label><select id="aaClass"><option value="">- คละห้อง (ไม่ระบุห้อง) -</option>${cls.map(c=>`<option value="${c.classId}">${escapeHtml(c.className)}</option>`).join('')}</select></div><div class="field"><label>กลุ่ม/ชื่อชุมนุม</label><input id="aaGroup" placeholder="เช่น ชุมนุมคอมพิวเตอร์"></div><div class="field"><label>ครูผู้รับผิดชอบ</label><select id="aaTeacher">${users.filter(u=>u.roles.includes('TEACHER')||u.roles.includes('ADMIN')).map(u=>`<option value="${u.userId}">${escapeHtml(u.fullName)}</option>`).join('')}</select></div></div><div class="toolbar"><button class="btn btn-primary" onclick="saveAA()">บันทึกการมอบหมายกิจกรรม</button><span class="spacer"></span><button class="btn btn-secondary" onclick="downloadCsv('เทมเพลต_มอบหมายกิจกรรม.csv',CSV_TEMPLATES.activityAssignments)">⬇ เทมเพลต CSV</button><button class="btn btn-secondary" onclick="openCsvImportModal('มอบหมายกิจกรรม','importActivityAssignmentsCsv',()=>renderActivitiesAdmin($(\`page\`)))">⬆ นำเข้า CSV</button></div>
    ${bulkBarHtml('aaTable',"bulkDeleteWith('aaTable','deleteActivityAssignment',()=>renderActivitiesAdmin($('page')))")}
    <div class="table-wrap" style="margin-top:10px"><table class="data-table" id="aaTable"><thead><tr><th><input type="checkbox" onchange="toggleAllBulk(this,'aaTable')"></th><th>กิจกรรม</th><th>กลุ่ม</th><th>ห้อง</th><th>ครูผู้รับผิดชอบ</th><th></th></tr></thead><tbody>${aas.map(a=>`<tr><td><input type="checkbox" class="bulk-check" value="${a.activityAssignmentId}" onchange="updateBulkBar('aaTable')"></td><td>${escapeHtml(a.activityName)}</td><td>${escapeHtml(a.groupName||'')}</td><td>${escapeHtml(a.className||'คละห้อง')}</td><td>${escapeHtml((users.find(u=>u.userId===a.teacherUserId)||{}).fullName||'')}</td><td class="row-actions">${a.crossClass?`<button class="btn-icon" title="จัดการสมาชิก" onclick="openClubRosterModal('${a.activityAssignmentId}')">👥</button>`:''}<button class="btn-icon" title="ลบ" onclick="deleteAANow('${a.activityAssignmentId}')">🗑️</button></td></tr>`).join('')}</tbody></table></div>
  </div>`;
  toggleAaClassField();
}
function toggleAaClassField(){
  const sel=$('aaAct');const cross=sel.options[sel.selectedIndex]?.dataset.cross==='1';
  $('aaClassWrap').style.display=cross?'none':'';
}
function loadActivityTypeForEdit(a){
  $('atId').value=a.activityId;$('atName').value=a.name;$('atType').value=a.type;$('atHours').value=a.hours??'';$('atCrossClass').checked=!!a.crossClass;
  $('actTypeFormTitle').textContent='แก้ไขกิจกรรม: '+a.name;$('atCancelBtn').style.display='';
  window.scrollTo({top:0,behavior:'smooth'});
}
function resetActivityTypeForm(){['atId','atName','atHours'].forEach(id=>$(id).value='');$('atType').value='OTHER';$('atCrossClass').checked=false;$('actTypeFormTitle').textContent='เพิ่มประเภทกิจกรรม';$('atCancelBtn').style.display='none';}
async function saveActivityType(){
  try{await call('saveActivity',state.token,{activityId:$('atId').value||undefined,name:$('atName').value,type:$('atType').value,hours:$('atHours').value,crossClass:$('atCrossClass').checked});toast('บันทึกกิจกรรมแล้ว',true);await renderActivitiesAdmin($('page'));}catch(e){toast(e.message);}
}
async function deleteActivityTypeNow(activityId){
  if(!confirm('ลบกิจกรรมนี้?'))return;
  try{await call('deleteActivity',state.token,activityId);toast('ลบกิจกรรมแล้ว',true);await renderActivitiesAdmin($('page'));}catch(e){toast(e.message);}
}
async function saveAA(){
  try{await call('saveActivityAssignment',state.token,{academicYear:state.period.year,term:state.period.term,activityId:$('aaAct').value,classId:$('aaClass').value,groupName:$('aaGroup').value,teacherUserId:$('aaTeacher').value});toast('บันทึกการมอบหมายกิจกรรมแล้ว',true);await renderActivitiesAdmin($('page'));}catch(e){toast(e.message);}
}
async function deleteAANow(activityAssignmentId){
  if(!confirm('ยกเลิกการมอบหมายนี้?'))return;
  try{await call('deleteActivityAssignment',state.token,activityAssignmentId);toast('ยกเลิกการมอบหมายแล้ว',true);await renderActivitiesAdmin($('page'));}catch(e){toast(e.message);}
}

/* ---- ชุมนุม / cross-class roster picker ----
 * FIX (การค้นหาในหน้า "จัดการสมาชิก" ใช้งานไม่ได้): the old version stored the
 * fetched candidate list on `window._clubList` and re-looked-up the search box
 * and table body by id every keystroke via document.getElementById('clubSearch')
 * / ('clubRows'). openClubRosterModal() never guarded against being called a
 * second time before the first modal finished loading (e.g. an impatient
 * double-click on "👥 จัดการสมาชิก" while the getClubCandidates() round trip
 * was still in flight, or opening it for a second club before closing the
 * first). .modal is `position:fixed;inset:0`, so two of them stack as two
 * full-screen overlays: the newest paints on top and is what the teacher sees
 * and types into, but getElementById() returns the FIRST (oldest, hidden)
 * element in the document — so the visible search box's keystrokes were read
 * from, and its results written to, the WRONG modal entirely. From the
 * teacher's side this looked exactly like "ค้นหาด้วยตัวอักษรไม่ได้ -- search,
 * nothing happens": the visible list just never updated no matter what was
 * typed. Fixed by keeping every reference scoped to the specific modal
 * instance (closures, not ids/globals) and by refusing to open a second
 * instance while one is already open or still loading.
 */
let _clubModalBusy = false;
async function openClubRosterModal(activityAssignmentId,refreshFn){
  if (_clubModalBusy) return; // a previous click is still loading or a modal is already open
  const already = document.getElementById('clubModal');
  if (already) already.remove(); // defensive cleanup in case an earlier one was left behind
  _clubModalBusy = true;
  try {
    const list = await call('getClubCandidates',state.token,activityAssignmentId);
    const wrap = document.createElement('div');
    wrap.className = 'modal'; wrap.id = 'clubModal';
    wrap.innerHTML = `<div class="modal-card" style="max-width:640px"><h3>จัดการสมาชิกชุมนุม</h3><input type="text" placeholder="ค้นหาชื่อ / เลขประจำตัว / ห้อง..." style="width:100%;margin-bottom:10px;padding:8px;border:1px solid #cbd5e1;border-radius:8px"><div class="table-wrap" style="max-height:50vh"><table class="data-table"><thead><tr><th></th><th>เลขประจำตัว</th><th>ชื่อ-สกุล</th><th>ห้อง</th></tr></thead><tbody></tbody></table></div><p class="muted"></p><div class="toolbar" style="margin-top:10px"><button class="btn btn-primary">บันทึกสมาชิก</button><button class="btn btn-secondary">ยกเลิก</button></div></div>`;
    document.body.appendChild(wrap);

    // Scoped, one per open modal — no id collisions possible even if this
    // function somehow runs again before wrap is removed.
    const searchEl = wrap.querySelector('input');
    const rowsEl = wrap.querySelector('tbody');
    const countEl = wrap.querySelector('.muted');
    const [saveBtn, cancelBtn] = wrap.querySelectorAll('.toolbar button');
    const norm = s => String(s||'').normalize('NFC').trim().toLowerCase(); // FIX: normalize so Excel-imported Thai text with a different combining-mark order still matches what's typed

    const draw = filterText => {
      const f = norm(filterText);
      const rows = list.filter(s => !f || norm(s.name).includes(f) || norm(s.studentCode).includes(f) || norm(s.className).includes(f));
      rowsEl.innerHTML = rows.map(s=>`<tr><td><input type="checkbox" data-sid="${s.studentId}" ${s.isMember?'checked':''}></td><td>${escapeHtml(s.studentCode)}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.className)}</td></tr>`).join('');
      countEl.textContent = 'เลือกแล้ว '+list.filter(x=>x.isMember).length+' คน'+(f?` (พบ ${rows.length} จากการค้นหา)`:'');
    };
    searchEl.addEventListener('input', ()=>draw(searchEl.value));
    rowsEl.addEventListener('change', e=>{
      const cb = e.target.closest('input[type="checkbox"]'); if(!cb) return;
      const item = list.find(x=>x.studentId===cb.dataset.sid); if(item) item.isMember = cb.checked;
      countEl.textContent = 'เลือกแล้ว '+list.filter(x=>x.isMember).length+' คน';
    });
    const close = ()=>wrap.remove();
    cancelBtn.addEventListener('click', close);
    saveBtn.addEventListener('click', async ()=>{
      const ids = list.filter(x=>x.isMember).map(x=>x.studentId);
      try{
        const r = await call('setClubMembers',state.token,activityAssignmentId,ids);
        close();
        toast(`บันทึกสมาชิกชุมนุมแล้ว (ทั้งหมด ${r.total} คน)`,true);
        await (refreshFn || (()=>renderActivitiesAdmin($('page'))))();
      }catch(e){ toast(e.message); }
    });

    draw('');
  } catch(e) {
    toast(e.message);
  } finally {
    _clubModalBusy = false;
  }
}

/* ---- หน้าลงทะเบียนนักเรียนชุมนุม (สำหรับครูประจำชุมนุมเอง ไม่ต้องผ่านหน้าแอดมิน) ---- */
async function renderClubRegister(p){
  const aas=await call('getActivityAssignments',state.token,state.period.year,state.period.term);
  const clubs=aas.filter(a=>a.crossClass);
  if(!clubs.length){p.innerHTML='<h2>ลงทะเบียนนักเรียนชุมนุม</h2><div class="card"><p class="muted">ยังไม่มีชุมนุมที่ท่านรับผิดชอบ — หากดูแลชุมนุม กรุณาแจ้งแอดมินให้มอบหมายชุมนุมนั้นให้ท่านก่อน</p></div>';return;}
  p.innerHTML=`<h2>ลงทะเบียนนักเรียนชุมนุม</h2><p class="muted">เลือกชุมนุมที่ท่านรับผิดชอบ แล้วกดจัดการสมาชิก เพื่อเลือกนักเรียนจากทุกห้อง/ทุกระดับชั้นเข้าชุมนุม</p><div class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>ชุมนุม</th><th>กลุ่ม</th><th></th></tr></thead><tbody>${clubs.map(c=>`<tr><td>${escapeHtml(c.activityName)}</td><td>${escapeHtml(c.groupName||'-')}</td><td><button class="btn btn-primary" onclick="openClubRosterModal('${c.activityAssignmentId}',()=>renderClubRegister($('page')))">👥 จัดการสมาชิก</button></td></tr>`).join('')}</tbody></table></div></div>`;
}

/* ---------------- Users (admin) ---------------- */
async function renderUsers(p){
  if(!state.me.roles.includes('ADMIN')){p.innerHTML='<div class="card">ไม่มีสิทธิ์</div>';return;}
  const [users,cfg]=await Promise.all([call('getUsers',state.token),call('getSchoolConfig',state.token)]);
  p.innerHTML=`<h2>ผู้ใช้งาน</h2>
  <div class="card period-settings-card"><div class="section-heading"><div><span class="section-kicker">ACADEMIC PERIOD</span><h3>ตั้งค่าภาคเรียน / ปีการศึกษา</h3></div><span class="soft-badge">${state.period.year} · ภาคเรียน ${state.period.term}</span></div><div class="grid grid-2"><div class="field"><label>ปีการศึกษา</label><input id="newPeriodYear" inputmode="numeric" value="${escapeHtml(state.period.year||'2569')}"></div><div class="field"><label>ภาคเรียนที่</label><select id="newPeriodTerm"><option value="1">1</option><option value="2">2</option></select></div><div class="field"><label>ชื่อช่วงการศึกษา (ไม่บังคับ)</label><input id="newPeriodLabel" placeholder="เช่น ปีการศึกษา 2569 · ภาคเรียน 1"></div></div><div class="toolbar"><button class="btn btn-primary" onclick="savePeriodSettingNow(false)">＋ เพิ่ม/บันทึกช่วงการศึกษา</button><button class="btn btn-secondary" onclick="savePeriodSettingNow(true)">⭐ ตั้งเป็นช่วงปัจจุบัน</button></div><div class="table-wrap" style="margin-top:12px"><table class="data-table period-list-table"><thead><tr><th>ปีการศึกษา</th><th>ภาคเรียน</th><th>สถานะ</th><th>การทำงาน</th></tr></thead><tbody>${(state.periods||[]).map(x=>`<tr><td>${escapeHtml(x.year)}</td><td>${escapeHtml(x.term)}</td><td>${x.isCurrent?'<span class="soft-badge soft-green">ปัจจุบัน</span>':'-'}</td><td class="row-actions"><button class="btn btn-secondary btn-sm" onclick="useAcademicPeriod('${escapeHtml(x.year)}','${escapeHtml(x.term)}')">ใช้ช่วงนี้</button>${!x.isCurrent?`<button class="btn-icon" title="ลบช่วงนี้" onclick="deleteAcademicPeriodNow('${escapeHtml(x.year)}','${escapeHtml(x.term)}')">🗑️</button>`:''}</td></tr>`).join('')||'<tr><td colspan="4" class="muted center">ยังไม่มีรายการ</td></tr>'}</tbody></table></div></div>
  <div class="card"><h3>ตั้งค่าโรงเรียน (ใช้พิมพ์บนเอกสาร ปพ.6)</h3><div class="grid grid-2"><div class="field"><label>ชื่อโรงเรียน</label><input id="cfgSchoolName" value="${escapeHtml(cfg.SCHOOL_NAME||'')}"></div><div class="field"><label>จังหวัด</label><input id="cfgSchoolProvince" value="${escapeHtml(cfg.SCHOOL_PROVINCE||'')}"></div><div class="field"><label>ชื่อผู้อำนวยการโรงเรียน</label><input id="cfgPrincipal" value="${escapeHtml(cfg.PRINCIPAL_NAME||'')}"></div><div class="field"><label>ปีการศึกษาปัจจุบัน</label><input id="cfgYear" value="${escapeHtml(cfg.CURRENT_YEAR||'')}"></div><div class="field"><label>ภาคเรียนปัจจุบัน</label><input id="cfgTerm" value="${escapeHtml(cfg.CURRENT_TERM||'')}"></div></div><div class="toolbar"><button class="btn btn-primary" onclick="saveSchoolConfigNow()">บันทึกการตั้งค่าโรงเรียน</button></div></div>
  <div class="card" style="margin-top:14px"><h3>สร้างผู้ใช้ใหม่</h3><div class="grid grid-2"><div class="field"><label>Username</label><input id="newUser"></div><div class="field"><label>ชื่อ-สกุล</label><input id="newName"></div><div class="field"><label>Role</label><select id="newRole"><option>TEACHER</option><option>HOMEROOM</option><option>TEACHER,HOMEROOM</option><option>ADMIN</option></select></div><div class="field"><label>รหัสผ่านเริ่มต้น</label><input id="newPass" type="password"></div></div><div class="toolbar"><button class="btn btn-primary" onclick="createUser()">สร้างผู้ใช้</button><span class="spacer"></span><button class="btn btn-secondary" onclick="downloadCsv('เทมเพลต_ครู.csv',CSV_TEMPLATES.teachers)">⬇ เทมเพลต CSV</button><button class="btn btn-secondary" onclick="openCsvImportModal('บัญชีผู้ใช้','importTeachersCsv',()=>renderUsers($(\`page\`)))">⬆ นำเข้า CSV</button></div></div>
  <div class="card" style="margin-top:14px"><p class="muted">🔒 เพื่อความปลอดภัย ระบบเก็บรหัสผ่านแบบเข้ารหัส (hash) เท่านั้น จึงไม่สามารถ "ดูรหัสผ่านเดิม" ได้ — ใช้ปุ่ม "ตั้งรหัสผ่านใหม่" แทนเพื่อกำหนดรหัสผ่านชั่วคราวให้ผู้ใช้แล้วบังคับให้เปลี่ยนเมื่อเข้าสู่ระบบครั้งถัดไป</p><div class="toolbar"><button class="btn btn-secondary" onclick="purgeDeletedUsersNow()">🧹 ล้างแถวเสีย / บัญชีที่ปิดใช้งาน ออกจากชีตถาวร</button></div>${bulkBarHtml('userTable',"bulkDeleteWith('userTable','deleteUser',()=>renderUsers($('page')))")}<div class="table-wrap"><table class="data-table" id="userTable"><thead><tr><th><input type="checkbox" onchange="toggleAllBulk(this,'userTable')"></th><th>Username</th><th>ชื่อ</th><th>Role</th><th>Active</th><th></th></tr></thead><tbody>${users.map(u=>`<tr><td>${u.userId!==state.me.userId?`<input type="checkbox" class="bulk-check" value="${u.userId}" onchange="updateBulkBar('userTable')">`:''}</td><td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.fullName)}</td><td>${escapeHtml(u.roles.join(','))}</td><td>${u.active===false?'ปิด':'เปิด'}</td><td class="row-actions"><button class="btn-icon" title="ตั้งรหัสผ่านใหม่" onclick="openResetPasswordModal('${u.userId}','${escapeHtml(u.fullName)}')">🔑</button>${u.userId!==state.me.userId?`<button class="btn-icon" title="ลบผู้ใช้" onclick="deleteUserNow('${u.userId}')">🗑️</button>`:''}</td></tr>`).join('')}</tbody></table></div></div>`;
}
async function savePeriodSettingNow(setCurrent){try{const year=$('newPeriodYear').value.trim(),term=$('newPeriodTerm').value,label=$('newPeriodLabel').value.trim();if(!year||!term)return toast('กรุณาระบุปีการศึกษาและภาคเรียน');
  // เตือนเมื่อเป็นปีการศึกษาใหม่ที่ยังไม่เคยมีในระบบ -- รายชื่อนักเรียนในห้อง
  // (CLASS_MEMBERS) ไม่ได้ผูกกับปีการศึกษาโดยอัตโนมัติ ถ้าแอดมินใช้ห้องเรียน
  // (ClassID) เดิมข้ามปีโดยไม่ล้าง/ตรวจสอบก่อน นักเรียนรุ่นเก่าที่ยังมีสถานะ
  // Active อยู่จะถูกดึงไปลงทะเบียนวิชาปนกับนักเรียนรุ่นใหม่ทันทีเมื่อครูตั้งวิชา
  // สอนของปีใหม่ (ดู ensureEnrollments_ ฝั่ง Code.gs)
  const isNewYear = !(state.periods||[]).some(p=>String(p.year)===String(year));
  if(isNewYear){
    const proceed=confirm('⚠️ ปีการศึกษา '+year+' ยังไม่เคยมีในระบบมาก่อน\n\nระบบไม่ได้ผูกรายชื่อนักเรียนในห้องเข้ากับปีการศึกษาโดยอัตโนมัติ หากใช้ห้องเรียนเดิมข้ามปีการศึกษา นักเรียนรุ่นเก่าที่ยังมีสถานะอยู่ในห้องจะถูกดึงไปลงทะเบียนวิชาปนกับรุ่นใหม่ทันที\n\nแนะนำให้ไปตรวจสอบ/ล้างรายชื่อนักเรียนแต่ละห้องก่อน (หน้า "ลงทะเบียนนักเรียน" ปุ่ม 🧹 ล้างข้อมูลนักเรียนทั้งห้อง) หรือสร้างห้องเรียนใหม่แยกสำหรับปีนี้\n\nกด ตกลง เพื่อบันทึกช่วงการศึกษานี้ต่อไป หรือ ยกเลิก เพื่อไปตรวจสอบห้องเรียนก่อน');
    if(!proceed) return;
  }
  if(setCurrent){await call('setCurrentAcademicPeriod',state.token,year,term);}else{await call('saveAcademicPeriod',state.token,{year,term,label});}state.periods=await call('getAcademicPeriods',state.token);if(setCurrent){state.period={year,term};localStorage.setItem('pp6_period',JSON.stringify(state.period));state.dashboard=await call('getDashboard',state.token,year,term);}toast(setCurrent?'ตั้งเป็นช่วงปัจจุบันแล้ว':'บันทึกช่วงการศึกษาแล้ว',true);await renderUsers($('page'));}catch(e){toast(e.message);}}
async function useAcademicPeriod(year,term){state.period={year,term};localStorage.setItem('pp6_period',JSON.stringify(state.period));try{state.dashboard=await call('getDashboard',state.token,year,term);await renderRoute();}catch(e){toast(e.message);}}
async function deleteAcademicPeriodNow(year,term){if(!confirm(`ลบช่วงการศึกษา ${year} ภาคเรียน ${term} ?`))return;try{await call('deleteAcademicPeriod',state.token,year,term);state.periods=await call('getAcademicPeriods',state.token);await renderUsers($('page'));toast('ลบช่วงการศึกษาแล้ว',true);}catch(e){toast(e.message);}}
async function saveSchoolConfigNow(){
  try{await call('saveSchoolConfig',state.token,{SCHOOL_NAME:$('cfgSchoolName').value,SCHOOL_PROVINCE:$('cfgSchoolProvince').value,PRINCIPAL_NAME:$('cfgPrincipal').value,CURRENT_YEAR:$('cfgYear').value,CURRENT_TERM:$('cfgTerm').value});toast('บันทึกการตั้งค่าโรงเรียนแล้ว',true);}catch(e){toast(e.message);}
}
async function createUser(){
  try{await call('saveUser',state.token,{username:$('newUser').value,fullName:$('newName').value,role:$('newRole').value,password:$('newPass').value,active:true});toast('สร้างผู้ใช้แล้ว',true);await renderUsers($('page'));}catch(e){toast(e.message);}
}
async function deleteUserNow(userId){
  if(!confirm('ลบผู้ใช้นี้? บัญชีจะถูกปิดใช้งาน ออกจากระบบทันที และหายจากรายชื่อ\n(ชื่อผู้ใช้เดิมนำกลับมาสร้างใหม่ได้)'))return;
  try{await call('deleteUser',state.token,userId);toast('ลบผู้ใช้แล้ว',true);await renderUsers($('page'));}catch(e){toast(e.message);}
}
// "ลบถาวร": ลบแถวบัญชีที่ปิดใช้งานแล้วออกจากชีต USERS จริง ๆ
// บัญชีที่ยังถูกอ้างถึง (สอนวิชา/ครูประจำชั้น/ดูแลกิจกรรม) จะถูกข้ามและรายงานกลับมา
async function purgeDeletedUsersNow(){
  if(!confirm('ลบแถวบัญชีที่ปิดใช้งานแล้วออกจากชีต USERS อย่างถาวร?\nการกระทำนี้ย้อนกลับไม่ได้ — บัญชีที่ยังถูกใช้งานอ้างอิงอยู่จะถูกข้ามให้อัตโนมัติ'))return;
  try{
    const r=await call('purgeDeletedUsers',state.token);
    if(!r.total){toast('ไม่มีแถวเสียหรือบัญชีที่ปิดใช้งานให้ลบ',true);return;}
    const parts=[];
    if(r.removed)parts.push(`บัญชีที่ปิดใช้งาน ${r.removed} รายการ`);
    if(r.junkRemoved)parts.push(`แถวเสีย (ไม่มี UserID) ${r.junkRemoved} แถว`);
    toast(`ลบถาวรแล้ว: ${parts.join(' + ')||'0 รายการ'}${r.skipped.length?` — ข้าม ${r.skipped.length} บัญชีที่ยังถูกอ้างถึง: ${r.skipped.join(', ')}`:''}`,!r.skipped.length);
    await renderUsers($('page'));
  }catch(e){toast(e.message);}
}
function openResetPasswordModal(userId,fullName){
  $('page').insertAdjacentHTML('beforeend',`<div class="modal" id="resetPwModal"><div class="modal-card"><h3>ตั้งรหัสผ่านใหม่: ${fullName}</h3><div class="field"><label>รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)</label><input id="resetPwValue" type="text"></div><p class="muted">ผู้ใช้จะถูกบังคับให้เปลี่ยนรหัสผ่านนี้ในการเข้าสู่ระบบครั้งถัดไป</p><div class="toolbar"><button class="btn btn-primary" onclick="doResetPassword('${userId}')">บันทึก</button><button class="btn btn-secondary" onclick="closeModal('resetPwModal')">ยกเลิก</button></div></div></div>`);
}
async function doResetPassword(userId){
  try{await call('adminResetPassword',state.token,userId,$('resetPwValue').value);closeModal('resetPwModal');toast('ตั้งรหัสผ่านใหม่แล้ว',true);}catch(e){toast(e.message);}
}
function showPasswordModal(){$('appView').insertAdjacentHTML('beforeend',`<div class="modal" id="pwModal"><div class="modal-card"><h3>เปลี่ยนรหัสผ่าน</h3><div class="field"><label>รหัสผ่านเดิม</label><input id="oldPw" type="password"></div><div class="field"><label>รหัสผ่านใหม่</label><input id="newPw" type="password"></div><button class="btn btn-primary" onclick="changePw()">บันทึก</button> <button class="btn btn-secondary" onclick="closeModal('pwModal')">ยกเลิก</button></div></div>`);}
async function changePw(){try{await call('changePassword',state.token,$('oldPw').value,$('newPw').value);closeModal('pwModal');toast('เปลี่ยนรหัสผ่านแล้ว',true);state.me.forceChangePassword=false;}catch(e){toast(e.message);}}

/* ---------------- CSV templates + generic import ---------------- */
const CSV_TEMPLATES={
  students:'เลขที่,เลขประจำตัว,คำนำหน้า,ชื่อ,นามสกุล,เพศ\n1,10204,เด็กชาย,จิรภัทร,เลิศชัยกูล,ชาย\n2,10205,เด็กชาย,กรินทร์,จันทร์มงคล,ชาย',
  subjects:'รหัสวิชา,ชื่อวิชา,ประเภท,หน่วยกิต,เวลาเรียน\nท22101,ภาษาไทย 3,พื้นฐาน,1.5,60\nค22201,คณิตศาสตร์เพิ่มเติม 3,เพิ่มเติม,0.5,20',
  teachers:'Username,ชื่อ-สกุล,Role,รหัสผ่านเริ่มต้น\nsomsri.t,นางสมศรี ใจดี,TEACHER,Passw0rd123\nsurin.h,นายสุรินทร์ มั่นคง,"TEACHER,HOMEROOM",Passw0rd123',
  teaching:'ห้อง,รหัสวิชา,Username ครู,คะแนนเต็ม,หน่วยกิต,เวลาเรียน\nม.2/3,ท22101,somsri.t,100,1.5,60',
  classes:'ระดับชั้น,ห้อง,Username ครูประจำชั้น1,Username ครูประจำชั้น2\nม.2,3,surin.h,',
  activityAssignments:'กิจกรรม,ห้อง(หรือ ALL สำหรับคละห้อง),กลุ่ม/ชื่อชุมนุม,Username ครู\nชุมนุม,ALL,ชุมนุมคอมพิวเตอร์,somsri.t\nแนะแนว,ม.2/3,,surin.h',
  assessment:'เลขที่,อ่านคิดวิเคราะห์เขียน,คุณลักษณะอันพึงประสงค์,สมรรถนะสำคัญ\n1,3,3,2\n2,2,3,3'
};
function downloadCsv(filename,content){
  const blob=new Blob(['\uFEFF'+content],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function parseClientDelimited_(text){
  text=String(text||'').replace(/^\uFEFF/,'').replace(/\r/g,'');
  if(!text.trim())return [];
  const lines=text.split('\n').filter(line=>line.trim()!=='');
  if(!lines.length)return [];
  const sample=lines[0];
  const tab=(sample.match(/\t/g)||[]).length;
  const semi=(sample.match(/;/g)||[]).length;
  const comma=(sample.match(/,/g)||[]).length;
  const delim=tab>0?'\t':(semi>comma?';':',');
  const parseLine=(line)=>{
    const out=[];let cur='';let quoted=false;
    for(let i=0;i<line.length;i++){
      const c=line[i];
      if(quoted){
        if(c==='"'){
          if(line[i+1]==='"'){cur+='"';i++;}
          else quoted=false;
        }else cur+=c;
      }else{
        if(c==='"')quoted=true;
        else if(c===delim){out.push(cur.trim());cur='';}
        else cur+=c;
      }
    }
    out.push(cur.trim());
    return out;
  };
  return lines.map(parseLine).filter(r=>r.some(c=>String(c||'').trim()!==''));
}
function isCsvHeaderOrNote_(row){
  const joined=row.map(x=>String(x||'').trim()).join(' ').toLowerCase();
  if(!joined)return true;
  return /^(หมายเหตุ|note\b)/i.test(joined) || (joined.includes('เลขที่') && (joined.includes('อ่าน') || joined.includes('ผล') || joined.includes('คะแนน')));
}

function readFileInto(fileInputId,targetTextareaId){
  const input=$(fileInputId);if(!input.files||!input.files[0])return;
  const reader=new FileReader();
  reader.onload=()=>{$(targetTextareaId).value=String(reader.result||'');};
  reader.readAsText(input.files[0],'utf-8');
}
function openCsvImportModal(label,fnName,onDone){
  $('page').insertAdjacentHTML('beforeend',`<div class="modal" id="csvImportModal"><div class="modal-card"><h3>นำเข้าข้อมูล: ${escapeHtml(label)}</h3><p class="muted">อัปโหลดไฟล์ .csv หรือวางข้อมูลด้านล่าง (แถวแรกเป็นหัวตารางได้ ระบบจะข้ามให้อัตโนมัติ)</p><input type="file" id="csvImportFile" accept=".csv,text/csv" onchange="readFileInto('csvImportFile','csvImportText')"><textarea id="csvImportText" class="paste-box" style="margin-top:10px"></textarea><div id="csvImportResult"></div><div class="toolbar" style="margin-top:10px"><button class="btn btn-primary" onclick="runCsvImport('${fnName}')">นำเข้าข้อมูล</button><button class="btn btn-secondary" onclick="closeModal('csvImportModal')">ปิด</button></div></div></div>`);
  window._csvImportDone=onDone;
}
async function runCsvImport(fnName){
  const text=$('csvImportText').value;if(!text.trim())return toast('กรุณาเลือกไฟล์หรือวางข้อมูลก่อน');
  try{
    const r=await call(fnName,state.token,text);
    const added=r.added??r.processed??0; const updated=r.updated??0; const errs=r.errors||[];
    $('csvImportResult').innerHTML=`<div class="alert-inline ${errs.length?'alert-danger':'alert-ok'}">นำเข้าสำเร็จ ${added} รายการ${updated?', อัปเดต '+updated+' รายการ':''}${errs.length?'<br>'+errs.map(escapeHtml).join('<br>'):''}</div>`;
    toast('นำเข้าข้อมูลเรียบร้อย',true);
    if(window._csvImportDone) await window._csvImportDone();
  }catch(e){$('csvImportResult').innerHTML=`<div class="alert-inline alert-danger">${escapeHtml(e.message)}</div>`;}
}

showLogin();if(state.token)openApp();
