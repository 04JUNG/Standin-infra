# 외부 헬스 감시자 (Cloudflare Workers)

**이 감시자가 AWS 밖에서 도는 것이 요점이다.**

BFF 안의 알림기는 자기 죽음을 보고하지 못한다. 태스크가 아예 안 뜨거나, OOM으로 죽거나, AWS 리전이 흔들리면 알림도 대시보드도 함께 사라진다. 계획 4단계의 EventBridge → Lambda 경로도 결국 같은 계정 안에 있다. 그 마지막 구멍을 이 워커가 메운다.

## 무엇을 하나

1분마다 공개 API의 `/healthz`를 직접 두드린다.

| 상황 | 행동 |
| --- | --- |
| 2회 연속 실패 | `#standin-alert`에 P1 (`SERVICE_UNREACHABLE`) |
| 실패 상태에서 복구 | `#standin-alert`에 P1 (`SERVICE_RECOVERED`) |
| 계속 실패 중 | **다시 알리지 않는다** — 1분마다 울리면 아무도 안 본다 |
| 정상 | 아무것도 하지 않는다 (KV 쓰기도 하지 않는다) |

1회 실패로 알리지 않는 이유: ECS 롤링 배포 중 수 초의 끊김이 정상적으로 발생한다.

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

배포 직후 워커 주소를 한 번 열면 현재 판정을 JSON으로 돌려준다.

```bash
curl https://standin-watchdog.<계정>.workers.dev
```

실제 알림까지 확인하려면 `HEALTH_URL`을 잠깐 없는 주소로 바꿔 2분 기다린 뒤 되돌린다.

## 비용

무료 등급 안에서 돈다. 하루 1440회 실행, KV 읽기 1440회(한도 10만), 쓰기는 상태가 바뀔 때만 발생한다(정상 운영 시 0회).
