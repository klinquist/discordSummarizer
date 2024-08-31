const config = require('./config.json');


const moment = require('moment-timezone');
const axios = require("axios");
const AWS = require("aws-sdk");
process.env.OPENAI_API_KEY = config.openAI_key
const dynamodb = new AWS.DynamoDB.DocumentClient({
    region: config.aws_region
});

const OpenAI = require('openai');
const openai = new OpenAI();


const channels = config.channels




// Calculate the UNIX timestamp for 5AM today. That's when most of the valuable chatter starts.
const getStartTimestamp = () => {
    return moment().tz(config.timeZone).startOf('day').add(5, 'hours').valueOf();
};


const getMessagesSinceTime = async (channelId) => {
    const currentTimestamp = Date.now();

    let params = {
        TableName: config.dynamoDB_table,
        KeyConditionExpression: 'channelId = :channelId AND #ts BETWEEN :start AND :now',
        ExpressionAttributeNames: {
            '#ts': 'timestamp'
        },
        ExpressionAttributeValues: {
            ':channelId': channelId,
            ':start': getStartTimestamp(),
            ':now': currentTimestamp
        }
    };

    let allMessages = [];
    let lastEvaluatedKey = null;

    do {
        if (lastEvaluatedKey) {
            params.ExclusiveStartKey = lastEvaluatedKey;
        }

        try {
            const result = await dynamodb.query(params).promise();
            allMessages = allMessages.concat(result.Items);

            lastEvaluatedKey = result.LastEvaluatedKey;
        } catch (error) {
            console.error(`Error querying messages for channel ${channelId}:`, error);
            throw error;
        }
    } while (lastEvaluatedKey);

    return allMessages;
};


const summarizeMessages = async (messages, system_role) => {

    const maxPayloadSize = (maxSize, payload) => {
        if (JSON.stringify(payload).length > maxSize) {
            payload.messages[1].content.pop();
            console.log('Payload too large, removing last message');
            return maxPayloadSize(maxSize, payload);
        }
        payload.messages[1].content = JSON.stringify(payload.messages[1].content); //OpenAI needs this to be a string
        console.log(`Payload size: ${JSON.stringify(payload).length}`);
        return payload;
    };


    const payload = {
        model: "gpt-4o-mini",
        messages: [
            {
                role: 'system',
                content: system_role
            },
            {
                role: 'user',
                content: messages
            }
        ]
    }

    const completion = await openai.chat.completions.create(maxPayloadSize(126976, payload));

    return completion.choices[0].message.content;
};




(async () => {
    for (const channel of channels) {
        try {
            const messages = await getMessagesSinceTime(channel.id);
            if (messages.length > 0) {
                console.log(`Asking OpenAI to summarize ${messages.length} messages...`);
                const summary = await summarizeMessages(messages, channel.system_role);
                console.log(`Summary and sentiment for ${channel.name}:\n`, summary);
            } else {
                console.log(`No messages in channel ${channel.name} since start time.`);
            }
        } catch (error) {
            console.error(`Error processing channel ${channel.name}:`, error);
        }
    }
})();