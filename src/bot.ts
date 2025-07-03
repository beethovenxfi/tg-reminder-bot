import { Bot, Context } from 'grammy';
import { createPublicClient, http, getContract, Address } from 'viem';
import { mainnet } from 'viem/chains';
import fs from 'fs';
import { AllConfig } from './types';
import dotenv from 'dotenv';
dotenv.config();

// === Config ===
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const RPC_URL = 'https://rpc.soniclabs.com';
const bot = new Bot<Context>(TOKEN);

const client = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL),
});

const GAUGE_ABI = [
    {
        type: 'function',
        name: 'reward_count',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'uint256' }],
    },
    {
        type: 'function',
        name: 'reward_tokens',
        stateMutability: 'view',
        inputs: [{ type: 'uint256' }],
        outputs: [{ type: 'address' }],
    },
    {
        type: 'function',
        name: 'reward_data',
        stateMutability: 'view',
        inputs: [{ type: 'address' }],
        outputs: [
            { type: 'address', name: 'distributor' },
            { type: 'uint256', name: 'period_finish' },
            { type: 'uint256', name: 'rate' },
            { type: 'uint256', name: 'last_update' },
            { type: 'uint256', name: 'integral' },
        ],
    },
];

// === Helpers ===
const CONFIG_FILE = './config.json';
let config: AllConfig = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};

const saveConfig = () => {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
};

const log = (...args: any[]) => {
    console.log(`[${new Date().toISOString()}]`, ...args);
};

const error = (...args: any[]) => {
    console.error(`[${new Date().toISOString()}] ERROR:`, ...args);
};

const isValidAddress = (addr: string) => /^0x[a-fA-F0-9]{40}$/.test(addr);

// === /add_gauge_reminder ===
bot.command('add_gauge_reminder', async (ctx) => {
    const args = ctx.message?.text?.split(' ');
    if (!args || args.length < 5) {
        return ctx.reply('❌ Usage: /add_gauge_reminder <gaugeAddress> <rewardToken> <hoursBefore> <usernameToPing>');
    }

    const [_, gaugeAddress, rewardToken, hoursBeforeStr, userToPing] = args;

    if (!isValidAddress(gaugeAddress) || !isValidAddress(rewardToken)) {
        return ctx.reply('❌ Invalid gauge or reward token address.');
    }

    const hoursBefore = parseInt(hoursBeforeStr, 10);
    if (isNaN(hoursBefore) || hoursBefore <= 0) {
        return ctx.reply('❌ Invalid hoursBefore value.');
    }

    const gauge = getContract({
        address: gaugeAddress as Address,
        abi: GAUGE_ABI,
        client,
    });

    try {
        const rewardCount = await gauge.read.reward_count();
        let tokenFound = false;
        for (let i = 0; i < Number(rewardCount); i++) {
            const tokenAddr = (await gauge.read.reward_tokens([BigInt(i)])) as `0x${string}`;
            if (tokenAddr.toLowerCase() === rewardToken.toLowerCase()) {
                tokenFound = true;
                break;
            }
        }
        if (!tokenFound) {
            return ctx.reply('❌ Token not found in gauge.');
        }

        // Also check when it will run out:
        const rewardData = (await gauge.read.reward_data([rewardToken as Address])) as any;
        const periodFinish = BigInt(rewardData[1]);
        const now = BigInt(Math.floor(Date.now() / 1000));
        const secondsLeft = Number(periodFinish - now);
        const hoursLeft = secondsLeft / 3600;

        const chatId = String(ctx.chat?.id);
        if (!config[chatId]) config[chatId] = { gauges: [] };
        config[chatId].gauges.push({
            gaugeAddress,
            rewardToken,
            hoursBefore,
            userToPing,
        });
        saveConfig();

        await ctx.reply(
            `✅ Gauge added!\n` +
                `Will alert @${userToPing} ${hoursBefore}h before rewards run out.\n\n` +
                `⏰ Current estimate: rewards run out in ~${hoursLeft.toFixed(2)} hours.`,
        );
        log(`Added gauge for chat ${chatId}:`, gaugeAddress, rewardToken);
    } catch (err) {
        error(`Failed to validate gauge ${gaugeAddress}:`, err);
        return ctx.reply('❌ Could not read gauge contract.');
    }
});

