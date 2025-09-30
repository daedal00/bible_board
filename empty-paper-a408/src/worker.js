// Worker: Weekly Reactors Leaderboard (single-file)
// - /interactions (POST): Discord slash commands (verifies with discord-interactions)
// - /register (GET, admin): register /leaderboard command (per-guild)
// - /cron-test (GET): quick local/dev scan (last 30 min) and post
// - scheduled(): weekly scan + post
//
// env vars/secrets required (set in wrangler.toml + wrangler secret):
//   SOURCE_CHANNEL_ID  (string, the #daily-reading-check channel)
//   POST_CHANNEL_ID    (string, where to post the leaderboard)
//   GUILD_ID           (string, your server id; used for per-guild command register)
//   DISCORD_PUBLIC_KEY (secret, from Dev Portal > General Information)
//   DISCORD_BOT_TOKEN  (secret, bot token)
//   DISCORD_APPLICATION_ID (secret or var; app id)
//   ADMIN_KEY          (secret; to guard /register endpoint)

import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';

const DISCORD_API = 'https://discord.com/api/v10';

/* ---------- low-level helpers ---------- */
async function dFetch(env, path, init = {}) {
	const url = `${DISCORD_API}${path}`;
	const headers = {
		Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
		'Content-Type': 'application/json',
	};
	return fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
}

/* ---------- scanning logic ---------- */
async function* iterateMessages(env, channelId, sinceTs) {
	let before;
	while (true) {
		const qs = new URLSearchParams({ limit: '100' });
		if (before) qs.set('before', before);
		const res = await dFetch(env, `/channels/${channelId}/messages?${qs.toString()}`);
		if (!res.ok) throw new Error(`Get messages failed: ${res.status}`);
		const batch = await res.json();
		if (!Array.isArray(batch) || batch.length === 0) break;

		for (const msg of batch) {
			const ts = Date.parse(msg.timestamp);
			if (ts < sinceTs) return;
			yield msg;
		}
		before = batch[batch.length - 1].id;
	}
}

async function getReactorsForMessage(env, channelId, messageId, reactionsSummary) {
	const users = new Set();
	if (!Array.isArray(reactionsSummary) || reactionsSummary.length === 0) return users;

	for (const r of reactionsSummary) {
		if (!r.count || !r.emoji) continue;
		// Unicode emoji: raw name, Custom emoji: name:id
		const emojiIdent = r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : encodeURIComponent(r.emoji.name);

		let after;
		while (true) {
			const qs = new URLSearchParams({ limit: '100' });
			if (after) qs.set('after', after);
			const res = await dFetch(env, `/channels/${channelId}/messages/${messageId}/reactions/${emojiIdent}?${qs.toString()}`);
			if (!res.ok) throw new Error(`Get reactions failed: ${res.status}`);
			const batch = await res.json(); // users
			for (const u of batch) if (!u.bot) users.add(u.id); // ignore bots
			if (batch.length < 100) break;
			after = batch[batch.length - 1].id;
		}
	}
	return users;
}

