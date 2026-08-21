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

/** 복구 알림용. `since`는 장애 전이 시점에 저장한 ISO 문자열이다. */
function humanDuration(since) {
  const startedAt = since ? Date.parse(since) : Number.NaN;
  if (!Number.isFinite(startedAt)) return "알 수 없음";
  const minutes = Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

async function check(env) {
  const url = env.HEALTH_URL;
  if (!url) throw new Error("HEALTH_URL is not configured");

  const previous = JSON.parse((await env.WATCHDOG.get(STATE_KEY)) ?? '{"fails":0,"down":false}');
  const result = await probe(url);

  if (result.ok) {
    if (previous.down) {
      // 연속 실패 횟수가 아니라 지속 시간을 보고한다. 장애 중에는 상태를 쓰지 않으므로
      // fails는 down으로 판정된 순간(2)에 멈춰 있어 시간이 지나도 늘지 않는다.
      await sendDiscord(env, "P1", "SERVICE_RECOVERED", "공개 엔드포인트가 다시 응답합니다.", {
        주소: url,
        장애지속: humanDuration(previous.since),
      });
    }
    // 상태가 그대로면 쓰지 않는다(무료 등급 쓰기 한도를 아끼기 위해서다).
    if (previous.down || previous.fails > 0) {
      await env.WATCHDOG.put(STATE_KEY, JSON.stringify({ fails: 0, down: false }));
    }
    return { ok: true };
  }

  // 이미 알린 장애는 다시 알리지도, **쓰지도** 않는다.
  //
  // 매분 쓰면 장애 하나가 무료 등급 쓰기 한도(1,000/일)를 16시간 만에 태운다. 한도가
  // 마르면 그 다음 put이 실패하고, 그 뒤로는 복구 판정에 필요한 상태 전이도 남지 않는다.
  // 계속 실패하는 동안 새로 알아낼 것은 없다 — 죽었다는 사실과 시작 시각은 아래 전이
  // 시점에 이미 저장돼 있고, 복구 메시지도 그 둘만 쓴다.
  if (previous.down) {
    return { ok: false, down: true, since: previous.since };
  }

  const fails = (previous.fails ?? 0) + 1;
  const down = fails >= DOWN_AFTER;

  // 알림을 먼저 보내고 상태를 쓴다. 발송이 실패하면 상태가 남지 않아 다음 분에 같은
  // 판정으로 다시 시도한다 — P1을 통째로 놓치는 쪽이 중복으로 한 번 더 울리는 쪽보다
  // 나쁘다. 반대 순서로 두면 웹훅이 한 번 흔들릴 때 알림이 영영 사라진다.
  if (down) {
    await sendDiscord(
      env,
      "P1",
      "SERVICE_UNREACHABLE",
      `공개 엔드포인트가 ${fails}회 연속 응답하지 않습니다. AWS 밖에서 확인한 결과입니다.`,
      { 주소: url, 사유: result.reason },
    );
  }

  await env.WATCHDOG.put(
    STATE_KEY,
    JSON.stringify({ fails, down, ...(down ? { since: new Date().toISOString() } : {}) }),
  );
  return { ok: false, fails, down };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(check(env));
  },
  // 수동 확인용. 배포 직후 한 번 눌러 보라고 열어 둔다.
  //
  // ⚠ 이 주소는 공개이고 인증이 없다 — workers.dev 주소를 아는 누구나 부를 수 있다.
  //   그래서 여기서는 probe만 돌리고 **상태를 쓰지도, 알리지도 않는다.** check()를 그대로
  //   열어 두면 남이 장애 중에 이 주소를 두드려 KV 쓰기 한도를 대신 태우거나, 복구 판정
  //   상태를 밖에서 흔들 수 있다. 판정을 바꾸는 것은 cron만이다.
  async fetch(_request, env) {
    if (!env.HEALTH_URL) return Response.json({ error: "HEALTH_URL is not configured" }, { status: 500 });
    const [probeResult, stored] = await Promise.all([
      probe(env.HEALTH_URL),
      env.WATCHDOG.get(STATE_KEY),
    ]);
    return Response.json({
      probe: probeResult,
      state: JSON.parse(stored ?? '{"fails":0,"down":false}'),
      note: "읽기 전용입니다. 알림과 상태 갱신은 1분 주기 cron만 수행합니다.",
    });
  },
};
