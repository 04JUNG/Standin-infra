// 인프라 이벤트 → 디스코드 알림(계획 4단계).
//
// 왜 앱이 아니라 여기서 알리나: 아래 사건들은 **앱이 원리적으로 보고할 수 없다.**
//   · 태스크가 아예 뜨지 못함(이미지·시크릿·권한 문제) — 알림기가 실행되지도 않는다.
//   · OOM/강제 종료 — 죽는 순간 버퍼가 함께 사라진다.
//   · 배포 서킷브레이커 롤백 — 새 태스크가 죽고 옛 태스크가 계속 도는 상태라
//     서비스는 "정상"으로 보인다. 조용히 넘어가면 배포가 반영되지 않은 것을 아무도 모른다.
//
// CloudWatch 지표가 아니라 EventBridge 이벤트 버스를 쓴다. 임계값을 정할 필요가 없고
// 사건이 일어난 그 순간 한 건이 오며, 비용도 사실상 0이다.
//
// 의존성 없이 돈다 — Node 20 런타임에 fetch와 AWS SDK v3가 이미 들어 있다.
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});
const COLORS = { P1: 0xe03131, P2: 0xf08c00, P3: 0x868e96 };
const ICONS = { P1: "🔴", P2: "🟠", P3: "⚪" };

/** 콜드스타트마다 한 번만 읽는다. 이벤트마다 읽으면 Secrets Manager 호출료가 붙는다. */
let webhooksPromise = null;

function loadWebhooks() {
  if (!webhooksPromise) {
    webhooksPromise = secrets
      .send(new GetSecretValueCommand({ SecretId: process.env.DISCORD_SECRET_ARN }))
      .then((res) => JSON.parse(res.SecretString ?? "{}"))
      .catch((error) => {
        // 캐시를 비워 다음 호출에서 다시 시도하게 한다.
        webhooksPromise = null;
        throw error;
      });
  }
  return webhooksPromise;
}

function webhookFor(webhooks, severity) {
  const { webhookAlert = "", webhookWarn = "", webhookOps = "" } = webhooks;
  if (severity === "P1") return webhookAlert || webhookWarn || webhookOps;
  if (severity === "P2") return webhookWarn || webhookAlert || webhookOps;
  return webhookOps || webhookWarn || webhookAlert;
}

const arnTail = (arn) => (typeof arn === "string" ? arn.split("/").pop() : "-");

/**
 * ECS 태스크 종료. **정상 종료를 걸러내는 것이 이 함수의 일이다** —
 * 롤링 배포와 스케일 인은 태스크를 정상적으로 멈추므로 그때마다 알리면 알림이 무의미해진다.
 */
function fromTaskStateChange(detail) {
  if (detail.lastStatus !== "STOPPED") return null;

  const containers = detail.containers ?? [];
  const failed = containers.filter((c) => typeof c.exitCode === "number" && c.exitCode !== 0);
  const stopCode = detail.stopCode ?? "";

  // 배포·스케일 인이 멈춘 태스크는 사건이 아니다.
  if (stopCode !== "TaskFailedToStart" && stopCode !== "EssentialContainerExited") return null;
  // EssentialContainerExited라도 exitCode 0이면 정상 종료다(SIGTERM 처리 완료 등).
  if (stopCode === "EssentialContainerExited" && failed.length === 0) return null;

  const exits = failed.map((c) => `${c.name}=${c.exitCode}`).join(", ") || "-";
  // 137 = SIGKILL. Fargate에서 이 값은 대개 메모리 초과다.
  const oom = failed.some((c) => c.exitCode === 137) || /OutOfMemory/i.test(detail.stoppedReason ?? "");

  return {
    severity: "P1",
    code: stopCode === "TaskFailedToStart" ? "TASK_FAILED_TO_START" : oom ? "TASK_OOM" : "TASK_EXITED",
    message:
      stopCode === "TaskFailedToStart"
        ? "태스크가 기동에 실패했습니다. 이미지·시크릿·권한을 확인하세요."
        : oom
          ? "태스크가 메모리 초과로 종료됐습니다(exit 137)."
          : "태스크의 필수 컨테이너가 비정상 종료했습니다.",
    fields: {
      클러스터: arnTail(detail.clusterArn),
      태스크정의: arnTail(detail.taskDefinitionArn),
      종료코드: exits,
      사유: (detail.stoppedReason ?? "-").slice(0, 300),
    },
  };
}

