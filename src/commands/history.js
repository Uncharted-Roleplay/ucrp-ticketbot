/**
 * Command: /history
 * Staff look up a user's past tickets or one ticket by number, with its stored
 * transcript. Results are limited to the ticket types the member handles.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildHistoryPage, buildTicketDetail } = require('../utils/history');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('history')
    .setDescription('Show past tickets of a user, or one ticket by number.')
    .addUserOption(opt =>
      opt.setName('user')
         .setDescription('Whose tickets to list')
         .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('ticket')
         .setDescription('Ticket number to show')
         .setMinValue(1)
         .setRequired(false)
    ),

  async execute(client, interaction) {
    if (!client.isAnyStaff(interaction.member)) {
      return interaction.reply({ content: client.t('messages.onlyStaff'), flags: MessageFlags.Ephemeral });
    }

    const ticketId = interaction.options.getInteger('ticket');
    const user     = interaction.options.getUser('user');

    if (ticketId) {
      const detail = await buildTicketDetail(client, interaction.member, interaction.guildId, ticketId);
      if (!detail) {
        return interaction.reply({ content: client.t('history.notFound', { id: String(ticketId) }), flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ ...detail, flags: MessageFlags.Ephemeral });
    }

    if (user) {
      const page = await buildHistoryPage(client, interaction.member, interaction.guildId, user, 0);
      return interaction.reply({ ...page, flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({ content: client.t('history.needTarget'), flags: MessageFlags.Ephemeral });
  },
};
