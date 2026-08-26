# 외부 헬스 감시자 (Cloudflare Workers)

**이 감시자가 AWS 밖에서 도는 것이 요점이다.**

BFF 안의 알림기는 자기 죽음을 보고하지 못한다. 태스크가 아예 안 뜨거나, OOM으로 죽거나, AWS 리전이 흔들리면 알림도 대시보드도 함께 사라진다. 계획 4단계의 EventBridge → Lambda 경로도 결국 같은 계정 안에 있다. 그 마지막 구멍을 이 워커가 메운다.

## 무엇을 하나

1분마다 공개 API의 `/healthz`를 직접 두드린다.

| 상황 | 행동 |
| --- | --- |
| 2회 연속 실패 | `#standin-alert`에 P1 (`SERVICE_UNREACHABLE`) |
| 실패 상태에서 복구 | `#standin-alert`에 P1 (`SERVICE_RECOVERED`) |
| 계속 실패 중 | **다시 알리지도, KV에 쓰지도 않는다** — 1분마다 울리면 아무도 안 본다 |
| 정상 | 아무것도 하지 않는다 (KV 쓰기도 하지 않는다) |

1회 실패로 알리지 않는 이유: ECS 롤링 배포 중 수 초의 끊김이 정상적으로 발생한다.

복구 알림은 연속 실패 횟수가 아니라 **장애 지속 시간**을 보고한다. 장애 중에는 상태를
쓰지 않으므로 `fails`는 down 판정 시점(2)에 멈춰 있고, 대신 그때 저장한 `since`로 시간을
계산한다.

P1 발송은 KV 쓰기보다 **먼저** 한다. 웹훅이 흔들려 발송이 실패하면 상태가 남지 않아
다음 분에 같은 판정으로 다시 시도한다 — P1을 통째로 놓치는 쪽이 중복으로 한 번 더
울리는 쪽보다 나쁘다.

## 배포

Cloudflare 계정과 `npx wrangler login`이 필요하다. 무료 등급으로 충분하다.

```bash
cd watchdog/cloudflare
npx wrangler kv namespace create WATCHDOG
```

출력된 `id`를 `wrangler.toml`의 `kv_namespaces`에 넣는다. `HEALTH_URL`은
`https://api.standinpose.com/healthz`로 설정돼 있다.

```bash
npx wrangler secret put DISCORD_WEBHOOK_ALERT
npx wrangler secret put DISCORD_WEBHOOK_WARN
npx wrangler deploy
```

⚠ 웹훅 URL은 `wrangler.toml`에 쓰지 않는다 — 이 파일은 저장소에 올라간다. **웹훅 URL 자체가 비밀이다.**

## 확인

배포 직후 워커 주소를 한 번 열면 지금 probe 결과와 저장된 판정을 JSON으로 돌려준다.

```bash
curl https://standin-watchdog.<계정>.workers.dev
```

**이 응답은 읽기 전용이다.** 이 주소는 공개이고 인증이 없어서, 주소를 아는 누구나 부를 수
있다. 그래서 여기서는 probe만 돌리고 알림도 KV 쓰기도 하지 않는다 — 열어 두면 남이 장애
중에 두드려 쓰기 한도를 대신 태우거나 복구 판정을 밖에서 흔들 수 있다. 판정을 바꾸는 것은
cron뿐이다.

실제 알림까지 확인하려면 `HEALTH_URL`을 잠깐 없는 주소로 바꿔 2분 기다린 뒤 되돌린다.

## 비용

무료 등급 안에서 돈다. 하루 1440회 실행, KV 읽기 1440회(한도 10만), 쓰기는 상태가 바뀔 때만 발생한다(정상 운영 시 0회).

| 항목 | 사용량 | 무료 한도 |
| --- | --- | --- |
| Worker 요청 | 1,440/일 | 100,000/일 |
| Cron Trigger | 1개 | 5개/계정 |
| KV 읽기 | 1,440/일 | 100,000/일 |
| KV 쓰기 | 정상 0회, 장애 1건당 **3회** | 1,000/일 |

쓰기가 장애당 3회로 고정인 것이 중요하다(진입 1 + down 판정 1 + 복구 1). 장애 중에도
매분 쓰면 16시간짜리 장애 하나가 하루치 쓰기 한도를 통째로 태우고, 한도가 마르면 그
다음 put이 실패해 복구 판정에 필요한 상태 전이조차 남지 않는다.
