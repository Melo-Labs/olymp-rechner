"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { verifyKey } = require("discord-interactions");
const { AttachmentBuilder, Client, EmbedBuilder, Events, GatewayIntentBits } = require("discord.js");

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

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === "true";
const SESSION_TTL = 8 * 60 * 60 * 1000;
const ROLE_CHECK_TTL = 60 * 1000;
const ORDER_CHANNEL_ID = process.env.DISCORD_ORDER_CHANNEL_ID || "1558426870465302538";
const STANK_ORDER_CHANNEL_ID = "1558497954921193592";
const CUSTOM_ORDER_CHANNEL_ID = "1558508937400291338";
const SELL_OFFER_CHANNEL_ID = process.env.DISCORD_SELL_OFFER_CHANNEL_ID || "1558812539805110434";
const CATALOG_AUDIT_CHANNEL_ID = "1558539114662330419";
const WELCOME_CHANNEL_ID = "1558193685860982880";
const UNVERIFIED_ROLE_ID = "1558193824386261192";
const ACCOUNTING_CHANNEL_ID = "1559327859351232603";
const ROOT = __dirname;
const LEGACY_CATALOG_FILE = path.join(ROOT, "shop-products.json");
const LEGACY_CATALOG_AUDIT_PENDING_FILE = path.join(ROOT, "shop-audit-pending.json");
const BUYBACK_PRODUCTS_FILE = path.join(ROOT, "data", "buyback-products.json");
const WEEKLY_BUNDLE = {
  id: "wochenangebot-bundle",
  name: "Wochenangebot (Aktionspaket)",
  price: 200000
};
const SHOP_CONTENT = {
  weeklyOffers: [],
  ads: [
    {
      title: "Werbefläche im OLYMP SHOP",
      image: "/img/werbung1.png"
    }
  ]
};
const ACCOUNTING_ORDERS_FILE = path.join(ROOT, "data", "accounting-orders.json");
const ACCOUNTING_REPORTS_FILE = path.join(ROOT, "data", "accounting-reports.json");

