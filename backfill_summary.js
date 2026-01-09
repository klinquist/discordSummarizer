const config = require("./config.json");
process.env.AWS_REGION = config.aws_region;
process.env.OPENAI_API_KEY = config.openAI_key;

const AWS = require("aws-sdk");
const RSS = require("rss");
const path = require("path");
const fs = require("fs/promises");
const moment = require("moment-timezone");
const OpenAI = require("openai");
const showdown = require("showdown");

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: config.aws_region,
});
const s3 = new AWS.S3();
const cloudfront = new AWS.CloudFront();
const openai = new OpenAI();
const converter = new showdown.Converter();

const channels = config.channels;

const DEFAULT_START_HOUR = 5;
const DEFAULT_END_HOUR = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getOpenAIErrorInfo = (error) => {
  const status = error?.status ?? error?.response?.status;
  const code = error?.code ?? error?.error?.code;
  const type = error?.type ?? error?.error?.type;
  const message = error?.message ?? error?.error?.message;
  const headers = error?.headers ?? error?.response?.headers;
  const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"];
  return {
    status,
    code,
    type,
    message,
    retryAfter,
  };
};

const parseArgs = (argv) => {
  const dates = [];
  let dryRun = false;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--date") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --date");
      }
      dates.push(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--date=")) {
      const value = arg.slice("--date=".length);
      dates.push(value);
      continue;
    }
    if (arg === "--dates") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --dates");
      }
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach((item) => dates.push(item));
      i += 1;
      continue;
    }
    if (arg.startsWith("--dates=")) {
      const value = arg.slice("--dates=".length);
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach((item) => dates.push(item));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { dates, dryRun, help: true };
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { dates, dryRun, help: false };
};

const printUsage = () => {
  console.log("Usage:");
  console.log(
    "  node backfill_summary.js --date YYYY-MM-DD [--date YYYY-MM-DD] [--dry-run]"
  );
  console.log(
    "  node backfill_summary.js --dates YYYY-MM-DD,YYYY-MM-DD [--dry-run]"
  );
  console.log("");
  console.log(
    `Defaults to ${DEFAULT_START_HOUR}:00-${DEFAULT_END_HOUR}:00 in ${config.timeZone}.`
  );
};

const getWindowForDate = (dateStr) => {
  const day = moment.tz(dateStr, "YYYY-MM-DD", true, config.timeZone);
  if (!day.isValid()) {
    throw new Error(`Invalid date (expected YYYY-MM-DD): ${dateStr}`);
  }

  const start = day.clone().startOf("day").add(DEFAULT_START_HOUR, "hours");
  const end = day.clone().startOf("day").add(DEFAULT_END_HOUR, "hours");

  return {
    dateKey: day.format("YYYY-MM-DD"),
    dateLabel: day.format("dddd, MMMM Do, YYYY"),
    startTimestamp: start.valueOf(),
    endTimestamp: end.valueOf(),
    startLabel: start.format(),
    endLabel: end.format(),
  };
};

