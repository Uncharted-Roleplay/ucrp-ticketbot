/**
 * Button: tb_histPage:{userId}:{page}
 * Previous / next page of a /history list (edits the ephemeral reply).
 */
const { MessageFlags } = require('discord.js');
const { buildHistoryPage } = require('../../utils/history');

module.exports = {
  customId: 'tb_histPage',

  async execute(client, interaction) {
    // Re-checked on every page: roles may have changed since /history ran.
    if (!client.isAnyStaff(interaction.member)) {
      return interaction.reply({ content: client.t('messages.onlyStaff'), flags: MessageFlags.Ephemeral });
    }

    const [, userId, pageStr] = interaction.customId.split(':');
    const page = Math.max(parseInt(pageStr, 10) || 0, 0);
    if (!/^\d{17,20}$/.test(userId ?? '')) {
      return interaction.reply({ content: client.t('history.needTarget'), flags: MessageFlags.Ephemeral });
    }

    const user = await client.users.fetch(userId).catch(() => ({ id: userId, username: userId }));
    const view = await buildHistoryPage(client, interaction.member, interaction.guildId, user, page);
    return interaction.update(view);
  },
};
