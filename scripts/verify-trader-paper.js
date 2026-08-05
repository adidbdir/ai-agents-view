#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const srv = require('../server.js');

function makePaths(root) {
  const dir = path.join(root, 'data', 'trader');
  return srv._test.traderPaths({
    dir,
    pricesPath: path.join(dir, 'prices.jsonl'),
    portfolioPath: path.join(dir, 'portfolio.json'),
    configPath: path.join(root, 'trader-config.json'),
    statePath: path.join(dir, 'state.json'),
  });
}

function mockResponse(payload) {
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-paper-'));
  const paths = makePaths(root);

  const savedConfig = srv.saveTraderConfig({
    enabled: true,
    assets: ['bitcoin', 'ethereum'],
    vsCurrency: 'jpy',
    priceIntervalMin: 15,
    analysisHour: 7,
    startBalance: 120000,
    priceProvider: 'auto',
    symbolMap: {
      bitcoin: 'BTC-JPY',
      ethereum: 'ETH-JPY',
    },
  }, paths);
  assert.equal(savedConfig.enabled, true);
  assert.equal(savedConfig.startBalance, 120000);
  assert.deepEqual(savedConfig.assets, ['bitcoin', 'ethereum']);
  assert.equal(savedConfig.priceProvider, 'auto');
  assert.equal(savedConfig.symbolMap.bitcoin, 'BTC-JPY');

  const series = [];
  for (let i = 0; i < 16; i++) {
    const at = new Date(Date.UTC(2026, 6, 23, i * 12, 0, 0));
    series.push({
      now: at,
      payload: {
        bitcoin: { jpy: 15000000 + i * 180000, jpy_24h_change: 0.8 + i * 0.15 },
        ethereum: { jpy: 520000 - i * 2500, jpy_24h_change: -0.2 - i * 0.05 },
      },
    });
  }

  let fetchCalls = 0;
  for (const item of series) {
    await srv._test.maybeFetchTraderPrices({
      paths,
      config: savedConfig,
      now: item.now,
      force: true,
      fetchImpl: async () => {
        fetchCalls++;
        return mockResponse(item.payload);
      },
    });
  }
  assert.equal(fetchCalls, series.length);

  const history = srv.loadTraderPriceHistory(paths, savedConfig);
  assert.equal(history.length, series.length);

  const indicators = srv._test.computeTraderIndicators(history, savedConfig);
  assert.ok(indicators.bitcoin.sma24h > 0);
  assert.ok(indicators.bitcoin.sma7d > 0);
  assert.ok(indicators.bitcoin.rsi14 !== null);
  assert.ok(indicators.bitcoin.change24h !== null);
  assert.ok(indicators.bitcoin.change7d !== null);

  let yahooCalls = 0;
  let coingeckoCalls = 0;
  const yahooNow = new Date('2026-08-01T00:00:00.000Z');
  const yahooRecord = await srv._test.maybeFetchTraderPrices({
    paths,
    config: savedConfig,
    now: yahooNow,
    force: true,
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes('coingecko')) {
        coingeckoCalls++;
        throw new Error('fetch failed');
      }
      yahooCalls++;
      assert.equal(options.headers['User-Agent'], 'Mozilla/5.0');
      const price = String(url).includes('BTC-JPY') ? 18123456 : 512345;
      const prevClose = String(url).includes('BTC-JPY') ? 17600000 : 500000;
      return mockResponse({
        chart: {
          result: [{
            meta: {
              regularMarketPrice: price,
              chartPreviousClose: prevClose,
            },
          }],
        },
      });
    },
  });
  assert.equal(coingeckoCalls, 1);
  assert.equal(yahooCalls, 2);
  assert.equal(Number(yahooRecord.prices.bitcoin.jpy), 18123456);
  assert.ok(Number.isFinite(Number(yahooRecord.prices.bitcoin.jpy_24h_change)));
  const fetchState = srv.loadTraderFetchState(paths);
  assert.equal(fetchState.currentProvider, 'yahoo');
  assert.equal(fetchState.lastFetchOk, true);

  coingeckoCalls = 0;
  yahooCalls = 0;
  await srv._test.maybeFetchTraderPrices({
    paths,
    config: savedConfig,
    now: new Date('2026-08-01T00:05:00.000Z'),
    force: true,
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes('coingecko')) {
        coingeckoCalls++;
        throw new Error('memoized yahoo should avoid coingecko');
      }
      yahooCalls++;
      assert.equal(options.headers['User-Agent'], 'Mozilla/5.0');
      const price = String(url).includes('BTC-JPY') ? 18125000 : 513000;
      const prevClose = String(url).includes('BTC-JPY') ? 17650000 : 501000;
      return mockResponse({
        chart: {
          result: [{
            meta: {
              regularMarketPrice: price,
              chartPreviousClose: prevClose,
            },
          }],
        },
      });
    },
  });
  assert.equal(coingeckoCalls, 0);
  assert.equal(yahooCalls, 2);

  const result = await srv.analyzeTrader({
    paths,
    config: savedConfig,
    now: new Date('2026-07-31T07:05:00+09:00'),
    ensurePrice: false,
    skipRuntimeGuard: true,
    providerConfig: { mode: 'cli', model: 'mock', cli: 'mock' },
    taskRunner: async () => JSON.stringify({
      signals: [
        { asset: 'bitcoin', action: 'buy', sizePct: 20, confidence: 0.72, reasoning: '24hと7dの上昇が継続し、RSIもまだ極端ではないため。' },
        { asset: 'ethereum', action: 'hold', sizePct: 0, confidence: 0.58, reasoning: '下向きで明確な反転シグナルが弱いため。' },
      ],
      marketNote: 'BTC優位の地合いを想定したペーパートレード。',
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.trades.length, 2);
  assert.equal(result.trades[0].side, 'buy');
  assert.ok(result.trades[0].qty > 0);
  assert.equal(result.trades[1].side, 'hold');
  assert.equal(result.portfolio.equityHistory.length, 1);
  assert.equal(result.portfolio.lastAnalysis.signals.length, 2);

  const status = srv.getTraderStatus({ paths });
  assert.equal(status.latestSignals.length, 2);
  assert.ok(status.positions.bitcoin.qty > 0);
  assert.ok(Number.isFinite(status.equity));
  assert.equal(status.marketNote, 'BTC優位の地合いを想定したペーパートレード。');

  const reset = srv.resetTraderPortfolio(paths, savedConfig);
  assert.equal(reset.cash, savedConfig.startBalance);
  assert.equal(Object.keys(reset.positions).length, 0);
  assert.equal(reset.trades.length, 0);
  assert.equal(reset.equityHistory.length, 0);

  console.log('verify-trader-paper: OK');
  console.log(`temp_root=${root}`);
  console.log(`prices=${history.length} indicators=ok trades=${result.trades.length} reset=ok fetch_calls=${fetchCalls}`);
}

main().catch((err) => {
  console.error('verify-trader-paper: FAILED');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