bot.command('remove_gauge_reminder', async (ctx) => {
    const chatId = String(ctx.chat?.id);
    if (!ctx.message?.text) return;

    const args = ctx.message.text.split(' ').slice(1); // remove command itself
    if (args.length < 2) {
        await ctx.reply('❌ Usage: /remove_gauge_reminder <gaugeAddress> <rewardToken>');
        return;
    }

    const [gaugeAddress, rewardToken] = args;

    if (!isValidAddress(gaugeAddress) || !isValidAddress(rewardToken)) {
        await ctx.reply('❌ Invalid gauge or reward token address.');
        return;
    }

    if (!config[chatId]?.gauges || config[chatId].gauges.length === 0) {
        await ctx.reply('❌ No gauges found to remove.');
        return;
    }

    const initialLength = config[chatId].gauges.length;
    config[chatId].gauges = config[chatId].gauges.filter(
        (g) =>
            g.gaugeAddress.toLowerCase() !== gaugeAddress.toLowerCase() ||
            g.rewardToken.toLowerCase() !== rewardToken.toLowerCase(),
    );

    if (config[chatId].gauges.length === initialLength) {
        await ctx.reply('❌ Gauge with specified reward token not found.');
        return;
    }

    saveConfig();
    await ctx.reply(`✅ Gauge ${gaugeAddress} with reward token ${rewardToken} removed successfully.`);
    log(`Removed gauge for chat ${chatId}: ${gaugeAddress} ${rewardToken}`);
});

bot.command('list_gauge_reminders', async (ctx) => {
    const chatId = String(ctx.chat.id);

    if (!config[chatId] || config[chatId].gauges.length === 0) {
        await ctx.reply(`ℹ️ No gauge reminders set for this group.`);
        return;
    }

    const lines = config[chatId].gauges.map((gauge, i) => {
        return `#${i + 1}  
Gauge: \`${gauge.gaugeAddress}\`
Reward Token: \`${gauge.rewardToken}\`
Hours Before: ${gauge.hoursBefore}h
User to Ping: @${gauge.userToPing}`;
    });

    await ctx.reply(`📋 *Active Gauge Reminders:*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
});

// === /help ===
bot.command('help', (ctx) => {
    return ctx.reply(
        `Usage:\n` +
            `/add_gauge_reminder <gaugeAddress> <rewardToken> <hoursBefore> <usernameToPing>\n\n` +
            `/remove_gauge_reminder <gaugeAddress> <rewardToken>\n\n` +
            `/list_gauge_reminders\n\n` +
            `Example:\n/add_gauge_reminder 0xGauge... 0xToken... 24 myusername`,
    );
});

// === Run checker once ===
export async function runCheckerOnce() {
    log(`Starting single gauge check run...`);
    const now = Math.floor(Date.now() / 1000);

    for (const [chatId, group] of Object.entries(config)) {
        for (const gaugeCfg of group.gauges) {
            try {
                const gauge = getContract({
                    address: gaugeCfg.gaugeAddress as Address,
                    abi: GAUGE_ABI,
                    client,
                });

                const rewardData = (await gauge.read.reward_data([gaugeCfg.rewardToken as Address])) as [
                    string,
                    bigint,
                    bigint,
                    bigint,
                    bigint,
                ];
                const periodFinish = BigInt(rewardData[1]);
                const secondsLeft = Number(periodFinish) - now;
                const hoursLeft = secondsLeft / 3600;

                log(`Gauge ${gaugeCfg.gaugeAddress} Token ${gaugeCfg.rewardToken}: ${hoursLeft.toFixed(2)}h left.`);

                if (hoursLeft <= gaugeCfg.hoursBefore) {
                    const msg =
                        `⚠️ Rewards for token ${gaugeCfg.rewardToken} on gauge ${
                            gaugeCfg.gaugeAddress
                        } will run out in ${hoursLeft.toFixed(2)} hours!\n\n` +
                        `@${gaugeCfg.userToPing} please top up the rewards:\n` +
                        `1. Approve the gauge as spender for your reward token.\n` +
                        `2. Call deposit_reward_token(token, amount) on the gauge contract.`;

                    await bot.api.sendMessage(chatId, msg);
                    log(`Sent alert to chat ${chatId} for user ${gaugeCfg.userToPing}`);
                }
            } catch (err) {
                error(`Error checking gauge ${gaugeCfg.gaugeAddress}:`, err);
            }
        }
    }

    log(`Gauge check run completed.`);
}

// === Register commands (shows in "/" menu) ===
// await bot.api.setMyCommands([
//   {
//     command: "add_gauge_reminder",
//     description:
//       "Add a new gauge reminder: <gauge> <token> <hoursBefore> <username>",
//   },
//   {
//     command: "help",
//     description: "Show usage help",
//   },
// ]);

// === Run checker once if env set ===
if (process.env.RUN_ONCE === 'true') {
    runCheckerOnce().then(() => {
        log('Done.');
        process.exit(0);
    });
} else {
    // === Start polling ===
    bot.start();
    log('Bot started with grammY');
}
