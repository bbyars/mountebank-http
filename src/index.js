'use strict';

// Create a logger like object we can use throughout
function createLogger (loglevel) {
    const result = {},
        levels = ['debug', 'info', 'warn', 'error'];

    levels.forEach((level, index) => {
        if (index < levels.indexOf(loglevel)) {
            result[level] = () => {};
        }
        else {
            result[level] = function () {
                const args = Array.prototype.slice.call(arguments),
                    message = require('util').format.apply(this, args);

                // Anything written to stdout that starts with a log level and a space
                // will be written to the mountebank logs.
                console.log(`${level} ${message}`);
            };
        }
    });
    return result;
}

// Generic function to POST JSON to a URL
function postJSON (what, where) {
    const Q = require('q'),
        deferred = Q.defer(),
        url = require('url'),
        parts = url.parse(where),
        driver = require(parts.protocol.replace(':', '')),
        options = {
            hostname: parts.hostname,
            port: parts.port,
            path: parts.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        },
        request = driver.request(options, response => {
            const packets = [];

            response.on('data', chunk => packets.push(chunk));

            response.on('end', () => {
                const buffer = Buffer.concat(packets),
                    body = buffer.toString('utf8');

                if (response.statusCode !== 200) {
                    deferred.reject(require('../../util/errors').CommunicationError({
                        statusCode: response.statusCode,
                        body: body
                    }));
                }
                else {
                    deferred.resolve(JSON.parse(body));
                }
            });
        });

    request.on('error', deferred.reject);
    request.write(JSON.stringify(what));
    request.end();
    return deferred.promise;
}

function getProxyResponse (proxyConfig, request, proxyCallbackURL) {
    const proxy = require('./proxy').create(logger);
    return proxy.to(proxyConfig.to, request, proxyConfig)
        .then(response => postJSON({ proxyResponse: response }, proxyCallbackURL));
}

let callbackURL;

function getResponse (request) {
    const Q = require('q');

    // After we transform a network request into a simplified JSON request, we have to POST
    // that to the callbackURL mountebank provided us on startup
    return postJSON({ request }, callbackURL).then(mbResponse => {
        // Mountebank returns one of three options

        // 1. Mountebank selected a proxy response, but needs us to do the actual proxying
        // It will provide another callbackURL for us to finish the response resolution
        if (mbResponse.proxy) {
            return getProxyResponse(mbResponse.proxy, mbResponse.request, mbResponse.callbackURL);
        }
        // 2. Mountebank selected the JSON response object directly
        else if (mbResponse.response) {
            return Q(mbResponse.response);
        }
        // 3. Mountebank is preventing further processing due to IP whitelisting
        // We'll kill the socket in the request handling of the server, since we don't
        // have access to the socket in this scope
        else {
            return Q(mbResponse);
        }
    });
}

// Transform the network request into a simplified JSON request that mountebank can understand
function createJSONRequestFrom (request) {
    const Q = require('q'),
        deferred = Q.defer();

    request.body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { request.body += chunk; });
    request.on('end', () => {
        const url = require('url'),
            parts = url.parse(request.url, true);

        const simpleRequest = {
            ip: request.socket.remoteAddress,
            method: request.method,
            path: parts.pathname,
            query: parts.query,
            headers: request.headers,
            body: request.body
        };

        deferred.resolve(simpleRequest);
    });
    return deferred.promise;
}

// Create the HTTP server
function createServer (options, logger) {
    const Q = require('q'),
        deferred = Q.defer(),
        defaultResponse = options.defaultResponse || {};

    // Ensure that all response fields are filled out
    function postProcess (stubResponse) {
        const defaultHeaders = defaultResponse.headers || {},
            response = {
                statusCode: stubResponse.statusCode || defaultResponse.statusCode || 200,
                headers: stubResponse.headers || defaultHeaders,
                body: stubResponse.body || defaultResponse.body || '',
                _mode: stubResponse._mode || defaultResponse._mode || 'text'
            };

        return response;
    }

    const server = require('http').createServer();

    server.on('request', (request, response) => {
        logger.info(`${request.method} ${request.url}`);

        // First transform the network request into a simplified JSON request
        createJSONRequestFrom(request).then(jsonRequest => {
            logger.debug('%s => %s', JSON.stringify(jsonRequest));

            // Then post that to mountebank
            return getResponse(jsonRequest);
        }).done(mbResponse => {
            // If mountebank blocked the call due to an IP whitelist, kill the socket
            if (mbResponse.blocked) {
                request.socket.end();
                return;
            }

            // Fill out any missing fields on the JSON response
            const stubResponse = postProcess(mbResponse);
            logger.debug(JSON.stringify(stubResponse));

            // Transform the JSON response into a network response
            response.writeHead(stubResponse.statusCode, stubResponse.headers);
            response.end(stubResponse.body.toString(), 'utf8');
        });
    });

    // Bind the socket to a port (the || 0 bit auto-selects a port if one isn't provided)
    server.listen(options.port || 0, () => {
        deferred.resolve({
            port: server.address().port,
            metadata: {},
            close: callback => {
                server.close(callback);
            }
        });
    });

    return deferred.promise;
}


// Mountebank passes a JSON object on the command line (in this case, the second parameter,
// since the createCommand is node index.js JSON-OBJECT
const config = JSON.parse(process.argv[2]),
    logger = createLogger(config.loglevel);

createServer(config, logger).done(server => {
    // Since the protocol implementation can set the port, we have to replace that in the callbackURL
    callbackURL = config.callbackURLTemplate.replace(':port', server.port);

    const metadata = server.metadata;
    metadata.port = server.port;
    metadata.encoding = 'utf8';

    // As soon as we write to stdout, mountebank assumes we've fully initialized
    // If we write a JSON object, mountebank will capture all the metadata
    console.log(JSON.stringify(metadata));
}, error => {
    console.error(JSON.stringify(error));
    // Be sure to exit with a non-zero exit code
    process.exit(1);
});
