"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { verifyKey } = require("discord-interactions");
const {
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder
} = require("discord.js");
const { CATEGORY_LABELS, createLedger, periodRange, shiftDateKey, summarize } = require("./ledger");
const {
  ORDER_STATUS_LABELS,
  isAdminOrderClosed,
  displayAdminOrderStatus,
  buildAdminOrderDiscordPayload,
  buildMaterialOrderPayload,
  buildStankOrderPayload,
  buildCustomOrderPayload,
  buildSellOfferPayload,
  parseButtonAction,
  phoneFromEmbed
} = require("./discord-order-ui");

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
const FAMILY_CATEGORY_NAME = "Familien";
let discordGatewayClient = null;
const ROOT = __dirname;
const LEGACY_CATALOG_FILE = path.join(ROOT, "shop-products.json");
const LEGACY_CATALOG_AUDIT_PENDING_FILE = path.join(ROOT, "shop-audit-pending.json");
const BUYBACK_PRODUCTS_FILE = path.join(ROOT, "data", "buyback-products.json");
// Set to { id, name, price } to publish the next shop bundle.
const WEEKLY_BUNDLE = null;
const SHOP_CONTENT = {
  weeklyOffers: [],
  ads: [
    {
      title: "Werbefläche im OLYMP SHOP",
      image: "/img/werbung1.png"
    }
  ]
};
const ACCOUNTING_REPORTS_FILE = path.join(ROOT, "data", "accounting-reports.json");
const ACCOUNTING_LEDGER_FILE = process.env.ACCOUNTING_LEDGER_FILE
  ? (path.isAbsolute(process.env.ACCOUNTING_LEDGER_FILE)
    ? process.env.ACCOUNTING_LEDGER_FILE
    : path.resolve(ROOT, process.env.ACCOUNTING_LEDGER_FILE))
  : path.join(ROOT, "data", "accounting-ledger.json");
const accountingLedger = createLedger(ACCOUNTING_LEDGER_FILE);

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
let adminOrdersCache = null;
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
  ["/admin/buyback", "buyback-admin.html"],
  ["/admin/buyback.js", "buyback-admin.js"],
  ["/admin/nav.css", "admin-nav.css"],
  ["/admin/nav.js", "admin-nav.js"],
  ["/admin/orders", "orders-admin.html"],
  ["/admin/orders.js", "orders-admin.js"],
  ["/admin/accounting", "accounting-admin.html"],
  ["/admin/accounting.js", "accounting-admin.js"],
  ["/produktions-rechner.html", "produktions-rechner.html"],
  ["/script.js", "script.js"],
  ["/style.css", "style.css"],
  ["/theme.css", "theme.css"],
  ["/shop.css", "shop.css"],
  ["/forms.css", "forms.css"],
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

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
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
  const adminPath = ["/admin/catalog", "/admin/orders", "/admin/accounting"].includes(redirectPath) ? redirectPath : "/admin/catalog";
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
    const isAdmin = ["/admin/catalog", "/admin/orders", "/admin/accounting"].includes(requestedDestination);
    send(res, 503, loginPage("setup", isAdmin ? "Admin Panel" : "Produktionsrechner", requestedDestination || "/admin/catalog"), "text/html; charset=utf-8");
    return;
  }
  pruneState();
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const loginUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const requestedDestination = loginUrl.searchParams.get("next");
  const redirectPath = ["/admin/catalog", "/admin/orders", "/admin/accounting"].includes(requestedDestination) ? requestedDestination : "";
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

function readAdminOrders() {
  if (adminOrdersCache) return adminOrdersCache;
  const orders = JSON.parse(fs.readFileSync(ADMIN_ORDERS_FILE, "utf8"));
  if (!Array.isArray(orders)) throw new Error("Admin-Bestelldatei enthält keine Bestellliste.");
  for (const order of orders) {
    if (!order.type && Number.isFinite(order.technical) && Number.isFinite(order.medical)) {
      order.type = "material";
    }
  }
  adminOrdersCache = orders;
  return orders;
}

