import {
    EmbedBuilder,
    ChannelType,
    Client,
    GuildMember,
    GuildChannel,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    DMChannel,
    User,
    Message,
} from 'discord.js'
import nodemailer from 'nodemailer'
import { links as dm_link } from './modmail.js'
import * as VERIFY_EMBED from '../embeds/verify.js'
import { randomBytes } from 'node:crypto'

const time = 60 * 60 * 1000

const lang_embeds = {
    de: {
        id_ask: VERIFY_EMBED.default.id_ask_de,
        email: VERIFY_EMBED.default.email_de,
        verified: VERIFY_EMBED.default.verified_de,
        error_id: VERIFY_EMBED.default.error_id_de,
        error_hash: VERIFY_EMBED.default.error_hash_de,
    },
    en: {
        id_ask: VERIFY_EMBED.default.id_ask_en,
        email: VERIFY_EMBED.default.email_en,
        verified: VERIFY_EMBED.default.verified_en,
        error_id: VERIFY_EMBED.default.error_id_en,
        error_hash: VERIFY_EMBED.default.error_hash_en,
    },
    ru: {
        id_ask: VERIFY_EMBED.default.id_ask_ru,
        email: VERIFY_EMBED.default.email_ru,
        verified: VERIFY_EMBED.default.verified_ru,
        error_id: VERIFY_EMBED.default.error_id_ru,
        error_hash: VERIFY_EMBED.default.error_hash_ru,
    },
    ch: {
        id_ask: VERIFY_EMBED.default.id_ask_ch,
        email: VERIFY_EMBED.default.email_ch,
        verified: VERIFY_EMBED.default.verified_ch,
        error_id: VERIFY_EMBED.default.error_id_ch,
        error_hash: VERIFY_EMBED.default.error_hash_ch,
    },
}

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
    },
})

//this is a disgusting chain of functions

/**
 * @param {GuildMember} member
 */
async function guildMemberAdd(member) {
    console.log(member.user.tag, 'joined!')
    if (process.env.PROD) {
        //pretty sure this is broken but I'll just leave it
        console.log(`Automatically asking ${member.user.tag} to select a language.`)
        askForLanguage(member)
    }
}

/**
 * @param {GuildMember} member
 * @description Verify user by guiding through steps
 */
export async function askForLanguage(member, meta = {}) {

    /*
     * STEP 1: LANGUAGE SELECTION
     */
    let messageFail = false;
    let message = await member.send({
        embeds: [VERIFY_EMBED.default.lang_ask],
    }).catch(e => {
        console.log(`Error in verification.js: Could not send message to ${member.user.tag}. It is possible this user does not allow DMs from this bot.`);
        console.log(e);

        //notify user
        if (meta?.message) {
            meta.message.reply(`I could not send you a DM :( please check your settings and try again.\nIf the problem persists, contact the admins.`);
        }
        // return;
        messageFail = true;
    })

    if (messageFail) {
        return;
    }

    dm_link[member.user.id] = {
        type: 'verify',
        verification: {
            state: 0,
            lang: null, //yikes, null aka the billion dollar mistake. Look it up, quite interesting.
            TUM_ID: null,
        },
    }


    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('de')
            .setLabel('🇩🇪')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('en')
            .setLabel('🇬🇧')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('ru')
            .setLabel('🇷🇺')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('ch')
            .setLabel('🇨🇳')
            .setStyle(ButtonStyle.Secondary)
    )

    await message.edit({
        components: [row],
    })
}

/**
 * @param {import('discord.js').Interaction} interaction
 * @description Await user asking for interaction
 */
async function awaitLanguageOption(interaction) {
    if (!process.env.PROD) return
    if (!interaction.isButton()) return
    if (
        !dm_link[interaction.user.id] ||
        dm_link[interaction.user.id]?.type != 'verify'
    ) {
        return
    }

    /*
     * STEP 1b: AWAIT LANGUAGE SELECTION
     */

    dm_link[interaction.user.id].verification.lang = interaction.customId
    dm_link[interaction.user.id].verification.state = 1 // 1: enter tum code
    const embed = lang_embeds[interaction.customId].id_ask

    interaction.reply({
        embeds: [embed],
    })

    askForTumID(interaction.user)
}

