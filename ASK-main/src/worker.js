/**
 * YCC ASK — Cloudflare Worker
 *
 * 데이터는 KV에 단일 키(DATA_KEY)로 저장합니다.
 * 30명 규모 + 낮은 트래픽 기준으로는 이 방식이 KV 무료 티어(하루 쓰기 1,000회)를
 * 가장 여유롭게 쓰는 방법이라 이렇게 설계했어요. 요청마다 read 1회 + write 1회만 씁니다.
 *
 * 필요한 secret (한 번만 설정하면 됨):
 *   npx wrangler secret put LEADER_PASSWORD
 *   npx wrangler secret put AUTH_SECRET   (아무 긴 랜덤 문자열이면 됨. 쿠키 서명용)
 */

const DATA_KEY = 'ycc_ask_data';
const COOKIE_NAME = 'ycc_leader_token';

/*
 * 백업 로그: 질문/답변이 들어올 때마다 메인 데이터와 별개로 '자기만의 키'에 한 번 더 저장합니다.
 * 메인 데이터(DATA_KEY)는 동시에 여러 요청이 저장하면 서로 덮어써서 항목이 사라질 수 있는데,
 * 개별 키는 덮어쓸 일이 없어서 안전해요. 리더 화면의 '누락 확인' 버튼이 이걸로 빠진 항목을 복구합니다.
 */
const LOG_PREFIX = 'log:';
const LOG_TTL = 60 * 60 * 24 * 60; // 60일 보관 후 자동 삭제
const RESET_KEY = 'meta:resetAt';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1년 (로그인 유지)

const ADJECTIVES = ['어리둥절', '달리는', '반짝이는', '느긋한', '용감한', '수줍은', '엉뚱한', '단단한', '살금살금', '조용한', '씩씩한', '포근한', '엉거주춤', '신중한', '발랄한', '차분한', '활기찬', '다정한', '든든한', '상냥한', '유쾌한', '명랑한', '귀여운', '온순한', '성실한', '부지런한', '여유로운', '온화한', '재빠른', '날쌘', '늠름한', '새침한', '얌전한', '똑똑한', '야무진', '방긋웃는', '호기심많은', '엉큼한', '앙큼한', '까칠한', '시크한', '도도한', '느릿느릿한', '뒤뚱뒤뚱', '꾸벅꾸벅', '졸린', '깨어난', '춤추는', '노래하는', '웃고있는', '헤엄치는', '날아가는', '점프하는', '기지개켜는', '낮잠자는', '숨어있는', '엿보는', '돌아보는', '기다리는', '달려오는', '뛰어노는', '산책하는', '탐험하는', '모험하는', '따뜻한', '시원한', '포실포실한', '몽실몽실한', '말똥말똥한', '동글납작한', '길쭉한', '당당한', '꿋꿋한', '의젓한', '점잖은', '너그러운', '친절한', '싹싹한', '똘똘한', '슬기로운', '재치있는', '은근한', '조심스러운', '씩씩하게걷는', '반짝거리는', '말랑말랑한', '동글동글한', '네모난', '우직한', '산뜻한', '말끔한', '깔끔한', '단정한', '엉뚱하게웃는', '포근하게안는', '살살', '방실방실', '까르르웃는', '궁금한', '엉뚱발랄한', '용맹한', '넉살좋은', '싱글벙글', '해맑은'];
const ANIMALS = ['범고래', '흰오목눈이', '수달', '펭귄', '고슴도치', '다람쥐', '부엉이', '너구리', '알파카', '해달', '기린', '오소리', '두더지', '앵무새', '고양이', '여우', '토끼', '판다', '코알라', '고래상어', '돌고래', '라마', '염소', '양', '사슴', '고라니', '멧돼지', '오리', '거위', '백조', '홍학', '펠리컨', '두루미', '까치', '참새', '박새', '동고비', '딱따구리', '뻐꾸기', '올빼미', '독수리', '매', '송골매', '타조', '키위새', '바다표범', '물개', '바다코끼리', '해마', '불가사리', '해파리', '문어', '오징어', '거북이', '자라', '도롱뇽', '개구리', '두꺼비', '카멜레온', '도마뱀', '이구아나', '사막여우', '미어캣', '프레리도그', '비버', '수리부엉이', '삵', '스라소니', '살쾡이', '담비', '족제비', '밍크', '친칠라', '기니피그', '햄스터', '다람쥐원숭이', '여우원숭이', '코뿔소', '하마', '코끼리', '얼룩말', '레서판다', '왈라비', '캥거루', '웜뱃', '쿼카', '나무늘보', '아르마딜로', '듀공', '바다사자', '물범', '슴새', '되새', '박쥐', '날다람쥐'];