function resolvePersistentDataFile(envKey, fallbackPath, legacyPath) {
  const configured = process.env[envKey]?.trim();
  const target = configured ? (path.isAbsolute(configured) ? configured : path.resolve(ROOT, configured)) : path.join(ROOT, fallbackPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (!fs.existsSync(target)) {
    if (legacyPath && fs.existsSync(legacyPath)) {
      fs.copyFileSync(legacyPath, target);
    } else {
      fs.writeFileSync(target, envKey === "CATALOG_FILE" ? "[]" : "[]", "utf8");
    }
  }
  return target;
}

const CATALOG_FILE = resolvePersistentDataFile("CATALOG_FILE", "data/shop-products.json", LEGACY_CATALOG_FILE);
const CATALOG_AUDIT_PENDING_FILE = resolvePersistentDataFile("CATALOG_AUDIT_PENDING_FILE", "data/shop-audit-pending.json", LEGACY_CATALOG_AUDIT_PENDING_FILE);
const ADMIN_ORDERS_FILE = resolvePersistentDataFile("ADMIN_ORDERS_FILE", "data/admin-orders.json");
const ORDER_WEBHOOK_URL = process.env.DISCORD_ORDER_WEBHOOK_URL || "";
const sessions = new Map();
const pendingLogins = new Map();
let catalogAuditInProgress = false;
const staticFiles = new Map([
  ["/", "landing.html"],
  ["/index.html", "landing.html"],
  ["/ankauf.html", "ankauf.html"],
  ["/ankauf.js", "ankauf.js"],
  ["/material-ankauf.html", "material-ankauf.html"],
  ["/material-ankauf.js", "material-ankauf.js"],
  ["/stank-kauf.html", "stank-kauf.html"],
  ["/stank-kauf.js", "stank-kauf.js"],
  ["/freie-bestellung.html", "freie-bestellung.html"],
  ["/freie-bestellung.js", "freie-bestellung.js"],
  ["/admin/catalog", "catalog-admin.html"],
  ["/admin/catalog.js", "catalog-admin.js"],
  ["/admin/orders", "orders-admin.html"],
  ["/admin/orders.js", "orders-admin.js"],
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
    catalogAdminRoleId: process.env.DISCORD_CATALOG_ADMIN_ROLE_ID || "",
    redirectUri: process.env.DISCORD_REDIRECT_URI || "",
    botToken: process.env.DISCORD_BOT_TOKEN || "",
    publicKey: process.env.DISCORD_PUBLIC_KEY || "",
    allowedLogChannelId: process.env.DISCORD_ALLOWED_LOG_CHANNEL_ID || "",
    deniedLogChannelId: process.env.DISCORD_DENIED_LOG_CHANNEL_ID || ""
  };
}

function configIsReady(config) {
  const snowflake = /^\d{17,20}$/;
  return [
    config.clientId,
    config.clientSecret,
    config.guildId,
    config.roleId,
    config.redirectUri,
    config.botToken,
    config.publicKey,
    config.allowedLogChannelId,
    config.deniedLogChannelId
  ].every(Boolean)
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

function loginPage(error = "", title = "Produktionsrechner", redirectPath = "/produktions-rechner.html") {
  const messages = {
    setup: "Der Discord-Login oder der private Log-Channel ist noch nicht konfiguriert.",
    role: "Du hast keine passende Rolle auf dem Discord-Server.",
    state: "Der Login ist abgelaufen. Bitte versuche es erneut.",
    discord: "Die Anmeldung bei Discord ist fehlgeschlagen.",
    cancelled: "Die Discord-Anmeldung wurde abgebrochen."
  };
  const message = messages[error] || "";
  const adminPath = ["/admin/catalog", "/admin/orders"].includes(redirectPath) ? redirectPath : "/admin/catalog";
  const authHref = title === "Admin Panel" ? `/auth/discord?next=${encodeURIComponent(adminPath)}` : "/auth/discord";
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
</style></head><body><main class="login"><h1>${title}</h1><p>Zum Zugriff mit Discord anmelden.</p>${message ? `<p class="error" role="alert">${message}</p>` : ""}<a href="${authHref}">Mit Discord anmelden</a></main><script src="/bg.js"></script></body></html>`;
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

async function memberHasRole(session, config, roleId = config.roleId) {
  const response = await discordFetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(config.guildId)}/members/${encodeURIComponent(session.userId)}`, {
    headers: { Authorization: `Bot ${config.botToken}` }
  });
  if (response.status === 404) return false;
  const member = parseJson(await response.text());
  if (!response.ok || !Array.isArray(member?.roles)) {
    throw new Error(`Discord membership check failed (HTTP ${response.status}, code ${member?.code ?? "unknown"}: ${String(member?.message || "unknown response").slice(0, 160)})`);
  }
  return member.roles.includes(roleId);
}

async function logDiscordAccess(user, authorized, config) {
  const channelId = authorized ? config.allowedLogChannelId : config.deniedLogChannelId;
  const displayName = String(user.global_name || user.username || "Unbekannt").slice(0, 80);
  const embed = {
    author: { name: "OLYMP • ZUGRIFFSPROTOKOLL" },
    title: authorized ? "Zugriff freigegeben" : "Zugriff verweigert",
    description: authorized
      ? "Discord-Identität bestätigt. Die erforderliche Serverrolle ist vorhanden."
      : "Discord-Identität erkannt, aber die erforderliche Serverrolle fehlt.",
    color: authorized ? 0x48a868 : 0xd44c4c,
    fields: [
      { name: "DISCORD-KONTO", value: `<@${user.id}>\n${displayName}`, inline: true },
      { name: "ROLLENPRÜFUNG", value: authorized ? "✅ Berechtigung bestätigt" : "❌ Berechtigung fehlt", inline: true },
      { name: "USER-ID", value: `\`${user.id}\``, inline: false }
    ],
    footer: { text: "OLYMP • Sicherheitsprotokoll" },
    timestamp: new Date().toISOString()
  };
  if (user.avatar) {
    const extension = user.avatar.startsWith("a_") ? "gif" : "png";
    embed.thumbnail = { url: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=256` };
  }
  const statusImage = authorized ? "approved.png" : "denied.png";
  const message = { embeds: [embed], allowed_mentions: { parse: [] } };
  const headers = { Authorization: `Bot ${config.botToken}` };
  let body;
  try {
    const image = await fs.promises.readFile(path.join(ROOT, "img", statusImage));
    embed.image = { url: `attachment://${statusImage}` };
    const formData = new FormData();
    formData.append("payload_json", JSON.stringify(message));
    formData.append("files[0]", new Blob([image], { type: "image/png" }), statusImage);
    body = formData;
  } catch (error) {
    console.error("Discord-Zugriffsbild konnte nicht angehängt werden:", error.message);
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(message);
  }
  const response = await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers,
    body
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
    const loginUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const requestedDestination = loginUrl.searchParams.get("next");
    const isAdmin = ["/admin/catalog", "/admin/orders"].includes(requestedDestination);
    send(res, 503, loginPage("setup", isAdmin ? "Admin Panel" : "Produktionsrechner", requestedDestination || "/admin/catalog"), "text/html; charset=utf-8");
    return;
  }
  pruneState();
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const loginUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const requestedDestination = loginUrl.searchParams.get("next");
  const redirectPath = ["/admin/catalog", "/admin/orders"].includes(requestedDestination) ? requestedDestination : "";
  pendingLogins.set(state, { verifier, redirectPath, expiresAt: Date.now() + 10 * 60 * 1000 });
  appendCookie(res, makeCookie("olymp_oauth_state", state, 600));
  const query = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: "identify",
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
      discordName: String(user.global_name || user.username || "Unbekannt").slice(0, 80),
      username: String(user.username || "Unbekannt").slice(0, 80),
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
    redirect(res, pending.redirectPath || "/produktions-rechner.html");
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

const ORDER_STATUS_LABELS = {
  new: "Neu",
  accepted: "Angenommen",
  processing: "In Bearbeitung",
  completed: "Erledigt",
  rejected: "Abgelehnt"
};

function readAdminOrders() {
  const orders = JSON.parse(fs.readFileSync(ADMIN_ORDERS_FILE, "utf8"));
  if (!Array.isArray(orders)) throw new Error("Admin-Bestelldatei enthält keine Bestellliste.");
  return orders;
}

function writeAdminOrders(orders) {
  writeAccountingJson(ADMIN_ORDERS_FILE, orders);
}

function trackAdminOrder(order) {
  const orders = readAdminOrders();
  const tracked = {
    ...order,
    id: crypto.randomUUID(),
    status: "Neu",
    deliveryStatus: "pending"
  };
  orders.push(tracked);
  writeAdminOrders(orders);
  return tracked;
}

function updateAdminOrder(orderId, updates) {
  const orders = readAdminOrders();
  const index = orders.findIndex(order => order.id === orderId);
  if (index < 0) return null;
  orders[index] = { ...orders[index], ...updates };
  writeAdminOrders(orders);
  return orders[index];
}

function buildOrderComponents(order) {
  const controls = Object.entries(ORDER_STATUS_LABELS).filter(([value]) => value !== "new").map(([value, label]) => ({
    type: 2,
    style: value === "completed" ? 3 : value === "rejected" ? 4 : 2,
    label,
    custom_id: `order_status:${order.id}:${value}`,
    disabled: order.status === label
  }));
  return [
    { type: 1, components: controls },
    {
      type: 1,
      components: [{
        type: 2,
        style: 2,
        label: "Kontaktaufnahme",
        custom_id: `${order.type}_order_contact`
      }]
    }
  ];
}

function buildAdminOrderDiscordPayload(order) {
  const builders = {
    material: buildMaterialOrderPayload,
    stank: buildStankOrderPayload,
    custom: buildCustomOrderPayload
  };
  const builder = builders[order.type];
  if (!builder) throw new Error(`Unbekannter Bestelltyp: ${order.type}`);
  return builder(order);
}

function recordOrderDelivery(order, deliveryStatus, discordMessage = {}, deliveryError = "") {
  const updated = updateAdminOrder(order.id, {
    deliveryStatus,
    discordChannelId: discordMessage.channelId || "",
    discordMessageId: discordMessage.messageId || "",
    deliveryError: deliveryError.slice(0, 240)
  });
  if (updated) Object.assign(order, updated);
}

function accountingDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function previousAccountingDate(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}-${String(previous.getUTCDate()).padStart(2, "0")}`;
}

function nextAccountingDate(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function writeAccountingJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function readAccountingOrders() {
  if (!fs.existsSync(ACCOUNTING_ORDERS_FILE)) return [];
  const orders = JSON.parse(fs.readFileSync(ACCOUNTING_ORDERS_FILE, "utf8"));
  if (!Array.isArray(orders)) throw new Error("Buchhaltungsdatei enthält keine Bestellliste.");
  return orders;
}

function recordAccountingOrder(type, totalPrice, createdAt) {
  if (!["material", "stank", "custom"].includes(type) || !Number.isSafeInteger(totalPrice) || totalPrice < 0) {
    throw new Error("Ungültige Buchhaltungsdaten für Bestellung.");
  }
  const order = {
    id: crypto.randomUUID(),
    type,
    totalPrice,
    createdAt
  };
  const orders = readAccountingOrders();
  orders.push(order);
  writeAccountingJson(ACCOUNTING_ORDERS_FILE, orders);
  return order.id;
}

function readAccountingReports() {
  if (!fs.existsSync(ACCOUNTING_REPORTS_FILE)) {
    const initial = { startedOn: accountingDateKey(), sentDates: [] };
    writeAccountingJson(ACCOUNTING_REPORTS_FILE, initial);
    return initial;
  }
  const state = JSON.parse(fs.readFileSync(ACCOUNTING_REPORTS_FILE, "utf8"));
  if (!state || !/^\d{4}-\d{2}-\d{2}$/.test(state.startedOn) || !Array.isArray(state.sentDates)) {
    throw new Error("Buchhaltungsstatus ist ungültig.");
  }
  return state;
}

function accountingDateIsDue(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
  return values.hour > 0 || (values.hour === 0 && values.minute >= 5);
}

function summarizeAccountingDate(dateKey, orders) {
  const totals = new Map([
    ["material", { label: "Materialbestellungen", total: 0n, count: 0 }],
    ["stank", { label: "STANK-Bestellungen", total: 0n, count: 0 }],
    ["custom", { label: "Wunschbestellungen", total: 0n, count: 0 }]
  ]);
  let total = 0n;
  let count = 0;

  for (const order of orders) {
    const timestamp = typeof order?.createdAt === "string" ? new Date(order.createdAt) : null;
    if (!order || !Number.isSafeInteger(order.totalPrice) || order.totalPrice < 0
      || !timestamp || Number.isNaN(timestamp.getTime()) || accountingDateKey(timestamp) !== dateKey) continue;
    const category = totals.get(order.type);
    if (!category) continue;
    category.total += BigInt(order.totalPrice);
    category.count += 1;
    total += BigInt(order.totalPrice);
    count += 1;
  }

  return { total, count, categories: [...totals.values()] };
}

async function sendAccountingReport(dateKey, orders) {
  const summary = summarizeAccountingDate(dateKey, orders);
  const embed = {
    title: `Tagesbuchhaltung · ${dateKey.split("-").reverse().join(".")}`,
    description: `**Bestellsumme: ${summary.total.toLocaleString("de-DE")} $**\n${summary.count} Bestellungen\n\nDie Summe zeigt erfasste Bestellbeträge, keine bestätigten Zahlungseingänge.`,
    color: 0x3978d4,
    fields: summary.categories.map(category => ({
      name: category.label,
      value: `${category.total.toLocaleString("de-DE")} $ · ${category.count} Bestellungen`,
      inline: true
    })),
    footer: { text: "Ankauf-Angebote sind nicht enthalten." },
    timestamp: new Date().toISOString()
  };
  const result = await postToDiscordChannel(
    { embeds: [embed], allowed_mentions: { parse: [] } },
    ACCOUNTING_CHANNEL_ID,
    false
  );
  if (result.method === "local-only") {
    throw new Error("Buchhaltungsbericht konnte nicht gesendet werden: DISCORD_BOT_TOKEN fehlt.");
  }
}

let accountingReportInProgress = false;
let lastAccountingReportError = "";

async function runDailyAccountingReport() {
  if (accountingReportInProgress || !accountingDateIsDue()) return;
  accountingReportInProgress = true;
  try {
    const state = readAccountingReports();
    const latestClosedDate = previousAccountingDate(accountingDateKey());
    if (state.startedOn > latestClosedDate) return;
    let reportDate = state.startedOn;
    while (reportDate <= latestClosedDate && state.sentDates.includes(reportDate)) {
      reportDate = nextAccountingDate(reportDate);
    }
    if (reportDate > latestClosedDate) return;

    await sendAccountingReport(reportDate, readAccountingOrders());
    state.sentDates.push(reportDate);
    writeAccountingJson(ACCOUNTING_REPORTS_FILE, state);
    lastAccountingReportError = "";
    console.log(`Buchhaltungsbericht für ${reportDate} in Discord veröffentlicht.`);
  } catch (error) {
    const signature = error.message || String(error);
    if (signature !== lastAccountingReportError) {
      console.error("Buchhaltungsbericht konnte nicht veröffentlicht werden:", signature);
      lastAccountingReportError = signature;
    }
  } finally {
    accountingReportInProgress = false;
  }
}

function normalizeShopProduct(product, fallbackId = crypto.randomUUID()) {
  const id = typeof product?.id === "string" && /^[a-f0-9-]{36}$/i.test(product.id)
    ? product.id
    : fallbackId;
  const name = String(product?.name ?? "").trim();
  const price = Number(product?.price);
  const image = typeof product?.image === "string" ? product.image.trim() : "";
  const category = String(product?.category ?? "").trim() || "Allgemein";
  const available = typeof product?.available === "boolean" ? product.available : true;
  const active = typeof product?.active === "boolean" ? product.active : true;

  return {
    id,
    name,
    price,
    image,
    category,
    available: Boolean(available) && active,
    active
  };
}

function getShopPromotion(product) {
  const promotion = SHOP_CONTENT.weeklyOffers.find(entry => entry.productId === product.id);
  if (!promotion || !Number.isSafeInteger(promotion.price) || promotion.price < 1 || promotion.price >= product.price) return null;
  return {
    price: promotion.price,
    label: String(promotion.label || "Wochenangebot")
  };
}

function readShopProducts() {
  const products = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
  if (!Array.isArray(products)) throw new Error("Shop product catalog must be a JSON array.");
  return products.map((product, index) => normalizeShopProduct(product, `${index}-${crypto.randomUUID()}`));
}

function saveShopProducts(products) {
  const temporaryFile = `${CATALOG_FILE}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(products, null, 2), { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporaryFile, CATALOG_FILE);
}

async function requireCatalogAdmin(req, res, config, redirectPath = "/admin/catalog") {
  const deny = (status, message) => {
    if (String(req.headers.accept || "").includes("text/html")) {
      const page = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Produktverwaltung</title><body style="margin:0;padding:3rem;background:#101214;color:#ececec;font:16px/1.6 system-ui,sans-serif"><main style="max-width:640px;margin:auto"><h1>Produktverwaltung</h1><p>${message}</p><a style="color:#8ec6e8" href="/freie-bestellung.html">Zurück zum Shop</a></main></body></html>`;
      send(res, status, page, "text/html; charset=utf-8");
    } else {
      send(res, status, JSON.stringify({ ok: false, message }), "application/json; charset=utf-8");
    }
  };
  if (!/^\d{17,20}$/.test(config.catalogAdminRoleId)) {
    deny(503, "Die Discord-Rolle für die Produktverwaltung ist noch nicht konfiguriert. Bitte DISCORD_CATALOG_ADMIN_ROLE_ID setzen.");
    return false;
  }
  if (!configIsReady(config)) {
    redirect(res, "/login?error=setup&admin=1");
    return false;
  }

  let session;
  try {
    session = await authorizedSession(req, config);
  } catch (error) {
    console.error("Katalog-Admin-Rollenprüfung fehlgeschlagen:", error.message);
    deny(502, "Die Discord-Rollenprüfung ist momentan nicht erreichbar. Bitte versuche es später erneut.");
    return false;
  }
  if (!session) {
    if (String(req.headers.accept || "").includes("text/html")) {
      redirect(res, `/login?admin=1&next=${encodeURIComponent(redirectPath)}`);
    } else {
      send(res, 401, JSON.stringify({ ok: false, message: "Bitte melde dich mit deinem Discord-Admin-Konto an." }), "application/json; charset=utf-8");
    }
    return null;
  }

  try {
    if (!await memberHasRole(session, config, config.catalogAdminRoleId)) {
      deny(403, "Dein Discord-Konto hat keine Katalog-Admin-Rolle.");
      return null;
    }
  } catch (error) {
    console.error("Katalog-Admin-Rollenprüfung fehlgeschlagen:", error.message);
    deny(502, "Die Discord-Rollenprüfung ist momentan nicht erreichbar. Bitte versuche es später erneut.");
    return null;
  }
  return session;
}

function validateShopProducts(value) {
  if (!Array.isArray(value) || value.length > 200) {
    return { error: "Der Katalog darf höchstens 200 Produkte enthalten." };
  }
  const products = [];
  const ids = new Set();
  for (const entry of value) {
    const product = normalizeShopProduct(entry, crypto.randomUUID());
    const name = product.name;
    const price = Number(product.price);
    const image = typeof product.image === "string" ? product.image.trim() : "";
    const category = String(product.category || "").trim() || "Allgemein";
    const available = typeof product.available === "boolean" ? product.available : true;
    const validImage = !image
      || /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/i.test(image)
      || /^https?:\/\/[^\s]+\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(image)
      || /^\/img\/[^\s]+\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(image)
      || /^\.?\.?\/[^\s]+\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(image);
    if (!name || name.length > 80 || category.length > 40
      || !Number.isSafeInteger(price) || price < 1 || price > 1000000000
      || !validImage || typeof product.active !== "boolean" || typeof available !== "boolean" || ids.has(product.id)) {
      return { error: "Produktdaten ungültig: Name, Preis, Bild, Kategorie, Verfügbarkeit, Status oder Produkt-ID prüfen." };
    }
    ids.add(product.id);
    products.push({
      id: product.id,
      name,
      price,
      image,
      category,
      available: available && product.active,
      active: product.active
    });
  }
  return { products };
}

function describeCatalogChanges(previous, updated) {
  const before = new Map(previous.map(product => [product.id, product]));
  const after = new Map(updated.map(product => [product.id, product]));
  const changes = [];
  const auditText = value => String(value ?? "").replace(/@/g, "@\u200b").replace(/\s+/g, " ").slice(0, 320);

  for (const product of updated) {
    const oldProduct = before.get(product.id);
    if (!oldProduct) {
      changes.push(`➕ Hinzugefügt: **${auditText(product.name)}** — ${product.price.toLocaleString("de-DE")} $ (${product.active ? "aktiv" : "inaktiv"})`);
      continue;
    }
    const differences = [];
    if (oldProduct.name !== product.name) differences.push(`Name: „${auditText(oldProduct.name)}“ → „${auditText(product.name)}“`);
    if (oldProduct.description !== product.description) differences.push(`Beschreibung: „${auditText(oldProduct.description || "—")}“ → „${auditText(product.description || "—")}“`);
    if (oldProduct.price !== product.price) differences.push(`Preis: ${oldProduct.price.toLocaleString("de-DE")} $ → ${product.price.toLocaleString("de-DE")} $`);
    if (oldProduct.image !== product.image) differences.push(`Bild: ${oldProduct.image ? "vorhanden" : "kein Bild"} → ${product.image ? "vorhanden" : "kein Bild"}`);
    if (oldProduct.category !== product.category) differences.push(`Kategorie: ${auditText(oldProduct.category || "Allgemein")} → ${auditText(product.category || "Allgemein")}`);
    if (oldProduct.available !== product.available) differences.push(`Verfügbar: ${oldProduct.available ? "ja" : "nein"} → ${product.available ? "ja" : "nein"}`);
    if (oldProduct.active !== product.active) differences.push(`Status: ${oldProduct.active ? "aktiv" : "inaktiv"} → ${product.active ? "aktiv" : "inaktiv"}`);
    if (differences.length) changes.push(`✏️ Geändert: **${auditText(product.name)}** — ${differences.join("; ")}`);
  }

  for (const product of previous) {
    if (!after.has(product.id)) changes.push(`🗑️ Entfernt: **${auditText(product.name)}** — ${product.price.toLocaleString("de-DE")} $`);
  }
  return changes;
}

function readPendingCatalogAudits() {
  if (!fs.existsSync(CATALOG_AUDIT_PENDING_FILE)) return [];
  const pending = JSON.parse(fs.readFileSync(CATALOG_AUDIT_PENDING_FILE, "utf8"));
  if (!Array.isArray(pending)) throw new Error("Pending catalog audit data must be an array.");
  return pending;
}

function savePendingCatalogAudits(pending) {
  const temporaryFile = `${CATALOG_AUDIT_PENDING_FILE}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(pending, null, 2), { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporaryFile, CATALOG_AUDIT_PENDING_FILE);
}

async function logCatalogChanges(records) {
  for (const record of records) {
    const chunks = [];
    let chunk = "";
    for (const change of record.changes) {
      const nextChunk = chunk ? `${chunk}\n${change}` : change;
      if (nextChunk.length > 3500 && chunk) {
        chunks.push(chunk);
        chunk = change;
      } else {
        chunk = nextChunk;
      }
    }
    if (chunk) chunks.push(chunk);

    for (let index = 0; index < chunks.length; index++) {
      const payload = {
        embeds: [{
          title: `Shop-Katalog geändert (${index + 1}/${chunks.length})`,
          description: chunks[index],
          color: 0xe4e8ee,
          fields: [
            { name: "Geändert von", value: record.adminName, inline: true },
            { name: "Discord-ID", value: record.userId, inline: true },
            { name: "Änderungen", value: `${record.changes.length}`, inline: true }
          ],
          timestamp: record.timestamp
        }],
        allowed_mentions: { parse: [] }
      };
      const result = await postToDiscordChannel(payload, CATALOG_AUDIT_CHANNEL_ID, false);
      if (result.method !== "bot") throw new Error("Discord-Bot ist für das Katalog-Audit nicht konfiguriert.");
    }
  }
}

async function flushPendingCatalogAudits() {
  if (catalogAuditInProgress) return { ok: false, changeCount: 0 };
  catalogAuditInProgress = true;
  try {
    const pending = readPendingCatalogAudits();
    const changeCount = pending.reduce((total, record) => total + record.changes.length, 0);
    if (!pending.length) return { ok: true, changeCount: 0 };
    await logCatalogChanges(pending);
    const sentIds = new Set(pending.map(record => record.id));
    const remaining = readPendingCatalogAudits().filter(record => !sentIds.has(record.id));
    if (remaining.length) savePendingCatalogAudits(remaining);
    else fs.unlinkSync(CATALOG_AUDIT_PENDING_FILE);
    return { ok: true, changeCount };
  } catch (error) {
    console.error(`Katalog-Audit-Warteschlange konnte nicht vollständig verarbeitet werden (${CATALOG_AUDIT_CHANNEL_ID}):`, error.message);
    return { ok: false, changeCount: 0 };
  } finally {
    catalogAuditInProgress = false;
  }
}

const catalogAuditRetryTimer = setInterval(() => {
  void flushPendingCatalogAudits();
}, 60 * 1000);
catalogAuditRetryTimer.unref();

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
        { name: "Gesamtpreis", value: `${order.totalPrice.toLocaleString("de-DE")} $`, inline: true },
        { name: "Status", value: order.status || "Neu", inline: true }
      ],
      footer: { text: "Olymp Rechner • STANK-Kauf" },
      timestamp: order.createdAt || new Date().toISOString()
    }],
    components: buildOrderComponents(order),
    allowed_mentions: { parse: [] }
  };
}

