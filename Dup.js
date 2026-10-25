// Talking Stick bot: when someone starts speaking, everyone else in the
// voice channel is server-muted until that person stops talking.
 
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
 
// ---- Settings you can tweak ----
const SILENCE_MS = 1500;   // how long the speaker must be quiet before everyone is unmuted
const MAX_TURN_MS = 60000; // longest one person can hold the floor (set to 0 for no limit)
const CONNECT_TIMEOUT_MS = 20000;
const RECONNECT_TIMEOUT_MS = 5000;
 
const REASON = {
  mute: 'Talking stick: someone else is speaking',
  unmute: 'Talking stick: floor is open',
  cleanup: 'Talking stick: cleanup',
};
 
// The slash commands that show up when you type "/" in Discord
const commands = [
  new SlashCommandBuilder()
    .setName('stick')
    .setDescription('Talking stick: only one person can talk at a time')
    .addSubcommand((sub) =>
      sub.setName('start').setDescription('Join your voice channel and start the talking stick'))
    .addSubcommand((sub) =>
      sub.setName('stop').setDescription('Unmute everyone and leave the voice channel'))
    // Only people with Mute Members can see and use these commands
    .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers)
    .setContexts(InteractionContextType.Guild),
];
 
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
 
// One session per server: guildId -> Session
const sessions = new Map();
// People the bot muted who left voice before being unmuted ("guildId:userId")
const pendingUnmutes = new Set();
const userKey = (guildId, userId) => `${guildId}:${userId}`;
 
// Mute/unmute that logs instead of throwing
function setMute(voiceState, mute, reason) {
  return voiceState.setMute(mute, reason).catch((e) =>
    console.error(`${mute ? 'Mute' : 'Unmute'} failed for ${voiceState.id}:`, e.message));
}
 
class Session {
  constructor(guild, channelId, connection) {
    this.guild = guild;
    this.channelId = channelId;
    this.connection = connection;
    this.speaker = null;
    this.muted = new Set();
    this.silenceTimer = null;
    this.turnTimer = null;
    this.queue = Promise.resolve();
    this.ended = false;
    this.listen();
  }
 
  // Run mute/unmute jobs one at a time so they never overlap
  enqueue(fn) {
    this.queue = this.queue.then(fn).catch((err) => console.error(err));
    return this.queue;
  }
 
  queueRelease() {
    return this.enqueue(() => this.releaseFloor());
  }
 
  async giveFloor(speakerId) {
    if (this.ended || this.speaker) return; // stopped, or someone already has it
    const channel = this.guild.channels.cache.get(this.channelId);
    if (!channel) return;
    this.speaker = speakerId;
 
    const jobs = [];
    for (const [id, member] of channel.members) {
      // Skip the speaker, bots, and anyone already muted (maybe by a mod)
      if (id === speakerId || member.user.bot || member.voice.serverMute) continue;
      this.muted.add(id);
      jobs.push(setMute(member.voice, true, REASON.mute));
    }
    await Promise.all(jobs);
 
    if (MAX_TURN_MS) this.turnTimer = setTimeout(() => this.queueRelease(), MAX_TURN_MS);
  }
 
  async releaseFloor() {
    clearTimeout(this.silenceTimer);
    clearTimeout(this.turnTimer);
    this.speaker = null;
 
    const jobs = [];
    for (const id of this.muted) {
      const voiceState = this.guild.voiceStates.cache.get(id);
      if (voiceState?.channelId) jobs.push(setMute(voiceState, false, REASON.unmute));
      // Discord can't unmute someone who isn't in voice; do it when they come back
      else pendingUnmutes.add(userKey(this.guild.id, id));
    }
    this.muted.clear();
    await Promise.all(jobs);
  }
 
  async end() {
    if (this.ended) return;
    this.ended = true;
    sessions.delete(this.guild.id);
    await this.queueRelease();
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
  }
 
  listen() {
    const { speaking } = this.connection.receiver;
 
    speaking.on('start', (userId) => {
      if (userId === client.user.id) return;
      if (userId === this.speaker) clearTimeout(this.silenceTimer); // resumed after a short pause
      else if (!this.speaker) this.enqueue(() => this.giveFloor(userId));
    });
 
    speaking.on('end', (userId) => {
      if (userId !== this.speaker) return;
      clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => this.queueRelease(), SILENCE_MS);
    });
 
