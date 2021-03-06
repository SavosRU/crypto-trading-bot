let assert = require('assert')
let MACD = require('../../../../modules/strategy/strategies/macd')
let IndicatorBuilder = require('../../../../modules/strategy/dict/indicator_builder')
let IndicatorPeriod = require('../../../../modules/strategy/dict/indicator_period')

describe('#strategy macd', () => {
    it('macd indicator builder', async () => {
        let indicatorBuilder = new IndicatorBuilder()
        let macd = new MACD()

        macd.buildIndicator(indicatorBuilder, {'period': '15m'})
        assert.equal(3, indicatorBuilder.all().length)
    });

    it('macd long', async () => {
        let macd = new MACD()

        assert.equal('long', (await macd.period(new IndicatorPeriod(404, {
            'sma200': [500, 400, 388],
            'ema200': [500, 400, 388],
            'macd': [{'histogram': -1}, {'histogram': 0.1}, {'histogram': 0.3}],
        })))['signal'])

        assert.equal(undefined, (await macd.period(new IndicatorPeriod(404, {
            'sma200': [500, 400, 388],
            'ema200': [500, 400, 388],
            'macd': [{'histogram': -2}, {'histogram': -1}, {'histogram': -0.3}],
        })))['signal'])

        assert.equal(undefined, (await macd.period(new IndicatorPeriod(404, {
            'sma200': [500, 400, 388],
            'ema200': [500, 400, 388],
            'macd': [{'histogram': 2}, {'histogram': -1}, {'histogram': -0.3}],
        })))['signal'])
    })

    it('macd short', async () => {
        let macd = new MACD()

        assert.equal('short', (await macd.period(new IndicatorPeriod(394, {
            'sma200': [500, 400, 399],
            'ema200': [500, 400, 399],
            'macd': [{'histogram': 1}, {'histogram': -0.1}, {'histogram': -0.2}],
        })))['signal'])

        assert.equal(undefined, (await macd.period(new IndicatorPeriod(403, {
            'sma200': [500, 400, 399],
            'ema200': [500, 400, 399],
            'macd': [{'histogram': 1}, {'histogram': -0.1}, {'histogram': -0.2}],
        }))['signal']))
    })
})
