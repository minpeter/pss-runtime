# pss-kernel

Cloudflare Durable Object 안에 QuickJS/WASM 컨텍스트를 유지하는 컨테이너 없는 codemode PoC.
모델이 도구마다 다시 응답하는 대신, **코드 한 번으로 여러 비동기 도구 호출과 결과 처리를 수행**한다.

```text
client -- one eval request --> Worker --> session Durable Object
                                           |
                                     QuickJS context
                                           |
                              catalog -> quotes -> save note
                                           |
                                    DO SQLite storage
client <-- result + tool trace ------------+
```

## 로컬 실행

이 패키지는 독립 `pss-kernel` 프로젝트를 `pss-runtime` workspace의
`packages/kernel`로 옮긴 것이다. 패키지 이름은 `@minpeter/pss-kernel`이며
아직 npm에 배포하지 않는 private PoC다. `packages/runtime`이나
`experimental/apifuse-playground-bench`의 커널 구현과는 연결하지 않는다.

저장소와 동일하게 Node.js 24 이상과 루트에 지정된 pnpm이 필요하다.
Docker, Cloudflare 계정, LLM API 키는 필요 없다. 아래 명령은 저장소 루트에서 실행한다.

```sh
pnpm install
pnpm --filter @minpeter/pss-kernel dev
# 별도 터미널
pnpm --filter @minpeter/pss-kernel demo
```

기본 주소는 `http://127.0.0.1:8788`이며 LAN에서는 `http://10.10.10.10:8788`처럼 접속한다.
다른 포트라면 `pnpm --filter @minpeter/pss-kernel demo http://127.0.0.1:8787`.
`dev`는 `wrangler dev --local --ip 0.0.0.0 --port 8788`을 실행한다. 같은 LAN의 다른 기기에서는
호스트의 LAN IP로 접속할 수 있다. 원격 리소스나 배포는 사용하지 않는다.
루트(`/`)는 API 안내 JSON을 반환한다. 브라우저에서 코드를 입력하는 웹 UI는 없다.

## 단일 요청으로 네 번의 도구 호출

```sh
curl http://127.0.0.1:8788/sessions/example/eval \
  -H 'content-type: application/json' \
  --data '{"code":"(async()=>{const products=await tools.catalog.search({query:\"keyboard\"}); const quotes=await Promise.all(products.map(p=>tools.pricing.quote({sku:p.sku,quantity:2}))); globalThis.lastQuote=quotes.toSorted((a,b)=>a.totalCents-b.totalCents)[0]; return await tools.notes.save({key:\"recommendation\",value:lastQuote});})()"}'
```

응답의 `calls`에는 `catalog.search`, `pricing.quote` 두 번, `notes.save`가 기록된다.
최종 결과는 `kbd-basic` 두 개, `totalCents: 8000`. 호출 사이의 필터링, 정렬, 의존 관계는
QuickJS 안에서 처리하며 클라이언트나 모델의 추가 판단 요청은 없다. 도구 자체의 호출은 네 번이다.

이 PoC는 LLM을 실제로 호출하지 않는다. 위 코드는 모델이 만든 코드를 대신하며,
**하나의 code-tool invocation으로 도구를 조합하는 실행 경로**를 검증한다.
토큰 절감량이나 모델 정확도를 측정하는 벤치마크는 아니다.

## 셀 간 상태

```sh
curl http://127.0.0.1:8788/sessions/example/eval \
  -H 'content-type: application/json' --data '{"code":"lastQuote.totalCents"}'
# result: 8000
```

- 같은 세션 ID는 같은 DO로 전달된다. 다른 세션의 전역 변수와 노트는 분리된다.
- 전역 스크립트의 `var`, `let`, `const`, 함수가 다음 셀에서도 유지된다.
- **bare top-level await는 지원하지 않는다.** 비동기 코드는 `(async () => { ... })()`로 감싼다.
- async 함수 내부의 지역 변수는 셀 간 공유되지 않는다. 비동기 결과를 유지하려면
  `globalThis.lastQuote = ...` 또는 미리 선언한 전역 변수를 사용한다.
- `const`/`let` 재선언은 일반 JavaScript처럼 오류다.
- `generation`은 현재 커널 세대를 식별한다. reset 또는 실행 실패 후에는 바뀐다.