    // If the bot gets kicked or disconnected, try to reconnect briefly, otherwise clean up
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, RECONNECT_TIMEOUT_MS),
          entersState(this.connection, VoiceConnectionStatus.Connecting, RECONNECT_TIMEOUT_MS),
        ]);
      } catch {
        this.end();
      }
    });
  }
 
  // Returns true if the update was fully handled here
  onVoiceStateUpdate(oldState, newState) {
    const id = newState.id;
    const key = userKey(this.guild.id, id);
    const wasHere = oldState.channelId === this.channelId;
    const isHere = newState.channelId === this.channelId;
 
    if (wasHere && !isHere) {
      if (id === this.speaker) {
        this.queueRelease();
      } else if (this.muted.delete(id)) {
        if (newState.channelId) setMute(newState, false, REASON.cleanup);
        else pendingUnmutes.add(key);
      }
    }
 
    // Someone joins while a person has the floor: mute them too
    if (!wasHere && isHere && this.speaker && !newState.member?.user.bot) {
      if (pendingUnmutes.delete(key)) {
        this.muted.add(id); // still muted from before; unmute when floor opens
      } else if (!newState.serverMute) {
        this.muted.add(id);
        setMute(newState, true, REASON.mute);
      }
      return true;
    }
    return false;
  }
}
 
// ---- Commands ----
 
// Replies only the person who ran the command can see
function privateReply(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
 
async function startCommand(interaction) {
  const { guild } = interaction;
  const channel = interaction.member.voice.channel;
  if (!channel) return privateReply(interaction, 'Join a voice channel first, then run this again.');
  if (sessions.has(guild.id)) return privateReply(interaction, 'Already running. Use `/stick stop` first.');
 
  const perms = channel.permissionsFor(guild.members.me);
  if (!perms.has([PermissionFlagsBits.Connect, PermissionFlagsBits.MuteMembers])) {
    return privateReply(interaction, 'I need the **Connect** and **Mute Members** permissions in that channel.');
  }
 
  // Connecting can take longer than Discord's 3-second reply limit, so reply "thinking..." first
  await interaction.deferReply();
 
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // must NOT be deafened, or the bot can't hear who is talking
    selfMute: true,
  });
 
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
  } catch {
    connection.destroy();
    return interaction.editReply("Couldn't connect to the voice channel.");
  }
 
  sessions.set(guild.id, new Session(guild, channel.id, connection));
  return interaction.editReply(`Talking stick is on in **${channel.name}**. Whoever speaks first has the floor.`);
}
 
async function stopCommand(interaction) {
  const session = sessions.get(interaction.guildId);
  if (!session) return privateReply(interaction, "I'm not running right now.");
  await interaction.deferReply();
  await session.end();
  return interaction.editReply('Talking stick is off. Everyone has been unmuted.');
}
 
const subcommands = { start: startCommand, stop: stopCommand };
 
// ---- Events ----
 
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'stick') return;
  try {
    await subcommands[interaction.options.getSubcommand()]?.(interaction);
  } catch (err) {
    console.error(err);
    const msg = 'Something went wrong. Check the bot logs.';
    const send = interaction.deferred || interaction.replied
      ? interaction.editReply(msg)
      : privateReply(interaction, msg);
    send.catch(() => {});
  }
});
 
client.on('voiceStateUpdate', (oldState, newState) => {
  const session = sessions.get(newState.guild.id);
  if (session?.onVoiceStateUpdate(oldState, newState)) return;
 
  // Someone the bot muted earlier is back in voice: unmute them
  if (newState.channelId && pendingUnmutes.delete(userKey(newState.guild.id, newState.id))) {
    setMute(newState, false, REASON.cleanup);
  }
});
 
// Unmute everyone if you stop the bot with Ctrl+C
async function shutdown() {
  await Promise.all([...sessions.values()].map((s) => s.end()));
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
 
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Tell Discord about the slash commands so they show up in the "/" menu
  try {
    await client.application.commands.set(commands);
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});
 
client.login(process.env.DISCORD_TOKEN);