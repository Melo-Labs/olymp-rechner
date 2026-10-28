"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { runHealthMonitor } = require("../scripts/health-monitor");

const healthUrl = "https://shop.example/healthz";
const webhookUrl = "https://discord.com/api/webhooks/123/secret";
const environment = {
  HEALTHCHECK_URL: healthUrl,
  DISCORD_WEBHOOK: webhookUrl,
  GITHUB_REPOSITORY: "Melo-Labs/olymp-rechner",
  GITHUB_TOKEN: "test-token",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_RUN_ID: "42"
};

function response(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    }
  };
}

function healthyReport() {
  return {
    status: "ok",
    checks: { discord: "ok", storage: "ok", orders: "ok" }
  };
}

test("healthy checks do not create issues or send Discord messages", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === healthUrl) return response(200, healthyReport());
    if (String(url).includes("/issues?state=open")) return response(200, []);
    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await runHealthMonitor({ env: environment, fetchImpl });
  assert.deepEqual(result, { healthy: true, recovered: false });
  assert.equal(calls.length, 2);
});

test("a new failure opens one issue and sends a Discord alert", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, options });
    if (requestUrl === healthUrl) {
      return response(503, { status: "degraded", checks: { discord: "unavailable", storage: "ok", orders: "ok" } });
    }
    if (requestUrl.includes("/issues?state=open")) return response(200, []);
    if (requestUrl.endsWith("/issues") && options.method === "POST") {
      const body = JSON.parse(options.body);
      return response(201, {
        number: 7,
        title: body.title,
        body: body.body,
        html_url: "https://github.com/Melo-Labs/olymp-rechner/issues/7"
      });
    }
    if (requestUrl === webhookUrl) return response(204);
    if (requestUrl.endsWith("/issues/7") && options.method === "PATCH") return response(200, {});
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  const result = await runHealthMonitor({ env: environment, fetchImpl });
  assert.deepEqual(result, { healthy: false, issueNumber: 7 });
  assert.equal(calls.filter(call => call.url === webhookUrl).length, 1);
  const issueCreate = calls.find(call => call.options.method === "POST");
  assert.equal(JSON.parse(issueCreate.options.body).title, "Health-Check: Olymp Rechner");
});

test("an active alerted incident does not spam Discord", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, options });
    if (requestUrl === healthUrl) return response(503, { status: "degraded", checks: { orders: "degraded" } });
    if (requestUrl.includes("/issues?state=open")) {
      return response(200, [{
        number: 9,
        title: "Health-Check: Olymp Rechner",
        body: "<!-- discord-alert: sent -->",
        html_url: "https://github.com/Melo-Labs/olymp-rechner/issues/9"
      }]);
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  const result = await runHealthMonitor({ env: environment, fetchImpl });
  assert.deepEqual(result, { healthy: false, issueNumber: 9 });
  assert.equal(calls.length, 2);
});

test("recovery sends one Discord message and closes the health issue", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, options });
    if (requestUrl === healthUrl) return response(200, healthyReport());
    if (requestUrl.includes("/issues?state=open")) {
      return response(200, [{
        number: 11,
        title: "Health-Check: Olymp Rechner",
        body: "<!-- discord-alert: sent -->",
        html_url: "https://github.com/Melo-Labs/olymp-rechner/issues/11"
      }]);
    }
    if (requestUrl === webhookUrl) return response(204);
    if (requestUrl.endsWith("/issues/11") && options.method === "PATCH") {
      const update = JSON.parse(options.body);
      if (update.body) {
        assert.match(update.body, /discord-alert: recovered/);
        return response(200, {});
      }
      assert.deepEqual(update, { state: "closed" });
      return response(200, {});
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  const result = await runHealthMonitor({ env: environment, fetchImpl });
  assert.deepEqual(result, { healthy: true, recovered: true });
  assert.equal(calls.filter(call => call.url === webhookUrl).length, 1);
});