```sh
curl -X POST http://127.0.0.1:8788/sessions/example/reset
```

Reset은 QuickJS heap만 없애고 도구가 저장한 노트는 삭제하지 않는다.
DO eviction, 배포, Wrangler 재시작/코드 reload에서도 heap은 소실될 수 있다.
이 PoC에는 keepalive나 idle 유지 시간 정책, heap 저장·복구가 없다.
DO 저장소의 로컬 영속성과 QuickJS heap의 생존은 서로 다르다.

## API와 도구

| API | 용도 |
| --- | --- |
| `GET /` | 서비스 이름과 API 경로 안내 |
| `GET /health` | 실행 환경 확인 |
| `GET /tools` | 도구 이름과 입력 JSON Schema |
| `POST /sessions/:id/eval` | `{ "code": "..." }` 실행 |
| `POST /sessions/:id/reset` | 커널 해제 및 세대 변경 |

| 게스트 도구 | 동작 |
| --- | --- |
| `tools.catalog.search({query})` | 데모 상품 검색 |
| `tools.pricing.quote({sku, quantity})` | 상품 금액 계산 |
| `tools.notes.save({key, value})` | JSON 노트 저장 |
| `tools.notes.get({key})` | 노트 조회, 없으면 null |

도구는 실제 비동기 DO SQLite-backed storage API를 사용한다. 상품과 가격은 고정된 데모
데이터이며 외부 상점 API가 아니다. 교체 지점은 `src/tools.ts`의 `invokeTool`이다.

성공 응답은 `status`, `result`, `calls`, `generation`, `executionId`를 포함한다.
게스트 실행 오류는 HTTP 200의 `status: "error"`, `stateReset: true`로 반환하고 커널을 폐기한다.
이미 수행한 도구의 쓰기는 롤백하지 않는다. 잘못된 HTTP 입력은 400이다.

## 검증

```sh
pnpm --filter @minpeter/pss-kernel test       # 실제 Wrangler/workerd HTTP 통합 테스트
pnpm --filter @minpeter/pss-kernel typecheck
pnpm --filter @minpeter/pss-kernel lint
pnpm --filter @minpeter/pss-kernel build      # WASM 포함 번들 dry run; 클라우드 배포 아님
```

## 범위

- QuickJS에는 호스트 `process`, `Bun`, `require`, `fetch`, 파일·shell·git·browser를 노출하지 않는다.
- 명시적으로 등록된 JSON 입출력 도구만 호출할 수 있다. import 모듈 로더는 제공하지 않는다.
- 세션 내 eval/reset을 직렬 처리한다. 한 셀 내부의 `Promise.all` 도구 호출은 병렬 가능하다.
- 무한 루프, 과도한 Promise 작업, 끝나지 않는 Promise 및 잘못된 결과 직렬화를 제한한다.
- 셀당 QuickJS interrupt callback 1,000회까지 허용하고 1,001회째에
  `INSTRUCTION_LIMIT`로 실패·reset한다. 고정된 QuickJS 0.32는 callback 사이에
  10,000번의 interrupt poll을 수행한다. poll은 명령어마다가 아니라 분기·함수 호출
  등에서 수행되므로 JavaScript 문장 수나 정확한 실행 시간 제한이 아니다.
  이전 10,000 callback은 로컬 CPU 경합에서 동기 실행만 10초를 넘겼다.
  타이머는 동기 WASM을 중단하지 못하며 Workers의 시계도 환경에 따라 실행 중
  갱신되지 않을 수 있어, 이 작업량 제한은 시계나 타이머에 의존하지 않는다.
  비동기 대기 10초, Promise job 10,000개, 도구 호출 64회, JSON 64 KiB,
  heap 16 MiB와 stack 256 KiB 제한은 그대로다.
- 인증·사용자별 할당량·운영용 이벤트 기록은 없는 **로컬 PoC**다.
- 클라우드에서 배포·자동 eviction·요금은 이 로컬 테스트로 검증하지 않는다.

참고: [Wrangler 로컬 개발](https://developers.cloudflare.com/workers/local-development/),
[QuickJS Workers 예제](https://github.com/justjake/quickjs-emscripten/tree/main/examples/cloudflare-workers).
