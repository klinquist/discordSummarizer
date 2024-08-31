## Discord OpenAI Summarizer

I created this project to help me summarize and provide sentiment analysis on Discord channels.

### How to use

This is a personal project I'm making public on Discord.  It's not meant to be user-friendly outside of my own use case :).

You'll need to be running Redis (to keep track of the latest message timestamp) as well as a DynamoDB table with `channelId` as the primary key and `timestamp` (number) as the sort key.  It also sets a `ttl` for 30 days from now - you can configure this to auto-delete old messages in dynamo.

Obtain a discord access token.  Pull up the javascript console in your browser (network tab) and log in to discord.  You'll see an API call being made to https://discord.com/api/v9/channels/... The token is in the headers of that request.

Rename `config.json.example` to `config.json` and fill in the details (including discord channel ID, which you can get by right-clicking on the channel and selecting "Copy link", then grabbing the last number in that link).

Run `npm install` to install the dependencies.

Edit the cron schedule in `index.js` as appropriate.  The channels I monitor are mostly busy on weekdays, so I poll every 5 minutes from 5am-10pm M-F, hourly throughout the night, every 30 minutes on weekends.

Run `node index.js` to start - I have it running under pm2.

I run `node get_summary.js`  to get a summary.  You may want to also run this on a cron, and have it write to another file/dynamo table.