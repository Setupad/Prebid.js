import { ajaxBuilder } from '../src/ajax.js';
import { EVENTS } from '../src/constants.js';
import adapter from '../libraries/analyticsAdapter/AnalyticsAdapter.js';
import adapterManager from '../src/adapterManager.js';
import { logInfo } from '../src/utils.js';
import { getGptSlotInfoForAdUnitCode } from '../libraries/gptUtils/gptUtils.js';

// Set custom ajax fn with no timeout
const ajax = ajaxBuilder(null);

const analyticsType = 'endpoint';
const setupadAnalyticsEndpoint = 'https://analytics.setupad.io/api/prebid';
const GVLID = 1241;

let eventQueue = {};
let adUnitCodesCache = {};

let setupadAnalyticsAdapter = Object.assign(adapter({ setupadAnalyticsEndpoint, analyticsType }), {
  track({ eventType, args }) {
    switch (eventType) {
      case EVENTS.AUCTION_INIT:
        pushAdUnitCodesToCache(args?.auctionId, args?.adUnitCodes);
        break;

      case EVENTS.BID_REQUESTED:
        pushToEventQueue({
          eventType: EVENTS.BID_REQUESTED,
          args: args,
        });
        break;

      case EVENTS.BID_RESPONSE:
        pushToEventQueue({
          eventType: EVENTS.BID_RESPONSE,
          args: args,
        });
        break;

      case EVENTS.BID_TIMEOUT:
        // bidTimeout arg structure is different, so we need to loop through it
        args.forEach((timeoutEvent) => {
          pushToEventQueue({
            eventType: EVENTS.BID_TIMEOUT,
            args: timeoutEvent,
          });
        });
        break;

      case EVENTS.AUCTION_END:
        sendBatchAnalytics(args?.auctionId);
        break;

      case EVENTS.BID_WON:
        sendBidWonAnalytics(args);
        break;
    }
  },
});

/**
 * Sends a bid won event to the Setupad analytics endpoint.
 * @param {Object} args - The arguments object containing bid won data.
 * @returns {void}
 */
function sendBidWonAnalytics(args) {
  ajax(
    setupadAnalyticsEndpoint,
    () => logInfo('SETUPAD_ANALYTICS_BATCH_SENT'),
    JSON.stringify({
      data: [
        {
          eventType: EVENTS.BID_WON,
          args: args,
        },
      ],
      adUnitCodes: handleAdUnitCodes([args.adUnitCode]),
    }),
    {
      contentType: 'application/json',
      method: 'POST',
    }
  );
}

/**
 * Sends batch of all stored events and their data to Setupad analytics endpoint and flushes existing batch
 * @returns {void}
 */
function sendBatchAnalytics(auctionId) {
  if (!eventQueue[auctionId]) return;

  ajax(
    setupadAnalyticsEndpoint,
    () => logInfo('SETUPAD_ANALYTICS_BATCH_SENT'),
    JSON.stringify({ data: eventQueue[auctionId], adUnitCodes: adUnitCodesCache[auctionId] }),
    {
      contentType: 'application/json',
      method: 'POST',
    }
  );

  delete adUnitCodesCache[auctionId];
  delete eventQueue[auctionId];
}

/**
 * Queues an event to be sent to the Setupad analytics endpoint.
 * @param {Object} data - The event data to queue.
 * @returns {void}
 */
function pushToEventQueue(data) {
  const auctionId = data?.args?.auctionId;
  if (auctionId) {
    if (!eventQueue[auctionId]) {
      eventQueue[auctionId] = [];
    }
    eventQueue[auctionId].push(data);
  }
}

/**
 * Pushes ad unit codes to cache for later use in batch analytics.
 * @param {string} auctionId
 * @param {string[]} adUnitCodes
 */
function pushAdUnitCodesToCache(auctionId, adUnitCodes) {
  if (!auctionId || !Array.isArray(adUnitCodes)) return;

  adUnitCodesCache[auctionId] = handleAdUnitCodes(adUnitCodes);
}

/**
 * Processes an array of ad unit codes and returns an array of objects with formatted information.
 * @param {string[]} adUnitCodes - an array of ad unit code strings to process
 * @returns {Object[]}
 */
function handleAdUnitCodes(adUnitCodes) {
  if (!Array.isArray(adUnitCodes)) return [];
  return adUnitCodes.map((code) => {
    const gamPath = getGptSlotInfoForAdUnitCode(code)?.gptSlot ?? code;
    return {
      adUnitCode: code,
      gamPath,
    };
  });
}

adapterManager.registerAnalyticsAdapter({
  adapter: setupadAnalyticsAdapter,
  code: 'setupadAnalyticsAdapter',
  gvlid: GVLID,
});

// export for testing
export { handleAdUnitCodes };

export default setupadAnalyticsAdapter;