/* ---------------- 리더에게 텔레그램 알림 ---------------- */
async function notifyLeader(env, ctx, subject, text) {
  // TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 이 설정 안 돼있으면 그냥 건너뜀 (알림 기능은 선택 사항)
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const message = `${subject}\n\n${text}`;

  const send = fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: message,
    }),
  }).catch(err => console.error('텔레그램 알림 실패', err));

  // 알림 발송 때문에 질문/답변 응답이 느려지지 않도록 기다리지 않고 백그라운드로 처리
  if (ctx && ctx.waitUntil) ctx.waitUntil(send); else await send;
}

function randomName(existingNames) {
  const used = new Set(existingNames || []);
  let name, tries = 0;
  do {
    const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    name = `${a} ${b}`;
    tries += 1;
  } while (used.has(name) && tries < 30);
  return name;
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function nowLabel() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (type) => parts.find(p => p.type === type).value;
  const hour = get('hour').padStart(2, '0');
  return `${get('month')}.${get('day')} ${hour}:${get('minute')} ${get('dayPeriod')}`;
}

async function loadData(env) {
  const raw = await env.ask_kv.get(DATA_KEY);
  if (!raw) {
    return {
      counters: { question: 0, answer: 0 },
      questions: [],
      answers: [],
      blockedIPs: [],
    };
  }
  const data = JSON.parse(raw);
  if (!data.blockedIPs) data.blockedIPs = [];
  return data;
}

async function saveData(env, data) {
  await env.ask_kv.put(DATA_KEY, JSON.stringify(data));
}

async function writeLog(env, ctx, key, item) {
  const p = env.ask_kv.put(key, JSON.stringify({ ...item, createdAt: Date.now() }), { expirationTtl: LOG_TTL })
    .catch(err => console.error('백업 로그 저장 실패', err));
  if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
}

async function deleteLogs(env, ctx, keys) {
  const list = keys.filter(Boolean);
  if (!list.length) return;
  const p = Promise.all(list.map(k => env.ask_kv.delete(k).catch(() => {})));
  if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
}

