'use strict';

function create (logger) {
    function hostnameFor (protocol, host, port) {
        let result = host;
        if ((protocol === 'http:' && port !== 80) || (protocol === 'https:' && port !== 443)) {
            result += `:${port}`;
        }
        return result;
    }

    function getProxyRequest (baseUrl, originalRequest) {
        const url = require('url'),
            parts = url.parse(baseUrl),
            protocol = parts.protocol === 'https:' ? require('https') : require('http'),
            defaultPort = parts.protocol === 'https:' ? 443 : 80,
            options = {
                method: originalRequest.method,
                hostname: parts.hostname,
                port: parts.port || defaultPort,
                auth: parts.auth,
                path: originalRequest.path,
                headers: originalRequest.headers
            };

        options.headers.host = hostnameFor(parts.protocol, parts.hostname, options.port);

        const proxiedRequest = protocol.request(options);
        if (originalRequest.body) {
            proxiedRequest.write(originalRequest.body);
        }
        return proxiedRequest;
    }

    function proxy (proxiedRequest) {
        const Q = require('q'),
            deferred = Q.defer();

        proxiedRequest.end();

        proxiedRequest.once('response', response => {
            const packets = [];

            response.on('data', chunk => {
                packets.push(chunk);
            });

            response.on('end', () => {
                const body = Buffer.concat(packets),
                    stubResponse = {
                        statusCode: response.statusCode,
                        headers: response.headers,
                        body: body.toString('utf8'),
                        _mode: mode
                    };
                deferred.resolve(stubResponse);
            });
        });

        return deferred.promise;
    }

    function to (proxyDestination, originalRequest, options) {

        function log (direction, what) {
            logger.debug('Proxy %s %s %s %s %s',
                originalRequest.requestFrom, direction, JSON.stringify(what), direction, proxyDestination);
        }

        const Q = require('q'),
            deferred = Q.defer(),
            proxiedRequest = getProxyRequest(proxyDestination, originalRequest, options);

        log('=>', originalRequest);

        proxy(proxiedRequest).done(response => {
            log('<=', response);
            deferred.resolve(response);
        });

        return deferred.promise;
    }

    return { to };
}

module.exports = { create };