function topN(map, n = 10) {
	return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

// simpler: render mentions, avoids extra member lookups/rate limits
async function buildNameMap(_env, _guildId, userIds) {
	const names = new Map();
	for (const uid of userIds) names.set(uid, `<@${uid}>`);
	return names;
}

async function runScan(env, windowMs = 7 * 24 * 60 * 60 * 1000) {
	const source = env.SOURCE_CHANNEL_ID;
	if (!env.DISCORD_BOT_TOKEN || !source) throw new Error('Missing DISCORD_BOT_TOKEN or SOURCE_CHANNEL_ID');

	const sinceTs = Date.now() - windowMs;
	const points = new Map(); // userId -> points
	const seenUsers = new Set();

	for await (const msg of iterateMessages(env, source, sinceTs)) {
		if (!msg.reactions || msg.reactions.length === 0) continue;
		const reactors = await getReactorsForMessage(env, source, msg.id, msg.reactions);
		for (const uid of reactors) {
			points.set(uid, (points.get(uid) || 0) + 1); // 1 point per message reacted to
			seenUsers.add(uid);
		}
	}

	const names = await buildNameMap(env, env.GUILD_ID, seenUsers);
	const rows = topN(points, 10);
	return { rows, names, uniqueReactors: seenUsers.size };
}

async function postFancyLeaderboard(env, channelId, rows, nameLookup, meta) {
	const medal = (i) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•');
	const lines = rows.map(([uid, pts], i) => {
		const name = nameLookup.get(uid) || `User ${uid}`;
		return `${medal(i)} **${i + 1}. ${name}** — ${pts} pt${pts === 1 ? '' : 's'}`;
	});

	const embed = {
		title: '🏆 Weekly Reading Leaderboard',
		description: lines.join('\n') || 'No points this week.',
		color: 0x00b894,
		footer: { text: 'Scoring: 1 point per message you react to in #daily-reading-check' },
		timestamp: new Date().toISOString(),
		fields: meta ? [{ name: 'Unique reactors (7d)', value: String(meta.uniqueReactors ?? 0), inline: true }] : [],
	};

	const res = await dFetch(env, `/channels/${channelId}/messages`, {
		method: 'POST',
		body: JSON.stringify({ embeds: [embed] }),
	});
	if (!res.ok) throw new Error(`Post leaderboard failed: ${res.status} ${await res.text()}`);
}

/* ---------- command registration (per-guild) ---------- */
async function registerPerGuild(env) {
	const body = [
		{
			name: 'leaderboard',
			description: 'Show the top reactors in #daily-reading-check (last 7 days)',
			type: 1,
		},
	];
	const url = `/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.GUILD_ID}/commands`;
	const res = await dFetch(env, url, { method: 'PUT', body: JSON.stringify(body) });
	if (!res.ok) throw new Error(`Register failed: ${res.status} ${await res.text()}`);
}

/* ---------- worker entrypoints ---------- */
export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// Interactions endpoint (set this URL in the Dev Portal)
		if (url.pathname === '/interactions' && request.method === 'POST') {
			// Verify signature with discord-interactions
			const signature = request.headers.get('x-signature-ed25519');
			const timestamp = request.headers.get('x-signature-timestamp');
			const body = await request.arrayBuffer();

			const isValid = verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
			if (!isValid) return new Response('Bad request signature.', { status: 401 });

			const message = JSON.parse(new TextDecoder().decode(body));

			// PING -> PONG (Discord uses this to verify your endpoint)
			if (message.type === InteractionType.PING) {
				return Response.json({ type: InteractionResponseType.PONG });
			}

			// /leaderboard
			if (message.type === InteractionType.APPLICATION_COMMAND && message.data?.name?.toLowerCase() === 'leaderboard') {
				// Defer reply immediately (we need time to scan)
				const ack = Response.json({
					type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
				});

				// Do the heavy work asynchronously, then send a follow-up
				(async () => {
					try {
						const { rows, names, uniqueReactors } = await runScan(env);
						const medal = (i) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•');
						const lines = rows.map(([uid, pts], i) => {
							const name = names.get(uid) || `User ${uid}`;
							return `${medal(i)} **${i + 1}. ${name}** — ${pts} pt${pts === 1 ? '' : 's'}`;
						});
						const embed = {
							title: '🏆 Weekly Reading Leaderboard (last 7 days)',
							description: lines.join('\n') || 'No points this week.',
							color: 0xf1c40f,
							timestamp: new Date().toISOString(),
							footer: { text: 'Slash-triggered snapshot' },
							fields: [{ name: 'Unique reactors', value: String(uniqueReactors), inline: true }],
						};

						await fetch(`${DISCORD_API}/webhooks/${env.DISCORD_APPLICATION_ID}/${message.token}`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ embeds: [embed] }),
						});
					} catch (e) {
						await fetch(`${DISCORD_API}/webhooks/${env.DISCORD_APPLICATION_ID}/${message.token}`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ content: 'Failed to compute leaderboard.' }),
						});
					}
				})();

				return ack;
			}

			return new Response('Unknown interaction', { status: 400 });
		}

		// Admin: register the command (per-guild). Call with ?key=YOUR_ADMIN_KEY
		if (url.pathname === '/register' && request.method === 'GET') {
			if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) {
				return new Response('Forbidden', { status: 403 });
			}
			await registerPerGuild(env);
			return new Response('Registered /leaderboard (per-guild).');
		}

		// Dev helper: run a quick scan (30 minutes) and post to POST_CHANNEL_ID
		if (url.pathname === '/cron-test' && request.method === 'GET') {
			const { rows, names, uniqueReactors } = await runScan(env, 30 * 60 * 1000);
			await postFancyLeaderboard(env, env.POST_CHANNEL_ID, rows, names, { uniqueReactors });
			return new Response('ok');
		}

		return new Response('OK');
	},

	// Weekly post (set your cron in wrangler.toml)
	async scheduled(_event, env) {
		const { rows, names, uniqueReactors } = await runScan(env);
		await postFancyLeaderboard(env, env.POST_CHANNEL_ID, rows, names, { uniqueReactors });
	},
};
