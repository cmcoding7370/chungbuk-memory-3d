# 충북 기억 카드 게임 서버

`chungbuk-memory-v1` 전용 Node.js 권한 서버입니다. 카드 22장의 무작위 배치와 정체, 방, 참가자, 차례, 점수, 11개 지역 캐릭터 및 완료 판정을 서버에서만 결정합니다. 이 디렉터리는 독립 패키지이며 클라이언트 정적 파일을 제공하지 않습니다.

## 설치와 실행

Node.js 22 이상과 pnpm 11.25.0이 필요합니다. 저장된 잠금 파일만 사용하여 설치합니다.

```sh
cd /home/ubuntu/chungbuk/server
pnpm install --frozen-lockfile
ALLOWED_ORIGINS=http://localhost:5173 HOST=127.0.0.1 PORT=8787 pnpm start
# 다른 터미널에서
curl http://127.0.0.1:8787/health
pnpm test
```

`HOST` 기본값은 `127.0.0.1`, `PORT` 기본값은 `8787`입니다. `PORT=0`은 빈 포트를 고르며 시작 시 stdout에 포트와 build만 출력합니다. `GET /health`는 `{"ok":true,"build":"chungbuk-memory-v1"}`를 반환합니다. WebSocket 경로는 정확히 `/ws`입니다. 쿼리 문자열은 허용하지 않습니다.

`ALLOWED_ORIGINS`는 브라우저 클라이언트의 정확한 origin을 쉼표로 구분한 목록입니다. 예: `https://game.example,https://preview.example`. 동일 origin이라도 목록에 없거나 Origin 헤더가 없으면 업그레이드를 거부합니다. 기본 목록은 비어 있어 모두 거부합니다. Origin은 인증 수단이 아니며 계정 기능도 아닙니다.

외부 서비스는 아직 배포하지 않았습니다. 배포 시 전용 프로세스를 사용하고 기존 TLS 역방향 프록시 뒤의 loopback에 바인딩하며, 프록시에서 `/ws` 업그레이드와 충분한 유휴 시간, `/health`를 설정하세요. HTTPS 게임에서는 `wss://`가 필요합니다. 실제 공개 사이트와 프리뷰 origin을 명시하고, 방 코드는 초대용으로만 공유하세요. 공개 WSS 연결 및 별도 브라우저 간 통신은 배포 후 별도로 검증해야 합니다. HTTP 정적 호스팅만으로 이 프로세스가 자동 실행되지는 않습니다.

## 프로토콜

모든 데이터 프레임은 UTF-8 JSON 텍스트입니다. 클라이언트는 연결 후 첫 메시지로 다음 중 하나를 보냅니다. 초대 코드는 서버가 생성한 6글자 대문자입니다.

```json
{"type":"hello","build":"chungbuk-memory-v1","mode":"create","name":"가람"}
{"type":"hello","build":"chungbuk-memory-v1","mode":"join","room":"ABCDEF","name":"누리"}
{"type":"hello","build":"chungbuk-memory-v1","mode":"resume","room":"ABCDEF","token":"서버가-발급한-비밀-토큰"}
```

이름은 공백을 앞뒤에서 제거한 1~24 Unicode 문자로, 제어 문자와 `<`, `>`, `&`는 허용하지 않습니다. create에는 room/token, join에는 token, resume에는 name을 넣지 않습니다. 실제 token은 암호학적으로 생성된 32바이트의 base64url 문자열(43자)입니다. 클라이언트는 이 토큰을 **탭별 임시 저장소**에 저장하여 그 탭의 resume에만 쓰고, 링크·URL·콘솔·분석 로그·다른 참가자에게 절대 넣지 마세요. 방 코드는 공개해도 되지만 토큰을 대체하지 못합니다.

접속한 소켓에만 `welcome`을 보냅니다. `seat`는 0~5이고, 0이 방장입니다. 서버는 재접속한 소켓을 먼저 유효한 자리 소켓으로 지정하고 이전 소켓 권한을 즉시 철회합니다. 이후 실제 상태 변경은 전원에게 `snapshot`으로 전송합니다. `members`에는 자리 번호, 이름, 연결 여부만 있고 토큰은 없습니다.

```text
welcome:  {type, build, room, seat, token, revision, status, members, game}
snapshot: {type, build, room, revision, status, members, game}
ack:      {type:"ack", actionId, revision}
error:    {type:"error", code, message, revision?, actionId?}
member:   {id:number, name:string, connected:boolean}
status:   "waiting" | "playing" | "finished"
```

