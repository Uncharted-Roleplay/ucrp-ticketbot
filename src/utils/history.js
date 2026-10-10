/**
 * Ticket history for staff (/history): a user's past tickets, one ticket's
 * details and its stored transcript, read from the database. Works without the
 * web dashboard and without the ticket channel (e.g. with deleteOnClose).
 *
 * Everything is scoped by the staff rules: a member only sees tickets of types
 * they are staff for (client.isStaff(member, type)).
 */
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, escapeMarkdown,
} = require('discord.js');
const db = require('../database');
const { parseColor } = require('./embeds');
const { buildTranscriptFile } = require('./ticketActions');

const PAGE_SIZE   = 5;
const MAX_NOTES   = 5;
const NO_MENTIONS = { parse: [], users: [], roles: [] };

/** The type scope of a staff member for the history queries. */
function historyScope(client, member) {
  const types = client.config.ticketTypes ?? [];
  return {
    allowedTypes:      types.filter(type => client.isStaff(member, type)).map(type => type.codeName),
    includeOtherTypes: client.isStaff(member, null),
    configuredTypes:   types.map(type => type.codeName),
  };
}

/** True if the member may see this ticket row (same rule as historyScope). */
function canSeeTicket(client, member, ticket) {
  return client.isStaff(member, client.ticketTypeOf(ticket));
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const ts = (ms) => (ms ? `<t:${Math.floor(Number(ms) / 1000)}:f>` : null);
const clip = (text, max) => {
  const s = escapeMarkdown(String(text ?? '').trim());
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

function typeLabel(client, ticket) {
  const type = client.ticketTypeOf(ticket);
  return type ? `${type.emoji ? `${type.emoji} ` : ''}${type.name}` : ticket.type;
}

function statusLabel(client, ticket) {
  return ticket.status === 'open' ? client.t('history.statusOpen') : client.t('history.statusClosed');
}

function stars(rating) {
  const n = Number(rating);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? '⭐'.repeat(n) : null;
}

function transcriptButton(client, ticket) {
  return new ButtonBuilder()
    .setCustomId(`tb_histTranscript:${ticket.id}`)
    .setLabel(client.t('history.transcriptButton', { id: String(ticket.id) }))
    .setEmoji('📄')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!Number(ticket.has_transcript));
}

// ─── Views ────────────────────────────────────────────────────────────────────

/**
 * Page `page` (0-based) of a user's ticket history, as an interaction reply
 * payload. Out-of-range pages are clamped.
 */
async function buildHistoryPage(client, member, guildId, user, page = 0) {
  const scope = historyScope(client, member);
  let { total, rows } = await db.getTicketHistory(user.id, guildId, scope, { limit: PAGE_SIZE, offset: page * PAGE_SIZE });

  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  if (page >= pages) {
    page = pages - 1;
    ({ rows } = await db.getTicketHistory(user.id, guildId, scope, { limit: PAGE_SIZE, offset: page * PAGE_SIZE }));
  }

  const embed = new EmbedBuilder()
    .setTitle(client.t('history.title', { user: user.username }))
    .setColor(parseColor(client.config.mainColor))
    .setFooter({ text: client.t('history.footer', { page: String(page + 1), pages: String(pages), total: String(total) }) });

  if (rows.length === 0) {
    embed.setDescription(`${client.t('history.empty', { user: `<@${user.id}>` })}\n-# ${client.t('history.scopeNote')}`);
    return { embeds: [embed], components: [], allowedMentions: NO_MENTIONS };
  }

  embed.setDescription(`-# ${client.t('history.scopeNote')}`);
  for (const ticket of rows) {
    const lines = [`${client.t('history.opened')}: ${ts(ticket.created_at)}`];
    if (ticket.closed_at) {
      lines.push(`${client.t('history.closed')}: ${ts(ticket.closed_at)}${ticket.closed_by ? ` ${client.t('history.closedBy')} <@${ticket.closed_by}>` : ''}`);
    }
    if (ticket.claimed_by)   lines.push(`${client.t('history.claimedBy')}: <@${ticket.claimed_by}>`);
    if (ticket.close_reason) lines.push(`${client.t('history.reason')}: ${clip(ticket.close_reason, 150)}`);
    const rating = stars(ticket.rating);
    if (rating) lines.push(`${client.t('history.rating')}: ${rating}`);

    embed.addFields({
      name:  `#${ticket.id} • ${typeLabel(client, ticket)} • ${statusLabel(client, ticket)}`.slice(0, 256),
      value: lines.join('\n').slice(0, 1024),
    });
  }

  const components = [new ActionRowBuilder().addComponents(rows.map(ticket => transcriptButton(client, ticket)))];
  if (pages > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`tb_histPage:${user.id}:${page - 1}`)
        .setLabel(client.t('history.prev'))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`tb_histPage:${user.id}:${page + 1}`)
        .setLabel(client.t('history.next'))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page >= pages - 1),
    ));
  }

  return { embeds: [embed], components, allowedMentions: NO_MENTIONS };
}

