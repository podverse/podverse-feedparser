const
    sqlEngineFactory = require('../repositories/sequelize/engineFactory.js'),
    modelFactory = require('../repositories/sequelize/models'),
    {postgresUri, queueUrl} = require('../config'),
    aws = require('aws-sdk');

const sqlEngine = new sqlEngineFactory({uri: postgresUri});
const Models = modelFactory(sqlEngine);

aws.config.update({region:'us-west-2'});
const sqs = new aws.SQS();

function addFeedUrlsToSQSParsingQueue(params = {}) {

  return new Promise((resolve, reject) => {
    purgeSQSFeedQueue(resolve, reject)
  })
    .then(() => {
      let {Podcast} = Models;

      let queryObj;

      // NOTE: onlyParseUnparsed assumes if a podcast doesn't have a title then
      // it hasn't been parsed. Definitely a flawed approach.
      if (params.onlyParseUnparsed) {
        queryObj = {
          attributes: ['feedUrl'],
          where: {
            title: null
          }
        };
      } else {
        queryObj = {
          attributes: ['feedUrl']
        };
      }

      return Podcast.findAll(queryObj)
        .then(podcasts => {

          let feedUrls = [];
          for (podcast of podcasts) {
            feedUrls.push(podcast.feedUrl);
          }

          // AWS SQS has a max of 10 messages per batch message. This code breaks
          // the feedUrls into chunks of 10, then calls the send batch message
          // operation once for each of those chunks of 10.
          let entryChunks = [];
          let tempChunk = [];

          for (let [index, feedUrl] of feedUrls.entries()) {
            let entry = {
              Id: String(index),
              MessageBody: feedUrl
            }

            tempChunk.push(entry);

            if ((index + 1) % 10 === 0 || index === feedUrls.length - 1) {
              entryChunks.push(tempChunk);
              tempChunk = [];
            }
          }

          for (entryChunk of entryChunks) {
            let chunkParams = {
              Entries: entryChunk,
              QueueUrl: queueUrl
            }

            sqs.sendMessageBatch(chunkParams, (err, data) => {
              if (err) {
                console.log(err, err.stack);
              }
            });
          }

        })
    })
    .catch((err) => {
      console.log(err);
    });

}

function parseNextFeedFromQueue () {

  console.log('parseNextFeedFromQueue');

  return new Promise((resolve, reject) => {
    let params = {
      QueueUrl: queueUrl,
      MessageAttributeNames: ['All'],
      VisibilityTimeout: 300
    }

    sqs.receiveMessage(params, (err, data) => {

      console.log('sqs.receiveMessage');
      console.log(err);
      console.log(data);

      if (err) {
        reject(err);
        return;
      }

      if (!data.Messages || data.Messages.length < 1) {
        console.log('no messages!');
        reject('No messages returned.');
        return;
      }

      let parseParams = {};
      let message = data.Messages[0];
      let receiptHandle = message.ReceiptHandle;

      let feedUrl = message.Body;

      resolve([feedUrl, parseParams, receiptHandle])
    });

  });
}

function deleteSQSMessage (receiptHandle) {
  if (receiptHandle) {
    let params = {
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle
    };

    sqs.deleteMessage(params, (err, data) => {
      if (err) {
        console.log(err);
      }
    })
  }
}

function purgeSQSFeedQueue (resolve, reject) {
  let params = {
    QueueUrl: queueUrl
  };

  sqs.purgeQueue(params, (err, data) => {
    if (err) {
      reject(err);
      return;
    }

    resolve();
  });
}

module.exports = {
  addFeedUrlsToSQSParsingQueue,
  parseNextFeedFromQueue,
  deleteSQSMessage
}
