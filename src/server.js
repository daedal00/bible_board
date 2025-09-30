/**
 * The core server that runs on a Cloudflare worker.
 */

import { AutoRouter } from 'itty-router';
import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from 'discord-interactions';
import { AWW_COMMAND, INVITE_COMMAND, LEADERBOARD_COMMAND } from './commands.js';
import { getCuteUrl } from './reddit.js';
import { generateAndPostLeaderboard } from './leaderboard.js';
import { InteractionResponseFlags } from 'discord-interactions';

class JsonResponse extends Response {
  constructor(body, init) {
    const jsonBody = JSON.stringify(body);
    init = init || {
      headers: {
        'content-type': 'application/json;charset=UTF-8',
      },
    };
    super(jsonBody, init);
  }
}

const router = AutoRouter();

/**
 * A simple :wave: hello page to verify the worker is working.
 */
router.get('/', (request, env) => {
  return new Response(`👋 ${env.DISCORD_APPLICATION_ID}`);
});

/**
 * Admin route to register the leaderboard command
 */
router.get('/register', async (request, env) => {
  const key = request.query?.key;
  if (!key || key !== env.ADMIN_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const url = `https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.GUILD_ID}/commands`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(LEADERBOARD_COMMAND),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to register command: ${error}`);
    }

    return new Response('Command registered successfully!');
  } catch (error) {
    return new Response(`Failed to register command: ${error.message}`, {
      status: 500,
    });
  }
});

/**
 * Admin route to test the leaderboard generation with a 30-minute scan
 */
router.get('/cron-test', async (request, env) => {
  const key = request.query?.key;
  if (!key || key !== env.ADMIN_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const embed = await generateAndPostLeaderboard(env, 500); // Limit to 500 messages for quick test
    return new JsonResponse({
      message: 'Leaderboard test completed successfully!',
      embed,
    });
  } catch (error) {
    return new Response(`Failed to generate test leaderboard: ${error.message}`, {
      status: 500,
    });
  }
});

/**
 * Main route for all requests sent from Discord.  All incoming messages will
 * include a JSON payload described here:
 * https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object
 */
router.post('/', async (request, env) => {
  const { isValid, interaction } = await server.verifyDiscordRequest(
    request,
    env,
  );
  if (!isValid || !interaction) {
    return new Response('Bad request signature.', { status: 401 });
  }

  if (interaction.type === InteractionType.PING) {
    // The `PING` message is used during the initial webhook handshake, and is
    // required to configure the webhook in the developer portal.
    return new JsonResponse({
      type: InteractionResponseType.PONG,
    });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    // Most user commands will come as `APPLICATION_COMMAND`.
    switch (interaction.data.name.toLowerCase()) {
      case AWW_COMMAND.name.toLowerCase(): {
        const cuteUrl = await getCuteUrl();
        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: cuteUrl,
          },
        });
      }
      case INVITE_COMMAND.name.toLowerCase(): {
        const applicationId = env.DISCORD_APPLICATION_ID;
        const INVITE_URL = `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=applications.commands`;
        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: INVITE_URL,
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }
      case LEADERBOARD_COMMAND.name.toLowerCase(): {
        // First, acknowledge the command
        await fetch(
          `https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
            }),
          },
        );

        try {
          const embed = await generateAndPostLeaderboard(env);
          // Edit the original response
          await fetch(
            `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content: 'Leaderboard has been posted! 🎉',
                embeds: [embed],
              }),
            },
          );
        } catch (error) {
          console.error('Error generating leaderboard:', error);
          // Edit the original response with error
          await fetch(
            `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content: 'Failed to generate leaderboard. Please try again later.',
                flags: InteractionResponseFlags.EPHEMERAL,
              }),
            },
          );
        }
        return new Response(); // We've already handled the response
      }
      default:
        return new JsonResponse({ error: 'Unknown Type' }, { status: 400 });
    }
  }

  console.error('Unknown Type');
  return new JsonResponse({ error: 'Unknown Type' }, { status: 400 });
});
router.all('*', () => new Response('Not Found.', { status: 404 }));

async function verifyDiscordRequest(request, env) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();
  const isValidRequest =
    signature &&
    timestamp &&
    (await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY));
  if (!isValidRequest) {
    return { isValid: false };
  }

  return { interaction: JSON.parse(body), isValid: true };
}

/**
 * Handle scheduled tasks (cron)
 * @param {ScheduledEvent} event The scheduled event
 * @param {Object} env Environment variables
 */
async function scheduled(event, env) {
  try {
    await generateAndPostLeaderboard(env);
    console.log('Weekly leaderboard generated successfully');
  } catch (error) {
    console.error('Failed to generate weekly leaderboard:', error);
  }
}

const server = {
  verifyDiscordRequest,
  fetch: router.fetch,
  scheduled,
};

export default server;