/* 백업 로그와 메인 데이터를 비교해서 빠진 질문/답변을 다시 넣기 */
async function recoverMissing(env) {
  const resetAt = Number(await env.ask_kv.get(RESET_KEY)) || 0;

  // 백업 키 목록 가져오기
  const keys = [];
  let cursor;
  do {
    const res = await env.ask_kv.list({ prefix: LOG_PREFIX, cursor });
    keys.push(...res.keys.map(k => k.name));
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  const data = await loadData(env);
  const haveQ = new Set(data.questions.map(q => q.uid));
  const haveA = new Set(data.answers.map(a => a.logKey).filter(Boolean));

  const missingKeys = keys.filter(k =>
    k.startsWith(LOG_PREFIX + 'q:') ? !haveQ.has(k.slice((LOG_PREFIX + 'q:').length)) : !haveA.has(k)
  );
  if (!missingKeys.length) return { questions: 0, answers: 0 };

  const entries = (await Promise.all(missingKeys.map(async k => {
    const raw = await env.ask_kv.get(k);
    if (!raw) return null;
    try { return { key: k, item: JSON.parse(raw) }; } catch { return null; }
  }))).filter(e => e && (e.item.createdAt || 0) > resetAt)
    .sort((x, y) => x.item.createdAt - y.item.createdAt);

  // 동시 저장 때문에 번호가 겹쳤을 수 있으니 카운터를 실제 최대값 이상으로 맞춰둠
  const maxQNum = Math.max(0, ...data.questions.map(q => Number(String(q.qid).split('-')[1]) || 0));
  data.counters.question = Math.max(data.counters.question || 0, maxQNum);
  data.counters.answer = Math.max(data.counters.answer || 0, 0, ...data.answers.map(a => a.id || 0));

  let rq = 0, ra = 0;

  for (const { key, item } of entries.filter(e => e.key.startsWith(LOG_PREFIX + 'q:'))) {
    const { createdAt, ...q } = item;
    if (data.questions.some(x => x.qid === q.qid)) {
      // 같은 번호를 다른 질문이 이미 쓰고 있으면 새 번호 부여
      data.counters.question += 1;
      const n = pad3(data.counters.question);
      q.qid = `${q.category}-${n}`;
      q.code = `${q.category} ${n}`;
    }
    q.logKey = key;
    data.questions.push(q);
    rq += 1;
  }

  for (const { key, item } of entries.filter(e => e.key.startsWith(LOG_PREFIX + 'a:'))) {
    const { createdAt, ...a } = item;
    // 질문이 삭제된 답변은 복구하지 않음
    if (!data.questions.some(x => x.qid === a.qid)) continue;
    if (data.answers.some(x => x.id === a.id)) {
      data.counters.answer += 1;
      a.id = data.counters.answer;
    }
    a.logKey = key;
    data.answers.push(a);
    ra += 1;
  }

  if (rq || ra) await saveData(env, data);
  return { questions: rq, answers: ra };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/* ---------------- 쿠키 서명 (리더 인증) ---------------- */
async function hmac(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function makeToken(env) {
  const expiry = Date.now() + COOKIE_MAX_AGE * 1000;
  const sig = await hmac(env.AUTH_SECRET, String(expiry));
  return `${expiry}.${sig}`;
}

async function verifyToken(env, token) {
  if (!token) return false;
  const [expiryStr, sig] = token.split('.');
  if (!expiryStr || !sig) return false;
  const expiry = Number(expiryStr);
  if (!expiry || expiry < Date.now()) return false;
  const expectedSig = await hmac(env.AUTH_SECRET, expiryStr);
  return expectedSig === sig;
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

async function requireLeader(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  return verifyToken(env, token);
}

function setCookieHeader(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}; Path=/`;
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`;
}

/* ---------------- 라우터 ---------------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ---- 공개: 홈 화면용 데이터 ----
      if (path === '/api/public/data' && method === 'GET') {
        const data = await loadData(env);
        const publicQuestions = data.questions
          .filter(q => q.category === '익명' && q.public)
          .map(q => ({ qid: q.qid, uid: q.uid || q.qid, code: q.code, text: q.text, time: q.time }))
          .reverse(); // 최신순

        const categoryCounts = { 전체: 0, 그룹: 0, 익명: 0 };
        data.questions.forEach(q => {
          if (categoryCounts[q.category] !== undefined) categoryCounts[q.category] += 1;
        });

        return json({ total: data.questions.length, counters: data.counters, categoryCounts, publicQuestions });
      }

      // ---- 공개: 질문 전송 ----
      if (path === '/api/questions' && method === 'POST') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

        const body = await request.json();
        const category = body.category;
        const text = (body.text || '').trim().slice(0, 99);
        const target = category === '그룹' ? (body.target || '').trim().slice(0, 30) : null;

        if (!['전체', '익명', '그룹'].includes(category)) return json({ error: '잘못된 카테고리예요.' }, 400);
        if (!text) return json({ error: '질문 내용을 입력해주세요.' }, 400);
        if (category === '그룹' && !target) return json({ error: '받는 사람을 입력해주세요.' }, 400);

        const data = await loadData(env);

        if (data.blockedIPs.includes(ip)) {
          return json({ error: '이용이 제한됐어요.' }, 403);
        }

        data.counters.question = (data.counters.question || 0) + 1;
        const num = data.counters.question;
        const qid = `${category}-${pad3(num)}`;
        const code = `${category} ${pad3(num)}`;

        const uid = crypto.randomUUID();
        const logKey = `${LOG_PREFIX}q:${uid}`;
        const newQ = {
          qid, uid, category, code, text, target,
          time: nowLabel(),
          status: 'unread',
          public: false,
          ip,
          logKey,
        };
        data.questions.push(newQ);

        await saveData(env, data);
        await writeLog(env, ctx, logKey, newQ);

        await notifyLeader(
          env, ctx,
          `[YCC ASK] 새 질문 도착 · ${code}`,
          `${code}\n${nowLabel()}\n\n${text}${target ? `\n\nTO. ${target}` : ''}\n\n리더 화면에서 확인하세요.`
        );

        return json({ qid, code });
      }

      // ---- 공개: 익명 질문에 답변 ----
      if (path === '/api/answers' && method === 'POST') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

        const body = await request.json();
        const qid = body.qid;
        const text = (body.text || '').trim().slice(0, 300);
        if (!text) return json({ error: '답변 내용을 입력해주세요.' }, 400);

        const data = await loadData(env);

        if (data.blockedIPs.includes(ip)) {
          return json({ error: '이용이 제한됐어요.' }, 403);
        }

        const q = data.questions.find(x => x.qid === qid);
        if (!q || q.category !== '익명' || !q.public) {
          return json({ error: '답변할 수 없는 질문이에요.' }, 400);
        }

        data.counters.answer += 1;
        const id = data.counters.answer;
        const existingNames = data.answers.filter(a => a.qid === qid).map(a => a.name);
        const name = randomName(existingNames);

        const logKey = `${LOG_PREFIX}a:${crypto.randomUUID()}`;
        const newA = {
          id, qid,
          questionText: q.text,
          name,
          answerText: text,
          time: nowLabel(),
          ip,
          read: false,
          logKey,
        };
        data.answers.push(newA);

        await saveData(env, data);
        await writeLog(env, ctx, logKey, newA);

        await notifyLeader(
          env, ctx,
          `[YCC ASK] 새 답변 도착 · ${q.code}`,
          `원 질문: ${q.text}\n\n답변 (${name}):\n${text}\n\n리더 화면 답변함에서 확인하세요.`
        );

        return json({ id, name });
      }

      // ---- 리더: 로그인 ----
      if (path === '/api/leader/login' && method === 'POST') {
        const body = await request.json();
        if (body.password !== env.LEADER_PASSWORD) {
          return json({ error: '비밀번호가 올바르지 않아요.' }, 401);
        }
        const token = await makeToken(env);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': setCookieHeader(token),
          },
        });
      }

      // ---- 리더: 로그아웃 ----
      if (path === '/api/leader/logout' && method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': clearCookieHeader(),
          },
        });
      }

      // ---- 리더: 인증 체크 ----
      if (path === '/api/leader/check' && method === 'GET') {
        const ok = await requireLeader(request, env);
        return json({ authenticated: ok });
      }

      // ---- 이 아래는 전부 리더 인증 필요 ----
      if (path.startsWith('/api/leader/')) {
        const ok = await requireLeader(request, env);
        if (!ok) return json({ error: '인증이 필요해요.' }, 401);
      }

      // ---- 리더: 전체 데이터 ----
      if (path === '/api/leader/data' && method === 'GET') {
        const data = await loadData(env);
        return json(data);
      }

      // ---- 리더: 질문 상태(읽음/미읽음) 변경 ----
      if (path.match(/^\/api\/leader\/questions\/[^/]+\/status$/) && method === 'POST') {
        const qid = decodeURIComponent(path.split('/')[4]);
        const body = await request.json();
        const data = await loadData(env);
        const q = data.questions.find(x => x.qid === qid);
        if (!q) return json({ error: '질문을 찾을 수 없어요.' }, 404);
        q.status = body.status === 'read' ? 'read' : 'unread';
        await saveData(env, data);
        return json({ ok: true });
      }

      // ---- 리더: 익명 질문 공개/비공개 전환 ----
      if (path.match(/^\/api\/leader\/questions\/[^/]+\/public$/) && method === 'POST') {
        const qid = decodeURIComponent(path.split('/')[4]);
        const body = await request.json();
        const data = await loadData(env);
        const q = data.questions.find(x => x.qid === qid);
        if (!q) return json({ error: '질문을 찾을 수 없어요.' }, 404);
        if (q.category !== '익명') return json({ error: '익명 질문만 공개할 수 있어요.' }, 400);
        q.public = !!body.public;
        await saveData(env, data);
        return json({ ok: true });
      }

      // ---- 리더: 질문 삭제 ----
      if (path.match(/^\/api\/leader\/questions\/[^/]+$/) && method === 'DELETE') {
        const qid = decodeURIComponent(path.split('/')[4]);
        const data = await loadData(env);
        const removedQ = data.questions.filter(x => x.qid === qid);
        const removedA = data.answers.filter(x => x.qid === qid);
        data.questions = data.questions.filter(x => x.qid !== qid);
        // 연결된 답변도 함께 정리
        data.answers = data.answers.filter(x => x.qid !== qid);
        await saveData(env, data);
        // 백업도 지워야 '누락 확인' 때 되살아나지 않음
        await deleteLogs(env, ctx, [
          ...removedQ.map(x => x.logKey || (x.uid ? `${LOG_PREFIX}q:${x.uid}` : null)),
          ...removedA.map(x => x.logKey),
        ]);
        return json({ ok: true });
      }

      // ---- 리더: 답변 확인 상태 토글 ----
      if (path.match(/^\/api\/leader\/answers\/[^/]+\/read$/) && method === 'POST') {
        const id = Number(path.split('/')[4]);
        const body = await request.json();
        const data = await loadData(env);
        const a = data.answers.find(x => x.id === id);
        if (!a) return json({ error: '답변을 찾을 수 없어요.' }, 404);
        a.read = !!body.read;
        await saveData(env, data);
        return json({ ok: true });
      }

      // ---- 리더: 답변 삭제 ----
      if (path.match(/^\/api\/leader\/answers\/[^/]+$/) && method === 'DELETE') {
        const id = Number(path.split('/')[4]);
        const data = await loadData(env);
        const removed = data.answers.filter(x => x.id === id);
        data.answers = data.answers.filter(x => x.id !== id);
        await saveData(env, data);
        await deleteLogs(env, ctx, removed.map(x => x.logKey));
        return json({ ok: true });
      }

      // ---- 리더: IP 차단 (해당 질문을 보낸 IP를 차단 목록에 추가) ----
      if (path.match(/^\/api\/leader\/questions\/[^/]+\/block-ip$/) && method === 'POST') {
        const qid = decodeURIComponent(path.split('/')[4]);
        const data = await loadData(env);
        const q = data.questions.find(x => x.qid === qid);
        if (!q) return json({ error: '질문을 찾을 수 없어요.' }, 404);
        if (!q.ip || q.ip === 'unknown') return json({ error: '이 질문은 IP 정보가 없어서 차단할 수 없어요.' }, 400);
        if (!data.blockedIPs.includes(q.ip)) data.blockedIPs.push(q.ip);
        await saveData(env, data);
        return json({ ok: true, ip: q.ip });
      }

      // ---- 리더: 누락 확인 (백업에는 있는데 화면에 없는 질문/답변 복구) ----
      if (path === '/api/leader/recover' && method === 'POST') {
        const result = await recoverMissing(env);
        return json({ ok: true, recovered: result });
      }

      // ---- 리더: 전체 초기화 (질문/답변/번호 전부 비우기) ----
      if (path === '/api/leader/reset' && method === 'POST') {
        const fresh = {
          counters: { question: 0, answer: 0 },
          questions: [],
          answers: [],
          blockedIPs: [],
        };
        await saveData(env, fresh);
        // 초기화 이전 백업은 복구 대상에서 제외
        await env.ask_kv.put(RESET_KEY, String(Date.now()));
        return json({ ok: true });
      }

      // ---- 그 외는 정적 파일로 ----
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: '서버 오류가 발생했어요.', detail: String(err) }, 500);
    }
  },
};
