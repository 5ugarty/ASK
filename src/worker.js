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
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1년 (로그인 유지)

const ADJECTIVES = ['어리둥절', '달리는', '반짝이는', '느긋한', '용감한', '몰래', '수줍은', '엉뚱한', '단단한', '살금살금', '깜짝', '조용한', '씩씩한', '포근한', '엉거주춤'];
const ANIMALS = ['범고래', '흰오목눈이', '수달', '펭귄', '고슴도치', '다람쥐', '부엉이', '너구리', '알파카', '해달', '기린', '오소리', '두더지', '앵무새', '고양이'];

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

function randomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${a} ${b}`;
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
    };
  }
  return JSON.parse(raw);
}

async function saveData(env, data) {
  await env.ask_kv.put(DATA_KEY, JSON.stringify(data));
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
        return json({ total: data.questions.length, counters: data.counters, publicQuestions });
      }

      // ---- 공개: 질문 전송 ----
      if (path === '/api/questions' && method === 'POST') {
        const body = await request.json();
        const category = body.category;
        const text = (body.text || '').trim().slice(0, 300);
        const target = category === '그룹' ? (body.target || '').trim().slice(0, 30) : null;

        if (!['전체', '익명', '그룹'].includes(category)) return json({ error: '잘못된 카테고리예요.' }, 400);
        if (!text) return json({ error: '질문 내용을 입력해주세요.' }, 400);
        if (category === '그룹' && !target) return json({ error: '받는 사람을 입력해주세요.' }, 400);

        const data = await loadData(env);
        data.counters.question = (data.counters.question || 0) + 1;
        const num = data.counters.question;
        const qid = `${category}-${pad3(num)}`;
        const code = `${category} ${pad3(num)}`;

        data.questions.push({
          qid, uid: crypto.randomUUID(), category, code, text, target,
          time: nowLabel(),
          status: 'unread',
          public: false,
        });

        await saveData(env, data);

        await notifyLeader(
          env, ctx,
          `[YCC ASK] 새 질문 도착 · ${code}`,
          `${code}\n${nowLabel()}\n\n${text}${target ? `\n\nTO. ${target}` : ''}\n\n리더 화면에서 확인하세요.`
        );

        return json({ qid, code });
      }

      // ---- 공개: 익명 질문에 답변 ----
      if (path === '/api/answers' && method === 'POST') {
        const body = await request.json();
        const qid = body.qid;
        const text = (body.text || '').trim().slice(0, 300);
        if (!text) return json({ error: '답변 내용을 입력해주세요.' }, 400);

        const data = await loadData(env);
        const q = data.questions.find(x => x.qid === qid);
        if (!q || q.category !== '익명' || !q.public) {
          return json({ error: '답변할 수 없는 질문이에요.' }, 400);
        }

        data.counters.answer += 1;
        const id = data.counters.answer;
        const name = randomName();

        data.answers.push({
          id, qid,
          questionText: q.text,
          name,
          answerText: text,
          time: nowLabel(),
          read: false,
        });

        await saveData(env, data);

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
        data.questions = data.questions.filter(x => x.qid !== qid);
        // 연결된 답변도 함께 정리
        data.answers = data.answers.filter(x => x.qid !== qid);
        await saveData(env, data);
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
        data.answers = data.answers.filter(x => x.id !== id);
        await saveData(env, data);
        return json({ ok: true });
      }

      // ---- 그 외는 정적 파일로 ----
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: '서버 오류가 발생했어요.', detail: String(err) }, 500);
    }
  },
};
