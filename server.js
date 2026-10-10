"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

function loadEnvFile() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!match || match[1].startsWith("#") || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile();

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === "true";
const SESSION_TTL = 8 * 60 * 60 * 1000;
const ROLE_CHECK_TTL = 60 * 1000;
const ORDER_CHANNEL_ID = process.env.DISCORD_ORDER_CHANNEL_ID || "1558426870465302538";
const ORDER_WEBHOOK_URL = process.env.DISCORD_ORDER_WEBHOOK_URL || "";
const sessions = new Map();
const pendingLogins = new Map();
const staticFiles = new Map([
  ["/", "landing.html"],
  ["/index.html", "landing.html"],
  ["/material-ankauf.html", "material-ankauf.html"],
  ["/material-ankauf.js", "material-ankauf.js"],
  ["/produktions-rechner.html", "produktions-rechner.html"],
  ["/script.js", "script.js"],
  ["/style.css", "style.css"]
]);

function discordConfig() {
  return {
    clientId: process.env.DISCORD_CLIENT_ID || "",
    clientSecret: process.env.DISCORD_CLIENT_SECRET || "",
    guildId: process.env.DISCORD_GUILD_ID || "",
    roleId: process.env.DISCORD_ROLE_ID || "",
    redirectUri: process.env.DISCORD_REDIRECT_URI || "",
    botToken: process.env.DISCORD_BOT_TOKEN || "",
    allowedLogChannelId: process.env.DISCORD_ALLOWED_LOG_CHANNEL_ID || "",
    deniedLogChannelId: process.env.DISCORD_DENIED_LOG_CHANNEL_ID || ""
  };
}

function configIsReady(config) {
  const snowflake = /^\d{17,20}$/;
  return Object.values(config).every(Boolean)
    && [config.guildId, config.roleId, config.allowedLogChannelId, config.deniedLogChannelId].every(id => snowflake.test(id));
}

function appendCookie(res, cookie) {
  const current = res.getHeader("Set-Cookie");
  const cookies = current ? (Array.isArray(current) ? current : [current]) : [];
  res.setHeader("Set-Cookie", [...cookies, cookie]);
}

function makeCookie(name, value, maxAge, httpOnly = true) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (httpOnly) parts.push("HttpOnly");
  if (COOKIE_SECURE) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(res, name) {
  appendCookie(res, makeCookie(name, "", 0));
}

function cookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    try {
      result[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      result[name] = "";
    }
  }
  return result;
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  applySecurityHeaders(res);
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}

