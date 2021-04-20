'use strict';

const URL = require('url').URL;
const net = require('net');
const accepts = require('accepts');
const contentType = require('content-type');
const stringify = require('url').format;
const parse = require('parseurl');
const qs = require('querystring');
const typeis = require('type-is');
const fresh = require('fresh');
const only = require('only');
const util = require('util');

const IP = Symbol('context#ip');

module.exports = {

    // 在application.js的createContext函数中，会把node原生的req作为request对象(即request.js封装的对象)的属性
    // request对象会基于req封装很多便利的属性和方法

    // 大量类似的工具属性和方法 get set

    // request对象基于node原生req封装了一系列便利属性和方法，供处理请求时调用。
    // 所以当你访问ctx.request.xxx的时候，实际上是在访问request对象上的赋值器（setter）和取值器（getter）。

    get header() {
        return this.req.headers;
    },
    set header(val) {
        this.req.headers = val;
    },
    get headers() {
        return this.req.headers;
    },
    set headers(val) {
        this.req.headers = val;
    },
    get url() {
        return this.req.url;
    },
    set url(val) {
        this.req.url = val;
    },
    // ......
};

if (util.inspect.custom) {
    module.exports[util.inspect.custom] = module.exports.inspect;
}