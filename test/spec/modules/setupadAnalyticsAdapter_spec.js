import setupadAnalyticsAdapter from '../../../modules/setupadAnalyticsAdapter.js';
import { handleAdUnitCodes } from '../../../modules/setupadAnalyticsAdapter.js';
import adapterManager from '../../../src/adapterManager.js';
import { expect } from 'chai';
import * as events from '../../../src/events.js';
import { EVENTS } from '../../../src/constants.js';
import { generateUUID } from '../../../src/utils.js';
import { server } from 'test/mocks/xhr.js';

describe('setupadAnalyticsAdapter', () => {
  describe('handleAdUnitCodes', () => {
    it('should return empty array if data is invalid', () => {
      expect(handleAdUnitCodes()).to.be.an('array').that.is.empty;
      expect(handleAdUnitCodes([])).to.be.an('array').that.is.empty;
      expect(handleAdUnitCodes({})).to.be.an('array').that.is.empty;
    });

    it('should return valid array if data is correct', () => {
      const adunitsCodes = handleAdUnitCodes(['id1']);
      expect(adunitsCodes).to.have.lengthOf(1);
      expect(handleAdUnitCodes(['id1', 'id2'])).to.have.lengthOf(2);
      expect(adunitsCodes[0]).to.be.an('object');
      expect(adunitsCodes[0]).to.have.keys(['adUnitCode', 'gamPath']);
      expect(adunitsCodes[0]).to.include({ adUnitCode: 'id1' });
    });
  });

  describe('enableAnalytics', () => {
    afterEach(() => {
      setupadAnalyticsAdapter.disableAnalytics();
    });

    it('registers itself with the adapter manager', () => {
      const adapter = adapterManager.getAnalyticsAdapter('setupadAnalyticsAdapter');
      expect(adapter).to.exist;
      expect(adapter.gvlid).to.be.a('number');
      expect(adapter.adapter).to.equal(setupadAnalyticsAdapter);
    });

    it('should send proper data to backend', () => {
      setupadAnalyticsAdapter.enableAnalytics({
        provider: 'setupad',
      });

      const auctionId = generateUUID();

      const auctionInitPayload = {
        auctionId: auctionId,
        adUnitCodes: ['usr1234'],
      };

      const bidRequestedPayload = {
        auctionId: auctionId,
        bids: [
          {
            adUnitCode: 'usr1234',
            bidder: 'bidder1',
          },
        ],
      };

      const auctionEndPayload = {
        auctionId: auctionId,
        adUnits: [
          {
            code: 'usr1234',
          },
        ],
      };
      events.emit(EVENTS.AUCTION_INIT, auctionInitPayload);
      events.emit(EVENTS.BID_REQUESTED, auctionInitPayload);
      events.emit(EVENTS.AUCTION_END, auctionEndPayload);

      // check if request has proper payload
      const body = JSON.parse(server.requests[0].requestBody);
      expect(body).to.have.keys('data', 'adUnitCodes');

      // check if request has proper data
      expect(body.data).to.have.lengthOf(1);
      expect(body.data[0]).to.have.keys('eventType', 'args');
    });

    it('sends bid won events to the backend', () => {
      setupadAnalyticsAdapter.enableAnalytics({
        provider: 'setupad',
      });
      const auction = { adUnitCode: '12345', bidderCode: 'test-code' };

      events.emit(EVENTS.BID_WON, auction);
      expect(server.requests).to.have.lengthOf.at.least(1);

      // check if bid won request has proper payload
      const bidWonRequest = server.requests.find((req) =>
        req.requestBody.includes('"eventType":"bidWon"')
      );

      const body = JSON.parse(bidWonRequest.requestBody);
      expect(body).to.have.keys('data', 'adUnitCodes');
    });
  });
});
