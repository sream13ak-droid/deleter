const { Client, GatewayIntentBits, PermissionsBitField, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const express = require('express');

const config = {
    token: process.env.DISCORD_TOKEN,
    port: process.env.PORT || 3000,
    allowedUsers: process.env.ALLOWED_USERS ? 
        process.env.ALLOWED_USERS.split(',') : 
        ['721996501999550485']
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

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

async function cleanUserMessages(interaction, targetUserId, channelId = null) {
    try {
        await interaction.deferReply({ flags: [4096] });
        
        const guild = interaction.guild;
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
                channel.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.ReadMessageHistory)
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
                const permissions = channel.permissionsFor(guild.members.me);
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
        const guild = interaction.guild;
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
                channel.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.ReadMessageHistory)
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
                const permissions = channel.permissionsFor(guild.members.me);
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

    const hasManageMessages = interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages);
    const isAllowedUser = config.allowedUsers.includes(interaction.user.id);
    
    if (!hasManageMessages && !isAllowedUser) {
        return await interaction.reply({
            content: 'У вас немає прав для використання цієї команди! Потрібні права **Manage Messages** або бути в списку дозволених користувачів.',
            flags: [4096]
        });
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
                    name: '/clear-info',
                    value: 'Показати цю довідку'
                },
                {
                    name: 'Права доступу',
                    value: 'Потрібні права **Manage Messages** або бути в списку дозволених користувачів'
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
