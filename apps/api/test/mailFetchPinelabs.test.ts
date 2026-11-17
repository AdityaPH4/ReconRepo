import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { downloadPinelabsMpr, pinelabsMprLinks } from '../src/services/mailFetchService.ts';

const ID = '1bc55043-d910-45d3-b352-3280d1ab24e9';
const URL = `https://settlement-content.pinelabs.com/${ID}`;

describe('pinelabsMprLinks()', () => {
  it('finds the download link in html and text, once', () => {
    assert.deepEqual(pinelabsMprLinks(`<a href="${URL}">Download MPR</a> [${URL}]`), [URL]);
  });

  it('ignores other hosts and look-alikes', () => {
    assert.deepEqual(pinelabsMprLinks(`https://settlement-content.pinelabs.com.evil.com/${ID} http://settlement-content.pinelabs.com/${ID} https://example.com/${ID}`), []);
  });
});

describe('downloadPinelabsMpr()', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const reply = (body: string, init: ResponseInit) => {
    globalThis.fetch = (async () => new Response(body, init)) as typeof fetch;
  };

  it("keeps the server's own file name, decoded", async () => {
    reply('x', { headers: { 'content-disposition': 'attachment; filename="261115_0530_Ph4food%26bev_POS_AuthMerchantMpr.xlsx"' } });
    const f = await downloadPinelabsMpr(URL);
    assert.equal(f.name, '261115_0530_Ph4food&bev_POS_AuthMerchantMpr.xlsx');
    assert.equal(f.body.toString(), 'x');
  });

  it('falls back to a name Pinelabs detection recognises when the server sends none', async () => {
    reply('x', {});
    assert.equal((await downloadPinelabsMpr(URL)).name, `pinelabs_${ID}.xlsx`);
  });

  it('rejects an error response and a non-spreadsheet file', async () => {
    reply('no', { status: 404 });
    await assert.rejects(downloadPinelabsMpr(URL), /HTTP 404/);
    reply('x', { headers: { 'content-disposition': 'attachment; filename="report.pdf"' } });
    await assert.rejects(downloadPinelabsMpr(URL), /unexpected file type/);
  });
});