/** 배포 상태. 롤백은 "배포가 반영되지 않았다"는 뜻이라 성공 알림보다 훨씬 중요하다. */
function fromDeploymentStateChange(detail) {
  const eventName = detail.eventName ?? "";
  if (eventName === "SERVICE_DEPLOYMENT_FAILED") {
    return {
      severity: "P1",
      code: "DEPLOYMENT_ROLLED_BACK",
      message:
        "배포가 실패해 서킷브레이커가 롤백했습니다. 서비스는 이전 버전으로 계속 돕니다 — " +
        "새 코드는 반영되지 않았습니다.",
      fields: { 사유: (detail.reason ?? "-").slice(0, 300), 배포: detail.deploymentId ?? "-" },
    };
  }
  if (eventName === "SERVICE_DEPLOYMENT_COMPLETED") {
    return {
      severity: "P3",
      code: "DEPLOYMENT_COMPLETED",
      message: "배포가 완료됐습니다.",
      fields: { 배포: detail.deploymentId ?? "-" },
    };
  }
  return null;
}

/** RDS. 저장공간·장애조치는 앱이 느려지거나 죽기 **전에** 오는 유일한 신호다. */
function fromRdsEvent(detail) {
  const categories = detail.EventCategories ?? [];
  const message = detail.Message ?? "-";
  const critical = categories.some((category) =>
    ["failure", "failover", "low storage", "maintenance"].includes(category),
  );
  return {
    severity: critical ? "P1" : "P2",
    code: `RDS_${(categories[0] ?? "event").toUpperCase().replace(/\s+/g, "_")}`,
    message: `RDS: ${message}`.slice(0, 500),
    fields: { 인스턴스: detail.SourceIdentifier ?? "-", 분류: categories.join(", ") || "-" },
  };
}

function toAlert(event) {
  const detail = event.detail ?? {};
  switch (event["detail-type"]) {
    case "ECS Task State Change":
      return fromTaskStateChange(detail);
    case "ECS Deployment State Change":
      return fromDeploymentStateChange(detail);
    case "RDS DB Instance Event":
      return fromRdsEvent(detail);
    default:
      return null;
  }
}

export const handler = async (event) => {
  const alert = toAlert(event);
  // 걸러낸 이벤트가 대부분이다(정상 배포·스케일 인). 조용히 끝낸다.
  if (!alert) return { skipped: true };

  const webhooks = await loadWebhooks();
  const webhook = webhookFor(webhooks, alert.severity);
  if (!webhook) return { skipped: true, reason: "webhook not configured" };

  const mention = alert.severity === "P1" ? process.env.DISCORD_ALERT_MENTION ?? "" : "";
  const body = {
    ...(mention ? { content: mention } : {}),
    embeds: [
      {
        title: `${ICONS[alert.severity]} ${alert.severity} · ${alert.code}`,
        description: alert.message,
        color: COLORS[alert.severity],
        fields: Object.entries(alert.fields).map(([name, value]) => ({
          name,
          value: String(value).slice(0, 900) || "-",
          inline: true,
        })),
        timestamp: event.time ?? new Date().toISOString(),
        footer: { text: `AWS ${event.region ?? ""} · ${event.source ?? ""}` },
      },
    ],
    // 멘션을 명시적으로 켜지 않으면 디스코드가 @here를 실제 알림으로 처리하지 않는다.
    allowed_mentions: mention ? { parse: ["everyone", "roles"] } : { parse: [] },
  };

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // 실패하면 던진다 — EventBridge가 재시도하고, 그래도 안 되면 Lambda 오류로 남는다.
  // 여기서 삼키면 알림이 안 갔다는 사실조차 사라진다.
  if (!res.ok) throw new Error(`discord webhook ${res.status}`);
  return { sent: alert.code };
};
