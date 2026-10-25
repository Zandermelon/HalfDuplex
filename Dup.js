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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// One session per server
const sessions = new Map();
// People the bot muted who left voice before being unmuted ("guildId:userId")
const pendingUnmutes = new Set();

// Run mute/unmute jobs one at a time per session so they never overlap
function enqueue(session, fn) {
  session.queue = session.queue.then(fn).catch((err) => console.error(err));
  return session.queue;
}

async function giveFloor(session, speakerId) {
  if (session.speaker) return; // someone already has it
  session.speaker = speakerId;

  const channel = session.guild.channels.cache.get(session.channelId);
  if (!channel) return;

  const jobs = [];
  for (const [id, member] of channel.members) {
    if (id === speakerId || member.user.bot) continue;
    if (member.voice.serverMute) continue; // already muted (maybe by a mod), leave them alone
    session.muted.add(id);
    jobs.push(
      member.voice.setMute(true, 'Talking stick: someone else is speaking')
        .catch((e) => console.error(`Mute failed for ${id}:`, e.message)),
    );
  }
  await Promise.all(jobs);

  if (MAX_TURN_MS) {
    session.turnTimer = setTimeout(() => enqueue(session, () => releaseFloor(session)), MAX_TURN_MS);
  }
}

async function releaseFloor(session) {
  clearTimeout(session.silenceTimer);
  clearTimeout(session.turnTimer);
  session.speaker = null;

  const jobs = [];
  for (const id of session.muted) {
    const voiceState = session.guild.voiceStates.cache.get(id);
    if (voiceState?.channelId) {
      jobs.push(
        voiceState.setMute(false, 'Talking stick: floor is open')
          .catch((e) => console.error(`Unmute failed for ${id}:`, e.message)),
      );
    } else {
      // Discord can't unmute someone who isn't in voice; do it when they come back
      pendingUnmutes.add(`${session.guild.id}:${id}`);
    }
  }
  session.muted.clear();
  await Promise.all(jobs);
}

async function endSession(guildId) {
  const session = sessions.get(guildId);
  if (!session) return;
  sessions.delete(guildId);
  await enqueue(session, () => releaseFloor(session));
  if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    session.connection.destroy();
  }
}

// Replies only the person who ran the command can see
function privateReply(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function startSession(interaction) {
  const guild = interaction.guild;
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
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
  } catch {
    connection.destroy();
    return interaction.editReply("Couldn't connect to the voice channel.");
  }

  const session = {
    guild,
    channelId: channel.id,
    connection,
    speaker: null,
    muted: new Set(),
    silenceTimer: null,
    turnTimer: null,
    queue: Promise.resolve(),
  };
  sessions.set(guild.id, session);

  const speaking = connection.receiver.speaking;

  speaking.on('start', (userId) => {
    if (userId === client.user.id) return;
    if (userId === session.speaker) {
      clearTimeout(session.silenceTimer); // speaker resumed after a short pause
      return;
    }
    if (!session.speaker) enqueue(session, () => giveFloor(session, userId));
  });

  speaking.on('end', (userId) => {
    if (userId !== session.speaker) return;
    clearTimeout(session.silenceTimer);
    session.silenceTimer = setTimeout(
      () => enqueue(session, () => releaseFloor(session)),
      SILENCE_MS,
    );
  });

  // If the bot gets kicked or disconnected, try to reconnect briefly, otherwise clean up
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      endSession(guild.id);
    }
  });

  interaction.editReply(`Talking stick is on in **${channel.name}**. Whoever speaks first has the floor.`);
}

client.on('voiceStateUpdate', (oldState, newState) => {
  const key = `${newState.guild.id}:${newState.id}`;
  const session = sessions.get(newState.guild.id);

  if (session) {
    const left = oldState.channelId === session.channelId && newState.channelId !== session.channelId;
    const joined = newState.channelId === session.channelId && oldState.channelId !== session.channelId;

    if (left) {
      if (newState.id === session.speaker) {
        enqueue(session, () => releaseFloor(session));
      } else if (session.muted.has(newState.id)) {
        session.muted.delete(newState.id);
        if (newState.channelId) newState.setMute(false).catch(() => {});
        else pendingUnmutes.add(key);
      }
    }

    // Someone joins while a person has the floor: mute them too
    if (joined && session.speaker && !newState.member?.user.bot) {
      if (pendingUnmutes.delete(key)) {
        session.muted.add(newState.id); // still muted from before; unmute when floor opens
      } else if (!newState.serverMute) {
        session.muted.add(newState.id);
        newState.setMute(true, 'Talking stick: someone else is speaking').catch(() => {});
      }
      return;
    }
  }

  // Someone the bot muted earlier is back in voice: unmute them
  if (newState.channelId && pendingUnmutes.has(key)) {
    pendingUnmutes.delete(key);
    newState.setMute(false, 'Talking stick: cleanup').catch(() => {});
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'stick') return;

  try {
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') return await startSession(interaction);
    if (sub === 'stop') {
      if (!sessions.has(interaction.guild.id)) return privateReply(interaction, "I'm not running right now.");
      await interaction.deferReply();
      await endSession(interaction.guild.id);
      return interaction.editReply('Talking stick is off. Everyone has been unmuted.');
    }
  } catch (err) {
    console.error(err);
  }
});

// Unmute everyone if you stop the bot with Ctrl+C
async function shutdown() {
  await Promise.all([...sessions.keys()].map(endSession));
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