두 번째 참가자의 연결이 성립하는 즉시 게임을 시작합니다. 이후에도 빈 자리에 들어온 사람은 관전자가 아니라 점수 0점의 즉시 참가자이며, 현재 진행 중인 차례 이후의 순환에 포함됩니다. 유예 중인 연결 끊긴 자리도 최대 6자리를 차지합니다. 종료된 방에도 빈자리가 있다면 참가할 수 있으며, 완료된 게임을 본 뒤 방장이 다시 시작할 수 있습니다.

`game`은 대기 중에는 `null`, 그 외에는 기존 게임과 동일한 `{cards,players,turn,phase,selectedIds,claimed,lastMessage}`입니다. `players` 항목은 `{id:number,name,score,collected:number[]}`이고, `turn`은 id가 아니라 players 배열의 0부터 시작하는 인덱스입니다. phase는 `flip`, `resolving`, `turnEnd`, `finished`입니다. `claimed`와 `collected`는 지역 ID입니다. 공개된 카드는 실제 `{id,regionId,kind,revealed:true}`이고, **공개되지 않은 카드**는 언제나 `{id,regionId:-1,kind:"place",revealed:false}`입니다. `c0`~`c21`은 서버가 신원을 섞은 다음 배정하는 고정 화면 슬롯이며 신원이나 지역 순서를 나타내지 않습니다. 서버의 매치 판정 전에는 클라이언트가 뒷면의 신원을 예측하거나 공개해서는 안 됩니다.

행동은 다음과 같습니다. `actionId`는 자리별로 유일한 1~80자의 영문/숫자/밑줄/하이픈 문자열이어야 합니다. `revision`은 마지막으로 적용한 welcome 또는 snapshot의 값입니다.

```json
{"type":"action","build":"chungbuk-memory-v1","actionId":"client-unique-1","revision":2,"action":"reveal","cardId":"c0"}
{"type":"action","build":"chungbuk-memory-v1","actionId":"client-unique-2","revision":3,"action":"next"}
{"type":"action","build":"chungbuk-memory-v1","actionId":"client-unique-3","revision":4,"action":"restart"}
```

현재 참가자만 `reveal`과 `next`, 0번 방장만 `restart`를 할 수 있습니다. 한 턴에 다른 뒷면 카드 두 장을 공개하고 1.4초 후 서버가 판정합니다. 같은 지역의 관광지와 특산물일 때 점수 1점과 캐릭터를 얻고 두 카드는 공개 상태로 남습니다. 틀리면 두 카드가 뒷면으로 돌아갑니다. 어느 경우에도 `turnEnd`에서 현재 참가자가 `next`를 보내야 다음 연결된 플레이어로 넘어갑니다. 11쌍이 모두 발견되면 `finished`입니다. 승자는 `players` 중 최고 점수인 모든 사람으로, 동점자는 공동 우승입니다. 서버가 `lastMessage`에 우승자들을 명시하며, 추가 winner 필드를 프로토콜에 넣지 않습니다. `restart`는 새로 섞고 점수/수집/타이머를 초기화합니다.

정상 적용된 행동은 모든 참가자에게 snapshot을 보낸 뒤 요청자에게만 `{type:'ack', actionId, revision}`을 보냅니다. 정상 적용된 `actionId`의 정확히 같은 재전송은 상태를 다시 변경하지 않고 최신 snapshot을 방송한 뒤 요청자에게 ACK를 돌려줍니다. 동일 ID에 다른 내용을 넣으면 `ACTION_ID_CONFLICT`입니다. stale revision은 최신 snapshot 다음 `STALE_REVISION` 오류를 보내며 실행하지 않습니다. 인증된 행동 요청의 거부 오류에는 안전한 유효 `actionId`가 포함되며, 잘못된 ID는 되돌려주지 않습니다. 거부된 요청 ID는 소비되지 않습니다. 클라이언트는 역행 snapshot을 무시하고 일치하는 ID의 ACK 또는 오류에서만 pending을 해제하며, ACK의 revision까지 상태를 적용한 후에만 성공 처리합니다. 자리당 적용된 ID 1,024개를 넘기지 않으며, 한도 도달 시 새 방이 필요합니다. ID 기억은 방/자리 수명 동안만 유지됩니다.

