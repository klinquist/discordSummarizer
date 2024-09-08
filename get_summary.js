const config = require('./config.json');

const cron = require('node-cron');
const RSS = require('rss');
const path = require('path');

const moment = require('moment-timezone');
const axios = require("axios");
const AWS = require("aws-sdk");
process.env.OPENAI_API_KEY = config.openAI_key
const dynamodb = new AWS.DynamoDB.DocumentClient({
    region: config.aws_region
});

const OpenAI = require('openai');
const openai = new OpenAI();

const showdown = require('showdown')

const channels = config.channels;

var converter = new showdown.Converter()
const s3 = new AWS.S3();
const cloudfront = new AWS.CloudFront();



const getMessagesSinceTime = async (channelId) => {

    // Calculate the UNIX timestamp for 5AM today. That's when most of the valuable chatter starts.
    const getStartTimestamp = () => {
        return moment().tz(config.timeZone).startOf('day').add(5, 'hours').valueOf();
    };

    const currentTimestamp = () => {
        return Date.now();
    }

    //const currentTimestamp = Date.now();

    let params = {
        TableName: config.dynamoDB_table,
        KeyConditionExpression: 'channelId = :channelId AND #ts BETWEEN :start AND :now',
        ExpressionAttributeNames: {
            '#ts': 'timestamp'
        },
        ExpressionAttributeValues: {
            ':channelId': channelId,
            ':start': getStartTimestamp(),
            ':now': currentTimestamp()
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
        // if (JSON.stringify(payload).length > maxSize) {
        //     payload.messages[1].content.pop();
        //     console.log('Payload too large, removing last message');
        //     return maxPayloadSize(maxSize, payload);
        // }
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


const uploadToS3 = async (html) => {
    const currentDate = moment().tz(config.timeZone).format("YYYY-MM-DD");
    const fileName = `${config.filenamePrefix}${currentDate}-Summary.html`;

    const params = {
        Bucket: config.s3Bucket,
        Key: fileName,
        Body: html,
        ContentType: "text/html"
    };

    try {
        await s3.upload(params).promise();
        console.log(`Successfully uploaded ${fileName} to S3 bucket.`);
    } catch (error) {
        console.error(`Error uploading ${fileName} to S3 bucket:`, error);
        throw error;
    }
};



const generateSummary = async () => {

        const today = moment().tz(config.timeZone).format("MMMM D, YYYY");
        let summary = ``;
        summary += `# Daily Summary and Sentiment Analysis for ${today}\n\n`
        for (const channel of channels) {
            try {
                const messages = await getMessagesSinceTime(channel.id);
                if (messages.length > 0) {
                    console.log(`Generating for ${channel.name}`);
                    const sm = await summarizeMessages(messages, channel.system_role);
                    summary += `## ${channel.name}:\n${sm}\n\n`
                } else {
                    console.log(`No messages in channel ${channel.name} since start time.`);
                }
            } catch (error) {
                console.error(`Error processing channel ${channel.name}:`, error);
            }
        }
    let html = `
  <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          font-size: 16px;
        }
        @media (max-width: 600px) {
          body {
            font-size: 18px;
          }
        }
      </style>
    </head>
    <body>
      ${converter.makeHtml(summary)}
    </body>
  </html>
`;

    await uploadToS3(html);
    
}





// List all files in the S3 bucket
async function listFiles() {
    const params = {
        Bucket: config.s3Bucket,
        Prefix: config.filenamePrefix
    };

    let fileList = [];
    try {
        const data = await s3.listObjectsV2(params).promise();
        fileList = data.Contents.map(item => item.Key).filter(key => key.endsWith('Summary.html'));
    } catch (err) {
        console.error('Error listing files:', err);
    }
    return fileList;
}

// Generate RSS feed
async function generateRSSFeed() {
    const feed = new RSS({
        title: 'Caltrain Discord summary',
        description: 'A feed that updates daily with new summaries',
        feed_url: `${config.siteUrl}/${config.filenamePrefix}${config.rssFileKey}`,
        site_url: config.siteUrl,
        language: 'en',
    });

    const files = await listFiles();

    console.log('Found files:', files);

    files.forEach(file => {
        const date = path.basename(file, '.html').split('-Summary')[0];
        const fileUrl = `${config.siteUrl}/${file}`;

        feed.item({
            title: `Summary for ${date}`,
            description: `Daily summary for ${date} (follow RSS link to view)`,
            url: fileUrl, // Link to the HTML file in S3
            date, // Publish date
        });
    });

    const rssXML = feed.xml({
        indent: true
    });
    return rssXML;
}

// Upload the RSS feed to S3
async function uploadRSSFeed(rssXML) {
    const params = {
        Bucket: config.s3Bucket,
        Key: `${config.filenamePrefix}${config.rssFileKey}`,
        Body: rssXML,
        ContentType: 'application/rss+xml',
    };

    try {
        await s3.putObject(params).promise();
        console.log('RSS feed uploaded successfully');
    } catch (err) {
        console.error('Error uploading RSS feed:', err);
    }
}

// Main function to generate and upload the RSS feed
async function updateRSSFeed() {
    const rssXML = await generateRSSFeed();
    await uploadRSSFeed(rssXML);
}

async function createInvalidation(distributionId) {
    const params = {
        DistributionId: distributionId,
        InvalidationBatch: {
            CallerReference: `invalidation-${Date.now()}`, 
            Paths: {
                Quantity: 1,
                Items: ['/summary/summary.xml'], // The path to your RSS file
            },
        },
    };

    try {
        const data = await cloudfront.createInvalidation(params).promise();
        console.log('CloudFront invalidation created:', data.Invalidation.Id);
    } catch (err) {
        console.error('Error creating CloudFront invalidation:', err);
    }
}



(async () => {
    console.log('Waiting until 8PM')
    cron.schedule('0 20 * * *', async () => {
        await generateSummary();
        await updateRSSFeed();
        await createInvalidation(config.cloudfrontId);
        console.log('Done')
        console.log(`[${moment().tz('America/Los_Angeles').format()}] Executed daily 8PM poll.`);
    }, {
        timezone: 'America/Los_Angeles'
    });
})();