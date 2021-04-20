'use strict';

// response对象与request对象类似

const contentDisposition = require('content-disposition');
const getType = require('cache-content-type');
const onFinish = require('on-finished');
const escape = require('escape-html');
const typeis = require('type-is').is;
const statuses = require('statuses');
const destroy = require('destroy');
const assert = require('assert');
const extname = require('path').extname;
const vary = require('vary');
const only = require('only');
const util = require('util');
const encodeUrl = require('encodeurl');
const Stream = require('stream');


module.exports = {
    // 在application.js的createContext函数中，会把node原生的res作为request对象(即responsejs封装的对象)的属性
    // response对象会基于req封装很多便利的属性和方法

    // 大量类似的工具属性和方法 get set

    // response对象基于node原生res封装了一系列便利属性和方法，供处理请求时调用。
    // 所以当你访问ctx.response.xxx的时候，实际上是在访问response对象上的赋值器（setter）和取值器（getter）。

    get socket() {
        return this.res.socket;
    },

    get header() {
        const {
            res
        } = this;
        return typeof res.getHeaders === 'function' ?
            res.getHeaders() :
            res._headers || {}; // Node < 7.7
    },
    get headers() {
        return this.header;
    },
    // ......
};
if (util.inspect.custom) {
    module.exports[util.inspect.custom] = module.exports.inspect;
}