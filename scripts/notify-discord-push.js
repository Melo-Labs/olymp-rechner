#!/usr/bin/env node

const fs = require("node:fs");
const { execSync } = require("node:child_process");

const webhookUrl = process.env.DISCORD_PUSH_WEBHOOK_URL || process.argv[2];

if (!webhookUrl) {
  console.log("[discord-push] No Discord webhook configured; skipping notification.");
  process.exit(0);
}

function run(command) {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

const repoRoot = run("git rev-parse --show-toplevel") || process.cwd();
const repoName = (repoRoot.split(/[\\/]/).filter(Boolean).pop() || "repo").replace(/\.git$/, "");
const branch = run("git rev-parse --abbrev-ref HEAD") || "unknown";
const remoteUrl = run("git config --get remote.origin.url") || "local";
const pusher = run("git config user.name") || process.env.USER || "unknown";
const currentSha = run("git rev-parse --short HEAD") || "unknown";
const recentCommits = run("git log --format=%h%x09%an%x09%s -n 5") || "";
const incomingRefs = (fs.readFileSync(0, "utf8") || "").trim();

const refsSummary = incomingRefs
  ? incomingRefs.split(/\n/)
      .filter(Boolean)
      .slice(0, 3)
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        const localRef = parts[0] || "ref";
        const remoteRef = parts[2] || localRef;
        const remoteSha = parts[3] || "";
        const target = (remoteRef || localRef || "ref").replace(/^refs\/heads\//, "");
        return `• ${target} (${remoteSha ? remoteSha.slice(0, 7) : "head"})`;
      })
      .join("\n")
  : "Keine Ref-Informationen";

const commitLines = recentCommits
  ? recentCommits
      .split(/\n/)
      .filter(Boolean)
      .slice(0, 5)
      .map((line) => {
        const [sha, author, ...messageParts] = line.split(/\t/);
        const message = messageParts.join(" ") || "Kein Commit-Text";
        return `• ${sha} — ${author}: ${message}`;
      })
      .join("\n")
  : "Keine Commits";

const payload = {
  username: "Git Push Notifier",
  avatar_url: "https://cdn.discordapp.com/embed/avatars/1.png",
  content: `🚀 Neuer Push in **${repoName}**`,
  embeds: [
    {
      title: `✅ Push auf ${branch}`,
      color: 0x57f287,
      description: `Ein neuer Commit wurde von **${pusher}** an **${repoName}** gepusht.`,
      fields: [
        {
          name: "Repository",
          value: `**${repoName}**`,
          inline: true,
        },
        {
          name: "Branch",
          value: `\`${branch}\``,
          inline: true,
        },
        {
          name: "Letzter Commit",
          value: `\`${currentSha}\``,
          inline: true,
        },
        {
          name: "Refs",
          value: refsSummary,
          inline: false,
        },
        {
          name: "Letzte Commits",
          value: commitLines,
          inline: false,
        },
      ],
      footer: {
        text: `${repoName} • ${new Date().toLocaleString("de-DE")}`,
      },
      timestamp: new Date().toISOString(),
    },
  ],
};

async function send() {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  if (!response.ok) {
    console.error(`[discord-push] Discord webhook failed (${response.status}): ${text}`);
    process.exit(1);
  }

  console.log(`[discord-push] Discord notification sent (${response.status})`);
}

send().catch((error) => {
  console.error("[discord-push] Failed to deliver Discord notification:", error.message);
  process.exit(1);
});
