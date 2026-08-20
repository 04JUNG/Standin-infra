// 외부 헬스 감시자(계획 4단계).
//
// **이 코드가 AWS 밖에서 도는 것이 요점이다.** 계정 안의 감시자는 계정이 무너질 때
// 같이 무너진다. BFF 안의 알림기는 자기 죽음을 보고하지 못하고, 3단계 대시보드도
// BFF가 죽으면 함께 죽는다. 그 구멍을 메우는 것이 이 워커다.
//
// Cloudflare Workers 무료 등급 + Cron Trigger(1분 주기)로 돈다. 상태(연속 실패 횟수)는
// KV에 두되 **바뀔 때만** 쓴다 — 무료 등급의 쓰기 한도가 읽기보다 훨씬 빡빡하다.

const STATE_KEY = "health";
const DOWN_AFTER = 2; // 연속 실패 횟수. 1회는 배포 중 순간 끊김일 수 있다.
const TIMEOUT_MS = 10_000;

async function probe(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Cloudflare 캐시를 타면 죽은 서버가 살아 있는 것처럼 보인다.
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: { "Cache-Control": "no-cache" },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    // BFF는 {ok:true, inference:boolean}을 준다. ok가 false면 스스로 이상하다고 말한 것이다.
    if (body && body.ok === false) return { ok: false, reason: "healthz ok=false" };
    return { ok: true, inference: body?.inference !== false };
  } catch (error) {
    return { ok: false, reason: error?.name === "TimeoutError" ? "timeout" : String(error).slice(0, 200) };
  }
}

async function sendDiscord(env, severity, code, message, fields) {
  const webhook = severity === "P1" ? env.DISCORD_WEBHOOK_ALERT : env.DISCORD_WEBHOOK_WARN;
  if (!webhook) return;
  const mention = severity === "P1" ? env.DISCORD_ALERT_MENTION ?? "" : "";
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(mention ? { content: mention } : {}),
      embeds: [
        {
          title: `${severity === "P1" ? "🔴" : "🟠"} ${severity} · ${code}`,
          description: message,
          color: severity === "P1" ? 0xe03131 : 0xf08c00,
          fields: Object.entries(fields).map(([name, value]) => ({
            name,
            value: String(value).slice(0, 900) || "-",
            inline: true,
          })),
          timestamp: new Date().toISOString(),
          // 이 알림이 AWS 밖에서 왔다는 사실 자체가 정보다. AWS가 통째로 조용할 때
          // 유일하게 도착하는 알림이므로 출처를 분명히 남긴다.
          footer: { text: "외부 감시자 · Cloudflare Workers" },
        },
      ],
      allowed_mentions: mention ? { parse: ["everyone", "roles"] } : { parse: [] },
    }),
  });
}

async function check(env) {
  const url = env.HEALTH_URL;
  if (!url) throw new Error("HEALTH_URL is not configured");

  const previous = JSON.parse((await env.WATCHDOG.get(STATE_KEY)) ?? '{"fails":0,"down":false}');
  const result = await probe(url);

  if (result.ok) {
    if (previous.down) {
      await sendDiscord(env, "P1", "SERVICE_RECOVERED", "공개 엔드포인트가 다시 응답합니다.", {
        주소: url,
        연속실패: previous.fails,
      });
    }
    // 상태가 그대로면 쓰지 않는다(무료 등급 쓰기 한도를 아끼기 위해서다).
    if (previous.down || previous.fails > 0) {
      await env.WATCHDOG.put(STATE_KEY, JSON.stringify({ fails: 0, down: false }));
    }
    return { ok: true };
  }

  const fails = (previous.fails ?? 0) + 1;
  const down = previous.down || fails >= DOWN_AFTER;
  await env.WATCHDOG.put(STATE_KEY, JSON.stringify({ fails, down }));

  // 이미 알린 장애를 1분마다 다시 알리지 않는다. 복구될 때 한 번 더 알린다.
  if (down && !previous.down) {
    await sendDiscord(
      env,
      "P1",
      "SERVICE_UNREACHABLE",
      `공개 엔드포인트가 ${fails}회 연속 응답하지 않습니다. AWS 밖에서 확인한 결과입니다.`,
      { 주소: url, 사유: result.reason },
    );
  }
  return { ok: false, fails };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(check(env));
  },
  // 수동 확인용. 배포 직후 한 번 눌러 보라고 열어 둔다.
  async fetch(_request, env) {
    return Response.json(await check(env));
  },
};