function writeAdminOrders(orders) {
  adminOrdersCache = orders;
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
  if (Object.hasOwn(updates, "status")) {
    try {
      accountingLedger.syncOrder(orders[index]);
    } catch (error) {
      console.error("Hauptbuch konnte nicht mit der Bestelländerung synchronisiert werden:", error.message);
      const syncError = new Error("Bestellstatus wurde gespeichert, aber die Buchhaltung konnte nicht synchronisiert werden.");
      syncError.code = "ACCOUNTING_SYNC_FAILED";
      syncError.cause = error;
      throw syncError;
    }
  }
  return orders[index];
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

function readAccountingReports() {
  if (!fs.existsSync(ACCOUNTING_REPORTS_FILE)) {
    const initial = { startedOn: accountingDateKey(), sentDates: [], sentWeeks: [], sentMonths: [] };
    writeAccountingJson(ACCOUNTING_REPORTS_FILE, initial);
    return initial;
  }
  const state = JSON.parse(fs.readFileSync(ACCOUNTING_REPORTS_FILE, "utf8"));
  if (!state || !/^\d{4}-\d{2}-\d{2}$/.test(state.startedOn) || !Array.isArray(state.sentDates)) {
    throw new Error("Buchhaltungsstatus ist ungültig.");
  }
  if (!Array.isArray(state.sentWeeks)) state.sentWeeks = [];
  if (!Array.isArray(state.sentMonths)) state.sentMonths = [];
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

function accountingWeekStart(date) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  return shiftDateKey(date, 1 - weekday);
}

function accountingMonthStart(date) {
  return `${date.slice(0, 7)}-01`;
}

function accountingMonthEnd(monthStart) {
  return shiftDateKey(shiftDateKey(monthStart, 32).slice(0, 7) + "-01", -1);
}

function accountingDateLabel(date) {
  return date.split("-").reverse().join(".");
}

async function sendAccountingReport(title, range, entries) {
  const summary = summarize(entries, range);
  const embed = {
    title,
    description: `**Einnahmen: ${summary.income.toLocaleString("de-DE")} $**\n**Ausgaben: ${summary.expense.toLocaleString("de-DE")} $**\n**Saldo: ${summary.net.toLocaleString("de-DE")} $**\n${summary.count} Buchungen`,
    color: 0x3978d4,
    fields: Object.entries(summary.categories).map(([category, totals]) => ({
      name: CATEGORY_LABELS[category] || category,
      value: `+${totals.income.toLocaleString("de-DE")} $ / −${totals.expense.toLocaleString("de-DE")} $ · ${totals.count} Buchungen`,
      inline: true
    })),
    footer: { text: "Abgelehnte und offene Bestellungen sind nicht gebucht." },
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
    const today = accountingDateKey();
    const latestClosedDate = previousAccountingDate(today);
    if (state.startedOn > latestClosedDate) return;
    let reportDate = state.startedOn;
    while (reportDate <= latestClosedDate && state.sentDates.includes(reportDate)) {
      reportDate = nextAccountingDate(reportDate);
    }
    if (reportDate <= latestClosedDate) {
      await sendAccountingReport(
        `Tagesbuchhaltung · ${accountingDateLabel(reportDate)}`,
        { from: reportDate, to: reportDate },
        accountingLedger.read()
      );
      state.sentDates.push(reportDate);
      writeAccountingJson(ACCOUNTING_REPORTS_FILE, state);
      lastAccountingReportError = "";
      console.log(`Buchhaltungsbericht für ${reportDate} in Discord veröffentlicht.`);
      return;
    }

    const latestClosedWeek = shiftDateKey(accountingWeekStart(today), -7);
    let weekStart = accountingWeekStart(state.startedOn);
    while (weekStart <= latestClosedWeek && state.sentWeeks.includes(weekStart)) {
      weekStart = shiftDateKey(weekStart, 7);
    }
    if (weekStart <= latestClosedWeek) {
      const weekEnd = shiftDateKey(weekStart, 6);
      const from = state.startedOn > weekStart ? state.startedOn : weekStart;
      await sendAccountingReport(
        `Wochenbuchhaltung · ${accountingDateLabel(from)}–${accountingDateLabel(weekEnd)}`,
        { from, to: weekEnd },
        accountingLedger.read()
      );
      state.sentWeeks.push(weekStart);
      writeAccountingJson(ACCOUNTING_REPORTS_FILE, state);
      lastAccountingReportError = "";
      console.log(`Wochenbuchhaltungsbericht ab ${weekStart} in Discord veröffentlicht.`);
      return;
    }

    const latestClosedMonth = previousAccountingDate(accountingMonthStart(today));
    const latestClosedMonthStart = accountingMonthStart(latestClosedMonth);
    let monthStart = accountingMonthStart(state.startedOn);
    while (monthStart <= latestClosedMonthStart && state.sentMonths.includes(monthStart)) {
      monthStart = accountingMonthStart(shiftDateKey(monthStart, 32));
    }
    if (monthStart > latestClosedMonthStart) return;
    const monthEnd = accountingMonthEnd(monthStart);
    const from = state.startedOn > monthStart ? state.startedOn : monthStart;
    const monthLabel = new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      month: "long",
      year: "numeric"
    }).format(new Date(`${monthStart}T12:00:00Z`));
    await sendAccountingReport(
      `Monatsbuchhaltung · ${monthLabel}`,
      { from, to: monthEnd },
      accountingLedger.read()
    );
    state.sentMonths.push(monthStart);
    writeAccountingJson(ACCOUNTING_REPORTS_FILE, state);
    lastAccountingReportError = "";
    console.log(`Monatsbuchhaltungsbericht ${monthStart} in Discord veröffentlicht.`);
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
    available: Boolean(available),
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

function saveBuybackProducts(products) {
  const temporaryFile = `${BUYBACK_PRODUCTS_FILE}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(products, null, 2), { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporaryFile, BUYBACK_PRODUCTS_FILE);
}

function validateBuybackProducts(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    return { error: "Die Ankaufspreisliste muss zwischen 1 und 100 Produkte enthalten." };
  }
  const products = [];
  const ids = new Set();
  for (const entry of value) {
    const name = String(entry?.name || "").trim();
    const price = Number(entry?.price);
    let id = String(entry?.id || "").trim();
    if (!name || name.length > 80 || !Number.isSafeInteger(price) || price < 1 || price > 1000000000) {
      return { error: "Produktdaten ungültig: Name und Preis prüfen." };
    }
    if (!id) {
      const base = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "produkt";
      id = base;
      let suffix = 2;
      while (ids.has(id)) id = `${base}-${suffix++}`;
    }
    if (!/^[a-z0-9-]{1,80}$/.test(id) || ids.has(id)) {
      return { error: "Produktdaten ungültig: Produktnamen dürfen nicht doppelt sein." };
    }
    ids.add(id);
    products.push({ id, name, price });
  }
  return { products };
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
      available,
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

function recoverAdminOrderFromDiscordMessage(orderId, payload) {
  const message = payload.message;
  const embed = message?.embeds?.[0];
  const footer = String(embed?.footer?.text || "");
  const type = footer.includes("Material-Ankauf")
    ? "material"
    : footer.includes("Ankauf")
      ? "sell-offer"
      : footer.includes("Wunsch-Bestellung")
      ? "custom"
      : footer.includes("STANK-Kauf")
        ? "stank"
        : "";
  const channelIds = [ORDER_CHANNEL_ID, STANK_ORDER_CHANNEL_ID, CUSTOM_ORDER_CHANNEL_ID, SELL_OFFER_CHANNEL_ID];
  if (!type || !channelIds.includes(String(payload.channel_id || "")) || !Array.isArray(embed.fields)) return null;

  const fields = new Map(embed.fields.map(field => [String(field.name || ""), String(field.value || "").replace(/\*\*/g, "")]));
  const parseAmount = value => {
    const amount = Number(String(value || "").replace(/[^\d-]/g, ""));
    return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
  };
  const createdAt = typeof embed.timestamp === "string" && !Number.isNaN(Date.parse(embed.timestamp))
    ? embed.timestamp
    : new Date().toISOString();
  const statusValue = String(fields.get("Status") || "Neu").replace(" · Abgeschlossen", "").trim();
  return {
    id: orderId,
    type,
    status: statusValue || "Neu",
    icName: fields.get("Kunde") || fields.get("IC-Name") || "Unbekannt",
    phone: phoneFromEmbed(embed) || fields.get("Telefon") || fields.get("Handynummer") || fields.get("Handynummer / IC") || fields.get("Telefonnummer") || "",
    totalPrice: parseAmount(fields.get("Gesamtsumme") || fields.get("Gesamtpreis")),
    technical: parseAmount(fields.get("Technik") || fields.get("Technische Materialien")),
    medical: parseAmount(fields.get("Medizin") || fields.get("Medizinische Materialien")),
    totalMaterials: parseAmount(fields.get("Stück") || fields.get("Gesamtanzahl")),
    quantity: parseAmount(fields.get("Pflanzen") || fields.get("STANK-Pflanzen")),
    items: [],
    discordDescription: String(embed.description || ""),
    createdAt,
    deliveryStatus: "bot",
    discordChannelId: String(payload.channel_id),
    discordMessageId: String(message.id),
    recoveredFromDiscord: true
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

function memberCanManageOrders(guildId, roleIds, config) {
  return guildId === config.guildId
    && /^\d{17,20}$/.test(config.catalogAdminRoleId)
    && Array.isArray(roleIds)
    && roleIds.includes(config.catalogAdminRoleId);
}

function actorNameFromMember(member) {
  return String(member?.user?.global_name || member?.nick || member?.user?.username || "Discord-Admin").slice(0, 80);
}

function findOrderForButton(orderId, messageId) {
  const orders = readAdminOrders();
  let order = orders.find(entry => entry.id === orderId && entry.discordMessageId === messageId)
    || orders.find(entry => entry.id === orderId)
    || orders.find(entry => entry.discordMessageId === messageId);
  if (order && order.id !== orderId) {
    console.warn(`Discord-Bestellbutton ${orderId} wurde über Nachrichten-ID ${messageId} zugeordnet.`);
  }
  return { orders, order };
}

function applyDiscordOrderStatus(orderId, statusKey, actorName, messageId, payload) {
  const { orders, order: existing } = findOrderForButton(orderId, messageId);
  let order = existing;
  if (!order) {
    order = recoverAdminOrderFromDiscordMessage(orderId, payload);
    if (order) {
      orders.push(order);
      writeAdminOrders(orders);
      console.warn(`Bestellung ${orderId} wurde aus der Discord-Nachricht wiederhergestellt.`);
    }
  }
  if (!order) {
    const error = new Error("order-not-found");
    error.code = "NOT_FOUND";
    throw error;
  }
  if (isAdminOrderClosed(order)) return order;

  const updated = updateAdminOrder(order.id, {
    status: ORDER_STATUS_LABELS[statusKey],
    updatedAt: new Date().toISOString(),
    updatedBy: actorName
  });
  if (!updated) {
    const error = new Error("order-not-found");
    error.code = "NOT_FOUND";
    throw error;
  }
  return updated;
}

function contactReply(orderId, embed) {
  let phone = phoneFromEmbed(embed);
  if (!phone && orderId) {
    try {
      const order = readAdminOrders().find(entry => entry.id === orderId);
      phone = String(order?.phone || "").trim();
    } catch (error) {
      console.error("Telefonnummer konnte nicht gelesen werden:", error.message);
    }
  }
  return phone
    ? `📞 Kontakt: ${phone}`
    : "Für diese Bestellung ist keine Telefonnummer hinterlegt.";
}

async function editOriginalInteraction(payload, data) {
  const applicationId = payload.application_id;
  const token = payload.token;
  if (!applicationId || !token) throw new Error("Interaction-Token fehlt.");
  const response = await discordFetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }
  );
  if (!response.ok) {
    const body = parseJson(await response.text());
    throw new Error(body?.message || `Discord-Update fehlgeschlagen (${response.status}).`);
  }
}

async function followupInteraction(payload, content) {
  const applicationId = payload.application_id;
  const token = payload.token;
  if (!applicationId || !token) return;
  try {
    await discordFetch(
      `https://discord.com/api/v10/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, flags: 64, allowed_mentions: { parse: [] } })
      }
    );
  } catch (error) {
    console.error("Discord-Followup fehlgeschlagen:", error.message);
  }
}

