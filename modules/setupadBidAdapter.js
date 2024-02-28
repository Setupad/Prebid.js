import {
  _each,
  createTrackPixelHtml,
  deepAccess,
  isStr,
  getBidIdParameter,
  triggerPixel,
  logWarn,
} from '../src/utils.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { getRefererInfo } from '../src/refererDetection.js';
import { BANNER } from '../src/mediaTypes.js';

const BIDDER_CODE = 'setupad';
const ENDPOINT = 'https://prebid.setupad.io/openrtb2/auction';
const SYNC_ENDPOINT = 'https://cookie.stpd.cloud/sync?';
const REPORT_ENDPOINT = 'https://adapter-analytics.setupad.io/api/adapter-analytics';
const GVLID = 1241;
const TIME_TO_LIVE = 360;
const biddersCpms = {};
const biddersCreativeIds = {};

function getEids(bidRequest) {
  if (deepAccess(bidRequest, 'userIdAsEids')) return bidRequest.userIdAsEids;
}

export const spec = {
  code: BIDDER_CODE,
  supportedMediaTypes: [BANNER],
  gvlid: GVLID,

  isBidRequestValid: function (bid) {
    return !!(bid.params.placement_id && isStr(bid.params.placement_id));
  },

  buildRequests: function (validBidRequests, bidderRequest) {
    const requests = [];
    window.nmmRefreshCounts = window.nmmRefreshCounts || {};
    _each(validBidRequests, function (bid) {
      window.nmmRefreshCounts[bid.adUnitCode] = window.nmmRefreshCounts[bid.adUnitCode] || 0;
      const id = getBidIdParameter('placement_id', bid.params);
      const accountId = getBidIdParameter('account_id', bid.params);
      const auctionId = bid.auctionId;
      const bidId = bid.bidId;
      const eids = getEids(bid) || undefined;
      let sizes = bid.sizes;
      if (sizes && !Array.isArray(sizes[0])) sizes = [sizes];

      const site = getSiteObj();
      const device = getDeviceObj();

      const payload = {
        id: bid?.bidderRequestId,
        ext: {
          prebid: {
            storedrequest: {
              id: accountId || 'default',
            },
          },
        },
        user: { ext: { eids } },
        device,
        site,
        imp: [],
      };

      const imp = {
        id: bid.adUnitCode,
        ext: {
          prebid: {
            storedrequest: { id },
          },
        },
      };

      if (deepAccess(bid, 'mediaTypes.banner')) {
        imp.banner = {
          format: (sizes || []).map((s) => {
            return { w: s[0], h: s[1] };
          }),
        };
      }

      payload.imp.push(imp);

      const gdprConsent = bidderRequest && bidderRequest.gdprConsent;
      const uspConsent = bidderRequest && bidderRequest.uspConsent;

      if (gdprConsent || uspConsent) {
        payload.regs = { ext: {} };

        if (uspConsent) payload.regs.ext.us_privacy = uspConsent;

        if (gdprConsent) {
          if (typeof gdprConsent.gdprApplies !== 'undefined') {
            payload.regs.ext.gdpr = gdprConsent.gdprApplies ? 1 : 0;
          }

          if (typeof gdprConsent.consentString !== 'undefined') {
            payload.user.ext.consent = gdprConsent.consentString;
          }
        }
      }
      const params = bid.params;

      requests.push({
        method: 'POST',
        url: ENDPOINT,
        data: JSON.stringify(payload),
        options: {
          contentType: 'text/plain',
          withCredentials: true,
        },

        bidId,
        params,
        auctionId,
      });
    });

    return requests;
  },

  interpretResponse: function (serverResponse, bidRequest) {
    if (
      !serverResponse ||
      !serverResponse.body ||
      typeof serverResponse.body != 'object' ||
      Object.keys(serverResponse.body).length === 0
    ) {
      logWarn('no response or body is malformed');
      return [];
    }

    const serverBody = serverResponse.body;
    const bidResponses = [];

    _each(serverBody.seatbid, (res) => {
      _each(res.bid, (bid) => {
        const requestId = bidRequest.bidId;
        const params = bidRequest.params;
        const { ad, adUrl } = getAd(bid);

        const bidResponse = {
          requestId,
          params,
          cpm: bid.price,
          width: bid.w,
          height: bid.h,
          creativeId: bid.id,
          currency: serverBody.cur,
          netRevenue: true,
          ttl: TIME_TO_LIVE,
          meta: {
            advertiserDomains: bid.adomain || [],
          },
        };

        // Set all bidders obj for later use in getPixelUrl()
        biddersCpms[res.seat] = bidResponse.cpm;
        biddersCreativeIds[res.seat] = bidResponse.creativeId;

        bidResponse.ad = ad;
        bidResponse.adUrl = adUrl;
        bidResponses.push(bidResponse);
      });
    });

    return bidResponses;
  },

  getUserSyncs: function (syncOptions, responses, gdprConsent, uspConsent) {
    if (!responses?.length) return [];

    const syncs = [];
    const bidders = getBidders(responses);

    if (syncOptions.iframeEnabled && bidders) {
      const queryParams = [];

      queryParams.push(`bidders=${bidders}`);
      queryParams.push('gdpr=' + +gdprConsent.gdprApplies);
      queryParams.push('gdpr_consent=' + gdprConsent.consentString);
      queryParams.push('usp_consent=' + (uspConsent || ''));

      const strQueryParams = queryParams.join('&');

      syncs.push({
        type: 'iframe',
        url: SYNC_ENDPOINT + strQueryParams + '&type=iframe',
      });

      return syncs;
    }

    return [];
  },

  onBidWon: function (bid) {
    let bidder = bid.bidder || bid.bidderCode;
    const auctionId = bid.auctionId;
    if (bidder !== BIDDER_CODE) return;

    let params;
    if (bid.params) {
      params = Array.isArray(bid.params) ? bid.params : [bid.params];
    } else {
      if (Array.isArray(bid.bids)) {
        params = bid.bids.map((singleBid) => singleBid.params);
      }
    }

    if (!params?.length) return;

    const placementIdsArray = [];
    params.forEach((param) => {
      if (!param.placement_id) return;
      placementIdsArray.push(param.placement_id);
    });

    const placementIds = (placementIdsArray.length && placementIdsArray.join(';')) || '';

    if (!placementIds) return;

    let extraBidParams = '';

    // Iterate through all bidders to find the winning bidder by using creativeId as identification
    for (const bidderName in biddersCreativeIds) {
      if (
        biddersCreativeIds.hasOwnProperty(bidderName) &&
        biddersCreativeIds[bidderName] === bid.creativeId
      ) {
        bidder = bidderName;
        break; // Exit the loop if a match is found
      }
    }

    // Add extra parameters
    extraBidParams = `&cpm=${bid.originalCpm}&currency=${bid.originalCurrency}`;

    const url = `${REPORT_ENDPOINT}?event=bidWon&bidder=${bidder}&placementIds=${placementIds}&auctionId=${auctionId}${extraBidParams}&timestamp=${Date.now()}`;
    triggerPixel(url);
  },
};

