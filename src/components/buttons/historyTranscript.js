/**
 * Button: tb_histTranscript:{ticketId}
 * Sends a ticket's stored transcript to the staff member (ephemeral) and logs
 * the access in the log channel.
 */
const { MessageFlags } = require('discord.js');
const { sendTranscript } = require('../../utils/history');

module.exports = {
  customId: 'tb_histTranscript',

  async execute(client, interaction) {
    if (!client.isAnyStaff(interaction.member)) {
      return interaction.reply({ content: client.t('messages.onlyStaff'), flags: MessageFlags.Ephemeral });
    }

    const ticketId = parseInt(interaction.customId.split(':')[1], 10);
    if (!Number.isInteger(ticketId) || ticketId < 1) {
      return interaction.reply({ content: client.t('history.notFound', { id: '?' }), flags: MessageFlags.Ephemeral });
    }

    // Type scope is checked inside sendTranscript.
    return sendTranscript(client, interaction, ticketId);
  },
};