function interactionMessageData(order) {
  const message = buildAdminOrderDiscordPayload(order);
  return {
    content: message.content,
    embeds: message.embeds,
    components: message.components,
    allowed_mentions: message.allowed_mentions
  };
}

async function handleNewFamilyInteraction(interaction) {
  const config = discordConfig();
  if (!interaction.inGuild() || interaction.guildId !== config.guildId) {
    await interaction.reply({
      content: "Dieser Befehl kann nur auf dem konfigurierten Discord-Server verwendet werden.",
      ephemeral: true
    });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "Nur Server-Admins dürfen Familienkanäle erstellen.",
      ephemeral: true
    });
    return;
  }

  const familyName = interaction.options.getString("name", true).trim();
  if (!familySlug(familyName)) {
    await interaction.reply({
      content: "Bitte gib einen gültigen Familiennamen ein.",
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const result = await createFamily(interaction.guild, interaction.user.id, familyName);
  await interaction.editReply({ content: familyCreatedMessage(familyName, result) });
}

function familySlug(familyName) {
  return String(familyName || "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 100);
}

function familyCreatedMessage(familyName, result) {
  return `Familie **${familyName}** wurde eingerichtet: <#${result.channelId}>. Die Rolle <@&${result.roleId}> wurde dir zugewiesen.`;
}

async function createFamily(guild, userId, familyName) {
  const channelName = familySlug(familyName);
  const botMember = await guild.members.fetchMe();
  const requiredPermissions = [
    [PermissionFlagsBits.ManageChannels, "Kanäle verwalten"],
    [PermissionFlagsBits.ManageRoles, "Rollen verwalten"]
  ];
  const missingPermissions = requiredPermissions
    .filter(([permission]) => !botMember.permissions.has(permission))
    .map(([, label]) => label);
  if (missingPermissions.length) {
    throw new Error(`Dem Bot fehlen die Serverberechtigungen: ${missingPermissions.join(" und ")}.`);
  }

  const [channels, roles] = await Promise.all([
    guild.channels.fetch(),
    guild.roles.fetch()
  ]);
  const categories = channels.filter(channel =>
    channel?.type === ChannelType.GuildCategory
    && channel.name.toLowerCase() === FAMILY_CATEGORY_NAME.toLowerCase()
  );
  if (categories.size > 1) {
    throw new Error(`Es gibt mehrere Kategorien namens „${FAMILY_CATEGORY_NAME}“. Bitte bereinige die doppelten Kategorien zuerst.`);
  }

  const category = categories.first() || null;
  const existingRole = roles.find(role => role.name.toLowerCase() === familyName.toLowerCase());
  const existingChannel = category
    ? channels.find(channel =>
      channel?.type === ChannelType.GuildText
      && channel.parentId === category.id
      && channel.name === channelName
    )
    : null;
  if (existingRole || existingChannel) {
    const conflicts = [
      existingRole && "eine gleichnamige Rolle",
      existingChannel && "einen gleichnamigen Kanal"
    ].filter(Boolean);
    throw new Error(`Die Familie wurde nicht erstellt: Es gibt bereits ${conflicts.join(" und ")}.`);
  }

  let createdRole;
  let createdChannel;
  try {
    const familyCategory = category || await guild.channels.create({
      name: FAMILY_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      reason: "Kategorie für Familienkanäle"
    });
    createdRole = await guild.roles.create({
      name: familyName,
      mentionable: false,
      hoist: false,
      reason: `Familienrolle für ${familyName}`
    });
    createdChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: familyCategory.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: createdRole.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory
          ]
        },
        {
          id: botMember.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels
          ]
        }
      ],
      reason: `Privater Familienkanal für ${familyName}`
    });
    const member = await guild.members.fetch(userId);
    await member.roles.add(createdRole, `Familienrolle für ${familyName} zugewiesen`);
  } catch (error) {
    if (createdChannel) {
      try {
        await createdChannel.delete("Unvollständige Einrichtung des Familienkanals aufräumen");
      } catch (cleanupError) {
        console.error(`Unvollständiger Familienkanal ${createdChannel.id} konnte nicht entfernt werden:`, cleanupError.message);
      }
    }
    if (createdRole) {
      try {
        await createdRole.delete("Unvollständige Einrichtung der Familienrolle aufräumen");
      } catch (cleanupError) {
        console.error(`Unvollständige Familienrolle ${createdRole.id} konnte nicht entfernt werden:`, cleanupError.message);
      }
    }
    throw error;
  }

  return { channelId: createdChannel.id, roleId: createdRole.id };
}

