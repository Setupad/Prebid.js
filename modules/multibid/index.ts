/**
 * This module adds Multibid support to prebid.js
 * @module modules/multibid
 */

import {config} from '../../src/config.js';
import {setupBeforeHookFnOnce, getHook} from '../../src/hook.js';
import {
  logWarn, deepAccess, getUniqueIdentifierStr, deepSetValue, groupBy
} from '../../src/utils.js';
import * as events from '../../src/events.js';
import { EVENTS } from '../../src/constants.js';
import {addBidderRequests} from '../../src/auction.js';
import {getHighestCpmBidsFromBidPool, sortByDealAndPriceBucketOrCpm} from '../../src/targeting.js';
import {PBS, registerOrtbProcessor, REQUEST} from '../../src/pbjsORTB.js';
import {timedBidResponseHook} from '../../src/utils/perfMetrics.js';
import type {BidderCode} from "../../src/types/common.d.ts";

const MODULE_NAME = 'multibid';
let hasMultibid = false;
let multiConfig = {};
let multibidUnits = {};

type MultiBidConfig = ({
  /**
   * A bidder code.
   */
  bidder: BidderCode;
  bidders?: undefined
} | {
  /**
   * Multiple bidder codes.
   */
  bidders: BidderCode[];
  bidder?: undefined;
}) & {
  /**
   * The number of bids the named bidder(s) can supply. Max of 9.
   */
  maxBids: number;
  /**
   * An alternate (short) bidder code to send to the ad server. A number will be appended, starting from 2, e.g. hb_pb_PREFIX2.
   * If not provided, the extra bids will not go to the ad server.
   */
  targetBiddercodePrefix?: string;
}

declare module '../../src/config' {
  interface Config {
    multibid?: MultiBidConfig[];
  }
}

// Storing this globally on init for easy reference to configuration
config.getConfig(MODULE_NAME, conf => {
  if (!Array.isArray(conf.multibid) || !conf.multibid.length || !validateMultibid(conf.multibid)) return;

  resetMultiConfig();
  hasMultibid = true;

  conf.multibid.forEach(entry => {
    if (entry.bidder) {
      multiConfig[entry.bidder] = {
        maxbids: entry.maxBids,
        prefix: entry.targetBiddercodePrefix
      }
    } else {
      entry.bidders.forEach(key => {
        multiConfig[key] = {
          maxbids: entry.maxBids,
          prefix: entry.targetBiddercodePrefix
        }
      });
    }
  });
});

/**
 * @summary validates multibid configuration entries
 * @param {Object[]} conf - example [{bidder: 'bidderA', maxbids: 2, prefix: 'bidA'}, {bidder: 'bidderB', maxbids: 2}]
 * @return {Boolean}
 */
export function validateMultibid(conf) {
  let check = true;
  const duplicate = conf.filter(entry => {
    // Check if entry.bidder is not defined or typeof string, filter entry and reset configuration
    if ((!entry.bidder || typeof entry.bidder !== 'string') && (!entry.bidders || !Array.isArray(entry.bidders))) {
      logWarn('Filtering multibid entry. Missing required bidder or bidders property.');
      check = false;
      return false;
    }

    return true;
  }).map(entry => {
    // Check if entry.maxbids is not defined, not typeof number, or less than 1, set maxbids to 1 and reset configuration
    // Check if entry.maxbids is greater than 9, set maxbids to 9 and reset configuration
    if (typeof entry.maxBids !== 'number' || entry.maxBids < 1 || entry.maxBids > 9) {
      entry.maxBids = (typeof entry.maxBids !== 'number' || entry.maxBids < 1) ? 1 : 9;
      check = false;
    }

    return entry;
  });

  if (!check) config.setConfig({multibid: duplicate});

  return check;
}

/**
 * @summary addBidderRequests before hook
 * @param {Function} fn reference to original function (used by hook logic)
 * @param {Object[]} bidderRequests containing copy of each bidderRequest object
 */
export function adjustBidderRequestsHook(fn, bidderRequests) {
  bidderRequests.map(bidRequest => {
    // Loop through bidderRequests and check if bidderCode exists in multiconfig
    // If true, add bidderRequest.bidLimit to bidder request
    if (multiConfig[bidRequest.bidderCode]) {
      bidRequest.bidLimit = multiConfig[bidRequest.bidderCode].maxbids
    }
    return bidRequest;
  })

  fn.call(this, bidderRequests);
}