const getMessagesBetweenTimes = async (channelId, startTimestamp, endTimestamp) => {
  let params = {
    TableName: config.dynamoDB_table,
    KeyConditionExpression:
      "channelId = :channelId AND #ts BETWEEN :start AND :end",
    ExpressionAttributeNames: {
      "#ts": "timestamp",
    },
    ExpressionAttributeValues: {
      ":channelId": channelId,
      ":start": startTimestamp,
      ":end": endTimestamp,
    },
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
  const maxPayloadSize = (maxSize, arr) => {
    console.log("Incoming array size is:", arr.length);

    arr = arr.map((msg) => {
      delete msg.ttl;
      delete msg.channelId;
      return msg;
    });

    if (JSON.stringify(arr).length <= maxSize) return arr;

    arr = arr.filter((msg) => {
      return msg.content.length > 10;
    });

    if (JSON.stringify(arr).length <= maxSize) {
      console.log(
        "Successfully trimmed using short method, new length :",
        arr.length
      );
      return arr;
    } else {
      console.log("After short message filter, new length:", arr.length);
    }

    while (JSON.stringify(arr).length > maxSize) {
      const index = Math.floor(Math.random() * arr.length);
      arr.splice(index, 1);
    }
    console.log("Shortened via random method, new length:", arr.length);
    return arr;
  };

  let origMsgsLength = messages.length;
  messages = maxPayloadSize(300000, messages);
  let newMsgsLength = messages.length;

  messages = messages.map((msg) => {
    msg.timestamp = Number(msg.timestamp);
    msg.local_time = moment(msg.timestamp).tz(config.timeZone).format("h:mm A");
    return msg;
  });

  const systemPrompt = `${system_role}\n\nEach message includes a preformatted local_time string (timezone: ${config.timeZone}); prefer that over the raw timestamp.`;

  const conversation = [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "user",
      content: JSON.stringify(messages),
    },
  ];

  const maxRetries = 5;
  let attempt = 0;
  let completion;

  while (true) {
    try {
      completion = await openai.chat.completions.create({
        model: "gpt-5-mini",
        messages: conversation,
      });
      break;
    } catch (error) {
      attempt += 1;
      const info = getOpenAIErrorInfo(error);
      const isRateLimit =
        info.status === 429 ||
        info.code === "rate_limit_exceeded" ||
        info.type === "rate_limit_exceeded";

      if (!isRateLimit || attempt > maxRetries) {
        if (isRateLimit) {
          console.error(
            `[OpenAI 429] exceeded max retries (${maxRetries}). Last error: status=${info.status} code=${info.code} type=${info.type} message=${info.message}`
          );
        }
        throw error;
      }

      const baseDelayMs = 1000 * Math.pow(2, attempt - 1);
      const retryAfterMs = info.retryAfter ? Number(info.retryAfter) * 1000 : 0;
      const delayMs =
        Math.min(30000, Math.max(baseDelayMs, retryAfterMs)) +
        Math.floor(Math.random() * 250);

      console.warn(
        `[OpenAI 429] rate limit hit (attempt ${attempt}/${maxRetries}). status=${info.status} code=${info.code} type=${info.type} message=${info.message} retryAfter=${
          info.retryAfter || "none"
        }; backing off ${delayMs}ms`
      );

      await sleep(delayMs);
    }
  }

  const finalContent = completion.choices[0].message.content || "";

  if (newMsgsLength !== origMsgsLength) {
    let percent = Math.round(100 - (newMsgsLength / origMsgsLength) * 100);
    return (
      finalContent +
      `\n\n_Due to ChatGPT's payload maximum, ${percent}% of messages were randomly removed prior to generating the summary._\n\n`
    );
  }

  return finalContent;
};

const uploadToS3 = async (html, summary_text, dateKey) => {
  const htmlFileName = `${config.filenamePrefix}${dateKey}-Summary.html`;
  const textFileName = `${config.filenamePrefix}${dateKey}-Summary.md`;

  const params = {
    Bucket: config.s3Bucket,
    Key: htmlFileName,
    Body: html,
    ContentType: "text/html; charset=utf-8",
  };

  try {
    await s3.upload(params).promise();
    console.log(`Successfully uploaded ${htmlFileName} to S3 bucket.`);
  } catch (error) {
    console.error(`Error uploading ${htmlFileName} to S3 bucket:`, error);
    throw error;
  }

  const paramsText = {
    Bucket: config.s3Bucket,
    Key: textFileName,
    Body: summary_text,
    ContentType: "text/plain; charset=utf-8",
  };

  try {
    await s3.upload(paramsText).promise();
    console.log(`Successfully uploaded ${textFileName} to S3 bucket.`);
  } catch (error) {
    console.error(`Error uploading ${textFileName} to S3 bucket:`, error);
    throw error;
  }
};

