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
const recentCommits = run("git log --format=%h %s -n 5") || "Keine Commits";
const incomingRefs = (fs.readFileSync(0, "utf8") || "").trim();

const refsSummary = incomingRefs
  ? incomingRefs.split(/\n/)
      .filter(Boolean)
      .slice(0, 3)
      .map((line) => {
        const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
        const remoteTarget = (remoteRef || localRef || "ref").replace(/^refs\/heads\//, "");
        return `${remoteTarget} (${remoteSha ? remoteSha.slice(0, 7) : "head"})`;
      })
      .join("\n")
  : "No ref data";

const payload = {
  username: "Git Push Notifier",
  avatar_url: "https://cdn.discordapp.com/embed/avatars/0.png",
  content: `🚀 Push in ${repoName}`,
  embeds: [
    {
      title: `Push auf ${branch}`,
      color: 0x5865f2,
      description: `Repository: **${repoName}**\nPusher: **${pusher}**\nRemote: ${remoteUrl}`,
      fields: [
        {
          name: "Refs",
          value: refsSummary || "Keine Ref-Infos",
          inline: false,
        },
        {
          name: "Letzte Commits",
          value: recentCommits.split("\n").slice(0, 5).join("\n") || "Keine Commits",
          inline: false,
        },
      ],
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
