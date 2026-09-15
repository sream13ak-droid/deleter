const { Client, GatewayIntentBits, PermissionsBitField, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const express = require('express');
const axios = require('axios');

const config = {
    token: process.env.DISCORD_TOKEN,
    port: process.env.PORT || 3000,
    // ID власника бота. Тільки цей користувач може використовувати команди.
    ownerId: process.env.OWNER_ID || '721996501999550485',
    // Для команди /report
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    reportModel: process.env.REPORT_MODEL || 'claude-sonnet-5',
    reportMaxMessages: parseInt(process.env.REPORT_MAX_MESSAGES || '300', 10)
};

const app = express();

app.get('/', (req, res) => {
    res.json({
        status: 'Message Cleaner Bot активний',
        uptime: process.uptime(),
        botStatus: client.user ? client.user.presence.status : 'не підключений'
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Іноді interaction.guild приходить порожнім (кеш ще не прогрівся після рестарту,
// або сервер випав із кешу) — у такому разі довантажуємо guild напряму через API.
async function resolveGuild(interaction) {
    if (interaction.guild) return interaction.guild;

    if (!interaction.guildId) {
        console.error('resolveGuild: interaction.guildId відсутній (команда не з сервера?)');
        return null;
    }

    const cached = client.guilds.cache.get(interaction.guildId);
    if (cached) return cached;

    try {
        return await client.guilds.fetch(interaction.guildId);
    } catch (error) {
        console.error(`resolveGuild: не вдалося отримати guild ${interaction.guildId} (спроба 1): ${error.message}`);
        // Одна повторна спроба з невеликою затримкою — на випадок тимчасового збою Discord API
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
            return await client.guilds.fetch(interaction.guildId);
        } catch (retryError) {
            console.error(`resolveGuild: не вдалося отримати guild ${interaction.guildId} (спроба 2): ${retryError.message}`);
            return null;
        }
    }
}

async function resolveMe(guild) {
    if (guild.members.me) return guild.members.me;
    try {
        return await guild.members.fetchMe();
    } catch (error) {
        console.error(`resolveMe: не вдалося отримати member бота для guild ${guild.id}: ${error.message}`);
        return null;
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

async function cleanUserMessages(interaction, targetUserId, channelId = null) {
    try {
        await interaction.deferReply({ flags: [4096] });
        
        const guild = await resolveGuild(interaction);
        if (!guild) {
            return await interaction.editReply({
                content: 'Не вдалося визначити сервер для цієї команди. Спробуйте ще раз за кілька секунд.'
            });
        }

        const me = await resolveMe(guild);
        if (!me) {
            return await interaction.editReply({
                content: 'Не вдалося визначити бота на цьому сервері. Спробуйте ще раз за кілька секунд.'
            });
        }

        const targetUser = await client.users.fetch(targetUserId).catch(() => null);
        
        if (!targetUser) {
            return await interaction.editReply({
                content: 'Користувача з таким ID не знайдено!'
            });
        }

        let deletedCount = 0;
        let channelsProcessed = 0;
        const channels = channelId ? 
            [guild.channels.cache.get(channelId)] : 
            guild.channels.cache.filter(channel => 
                channel.isTextBased() && 
                channel.permissionsFor(me)?.has(PermissionsBitField.Flags.ReadMessageHistory)
            ).values();

        const progressEmbed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('Швидке видалення повідомлень...')
            .setDescription(`Початок видалення повідомлень користувача **${targetUser.tag}** (тільки < 14 днів)${channelId ? ` в каналі <#${channelId}>` : ' у всіх каналах'}`);
        
        await interaction.editReply({ embeds: [progressEmbed] });

        const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);

        for (const channel of channels) {
            if (!channel || !channel.isTextBased()) continue;
            
            try {
                const permissions = channel.permissionsFor(me);
                if (!permissions?.has([
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.ReadMessageHistory,
                    PermissionsBitField.Flags.ManageMessages
                ])) {
                    continue;
                }

                let lastMessageId = null;
                let channelDeleted = 0;

                while (true) {
                    const messages = await channel.messages.fetch({
                        limit: 100,
                        before: lastMessageId
                    });

                    if (messages.size === 0) break;

                    const oldestMessage = messages.last();
                    if (oldestMessage && oldestMessage.createdTimestamp < fourteenDaysAgo) {
                        const recentMessages = messages.filter(msg => 
                            msg.author.id === targetUserId && 
                            msg.createdTimestamp > fourteenDaysAgo
                        );
                        
                        if (recentMessages.size > 0) {
                            await processMessageBatch(recentMessages, channel);
                            deletedCount += recentMessages.size;
                            channelDeleted += recentMessages.size;
                        }
                        break;
                    }

                    const userMessages = messages.filter(msg => msg.author.id === targetUserId);
                    
                    if (userMessages.size === 0) {
                        lastMessageId = messages.last().id;
                        continue;
                    }

                    await processMessageBatch(userMessages, channel);
                    deletedCount += userMessages.size;
                    channelDeleted += userMessages.size;

                    lastMessageId = messages.last().id;
                    
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                if (channelDeleted > 0) {
                    channelsProcessed++;
                    console.log(`Канал ${channel.name}: видалено ${channelDeleted} повідомлень`);
                }

            } catch (error) {
                console.error(`Помилка обробки каналу ${channel.name}: ${error.message}`);
            }
        }

        const resultEmbed = new EmbedBuilder()
            .setColor(deletedCount > 0 ? '#00FF00' : '#FFA500')
            .setTitle('Швидке видалення завершено')
            .setDescription(`
                **Користувач:** ${targetUser.tag} (${targetUser.id})
                **Видалено повідомлень:** ${deletedCount}
                **Оброблено каналів:** ${channelsProcessed}
                **Область:** ${channelId ? `<#${channelId}>` : 'Всі канали'}
                
                *Використано bulk delete API (тільки повідомлення < 14 днів)*
            `)
            .setTimestamp();

        await interaction.editReply({ embeds: [resultEmbed] });

        console.log(`${interaction.user.tag} використав CLEAN: видалив ${deletedCount} повідомлень користувача ${targetUser.tag}`);

    } catch (error) {
        console.error('Помилка швидкого видалення повідомлень:', error);
        
        const errorEmbed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('Помилка')
            .setDescription(`Сталася помилка: ${error.message}`);

        await interaction.editReply({ embeds: [errorEmbed] }).catch(console.error);
    }
}

async function cleanAllUserMessages(interaction, targetUserId, channelId = null) {
    try {
        const guild = await resolveGuild(interaction);
        if (!guild) {
            return await interaction.editReply({
                content: 'Не вдалося визначити сервер для цієї команди. Спробуйте ще раз за кілька секунд.'
            });
        }

        const me = await resolveMe(guild);
        if (!me) {
            return await interaction.editReply({
                content: 'Не вдалося визначити бота на цьому сервері. Спробуйте ще раз за кілька секунд.'
            });
        }

        const targetUser = await client.users.fetch(targetUserId).catch(() => null);
        
        if (!targetUser) {
            return await interaction.editReply({
                content: 'Користувача з таким ID не знайдено!'
            });
        }

        let deletedCount = 0;
        let channelsProcessed = 0;
        let oldMessagesCount = 0;
        const channels = channelId ? 
            [guild.channels.cache.get(channelId)] : 
            guild.channels.cache.filter(channel => 
                channel.isTextBased() && 
                channel.permissionsFor(me)?.has(PermissionsBitField.Flags.ReadMessageHistory)
            ).values();

        const progressEmbed = new EmbedBuilder()
            .setColor('#FF6B35')
            .setTitle('Повне видалення повідомлень...')
            .setDescription(`Початок видалення ВСІХ повідомлень користувача **${targetUser.tag}** (включаючи старіші за 14 днів)${channelId ? ` в каналі <#${channelId}>` : ' у всіх каналах'}\n**Це може зайняти багато часу!**`);
        
        await interaction.editReply({ embeds: [progressEmbed] });

        const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);

        for (const channel of channels) {
            if (!channel || !channel.isTextBased()) continue;
            
            try {
                const permissions = channel.permissionsFor(me);
                if (!permissions?.has([
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.ReadMessageHistory,
                    PermissionsBitField.Flags.ManageMessages
                ])) {
                    continue;
                }

                let lastMessageId = null;
                let channelDeleted = 0;
                let channelOldDeleted = 0;

                while (true) {
                    const messages = await channel.messages.fetch({
                        limit: 100,
                        before: lastMessageId
                    });

                    if (messages.size === 0) break;

                    const userMessages = messages.filter(msg => msg.author.id === targetUserId);
                    
                    if (userMessages.size === 0) {
                        lastMessageId = messages.last().id;
                        continue;
                    }

                    const recentMessages = userMessages.filter(msg => msg.createdTimestamp > fourteenDaysAgo);
                    const oldMessages = userMessages.filter(msg => msg.createdTimestamp <= fourteenDaysAgo);

                    if (recentMessages.size > 0) {
                        await processMessageBatch(recentMessages, channel);
                        deletedCount += recentMessages.size;
                        channelDeleted += recentMessages.size;
                    }

                    if (oldMessages.size > 0) {
                        for (const message of oldMessages.values()) {
                            try {
                                await message.delete();
                                deletedCount++;
                                channelDeleted++;
                                channelOldDeleted++;
                                oldMessagesCount++;
                                
                                await new Promise(resolve => setTimeout(resolve, 1500));
                            } catch (deleteError) {
                                console.error(`Помилка видалення старого повідомлення: ${deleteError.message}`);
                            }
                        }
                    }

                    lastMessageId = messages.last().id;
                    
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    if (deletedCount % 50 === 0 && deletedCount > 0) {
                        const updateEmbed = new EmbedBuilder()
                            .setColor('#FF6B35')
                            .setTitle('Повне видалення у процесі...')
                            .setDescription(`
                                **Користувач:** ${targetUser.tag}
                                **Видалено:** ${deletedCount} повідомлень
                                **Старих повідомлень:** ${oldMessagesCount}
                                **Поточний канал:** ${channel.name}
                                **Область:** ${channelId ? `<#${channelId}>` : 'Всі канали'}
                                
                                *Процес триває...*
                            `);
                        
                        await interaction.editReply({ embeds: [updateEmbed] }).catch(() => {});
                    }
                }

                if (channelDeleted > 0) {
                    channelsProcessed++;
                    console.log(`Канал ${channel.name}: видалено ${channelDeleted} повідомлень (${channelOldDeleted} старих)`);
                }

            } catch (error) {
                console.error(`Помилка обробки каналу ${channel.name}: ${error.message}`);
            }
        }

        const resultEmbed = new EmbedBuilder()
            .setColor(deletedCount > 0 ? '#00FF00' : '#FFA500')
            .setTitle('Повне видалення завершено')
            .setDescription(`
                **Користувач:** ${targetUser.tag} (${targetUser.id})
                **Всього видалено:** ${deletedCount} повідомлень
                **Старих повідомлень (>14 днів):** ${oldMessagesCount}
                **Нових повідомлень (<14 днів):** ${deletedCount - oldMessagesCount}
                **Оброблено каналів:** ${channelsProcessed}
                **Область:** ${channelId ? `<#${channelId}>` : 'Всі канали'}
                
                *Використано комбіновану стратегію: bulk delete + індивідуальне видалення*
            `)
            .setTimestamp();

        await interaction.editReply({ embeds: [resultEmbed] });

        console.log(`${interaction.user.tag} використав CLEANALL: видалив ${deletedCount} повідомлень (${oldMessagesCount} старих) користувача ${targetUser.tag}`);

    } catch (error) {
        console.error('Помилка повного видалення повідомлень:', error);
        
        const errorEmbed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('Помилка')
            .setDescription(`Сталася помилка: ${error.message}`);

        await interaction.editReply({ embeds: [errorEmbed] }).catch(console.error);
    }
}

async function collectUserMessages(interaction, targetUserId, channelId = null, daysBack = 30) {
    const guild = await resolveGuild(interaction);
    if (!guild) {
        throw new Error('Не вдалося визначити сервер для цієї команди.');
    }

    const me = await resolveMe(guild);
    if (!me) {
        throw new Error('Не вдалося визначити бота на цьому сервері.');
    }

    const channels = channelId ?
        [guild.channels.cache.get(channelId)] :
        [...guild.channels.cache.filter(channel =>
            channel.isTextBased() &&
            channel.permissionsFor(me)?.has(PermissionsBitField.Flags.ReadMessageHistory)
        ).values()];

    const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
    const maxMessages = config.reportMaxMessages;
    const collected = [];

    for (const channel of channels) {
        if (!channel || !channel.isTextBased()) continue;
        if (collected.length >= maxMessages) break;

        try {
            let lastMessageId = null;
            let stop = false;

            while (!stop && collected.length < maxMessages) {
                const messages = await channel.messages.fetch({ limit: 100, before: lastMessageId });
                if (messages.size === 0) break;

                for (const msg of messages.values()) {
                    if (msg.createdTimestamp < cutoff) { stop = true; break; }

                    if (msg.author.id === targetUserId && msg.content && msg.content.trim().length > 0) {
                        collected.push({
                            channel: channel.name,
                            timestamp: msg.createdAt.toISOString(),
                            content: msg.content.slice(0, 500)
                        });
                        if (collected.length >= maxMessages) break;
                    }
                }

                lastMessageId = messages.last().id;
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (error) {
            console.error(`Помилка збору повідомлень з каналу ${channel.name}: ${error.message}`);
        }
    }

    collected.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return collected;
}

async function generateModerationReport(messages, targetUser) {
    if (messages.length === 0) {
        return 'За вказаний період повідомлень користувача не знайдено.';
    }

    const transcript = messages
        .map(m => `[${m.timestamp} | #${m.channel}] ${m.content}`)
        .join('\n')
        .slice(0, 15000);

    const systemPrompt = `Ти — асистент модерації закритої Discord-спільноти (ветеранський проєкт). Тобі дають транскрипт повідомлень ОДНОГО користувача за певний період.

Склади короткий фактологічний звіт СУВОРО на основі того, що написано в повідомленнях:
1. Загальна активність (кількість повідомлень, канали, періоди активності)
2. Тон спілкування — лише на основі формулювань у тексті (спокійний / конфліктний / нейтральний)
3. Ознаки порушення правил спільноти, якщо є: спам, флуд, образи, погрози, підозрілі посилання, провокації — з короткими цитатами-прикладами (до 15 слів кожна)
4. Динаміка за часом: чи є ознаки ескалації

СУВОРО ЗАБОРОНЕНО:
- Робити висновки про психічний стан, ставити діагнози, визначати тип особистості (MBTI тощо)
- Припускати політичні погляди, релігію, сексуальну орієнтацію, стать, етнічне походження
- Робити висновки про людину поза межами того, що вона написала в чаті
- Подавати припущення як факти

Якщо ознак порушень немає — так і напиши, без драматизації. Формат — стислий, структурований, українською мовою.`;

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
        model: config.reportModel,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [
            { role: 'user', content: `Транскрипт повідомлень користувача ${targetUser.tag} (${targetUser.id}):\n\n${transcript}` }
        ]
    }, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.anthropicApiKey,
            'anthropic-version': '2023-06-01'
        }
    });

    return response.data.content.map(block => block.text || '').join('\n').trim();
}

async function processMessageBatch(messages, channel) {
    if (messages.size > 1) {
        try {
            await channel.bulkDelete(messages);
        } catch (error) {
            for (const message of messages.values()) {
                try {
                    await message.delete();
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (deleteError) {
                    console.error(`Помилка видалення повідомлення: ${deleteError.message}`);
                }
            }
        }
    } else if (messages.size === 1) {
        try {
            await messages.first().delete();
        } catch (error) {
            console.error(`Помилка видалення повідомлення: ${error.message}`);
        }
    }
}

const commands = [
    new SlashCommandBuilder()
        .setName('clean')
        .setDescription('Швидко видалити повідомлення користувача (тільки останні 14 днів)')
        .addStringOption(option =>
            option.setName('userid')
                .setDescription('ID користувача Discord')
                .setRequired(true)
        )
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('Конкретний канал (якщо не вказано - всі канали)')
                .setRequired(false)
        ),
    
    new SlashCommandBuilder()
        .setName('cleanall')
        .setDescription('Видалити ВСІ повідомлення користувача (включаючи старіші за 14 днів)')
        .addStringOption(option =>
            option.setName('userid')
                .setDescription('ID користувача Discord')
                .setRequired(true)
        )
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('Конкретний канал (якщо не вказано - всі канали)')
                .setRequired(false)
        ),
    
    new SlashCommandBuilder()
        .setName('report')
        .setDescription('Аналітичний звіт по повідомленнях користувача (тільки для власника)')
        .addStringOption(option =>
            option.setName('userid')
                .setDescription('ID користувача Discord')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option.setName('days')
                .setDescription('За скільки останніх днів аналізувати (за замовчуванням 30)')
                .setRequired(false)
        )
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('Конкретний канал (якщо не вказано - всі канали)')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('clear-info')
        .setDescription('Інформація про команди бота')
];

client.once('ready', async () => {
    console.log(`Message Cleaner Bot ${client.user.tag} готовий!`);
    
    try {
        await client.application.commands.set(commands);
        console.log('Slash команди зареєстровані');
    } catch (error) {
        console.error('Помилка реєстрації команд:', error);
    }
    
    client.user.setActivity('Очищення повідомлень', { type: 'WATCHING' });
    client.user.setStatus('online');
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // Перевірка власника: якщо ID користувача не збігається з ownerId —
    // команда нічого не робить (без відповіді, без логів, тиша).
    if (interaction.user.id !== config.ownerId) {
        return;
    }

    const { commandName } = interaction;

    if (commandName === 'clean') {
        const targetUserId = interaction.options.getString('userid');
        const targetChannel = interaction.options.getChannel('channel');
        
        if (!/^\d{17,19}$/.test(targetUserId)) {
            return await interaction.reply({
                content: 'Невірний формат ID користувача! ID повинен містити 17-19 цифр.',
                flags: [4096]
            });
        }

        if (targetUserId === client.user.id) {
            return await interaction.reply({
                content: 'Неможливо видалити повідомлення самого бота!',
                flags: [4096]
            });
        }

        if (targetUserId === interaction.user.id) {
            return await interaction.reply({
                content: 'Використовуйте стандартні засоби Discord для видалення власних повідомлень!',
                flags: [4096]
            });
        }

        await cleanUserMessages(interaction, targetUserId, targetChannel?.id);
    }
    
    else if (commandName === 'cleanall') {
        const targetUserId = interaction.options.getString('userid');
        const targetChannel = interaction.options.getChannel('channel');
        
        if (!/^\d{17,19}$/.test(targetUserId)) {
            return await interaction.reply({
                content: 'Невірний формат ID користувача! ID повинен містити 17-19 цифр.',
                flags: [4096]
            });
        }

        if (targetUserId === client.user.id) {
            return await interaction.reply({
                content: 'Неможливо видалити повідомлення самого бота!',
                flags: [4096]
            });
        }

        if (targetUserId === interaction.user.id) {
            return await interaction.reply({
                content: 'Використовуйте стандартні засоби Discord для видалення власних повідомлень!',
                flags: [4096]
            });
        }

        const warningEmbed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('УВАГА!')
            .setDescription(`
                Ви збираєтеся видалити **ВСІ** повідомлення користувача!
                
                **Це включає:**
                - Повідомлення новіші за 14 днів (швидко)
                - Повідомлення старіші за 14 днів (повільно)
                
                **Область:** ${targetChannel ? `<#${targetChannel.id}>` : 'Всі канали'}
                **Процес може зайняти дуже багато часу!**
                
                Продовжити?
            `);

        await interaction.reply({ 
            embeds: [warningEmbed], 
            flags: [4096]
        });
        
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        await cleanAllUserMessages(interaction, targetUserId, targetChannel?.id);
    }
    
    else if (commandName === 'report') {
        const targetUserId = interaction.options.getString('userid');
        const targetChannel = interaction.options.getChannel('channel');
        const days = interaction.options.getInteger('days') || 30;

        if (!/^\d{17,19}$/.test(targetUserId)) {
            return await interaction.reply({
                content: 'Невірний формат ID користувача! ID повинен містити 17-19 цифр.',
                flags: [4096]
            });
        }

        if (!config.anthropicApiKey) {
            return await interaction.reply({
                content: 'ANTHROPIC_API_KEY не налаштований на сервері. Додайте змінну середовища, щоб ця команда працювала.',
                flags: [4096]
            });
        }

        await interaction.deferReply({ flags: [4096] });

        const targetUser = await client.users.fetch(targetUserId).catch(() => null);
        if (!targetUser) {
            return await interaction.editReply({ content: 'Користувача з таким ID не знайдено!' });
        }

        await interaction.editReply({ content: `Збираю повідомлення користувача **${targetUser.tag}** за останні ${days} днів...` });

        try {
            const messages = await collectUserMessages(interaction, targetUserId, targetChannel?.id, days);
            await interaction.editReply({ content: `Зібрано ${messages.length} повідомлень. Генерую звіт...` });

            const reportText = await generateModerationReport(messages, targetUser);

            // Discord обмежує опис embed до 4096 символів — розбиваємо, якщо звіт довший
            const chunks = reportText.match(/[\s\S]{1,3900}/g) || ['Звіт порожній.'];

            const embeds = chunks.slice(0, 10).map((chunk, i) =>
                new EmbedBuilder()
                    .setColor('#8A2BE2')
                    .setTitle(i === 0 ? `Звіт: ${targetUser.tag} (${targetUser.id})` : `Звіт (продовження ${i + 1})`)
                    .setDescription(chunk)
                    .setFooter({ text: `Період: ${days} днів · Проаналізовано повідомлень: ${messages.length}` })
                    .setTimestamp()
            );

            await interaction.editReply({ content: null, embeds });

            console.log(`${interaction.user.tag} згенерував REPORT по користувачу ${targetUser.tag} (${messages.length} повідомлень, ${days} днів)`);

        } catch (error) {
            console.error('Помилка генерації звіту:', error.response?.data || error.message);
            await interaction.editReply({
                content: `Сталася помилка при генерації звіту: ${error.response?.data?.error?.message || error.message}`
            });
        }
    }

    else if (commandName === 'clear-info') {
        const infoEmbed = new EmbedBuilder()
            .setColor('#0099FF')
            .setTitle('Message Cleaner Bot')
            .setDescription('Бот для видалення повідомлень користувачів з двома режимами')
            .addFields(
                {
                    name: '/clean',
                    value: '**Швидке видалення** повідомлень молодших за 14 днів\n- Використовує bulk delete API\n- Дуже швидко\n- Обмеження Discord API'
                },
                {
                    name: '/cleanall',
                    value: '**Повне видалення** ВСІХ повідомлень користувача\n- Видаляє і старі (>14 днів), і нові (<14 днів)\n- Повільно для старих повідомлень\n- Може зайняти багато часу'
                },
                {
                    name: '/report',
                    value: '**Аналітичний звіт** по повідомленнях користувача за AI\n- Активність, тон, ознаки порушень\n- Тільки для власника, приватна відповідь'
                },
                {
                    name: '/clear-info',
                    value: 'Показати цю довідку'
                },
                {
                    name: 'Права доступу',
                    value: 'Команди доступні лише власнику бота (за ID)'
                },
                {
                    name: 'Застереження',
                    value: 'Всі операції незворотні! Використовуйте обережно.'
                },
                {
                    name: 'Рекомендації',
                    value: '- Використовуйте `/clean` для швидкого видалення\n- Використовуйте `/cleanall` тільки якщо потрібно видалити старі повідомлення\n- `/cleanall` може працювати годинами для активних користувачів'
                }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [infoEmbed], flags: [4096] });
    }
});

client.on('error', console.error);

process.on('unhandledRejection', (reason, promise) => {
    console.error('Необроблена помилка Promise:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Необроблена помилка:', error);
});

app.listen(config.port, () => {
    console.log(`Express сервер запущено на порті ${config.port}`);
});

client.login(config.token);
