const config = require('./config.json');

const cron = require('node-cron');
const moment = require('moment-timezone')
const axios = require("axios");
const Redis = require("ioredis");
const AWS = require("aws-sdk");
const redis = new Redis(); // Hostname required if not localhost...

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: config.aws_region });


const accessToken = config.discord_accessToken;
const channels = config.channels;
const messagesToGet = config.messagesToGet;

const getNewMessages = async (channelId) => {
    const headers = {
        'Authorization': accessToken,
    };
    
    let latestMessageTimestamp = await redis.get(`discord-${channelId}`) || 0
    let msgs = await axios.get(`https://discord.com/api/v9/channels/${channelId}/messages?limit=${messagesToGet}`, {
        headers
    })
    let newMessages = msgs.data.filter(msg => new Date(msg.timestamp).getTime() > latestMessageTimestamp);
    if (newMessages.length == 0) {
        return []
    }
    await redis.set(`discord-${channelId}`, new Date(newMessages[0].timestamp).getTime());
    if (newMessages.length == messagesToGet) {
        //We need to get more messages!
        console.log('Received max messages, getting more!')
        msgs = await axios.get(`https://discord.com/api/v9/channels/${channelId}/messages?limit=100`, {
            headers
        })
        newMessages = msgs.data.filter(msg => new Date(msg.timestamp).getTime() > latestMessageTimestamp);
        if (newMessages.length == 100) {
            console.log('Max messages received, consider increasing the cron polling interval.')
        }
        return newMessages
    } else {
        return newMessages
    }
};




const writeMessagesToDynamoDB = async (messages, channelId) => {
    const batchSize = 25;
    const ttlDays = 30;

    const writeBatch = async (batch) => {
        const putRequests = batch.map((msg) => ({
            PutRequest: {
                Item: {
                    channelId: msg.channel_id,
                    messageId: msg.id,
                    timestamp: new Date(msg.timestamp).getTime(),
                    authorId: msg.author.id,
                    authorName: msg.author.global_name || msg.author.username,
                    content: msg.content,
                    referenced_message: msg.referenced_message && msg.referenced_message.id,
                    mentions: msg.mentions.map(mention => mention.id),
                    has_attachments: msg.attachments.length > 0,
                    ttl: Math.round((new Date().getTime() + (86400 * 1000 * ttlDays)) / 1000)
                },
            },
        }));

        const params = {
            RequestItems: {
                [config.dynamoDB_table]: putRequests
            }
        };
    
        try {
            await dynamodb.batchWrite(params).promise();
            console.log(`Successfully wrote ${batch.length} messages from channel ${channelId} to DynamoDB`);
        } catch (error) {
            console.error(`Error writing messages from channel ${channelId} to DynamoDB:`, error);
        }
    };

    // Split messages into chunks of 25 and write each chunk
    for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        await writeBatch(batch); // Await to ensure sequential writing
    }

    console.log('All messages processed');
};

const pollForChanges = async () => {
        for (const channel of channels) {
            try {
                const newMessages = await getNewMessages(channel.id);
                if (newMessages.length > 0) {
                    await writeMessagesToDynamoDB(newMessages, channel.id);
                } else {
                    console.log(`No new messages in channel ${channel.name}`);
                }
            } catch (error) {
                console.error(`Error processing channel ${channel.name}:`, error);
            }
        }
}

(async () => {

    //Poll on startup
    await pollForChanges()


    // Weekday Schedule: Every 5 minutes between 5 AM and 10 PM Pacific Time weekdays
    cron.schedule('*/5 5-21 * * 1-5', async () => { // 1-5 specifies Monday to Friday
        await pollForChanges();
        console.log(`[${moment().tz(config.timeZone).format()}] Executed 5-minute weekday daytime poll.`);
    }, {
        timezone: config.timeZone
    });

    // Every hour 10PM-12PM
    cron.schedule('0 22-23 * * *', async () => { // 1-5 specifies Monday to Friday
        await pollForChanges();
        console.log(`[${moment().tz(config.timeZone).format()}] Executed hourly nighttime poll (22-23).`);
    }, {
        timezone: config.timeZone
    });

    // Every hour 12AM-4AM
    cron.schedule('0 0-4 * * *', async () => { // 1-5 specifies Monday to Friday
        await pollForChanges();
        console.log(`[${moment().tz(config.timeZone).format()}] Executed hourly nighttime poll (0-4).`);
    }, {
        timezone: config.timeZone
    });

    // Weekend Schedule: Every 30 minutes 5AM-10PM
    cron.schedule('*/15 5-21 * * 6,0', async () => { // 6 and 0 specify Saturday and Sunday
        await pollForChanges();
        console.log(`[${moment().tz('America/Los_Angeles').format()}] Executed 15-minute weekend poll.`);
    }, {
        timezone: 'America/Los_Angeles'
    });

})();