function redirect(res, location) {
  applySecurityHeaders(res);
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function loginPage(error = "") {
  const messages = {
    setup: "Der Discord-Login oder der private Log-Channel ist noch nicht konfiguriert.",
    role: "Du hast keine passende Rolle auf dem Discord-Server.",
    state: "Der Login ist abgelaufen. Bitte versuche es erneut.",
    discord: "Die Anmeldung bei Discord ist fehlgeschlagen.",
    cancelled: "Die Discord-Anmeldung wurde abgebrochen."
  };
  const message = messages[error] || "";
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Discord-Anmeldung · Olymp Rechner</title>
<style>
:root{color-scheme:dark;--bg:#111311;--panel:#1c201d;--line:#353c35;--text:#f3f4ee;--muted:#a6ada4;--accent:#f0ce32;--error:#ff8d82}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse at 50% 0%,#293027 0%,var(--bg) 60%);color:var(--text);font:16px/1.5 system-ui,sans-serif}.login{width:min(440px,calc(100% - 32px));padding:32px;background:var(--panel);border:1px solid var(--line);border-radius:8px}h1{margin:0 0 8px;font-size:24px}p{margin:0 0 24px;color:var(--muted)}.error{margin:0 0 18px;color:var(--error)}.privacy{margin:18px 0 0;font-size:12px}a{display:flex;align-items:center;justify-content:center;min-height:48px;padding:10px 16px;background:var(--accent);color:#191a15;text-decoration:none;font-weight:700;border-radius:5px}a:hover{filter:brightness(1.06)}
</style></head><body><main class="login"><h1>Olymp Produktions Rechner</h1><p>Zum Zugriff mit Discord anmelden.</p>${message ? `<p class="error" role="alert">${message}</p>` : ""}<a href="/auth/discord">Mit Discord anmelden</a><p class="privacy">Bei erfolgreichen Anmeldungen und abgelehnten Rollenprüfungen werden Discord-Name, Profilbild, User-ID und Ergebnis je nach Ergebnis in den zugehörigen privaten Log-Channel protokolliert.</p></main></body></html>`;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function discordFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { "User-Agent": "OlympProduktionsRechner/1.0", ...(options.headers || {}) },
    signal: AbortSignal.timeout(10000)
  });
}

async function exchangeCode(config, code, verifier) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier
  });
  const response = await discordFetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = parseJson(await response.text());
  if (!response.ok || !data?.access_token) throw new Error("Discord token exchange failed");
  return data;
}

async function refreshToken(session, config) {
  if (!session.refreshToken) throw new Error("Discord session expired");
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: session.refreshToken
  });
  const response = await discordFetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = parseJson(await response.text());
  if (!response.ok || !data?.access_token) throw new Error("Discord token refresh failed");
  session.accessToken = data.access_token;
  session.refreshToken = data.refresh_token || session.refreshToken;
  session.tokenExpiresAt = Date.now() + (Number(data.expires_in) || 0) * 1000;
}

async function memberHasRole(session, config) {
  if (session.tokenExpiresAt <= Date.now() + 30000) await refreshToken(session, config);
  const requestMember = () => discordFetch(`https://discord.com/api/v10/users/@me/guilds/${encodeURIComponent(config.guildId)}/member`, {
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  let response = await requestMember();
  if (response.status === 401) {
    await refreshToken(session, config);
    response = await requestMember();
  }
  if (response.status === 403 || response.status === 404) return false;
  const member = parseJson(await response.text());
  if (!response.ok || !Array.isArray(member?.roles)) throw new Error("Discord membership check failed");
  return member.roles.includes(config.roleId);
}

async function logDiscordAccess(user, authorized, config) {
  const channelId = authorized ? config.allowedLogChannelId : config.deniedLogChannelId;
  const displayName = String(user.global_name || user.username || "Unbekannt").slice(0, 80);
  const embed = {
    title: authorized ? "Discord-Zugriff gewährt" : "Discord-Zugriff abgelehnt",
    color: authorized ? 0x48a868 : 0xd44c4c,
    fields: [
      { name: "Discord-Profil", value: `<@${user.id}>\n${displayName}\nID: ${user.id}`, inline: true },
      { name: "Ergebnis", value: authorized ? "Verified-Rolle vorhanden" : "Verified-Rolle fehlt", inline: true }
    ],
    timestamp: new Date().toISOString()
  };
  if (user.avatar) {
    const extension = user.avatar.startsWith("a_") ? "gif" : "png";
    embed.thumbnail = { url: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=128` };
  }
  const response = await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${config.botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } })
  });
  if (!response.ok) {
    const error = parseJson(await response.text());
    throw new Error(`Discord access log failed (${response.status}, code ${error?.code ?? "unknown"}): ${String(error?.message || "unknown response").slice(0, 200)}`);
  }
}

function pruneState() {
  const now = Date.now();
  for (const [key, value] of pendingLogins) if (value.expiresAt <= now) pendingLogins.delete(key);
  for (const [key, value] of sessions) if (value.sessionExpiresAt <= now) sessions.delete(key);
}

async function authorizedSession(req, config) {
  const id = cookies(req).olymp_session;
  const session = id && sessions.get(id);
  if (!session || session.sessionExpiresAt <= Date.now()) {
    if (id) sessions.delete(id);
    return null;
  }
  if (Date.now() - session.roleCheckedAt < ROLE_CHECK_TTL) return session;
  if (!await memberHasRole(session, config)) {
    sessions.delete(id);
    return null;
  }
  session.roleCheckedAt = Date.now();
  return session;
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function beginLogin(req, res, config) {
  if (!configIsReady(config)) {
    send(res, 503, loginPage("setup"), "text/html; charset=utf-8");
    return;
  }
  pruneState();
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  pendingLogins.set(state, { verifier, expiresAt: Date.now() + 10 * 60 * 1000 });
  appendCookie(res, makeCookie("olymp_oauth_state", state, 600));
  const query = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: "identify guilds.members.read",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  redirect(res, `https://discord.com/oauth2/authorize?${query}`);
}

async function finishLogin(req, res, url, config) {
  clearCookie(res, "olymp_oauth_state");
  if (url.searchParams.has("error")) {
    redirect(res, "/login?error=cancelled");
    return;
  }
  const state = url.searchParams.get("state") || "";
  const stateCookie = cookies(req).olymp_oauth_state || "";
  const pending = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (!state || !safeEqual(state, stateCookie) || !pending || pending.expiresAt <= Date.now()) {
    redirect(res, "/login?error=state");
    return;
  }
  const code = url.searchParams.get("code");
  if (!code || !configIsReady(config)) {
    redirect(res, "/login?error=discord");
    return;
  }
  try {
    const token = await exchangeCode(config, code, pending.verifier);
    const userResponse = await discordFetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    const user = parseJson(await userResponse.text());
    if (!userResponse.ok || !user?.id) throw new Error("Discord user lookup failed");
    const session = {
      userId: user.id,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenExpiresAt: Date.now() + (Number(token.expires_in) || 0) * 1000,
      sessionExpiresAt: Date.now() + SESSION_TTL,
      roleCheckedAt: 0
    };
    const authorized = await memberHasRole(session, config);
    await logDiscordAccess(user, authorized, config);
    if (!authorized) {
      redirect(res, "/login?error=role");
      return;
    }
    session.roleCheckedAt = Date.now();
    const sessionId = crypto.randomBytes(32).toString("base64url");
    sessions.set(sessionId, session);
    appendCookie(res, makeCookie("olymp_session", sessionId, SESSION_TTL / 1000));
    redirect(res, "/produktions-rechner.html");
  } catch (error) {
    console.error("Discord OAuth fehlgeschlagen:", error.message);
    redirect(res, "/login?error=discord");
  }
}

function staticFile(pathname) {
  if (staticFiles.has(pathname)) return path.join(ROOT, staticFiles.get(pathname));
  if (!pathname.startsWith("/img/")) return null;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const imageRoot = path.resolve(ROOT, "img");
  const file = path.resolve(ROOT, `.${decoded}`);
  return file.startsWith(`${imageRoot}${path.sep}`) ? file : null;
}

function serveStatic(req, res, pathname) {
  const file = staticFile(pathname);
  if (!file) {
    send(res, 404, "Nicht gefunden");
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      send(res, error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "Nicht gefunden" : "Interner Fehler");
      return;
    }
    const extension = path.extname(file).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".svg": "image/svg+xml"
    };
    applySecurityHeaders(res);
    res.writeHead(200, { "Content-Type": types[extension] || "application/octet-stream", "Cache-Control": "private, no-store" });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

function saveMaterialOrderLocally(order) {
  const logPath = path.join(ROOT, "material-bestellungen.json");
  let list = [];
  try {
    if (fs.existsSync(logPath)) {
      const existing = fs.readFileSync(logPath, "utf8");
      list = JSON.parse(existing || "[]");
      if (!Array.isArray(list)) list = [];
    }
  } catch {
    list = [];
  }

  list.push({
    createdAt: new Date().toISOString(),
    ...order
  });

  fs.writeFileSync(logPath, JSON.stringify(list, null, 2), "utf8");
  return logPath;
}

async function postToDiscordChannel(orderMessage) {
  const config = discordConfig();
  if (ORDER_WEBHOOK_URL) {
    const response = await discordFetch(ORDER_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: orderMessage, allowed_mentions: { parse: [] } })
    });
    const data = parseJson(await response.text());
    if (!response.ok) {
      throw new Error(data?.message || "Webhook-Request fehlgeschlagen.");
    }
    return { method: "webhook" };
  }

  if (config.botToken) {
    const response = await discordFetch(`https://discord.com/api/v10/channels/${encodeURIComponent(ORDER_CHANNEL_ID)}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${config.botToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ content: orderMessage, allowed_mentions: { parse: [] } })
    });
    const data = parseJson(await response.text());
    if (!response.ok) {
      throw new Error(data?.message || "Discord-API fehlgeschlagen.");
    }
    return { method: "bot" };
  }

  return { method: "local-only" };
}

async function handleMaterialOrder(req, res) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 256000) {
      send(res, 413, JSON.stringify({ ok: false, message: "Anfrage zu groß." }), "application/json; charset=utf-8");
      return;
    }
  }

  let payload = {};
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    send(res, 400, JSON.stringify({ ok: false, message: "Ungültige Formulardaten." }), "application/json; charset=utf-8");
    return;
  }

  const technical = Number(payload.technical ?? 0);
  const medical = Number(payload.medical ?? 0);
  const phone = String(payload.phone || "").trim();

  if (!Number.isFinite(technical) || !Number.isFinite(medical) || technical < 0 || medical < 0 || !phone) {
    send(res, 400, JSON.stringify({ ok: false, message: "Bitte alle Felder korrekt ausfüllen." }), "application/json; charset=utf-8");
    return;
  }

  const totalMaterials = technical + medical;
  const totalPrice = technical * 250 + medical * 150;
  const message = `📦 Neue Material-Bestellung\n` +
    `Technische Materialien: ${technical}\n` +
    `Medizinische Materialien: ${medical}\n` +
    `Gesamtanzahl: ${totalMaterials}\n` +
    `Handynummer: ${phone}\n` +
    `Gesamtpreis: ${totalPrice} $\n` +
    `Zeitstempel: ${new Date().toLocaleString("de-DE")}`;

  const order = {
    technical,
    medical,
    phone,
    totalMaterials,
    totalPrice,
    message
  };

  try {
    const result = await postToDiscordChannel(message);
    if (result.method === "local-only") {
      saveMaterialOrderLocally(order);
      send(res, 200, JSON.stringify({
        ok: true,
        total: totalPrice,
        orderCount: totalMaterials,
        channelId: ORDER_CHANNEL_ID,
        savedLocally: true,
        message: "Bestellung wurde lokal gespeichert. Discord-Konfiguration fehlt noch."
      }), "application/json; charset=utf-8");
      return;
    }

    send(res, 200, JSON.stringify({
      ok: true,
      total: totalPrice,
      orderCount: totalMaterials,
      channelId: ORDER_CHANNEL_ID,
      savedLocally: false,
      message: "Bestellung wurde erfolgreich an Discord gesendet."
    }), "application/json; charset=utf-8");
  } catch (error) {
    console.error("Material-Bestellung fehlgeschlagen:", error.message);
    saveMaterialOrderLocally(order);
    send(res, 200, JSON.stringify({
      ok: true,
      total: totalPrice,
      orderCount: totalMaterials,
      channelId: ORDER_CHANNEL_ID,
      savedLocally: true,
      message: "Bestellung wurde lokal gespeichert. Der Discord-Upload war nicht verfügbar."
    }), "application/json; charset=utf-8");
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const config = discordConfig();
  if (req.method === "POST" && pathname === "/api/material-bestellung") {
    await handleMaterialOrder(req, res);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Methode nicht erlaubt");
    return;
  }
  if (pathname === "/healthz") {
    send(res, 200, "ok");
    return;
  }
  if (pathname === "/login") {
    send(res, 200, loginPage(url.searchParams.get("error") || ""), "text/html; charset=utf-8");
    return;
  }
  if (pathname === "/auth/discord") {
    await beginLogin(req, res, config);
    return;
  }
  if (pathname === "/auth/callback") {
    await finishLogin(req, res, url, config);
    return;
  }
  if (pathname === "/logout") {
    const id = cookies(req).olymp_session;
    if (id) sessions.delete(id);
    clearCookie(res, "olymp_session");
    redirect(res, "/login");
    return;
  }
  if (pathname === "/" || pathname === "/index.html" || pathname === "/material-ankauf.html" || pathname === "/material-ankauf.js" || pathname.startsWith("/img/")) {
    serveStatic(req, res, pathname === "/index.html" ? "/index.html" : pathname);
    return;
  }
  if (!staticFile(pathname)) {
    send(res, 404, "Nicht gefunden");
    return;
  }
  if (!configIsReady(config)) {
    redirect(res, "/login?error=setup");
    return;
  }
  let session;
  try {
    session = await authorizedSession(req, config);
  } catch (error) {
    console.error("Discord-Rollenprüfung fehlgeschlagen:", error.message);
    send(res, 502, "Die Discord-Rollenprüfung ist momentan nicht erreichbar.");
    return;
  }
  if (!session) {
    redirect(res, "/login");
    return;
  }
  serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error("HTTP-Anfrage fehlgeschlagen:", error.message);
    if (!res.headersSent) send(res, 500, "Interner Fehler");
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Olymp Rechner läuft auf http://${HOST}:${PORT}`);
  if (!configIsReady(discordConfig())) console.log("Discord OAuth ist noch nicht konfiguriert. Bitte .env ausfüllen.");
});