## 연결 끊김과 종료

- 자리는 연결 해제 후 60초 동안 해당 방의 비밀 토큰으로 복구할 수 있습니다. 복구에 실패하면 `RESUME_FAILED` 등 한글 오류를 보내고 접속을 닫습니다. 같은 토큰으로 복구하면 기존 소켓은 즉시 권한을 잃습니다.
- 현재 참가자가 `flip` 중 연결 해제되면 이미 뒤집은 미완성 카드가 다시 숨겨지고, 다음 연결된 플레이어의 차례로 자동 넘어갑니다. `turnEnd` 중이라면 자동으로 다음 연결된 플레이어로 넘어갑니다. `resolving` 도중 연결이 끊겨도 1.4초 판정을 마쳐 그 참가자에게 정상적으로 점수를 주고, 그 후 차례를 자동으로 넘깁니다. 이미 건너뛴 참가자가 복구해도 차례를 되돌리지 않습니다. 이 자동 넘김은 연결 끊김에 대한 예외입니다.
- 연결된 참가자가 2명 미만이면 게임 행동과 재시작을 일시 거부합니다(`NEED_PLAYERS`). 누군가 복구하거나 빈자리에 새로 들어오면 계속할 수 있습니다. 참가자 중 자신의 차례에 연결이 살아 있지만 아무 행동을 하지 않는 경우를 위한 자동 턴 제한은 없습니다.
- 60초가 지나면 해당 자리는 소멸하고 새 참가자가 사용할 수 있습니다. 해당 참가자는 `players`에서 빠지고 그의 점수/수집 기록은 현재 결과에서 제외됩니다. 이미 발견된 카드는 계속 공개되고 `claimed`는 보존됩니다. 따라서 중도 이탈이 발생한 게임에서는 남은 참가자들의 점수 합이 11보다 작을 수 있고, 완료 후 이탈 시 표시되는 승자도 달라질 수 있습니다. 공정한 영구 순위표가 필요한 서비스라면 별도 영구 계정/기록 설계가 필요합니다.
- 방장 자리가 만료되면 연결 중인 참가자 중 한 명을 0번으로 승격하고 **그 참가자에게 새 `welcome`**을 보내 새 seat와 기존 개인 토큰을 알려줍니다. 다른 참가자에게는 snapshot만 보냅니다. 따라서 클라이언트는 최초 접속 외에도 welcome의 seat를 갱신해야 합니다. 기존 자리 번호는 사람의 영구 ID가 아닙니다.
- 빈 방에서 모든 자리의 유예가 만료되면 제거합니다. 연결이 없는 유휴 방은 최대 10분 후에도 제거됩니다. 서버가 재시작되면 방·카드·점수·토큰은 모두 사라집니다. 로컬 저장소 삭제, 60초 초과, 방 삭제나 프로세스 재시작 시 새로 참가하거나 새 방을 만들어야 합니다.

## 제한과 검증

현재 한 프로세스에 방 128개, 소켓 256개, 방당 플레이어 6명, 메시지 4,096바이트, 소켓당 초당 30개 메시지, 전송 대기 64 KiB의 제한이 있습니다. hello 제한시간은 10초이고 WebSocket ping/pong은 15초마다 검사합니다. 바이너리/잘못된 JSON·형식·build·차례·상태·자리·revision을 검증합니다. 느린 수신자나 응답 없는 연결은 종료합니다. 한 인스턴스 메모리 기반이므로 여러 인스턴스 간 상태 공유, 인증 계정, 지속 기록, 자동 매치메이킹, 분산 DDoS 방어는 제공하지 않습니다.

`pnpm test`는 Node 내장 테스트 러너와 실제 로컬 WebSocket 다중 클라이언트를 사용합니다. 11개 짝 전체, 공동 우승 규칙, 숨김 마스킹, 실제 1.4초 지연, 점수/차례, 다른 방 격리, 중복/위조/stale, 방장 및 타이머 취소, 재접속/자리 교체/유예 만료, 중간 참가/6명 제한, 잘못된 build/origin/크기 등을 검사합니다. 대부분의 재접속·판정 통합 테스트는 시간을 단축한 설정을 주입하며, 실제 기본 1.4초도 별도 검사합니다. 로컬 자동 테스트는 공개 인터넷 배포나 사용자 브라우저 통합 성공을 의미하지 않습니다.
