'use strict';

let Candlestick = require('./../dict/candlestick')
let Ticker = require('./../dict/ticker')
let Orderbook = require('./../dict/orderbook')

let CandlestickEvent = require('./../event/candlestick_event')
let TickerEvent = require('./../event/ticker_event')
let OrderbookEvent = require('./../event/orderbook_event')

let resample = require('./../utils/resample')

let moment = require('moment')
let request = require('request');
var crypto = require('crypto')

let BitMEXClient = require('bitmex-realtime-api');
let Position = require('../dict/position.js');
let ExchangeOrder = require('../dict/exchange_order');

let orderUtil = require('../utils/order_util');
var _ = require('lodash')

module.exports = class Bitmex {
    constructor(eventEmitter, logger) {
        this.eventEmitter = eventEmitter
        this.logger = logger
        this.apiKey = undefined
        this.apiSecret = undefined
        this.tickSizes = {}
        this.lotSizes = {}
        this.symbols = []
    }

    start(config, symbols) {
        let eventEmitter = this.eventEmitter
        let logger = this.logger
        let tickSizes = this.tickSizes
        let lotSizes = this.lotSizes

        this.symbols = symbols
        this.positions = {}
        this.orders = {}

        let client = new BitMEXClient({
            'apiKeyID': this.apiKey = config.key,
            'apiKeySecret': this.apiSecret = config.secret,
            'testnet': this.getBaseUrl().includes('testnet'),
        })

        client.on('error', (error) => {
            console.error(error)
            logger.error('Bitmex: error' + JSON.stringify(error))
        })

        client.on('open', () => {
            logger.info('Bitmex: Connection opened.')
            console.log('Bitmex: Connection opened.')
        })

        client.on('close', () => {
            logger.info('Bitmex: Connection closed.')
            console.log('Bitmex: Connection closed.')
        })

        let me = this
        client.on('end', () => {
            logger.info('Bitmex: Connection closed.')
            console.log('Bitmex: Connection closed.')

            // retry connecting after some second to not bothering on high load
            setTimeout(() => {
                me.start(config, symbols)
            }, 10000);
        })

        symbols.forEach(symbol => {
            symbol['periods'].forEach(time => {

                let wantPeriod = time
                let resamplePeriod = undefined

                // TODO: provide a period minutes time converter
                if (time === '15m') {
                    wantPeriod = '5m'
                    resamplePeriod = 15
                }

                request(me.getBaseUrl() + '/api/v1/trade/bucketed?binSize=' + wantPeriod + '&partial=false&symbol=' + symbol['symbol'] + '&count=500&reverse=true', { json: true }, (err, res, body) => {
                    if (err) {
                        console.log(err)
                        logger.error('Bitmex candle backfill error: ' + err)
                        return
                    }

                    if(!Array.isArray(body)) {
                        console.log(body);
                        logger.error('Bitmex candle backfill error: ' + JSON.stringify(body))
                        return
                    }

                    let sticks = body.map(candle => {
                        return new Candlestick(
                            moment(candle['timestamp']).format('X'),
                            candle['open'],
                            candle['high'],
                            candle['low'],
                            candle['close'],
                            candle['volume'],
                        )
                    })

                    if (resamplePeriod) {
                        sticks = resample.resampleMinutes(sticks, resamplePeriod)
                    }

                    eventEmitter.emit('candlestick', new CandlestickEvent(this.getName(), symbol['symbol'], time, sticks));
                });

                client.addStream(symbol['symbol'], 'tradeBin' + wantPeriod, (candles) => {
                    // we need a force reset; candles are like queue
                    let myCandles = candles.slice();
                    candles.length = 0

                    let sticks = myCandles.map(candle => {
                        return new Candlestick(
                            moment(candle['timestamp']).format('X'),
                            candle['open'],
                            candle['high'],
                            candle['low'],
                            candle['close'],
                            candle['volume'],
                        );
                    });

                    if (resamplePeriod) {
                        sticks = resample.resampleMinutes(sticks, resamplePeriod)
                    }

                    eventEmitter.emit('candlestick', new CandlestickEvent(this.getName(), symbol['symbol'], time, sticks));
                })
            })

            client.addStream(symbol['symbol'], 'instrument', (instruments) => {
                instruments.forEach((instrument) => {
                    tickSizes[symbol['symbol']] = instrument['tickSize']
                    lotSizes[symbol['symbol']] = instrument['lotSize']

                    eventEmitter.emit('ticker', new TickerEvent(
                        this.getName(),
                        symbol['symbol'],
                        new Ticker(this.getName(), symbol['symbol'], moment().format('X'), instrument['bidPrice'], instrument['askPrice'])
                    ))
                })
            })

            /*
             * This stream alerts me of any executions of my orders. The results of the executions are seen in the postions stream

            client.addStream(symbol['symbol'], 'execution', (data, symbol, tableName) => {
            })
             */

            /*
            Disable: huge traffic with no use case right now
            var lastTime = moment().format('X');

            client.addStream(symbol['symbol'], 'orderBook10', (books) => {
                let s = moment().format('X');

                // throttle orderbook; updated to often
                if ((lastTime - s) > -5) {
                    return;
                }

                lastTime = s;

                books.forEach(function(book) {
                    eventEmitter.emit('orderbook', new OrderbookEvent(
                        'bitmex',
                        symbol['symbol'],
                        new Orderbook(book['bids'].map(function(item) {
                            return {'price': item[0], 'size': item[1]}
                        }), book['asks'].map(function(item) {
                            return {'price': item[0], 'size': item[1]}
                        }))
                    ));
                })
            });
            */

        })

        client.addStream('*', 'order', (orders) => {
            let ourOrders = this.orders

            Bitmex.createOrders(orders).forEach(order => {
                ourOrders[order.id] = order
            })

            // order cleanup
            for (let key in ourOrders){
                let order = ourOrders[key];
                if (order.status !== 'open') {
                    logger.debug('Cleanup non open order:' + JSON.stringify(order))
                    delete ourOrders[key]
                }
            }
        })

        // open position listener
        client.addStream('*', 'position', (positions) => {
            let myPositions = this.positions

            // cleanup our local known positions that are possible not open anymore
            positions
                .filter(position => position['isOpen'] === false)
                .map(position => position.symbol)
                .filter(symbol => symbol in myPositions)
                .forEach(symbol => {
                    logger.debug('Cleanup closed position: ' + symbol)
                    delete myPositions[symbol]
                })

            // add open positions
            Bitmex.createPositions(positions).forEach(position => {
                myPositions[position.symbol] = position
            })
        })
    }

    getOrders() {
        return new Promise(resolve => {
            let orders = []

            for (let key in this.orders){
                if (this.orders[key].status === 'open') {
                    orders.push(this.orders[key])
                }
            }

            resolve(orders)
        })
    }

    findOrderById(id) {
        return new Promise(async resolve => {
            resolve((await this.getOrders()).find(order =>
                order.id === id
            ))
        })
    }

    getOrdersForSymbol(symbol) {
        return new Promise(resolve => {
            let orders = []

            for(let key in this.orders){
                let order = this.orders[key];

                if(order.status === 'open' && order.symbol === symbol) {
                    orders.push(order)
                }
            }

            resolve(orders)
        })
    }

    getPositions() {
        return new Promise(resolve => {
            let results = []

            for (let x in this.positions) {
                results.push(this.positions[x])
            }

            resolve(results)
        })
    }

    getPositionForSymbol(symbol) {
        return new Promise(resolve => {

            for (let x in this.positions) {
                let position = this.positions[x];

                if(position.symbol === symbol) {
                    resolve(position)
                    return
                }
            }

            return resolve()
        })
    }

    /**
     * LTC: 0.008195 => 0.00820
     *
     * @param price
     * @param symbol
     * @returns {*}
     */
    calculatePrice(price, symbol) {
        if (!(symbol in this.tickSizes)) {
            return undefined
        }

        return orderUtil.calculateNearestSize(price, this.tickSizes[symbol])
    }

    /**
     * LTC: 0.65 => 1
     *
     * @param amount
     * @param symbol
     * @returns {*}
     */
    calculateAmount(amount, symbol) {
        if (!(symbol in this.lotSizes)) {
            return undefined
        }

        return orderUtil.calculateNearestSize(amount, this.lotSizes[symbol])
    }

    getName() {
        return 'bitmex'
    }

    order(order) {
        let data = Bitmex.createOrderBody(order)

        let verb = 'POST',
            path = '/api/v1/order',
            expires = new Date().getTime() + (60 * 1000) // 1 min in the future
        ;

        let postBody = JSON.stringify(data);
        let signature = crypto.createHmac('sha256', this.apiSecret).update(verb + path + expires + postBody).digest('hex');

        let headers = {
            'content-type' : 'application/json',
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'api-expires': expires,
            'api-key': this.apiKey,
            'api-signature': signature
        }

        let logger = this.logger
        return new Promise(async (resolve, reject) => {
            // update leverage for pair position
            await this.updateLeverage(order.symbol)

            request({
                headers: headers,
                url: this.getBaseUrl() + path,
                method: verb,
                body: postBody
            }, (error, response, body) => {
                if (error) {
                    logger.error('Bitmex: Invalid order update request:' + JSON.stringify({'error': error, 'body': body}))
                    console.log(error)
                    reject()

                    return
                }

                logger.info('Bitmex: Order created:' + JSON.stringify({'body': body}))

                let order = JSON.parse(body)
                if (order.error) {
                    logger.error('Bitmex: Invalid order created request:' + JSON.stringify(order))
                    console.log(body)
                    reject()
                    return
                }

                resolve(Bitmex.createOrders([order])[0])
            })
        })
    }

    /**
     * Set the configured leverage size "0-100" for pair before creating an order default "3" if not provided in configuration
     *
     * symbol configuration via:
     *
     * "extra.bitmex_leverage": 5
     *
     * @param symbol
     * @returns {Promise<any>}
     */
    async updateLeverage(symbol) {
        let logger = this.logger
        return new Promise((resolve, reject) => {
            let config = this.symbols.find(cSymbol => cSymbol.symbol === symbol)
            if (!config) {
                this.logger.error('Bitmex: Invalid leverage config for:' + symbol)
                resolve(false)

                return
            }

            // use default leverage to "3"
            let leverageSize = _.get(config, 'extra.bitmex_leverage', 3)

            if (leverageSize < 0 || leverageSize > 100) {
                throw 'Invalid leverage size for: ' + leverageSize + ' ' + symbol
            }

            var verb = 'POST',
                path = '/api/v1/position/leverage',
                expires = new Date().getTime() + (60 * 1000) // 1 min in the future
            ;

            let data = {
                'symbol': symbol,
                'leverage': leverageSize,
            }

            var postBody = JSON.stringify(data);
            var signature = crypto.createHmac('sha256', this.apiSecret).update(verb + path + expires + postBody).digest('hex');

            var headers = {
                'content-type' : 'application/json',
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'api-expires': expires,
                'api-key': this.apiKey,
                'api-signature': signature
            }

            request({
                headers: headers,
                url: this.getBaseUrl() + path,
                method: verb,
                body: postBody
            }, (error, response, body) => {
                if (error) {
                    logger.error('Bitmex: Invalid leverage update request:' + JSON.stringify({'error': error, 'body': body}))
                    console.log(error)
                    resolve(false)

                    return
                }

                let result = JSON.parse(body)
                if (result.error) {
                    logger.error('Bitmex: Invalid leverage update request:' + JSON.stringify(result))
                    console.log(body)
                    reject()
                    return
                }

                logger.debug('Bitmex: Leverage update:' + JSON.stringify(result))
                resolve(true)
            })
        })
    }

    updateOrder(id, order) {
        if (!order.amount && !order.price) {
            throw 'Invalid amount / price for update'
        }

        var verb = 'PUT',
            path = '/api/v1/order',
            expires = new Date().getTime() + (60 * 1000) // 1 min in the future
        ;

        let data = {
            'orderID': id,
            'text':	'Powered by your awesome crypto-bot watchdog',
        }

        if (order.amount) {
            data['orderQty'] = Math.abs(order.amount)
        }

        // order create needs negative price; order update positive value for "short"
        if (order.price) {
            data['price'] = Math.abs(order.price)
        }

        var postBody = JSON.stringify(data);
        var signature = crypto.createHmac('sha256', this.apiSecret).update(verb + path + expires + postBody).digest('hex');

        var headers = {
            'content-type' : 'application/json',
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'api-expires': expires,
            'api-key': this.apiKey,
            'api-signature': signature
        }

        let logger = this.logger
        return new Promise((resolve, reject) => {
            request({
                headers: headers,
                url: this.getBaseUrl() + path,
                method: verb,
                body: postBody
            }, (error, response, body) => {
                if (error) {
                    logger.error('Bitmex: Invalid order update request:' + JSON.stringify({'error': error, 'body': body}))
                    console.log(error)
                    reject()

                    return
                }

                let order = JSON.parse(body)

                if (order.error) {
                    logger.error('Bitmex: Invalid order update request:' + JSON.stringify(order))
                    console.log(body)
                    reject()
                    return
                }

                logger.info('Bitmex: Order update:' + JSON.stringify({'body': body}))

                resolve(Bitmex.createOrders([order])[0])
            })
        })
    }

    static createPositions(positions) {
        return positions.filter((position) => {
            return position['isOpen'] === true
        }).map(position => {
            return new Position(
                position['symbol'],
                position['currentQty'] < 0 ? 'short' : 'long',
                position['currentQty'],
                position['unrealisedRoePcnt']  * 100,
                new Date(),
                position['avgEntryPrice'],
                new Date(position['openingTimestamp'])
            )
        })
    }

    static createOrders(orders) {
        return orders.map(order => {
            let retry = false

            /*
            match execType with
                | "New" -> `Open, `New_order_accepted
            | "PartiallyFilled" -> `Open, `Partially_filled
            | "Filled" -> `Filled, `Filled
            | "DoneForDay" -> `Open, `General_order_update
            | "Canceled" -> `Canceled, `Canceled
            | "PendingCancel" -> `Pending_cancel, `General_order_update
            | "Stopped" -> `Open, `General_order_update
            | "Rejected" -> `Rejected, `New_order_rejected
            | "PendingNew" -> `Pending_open, `General_order_update
            | "Expired" -> `Rejected, `New_order_rejected
            | _ -> invalid_arg' execType ordStatus
            */

            let status = 'open'
            let orderStatus = order['ordStatus'].toLowerCase()

            if (orderStatus === 'new' || orderStatus === 'partiallyfilled' || orderStatus === 'pendingnew') {
                status = 'open'
            } else if (orderStatus === 'filled') {
                status = 'done'
            } else if (orderStatus === 'canceled') {
                status = 'canceled'

                // price of order out of ask / bid range from orderbook; we can retry it with updated price
                if (order.execInst.includes('ParticipateDoNotInitiate') && order.text.includes('ParticipateDoNotInitiate')) {
                    retry = true
                }
            } else if (orderStatus === 'rejected' || orderStatus === 'expired') {
                status = 'rejected'
                retry = true
            }

            let ordType = order['ordType'].toLowerCase();

            // secure the value
            let orderType = undefined
            switch (ordType) {
                case 'limit':
                    orderType = 'limit'
                    break;
                case 'stop':
                    orderType = 'stop'
                    break;
            }

            let price = order['price']
            if (orderType === 'stop') {
                price = order['stopPx']
            }

            return new ExchangeOrder(
                order['orderID'],
                order['symbol'],
                status,
                price,
                order['orderQty'],
                retry,
                order['clOrdID'],
                order['side'].toLowerCase() === 'sell' ? 'sell' : 'buy', // secure the value,
                orderType,
                new Date(order['transactTime']),
                new Date(),
                JSON.stringify(orders)
            )
        })
    }

    /**
     * Create a REST API body for Bitmex based on our internal order
     *
     * @param order
     * @returns {{symbol: *, orderQty: *, ordType: undefined, text: string}}
     */
    static createOrderBody(order) {
        if (!order.amount && !order.price && !order.symbol) {
            throw 'Invalid amount for update'
        }

        let orderType = undefined
        if (!order.type) {
            orderType = 'Limit'
        } else if(order.type === 'limit') {
            orderType = 'Limit'
        } else if(order.type === 'stop') {
            orderType = 'Stop'
        } else if(order.type === 'market') {
            orderType = 'Market'
        }

        if (!orderType) {
            throw 'Invalid order type'
        }

        let body = {
            'symbol': order.symbol,
            'orderQty': order.amount,
            'ordType': orderType,
            'text':	'Powered by your awesome crypto-bot watchdog',
        }

        let execInst = [];
        if (order.options && order.options.reduce_only === true &&  orderType === 'Limit') {
            execInst.push('ReduceOnly')
        }

        if (order.options && order.options.close === true && orderType === 'Stop') {
            execInst.push('Close')
        }

        // we need a trigger; else order is filled directly on: "market sell [short]"
        if (orderType === 'Stop') {
            execInst.push('LastPrice')
        }

        if (order.options && order.options.post_only === true) {
            execInst.push('ParticipateDoNotInitiate')
        }

        if(execInst.length > 0) {
            body['execInst'] = execInst.join(',')
        }

        if (orderType === 'Stop') {
            body['stopPx'] = Math.abs(order.price)
        } else if(orderType === 'Limit') {
            body['price'] = Math.abs(order.price)
        }

        body['side'] = order.price < 0 ? 'Sell' : 'Buy'

        if (order.id) {
            body['clOrdID'] = order.id
        }

        return body
    }

    getBaseUrl() {
        return 'https://www.bitmex.com'
    }
}
