# YCC ASK 배포 가이드

## 폴더 구조
```
ycc-ask/
├── wrangler.toml       ← Cloudflare 설정
├── src/worker.js       ← 백엔드 로직 (API + 인증)
└── public/
    ├── index.html      ← 홈 화면 (누구나 접속)
    └── leader.html      ← 리더 전용 화면
```

## 1. 준비물
- Node.js 설치되어 있어야 함
- Cloudflare 계정 (무료 플랜으로 충분)

## 2. Wrangler 설치 & 로그인
```bash
npm install -g wrangler
wrangler login
```

## 3. KV 네임스페이스 생성
```bash
wrangler kv namespace create YCC_KV
```
실행하면 `id = "xxxxxxxx"` 값이 출력돼요. 이 값을 `wrangler.toml`의
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID` 자리에 붙여넣어주세요.

## 4. 비밀번호 & 서명키 설정 (한 번만)
```bash
wrangler secret put LEADER_PASSWORD
# → 리더 로그인 비밀번호 입력 (예: 실제 쓸 비밀번호)

wrangler secret put AUTH_SECRET
# → 아무 긴 랜덤 문자열 입력 (예: openssl rand -hex 32 로 생성한 값)
```

## 5. 배포
```bash
wrangler deploy
```
배포가 끝나면 `https://ycc-ask.<your-subdomain>.workers.dev` 같은 주소가 나와요.

- 홈 화면: `https://.../` (index.html)
- 리더 화면: `https://.../leader.html`

## 6. 확인
- 홈에서 질문 보내보고
- 리더 화면(`/leader.html`)에서 방금 설정한 비밀번호로 로그인해서 질문함에 뜨는지 확인
- 익명 질문 승인 → 홈에 공개되는지 확인
- 공개된 질문에 답변 달아보고 → 리더 답변함에 뜨는지 확인

## 참고
- 데이터는 전부 Cloudflare KV에 저장돼요. 30명 규모 트래픽으로는 무료 티어(하루 쓰기 1,000회) 안에서 여유롭게 운영 가능해요.
- 리더 비밀번호는 서버(Worker) 쪽에서만 검증하고, 로그인하면 서명된 쿠키로 1년간 로그인 유지돼요.
- 도메인을 따로 갖고 계시면 `wrangler.toml`의 `route` 설정으로 연결도 가능해요 (필요하면 말씀해주세요).