function buildCustomOrderPayload(order) {
  const itemList = order.items.map((item, index) =>
    `**${index + 1}. ${item.name}**${item.type === "custom" ? " (Wunsch)" : ""} — ${item.quantity} × ${item.pricePerItem.toLocaleString("de-DE")} $${item.type === "custom" ? " Preisvorschlag" : " Festpreis"} = ${item.totalPrice.toLocaleString("de-DE")} $`
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
        { name: "Gesamtsumme", value: `${order.totalPrice.toLocaleString("de-DE")} $`, inline: true },
        { name: "Status", value: order.status || "Neu", inline: true }
      ],
      footer: { text: "Olymp Rechner • Wunsch-Bestellung" },
      timestamp: order.createdAt || new Date().toISOString()
    }],
    components: buildOrderComponents(order),
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
        { name: "Status", value: order.status || "Neu", inline: true },
        { name: "Zeitstempel", value: `${new Date(order.createdAt || Date.now()).toLocaleString("de-DE")}`, inline: false }
      ],
      footer: { text: "Olymp Rechner • Material-Ankauf" },
      timestamp: order.createdAt || new Date().toISOString()
    }],
    components: buildOrderComponents(order),
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
    const statusAction = /^order_status:([a-f0-9-]{36}):(accepted|processing|completed|rejected)$/i.exec(action || "");
    if (statusAction) {
      const [, orderId, statusKey] = statusAction;
      const authorized = payload.guild_id === config.guildId
        && /^\d{17,20}$/.test(config.catalogAdminRoleId)
        && Array.isArray(payload.member?.roles)
        && payload.member.roles.includes(config.catalogAdminRoleId);
      if (!authorized) {
        send(res, 200, JSON.stringify({
          type: 4,
          data: { content: "Du hast keine Berechtigung, den Bestellstatus zu ändern.", flags: 64 }
        }), "application/json; charset=utf-8");
        return;
      }

      let order;
      try {
        order = readAdminOrders().find(entry => entry.id === orderId);
      } catch (error) {
        console.error("Bestellübersicht konnte bei Discord-Interaktion nicht gelesen werden:", error.message);
        send(res, 200, JSON.stringify({
          type: 4,
          data: { content: "Der Bestellstatus konnte nicht gespeichert werden. Bitte Admin informieren.", flags: 64 }
        }), "application/json; charset=utf-8");
        return;
      }
      if (!order || order.discordMessageId !== payload.message?.id
        || order.discordChannelId !== payload.channel_id) {
        send(res, 200, JSON.stringify({
          type: 4,
          data: { content: "Diese Bestellnachricht ist nicht mehr verfügbar.", flags: 64 }
        }), "application/json; charset=utf-8");
        return;
      }

      order.status = ORDER_STATUS_LABELS[statusKey];
      order.updatedAt = new Date().toISOString();
      order.updatedBy = String(payload.member?.user?.global_name || payload.member?.user?.username || "Discord-Admin").slice(0, 80);
      try {
        order = updateAdminOrder(orderId, {
          status: order.status,
          updatedAt: order.updatedAt,
          updatedBy: order.updatedBy
        });
        const message = buildAdminOrderDiscordPayload(order);
        send(res, 200, JSON.stringify({
          type: 7,
          data: {
            content: message.content,
            embeds: message.embeds,
            components: message.components,
            allowed_mentions: message.allowed_mentions
          }
        }), "application/json; charset=utf-8");
      } catch (error) {
        console.error("Bestellstatus konnte nicht gespeichert werden:", error.message);
        send(res, 200, JSON.stringify({
          type: 4,
          data: { content: "Der Bestellstatus konnte nicht gespeichert werden. Bitte Admin informieren.", flags: 64 }
        }), "application/json; charset=utf-8");
      }
      return;
    }

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

    const canManageOrders = payload.guild_id === config.guildId
      && /^\d{17,20}$/.test(config.catalogAdminRoleId)
      && Array.isArray(payload.member?.roles)
      && payload.member.roles.includes(config.catalogAdminRoleId);
    if (!canManageOrders) {
      send(res, 200, JSON.stringify({
        type: 4,
        data: { content: "Du hast keine Berechtigung, den Bestellstatus zu ändern.", flags: 64 }
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
    const webhookUrl = new URL(ORDER_WEBHOOK_URL);
    webhookUrl.searchParams.set("wait", "true");
    const response = await discordFetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = parseJson(await response.text());
    if (!response.ok) {
      throw new Error(data?.message || "Webhook-Request fehlgeschlagen.");
    }
    return { method: "webhook", channelId: data?.channel_id || channelId, messageId: data?.id || "" };
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
    return { method: "bot", channelId: data?.channel_id || channelId, messageId: data?.id || "" };
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
    customerName: icName,
    status: "Neu",
    createdAt: new Date().toISOString(),
    message: `📦 Neue Material-Bestellung\n` +
      `Technische Materialien: ${technical}\n` +
      `Medizinische Materialien: ${medical}\n` +
      `Gesamtanzahl: ${totalMaterials}\n` +
      `IC-Name: ${icName}\n` +
      `Handynummer: ${phone}\n` +
      `Gesamtpreis: ${totalPrice} $\n` +
      `Zeitstempel: ${new Date().toLocaleString("de-DE")}`
  };
  Object.assign(order, trackAdminOrder(order));
  const discordPayload = buildMaterialOrderPayload(order);
  recordAccountingOrder("material", totalPrice, order.createdAt);

  try {
    const result = await postToDiscordChannel(discordPayload, ORDER_CHANNEL_ID, false);
    if (result.method === "local-only") {
      recordOrderDelivery(order, "local-only");
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
    recordOrderDelivery(order, result.method, result);

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
    recordOrderDelivery(order, "failed", {}, error.message || String(error));
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

function readBuybackProducts() {
  const products = JSON.parse(fs.readFileSync(BUYBACK_PRODUCTS_FILE, "utf8"));
  if (!Array.isArray(products) || products.length < 1 || products.length > 100) {
    throw new Error("Buyback product catalog must contain between 1 and 100 products.");
  }

  const ids = new Set();
  for (const product of products) {
    if (!product || typeof product.id !== "string" || !/^[a-z0-9-]{1,80}$/.test(product.id)
      || typeof product.name !== "string" || !product.name.trim() || product.name.length > 80
      || !Number.isSafeInteger(product.price) || product.price < 1 || product.price > 1000000000
      || ids.has(product.id)) {
      throw new Error("Buyback product catalog contains invalid product data.");
    }
    ids.add(product.id);
  }
  return products;
}

async function handleSellOffer(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readRequestBody(req, 256 * 1024));
  } catch (error) {
    const tooLarge = error.message === "Request body too large.";
    send(res, tooLarge ? 413 : 400, JSON.stringify({
      ok: false,
      message: tooLarge ? "Anfrage zu groß." : "Ungültige Formulardaten."
    }), "application/json; charset=utf-8");
    return;
  }

  const icName = String(payload?.icName || "").trim();
  const phone = String(payload?.phone || "").trim();
  if (!icName || icName.length > 80 || !phone || phone.length > 40
    || !Array.isArray(payload?.items) || payload.items.length < 1 || payload.items.length > 100) {
    send(res, 400, JSON.stringify({ ok: false, message: "Bitte mindestens einen Gegenstand auswählen und deine Kontaktdaten korrekt ausfüllen." }), "application/json; charset=utf-8");
    return;
  }

  let products;
  try {
    products = readBuybackProducts();
  } catch (error) {
    console.error("Ankauf-Preisliste konnte nicht gelesen werden:", error.message);
    send(res, 500, JSON.stringify({ ok: false, message: "Die Ankauf-Preisliste ist momentan nicht verfügbar." }), "application/json; charset=utf-8");
    return;
  }

  const productById = new Map(products.map(product => [product.id, product]));
  const seenProductIds = new Set();
  const items = [];
  let totalPrice = 0;
  for (const entry of payload.items) {
    const product = productById.get(entry?.productId);
    const quantity = Number(entry?.quantity);
    if (!product || seenProductIds.has(product.id)
      || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) {
      send(res, 400, JSON.stringify({ ok: false, message: "Eine ausgewählte Position oder Stückzahl ist ungültig." }), "application/json; charset=utf-8");
      return;
    }
    const itemTotal = product.price * quantity;
    if (!Number.isSafeInteger(itemTotal) || !Number.isSafeInteger(totalPrice + itemTotal)) {
      send(res, 400, JSON.stringify({ ok: false, message: "Der Gesamtpreis ist zu hoch." }), "application/json; charset=utf-8");
      return;
    }
    seenProductIds.add(product.id);
    totalPrice += itemTotal;
    items.push({ productId: product.id, name: product.name, quantity, pricePerItem: product.price, totalPrice: itemTotal });
  }

  const itemList = items.map(item =>
    `**${item.name}** — ${item.quantity} × ${item.pricePerItem.toLocaleString("de-DE")} $ = ${item.totalPrice.toLocaleString("de-DE")} $`
  ).join("\n");
  const sellOffer = {
    type: "sell-offer",
    items,
    icName,
    phone,
    totalPrice,
    status: "Neu",
    createdAt: new Date().toISOString()
  };
  const discordPayload = {
    content: "💰 Neues Ankauf-Angebot",
    embeds: [{
      title: "Neues Ankauf-Angebot",
      description: itemList,
      color: 0xd7ad72,
      fields: [
        { name: "IC-Name", value: icName, inline: true },
        { name: "Telefonnummer", value: phone, inline: true },
        { name: "Gesamtsumme", value: `${totalPrice.toLocaleString("de-DE")} $`, inline: true }
      ],
      footer: { text: "Olymp Rechner • Ankauf" },
      timestamp: sellOffer.createdAt
    }],
    allowed_mentions: { parse: [] }
  };

  try {
    const result = await postToDiscordChannel(discordPayload, SELL_OFFER_CHANNEL_ID);
    if (result.method === "local-only") {
      saveOrderLocally(sellOffer, "ankauf-angebote.json");
      send(res, 200, JSON.stringify({
        ok: true,
        savedLocally: true,
        message: "Angebot lokal gespeichert. Die Discord-Konfiguration fehlt noch."
      }), "application/json; charset=utf-8");
      return;
    }

    send(res, 200, JSON.stringify({
      ok: true,
      savedLocally: false,
      message: "Dein Ankauf-Angebot wurde erfolgreich gesendet."
    }), "application/json; charset=utf-8");
  } catch (error) {
    console.error("Ankauf-Angebot konnte nicht an Discord gesendet werden:", error.message);
    saveOrderLocally(sellOffer, "ankauf-angebote.json");
    send(res, 200, JSON.stringify({
      ok: true,
      savedLocally: true,
      message: "Angebot lokal gespeichert. Der Discord-Upload war nicht verfügbar."
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
    customerName: icName,
    status: "Neu",
    createdAt: new Date().toISOString(),
    message: `🌿 Neue STANK-Bestellung\n` +
      `IC-Name: ${icName}\n` +
      `Handynummer / IC: ${phone}\n` +
      `STANK-Pflanzen: ${quantity}\n` +
      `Gesamtpreis: ${totalPrice.toLocaleString("de-DE")} $`
  };
  Object.assign(order, trackAdminOrder(order));
  recordAccountingOrder("stank", totalPrice, order.createdAt);
  try {
    const result = await postToDiscordChannel(
      buildStankOrderPayload(order),
      STANK_ORDER_CHANNEL_ID,
      false
    );
    if (result.method === "local-only") {
      recordOrderDelivery(order, "local-only");
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
    recordOrderDelivery(order, result.method, result);

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
    recordOrderDelivery(order, "failed", {}, error.message || String(error));
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
  let catalog;
  try {
    catalog = readShopProducts();
  } catch (error) {
    console.error("Shop-Katalog konnte nicht gelesen werden:", error.message);
    send(res, 500, JSON.stringify({ ok: false, message: "Der Produktkatalog ist momentan nicht verfügbar." }), "application/json; charset=utf-8");
    return;
  }
  for (const entry of payload.items) {
    const type = entry?.type === "catalog" ? "catalog" : entry?.type === "weeklyOffer" ? "weeklyOffer" : "custom";
    const quantity = Number(entry?.quantity);
    let name;
    let pricePerItem;
    if (type === "catalog") {
      const product = catalog.find(item => item.id === entry?.productId && item.active);
      if (!product) {
        send(res, 400, JSON.stringify({ ok: false, message: "Ein ausgewähltes Produkt ist nicht mehr verfügbar." }), "application/json; charset=utf-8");
        return;
      }
      name = product.name;
      pricePerItem = getShopPromotion(product)?.price ?? product.price;
    } else if (type === "weeklyOffer") {
      if (entry?.weeklyOfferId !== WEEKLY_BUNDLE.id) {
        send(res, 400, JSON.stringify({ ok: false, message: "Das Wochenangebot ist nicht mehr verfügbar." }), "application/json; charset=utf-8");
        return;
      }
      name = WEEKLY_BUNDLE.name;
      pricePerItem = WEEKLY_BUNDLE.price;
    } else {
      name = String(entry?.name || "").trim();
      pricePerItem = Number(entry?.pricePerItem);
    }
    if (!name || name.length > 80 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000
      || !Number.isSafeInteger(pricePerItem) || pricePerItem < 1 || pricePerItem > 1000000000) {
      send(res, 400, JSON.stringify({ ok: false, message: "Jede Position braucht einen gültigen Gegenstand, eine Stückzahl und einen gültigen Preis." }), "application/json; charset=utf-8");
      return;
    }
    const itemTotal = quantity * pricePerItem;
    if (!Number.isSafeInteger(itemTotal) || !Number.isSafeInteger(totalPrice + itemTotal)) {
      send(res, 400, JSON.stringify({ ok: false, message: "Der Gesamtpreisvorschlag ist zu hoch." }), "application/json; charset=utf-8");
      return;
    }
    items.push({ type, name, quantity, pricePerItem, totalPrice: itemTotal });
    totalPrice += itemTotal;
  }

  const order = {
    type: "custom",
    icName,
    phone,
    items,
    totalPrice,
    customerName: icName,
    status: "Neu",
    createdAt: new Date().toISOString(),
    message: `🛒 Neue Wunsch-Bestellung\nIC-Name: ${icName}\nHandynummer / IC: ${phone}\n` +
      items.map((item, index) => `${index + 1}. ${item.name}${item.type === "custom" ? " (Wunsch)" : ""} — ${item.quantity} × ${item.pricePerItem} $ = ${item.totalPrice} $`).join("\n") +
      `\nGesamtsumme: ${totalPrice} $`
  };
  Object.assign(order, trackAdminOrder(order));
  recordAccountingOrder("custom", totalPrice, order.createdAt);
  try {
    const result = await postToDiscordChannel(
      buildCustomOrderPayload(order),
      CUSTOM_ORDER_CHANNEL_ID,
      false
    );
    if (result.method === "local-only") {
      recordOrderDelivery(order, "local-only");
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
    recordOrderDelivery(order, result.method, result);

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
    recordOrderDelivery(order, "failed", {}, error.message || String(error));
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
  if (req.method === "POST" && pathname === "/api/ankauf-angebot") {
    await handleSellOffer(req, res);
    return;
  }
  if (req.method === "GET" && pathname === "/api/ankauf-produkte") {
    try {
      send(res, 200, JSON.stringify({ ok: true, products: readBuybackProducts() }), "application/json; charset=utf-8");
    } catch (error) {
      console.error("Ankauf-Preisliste konnte nicht gelesen werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Die Ankauf-Preisliste ist momentan nicht verfügbar." }), "application/json; charset=utf-8");
    }
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
  const orderStatusPath = pathname.match(/^\/api\/admin\/orders\/([a-f0-9-]{36})$/i);
  if ((req.method === "GET" && pathname === "/api/admin/orders") || (req.method === "PATCH" && orderStatusPath)) {
    const adminSession = await requireCatalogAdmin(req, res, config, "/admin/orders");
    if (!adminSession) return;
    if (req.method === "GET") {
      try {
        const orders = readAdminOrders().sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
        send(res, 200, JSON.stringify({ ok: true, orders }), "application/json; charset=utf-8");
      } catch (error) {
        console.error("Admin-Bestellübersicht konnte nicht gelesen werden:", error.message);
        send(res, 500, JSON.stringify({ ok: false, message: "Die Bestellübersicht konnte nicht gelesen werden." }), "application/json; charset=utf-8");
      }
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readRequestBody(req, 16 * 1024));
    } catch {
      send(res, 400, JSON.stringify({ ok: false, message: "Ungültige Statusdaten." }), "application/json; charset=utf-8");
      return;
    }
    if (!Object.hasOwn(ORDER_STATUS_LABELS, payload?.status)) {
      send(res, 400, JSON.stringify({ ok: false, message: "Dieser Bestellstatus ist ungültig." }), "application/json; charset=utf-8");
      return;
    }

    let order;
    try {
      order = updateAdminOrder(orderStatusPath[1], {
        status: ORDER_STATUS_LABELS[payload.status],
        updatedAt: new Date().toISOString(),
        updatedBy: adminSession.discordName || adminSession.username || "Discord-Admin"
      });
    } catch (error) {
      console.error("Bestellstatus konnte nicht gespeichert werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Der Bestellstatus konnte nicht gespeichert werden." }), "application/json; charset=utf-8");
      return;
    }
    if (!order) {
      send(res, 404, JSON.stringify({ ok: false, message: "Bestellung nicht gefunden." }), "application/json; charset=utf-8");
      return;
    }

    let discordSynced = false;
    let warning = "";
    if (order.discordChannelId && order.discordMessageId) {
      try {
        const discordResponse = await discordFetch(
          `https://discord.com/api/v10/channels/${encodeURIComponent(order.discordChannelId)}/messages/${encodeURIComponent(order.discordMessageId)}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bot ${config.botToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(buildAdminOrderDiscordPayload(order))
          }
        );
        const responseBody = parseJson(await discordResponse.text());
        if (!discordResponse.ok) {
          throw new Error(`Discord API HTTP ${discordResponse.status}: ${String(responseBody?.message || "Unbekannter Fehler").slice(0, 160)}`);
        }
        discordSynced = true;
      } catch (error) {
        warning = "Status wurde gespeichert, aber die Discord-Nachricht konnte nicht aktualisiert werden.";
        console.error(`Discord-Bestellnachricht ${order.discordMessageId} konnte nicht aktualisiert werden:`, error.message);
      }
    }
    send(res, 200, JSON.stringify({ ok: true, order, discordSynced, warning }), "application/json; charset=utf-8");
    return;
  }
  if (req.method === "GET" && pathname === "/api/shop/products") {
    try {
      const products = readShopProducts()
        .filter(product => product.active && product.available)
        .map(product => ({
          id: product.id,
          name: product.name,
          description: product.description,
          price: product.price,
          image: product.image,
          category: product.category,
          available: product.available,
          promotion: getShopPromotion(product)
        }));
      send(res, 200, JSON.stringify({ ok: true, products, ads: SHOP_CONTENT.ads, weeklyBundle: WEEKLY_BUNDLE }), "application/json; charset=utf-8");
    } catch (error) {
      console.error("Shop-Katalog konnte nicht gelesen werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Der Produktkatalog ist momentan nicht verfügbar." }), "application/json; charset=utf-8");
    }
    return;
  }
  if ((req.method === "GET" || req.method === "PUT") && pathname === "/api/admin/shop-products") {
    const adminSession = await requireCatalogAdmin(req, res, config);
    if (!adminSession) return;
    if (req.method === "GET") {
      try {
        send(res, 200, JSON.stringify({ ok: true, products: readShopProducts() }), "application/json; charset=utf-8");
      } catch (error) {
        console.error("Shop-Katalog konnte nicht gelesen werden:", error.message);
        send(res, 500, JSON.stringify({ ok: false, message: "Der Produktkatalog konnte nicht gelesen werden." }), "application/json; charset=utf-8");
      }
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await readRequestBody(req, 256 * 1024));
    } catch (error) {
      send(res, 400, JSON.stringify({ ok: false, message: "Ungültige oder zu große Produktdaten." }), "application/json; charset=utf-8");
      return;
    }
    const validation = validateShopProducts(payload?.products);
    if (validation.error) {
      send(res, 400, JSON.stringify({ ok: false, message: validation.error }), "application/json; charset=utf-8");
      return;
    }
    let previousProducts;
    try {
      previousProducts = readShopProducts();
    } catch (error) {
      console.error("Vorheriger Shop-Katalog konnte nicht gelesen werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Der aktuelle Produktkatalog konnte nicht gelesen werden." }), "application/json; charset=utf-8");
      return;
    }
    try {
      saveShopProducts(validation.products);
    } catch (error) {
      console.error("Shop-Katalog konnte nicht gespeichert werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Der Produktkatalog konnte nicht gespeichert werden." }), "application/json; charset=utf-8");
      return;
    }
    const changes = describeCatalogChanges(previousProducts, validation.products);
    let auditLogged = false;
    let auditChangeCount = changes.length;
    let warning = "";
    try {
      if (changes.length) {
        const pending = readPendingCatalogAudits();
        pending.push({
          id: crypto.randomUUID(),
          adminName: adminSession.discordName || adminSession.username || "Unbekannt",
          userId: adminSession.userId,
          timestamp: new Date().toISOString(),
          changes
        });
        savePendingCatalogAudits(pending);
      }
      const auditResult = await flushPendingCatalogAudits();
      auditLogged = auditResult.ok;
      auditChangeCount = auditResult.changeCount || changes.length;
      if (!auditLogged) warning = "Änderung gespeichert und zum Audit vorgemerkt. Discord konnte das Protokoll gerade nicht annehmen; der Server versucht es automatisch erneut.";
    } catch (error) {
      warning = "Änderung gespeichert, aber das Audit konnte nicht dauerhaft vorgemerkt werden. Bitte Serverprotokoll und Speicherplatz prüfen.";
      console.error(`Shop-Katalog gespeichert, Audit konnte nicht vorgemerkt werden (${changes.length} Änderung(en)) für Channel ${CATALOG_AUDIT_CHANNEL_ID}:`, error.message);
    }
    send(res, 200, JSON.stringify({
      ok: true,
      products: validation.products,
      auditLogged,
      auditChangeCount,
      warning
    }), "application/json; charset=utf-8");
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
    const title = url.searchParams.get("admin") === "1" ? "Admin Panel" : "Produktionsrechner";
    send(res, 200, loginPage(url.searchParams.get("error") || "", title), "text/html; charset=utf-8");
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
  if (pathname === "/admin/catalog" || pathname === "/admin/catalog.js") {
    const adminSession = await requireCatalogAdmin(req, res, config);
    if (!adminSession) return;
    serveStatic(req, res, pathname);
    return;
  }
  if (pathname === "/admin/orders" || pathname === "/admin/orders.js") {
    const adminSession = await requireCatalogAdmin(req, res, config, "/admin/orders");
    if (!adminSession) return;
    serveStatic(req, res, pathname);
    return;
  }
  if (pathname === "/" || pathname === "/index.html" || pathname === "/ankauf.html" || pathname === "/ankauf.js" || pathname === "/material-ankauf.html" || pathname === "/material-ankauf.js" || pathname === "/stank-kauf.html" || pathname === "/stank-kauf.js" || pathname === "/freie-bestellung.html" || pathname === "/freie-bestellung.js" || pathname === "/theme.css" || pathname === "/bg.js" || pathname.startsWith("/img/")) {
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

function startDiscordWelcomeBot() {
  const config = discordConfig();
  if (!config.botToken || !/^\d{17,20}$/.test(config.guildId)) {
    console.warn("Discord-Willkommensbot nicht gestartet: Bot-Token oder Server-ID fehlt.");
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  client.once(Events.ClientReady, readyClient => {
    console.log(`Discord-Willkommensbot verbunden als ${readyClient.user.tag}.`);
  });
  client.on(Events.Error, error => {
    console.error("Discord-Willkommensbot-Verbindung fehlgeschlagen:", error.message);
  });
  client.on(Events.GuildMemberAdd, async member => {
    if (member.guild.id !== config.guildId) return;

    try {
      await member.roles.add(UNVERIFIED_ROLE_ID, "Neue Mitglieder erhalten automatisch die Unverified-Rolle.");
      const channel = await client.channels.fetch(WELCOME_CHANNEL_ID);
      if (!channel?.isTextBased() || !channel.send) {
        throw new Error("Der konfigurierte Willkommenskanal ist nicht beschreibbar.");
      }

      const attachment = new AttachmentBuilder(path.join(ROOT, "img", "willkommen.png"), { name: "willkommen.png" });
      const embed = new EmbedBuilder()
        .setColor(0x3976d2)
        .setTitle(`Willkommen auf ${member.guild.name}!`)
        .setDescription(`Hallo <@${member.id}>! Du hast automatisch die Unverified-Rolle erhalten. Bitte folge den Hinweisen auf dem Server.`)
        .setImage("attachment://willkommen.png")
        .setFooter({ text: "OLYMP • Willkommen" })
        .setTimestamp();

      await channel.send({
        embeds: [embed],
        files: [attachment],
        allowedMentions: { users: [member.id] }
      });
    } catch (error) {
      console.error(`Willkommensablauf für ${member.id} fehlgeschlagen:`, error.message);
    }
  });
  client.login(config.botToken).catch(error => {
    console.error("Discord-Willkommensbot konnte sich nicht verbinden:", error.message);
  });
}

setInterval(() => {
  void runDailyAccountingReport();
}, 60 * 1000);

server.listen(PORT, HOST, () => {
  console.log(`Olymp Rechner läuft auf http://${HOST}:${PORT}`);
  if (!configIsReady(discordConfig())) console.log("Discord OAuth ist noch nicht konfiguriert. Bitte .env ausfüllen.");
  startDiscordWelcomeBot();
  void runDailyAccountingReport();
});