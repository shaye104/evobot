const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
  Partials,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { CONFIG } = require('../config');
const payhip = require('../payhip/service');
const supportApi = require('./supportApi');
const {
  loadNotificationTemplates,
  renderTemplate,
} = require('./notificationTemplates');

const CUSTOMER_LOUNGE_CHANNEL_ID = '1468663410848698440';
const BOT_STATE_PATH = (() => {
  if (process.env.DISCORD_BOT_STATE_PATH) return process.env.DISCORD_BOT_STATE_PATH;
  const cwd = process.cwd();
  // If running from repo root, prefer DISCORD BOT. If running inside DISCORD BOT, use ./data.
  const uploadsDir = path.join(cwd, 'DISCORD BOT');
  if (fs.existsSync(uploadsDir)) {
    return path.join(uploadsDir, 'data', 'bot_state.json');
  }
  return path.join(cwd, 'data', 'bot_state.json');
})();

async function startDiscordBot() {
  if (!CONFIG.DISCORD_BOT_TOKEN) {
    console.warn('[discord] Bot not started: missing bot token.');
    return createDiscordStubs();
  }

  const { filePath: templatePath, templates } = loadNotificationTemplates();
  if (templates.size) {
    console.log(`[discord] Loaded ${templates.size} notification templates from ${templatePath}`);
  } else {
    console.warn('[discord] No Discord notification templates loaded; using fallback embeds.');
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  function shortPreview(input, maxLen = 20) {
    const text = String(input || '').replace(/\s+/g, ' ').trim();
    if (!text) return 'New message';
    if (text.length <= maxLen) return text;
    if (maxLen <= 3) return '...'.slice(0, maxLen);
    return `${text.slice(0, maxLen - 3).trimEnd()}...`;
  }

  async function handleAutoRoleAndWelcome(discordId) {
    if (!discordId) return;
    if (!CONFIG.DISCORD_GUILD_ID || !CONFIG.DISCORD_ROLE_ID) return;

    try {
      const guild = await client.guilds.fetch(CONFIG.DISCORD_GUILD_ID);
      const member = await guild.members.fetch(discordId);
      if (!member) return;

      const hasRole = member.roles.cache.has(CONFIG.DISCORD_ROLE_ID);
      if (!hasRole) {
        await member.roles.add(CONFIG.DISCORD_ROLE_ID);
      } else {
        return;
      }

      const channel = await client.channels.fetch(CUSTOMER_LOUNGE_CHANNEL_ID);
      if (channel && channel.isTextBased()) {
        await channel.send(`<@${discordId}> has entered the customer lounge.`);
      }
    } catch (err) {
      console.warn(`[discord] Auto-role failed: ${err.message}`);
    }
  }

  async function sendSupportChannelMessage(content, ticket) {
    if (!CONFIG.DISCORD_SUPPORT_NOTIFY_CHANNEL_ID) return;
    if (!content) return;
    try {
      const channel = await client.channels.fetch(
        CONFIG.DISCORD_SUPPORT_NOTIFY_CHANNEL_ID
      );
      if (!channel || !channel.isTextBased()) return;
      const linkBase = CONFIG.SUPPORT_API_BASE || CONFIG.BASE_URL;
      const link = ticket?.public_id
        ? CONFIG.SUPPORT_API_BASE
            ? `${linkBase}/staff-ticket.html?id=${ticket.public_id}`
            : `${linkBase}/staff/tickets/${ticket.public_id}`
        : linkBase;
      await channel.send(`${content}\n${link}`);
    } catch (err) {
      console.warn(`[discord] Notify channel failed: ${err.message}`);
    }
  }

  async function sendTicketDmReply(ticket, payload) {
    if (!ticket?.creator_discord_id) return;
    try {
      const user = await client.users.fetch(ticket.creator_discord_id);
      if (!user) return;
      const content = `Ticket ${ticket.public_id} reply:\n${payload.body}`;
      await user.send({
        content,
        files: payload.files || [],
      });
    } catch (err) {
      console.warn(`[discord] DM reply failed: ${err.message}`);
    }
  }

  async function sendTicketUpdateDm(ticket, body) {
    if (!ticket?.creator_discord_id) return;
    try {
      const user = await client.users.fetch(ticket.creator_discord_id);
      if (!user) return;
      const content = `Ticket ${ticket.public_id} has an update:\n${body}`;
      await user.send({ content });
    } catch (err) {
      console.warn(`[discord] DM update failed: ${err.message}`);
    }
  }

  async function loadBotState() {
    try {
      const raw = await fs.promises.readFile(BOT_STATE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        last_staff_message_id: parsed.last_staff_message_id ?? null,
        last_claimed_user_message_id: parsed.last_claimed_user_message_id ?? null,
        last_audit_event_id: parsed.last_audit_event_id ?? null,
        ticket_open_message_ids: parsed.ticket_open_message_ids || {},
      };
    } catch {
      return {
        last_staff_message_id: null,
        last_claimed_user_message_id: null,
        last_audit_event_id: null,
        ticket_open_message_ids: {},
      };
    }
  }

  async function saveBotState(state) {
    await fs.promises.mkdir(path.dirname(BOT_STATE_PATH), { recursive: true });
    await fs.promises.writeFile(
      BOT_STATE_PATH,
      JSON.stringify(state, null, 2)
    );
  }

  async function syncStaffReplies() {
    if (!supportApi.isBotAuthReady()) return;

    const state = await loadBotState();
    if (state.last_staff_message_id == null) {
      const { messages } = await supportApi.listStaffReplies(0);
      state.last_staff_message_id = messages.length
        ? Math.max(...messages.map((msg) => msg.id))
        : 0;
      await saveBotState(state);
      return;
    }

    const { messages, attachments } = await supportApi.listStaffReplies(
      state.last_staff_message_id
    );
    if (!messages.length) return;

    const attachmentsByMessage = new Map();
    for (const attachment of attachments) {
      if (!attachment.ticket_message_id) continue;
      if (!attachmentsByMessage.has(attachment.ticket_message_id)) {
        attachmentsByMessage.set(attachment.ticket_message_id, []);
      }
      attachmentsByMessage
        .get(attachment.ticket_message_id)
        .push(attachment);
    }

    for (const msg of messages) {
      if (!msg.creator_discord_id) continue;
      if (msg.notify === false) {
        continue;
      }
      try {
        const user = await client.users.fetch(msg.creator_discord_id);
        if (!user) continue;
        const files = (attachmentsByMessage.get(msg.id) || [])
          .filter((att) => att.storage_url)
          .map((att) => ({
            attachment: att.storage_url,
            name: att.filename || 'attachment',
          }));

        const base = (CONFIG.SUPPORT_API_BASE || CONFIG.BASE_URL || '').replace(/\/$/, '');
        const ticketUrl = `${base}/ticket.html?id=${encodeURIComponent(String(msg.public_id || ''))}`;
        const body = String(msg.body || '').trim();
        const preview = shortPreview(body, 20);
        const sender = String(msg.author_name || 'Staff').trim() || 'Staff';

        const template = templates.get('📩 New Message Received');
        if (template) {
          const payload = renderTemplate(template, {
            ticketUrl,
            replacements: {
              ID: String(msg.public_id || ''),
              Username: sender,
              'Short message preview': preview,
            },
            now: new Date(),
          });
          await user.send({
            content: payload.content,
            embeds: payload.embeds,
            components: payload.components,
            files: files.length ? files : undefined,
          });
        } else {
          const embed = new EmbedBuilder()
            .setTitle(`Ticket reply`)
            .setDescription(body.slice(0, 3500) || 'New reply')
            .setColor(0x3484ff)
            .setFooter({
              text: new Date().toLocaleString('en-GB', { hour12: false }),
            });

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setStyle(ButtonStyle.Link)
              .setLabel('View ticket')
              .setURL(ticketUrl)
          );

          await user.send({
            embeds: [embed],
            components: [row],
            files: files.length ? files : undefined,
          });
        }
      } catch (err) {
        console.warn(`[discord] DM update failed: ${err.message}`);
      }
    }

    state.last_staff_message_id = Math.max(...messages.map((msg) => msg.id));
    await saveBotState(state);
  }

  async function syncClaimedUserMessages() {
    if (!supportApi.isBotAuthReady()) return;

    const state = await loadBotState();
    if (state.last_claimed_user_message_id == null) {
      const { messages } = await supportApi.listClaimedUserMessages(0);
      state.last_claimed_user_message_id = messages.length
        ? Math.max(...messages.map((m) => m.id))
        : 0;
      await saveBotState(state);
      return;
    }

    const { messages, attachments } = await supportApi.listClaimedUserMessages(
      state.last_claimed_user_message_id
    );
    if (!messages.length) return;

    const attachmentsByMessage = new Map();
    for (const attachment of attachments || []) {
      if (!attachment.ticket_message_id) continue;
      if (!attachmentsByMessage.has(attachment.ticket_message_id)) {
        attachmentsByMessage.set(attachment.ticket_message_id, []);
      }
      attachmentsByMessage
        .get(attachment.ticket_message_id)
        .push(attachment);
    }

    for (const msg of messages) {
      const staffDiscordId = String(msg.staff_discord_id || '').trim();
      if (!staffDiscordId) continue;
      try {
        const staffUser = await client.users.fetch(staffDiscordId);
        if (!staffUser) continue;

        const files = (attachmentsByMessage.get(msg.id) || [])
          .filter((att) => att.storage_url)
          .map((att) => ({
            attachment: att.storage_url,
            name: att.filename || 'attachment',
          }));

        const base = (CONFIG.SUPPORT_API_BASE || CONFIG.BASE_URL || '').replace(/\/$/, '');
        const staffTicketUrl = `${base}/staff-ticket.html?id=${encodeURIComponent(String(msg.public_id || ''))}`;
        const body = String(msg.body || '').trim();
        const preview = shortPreview(body, 20);
        const sender = String(msg.author_name || 'User').trim() || 'User';

        const template = templates.get('📩 New Message Received');
        if (template) {
          const payload = renderTemplate(template, {
            ticketUrl: staffTicketUrl,
            replacements: {
              ID: String(msg.public_id || ''),
              Username: sender,
              'Short message preview': preview,
            },
            now: new Date(),
          });
          await staffUser.send({
            content: payload.content,
            embeds: payload.embeds,
            components: payload.components,
            files: files.length ? files : undefined,
          });
        } else {
          const embed = new EmbedBuilder()
            .setTitle('New user message')
            .setDescription(body.slice(0, 3500) || 'New message')
            .setColor(0x3484ff)
            .setFooter({ text: new Date().toLocaleString('en-GB', { hour12: false }) });

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setStyle(ButtonStyle.Link)
              .setLabel('Open ticket')
              .setURL(staffTicketUrl)
          );

          await staffUser.send({
            embeds: [embed],
            components: [row],
            files: files.length ? files : undefined,
          });
        }
      } catch (err) {
        console.warn(`[discord] DM claimed-ticket update failed: ${err.message}`);
      }
    }

    state.last_claimed_user_message_id = Math.max(...messages.map((m) => m.id));
    await saveBotState(state);
  }

  async function syncWebhookTicketEvents() {
    if (!supportApi.isBotAuthReady()) return;
    if (
      !CONFIG.DISCORD_SUPPORT_NOTIFY_CHANNEL_ID &&
      !CONFIG.DISCORD_TICKET_OPEN_CHANNEL_ID &&
      !CONFIG.DISCORD_TICKET_ESCALATE_CHANNEL_ID
    ) {
      return;
    }

    const state = await loadBotState();
    if (state.last_audit_event_id == null) {
      const events = await supportApi.listWebhookEvents(0).catch(() => []);
      state.last_audit_event_id = events.length
        ? Math.max(...events.map((e) => e.id))
        : 0;
      await saveBotState(state);
      return;
    }

    const events = await supportApi.listWebhookEvents(state.last_audit_event_id).catch(() => []);
    if (!Array.isArray(events) || !events.length) return;
    console.log(
      `[discord] Ticket events: fetched ${events.length} event(s) since id ${state.last_audit_event_id}`
    );

    const base = (CONFIG.SUPPORT_API_BASE || CONFIG.BASE_URL || '').replace(/\/$/, '');
    async function fetchNotifyChannel(channelId) {
      if (!channelId) return null;
      try {
        const ch = await client.channels.fetch(channelId);
        return ch && ch.isTextBased() ? ch : null;
      } catch (err) {
        console.warn(`[discord] Notify channel fetch failed (${channelId}): ${err.message}`);
        return null;
      }
    }

    for (const ev of events) {
      const publicId = String(ev.public_id || '').trim();
      if (!publicId) continue;

      const staffTicketUrl = `${base}/staff-ticket.html?id=${encodeURIComponent(publicId)}`;

      try {
        if (ev.action === 'ticket.created') {
          const channelId =
            CONFIG.DISCORD_TICKET_OPEN_CHANNEL_ID ||
            CONFIG.DISCORD_SUPPORT_NOTIFY_CHANNEL_ID;
          const channel = await fetchNotifyChannel(channelId);
          if (!channel) continue;

          const t = templates.get('🎫 Ticket Opened');
          const openedBy = String(ev.opened_by_name || 'User').trim() || 'User';
          const panelName = String(ev.panel_name || 'Unknown').trim() || 'Unknown';
          const claimedBy = String(ev.claimed_by_name || 'Nobody').trim() || 'Nobody';

          const payload = t
            ? renderTemplate(t, {
                ticketUrl: staffTicketUrl,
                replacements: {
                  ID: publicId,
                  'panel name': panelName,
                  username: openedBy,
                  'nobody/usernane': claimedBy,
                },
                now: new Date(),
              })
            : {
                embeds: [
                  {
                    title: 'Ticket Opened',
                    description: 'A new support ticket has been created.',
                    color: 0x3484ff,
                    fields: [
                      { name: 'Ticket ID', value: `\`\`${publicId}\`\``, inline: true },
                      { name: 'Ticket Panel', value: `\`\`${panelName}\`\``, inline: true },
                      { name: 'Opened By', value: `\`\`${openedBy}\`\``, inline: true },
                    ],
                  },
                ],
                components: [
                  {
                    type: 1,
                    components: [
                      { type: 2, style: 5, url: staffTicketUrl, label: 'Open Ticket' },
                    ],
                  },
                ],
              };

          const sent = await channel.send({
            embeds: payload.embeds,
            components: payload.components,
          });

          // Store the message id so we can edit it later (e.g., when claimed).
          state.ticket_open_message_ids = state.ticket_open_message_ids || {};
          state.ticket_open_message_ids[publicId] = String(sent.id);
          await saveBotState(state);
        } else if (ev.action === 'ticket.escalate') {
          const channelId =
            CONFIG.DISCORD_TICKET_ESCALATE_CHANNEL_ID ||
            CONFIG.DISCORD_SUPPORT_NOTIFY_CHANNEL_ID;
          const channel = await fetchNotifyChannel(channelId);
          if (!channel) continue;

          const t = templates.get('🚨 Ticket Escalated');
          const escalatedBy = String(ev.actor_name || 'Staff').trim() || 'Staff';
          const toPanel = String(ev.to_panel_name || ev.panel_name || 'Unknown').trim() || 'Unknown';

          const payload = t
            ? renderTemplate(t, {
                ticketUrl: staffTicketUrl,
                replacements: {
                  ID: publicId,
                  username: escalatedBy,
                  'panel name': toPanel,
                },
                now: new Date(),
              })
            : {
                embeds: [
                  {
                    title: 'Ticket Escalated',
                    description: 'A ticket has been escalated to another panel.',
                    color: 0x3484ff,
                    fields: [
                      { name: 'Ticket ID', value: `\`\`${publicId}\`\``, inline: true },
                      { name: 'Escalated By', value: `\`\`${escalatedBy}\`\``, inline: true },
                      { name: 'Escalated To', value: `\`\`${toPanel}\`\``, inline: true },
                    ],
                  },
                ],
                components: [
                  {
                    type: 1,
                    components: [
                      { type: 2, style: 5, url: staffTicketUrl, label: 'Open Ticket' },
                    ],
                  },
                ],
              };

          await channel.send({
            embeds: payload.embeds,
            components: payload.components,
          });
        } else if (ev.action === 'ticket.claim' || ev.action === 'ticket.unclaim') {
          const channelId =
            CONFIG.DISCORD_TICKET_OPEN_CHANNEL_ID ||
            CONFIG.DISCORD_SUPPORT_NOTIFY_CHANNEL_ID;
          const channel = await fetchNotifyChannel(channelId);
          if (!channel) continue;

          const t = templates.get('🎫 Ticket Opened');
          const openedBy = String(ev.opened_by_name || 'User').trim() || 'User';
          const panelName = String(ev.panel_name || 'Unknown').trim() || 'Unknown';
          const claimedBy = String(ev.claimed_by_name || 'Nobody').trim() || 'Nobody';

          const maybeDmAssignedUser = async () => {
            if (ev.action !== 'ticket.claim') return;
            if (!ev.creator_discord_id) return;
            try {
              const userDm = await client.users.fetch(String(ev.creator_discord_id));
              const tAssign = templates.get('👤 Ticket Assigned');
              const userTicketUrl = `${base}/ticket.html?id=${encodeURIComponent(publicId)}`;
              const agent = String(ev.claimed_by_name || ev.actor_name || 'Staff').trim() || 'Staff';
              if (tAssign) {
                const dmPayload = renderTemplate(tAssign, {
                  ticketUrl: userTicketUrl,
                  replacements: {
                    ID: publicId,
                    username: agent,
                  },
                  now: new Date(),
                });
                await userDm.send({
                  content: dmPayload.content,
                  embeds: dmPayload.embeds,
                  components: dmPayload.components,
                });
              } else {
                const embed = new EmbedBuilder()
                  .setTitle('Ticket Assigned')
                  .setDescription('Your ticket is now being handled by a support agent.')
                  .setColor(0x3484ff)
                  .addFields(
                    { name: 'Ticket ID', value: `\`\`${publicId}\`\``, inline: true },
                    { name: 'Assigned Agent', value: `\`\`${agent}\`\``, inline: true }
                  )
                  .setFooter({ text: new Date().toLocaleString('en-GB', { hour12: false }) });
                const row = new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setStyle(ButtonStyle.Link)
                    .setLabel('Open Ticket')
                    .setURL(userTicketUrl)
                );
                await userDm.send({ embeds: [embed], components: [row] });
              }
            } catch (err) {
              console.warn(`[discord] Ticket assigned DM failed: ${err.message}`);
            }
          };

          const payload = t
            ? renderTemplate(t, {
                ticketUrl: staffTicketUrl,
                replacements: {
                  ID: publicId,
                  'panel name': panelName,
                  username: openedBy,
                  'nobody/usernane': claimedBy,
                },
                now: new Date(),
              })
            : null;

          const msgId =
            state.ticket_open_message_ids &&
            state.ticket_open_message_ids[publicId]
              ? String(state.ticket_open_message_ids[publicId])
              : '';

          if (payload && msgId) {
            try {
              const existing = await channel.messages.fetch(msgId);
              if (existing) {
                await existing.edit({
                  content: payload.content,
                  embeds: payload.embeds,
                  components: payload.components,
                });
                await maybeDmAssignedUser();
                continue;
              }
            } catch {
              // If we can't fetch/edit (deleted message, perms, etc.), fall back to sending a new one.
            }
          }

          // No stored message (or edit failed): send a fresh opened embed and update mapping.
          if (payload) {
            const sent = await channel.send({
              content: payload.content,
              embeds: payload.embeds,
              components: payload.components,
            });
            state.ticket_open_message_ids = state.ticket_open_message_ids || {};
            state.ticket_open_message_ids[publicId] = String(sent.id);
            await saveBotState(state);
            await maybeDmAssignedUser();
          }
        }
      } catch (err) {
        console.warn(`[discord] Ticket event notify failed: ${err.message}`);
      }
    }

    state.last_audit_event_id = Math.max(...events.map((e) => e.id));
    await saveBotState(state);
  }

  async function registerSlashCommand() {
    if (!CONFIG.DISCORD_APP_ID) return;

    const linkCommand = new SlashCommandBuilder()
      .setName('link')
      .setDescription('Link your Payhip purchase to your Discord account');

    const claimCommand = new SlashCommandBuilder()
      .setName('claim')
      .setDescription('Claim your purchase with order ID and email')
      .addStringOption((opt) =>
        opt
          .setName('order_id')
          .setDescription('Your Payhip order ID')
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('email')
          .setDescription('Email used for the purchase')
          .setRequired(true)
      );

    const reprintCommand = new SlashCommandBuilder()
      .setName('reprint')
      .setDescription('Admin: resend receipt for a purchase')
      .addStringOption((opt) =>
        opt
          .setName('order_id')
          .setDescription('Payhip order ID')
          .setRequired(true)
      );

    const lookupCommand = new SlashCommandBuilder()
      .setName('lookup')
      .setDescription('Admin: lookup a Payhip order by ID')
      .addStringOption((opt) =>
        opt
          .setName('order_id')
          .setDescription('Payhip order ID')
          .setRequired(true)
      );

    const ticketCommand = new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('Open a support ticket in DMs');

    const botDebugCommand = new SlashCommandBuilder()
      .setName('botdebug')
      .setDescription(
        'Admin: view bot config/state and test notification channels'
      )
      .addStringOption((opt) =>
        opt
          .setName('action')
          .setDescription('Action to perform')
          .setRequired(false)
          .addChoices(
            { name: 'status', value: 'status' },
            { name: 'test_open_channel', value: 'test_open_channel' },
            { name: 'test_escalate_channel', value: 'test_escalate_channel' },
            { name: 'reset_event_cursor', value: 'reset_event_cursor' }
          )
      );

    const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_BOT_TOKEN);
    const data = [
      linkCommand.toJSON(),
      claimCommand.toJSON(),
      reprintCommand.toJSON(),
      lookupCommand.toJSON(),
      ticketCommand.toJSON(),
      botDebugCommand.toJSON(),
    ];

    if (CONFIG.DISCORD_COMMAND_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(
          CONFIG.DISCORD_APP_ID,
          CONFIG.DISCORD_COMMAND_GUILD_ID
        ),
        { body: data }
      );
      console.log('[discord] Registered guild commands');
    } else {
      await rest.put(Routes.applicationCommands(CONFIG.DISCORD_APP_ID), {
        body: data,
      });
      console.log('[discord] Registered global commands');
    }
  }

  async function updatePresence() {
    let memberCount = 0;
    try {
      const guild = await client.guilds.fetch(CONFIG.DISCORD_GUILD_ID);
      memberCount = guild?.memberCount || 0;
    } catch (err) {
      console.warn(`[discord] Presence update failed: ${err.message}`);
    }

    const presences = [
      { name: 'Watching orders...', type: 3 },
      { name: `Watching ${memberCount} members`, type: 3 },
      { name: 'Helping customers...', type: 0 },
    ];

    const next = presences[Math.floor(Math.random() * presences.length)];
    try {
      client.user.setPresence({
        status: 'online',
        activities: [{ name: next.name, type: next.type }],
      });
    } catch (err) {
      console.warn(`[discord] Presence set failed: ${err.message}`);
    }
  }

  client.once('clientReady', async () => {
    console.log(`[discord] Logged in as ${client.user.tag}`);
    try {
      await registerSlashCommand();
    } catch (err) {
      console.error(`[discord] Command registration failed: ${err.message}`);
    }

    await updatePresence();
    setInterval(updatePresence, 30 * 60 * 1000);

    if (supportApi.isBotAuthReady()) {
      syncStaffReplies().catch((err) => {
        console.warn(`[discord] Staff reply sync failed: ${err.message}`);
      });
      syncClaimedUserMessages().catch((err) => {
        console.warn(`[discord] Claimed message sync failed: ${err.message}`);
      });
      syncWebhookTicketEvents().catch((err) => {
        console.warn(`[discord] Webhook event sync failed: ${err.message}`);
      });
      setInterval(() => {
        syncStaffReplies().catch((err) => {
          console.warn(`[discord] Staff reply sync failed: ${err.message}`);
        });
      }, CONFIG.BOT_SYNC_INTERVAL_MS);
      setInterval(() => {
        syncClaimedUserMessages().catch((err) => {
          console.warn(`[discord] Claimed message sync failed: ${err.message}`);
        });
      }, CONFIG.BOT_SYNC_INTERVAL_MS);
      setInterval(() => {
        syncWebhookTicketEvents().catch((err) => {
          console.warn(`[discord] Webhook event sync failed: ${err.message}`);
        });
      }, CONFIG.BOT_SYNC_INTERVAL_MS);

      // Request-response pings (staff button).
      setInterval(() => {
        (async () => {
          const requests = await supportApi.requestResponsePings().catch(() => []);
          if (!Array.isArray(requests) || !requests.length) return;
          for (const r of requests) {
            const discordId = String(r.creator_discord_id || r.recipient_discord_id || '').trim();
            if (!discordId) continue;
            try {
              const user = await client.users.fetch(discordId);
              if (!user) continue;
              const base = (CONFIG.SUPPORT_API_BASE || CONFIG.BASE_URL || '').replace(/\/$/, '');
              const ticketUrl = `${base}/ticket.html?id=${encodeURIComponent(String(r.public_id || ''))}`;
              const template = templates.get('⏰ Response Requested');

              const requestedBy = String(r.requested_by_name || 'Staff').trim() || 'Staff';
              const lastUserAt = r.last_user_message_at ? Date.parse(r.last_user_message_at) : 0;
              const nowMs = Date.now();
              const elapsedMs = lastUserAt ? Math.max(0, nowMs - lastUserAt) : 0;
              const elapsedMinutes = Math.floor(elapsedMs / 60000);
              const elapsed =
                !lastUserAt
                  ? 'No previous reply'
                  : elapsedMinutes < 60
                      ? `${elapsedMinutes} minutes`
                      : `${Math.floor(elapsedMinutes / 60)} hours`;

              if (template) {
                const payload = renderTemplate(template, {
                  ticketUrl,
                  replacements: {
                    ID: String(r.public_id || ''),
                    username: requestedBy,
                    'elapsed time': elapsed,
                  },
                  now: new Date(),
                });
                await user.send({ embeds: payload.embeds, components: payload.components });
              } else {
                const embed = new EmbedBuilder()
                  .setTitle('Response requested')
                  .setDescription('A staff member has requested a response on your ticket.')
                  .setColor(0xfcb828)
                  .setFooter({ text: new Date().toLocaleString('en-GB', { hour12: false }) });
                const row = new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setStyle(ButtonStyle.Link)
                    .setLabel('Open ticket')
                    .setURL(ticketUrl)
                );
                await user.send({ embeds: [embed], components: [row] });
              }
              await supportApi.ackResponsePing(r.ticket_id);
            } catch {}
          }
        })().catch(() => null);
      }, Math.max(5000, Number(CONFIG.BOT_SYNC_INTERVAL_MS || 10000)));
    } else {
      console.warn(
        '[discord] Support API not configured; staff reply sync disabled.'
      );
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId !== 'ticket_panel') return;
      const panelId = Number(interaction.values[0] || 0) || null;
      if (!panelId) {
        return interaction.reply({
          content: 'Panel selection failed. Try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (!supportApi.isBotAuthReady()) {
        return interaction.reply({
          content: 'Support system is not configured.',
          flags: MessageFlags.Ephemeral,
        });
      }

      try {
        const ticket = await supportApi.createDiscordTicket({
          discordId: interaction.user.id,
          panelId,
          message: 'Ticket created via Discord.',
          subject: 'Discord support ticket',
        });

        return interaction.update({
          content: `Ticket ${ticket.public_id} created. Reply here with your issue.`,
          components: [],
        });
      } catch (err) {
        console.warn(`[discord] Ticket create failed: ${err.message}`);
        return interaction.update({
          content: 'Ticket creation failed. Please try again or use the website.',
          components: [],
        });
      }
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'botdebug') {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: 'This command can only be used in the server.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (!interaction.memberPermissions?.has('ManageGuild')) {
        return interaction.reply({
          content: 'You do not have permission to use this command.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const action = interaction.options.getString('action') || 'status';
      const state = await loadBotState();
      const base = (CONFIG.SUPPORT_API_BASE || CONFIG.BASE_URL || '').trim();
      const authReady = supportApi.isBotAuthReady();

      let apiProbe = '';
      if (authReady) {
        try {
          const ev = await supportApi.listWebhookEvents(0);
          apiProbe = `api_probe_events: ok (${Array.isArray(ev) ? ev.length : 0} events)`;
        } catch (err) {
          apiProbe = `api_probe_events: ${String(err?.message || err)}`;
        }
      } else {
        apiProbe = 'api_probe_events: skipped (auth not ready)';
      }

      let apiProbeClaimed = '';
      if (authReady) {
        try {
          const { messages } = await supportApi.listClaimedUserMessages(0);
          apiProbeClaimed = `api_probe_claimed_messages: ok (${Array.isArray(messages) ? messages.length : 0} messages)`;
        } catch (err) {
          apiProbeClaimed = `api_probe_claimed_messages: ${String(err?.message || err)}`;
        }
      } else {
        apiProbeClaimed = 'api_probe_claimed_messages: skipped (auth not ready)';
      }

      if (action === 'reset_event_cursor') {
        state.last_audit_event_id = null;
        await saveBotState(state);
      }

      const openChannelId =
        CONFIG.DISCORD_TICKET_OPEN_CHANNEL_ID ||
        CONFIG.DISCORD_SUPPORT_NOTIFY_CHANNEL_ID;
      const escalateChannelId =
        CONFIG.DISCORD_TICKET_ESCALATE_CHANNEL_ID ||
        CONFIG.DISCORD_SUPPORT_NOTIFY_CHANNEL_ID;

      async function testChannel(channelId, label) {
        if (!channelId) return `${label}: not set`;
        try {
          const ch = await client.channels.fetch(channelId);
          if (!ch) return `${label}: not found`;
          if (!ch.isTextBased()) return `${label}: not text-based`;
          await ch.send('Bot test: notification channel is reachable.');
          return `${label}: ok`;
        } catch (err) {
          return `${label}: error (${err.message})`;
        }
      }

      let testResult = '';
      if (action === 'test_open_channel') {
        testResult = await testChannel(openChannelId, 'open_channel');
      } else if (action === 'test_escalate_channel') {
        testResult = await testChannel(escalateChannelId, 'escalate_channel');
      }

      const lines = [
        `auth_ready: ${authReady}`,
        `support_api_base: ${base || '(empty)'}`,
        `bot_api_token_set: ${Boolean(CONFIG.BOT_API_TOKEN)}`,
        apiProbe,
        apiProbeClaimed,
        `notify_channel_default: ${CONFIG.DISCORD_SUPPORT_NOTIFY_CHANNEL_ID || '(empty)'}`,
        `ticket_open_channel: ${CONFIG.DISCORD_TICKET_OPEN_CHANNEL_ID || '(empty)'} (effective: ${openChannelId || '(empty)'})`,
        `ticket_escalate_channel: ${CONFIG.DISCORD_TICKET_ESCALATE_CHANNEL_ID || '(empty)'} (effective: ${escalateChannelId || '(empty)'})`,
        `last_staff_message_id: ${state.last_staff_message_id ?? '(null)'}`,
        `last_claimed_user_message_id: ${state.last_claimed_user_message_id ?? '(null)'}`,
        `last_audit_event_id: ${state.last_audit_event_id ?? '(null)'}`,
        testResult ? `test: ${testResult}` : null,
        action === 'reset_event_cursor' ? 'event cursor reset: done' : null,
      ].filter(Boolean);

      return interaction.reply({
        content: `\`\`\`\n${lines.join('\n')}\n\`\`\``,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.commandName === 'ticket') {
      if (!supportApi.isBotAuthReady()) {
        return interaction.reply({
          content: 'Support system is not configured.',
          flags: MessageFlags.Ephemeral,
        });
      }
      let panels = [];
      try {
        panels = await supportApi.listPanels();
      } catch (err) {
        console.warn(`[discord] Panel list failed: ${err.message}`);
        return interaction.reply({
          content: 'Unable to load support panels right now.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (panels.length === 0) {
        return interaction.reply({
          content: 'No ticket panels are configured yet.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (panels.length > 25) {
        return interaction.reply({
          content:
            'Too many panels are configured. Please open a ticket on the website.',
          flags: MessageFlags.Ephemeral,
        });
      }

      try {
        const dm = await interaction.user.createDM();
        const menu = new StringSelectMenuBuilder()
          .setCustomId('ticket_panel')
          .setPlaceholder('Select a support panel')
          .addOptions(
            panels.map((panel) => ({
              label: panel.name,
              description: panel.description?.slice(0, 90) || 'Support ticket',
              value: String(panel.id),
            }))
          );
        await dm.send({
          content: 'Select a panel to start your ticket.',
          components: [new ActionRowBuilder().addComponents(menu)],
        });
        return interaction.reply({
          content: 'Check your DMs to pick a panel.',
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        return interaction.reply({
          content:
            'I could not DM you. Please open your DMs or use the website.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (
      interaction.commandName !== 'link' &&
      interaction.commandName !== 'claim' &&
      interaction.commandName !== 'reprint' &&
      interaction.commandName !== 'lookup'
    ) {
      return;
    }

    try {
      const dbEnabled = payhip.isDbConfigured();
      const store = payhip.shouldWriteJson() ? payhip.loadStoreCached() : null;
      const purchasesById = store ? payhip.STORE_CACHE.indexes.byId : new Map();
      const purchasesForUser = dbEnabled
        ? await payhip.dbGetPurchasesByDiscordId(interaction.user.id)
        : store
            ? payhip.STORE_CACHE.indexes.byDiscord.get(interaction.user.id) || []
            : [];
      const pending = purchasesForUser.find((p) => !p.redeemed_at);
      const alreadyLinked = purchasesForUser.find((p) => p.redeemed_at);

      // Admin-only commands: do not require role assignment or member fetching.
      if (interaction.commandName === 'lookup' || interaction.commandName === 'reprint') {
        if (!interaction.inGuild()) {
          return interaction.reply({
            content: 'This command can only be used in the server.',
            flags: MessageFlags.Ephemeral,
          });
        }
        if (!interaction.memberPermissions?.has('ManageGuild')) {
          return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const orderId = interaction.options.getString('order_id', true).trim();
        const order = dbEnabled
          ? await payhip.dbGetPurchaseById(orderId)
          : purchasesById.get(orderId);

        if (!order) {
          return interaction.reply({
            content: `No order found for ID: ${orderId}`,
            flags: MessageFlags.Ephemeral,
          });
        }

        if (interaction.commandName === 'lookup') {
          const embed = payhip.buildOrderEmbedFromOrder(order);
          await payhip.attachDiscordThumbnail(embed, order.discord_id);
          return interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral,
          });
        }

        await payhip.sendReprintWebhookEmbed(order);
        if (order.discord_id) {
          await handleAutoRoleAndWelcome(order.discord_id);
        }
        return interaction.reply({
          content: `Receipt reprinted for order ${orderId}.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const guild = await client.guilds.fetch(CONFIG.DISCORD_GUILD_ID);
      let member;
      try {
        member = await guild.members.fetch(interaction.user.id);
      } catch {
        return interaction.reply({
          content: 'You need to join the server before I can assign your role.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const hasRole = member.roles.cache.has(CONFIG.DISCORD_ROLE_ID);

      if (interaction.commandName === 'link') {
        if (!pending) {
          if (alreadyLinked) {
            if (!hasRole) {
              await member.roles.add(CONFIG.DISCORD_ROLE_ID);
              console.log(
                `[discord] Role re-assigned to ${interaction.user.id} (already linked)`
              );
              return interaction.reply({
                content: 'Welcome back! Your role has been re-assigned.',
                flags: MessageFlags.Ephemeral,
              });
            }
            return interaction.reply({
              content: 'You are already linked.',
              flags: MessageFlags.Ephemeral,
            });
          }
          return interaction.reply({
            content:
              'No unpaid or unmatched purchase found for your Discord ID. Make sure you entered the correct ID at checkout.',
            flags: MessageFlags.Ephemeral,
          });
        }
      }

      let claimedOrder = null;
      if (interaction.commandName === 'claim') {
        const orderId = interaction.options.getString('order_id', true).trim();
        const email = interaction.options.getString('email', true).trim().toLowerCase();
        const order = dbEnabled
          ? await payhip.dbGetPurchaseById(orderId)
          : purchasesById.get(orderId);
        const emailMatches =
          order && String(order.email || '').trim().toLowerCase() === email;

        if (!order || !emailMatches) {
          return interaction.reply({
            content: 'Order ID and email did not match a paid purchase.',
            flags: MessageFlags.Ephemeral,
          });
        }

        order.discord_id = interaction.user.id;
        if (!order.redeemed_at) {
          order.redeemed_at = new Date().toISOString();
        }
        order.discord_user_id = interaction.user.id;
        if (dbEnabled) {
          await payhip.dbUpsertPurchase(order);
        }
        if (store) {
          payhip.saveStoreCached(store);
        }
        claimedOrder = order;
      }

      if (!hasRole) {
        await member.roles.add(CONFIG.DISCORD_ROLE_ID);
      }

      if (interaction.commandName === 'link' && pending) {
        pending.redeemed_at = new Date().toISOString();
        pending.discord_user_id = interaction.user.id;
        if (dbEnabled) {
          await payhip.dbUpsertPurchase(pending);
        }
        if (store) {
          payhip.saveStoreCached(store);
        }
      }

      const orderRef = pending || claimedOrder;
      console.log(
        `[discord] Role assigned via /${interaction.commandName} to ${interaction.user.id} for order ${orderRef?.transaction_id || 'unknown'}`
      );

      const responseMessage =
        interaction.commandName === 'claim'
          ? 'Thanks! Your purchase is linked and your role has been assigned.'
          : hasRole
              ? 'You are already linked. Your role is already assigned.'
              : 'Success! Your role has been assigned.';
      return interaction.reply({
        content: responseMessage,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      console.error(`[discord] /${interaction.commandName} failed: ${err.message}`);
      return interaction.reply({
        content:
          'Something went wrong while processing that command. Please contact support.',
        flags: MessageFlags.Ephemeral,
      });
    }
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.DM) return;
    if (!supportApi.isBotAuthReady()) {
      await message.channel.send('Support system is not configured.');
      return;
    }

    const contentRaw = String(message.content || '');
    const content = contentRaw.trim();
    if (!content && message.attachments.size === 0) return;

    const discordId = message.author.id;
    let publicId = null;
    let body = content;
    const match = body.match(/^#([A-Z0-9]{6,16})/i);
    if (match) {
      publicId = match[1].toUpperCase();
      body = body.replace(/^#([A-Z0-9]{6,16})\s*/i, '').trim();
    }

    const attachments = [...message.attachments.values()].map((attachment) => ({
      filename: attachment.name || 'attachment',
      url: attachment.url,
      mime_type: attachment.contentType || '',
      size_bytes: attachment.size || 0,
    }));

    if (!body && attachments.length) {
      body = 'Attachment';
    }
    if (!body) return;

    if (!publicId) {
      let tickets = [];
      try {
        tickets = await supportApi.listActiveDiscordTickets(discordId);
      } catch (err) {
        console.warn(`[discord] Ticket lookup failed: ${err.message}`);
        await message.channel.send(
          'Unable to load your open tickets. Please try again later.'
        );
        return;
      }

      if (tickets.length === 1) {
        publicId = tickets[0].public_id;
      } else if (tickets.length > 1) {
        const ids = tickets.map((t) => `#${t.public_id}`).join(', ');
        await message.channel.send(
          `You have multiple open tickets (${ids}). Reply with the ticket ID, e.g. #${tickets[0].public_id}.`
        );
        return;
      }
    }

    if (!publicId) {
      await message.channel.send(
        'No open ticket found. Use /ticket in the server or the website to start one.'
      );
      return;
    }

    try {
      await supportApi.sendDiscordTicketMessage(publicId, {
        discordId,
        message: body,
        attachments: attachments.length ? attachments : undefined,
      });
    } catch (err) {
      console.warn(`[discord] Ticket reply failed: ${err.message}`);
      const response = err.message.includes('404')
        ? 'Ticket not found. Please check the ID.'
        : 'Failed to send your reply. Please try again later.';
      await message.channel.send(response);
    }
  });

  if (payhip.isDbConfigured()) {
    try {
      await payhip.initPayhipDb();
      const store = payhip.loadStoreCached();
      await payhip.dbSeedFromJson(store);
    } catch (err) {
      console.warn(`[db] Init/seed failed: ${err.message}`);
    }
  }

  client.login(CONFIG.DISCORD_BOT_TOKEN).catch((err) => {
    console.error(`[discord] Login failed: ${err.message}`);
  });

  return {
    client,
    handleAutoRoleAndWelcome,
    sendSupportChannelMessage,
    sendTicketDmReply,
    sendTicketUpdateDm,
  };
}

function createDiscordStubs() {
  return {
    client: null,
    handleAutoRoleAndWelcome: async () => {},
    sendSupportChannelMessage: async () => {},
    sendTicketDmReply: async () => {},
    sendTicketUpdateDm: async () => {},
  };
}

module.exports = { startDiscordBot };