const sendEmail = async (html, dateLabel) => {
  const params = {
    Destination: {
      ToAddresses: [config.emailTo],
    },
    Message: {
      Body: {
        Html: {
          Charset: "UTF-8",
          Data: html,
        },
      },
      Subject: {
        Charset: "UTF-8",
        Data: config.emailSummaryPrefix + dateLabel,
      },
    },
    Source: config.emailFrom,
  };

  try {
    const result = await new AWS.SES().sendEmail(params).promise();
    console.log(`Email sent successfully. Message ID: ${result.MessageId}`);
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
};

const generateSummary = async (dateLabel, startTimestamp, endTimestamp) => {
  let summary = ``;
  summary += `# Daily Summary and Sentiment Analysis for ${dateLabel}\n\n`;

  for (const channel of channels) {
    try {
      const messages = await getMessagesBetweenTimes(
        channel.id,
        startTimestamp,
        endTimestamp
      );
      if (messages.length > 0) {
        console.log(`Generating for ${channel.name}`);
        const sm = await summarizeMessages(messages, channel.system_role);
        summary += `## ${channel.name}:\n${sm}\n\n`;
      } else {
        console.log(`No messages in channel ${channel.name} for this window.`);
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
      <p><i>This is a ChatGPT-generated summary which may contain inaccurate information.</i></p>
    </body>
  </html>
`;

  return [html, summary];
};

async function listFiles() {
  const params = {
    Bucket: config.s3Bucket,
    Prefix: config.filenamePrefix,
  };

  let fileList = [];
  try {
    const data = await s3.listObjectsV2(params).promise();
    fileList = data.Contents.map((item) => item.Key).filter((key) =>
      key.endsWith("Summary.html")
    );
  } catch (err) {
    console.error("Error listing files:", err);
  }
  return fileList;
}

async function generateRSSFeed() {
  const feed = new RSS({
    title: "Caltrain Discord summary",
    description: "A feed that updates daily with new summaries",
    feed_url: `${config.siteUrl}/${config.filenamePrefix}${config.rssFileKey}`,
    site_url: config.siteUrl,
    language: "en",
  });

  const files = await listFiles();

  console.log("Found files:", files);

  files.forEach((file) => {
    const date = path.basename(file, ".html").split("-Summary")[0];
    const fileUrl = `${config.siteUrl}/${file}`;

    feed.item({
      title: `Summary for ${date}`,
      description: `Daily summary for ${date} (follow RSS link to view)`,
      url: fileUrl,
      date,
    });
  });

  const rssXML = feed.xml({
    indent: true,
  });
  return rssXML;
}

async function uploadRSSFeed(rssXML) {
  const params = {
    Bucket: config.s3Bucket,
    Key: `${config.filenamePrefix}${config.rssFileKey}`,
    Body: rssXML,
    ContentType: "application/rss+xml; charset=utf-8",
  };

  try {
    await s3.putObject(params).promise();
    console.log("RSS feed uploaded successfully");
  } catch (err) {
    console.error("Error uploading RSS feed:", err);
  }
}

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
        Items: [`/${config.filenamePrefix}${config.rssFileKey}`],
      },
    },
  };

  try {
    const data = await cloudfront.createInvalidation(params).promise();
    console.log("CloudFront invalidation created:", data.Invalidation.Id);
  } catch (err) {
    console.error("Error creating CloudFront invalidation:", err);
  }
}

const writeDryRunFiles = async (dateKey, html, summaryText) => {
  const dir = path.join(__dirname, "dry-run");
  const htmlPath = path.join(
    dir,
    `${config.filenamePrefix}${dateKey}-Summary.html`
  );
  const textPath = path.join(
    dir,
    `${config.filenamePrefix}${dateKey}-Summary.md`
  );

  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await fs.mkdir(path.dirname(textPath), { recursive: true });

  await fs.writeFile(htmlPath, html, "utf8");
  await fs.writeFile(textPath, summaryText, "utf8");

  console.log(`Dry run outputs written to ${htmlPath} and ${textPath}`);
};

async function runSummaryJobForDate(dateStr, dryRun) {
  const { dateKey, dateLabel, startTimestamp, endTimestamp, startLabel, endLabel } =
    getWindowForDate(dateStr);

  console.log(
    `Running summary for ${dateKey} (${startLabel} -> ${endLabel} ${config.timeZone})`
  );

  const [summaryHtml, summaryText] = await generateSummary(
    dateLabel,
    startTimestamp,
    endTimestamp
  );

  if (dryRun) {
    console.log(`Dry run enabled; skipping S3/SES/RSS/CloudFront.`);
    console.log(`Email subject would be: ${config.emailSummaryPrefix}${dateLabel}`);
    console.log("Dry run summary (markdown):");
    console.log(summaryText);
    await writeDryRunFiles(dateKey, summaryHtml, summaryText);
    return;
  }

  await uploadToS3(summaryHtml, summaryText, dateKey);
  await sendEmail(summaryHtml, dateLabel);
  await updateRSSFeed();
  await createInvalidation(config.cloudfrontId);
  console.log(
    `[${moment().tz(config.timeZone).format()}] Summary job completed for ${dateKey}.`
  );
}

(async () => {
  try {
    const { dates, dryRun, help } = parseArgs(process.argv);
    if (help || dates.length === 0) {
      printUsage();
      process.exit(help ? 0 : 1);
    }

    for (const dateStr of dates) {
      await runSummaryJobForDate(dateStr, dryRun);
    }
  } catch (error) {
    console.error("Backfill summary failed:", error);
    process.exit(1);
  }
})();