declare module '../../src/bidfactory' {
  interface BaseBid {
    // TODO multibid alters bid's `requestId` and `bidderCode`, which is not
    // necessary if the objective is to just alter targeting.
    // is it desirable for e.g. analytics to see bogus bidder codes?
    multibidPrefix?: string;
    originalBidder?: BaseBid['bidderCode'];
    originalRequestId?: BaseBid['requestId'];
    targetingBidder?: string;
  }
}
/**
 * @summary addBidResponse before hook
 * @param {Function} fn reference to original function (used by hook logic)
 * @param {String} ad unit code for bid
 * @param {Object} bid object
 */
export const addBidResponseHook = timedBidResponseHook('multibid', function addBidResponseHook(fn, adUnitCode, bid, reject) {
  const floor = deepAccess(bid, 'floorData.floorValue');

  if (!config.getConfig('multibid')) resetMultiConfig();
  // Checks if multiconfig exists and bid bidderCode exists within config and is an adpod bid
  // Else checks if multiconfig exists and bid bidderCode exists within config
  // Else continue with no modifications
  if (hasMultibid && multiConfig[bid.bidderCode] && deepAccess(bid, 'video.context') === 'adpod') {
    fn.call(this, adUnitCode, bid, reject);
  } else if (hasMultibid && multiConfig[bid.bidderCode]) {
    // Set property multibidPrefix on bid
    if (multiConfig[bid.bidderCode].prefix) bid.multibidPrefix = multiConfig[bid.bidderCode].prefix;
    bid.originalBidder = bid.bidderCode;
    // Check if stored bids for auction include adUnitCode.bidder and max limit not reach for ad unit
    if (deepAccess(multibidUnits, [adUnitCode, bid.bidderCode])) {
      // Store request id under new property originalRequestId, create new unique bidId,
      // and push bid into multibid stored bids for auction if max not reached and bid cpm above floor
      if (!multibidUnits[adUnitCode][bid.bidderCode].maxReached && (!floor || floor <= bid.cpm)) {
        bid.originalRequestId = bid.requestId;

        bid.requestId = getUniqueIdentifierStr();
        multibidUnits[adUnitCode][bid.bidderCode].ads.push(bid);

        const length = multibidUnits[adUnitCode][bid.bidderCode].ads.length;

        if (multiConfig[bid.bidderCode].prefix) bid.targetingBidder = multiConfig[bid.bidderCode].prefix + length;
        if (length === multiConfig[bid.bidderCode].maxbids) multibidUnits[adUnitCode][bid.bidderCode].maxReached = true;

        fn.call(this, adUnitCode, bid, reject);
      } else {
        logWarn(`Filtering multibid received from bidder ${bid.bidderCode}: ` + ((multibidUnits[adUnitCode][bid.bidderCode].maxReached) ? `Maximum bid limit reached for ad unit code ${adUnitCode}` : 'Bid cpm under floors value.'));
      }
    } else {
      if (deepAccess(bid, 'floorData.floorValue')) deepSetValue(multibidUnits, [adUnitCode, bid.bidderCode], {floor: deepAccess(bid, 'floorData.floorValue')});

      deepSetValue(multibidUnits, [adUnitCode, bid.bidderCode], {ads: [bid]});
      if (multibidUnits[adUnitCode][bid.bidderCode].ads.length === multiConfig[bid.bidderCode].maxbids) multibidUnits[adUnitCode][bid.bidderCode].maxReached = true;

      fn.call(this, adUnitCode, bid, reject);
    }
  } else {
    fn.call(this, adUnitCode, bid, reject);
  }
});

/**
 * A descending sort function that will sort the list of objects based on the following:
 *  - bids without dynamic aliases are sorted before bids with dynamic aliases
 */
export function sortByMultibid(a, b) {
  if (a.bidder !== a.bidderCode && b.bidder === b.bidderCode) {
    return 1;
  }

  if (a.bidder === a.bidderCode && b.bidder !== b.bidderCode) {
    return -1;
  }

  return 0;
}

