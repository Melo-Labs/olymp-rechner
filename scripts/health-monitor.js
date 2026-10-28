"use strict";

const HEALTH_ISSUE_TITLE = "Health-Check: Olymp Rechner";
const NOTIFICATION_PENDING_MARKER = "<!-- discord-alert: pending -->";
const NOTIFICATION_SENT_MARKER = "<!-- discord-alert: sent -->";
const NOTIFICATION_RECOVERED_MARKER = "<!-- discord-alert: recovered -->";

function monitorConfig(env) {
  const healthUrlValue = String(env.HEALTHCHECK_URL || "").trim();
  const webhookValue = String(env.DISCORD_WEBHOOK || "").trim();
  if (!healthUrlValue) throw new Error("Das Repository-Secret HEALTHCHECK_URL fehlt.");
  if (!webhookValue) throw new Error("Das Repository-Secret DISCORD_WEBHOOK fehlt.");

  let healthUrl;
  let webhookUrl;
  try {
    healthUrl = new URL(healthUrlValue);
  } catch {
    throw new Error("HEALTHCHECK_URL ist keine gültige URL.");
  }
  try {
    webhookUrl = new URL(webhookValue);
  } catch {
    throw new Error("DISCORD_WEBHOOK ist keine gültige URL.");
  }
  const repositoryParts = String(env.GITHUB_REPOSITORY || "").split("/");
  const [owner, repository] = repositoryParts;
  if (healthUrl.protocol !== "https:") throw new Error("HEALTHCHECK_URL muss HTTPS verwenden.");
  if (webhookUrl.protocol !== "https:"
    || !["discord.com", "discordapp.com"].includes(webhookUrl.hostname)
    || !webhookUrl.pathname.startsWith("/api/webhooks/")) {
    throw new Error("DISCORD_WEBHOOK muss eine gültige Discord-Webhook-URL sein.");
  }
  if (repositoryParts.length !== 2 || !owner || !repository || !env.GITHUB_TOKEN) {
    throw new Error("GitHub-Repository oder GITHUB_TOKEN fehlt.");
  }
  return {
    healthUrl,
    webhookUrl,
    owner,
    repository,
    githubToken: env.GITHUB_TOKEN,
    githubServerUrl: env.GITHUB_SERVER_URL || "https://github.com",
    runId: env.GITHUB_RUN_ID || ""
  };
}

async function checkHealth(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000)
    });
    let report = null;
    try {
      report = await response.json();
    } catch {
      report = null;
    }

    const checks = report?.checks && typeof report.checks === "object" ? report.checks : {};
    const allChecksHealthy = Object.keys(checks).length > 0
      && Object.values(checks).every(status => status === "ok");
    const healthy = response.status === 200 && report?.status === "ok" && allChecksHealthy;
    const checkSummary = Object.entries(checks)
      .map(([name, status]) => `${String(name).slice(0, 40)}: ${String(status).slice(0, 40)}`)
      .join(", ")
      .slice(0, 400);
    return {
      healthy,
      reason: healthy ? "" : response.status === 200 ? "Health response is not healthy" : `HTTP ${response.status}`,
      checkSummary: checkSummary || "No check details returned"
    };
  } catch (error) {
    return {
      healthy: false,
      reason: `Health request failed (${error?.name || "network error"})`,
      checkSummary: "No check details returned"
    };
  }
}

async function githubRequest(config, fetchImpl, route, method = "GET", data) {
  const response = await fetchImpl(new URL(route, "https://api.github.com/"), {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "olymp-rechner-health-monitor"
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}.`);
  if (response.status === 204) return null;
  return response.json();
}

async function postDiscordMessage(webhookUrl, content, fetchImpl) {
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}.`);
}

function issueRoute(config) {
  return `repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/issues`;
}

function buildIssueBody(config, health) {
  const runUrl = config.runId
    ? `${config.githubServerUrl}/${config.owner}/${config.repository}/actions/runs/${config.runId}`
    : "";
  return [
    "Der regelmäßige Health-Check hat einen gestörten Zustand erkannt.",
    `Grund: ${health.reason}`,
    `Prüfungen: ${health.checkSummary}`,
    runUrl ? `Workflow-Lauf: ${runUrl}` : "",
    NOTIFICATION_PENDING_MARKER
  ].filter(Boolean).join("\n\n");
}

function buildFailureMessage(health, issue) {
  return `🚨 Health-Check für den Olymp Rechner fehlgeschlagen. ${health.reason}. Prüfungen: ${health.checkSummary}. Details: ${issue.html_url || `#${issue.number}`}`;
}

async function findOpenHealthIssue(config, fetchImpl) {
  const issues = await githubRequest(
    config,
    fetchImpl,
    `${issueRoute(config)}?state=open&per_page=100`
  );
  return issues.find(issue => !issue.pull_request && issue.title === HEALTH_ISSUE_TITLE) || null;
}

async function runHealthMonitor({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = monitorConfig(env);
  if (typeof fetchImpl !== "function") throw new Error("Global fetch is unavailable.");
  const health = await checkHealth(config.healthUrl, fetchImpl);
  const issue = await findOpenHealthIssue(config, fetchImpl);

  if (!health.healthy) {
    let alertIssue = issue;
    if (!alertIssue) {
      alertIssue = await githubRequest(config, fetchImpl, issueRoute(config), "POST", {
        title: HEALTH_ISSUE_TITLE,
        body: buildIssueBody(config, health)
      });
    }

    if (!alertIssue.body?.includes(NOTIFICATION_SENT_MARKER)) {
      await postDiscordMessage(
        config.webhookUrl,
        buildFailureMessage(health, alertIssue),
        fetchImpl
      );
      const body = `${String(alertIssue.body || "").replace(NOTIFICATION_PENDING_MARKER, "").trim()}\n\n${NOTIFICATION_SENT_MARKER}`;
      await githubRequest(config, fetchImpl, `${issueRoute(config)}/${alertIssue.number}`, "PATCH", { body });
    }
    return { healthy: false, issueNumber: alertIssue.number };
  }

  if (issue) {
    if (!issue.body?.includes(NOTIFICATION_RECOVERED_MARKER)) {
      await postDiscordMessage(
        config.webhookUrl,
        `✅ Der Health-Check für den Olymp Rechner ist wieder in Ordnung. GitHub-Issue #${issue.number} wird geschlossen.`,
        fetchImpl
      );
      const body = `${String(issue.body || "")
        .replace(NOTIFICATION_PENDING_MARKER, "")
        .replace(NOTIFICATION_SENT_MARKER, "")
        .trim()}\n\n${NOTIFICATION_RECOVERED_MARKER}`;
      await githubRequest(config, fetchImpl, `${issueRoute(config)}/${issue.number}`, "PATCH", { body });
    }
    await githubRequest(config, fetchImpl, `${issueRoute(config)}/${issue.number}`, "PATCH", { state: "closed" });
    return { healthy: true, recovered: true };
  }

  return { healthy: true, recovered: false };
}

if (require.main === module) {
  runHealthMonitor()
    .then(result => {
      if (result.healthy) {
        console.log(result.recovered ? "Health-Check wiederhergestellt." : "Health-Check erfolgreich.");
        return;
      }
      console.error(`Health-Check ist eingeschränkt; Issue #${result.issueNumber} ist offen.`);
      process.exitCode = 1;
    })
    .catch(error => {
      console.error("Health-Monitor fehlgeschlagen:", error.message);
      process.exitCode = 1;
    });
}

module.exports = { runHealthMonitor };