async function handleHttpNewFamily(payload, config) {
  const isAdmin = (BigInt(payload.member?.permissions || "0") & PermissionFlagsBits.Administrator) !== 0n;
  const familyName = String(payload.data?.options?.find(option => option.name === "name")?.value || "").trim();
  if (payload.guild_id !== config.guildId || !isAdmin) {
    return "Nur Server-Admins dürfen Familienkanäle erstellen.";
  }
  if (!familySlug(familyName)) return "Bitte gib einen gültigen Familiennamen ein.";
  if (!discordGatewayClient?.isReady()) return "Der Bot ist noch nicht verbunden. Bitte in Kürze erneut versuchen.";
  const guild = await discordGatewayClient.guilds.fetch(config.guildId);
  const result = await createFamily(guild, payload.member.user.id, familyName);
  return familyCreatedMessage(familyName, result);
}

function addManualAccountingEntry(guildId, roleIds, kind, amount, description, bookedBy, sourceId) {
  const config = discordConfig();
  if (!memberCanManageOrders(guildId, roleIds, config)) {
    throw new Error("Nur Mitglieder mit der Katalog-Admin-Rolle dürfen Buchungen erfassen.");
  }
  if (kind !== "income" && kind !== "expense") {
    throw new Error("Buchungsart muss Einnahme oder Ausgabe sein.");
  }
  const entry = accountingLedger.add({
    kind,
    category: "manual",
    amount,
    description,
    source: "manual",
    bookedBy,
    sourceId
  });
  const summary = summarize(accountingLedger.read());
  const label = kind === "income" ? "Einnahme" : "Ausgabe";
  return {
    entry,
    content: `${label} über ${amount.toLocaleString("de-DE")} $ gebucht. Aktueller Saldo: ${summary.net.toLocaleString("de-DE")} $.\nBuchungs-ID: \`${entry.id}\``
  };
}

function accountingCashMessage(period) {
  if (!["heute", "woche", "monat", "gesamt"].includes(period)) {
    throw new Error("Bitte einen gültigen Zeitraum auswählen.");
  }
  const range = periodRange(period, accountingDateKey());
  const entries = accountingLedger.read();
  const summary = summarize(entries, range);
  const lines = [
    `**Kasse · ${range.label}**`,
    `Einnahmen: **${summary.income.toLocaleString("de-DE")} $**`,
    `Ausgaben: **${summary.expense.toLocaleString("de-DE")} $**`,
    `Saldo: **${summary.net.toLocaleString("de-DE")} $**`,
    `${summary.count} aktive Buchung(en)`
  ];
  if (range.from) lines.push(`Zeitraum: ${accountingDateLabel(range.from)}${range.to !== range.from ? `–${accountingDateLabel(range.to)}` : ""}`);
  return lines.join("\n");
}

function correctManualAccountingEntry(guildId, roleIds, id, reason, replacement, bookedBy) {
  const config = discordConfig();
  if (!memberCanManageOrders(guildId, roleIds, config)) {
    throw new Error("Nur Mitglieder mit der Katalog-Admin-Rolle dürfen Buchungen korrigieren oder stornieren.");
  }
  let result;
  try {
    result = accountingLedger.correctEntry(id, { by: bookedBy, reason, replacement });
  } catch (error) {
    if (error.code && !["NOT_FOUND", "ALREADY_VOIDED"].includes(error.code)) {
      console.error("Buchungskorrektur konnte nicht gespeichert werden:", error.message);
      throw new Error("Die Änderung konnte nicht dauerhaft gespeichert werden. Bitte Admin informieren.");
    }
    throw error;
  }
  return result.corrected
    ? `Buchung korrigiert und nachvollziehbar protokolliert. Neue Buchungs-ID: \`${result.corrected.id}\``
    : `Buchung \`${id}\` wurde mit Grund „${reason.trim()}“ storniert.`;
}

function accountingOptions(payload) {
  return Object.fromEntries((payload.data?.options || []).map(option => [option.name, option.value]));
}