/**
 * @summary getHighestCpmBidsFromBidPool before hook
 * @param {Function} fn reference to original function (used by hook logic)
 * @param {Object[]} bidsReceived array of objects containing all bids from bid pool
 * @param {Function} highestCpmCallback function to reduce to only highest cpm value for each bidderCode
 * @param {Number} adUnitBidLimit bidder targeting limit, default set to 0
 * @param {Boolean} hasModified default set to false, this hook modifies targeting and sets to true
 */
export function targetBidPoolHook(fn, bidsReceived, highestCpmCallback, adUnitBidLimit = 0, hasModified = false) {
  if (!config.getConfig('multibid')) resetMultiConfig();
  if (hasMultibid) {
    const dealPrioritization = config.getConfig('sendBidsControl.dealPrioritization');
    const modifiedBids = [];
    const buckets = groupBy(bidsReceived, 'adUnitCode');
    const bids = [].concat(...Object.keys(buckets).reduce((result, slotId) => {
      let bucketBids = [];
      // Get bids and group by property originalBidder
      const bidsByBidderName = groupBy(buckets[slotId], 'originalBidder');
      const adjustedBids = [].concat(...Object.keys(bidsByBidderName).map(key => {
        // Reset all bidderCodes to original bidder values and sort by CPM
        return bidsByBidderName[key].sort((bidA, bidB) => {
          if (bidA.originalBidder && bidA.originalBidder !== bidA.bidderCode) bidA.bidderCode = bidA.originalBidder;
          if (bidA.originalBidder && bidB.originalBidder !== bidB.bidderCode) bidB.bidderCode = bidB.originalBidder;
          return bidA.cpm > bidB.cpm ? -1 : (bidA.cpm < bidB.cpm ? 1 : 0);
        }).map((bid, index) => {
          // For each bid (post CPM sort), set dynamic bidderCode using prefix and index if less than maxbid amount
          if (deepAccess(multiConfig, `${bid.bidderCode}.prefix`) && index !== 0 && index < multiConfig[bid.bidderCode].maxbids) {
            bid.bidderCode = multiConfig[bid.bidderCode].prefix + (index + 1);
          }

          return bid
        })
      }));
      // Get adjustedBids by bidderCode and reduce using highestCpmCallback
      const bidsByBidderCode = groupBy(adjustedBids, 'bidderCode');
      Object.keys(bidsByBidderCode).forEach(key => bucketBids.push(bidsByBidderCode[key].reduce(highestCpmCallback)));
      // if adUnitBidLimit is set, pass top N number bids
      if (adUnitBidLimit > 0) {
        bucketBids = dealPrioritization ? bucketBids.sort(sortByDealAndPriceBucketOrCpm(true)) : bucketBids.sort((a, b) => b.cpm - a.cpm);
        bucketBids.sort(sortByMultibid);
        modifiedBids.push(...bucketBids.slice(0, adUnitBidLimit));
      } else {
        modifiedBids.push(...bucketBids);
      }

      return [].concat(...modifiedBids);
    }, []));

    fn.call(this, bids, highestCpmCallback, adUnitBidLimit, true);
  } else {
    fn.call(this, bidsReceived, highestCpmCallback, adUnitBidLimit);
  }
}

/**
 * Resets globally stored multibid configuration
 */
export const resetMultiConfig = () => { hasMultibid = false; multiConfig = {}; };

/**
 * Resets globally stored multibid ad unit bids
 */
export const resetMultibidUnits = () => {
  multibidUnits = {};
};

/**
 * Set up hooks on init
 */
function init() {
  // TODO: does this reset logic make sense - what about simultaneous auctions?
  events.on(EVENTS.AUCTION_INIT, resetMultibidUnits);
  setupBeforeHookFnOnce(addBidderRequests, adjustBidderRequestsHook);
  getHook('addBidResponse').before(addBidResponseHook, 3);
  setupBeforeHookFnOnce(getHighestCpmBidsFromBidPool, targetBidPoolHook);
}

init();

export function setOrtbExtPrebidMultibid(ortbRequest) {
  const multibid = config.getConfig('multibid');
  if (multibid) {
    deepSetValue(ortbRequest, 'ext.prebid.multibid', multibid.map(o =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v])))
    )
  }
}

registerOrtbProcessor({type: REQUEST, name: 'extPrebidMultibid', fn: setOrtbExtPrebidMultibid, dialects: [PBS]});