/**
 * @param {User} user
 * @description STEP 2: ENTER TUM ID
 */
async function askForTumID(user) {
    const collector = await user.dmChannel.createMessageCollector({
        filter: (m) => !m.author.bot,
        time,
    })

    collector.on('collect', async (message) => {
        // Find TUM ID in message
        const idRegex = /[a-z]{2}[0-9]{2}[a-z]{3}/i
        if (!idRegex.test(message.content)) {
            const embed =
                lang_embeds[dm_link[user.id].verification.lang].error_id
            user.send({
                embeds: [embed],
            })
            await collector.stop()
            askForTumID(user)
            return
        }

        dm_link[user.id].verification.TUM_ID = message.content
        dm_link[user.id].verification.state = 2 // 2: await verification
        let embed = lang_embeds[dm_link[user.id].verification.lang].email

        await collector.stop()
        let status = await sendVerifyEmail(
            user,
            dm_link[user.id].verification.TUM_ID
        )

        if (status == 1) {

            //for extra extra safety in case we ever decide to catch user.send errors below
            if (embed.data.description.endsWith("@mytum.de")) {
                embed.data.description = embed.data.description.slice(0, embed.data.description.length - "ab12cde@mytum.de".length);
            }

            embed.data.description += `${dm_link[user.id].verification.TUM_ID}@mytum.de`;
            user.send({
                embeds: [embed],
            })
            embed.data.description = embed.data.description.slice(0, embed.data.description.length - "ab12cde@mytum.de".length);
        }



    })
}

/**
 * @param {User} user
 * @description STEP 3: SEND VERIFICATION CODE PER EMAIL
 */
async function sendVerifyEmail(user, tum_id) {
    let hash = randomBytes(20).toString('hex')
    //console.log(hash)

    try {
        //let promise = new Promise((res, err) => {
        transporter.sendMail(
            {
                from: process.env.EMAIL_USER,
                to: tum_id + '@mytum.de',
                subject: 'TUM Discord Verifizierungs Code',
                text: 'Ihr Code ist: ' + hash,
            },
            function (error, info) {
                if (error) {
                    // err(error)
                    console.error(error)
                } else {
                    // res()
                    //console.log('Email sent: ' + info.response)
                    console.log(`Email sent to ${user.tag}`);
                }
            }
        )
        //})

        //await promise
    } catch (e) {
        const embed = lang_embeds[dm_link[user.id].verification.lang].error_id
        user.send({
            embeds: [embed],
        })
        askForTumID(user);
        //console.log(e)
        return 0;
    }

    const collector = await user.dmChannel.createMessageCollector({
        filter: (m) => !m.author.bot,
        time,
    })

    collector.on('collect', async (message) => {
        const guild = await message.client.guilds.fetch(process.env.GUILD_ID);
        let embed;
        let error;
        try {
            embed = lang_embeds[dm_link[user.id].verification.lang].verified;
        } catch (err) {
            error = err;
        }

        if (error) {
            console.log("Error in verification.js. Message:", message, "Error: ", error);
            return;
        }

        if (hash != message.content) {
            /*const embed = lang_embeds[dm_link[user.id].verification.lang].error_hash
            user.send({
                embeds: [embed],
            })
            await collector.stop()
            sendVerifyEmail(user, tum_id)*/
            return 0;
        }

        user.send({
            embeds: [embed],
        });

        delete dm_link[user.id];

        let guild_member = await guild.members.fetch(user.id);
        let verify_role = await guild.roles.fetch(process.env.VERIFIED_ROLE);
        guild_member.roles.add(verify_role);

        console.log(`${user.tag} verified!`);

        await collector.stop()
    })

    return 1
}

/**
 * @export
 */
export default [
    {
        type: 'event',
        name: 'guildMemberAdd',
        run: guildMemberAdd,
    },
    {
        type: 'event',
        name: 'interactionCreate',
        run: awaitLanguageOption,
    },
]
