/** @decorator */

import {
  TRADER_DATUM,
  OPERATION_TYPE,
  getInstrumentDictionaryMeta
} from '../const.js';
import { observable } from '../fast/observable.js';
import { uuidv4 } from '../ppp-crypto.js';
import { Tmpl } from '../tmpl.js';
import {
  ConditionalOrderDatum,
  GlobalTraderDatum,
  Trader,
  pppTraderInstanceForWorkerIs
} from './trader-worker.js';
import { EventBus } from '../event-bus.js';
import { TradingError } from '../ppp-exceptions.js';
import { stringToFloat } from '../intl.js';

class PositionsDatum extends GlobalTraderDatum {
  firstReferenceAdded() {
    this.trader.broadcastBalances();

    return this.trader.broadcastPositions();
  }

  filter(data, source, key, datum) {
    if (datum !== TRADER_DATUM.POSITION) {
      const isBalance = data.isCurrency;

      if (isBalance) {
        return data.symbol === source.getAttribute('balance');
      }

      return data.symbol === this.trader.getSymbol(source.instrument);
    } else {
      return true;
    }
  }

  [TRADER_DATUM.POSITION](data) {
    if (!data.isBalance) {
      if (data.size > 0) {
        this.trader.positions.set(data.symbol, data);
      } else {
        this.trader.positions.delete(data.symbol);
      }
    }

    return data;
  }

  [TRADER_DATUM.POSITION_SIZE](data) {
    return data.size;
  }

  [TRADER_DATUM.POSITION_AVERAGE](data) {
    const isBalance = data.isCurrency;

    if (isBalance) {
      return;
    }

    return data.averagePrice;
  }
}

class TimelineDatum extends GlobalTraderDatum {
  firstReferenceAdded() {
    // Broadcast executions.
    for (const t of this.trader.timeline) {
      this.dataArrived(Object.assign({}, t));
    }
  }

  valueKeyForData(data) {
    return data.operationId;
  }

  [TRADER_DATUM.TIMELINE_ITEM](data) {
    return data;
  }
}

class ActiveOrderDatum extends GlobalTraderDatum {
  firstReferenceAdded() {
    // Broadcast all orders.
    for (const [, orders] of this.trader.orders) {
      for (const o of orders) {
        this.dataArrived(Object.assign({}, o));
      }
    }
  }

  valueKeyForData(data) {
    return data.orderId;
  }

  [TRADER_DATUM.ACTIVE_ORDER](data) {
    return data;
  }
}

class InstrumentSource {
  #subscribed = false;

  #bus = new EventBus();

  get bus() {
    return this.#bus;
  }

  sourceID = uuidv4();

  instrument;

  parent;

  trader;

  constructor(instrument, parent, trader) {
    this.instrument = instrument;
    this.parent = parent;
    this.trader = trader;
  }

  @observable
  orderbook;

  orderbookChanged(oldValue, newValue) {
    if (this.#subscribed) {
      this.orderbook = newValue;

      this.#bus.emit('orderbook', {
        oldValue,
        newValue
      });

      return this.parent.processAllOrders(this.instrument);
    }
  }

  async subscribe() {
    if (!this.#subscribed) {
      this.#subscribed = true;

      return this.trader.subscribeFields({
        source: this,
        fieldDatumPairs: {
          orderbook: TRADER_DATUM.ORDERBOOK
        }
      });
    }
  }

  async unsubscribe() {
    if (this.#subscribed) {
      this.#subscribed = false;
      this.orderbook = null;

      return this.trader.unsubscribeFields({
        source: this,
        fieldDatumPairs: {
          orderbook: TRADER_DATUM.ORDERBOOK
        }
      });
    }
  }
}

/**
 * @typedef {Object} PaperTradeTrader
 */
class PaperTradeTrader extends Trader {
  #dictionaryMeta;

  // By symbol.
  orders = new Map();

  // By symbol.
  positions = new Map();

  timeline = [];

  nextOrderId = 0;

  nextOperationId = 0;

  // By currency.
  balance = new Map();

  commissionFunc;

  // Orderbook holders.
  sources = new Map();

  bookTrader;

  // Not ready yet.
  #marketOrderCoef = 0;

