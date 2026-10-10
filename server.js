"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { verifyKey } = require("discord-interactions");

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
const STANK_ORDER_CHANNEL_ID = "1558497954921193592";
const CUSTOM_ORDER_CHANNEL_ID = "1558508937400291338";
const ORDER_WEBHOOK_URL = process.env.DISCORD_ORDER_WEBHOOK_URL || "";
const sessions = new Map();
const pendingLogins = new Map();
const staticFiles = new Map([
  ["/", "landing.html"],
  ["/index.html", "landing.html"],
  ["/material-ankauf.html", "material-ankauf.html"],
  ["/material-ankauf.js", "material-ankauf.js"],
  ["/stank-kauf.html", "stank-kauf.html"],
  ["/stank-kauf.js", "stank-kauf.js"],
  ["/freie-bestellung.html", "freie-bestellung.html"],
  ["/freie-bestellung.js", "freie-bestellung.js"],
  ["/produktions-rechner.html", "produktions-rechner.html"],
  ["/script.js", "script.js"],
  ["/style.css", "style.css"],
  ["/theme.css", "theme.css"],
  ["/bg.js", "bg.js"]
]);

function discordConfig() {
  return {
    clientId: process.env.DISCORD_CLIENT_ID || "",
    clientSecret: process.env.DISCORD_CLIENT_SECRET || "",
    guildId: process.env.DISCORD_GUILD_ID || "",
    roleId: process.env.DISCORD_ROLE_ID || "",
    redirectUri: process.env.DISCORD_REDIRECT_URI || "",
    botToken: process.env.DISCORD_BOT_TOKEN || "",
    publicKey: process.env.DISCORD_PUBLIC_KEY || "",
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
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Discord-Anmeldung</title>
<link rel="stylesheet" href="/theme.css">
<style>
:root{color-scheme:dark;--text:#ececec;--muted:#9a9da3;--error:#ff8d82;--br:rgba(228,232,238,.5)}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;color:var(--text);font:16px/1.5 var(--body)}
.login{width:min(440px,calc(100% - 32px));padding:34px 30px;border:1px solid rgba(228,232,238,.14);border-radius:6px;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);background:linear-gradient(var(--br),var(--br)) 0 0/14px 1px no-repeat,linear-gradient(var(--br),var(--br)) 0 0/1px 14px no-repeat,linear-gradient(var(--br),var(--br)) 100% 0/14px 1px no-repeat,linear-gradient(var(--br),var(--br)) 100% 0/1px 14px no-repeat,linear-gradient(var(--br),var(--br)) 0 100%/14px 1px no-repeat,linear-gradient(var(--br),var(--br)) 0 100%/1px 14px no-repeat,linear-gradient(var(--br),var(--br)) 100% 100%/14px 1px no-repeat,linear-gradient(var(--br),var(--br)) 100% 100%/1px 14px no-repeat,linear-gradient(165deg,rgba(27,29,33,.82),rgba(11,12,14,.9))}
h1{margin:0 0 8px;font:700 24px/1.2 var(--display);letter-spacing:.05em;text-shadow:0 0 16px rgba(255,255,255,.3)}
p{margin:0 0 24px;color:var(--muted)}.error{margin:0 0 18px;color:var(--error)}
a{display:flex;align-items:center;justify-content:center;min-height:48px;padding:10px 16px;background:linear-gradient(135deg,#f4f6f9,#aeb6c1);color:#0a0a0b;text-decoration:none;font-weight:600;letter-spacing:.04em;border-radius:6px;transition:box-shadow .2s}
a:hover{box-shadow:0 0 26px rgba(228,232,238,.4)}
</style></head><body><main class="login"><h1>Produktionsrechner</h1><p>Zum Zugriff mit Discord anmelden.</p>${message ? `<p class="error" role="alert">${message}</p>` : ""}<a href="/auth/discord">Mit Discord anmelden</a></main><script src="/bg.js"></script></body></html>`;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
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
  if (!response.ok || !data?.access_token) {
    const reason = [data?.error, data?.error_description]
      .filter(Boolean)
      .join(": ")
      .slice(0, 240);
    throw new Error(`Discord token exchange failed (HTTP ${response.status}${reason ? `, ${reason}` : ""})`);
  }
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
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2"
    };
    applySecurityHeaders(res);
    res.writeHead(200, { "Content-Type": types[extension] || "application/octet-stream", "Cache-Control": "private, no-store" });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

function saveOrderLocally(order, fileName) {
  const logPath = path.join(ROOT, fileName);
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

function saveMaterialOrderLocally(order) {
  return saveOrderLocally(order, "material-bestellungen.json");
}

function buildStankOrderPayload(order) {
  return {
    content: "🌿 Neue STANK-Bestellung",
    embeds: [{
      title: "Neue STANK-Bestellung",
      description: "Eine neue Bestellung von STANK-Pflanzen wurde erfasst.",
      color: 0x70ad5b,
      fields: [
        { name: "IC-Name", value: order.icName, inline: true },
        { name: "Handynummer / IC", value: order.phone, inline: true },
        { name: "STANK-Pflanzen", value: `${order.quantity}`, inline: true },
        { name: "Preis pro Pflanze", value: "2.000 $", inline: true },
        { name: "Gesamtpreis", value: `${order.totalPrice.toLocaleString("de-DE")} $`, inline: true }
      ],
      footer: { text: "Olymp Rechner • STANK-Kauf" },
      timestamp: new Date().toISOString()
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 2, label: "Kontaktaufnahme", custom_id: "stank_order_contact" },
        { type: 2, style: 3, label: "Ausgeliefert", custom_id: "stank_order_delivered" },
        { type: 2, style: 4, label: "Abgelehnt", custom_id: "stank_order_rejected" }
      ]
    }],
    allowed_mentions: { parse: [] }
  };
}

function buildCustomOrderPayload(order) {
  const itemList = order.items.map((item, index) =>
    `**${index + 1}. ${item.name}** — ${item.quantity} × ${item.pricePerItem.toLocaleString("de-DE")} $ Vorschlag = ${item.totalPrice.toLocaleString("de-DE")} $`
  ).join("\n");
  return {
    content: "🛒 Neue Wunsch-Bestellung",
    embeds: [{
      title: "Neue Wunsch-Bestellung",
      description: itemList,
      color: 0x5ba6cb,
      fields: [
        { name: "IC-Name", value: order.icName, inline: true },
        { name: "Handynummer / IC", value: order.phone, inline: true },
        { name: "Gesamtpreisvorschlag", value: `${order.totalPrice.toLocaleString("de-DE")} $`, inline: true }
      ],
      footer: { text: "Olymp Rechner • Wunsch-Bestellung" },
      timestamp: new Date().toISOString()
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 2, label: "Kontaktaufnahme", custom_id: "custom_order_contact" },
        { type: 2, style: 3, label: "Ausgeliefert", custom_id: "custom_order_delivered" },
        { type: 2, style: 4, label: "Abgelehnt", custom_id: "custom_order_rejected" }
      ]
    }],
    allowed_mentions: { parse: [] }
  };
}

function buildMaterialOrderPayload(order) {
  return {
    content: "📦 Neue Material-Bestellung",
    embeds: [{
      title: "Neue Material-Bestellung",
      description: "Eine neue Bestellung wurde im Rechner erfasst.",
      color: 0x2ea6ff,
      fields: [
        { name: "IC-Name", value: order.icName || "—", inline: true },
        { name: "Technische Materialien", value: `${order.technical}`, inline: true },
        { name: "Medizinische Materialien", value: `${order.medical}`, inline: true },
        { name: "Gesamtanzahl", value: `${order.totalMaterials}`, inline: true },
        { name: "Handynummer", value: order.phone || "—", inline: true },
        { name: "Gesamtpreis", value: `${order.totalPrice} $`, inline: true },
        { name: "Zeitstempel", value: `${new Date().toLocaleString("de-DE")}`, inline: false }
      ],
      footer: { text: "Olymp Rechner • Material-Ankauf" },
      timestamp: new Date().toISOString()
    }],
    components: [{
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "Kontaktaufnahme",
          custom_id: "material_order_contact"
        },
        {
          type: 2,
          style: 3,
          label: "Ausgeliefert",
          custom_id: "material_order_delivered"
        },
        {
          type: 2,
          style: 4,
          label: "Abgelehnt",
          custom_id: "material_order_rejected"
        }
      ]
    }],
    allowed_mentions: { parse: [] }
  };
}

async function verifyDiscordInteraction(rawBody, signatureHex, timestamp, publicKey) {
  if (!signatureHex || !timestamp || !publicKey) return false;
  try {
    return await verifyKey(rawBody, signatureHex, timestamp, publicKey);
  } catch {
    return false;
  }
}

async function handleDiscordInteraction(req, res) {
  const config = discordConfig();
  if (!config.publicKey) {
    send(res, 503, JSON.stringify({ error: "Discord interaction endpoint not configured." }), "application/json; charset=utf-8");
    return;
  }

  let rawBody = "";
  try {
    rawBody = await readRequestBody(req, 256 * 1024);
  } catch {
    send(res, 413, JSON.stringify({ error: "Payload too large" }), "application/json; charset=utf-8");
    return;
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  if (!await verifyDiscordInteraction(rawBody, String(signature || ""), String(timestamp || ""), config.publicKey)) {
    send(res, 401, JSON.stringify({ error: "Invalid request signature" }), "application/json; charset=utf-8");
    return;
  }

  let payload = {};
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch {
    send(res, 400, JSON.stringify({ error: "Invalid interaction payload" }), "application/json; charset=utf-8");
    return;
  }

  if (payload.type === 1) {
    send(res, 200, JSON.stringify({ type: 1 }), "application/json; charset=utf-8");
    return;
  }

  if (payload.type === 3 && payload.data?.component_type === 2) {
    const action = payload.data.custom_id;
    if (action === "material_order_contact" || action === "stank_order_contact" || action === "custom_order_contact") {
      const phone = payload.message?.embeds?.[0]?.fields
        ?.find(field => field.name === "Handynummer" || field.name === "Handynummer / IC")?.value;
      send(res, 200, JSON.stringify({
        type: 4,
        data: {
          content: phone
            ? `📞 Kontaktaufnahme: ${phone}`
            : "Für diese Bestellung ist keine Telefonnummer hinterlegt.",
          flags: 64
        }
      }), "application/json; charset=utf-8");
      return;
    }

    if (!["material_order_delivered", "material_order_rejected", "stank_order_delivered", "stank_order_rejected", "custom_order_delivered", "custom_order_rejected"].includes(action)) {
      send(res, 200, JSON.stringify({
        type: 4,
        data: { content: "Unbekannte Bestellaktion.", flags: 64 }
      }), "application/json; charset=utf-8");
      return;
    }

    const status = action.endsWith("_delivered") ? "Ausgeliefert" : "Abgelehnt";
    send(res, 200, JSON.stringify({
      type: 7,
      data: {
        content: `✅ Bestellung wurde als ${status} markiert.`,
        components: []
      }
    }), "application/json; charset=utf-8");
    return;
  }

  send(res, 200, JSON.stringify({ type: 4, data: { content: "Interaction verarbeitet." } }), "application/json; charset=utf-8");
}

async function postToDiscordChannel(orderMessage, channelId = ORDER_CHANNEL_ID, allowWebhook = true) {
  const config = discordConfig();
  const payload = typeof orderMessage === "string" ? { content: orderMessage, allowed_mentions: { parse: [] } } : orderMessage;

  if (allowWebhook && ORDER_WEBHOOK_URL) {
    const response = await discordFetch(ORDER_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = parseJson(await response.text());
    if (!response.ok) {
      throw new Error(data?.message || "Webhook-Request fehlgeschlagen.");
    }
    return { method: "webhook" };
  }

  if (config.botToken) {
    const response = await discordFetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${config.botToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const data = parseJson(await response.text());
    if (!response.ok) {
      const details = data?.errors ? ` ${JSON.stringify(data.errors)}` : "";
      throw new Error(`${data?.message || "Discord-API fehlgeschlagen."}${details}`);
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
  const icName = String(payload.icName || "").trim();
  const phone = String(payload.phone || "").trim();

  if (!Number.isFinite(technical) || !Number.isFinite(medical) || technical < 0 || medical < 0 || !icName || icName.length > 80 || !phone || phone.length > 40) {
    send(res, 400, JSON.stringify({ ok: false, message: "Bitte alle Felder korrekt ausfüllen." }), "application/json; charset=utf-8");
    return;
  }

  const totalMaterials = technical + medical;
  const totalPrice = technical * 250 + medical * 150;
  const order = {
    technical,
    medical,
    icName,
    phone,
    totalMaterials,
    totalPrice,
    message: `📦 Neue Material-Bestellung\n` +
      `Technische Materialien: ${technical}\n` +
      `Medizinische Materialien: ${medical}\n` +
      `Gesamtanzahl: ${totalMaterials}\n` +
      `IC-Name: ${icName}\n` +
      `Handynummer: ${phone}\n` +
      `Gesamtpreis: ${totalPrice} $\n` +
      `Zeitstempel: ${new Date().toLocaleString("de-DE")}`
  };
  const discordPayload = buildMaterialOrderPayload(order);

  try {
    const result = await postToDiscordChannel(discordPayload);
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

async function handleStankOrder(req, res) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 256000) {
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

  const quantity = Number(payload.quantity);
  const icName = String(payload.icName || "").trim();
  const phone = String(payload.phone || "").trim();
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > Math.floor(Number.MAX_SAFE_INTEGER / 2000)
    || !icName || icName.length > 80 || !phone || phone.length > 40) {
    send(res, 400, JSON.stringify({ ok: false, message: "Bitte alle Felder korrekt ausfüllen." }), "application/json; charset=utf-8");
    return;
  }

  const totalPrice = quantity * 2000;
  const order = {
    type: "stank",
    quantity,
    icName,
    phone,
    totalPrice,
    message: `🌿 Neue STANK-Bestellung\n` +
      `IC-Name: ${icName}\n` +
      `Handynummer / IC: ${phone}\n` +
      `STANK-Pflanzen: ${quantity}\n` +
      `Gesamtpreis: ${totalPrice.toLocaleString("de-DE")} $`
  };

  try {
    const result = await postToDiscordChannel(
      buildStankOrderPayload(order),
      STANK_ORDER_CHANNEL_ID,
      false
    );
    if (result.method === "local-only") {
      saveOrderLocally(order, "stank-bestellungen.json");
      send(res, 200, JSON.stringify({
        ok: true,
        total: totalPrice,
        orderCount: quantity,
        channelId: STANK_ORDER_CHANNEL_ID,
        savedLocally: true,
        message: "Bestellung lokal gespeichert. Discord-Bot-Konfiguration fehlt noch."
      }), "application/json; charset=utf-8");
      return;
    }

    send(res, 200, JSON.stringify({
      ok: true,
      total: totalPrice,
      orderCount: quantity,
      channelId: STANK_ORDER_CHANNEL_ID,
      savedLocally: false,
      message: "STANK-Bestellung wurde erfolgreich an Discord gesendet."
    }), "application/json; charset=utf-8");
  } catch (error) {
    console.error("STANK-Bestellung fehlgeschlagen:", error.message);
    saveOrderLocally(order, "stank-bestellungen.json");
    send(res, 200, JSON.stringify({
      ok: true,
      total: totalPrice,
      orderCount: quantity,
      channelId: STANK_ORDER_CHANNEL_ID,
      savedLocally: true,
      message: "Bestellung lokal gespeichert. Discord-Upload war nicht verfügbar."
    }), "application/json; charset=utf-8");
  }
}

async function handleCustomOrder(req, res) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 256000) {
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

  const icName = String(payload.icName || "").trim();
  const phone = String(payload.phone || "").trim();
  if (!icName || icName.length > 80 || !phone || phone.length > 40
    || !Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 10) {
    send(res, 400, JSON.stringify({ ok: false, message: "Bitte Kontaktdaten und 1 bis 10 gültige Positionen angeben." }), "application/json; charset=utf-8");
    return;
  }

  const items = [];
  let totalPrice = 0;
  for (const entry of payload.items) {
    const name = String(entry?.name || "").trim();
    const quantity = Number(entry?.quantity);
    const pricePerItem = Number(entry?.pricePerItem);
    if (!name || name.length > 80 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000
      || !Number.isSafeInteger(pricePerItem) || pricePerItem < 1 || pricePerItem > 1000000000) {
      send(res, 400, JSON.stringify({ ok: false, message: "Jede Position braucht Gegenstand, ganze Stückzahl und einen positiven Preisvorschlag." }), "application/json; charset=utf-8");
      return;
    }
    const itemTotal = quantity * pricePerItem;
    if (!Number.isSafeInteger(itemTotal) || !Number.isSafeInteger(totalPrice + itemTotal)) {
      send(res, 400, JSON.stringify({ ok: false, message: "Der Gesamtpreisvorschlag ist zu hoch." }), "application/json; charset=utf-8");
      return;
    }
    items.push({ name, quantity, pricePerItem, totalPrice: itemTotal });
    totalPrice += itemTotal;
  }

  const order = {
    type: "custom",
    icName,
    phone,
    items,
    totalPrice,
    message: `🛒 Neue Wunsch-Bestellung\nIC-Name: ${icName}\nHandynummer / IC: ${phone}\n` +
      items.map((item, index) => `${index + 1}. ${item.name} — ${item.quantity} × ${item.pricePerItem} $ = ${item.totalPrice} $`).join("\n") +
      `\nGesamtpreisvorschlag: ${totalPrice} $`
  };

  try {
    const result = await postToDiscordChannel(
      buildCustomOrderPayload(order),
      CUSTOM_ORDER_CHANNEL_ID,
      false
    );
    if (result.method === "local-only") {
      saveOrderLocally(order, "wunsch-bestellungen.json");
      send(res, 200, JSON.stringify({
        ok: true,
        total: totalPrice,
        orderCount: items.length,
        channelId: CUSTOM_ORDER_CHANNEL_ID,
        savedLocally: true,
        message: "Bestellung lokal gespeichert. Discord-Bot-Konfiguration fehlt noch."
      }), "application/json; charset=utf-8");
      return;
    }

    send(res, 200, JSON.stringify({
      ok: true,
      total: totalPrice,
      orderCount: items.length,
      channelId: CUSTOM_ORDER_CHANNEL_ID,
      savedLocally: false,
      message: "Wunsch-Bestellung wurde erfolgreich an Discord gesendet."
    }), "application/json; charset=utf-8");
  } catch (error) {
    console.error("Wunsch-Bestellung fehlgeschlagen:", error.message);
    saveOrderLocally(order, "wunsch-bestellungen.json");
    send(res, 200, JSON.stringify({
      ok: true,
      total: totalPrice,
      orderCount: items.length,
      channelId: CUSTOM_ORDER_CHANNEL_ID,
      savedLocally: true,
      message: "Bestellung lokal gespeichert. Discord-Upload war nicht verfügbar."
    }), "application/json; charset=utf-8");
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const config = discordConfig();
  if (req.method === "POST" && pathname === "/api/discord-interactions") {
    await handleDiscordInteraction(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/material-bestellung") {
    await handleMaterialOrder(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/stank-bestellung") {
    await handleStankOrder(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/wunsch-bestellung") {
    await handleCustomOrder(req, res);
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
  if (pathname === "/" || pathname === "/index.html" || pathname === "/material-ankauf.html" || pathname === "/material-ankauf.js" || pathname === "/stank-kauf.html" || pathname === "/stank-kauf.js" || pathname === "/freie-bestellung.html" || pathname === "/freie-bestellung.js" || pathname === "/theme.css" || pathname === "/bg.js" || pathname.startsWith("/img/")) {
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