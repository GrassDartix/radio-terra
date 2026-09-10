require('dotenv').config();
const dns = require('node:dns');
const http = require('node:http');
const { webcrypto } = require('node:crypto');

if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { Player } = require('discord-player');
const { DefaultExtractors } = require('@discord-player/extractor');

dns.setDefaultResultOrder('ipv4first');

// Simple HTTP server for Render port requirement
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Radio Terra bot is active and running!');
});
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP server is listening on port ${PORT}`);
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ]
});

const player = new Player(client);

const lockedChannels = new Map();
const reportChannels = new Map();

async function initializePlayer() {
    await player.extractors.loadMulti(DefaultExtractors);
    console.log('Audio extractors loaded successfully.');
}
initializePlayer();

const commands = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a song immediately')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('The song title or URL')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('add')
        .setDescription('Add a song to the end of the queue')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('The song title or URL')
                .setRequired(true)
        ),
    new SlashCommandBuilder().setName('skip').setDescription('Skip to the next song'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
    new SlashCommandBuilder().setName('pause').setDescription('Pause the current song'),
    new SlashCommandBuilder().setName('resume').setDescription('Resume the paused song'),
    new SlashCommandBuilder().setName('queue').setDescription('View the upcoming songs'),
    new SlashCommandBuilder()
        .setName('setchannel')
        .setDescription('Lock bot outputs to this text channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
        .setName('setreportchannel')
        .setDescription('Set channel for song reports')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
        .setName('report')
        .setDescription('Report currently playing song')
].map(command => command.toJSON());

client.once('ready', async () => {
    console.log(`Bot logged in as ${client.user.tag}!`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Slash commands registered successfully.');
    } catch (error) {
        console.error('Failed to register slash commands:', error);
    }
});

// Detailed audio event logging
player.events.on('playerError', (queue, error) => {
    console.error(`❌ Player Error:`, error);
});

player.events.on('error', (queue, error) => {
    console.error(`❌ Queue Error:`, error);
});

player.events.on('playerStart', (queue, track) => {
    console.log(`🎶 Started playing: ${track.title} by ${track.author}`);
});

player.events.on('emptyQueue', (queue) => {
    console.log(`📭 Queue is empty, leaving voice channel.`);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const guildId = interaction.guildId;
    const voiceChannel = interaction.member?.voice?.channel;
    const queue = player.nodes.get(guildId);

    if (interaction.commandName === 'play') {
        const query = interaction.options.getString('query');
        await interaction.deferReply();

        try {
            if (!voiceChannel) {
                return interaction.editReply('You must be in a voice channel first!');
            }

            const searchResult = await player.search(query, {
                requestedBy: interaction.user
            });

            if (!searchResult.hasTracks()) {
                return interaction.editReply('Could not find any tracks matching your query.');
            }

            const track = searchResult.tracks[0];

            if (!queue || !queue.isPlaying()) {
                await player.play(voiceChannel, query, {
                    nodeOptions: {
                        metadata: interaction.channel,
                        leaveOnEmpty: true,
                        leaveOnEmptyCooldown: 180000,
                        leaveOnEnd: true,
                        leaveOnEndCooldown: 180000,
                    }
                });
                return interaction.editReply(`🎶 Now playing: **${track.title}** by **${track.author}**`);
            }

            queue.insertTrack(track, 0);
            queue.node.skip();

            return interaction.editReply(`⚡ Interrupted and playing now: **${track.title}** by **${track.author}**`);
        } catch (error) {
            console.error('Play error:', error);
            return interaction.editReply('An error occurred while trying to play the track.');
        }
    }

    if (interaction.commandName === 'add') {
        const query = interaction.options.getString('query');
        await interaction.deferReply();

        try {
            if (!voiceChannel) {
                return interaction.editReply('You must be in a voice channel first!');
            }

            const searchResult = await player.search(query, {
                requestedBy: interaction.user
            });

            if (!searchResult.hasTracks()) {
                return interaction.editReply('Could not find any tracks matching your query.');
            }

            const track = searchResult.tracks[0];

            if (!queue || !queue.isPlaying()) {
                await player.play(voiceChannel, query, {
                    nodeOptions: {
                        metadata: interaction.channel,
                        leaveOnEmpty: true,
                        leaveOnEmptyCooldown: 180000,
                        leaveOnEnd: true,
                        leaveOnEndCooldown: 180000,
                    }
                });
                return interaction.editReply(`🎶 Nothing was playing, so **${track.title}** is now playing!`);
            }

            queue.addTrack(track);
            return interaction.editReply(`➕ Added to queue: **${track.title}** by **${track.author}**`);
        } catch (error) {
            console.error('Add error:', error);
            return interaction.editReply('An error occurred while trying to add the track.');
        }
    }

    if (['skip', 'stop', 'pause', 'resume', 'queue'].includes(interaction.commandName)) {
        if (!queue || !queue.currentTrack) {
            return interaction.reply({ content: 'No music is currently playing.', flags: 64 });
        }

        if (interaction.commandName === 'skip') {
            queue.node.skip();
            return interaction.reply('⏭️ Skipped to the next track!');
        }
        if (interaction.commandName === 'stop') {
            queue.delete();
            return interaction.reply('🛑 Playback stopped and queue cleared.');
        }
        if (interaction.commandName === 'pause') {
            queue.node.setPaused(true);
            return interaction.reply('⏸️ Paused the music.');
        }
        if (interaction.commandName === 'resume') {
            queue.node.setPaused(false);
            return interaction.reply('▶️ Resumed the music.');
        }
        if (interaction.commandName === 'queue') {
            const current = queue.currentTrack;
            const tracks = queue.tracks.toArray();
            let str = `**Now Playing:** ${current.title}\n\n**Upcoming:**\n`;
            if (tracks.length === 0) {
                str += 'No upcoming songs.';
            } else {
                str += tracks.slice(0, 10).map((t, i) => `${i + 1}. ${t.title}`).join('\n');
            }
            return interaction.reply(str);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