async function handleManualBookingInteraction(interaction) {
  const config = discordConfig();
  const roleIds = interaction.member?.roles?.cache
    ? [...interaction.member.roles.cache.keys()]
    : [];
  if (!memberCanManageOrders(interaction.guildId, roleIds, config)) {
    await interaction.reply({
      content: "Nur Mitglieder mit der Katalog-Admin-Rolle dürfen Buchungen erfassen.",
      ephemeral: true
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const result = addManualAccountingEntry(
    interaction.guildId,
    roleIds,
    interaction.options.getString("art", true),
    interaction.options.getInteger("betrag", true),
    interaction.options.getString("beschreibung", true),
    actorNameFromMember(interaction.member),
    interaction.id
  );
  await interaction.editReply({ content: result.content });
}

async function handleCashInteraction(interaction) {
  const config = discordConfig();
  const roleIds = interaction.member?.roles?.cache
    ? [...interaction.member.roles.cache.keys()]
    : [];
  if (!memberCanManageOrders(interaction.guildId, roleIds, config)) {
    await interaction.reply({
      content: "Nur Mitglieder mit der Katalog-Admin-Rolle dürfen die Kasse einsehen.",
      ephemeral: true
    });
    return;
  }
  const period = interaction.options.getString("zeitraum", true);
  await interaction.reply({ content: accountingCashMessage(period), ephemeral: true });
}

async function handleVoidInteraction(interaction) {
  const roleIds = interaction.member?.roles?.cache
    ? [...interaction.member.roles.cache.keys()]
    : [];
  const id = interaction.options.getString("buchung_id", true).trim();
  const reason = interaction.options.getString("grund", true);
  const amount = interaction.options.getInteger("neuer_betrag");
  const description = interaction.options.getString("neue_beschreibung");
  const kind = interaction.options.getString("neue_art");
  const hasReplacement = amount !== null || description !== null || kind !== null;
  const replacement = hasReplacement ? { amount, description, kind: kind || undefined } : null;
  if (hasReplacement && (!Number.isSafeInteger(amount) || typeof description !== "string" || !description.trim())) {
    await interaction.reply({
      content: "Für eine Korrektur müssen neuer Betrag und neue Beschreibung zusammen angegeben werden.",
      ephemeral: true
    });
    return;
  }
  const content = correctManualAccountingEntry(
    interaction.guildId,
    roleIds,
    id,
    reason,
    replacement,
    actorNameFromMember(interaction.member)
  );
  await interaction.reply({ content, ephemeral: true });
}

async function handleHttpManualBooking(payload) {
  const roleIds = Array.isArray(payload.member?.roles) ? payload.member.roles : [];
  const options = accountingOptions(payload);
  const result = addManualAccountingEntry(
    payload.guild_id,
    roleIds,
    options.art,
    options.betrag,
    options.beschreibung,
    actorNameFromMember(payload.member),
    payload.id
  );
  return result.content;
}

async function handleHttpCash(payload, config) {
  const roleIds = Array.isArray(payload.member?.roles) ? payload.member.roles : [];
  if (!memberCanManageOrders(payload.guild_id, roleIds, config)) {
    throw new Error("Nur Mitglieder mit der Katalog-Admin-Rolle dürfen die Kasse einsehen.");
  }
  const options = accountingOptions(payload);
  return accountingCashMessage(options.zeitraum);
}

async function handleHttpVoid(payload) {
  const roleIds = Array.isArray(payload.member?.roles) ? payload.member.roles : [];
  const options = accountingOptions(payload);
  const hasReplacement = options.neuer_betrag !== undefined
    || options.neue_beschreibung !== undefined
    || options.neue_art !== undefined;
  if (hasReplacement && (!Number.isSafeInteger(options.neuer_betrag)
    || typeof options.neue_beschreibung !== "string" || !options.neue_beschreibung.trim())) {
    throw new Error("Für eine Korrektur müssen neuer Betrag und neue Beschreibung zusammen angegeben werden.");
  }
  return correctManualAccountingEntry(
    payload.guild_id,
    roleIds,
    String(options.buchung_id || "").trim(),
    options.grund,
    hasReplacement
      ? { amount: options.neuer_betrag, description: options.neue_beschreibung, kind: options.neue_art }
      : null,
    actorNameFromMember(payload.member)
  );
}

async function registerNewFamilyCommand(client, guildId) {
  const familyCommand = new SlashCommandBuilder()
    .setName("newfam")
    .setDescription("Erstellt einen privaten Familienkanal mit passender Rolle.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option =>
      option
        .setName("name")
        .setDescription("Name der Familie")
        .setRequired(true)
        .setMaxLength(100)
    )
    .toJSON();
  const commands = await client.application.commands.fetch({ guildId });
  const manualBookingCommand = new SlashCommandBuilder()
    .setName("buchung")
    .setDescription("Erfasst eine Einnahme oder Ausgabe in der Buchhaltung.")
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("art")
      .setDescription("Einnahme oder Ausgabe")
      .setRequired(true)
      .addChoices(
        { name: "Einnahme", value: "income" },
        { name: "Ausgabe", value: "expense" }
      ))
    .addIntegerOption(option => option
      .setName("betrag")
      .setDescription("Betrag in Dollar, ohne Cent")
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(1_000_000_000))
    .addStringOption(option => option
      .setName("beschreibung")
      .setDescription("Wofür ist die Buchung?")
      .setRequired(true)
      .setMaxLength(100))
    .toJSON();

  const cashCommand = new SlashCommandBuilder()
    .setName("kasse")
    .setDescription("Zeigt Einnahmen, Ausgaben und Saldo der Buchhaltung.")
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("zeitraum")
      .setDescription("Zeitraum für den Kassenstand")
      .setRequired(true)
      .addChoices(
        { name: "Heute", value: "heute" },
        { name: "Diese Woche", value: "woche" },
        { name: "Dieser Monat", value: "monat" },
        { name: "Gesamt", value: "gesamt" }
      ))
    .toJSON();
  const voidCommand = new SlashCommandBuilder()
    .setName("storno")
    .setDescription("Storniert oder korrigiert eine Buchung mit Begründung.")
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("buchung_id")
      .setDescription("ID aus der Buchungsbestätigung oder Admin-Buchhaltung")
      .setRequired(true)
      .setMaxLength(36))
    .addStringOption(option => option
      .setName("grund")
      .setDescription("Warum wird storniert oder korrigiert?")
      .setRequired(true)
      .setMinLength(3)
      .setMaxLength(200))
    .addIntegerOption(option => option
      .setName("neuer_betrag")
      .setDescription("Neuer Betrag bei einer Korrektur")
      .setMinValue(1)
      .setMaxValue(1_000_000_000))
    .addStringOption(option => option
      .setName("neue_beschreibung")
      .setDescription("Neue Beschreibung bei einer Korrektur")
      .setMaxLength(100))
    .addStringOption(option => option
      .setName("neue_art")
      .setDescription("Neue Buchungsart bei einer Korrektur")
      .addChoices(
        { name: "Einnahme", value: "income" },
        { name: "Ausgabe", value: "expense" }
      ))
    .toJSON();

  for (const command of [familyCommand, manualBookingCommand, cashCommand, voidCommand]) {
    const existingCommand = commands.find(existing => existing.name === command.name);
    if (existingCommand) {
      await existingCommand.edit(command);
    } else {
      await client.application.commands.create(command, guildId);
    }
  }
}

async function finishStatusButton(payload, orderId, statusKey, actorName) {
  try {
    const order = applyDiscordOrderStatus(orderId, statusKey, actorName, String(payload.message?.id || ""), payload);
    await editOriginalInteraction(payload, interactionMessageData(order));
  } catch (error) {
    if (error.code === "NOT_FOUND") {
      console.warn(`Discord-Bestellbutton ${orderId} konnte keiner gespeicherten Bestellung zugeordnet werden.`);
      await followupInteraction(payload, "Diese Bestellnachricht ist nicht mehr verfügbar.");
      return;
    }
    console.error("Discord-Bestellnachricht und/oder Buchhaltung konnten nicht aktualisiert werden:", error.message);
    await followupInteraction(payload, error.code === "ACCOUNTING_SYNC_FAILED"
      ? error.message
      : "Der Bestellstatus konnte nicht gespeichert werden. Bitte Admin informieren.");
  }
}