function getBidders(serverResponse) {
  const bidders = serverResponse
    .map((res) => Object.keys(res.body.ext.responsetimemillis || []))
    .flat(1);

  if (bidders.length) {
    return encodeURIComponent(JSON.stringify([...new Set(bidders)]));
  }
}

function getAd(bid) {
  let ad, adUrl, vastXml, vastUrl;

  switch (deepAccess(bid, 'ext.prebid.type')) {
    default:
      if (bid.adm && bid.nurl) {
        ad = bid.adm;
        ad += createTrackPixelHtml(decodeURIComponent(bid.nurl));
      } else if (bid.adm) {
        ad = bid.adm;
      } else if (bid.nurl) {
        adUrl = bid.nurl;
      }
  }

  return { ad, adUrl, vastXml, vastUrl };
}

function getSiteObj() {
  const refInfo = (getRefererInfo && getRefererInfo()) || {};

  return {
    page: refInfo.page,
    ref: refInfo.ref,
    domain: refInfo.domain,
  };
}

function getDeviceObj() {
  return {
    w:
      window.innerWidth ||
      window.document.documentElement.clientWidth ||
      window.document.body.clientWidth ||
      0,
    h:
      window.innerHeight ||
      window.document.documentElement.clientHeight ||
      window.document.body.clientHeight ||
      0,
  };
}

registerBidder(spec);