/** Detail view of one ticket, or null if it does not exist / is out of scope. */
async function buildTicketDetail(client, member, guildId, ticketId) {
  const ticket = await db.getTicketHistoryEntry(ticketId, guildId);
  if (!ticket || !canSeeTicket(client, member, ticket)) return null;

  const none = client.t('history.none');
  const embed = new EmbedBuilder()
    .setTitle(client.t('history.detailTitle', { id: String(ticket.id), type: typeLabel(client, ticket) }).slice(0, 256))
    .setColor(parseColor(client.config.mainColor))
    .addFields(
      { name: client.t('history.openedBy'), value: `<@${ticket.creator_id}>`, inline: true },
      { name: client.t('history.status'),   value: statusLabel(client, ticket), inline: true },
      { name: client.t('history.priority'), value: client.t(`priorities.${ticket.priority}`), inline: true },
      { name: client.t('history.opened'),   value: ts(ticket.created_at) ?? none, inline: true },
      { name: client.t('history.closed'),   value: ts(ticket.closed_at) ?? none, inline: true },
      { name: client.t('history.closedBy'), value: ticket.closed_by ? `<@${ticket.closed_by}>` : none, inline: true },
      { name: client.t('history.claimedBy'), value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : none, inline: true },
      { name: client.t('history.reason'),   value: ticket.close_reason ? clip(ticket.close_reason, 1000) : none },
    );

  const rating = stars(ticket.rating);
  if (rating) {
    const comment = ticket.rating_comment ? `\n${clip(ticket.rating_comment, 900)}` : '';
    embed.addFields({ name: client.t('history.rating'), value: `${rating}${comment}` });
  }

  const notes = await db.getNotes(ticket.id);
  if (notes.length > 0) {
    const shown = notes.slice(-MAX_NOTES).map(n => `<@${n.author_id}> ${ts(n.created_at) ?? ''}: ${clip(n.content, 150)}`);
    if (notes.length > MAX_NOTES) shown.unshift(client.t('history.moreNotes', { count: String(notes.length - MAX_NOTES) }));
    embed.addFields({ name: client.t('history.notes'), value: shown.join('\n').slice(0, 1024) });
  }

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(transcriptButton(client, ticket))],
    allowedMentions: NO_MENTIONS,
  };
}

/**
 * Send a ticket's stored transcript to the requesting staff member (ephemeral)
 * and note the access in the log channel: transcripts contain players' private
 * conversations, so who read which one is recorded.
 */
async function sendTranscript(client, interaction, ticketId) {
  const ticket = await db.getTicketHistoryEntry(ticketId, interaction.guildId);
  if (!ticket || !canSeeTicket(client, interaction.member, ticket)) {
    return interaction.reply({ content: client.t('history.notFound', { id: String(ticketId) }), flags: MessageFlags.Ephemeral });
  }

  const html = await db.getTicketTranscript(ticket.id, interaction.guildId);
  if (!html) {
    return interaction.reply({ content: client.t('history.noTranscript', { id: String(ticket.id) }), flags: MessageFlags.Ephemeral });
  }

  const file = buildTranscriptFile(client, ticket, html);
  if (!file) {
    return interaction.reply({ content: client.t('history.transcriptTooLarge', { id: String(ticket.id) }), flags: MessageFlags.Ephemeral });
  }

  await interaction.reply({
    content: client.t('history.transcriptSent', { id: String(ticket.id) }),
    files:   [file],
    flags:   MessageFlags.Ephemeral,
  });

  if (client.config.logs && client.config.logsChannelId) {
    const logChannel = await interaction.guild.channels.fetch(client.config.logsChannelId).catch(() => null);
    await logChannel?.send({
      content: client.t('history.accessLog', {
        staff: `<@${interaction.user.id}>`,
        id:    String(ticket.id),
        type:  typeLabel(client, ticket),
        user:  `<@${ticket.creator_id}>`,
      }),
      allowedMentions: NO_MENTIONS,
    }).catch(() => null);
  }
  client.logger.info(`[History] ${interaction.user.tag} viewed the transcript of ticket #${ticket.id}`);
}

module.exports = {
  PAGE_SIZE,
  historyScope,
  canSeeTicket,
  buildHistoryPage,
  buildTicketDetail,
  sendTranscript,
};
