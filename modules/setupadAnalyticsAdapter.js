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

let eventQueue = [];
let adUnitCodesCache = [];

let setupadAnalyticsAdapter = Object.assign(adapter({ setupadAnalyticsEndpoint, analyticsType }), {
  track({ eventType, args }) {
    switch (eventType) {
      case EVENTS.AUCTION_INIT:
        queueEvent({
          eventType: EVENTS.AUCTION_INIT,
          args: args,
        });
        break;

      case EVENTS.BID_REQUESTED:
        queueEvent({
          eventType: EVENTS.BID_REQUESTED,
          args: args,
        });
        break;

      case EVENTS.BID_RESPONSE:
        queueEvent({
          eventType: EVENTS.BID_RESPONSE,
          args: args,
        });
        break;

      case EVENTS.BIDDER_DONE:
        queueEvent({
          eventType: EVENTS.BIDDER_DONE,
          args: args,
        });
        break;

      case EVENTS.BID_WON:
        sendBidWonAnalytics(args);
        break;

      case EVENTS.NO_BID:
        queueEvent({
          eventType: EVENTS.NO_BID,
          args: args,
        });
        break;

      case EVENTS.AUCTION_END:
        queueEvent({
          eventType: EVENTS.AUCTION_END,
          args: args,
        });
        break;

      case EVENTS.BID_TIMEOUT:
        queueEvent({
          eventType: EVENTS.BID_TIMEOUT,
          args: args,
        });
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
function sendBatchAnalytics() {
  if (eventQueue.length > 0) {
    ajax(
      setupadAnalyticsEndpoint,
      () => logInfo('SETUPAD_ANALYTICS_BATCH_SENT'),
      JSON.stringify({ data: eventQueue, adUnitCodes: adUnitCodesCache }),
      {
        contentType: 'application/json',
        method: 'POST',
      }
    );

    adUnitCodesCache = [];
    eventQueue = [];
  }
}

/**
 * Queues event data for our batch and triggers send if it's auction end
 * @param {object} data - event data to be added to the batch
 * @returns {void}
 */
function queueEvent(data) {
  eventQueue.push(data);
  if (data.eventType === EVENTS.AUCTION_INIT) {
    adUnitCodesCache = handleAdUnitCodes(data?.args?.adUnitCodes);
  }
  if (data.eventType === EVENTS.AUCTION_END) sendBatchAnalytics();
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