async function handleDiscordInteraction(req, res) {
  const config = discordConfig();
  if (!config.publicKey) {
    sendJson(res, 503, { error: "Discord interaction endpoint not configured." });
    return;
  }

  let rawBody = "";
  try {
    rawBody = await readRequestBody(req, 256 * 1024);
  } catch {
    sendJson(res, 413, { error: "Payload too large" });
    return;
  }

  let payload = {};
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch {
    sendJson(res, 400, { error: "Invalid interaction payload" });
    return;
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const verifyRequest = () => verifyDiscordInteraction(
    rawBody,
    String(signature || ""),
    String(timestamp || ""),
    config.publicKey
  );

  // Statusbuttons sofort quittieren. Discord gibt dafür nur wenige Sekunden;
  // Signaturprüfung und Dateiverarbeitung dürfen die erste Antwort nicht verzögern.
  if (payload.type === 3 && payload.data?.component_type === 2) {
    const action = parseButtonAction(payload.data.custom_id);
    if (action.kind === "status" && memberCanManageOrders(payload.guild_id, payload.member?.roles, config)) {
      sendJson(res, 200, { type: 6 });
      void (async () => {
        if (!await verifyRequest()) {
          console.error("Discord-Interaction mit ungültiger Signatur verworfen.");
          return;
        }
        await finishStatusButton(payload, action.orderId, action.statusKey, actorNameFromMember(payload.member));
      })().catch(error => console.error("Discord-Statusverarbeitung fehlgeschlagen:", error.message));
      return;
    }
  }

  if (!await verifyRequest()) {
    sendJson(res, 401, { error: "Invalid request signature" });
    return;
  }

  if (payload.type === 1) {
    sendJson(res, 200, { type: 1 });
    return;
  }

  if (payload.type === 2 && payload.data?.name === "newfam") {
    sendJson(res, 200, { type: 5, data: { flags: 64 } });
    void handleHttpNewFamily(payload, config)
      .catch(error => {
        console.error("Discord-Slash-Command fehlgeschlagen:", error.message);
        return `Die Familieneinrichtung ist fehlgeschlagen: ${error.message}`;
      })
      .then(content => editOriginalInteraction(payload, { content, allowed_mentions: { parse: [] } }))
      .catch(error => console.error("Discord-Antwort auf /newfam fehlgeschlagen:", error.message));
    return;
  }

  if (payload.type === 2 && payload.data?.name === "buchung") {
    sendJson(res, 200, { type: 5, data: { flags: 64 } });
    void Promise.resolve()
      .then(() => handleHttpManualBooking(payload))
      .catch(error => {
        console.error("Discord-Buchung fehlgeschlagen:", error.message);
        return `Buchung fehlgeschlagen: ${error.message}`;
      })
      .then(content => editOriginalInteraction(payload, { content, allowed_mentions: { parse: [] } }))
      .catch(error => console.error("Discord-Antwort auf /buchung fehlgeschlagen:", error.message));
    return;
  }

  if (payload.type === 2 && ["kasse", "storno"].includes(payload.data?.name)) {
    sendJson(res, 200, { type: 5, data: { flags: 64 } });
    const handler = payload.data.name === "kasse"
      ? handleHttpCash(payload, config)
      : handleHttpVoid(payload);
    void Promise.resolve(handler)
      .catch(error => {
        console.error(`Discord-Slash-Command /${payload.data.name} fehlgeschlagen:`, error.message);
        return `/${payload.data.name} fehlgeschlagen: ${error.message}`;
      })
      .then(content => editOriginalInteraction(payload, { content, allowed_mentions: { parse: [] } }))
      .catch(error => console.error(`Discord-Antwort auf /${payload.data.name} fehlgeschlagen:`, error.message));
    return;
  }

  if (payload.type === 3 && payload.data?.component_type === 2) {
    const action = parseButtonAction(payload.data.custom_id);
    if (action.kind === "status") {
      if (!memberCanManageOrders(payload.guild_id, payload.member?.roles, config)) {
        sendJson(res, 200, {
          type: 4,
          data: { content: "Du hast keine Berechtigung, den Bestellstatus zu ändern.", flags: 64 }
        });
        return;
      }
      // Der autorisierte Statusbutton wurde im schnellen Pfad oben verarbeitet.
      sendJson(res, 500, { error: "Status-Interaction konnte nicht bestätigt werden." });
      return;
    }

    if (action.kind === "contact") {
      sendJson(res, 200, {
        type: 4,
        data: { content: contactReply(action.orderId, payload.message?.embeds?.[0]), flags: 64 }
      });
      return;
    }

    sendJson(res, 200, {
      type: 4,
      data: { content: "Unbekannte Bestellaktion.", flags: 64 }
    });
    return;
  }

  sendJson(res, 200, { type: 4, data: { content: "Interaction verarbeitet.", flags: 64 } });
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

async function handleGatewayOrderInteraction(interaction) {
  if (!interaction.isButton()) return;

  const action = parseButtonAction(interaction.customId);
  if (action.kind === "unknown") return;

  const config = discordConfig();
  const roleIds = interaction.member?.roles?.cache
    ? [...interaction.member.roles.cache.keys()]
    : [];
  if (!memberCanManageOrders(interaction.guildId, roleIds, config)) {
    await interaction.reply({
      content: "Du hast keine Berechtigung, den Bestellstatus zu ändern.",
      ephemeral: true
    });
    return;
  }

  if (action.kind === "contact") {
    await interaction.reply({
      content: contactReply(action.orderId, interaction.message?.embeds?.[0]),
      ephemeral: true
    });
    return;
  }

  // Discord erwartet die erste Antwort innerhalb weniger Sekunden. Das sofortige
  // deferUpdate verhindert den „hat nicht rechtzeitig reagiert“-Fehler, während
  // Datei- und Discord-Updates im Hintergrund verarbeitet werden.
  await interaction.deferUpdate();
  try {
    const payload = {
      message: interaction.message,
      channel_id: interaction.channelId
    };
    const order = applyDiscordOrderStatus(
      action.orderId,
      action.statusKey,
      actorNameFromMember(interaction.member),
      String(interaction.message?.id || ""),
      payload
    );
    await interaction.editReply(interactionMessageData(order));
  } catch (error) {
    console.error("Discord-Button-Interaktion konnte nicht verarbeitet werden:", error.message);
    try {
      await interaction.followUp({
        content: error.code === "NOT_FOUND"
          ? "Diese Bestellnachricht ist nicht mehr verfügbar."
          : error.code === "ACCOUNTING_SYNC_FAILED"
            ? error.message
          : "Der Bestellstatus konnte nicht gespeichert werden. Bitte Admin informieren.",
        ephemeral: true
      });
    } catch (followupError) {
      console.error("Discord-Fehlernachricht konnte nicht gesendet werden:", followupError.message);
    }
  }
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
    type: "material",
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

  const sellOffer = {
    type: "sell-offer",
    items,
    icName,
    phone,
    totalPrice,
    status: "Neu",
    createdAt: new Date().toISOString()
  };
  Object.assign(sellOffer, trackAdminOrder(sellOffer));
  const discordPayload = buildSellOfferPayload(sellOffer);

  try {
    const result = await postToDiscordChannel(discordPayload, SELL_OFFER_CHANNEL_ID, false);
    if (result.method === "local-only") {
      recordOrderDelivery(sellOffer, "local-only");
      saveOrderLocally(sellOffer, "ankauf-angebote.json");
      send(res, 200, JSON.stringify({
        ok: true,
        savedLocally: true,
        message: "Angebot lokal gespeichert. Die Discord-Konfiguration fehlt noch."
      }), "application/json; charset=utf-8");
      return;
    }
    recordOrderDelivery(sellOffer, result.method, result);

    send(res, 200, JSON.stringify({
      ok: true,
      savedLocally: false,
      message: "Dein Ankauf-Angebot wurde erfolgreich gesendet."
    }), "application/json; charset=utf-8");
  } catch (error) {
    console.error("Ankauf-Angebot konnte nicht an Discord gesendet werden:", error.message);
    recordOrderDelivery(sellOffer, "failed", {}, error.message || String(error));
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
      if (!WEEKLY_BUNDLE || entry?.weeklyOfferId !== WEEKLY_BUNDLE.id) {
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

    let existing;
    try {
      existing = readAdminOrders().find(order => order.id === orderStatusPath[1]);
    } catch (error) {
      console.error("Bestellstatus konnte nicht gespeichert werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Der Bestellstatus konnte nicht gespeichert werden." }), "application/json; charset=utf-8");
      return;
    }
    if (!existing) {
      send(res, 404, JSON.stringify({ ok: false, message: "Bestellung nicht gefunden." }), "application/json; charset=utf-8");
      return;
    }
    if (isAdminOrderClosed(existing)) {
      send(res, 409, JSON.stringify({
        ok: false,
        message: "Diese Bestellung ist bereits abgeschlossen und kann nicht mehr geändert werden.",
        order: existing
      }), "application/json; charset=utf-8");
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
      send(res, 500, JSON.stringify({
        ok: false,
        message: error.code === "ACCOUNTING_SYNC_FAILED"
          ? error.message
          : "Der Bestellstatus konnte nicht gespeichert werden."
      }), "application/json; charset=utf-8");
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
  const accountingEntryMatch = pathname.match(/^\/api\/admin\/accounting\/([a-f0-9-]{36})$/i);
  if ((req.method === "GET" && pathname === "/api/admin/accounting")
    || (req.method === "POST" && pathname === "/api/admin/accounting")
    || (req.method === "PATCH" && accountingEntryMatch)) {
    const adminSession = await requireCatalogAdmin(req, res, config, "/admin/accounting");
    if (!adminSession) return;
    if (req.method === "POST") {
      let payload;
      try {
        payload = JSON.parse(await readRequestBody(req, 16 * 1024));
      } catch {
        send(res, 400, JSON.stringify({ ok: false, message: "Ungültige oder zu große Buchungsdaten." }), "application/json; charset=utf-8");
        return;
      }
      if (!["income", "expense"].includes(payload?.kind)
        || !Number.isSafeInteger(payload.amount)
        || typeof payload.description !== "string"
        || !payload.description.trim()
        || payload.description.trim().length > 200
        || typeof payload.sourceId !== "string"
        || !/^[a-f0-9-]{36}$/i.test(payload.sourceId)) {
        send(res, 400, JSON.stringify({ ok: false, message: "Bitte Buchungsart, gültigen Betrag, Beschreibung und Buchungskennung prüfen." }), "application/json; charset=utf-8");
        return;
      }
      try {
        const entry = accountingLedger.add({
          kind: payload.kind,
          category: "manual",
          amount: payload.amount,
          description: payload.description,
          source: "manual",
          sourceId: payload.sourceId,
          bookedBy: adminSession.user?.global_name || adminSession.user?.username || "Web-Admin"
        });
        send(res, 201, JSON.stringify({ ok: true, entry }), "application/json; charset=utf-8");
      } catch (error) {
        if (/Betrag|Buchungsart|Beschreibung|Kategorie/.test(error.message)) {
          send(res, 400, JSON.stringify({ ok: false, message: error.message }), "application/json; charset=utf-8");
          return;
        }
        console.error("Web-Buchung konnte nicht gespeichert werden:", error.message);
        send(res, 500, JSON.stringify({ ok: false, message: "Die Buchung konnte nicht gespeichert werden." }), "application/json; charset=utf-8");
      }
      return;
    }
    if (req.method === "PATCH") {
      let payload;
      try {
        payload = JSON.parse(await readRequestBody(req, 16 * 1024));
      } catch {
        send(res, 400, JSON.stringify({ ok: false, message: "Ungültige oder zu große Korrekturdaten." }), "application/json; charset=utf-8");
        return;
      }
      try {
        const hasReplacement = payload?.replacement !== null && payload?.replacement !== undefined;
        if (typeof payload?.reason !== "string"
          || payload.reason.trim().length < 3
          || payload.reason.trim().length > 200
          || (hasReplacement && (!payload.replacement
            || !["income", "expense"].includes(payload.replacement.kind)
            || !Number.isSafeInteger(payload.replacement.amount)
            || typeof payload.replacement.description !== "string"
            || !payload.replacement.description.trim()
            || payload.replacement.description.trim().length > 200))) {
          send(res, 400, JSON.stringify({ ok: false, message: "Bitte Grund und Korrekturdaten prüfen." }), "application/json; charset=utf-8");
          return;
        }
        const result = accountingLedger.correctEntry(accountingEntryMatch[1], {
          by: adminSession.user?.global_name || adminSession.user?.username || "Web-Admin",
          reason: payload.reason,
          replacement: hasReplacement ? payload.replacement : null
        });
        send(res, 200, JSON.stringify({ ok: true, entry: result.entry, corrected: result.corrected }), "application/json; charset=utf-8");
      } catch (error) {
        const status = error.code === "NOT_FOUND" ? 404
          : error.code === "ALREADY_VOIDED" ? 409
            : error.code ? 500 : 400;
        if (status === 500) console.error("Web-Buchungskorrektur konnte nicht gespeichert werden:", error.message);
        const message = status === 500
          ? "Die Änderung konnte nicht dauerhaft gespeichert werden. Bitte Admin informieren."
          : error.message;
        send(res, status, JSON.stringify({ ok: false, message }), "application/json; charset=utf-8");
      }
      return;
    }
    try {
      accountingLedger.syncAllOrders(readAdminOrders());
      const entries = accountingLedger.read();
      const period = url.searchParams.get("period") || "gesamt";
      if (!["heute", "woche", "monat", "gesamt"].includes(period)) {
        send(res, 400, JSON.stringify({ ok: false, message: "Ungültiger Buchhaltungszeitraum." }), "application/json; charset=utf-8");
        return;
      }
      const range = periodRange(period);
      const summary = summarize(entries, range);
      const visibleEntries = entries
        .filter(entry => {
          if (!range.from && !range.to) return true;
          const date = accountingDateKey(new Date(entry.bookedAt));
          return (!range.from || date >= range.from) && (!range.to || date <= range.to);
        })
        .sort((left, right) => Date.parse(right.bookedAt) - Date.parse(left.bookedAt));
      send(res, 200, JSON.stringify({
        ok: true,
        period: range.label,
        summary,
        entries: visibleEntries.slice(0, 500),
        totalEntries: visibleEntries.length
      }), "application/json; charset=utf-8");
    } catch (error) {
      console.error("Buchhaltung konnte nicht geladen werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Die Buchhaltung konnte nicht geladen werden." }), "application/json; charset=utf-8");
    }
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
  if ((req.method === "GET" || req.method === "PUT") && pathname === "/api/admin/buyback-products") {
    const adminSession = await requireCatalogAdmin(req, res, config, "/admin/buyback");
    if (!adminSession) return;
    if (req.method === "GET") {
      try {
        send(res, 200, JSON.stringify({ ok: true, products: readBuybackProducts() }), "application/json; charset=utf-8");
      } catch (error) {
        console.error("Ankauf-Preisliste konnte nicht gelesen werden:", error.message);
        send(res, 500, JSON.stringify({ ok: false, message: "Die Ankauf-Preisliste konnte nicht gelesen werden." }), "application/json; charset=utf-8");
      }
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await readRequestBody(req, 64 * 1024));
    } catch {
      send(res, 400, JSON.stringify({ ok: false, message: "Ungültige oder zu große Produktdaten." }), "application/json; charset=utf-8");
      return;
    }
    const validation = validateBuybackProducts(payload?.products);
    if (validation.error) {
      send(res, 400, JSON.stringify({ ok: false, message: validation.error }), "application/json; charset=utf-8");
      return;
    }
    try {
      saveBuybackProducts(validation.products);
      send(res, 200, JSON.stringify({ ok: true, products: validation.products }), "application/json; charset=utf-8");
    } catch (error) {
      console.error("Ankauf-Preisliste konnte nicht gespeichert werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Die Ankauf-Preisliste konnte nicht gespeichert werden." }), "application/json; charset=utf-8");
    }
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
  if (pathname === "/admin/buyback" || pathname === "/admin/buyback.js") {
    const adminSession = await requireCatalogAdmin(req, res, config, "/admin/buyback");
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
  if (pathname === "/admin/accounting" || pathname === "/admin/accounting.js") {
    const adminSession = await requireCatalogAdmin(req, res, config, "/admin/accounting");
    if (!adminSession) return;
    serveStatic(req, res, pathname);
    return;
  }
  if (pathname === "/" || pathname === "/index.html" || pathname === "/ankauf.html" || pathname === "/ankauf.js" || pathname === "/material-ankauf.html" || pathname === "/material-ankauf.js" || pathname === "/stank-kauf.html" || pathname === "/stank-kauf.js" || pathname === "/freie-bestellung.html" || pathname === "/freie-bestellung.js" || pathname === "/theme.css" || pathname === "/shop.css" || pathname === "/forms.css" || pathname === "/bg.js" || pathname.startsWith("/img/")) {
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
  discordGatewayClient = client;
  client.once(Events.ClientReady, readyClient => {
    console.log(`Discord-Willkommensbot verbunden als ${readyClient.user.tag}.`);
    registerNewFamilyCommand(readyClient, config.guildId).then(() => {
      console.log("Discord-Slash-Commands /newfam und /buchung sind registriert.");
    }).catch(error => {
      console.error("Discord-Slash-Commands konnten nicht registriert werden:", error.message);
    });
  });
  client.on(Events.Error, error => {
    console.error("Discord-Willkommensbot-Verbindung fehlgeschlagen:", error.message);
  });
  client.on(Events.InteractionCreate, interaction => {
    const isNewFamilyCommand = interaction.isChatInputCommand() && interaction.commandName === "newfam";
    const isManualBookingCommand = interaction.isChatInputCommand() && interaction.commandName === "buchung";
    const isCashCommand = interaction.isChatInputCommand() && interaction.commandName === "kasse";
    const isVoidCommand = interaction.isChatInputCommand() && interaction.commandName === "storno";
    const handleInteraction = isNewFamilyCommand
      ? handleNewFamilyInteraction(interaction)
      : isManualBookingCommand
        ? handleManualBookingInteraction(interaction)
        : isCashCommand
          ? handleCashInteraction(interaction)
          : isVoidCommand
            ? handleVoidInteraction(interaction)
        : handleGatewayOrderInteraction(interaction);
    handleInteraction.catch(error => {
      const isSlashCommand = isNewFamilyCommand || isManualBookingCommand || isCashCommand || isVoidCommand;
      const context = isSlashCommand ? "Discord-Slash-Command fehlgeschlagen" : "Discord-Button-Interaktion fehlgeschlagen";
      console.error(`${context}:`, error.message);
      if (interaction.isRepliable() && !interaction.replied) {
        const content = isNewFamilyCommand
          ? `Die Familieneinrichtung ist fehlgeschlagen: ${error.message}`
          : isManualBookingCommand
            ? `Buchung fehlgeschlagen: ${error.message}`
            : isCashCommand
              ? `Kasse fehlgeschlagen: ${error.message}`
              : isVoidCommand
                ? `Storno/Korrektur fehlgeschlagen: ${error.message}`
            : "Der Bot konnte diese Bestellaktion nicht verarbeiten. Bitte die Bestellübersicht öffnen oder den Server-Admin informieren.";
        const reply = isSlashCommand
          ? (interaction.deferred ? interaction.editReply({ content }) : interaction.reply({ content, ephemeral: true }))
          : (interaction.deferred
            ? interaction.followUp({ content, ephemeral: true })
            : interaction.reply({ content, ephemeral: true }));
        reply.catch(replyError => {
          console.error("Discord-Fehlerantwort konnte nicht gesendet werden:", replyError.message);
        });
      }
    });
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
  try {
    const syncedOrders = accountingLedger.syncAllOrders(readAdminOrders());
    if (syncedOrders) console.log(`${syncedOrders} bestehende Bestellung(en) in die Buchhaltung übernommen.`);
  } catch (error) {
    console.error("Bestehende Bestellungen konnten nicht mit der Buchhaltung synchronisiert werden:", error.message);
  }
  void runDailyAccountingReport();
});
