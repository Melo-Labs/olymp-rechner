"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ChannelType, PermissionFlagsBits } = require("discord.js");
const { activateLockdown, restoreLockdown } = require("../discord-lockdown");

function makeOverwrite(id, allowBits = 0n, denyBits = 0n) {
  const overwrite = {
    id,
    allow: {
      bitfield: allowBits,
      has: permission => (allowBits & BigInt(permission)) !== 0n
    },
    deny: {
      bitfield: denyBits,
      has: permission => (denyBits & BigInt(permission)) !== 0n
    }
  };
  return overwrite;
}

function createGuild(channelSpecs, { canManageChannels = true } = {}) {
  const everyoneId = "everyone";
  const channels = channelSpecs.map(({ id, overwrites = [] }) => {
    const manager = {
      cache: new Map(),
      async edit(overwriteId, permissions) {
        let current = this.cache.get(overwriteId);
        let allowBits = current?.allow.bitfield || 0n;
        let denyBits = current?.deny.bitfield || 0n;
        for (const [name, flag] of [
          ["SendMessages", PermissionFlagsBits.SendMessages],
          ["SendMessagesInThreads", PermissionFlagsBits.SendMessagesInThreads]
        ]) {
          if (permissions[name] === null) {
            allowBits &= ~flag;
            denyBits &= ~flag;
          } else if (permissions[name] === true) {
            allowBits |= flag;
            denyBits &= ~flag;
          } else if (permissions[name] === false) {
            denyBits |= flag;
            allowBits &= ~flag;
          }
        }
        current = makeOverwrite(overwriteId, allowBits, denyBits, this);
        current.delete = async () => this.cache.delete(overwriteId);
        this.cache.set(overwriteId, current);
      }
    };
    for (const overwrite of overwrites) {
      const current = makeOverwrite(overwrite.id, overwrite.allow || 0n, overwrite.deny || 0n);
      current.delete = async () => manager.cache.delete(overwrite.id);
      manager.cache.set(overwrite.id, current);
    }
    return {
      id,
      name: id,
      type: ChannelType.GuildText,
      permissionOverwrites: manager,
      permissionsFor: () => ({ has: () => canManageChannels })
    };
  });
  return {
    id: "guild-id",
    roles: { everyone: { id: everyoneId } },
    members: { me: {} },
    channels: { cache: new Map(channels.map(channel => [channel.id, channel])) }
  };
}

test("Lockdown sperrt und stellt die ursprünglichen Schreibrechte wieder her", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "discord-lockdown-"));
  const stateFile = path.join(directory, "state.json");
  const sendMessages = PermissionFlagsBits.SendMessages;
  const sendInThreads = PermissionFlagsBits.SendMessagesInThreads;
  const viewChannel = PermissionFlagsBits.ViewChannel;
  const guild = createGuild([
    {
      id: "general",
      overwrites: [
        { id: "everyone", allow: sendMessages | viewChannel },
        { id: "moderator", allow: sendInThreads | viewChannel },
        { id: "member", deny: sendMessages }
      ]
    },
    { id: "announcements" }
  ]);
  const general = guild.channels.cache.get("general");
  const announcements = guild.channels.cache.get("announcements");

  try {
    assert.equal(await activateLockdown(guild, stateFile), 2);
    for (const overwrite of general.permissionOverwrites.cache.values()) {
      assert.equal(overwrite.deny.has(sendMessages), true);
      assert.equal(overwrite.deny.has(sendInThreads), true);
    }
    assert.equal(announcements.permissionOverwrites.cache.get("everyone").deny.has(sendMessages), true);
    assert.equal(fs.existsSync(stateFile), true);

    assert.equal(await restoreLockdown(guild, stateFile), 2);
    assert.equal(general.permissionOverwrites.cache.get("everyone").allow.has(sendMessages), true);
    assert.equal(general.permissionOverwrites.cache.get("everyone").allow.has(viewChannel), true);
    assert.equal(general.permissionOverwrites.cache.get("moderator").allow.has(sendInThreads), true);
    assert.equal(general.permissionOverwrites.cache.get("member").deny.has(sendMessages), true);
    assert.equal(announcements.permissionOverwrites.cache.has("everyone"), false);
    assert.equal(fs.existsSync(stateFile), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Lockdown prüft Kanalrechte vor jeder Änderung", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "discord-lockdown-"));
  const stateFile = path.join(directory, "state.json");
  const guild = createGuild([{ id: "general" }], { canManageChannels: false });

  try {
    await assert.rejects(activateLockdown(guild, stateFile), /es wurde nichts geändert/);
    assert.equal(fs.existsSync(stateFile), false);
    assert.equal(guild.channels.cache.get("general").permissionOverwrites.cache.size, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Teilfehler lassen den Zustand für eine spätere Wiederherstellung bestehen", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "discord-lockdown-"));
  const stateFile = path.join(directory, "state.json");
  const guild = createGuild([{ id: "general" }, { id: "news" }]);
  const news = guild.channels.cache.get("news");
  const edit = news.permissionOverwrites.edit;
  news.permissionOverwrites.edit = async () => {
    throw new Error("simulierter Discord-Fehler");
  };

  try {
    await assert.rejects(activateLockdown(guild, stateFile), /nur teilweise angewendet \(1\/2 Kanäle\)/);
    assert.equal(fs.existsSync(stateFile), true);

    news.permissionOverwrites.edit = edit;
    assert.equal(await restoreLockdown(guild, stateFile), 2);
    assert.equal(fs.existsSync(stateFile), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