  constructor(document) {
    super(document, [
      {
        type: PositionsDatum,
        datums: [
          TRADER_DATUM.POSITION,
          TRADER_DATUM.POSITION_SIZE,
          TRADER_DATUM.POSITION_AVERAGE
        ]
      },
      {
        type: TimelineDatum,
        datums: [TRADER_DATUM.TIMELINE_ITEM]
      },
      {
        type: ActiveOrderDatum,
        datums: [TRADER_DATUM.ACTIVE_ORDER]
      },
      {
        type: ConditionalOrderDatum,
        datums: [TRADER_DATUM.CONDITIONAL_ORDER]
      }
    ]);

    this.balance.set('USD', document.initialDepositUSD);
    this.balance.set('RUB', document.initialDepositRUB);

    this.#dictionaryMeta = getInstrumentDictionaryMeta(
      this.document.dictionary
    );
    this.#marketOrderCoef = document.marketOrderCoeff ?? 0.3;
  }

  serialize() {
    const workingOrders = [];

    this.orders.forEach((orders) => {
      orders.forEach((order) => {
        if (order.status === 'working') {
          workingOrders.push(order);
        }
      });
    });

    return {
      ...super.serialize(),
      balances: Object.fromEntries(this.balance),
      executions: this.timeline,
      orders: workingOrders,
      positions: Object.fromEntries(this.positions),
      dictionaryMeta: this.#dictionaryMeta
    };
  }

  async oneTimeInitializationCallback() {
    this.commissionFunc = new Function(
      'trade',
      await new Tmpl().render(this, this.document.commFunctionCode, {})
    );

    this.bookTrader = await ppp.getOrCreateTrader(this.document.bookTrader);
  }

  processOrder(order, orderbook) {
    if (order?.status === 'working' && order.filled < order.quantity) {
      const iterable =
        order.side === 'buy' ? orderbook?.asks ?? [] : orderbook?.bids ?? [];
      const filled = order.filled;

      // Sweep the book.
      for (const { price, volume } of iterable) {
        if (!price || !volume) {
          continue;
        }

        let priceIsEligibleForFill = false;

        if (order.side === 'buy') {
          priceIsEligibleForFill = price <= order.price;
        } else {
          priceIsEligibleForFill = price >= order.price;
        }

        if (priceIsEligibleForFill) {
          const rest = order.quantity - order.filled;

          if (rest >= volume) {
            order.filled += volume;

            this.createExecution({
              instrument: order.instrument,
              price,
              quantity: volume,
              side: order.side,
              parentId: order.orderId
            });
          } else {
            order.filled += rest;

            this.createExecution({
              instrument: order.instrument,
              price,
              quantity: rest,
              side: order.side,
              parentId: order.orderId
            });
          }
        }

        if (order.filled === order.quantity) {
          order.status = 'filled';

          break;
        }
      }

      if (filled !== order.filled) {
        this.datums[TRADER_DATUM.ACTIVE_ORDER].dataArrived(
          Object.assign({}, order)
        );
      }
    }
  }

  async processAllOrders(instrument) {
    const workingOrders = (this.orders.get(instrument.symbol) ?? []).filter(
      (o) => o.status === 'working'
    );

    if (!workingOrders.length) {
      await this.sources.get(instrument.symbol).unsubscribe();
    }

    for (const order of workingOrders) {
      this.processOrder(order, await this.#orderbookNeeded(order.instrument));
    }
  }

  createExecution({ instrument, price, quantity, side, parentId }) {
    const commission = this.commissionFunc({
      instrument,
      price,
      quantity
    });
    const balance = this.balance.get(instrument.currency) ?? 0;
    const timelineItem = {
      instrument,
      operationId: uuidv4(),
      accruedInterest: 0,
      commission,
      parentId,
      symbol: instrument.symbol,
      type:
        side === 'buy'
          ? OPERATION_TYPE.OPERATION_TYPE_BUY
          : OPERATION_TYPE.OPERATION_TYPE_SELL,
      exchange: this.getExchange(),
      quantity,
      price,
      createdAt: new Date().toISOString()
    };

    this.timeline.push(timelineItem);
    this.datums[TRADER_DATUM.TIMELINE_ITEM].dataArrived(timelineItem);

    if (side === 'buy') {
      this.balance.set(
        instrument.currency,
        balance - quantity * price - commission
      );
    } else {
      this.balance.set(
        instrument.currency,
        balance + quantity * price - commission
      );
    }

    this.broadcastBalances();
    this.broadcastPositions(instrument);
  }

  broadcastBalances() {
    for (const [symbol, size] of this.balance) {
      this.datums[TRADER_DATUM.POSITION].dataArrived({
        symbol,
        lot: 1,
        exchange: this.getExchange(),
        averagePrice: null,
        isCurrency: true,
        isBalance: true,
        size,
        accountId: this.document._id
      });
    }
  }

  broadcastPositions(instrument) {
    if (!instrument) {
      for (const [symbol, position] of this.positions) {
        this.broadcastPositions(position.instrument);
      }

      return;
    }

    const trades = this.timeline.filter((t) =>
      this.instrumentsAreEqual(t.instrument, instrument)
    );

    // Always non-negative.
    let currentSum = 0;
    // Can be negative.
    let total = 0;
    let size = 0;

    for (let trade of trades) {
      const isBuy = trade.type !== OPERATION_TYPE.OPERATION_TYPE_SELL;

      if (isBuy) {
        size += trade.quantity;
      } else {
        size -= trade.quantity;
      }

      if (total === 0) {
        currentSum = trade.price * trade.quantity;

        if (isBuy) {
          total += trade.quantity;
        } else {
          // Sell.
          total -= trade.quantity;
        }
      } else {
        // Total is non-zero.
        if (isBuy) {
          if (total > 0) {
            currentSum += trade.price * trade.quantity;
            total += trade.quantity;
          } else if (total + trade.quantity >= 0) {
            // A reversal.
            total += trade.quantity;
            currentSum = trade.price * total;
          }
        } else {
          // Sell.
          if (total < 0) {
            currentSum += trade.price * trade.quantity;
            total -= trade.quantity;
          } else if (total - trade.quantity <= 0) {
            // A reversal.
            total -= trade.quantity;
            currentSum = trade.price * total;
          }
        }
      }

      if (size === 0) {
        total = 0;
        currentSum = 0;
      }
    }

    // Weighted Average.
    const averagePrice = Math.abs(currentSum / total);

    this.datums[TRADER_DATUM.POSITION].dataArrived({
      instrument,
      symbol: instrument.symbol,
      lot: instrument.lot,
      exchange: this.getExchange(),
      averagePrice,
      isCurrency: false,
      isBalance: false,
      size,
      accountId: this.document._id
    });
  }

  getExchange() {
    return this.#dictionaryMeta.exchange;
  }

  getObservedAttributes() {
    return ['balance'];
  }

  getDictionary() {
    return this.document.dictionary;
  }

  getBroker() {
    return this.#dictionaryMeta.broker;
  }

  async #orderbookNeeded(instrument) {
    if (!instrument) {
      return;
    }

    if (typeof this.sources.get(instrument.symbol) === 'undefined') {
      this.sources.set(
        instrument.symbol,
        new InstrumentSource(instrument, this, this.bookTrader)
      );
    }

    const source = this.sources.get(instrument.symbol);

    await source.subscribe();

    if (source.orderbook) {
      return source.orderbook;
    } else {
      return new Promise((resolve) => {
        source.bus.once('orderbook', () => {
          resolve(source.orderbook);
        });
      });
    }
  }

  async placeLimitOrder({ instrument, price, quantity, direction }) {
    if (!this.orders.has(instrument.symbol)) {
      this.orders.set(instrument.symbol, []);
    }

    const order = {
      instrument,
      orderId: ++this.nextOrderId,
      symbol: instrument.symbol,
      exchange: instrument.exchange,
      orderType: 'limit',
      side: direction,
      status: 'working',
      placedAt: new Date().toISOString(),
      endsAt: null,
      quantity: stringToFloat(quantity),
      filled: 0,
      price: +this.fixPrice(instrument, price)
    };

    this.orders.get(instrument.symbol).push(order);
    this.datums[TRADER_DATUM.ACTIVE_ORDER].dataArrived(order);

    return this.processOrder(
      order,
      await this.#orderbookNeeded(order.instrument)
    );
  }

  async placeMarketOrder({ instrument, quantity, direction }) {
    throw new TradingError({
      details: {
        code: 'E_MARKET_ORDERS_DISABLED'
      }
    });
  }

  async modifyRealOrders({ instrument, side, value }) {
    const orders = this.orders.get(instrument.symbol) ?? [];

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];

      if (
        order.status === 'working' &&
        (order.side === side || side === 'all')
      ) {
        if (instrument && order.symbol !== this.getSymbol(instrument)) continue;

        if (!instrument.minPriceIncrement) {
          instrument.minPriceIncrement = order.price < 1 ? 0.0001 : 0.01;
        }

        order.price = +this.fixPrice(
          instrument,
          order.price + instrument.minPriceIncrement * value
        );

        this.datums[TRADER_DATUM.ACTIVE_ORDER].dataArrived(
          Object.assign({}, order)
        );
      }
    }

    return this.processAllOrders(instrument);
  }

  async cancelAllRealOrders({ instrument, filter } = {}) {
    for (const o of this.orders.get(instrument.symbol) ?? []) {
      if (o.status === 'working') {
        if (instrument && o.symbol !== this.getSymbol(instrument)) continue;

        if (filter === 'buy' && o.side !== 'buy') {
          continue;
        }

        if (filter === 'sell' && o.side !== 'sell') {
          continue;
        }

        await this.cancelRealOrder(o);
      }
    }
  }

  async cancelRealOrder(order) {
    if (order.status === 'working') {
      order.status = 'canceled';

      this.orders.forEach((orders) => {
        orders.forEach((o) => {
          if (o.orderId === order.orderId) {
            o.status = 'canceled';
          }
        });
      });

      this.datums[TRADER_DATUM.ACTIVE_ORDER].dataArrived(
        Object.assign({}, order)
      );
    }
  }

  async formatError({ error }) {
    switch (error.details.code) {
      case 'E_MARKET_ORDERS_DISABLED':
        return 'Трейдер не поддерживает выставление рыночных заявок.';
      case 'E_COMMISSION_CALCULATION_ERROR':
        return 'Не удалось рассчитать комиссию.';
    }
  }
}

pppTraderInstanceForWorkerIs(PaperTradeTrader);

export default PaperTradeTrader;
