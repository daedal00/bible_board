/**
 * Functions for handling reactions leaderboard functionality.
 */

const DISCORD_API = 'https://discord.com/api/v10';
const MS_IN_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Generate a leaderboard embed from reaction data
 * @param {Map<string, number>} userPoints Map of user IDs to their points
 * @returns {Object} Discord embed object
 */
function generateLeaderboardEmbed(userPoints) {
  const sortedUsers = [...userPoints.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const fields = sortedUsers.map(([userId, points], index) => ({
    name: `#${index + 1}`,
    value: `<@${userId}> - ${points} points`,
    inline: false,
  }));

  return {
    title: '🏆 Weekly Reactors Leaderboard',
    description: 'Top 10 users who received reactions in the past week:',
    fields,
    color: 0xffd700, // Gold color
    timestamp: new Date().toISOString(),
  };
}

/**
 * Get messages from a channel within the last week
 * @param {string} channelId Channel to fetch messages from
 * @param {string} botToken Discord bot token
 * @param {number} limit Optional limit of messages to scan
 * @returns {Promise<Array>} Array of messages
 */
async function getRecentMessages(channelId, botToken, limit = 100) {
  const oneWeekAgo = new Date(Date.now() - MS_IN_WEEK);
  const messages = [];
  let lastId;

  while (true) {
    const url = new URL(`${DISCORD_API}/channels/${channelId}/messages`);
    url.searchParams.set('limit', '100');
    if (lastId) url.searchParams.set('before', lastId);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bot ${botToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch messages: ${response.statusText}`);
    }

    const batch = await response.json();
    if (batch.length === 0) break;

    // Stop if we hit messages older than a week
    const oldestInBatch = new Date(batch[batch.length - 1].timestamp);
    if (oldestInBatch < oneWeekAgo) {
      const recentInBatch = batch.filter(
        msg => new Date(msg.timestamp) >= oneWeekAgo,
      );
      messages.push(...recentInBatch);
      break;
    }

    messages.push(...batch);
    if (messages.length >= limit) {
      messages.length = limit;
      break;
    }

    lastId = batch[batch.length - 1].id;
  }

  return messages;
}

/**
 * Calculate points for each user based on reactions
 * @param {Array} messages Array of Discord message objects
 * @returns {Map<string, number>} Map of user IDs to their points
 */
function calculatePoints(messages) {
  const userPoints = new Map();

  for (const message of messages) {
    if (!message.reactions) continue;

    // Count one point per message that got any reactions
    if (message.reactions.length > 0) {
      const userId = message.author.id;
      userPoints.set(userId, (userPoints.get(userId) || 0) + 1);
    }
  }

  return userPoints;
}

/**
 * Post a leaderboard embed to a channel
 * @param {Object} embed The embed object to post
 * @param {string} channelId Channel to post to
 * @param {string} botToken Discord bot token
 */
async function postLeaderboard(embed, channelId, botToken) {
  const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!response.ok) {
    throw new Error(`Failed to post leaderboard: ${response.statusText}`);
  }
}

/**
 * Generate and post a leaderboard for the given time period
 * @param {Object} env Environment variables
 * @param {number} limit Optional limit of messages to scan
 */
export async function generateAndPostLeaderboard(env, limit) {
  const messages = await getRecentMessages(
    env.SOURCE_CHANNEL_ID,
    env.DISCORD_BOT_TOKEN,
    limit,
  );
  const userPoints = calculatePoints(messages);
  const embed = generateLeaderboardEmbed(userPoints);
  await postLeaderboard(embed, env.POST_CHANNEL_ID, env.DISCORD_BOT_TOKEN);
  return embed;
}