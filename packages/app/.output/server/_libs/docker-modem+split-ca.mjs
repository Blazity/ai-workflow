import { r as __require, t as __commonJSMin } from "../_runtime.mjs";
import { n as require_src } from "./@slack/web-api+[...].mjs";
import { n as require_readable } from "./bl+[...].mjs";
//#region ../../node_modules/.pnpm/docker-modem@5.0.6/node_modules/docker-modem/lib/utils.js
var require_utils = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var arr = [];
	var each = arr.forEach;
	var slice = arr.slice;
	module.exports.extend = function(obj) {
		each.call(slice.call(arguments, 1), function(source) {
			if (source) for (var prop in source) obj[prop] = source[prop];
		});
		return obj;
	};
	module.exports.parseJSON = function(s) {
		try {
			return JSON.parse(s);
		} catch (e) {
			return null;
		}
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/docker-modem@5.0.6/node_modules/docker-modem/lib/http.js
var require_http = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var nativeHttps = __require("https"), nativeHttp = __require("http"), url$1 = __require("url"), utils$1 = require_utils();
	module.exports.maxRedirects = 5;
	var protocols = {
		https: nativeHttps,
		http: nativeHttp
	};
	for (var protocol in protocols) {
		var h = function() {};
		h.prototype = protocols[protocol];
		h = new h();
		h.request = function(h) {
			return function(options, callback, redirectOptions) {
				redirectOptions = redirectOptions || {};
				var max = typeof options === "object" && "maxRedirects" in options ? options.maxRedirects : exports.maxRedirects;
				var redirect = utils$1.extend({
					count: 0,
					max,
					clientRequest: null,
					userCallback: callback
				}, redirectOptions);
				if (redirect.count > redirect.max) {
					var err = /* @__PURE__ */ new Error("Max redirects exceeded. To allow more redirects, pass options.maxRedirects property.");
					redirect.clientRequest.emit("error", err);
					return redirect.clientRequest;
				}
				redirect.count++;
				var reqUrl;
				if (typeof options === "string") reqUrl = options;
				else reqUrl = url$1.format(utils$1.extend({ protocol }, options));
				var clientRequest = Object.getPrototypeOf(h).request(options, redirectCallback(reqUrl, redirect));
				if (!redirect.clientRequest) redirect.clientRequest = clientRequest;
				function redirectCallback(reqUrl, redirect) {
					return function(res) {
						if (res.statusCode < 300 || res.statusCode > 399) return redirect.userCallback(res);
						if (!("location" in res.headers)) return redirect.userCallback(res);
						var redirectUrl = url$1.resolve(reqUrl, res.headers.location);
						var proto = url$1.parse(redirectUrl).protocol;
						proto = proto.substr(0, proto.length - 1);
						return module.exports[proto].get(redirectUrl, redirectCallback(reqUrl, redirect), redirect);
					};
				}
				return clientRequest;
			};
		}(h);
		h.get = function(h) {
			return function(options, cb, redirectOptions) {
				var req = h.request(options, cb, redirectOptions);
				req.end();
				return req;
			};
		}(h);
		module.exports[protocol] = h;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/docker-modem@5.0.6/node_modules/docker-modem/lib/ssh.js
var require_ssh = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var Client = __require("ssh2").Client, http$1 = __require("http");
	module.exports = function(opt) {
		var conn = new Client();
		var agent = new http$1.Agent();
		agent.createConnection = function(options, fn) {
			try {
				conn.once("ready", function() {
					conn.exec("docker system dial-stdio", function(err, stream) {
						if (err) handleError(err, fn);
						fn(null, stream);
						stream.addListener("error", (err) => {
							handleError(err, fn);
						});
						stream.once("close", () => {
							conn.end();
							agent.destroy();
						});
					});
				}).on("error", (err) => {
					handleError(err, fn);
				}).connect(opt);
				conn.once("end", () => agent.destroy());
			} catch (err) {
				handleError(err);
			}
		};
		function handleError(err, cb) {
			conn.end();
			agent.destroy();
			if (cb) cb(err);
			else throw err;
		}
		return agent;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/docker-modem@5.0.6/node_modules/docker-modem/lib/http_duplex.js
var require_http_duplex = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = HttpDuplex;
	var util$1 = __require("util"), stream$1 = require_readable();
	util$1.inherits(HttpDuplex, stream$1.Duplex);
	function HttpDuplex(req, res, options) {
		var self = this;
		if (!(self instanceof HttpDuplex)) return new HttpDuplex(req, res, options);
		stream$1.Duplex.call(self, options);
		self._output = null;
		self.connect(req, res);
	}
	HttpDuplex.prototype.connect = function(req, res) {
		var self = this;
		self.req = req;
		self._output = res;
		self.emit("response", res);
		res.on("data", function(c) {
			if (!self.push(c)) self._output.pause();
		});
		res.on("end", function() {
			self.push(null);
		});
	};
	HttpDuplex.prototype._read = function(n) {
		if (this._output) this._output.resume();
	};
	HttpDuplex.prototype._write = function(chunk, encoding, cb) {
		this.req.write(chunk, encoding);
		cb();
	};
	HttpDuplex.prototype.end = function(chunk, encoding, cb) {
		this._output.socket.destroySoon();
		return this.req.end(chunk, encoding, cb);
	};
	HttpDuplex.prototype.destroy = function() {
		this.req.destroy();
		this._output.socket.destroy();
	};
	HttpDuplex.prototype.destroySoon = function() {
		this.req.destroy();
		this._output.socket.destroy();
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/split-ca@1.0.1/node_modules/split-ca/index.js
var require_split_ca = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var fs$1 = __require("fs");
	module.exports = function(filepath, split, encoding) {
		split = typeof split !== "undefined" ? split : "\n";
		encoding = typeof encoding !== "undefined" ? encoding : "utf8";
		var ca = [];
		var chain = fs$1.readFileSync(filepath, encoding);
		if (chain.indexOf("-END CERTIFICATE-") < 0 || chain.indexOf("-BEGIN CERTIFICATE-") < 0) throw Error("File does not contain 'BEGIN CERTIFICATE' or 'END CERTIFICATE'");
		chain = chain.split(split);
		var cert = [];
		var _i, _len;
		for (_i = 0, _len = chain.length; _i < _len; _i++) {
			var line = chain[_i];
			if (!(line.length !== 0)) continue;
			cert.push(line);
			if (line.match(/-END CERTIFICATE-/)) {
				ca.push(cert.join(split));
				cert = [];
			}
		}
		return ca;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/docker-modem@5.0.6/node_modules/docker-modem/lib/modem.js
var require_modem = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var querystring = __require("querystring"), http = require_http(), fs = __require("fs"), path = __require("path"), url = __require("url"), ssh = require_ssh(), HttpDuplex = require_http_duplex(), debug = require_src()("modem"), utils = require_utils(), util = __require("util"), splitca = require_split_ca(), os = __require("os"), isWin = os.type() === "Windows_NT", stream = __require("stream");
	var defaultOpts = function() {
		var host;
		var opts = {};
		if (!process.env.DOCKER_HOST) opts.socketPath = isWin ? "//./pipe/docker_engine" : findDefaultUnixSocket;
		else if (process.env.DOCKER_HOST.indexOf("unix://") === 0) opts.socketPath = process.env.DOCKER_HOST.substring(7) || findDefaultUnixSocket;
		else if (process.env.DOCKER_HOST.indexOf("npipe://") === 0) opts.socketPath = process.env.DOCKER_HOST.substring(8) || "//./pipe/docker_engine";
		else {
			var hostStr = process.env.DOCKER_HOST;
			if (hostStr.indexOf("//") < 0) hostStr = "tcp://" + hostStr;
			try {
				host = new url.URL(hostStr);
			} catch (err) {
				throw new Error("DOCKER_HOST env variable should be something like tcp://localhost:1234");
			}
			opts.port = host.port;
			if (process.env.DOCKER_TLS_VERIFY === "1" || opts.port === "2376") opts.protocol = "https";
			else if (host.protocol === "ssh:") {
				opts.protocol = "ssh";
				opts.username = host.username;
				opts.sshOptions = { agent: process.env.SSH_AUTH_SOCK };
			} else opts.protocol = "http";
			if (process.env.DOCKER_PATH_PREFIX) opts.pathPrefix = process.env.DOCKER_PATH_PREFIX;
			else opts.pathPrefix = "/";
			opts.host = host.hostname;
			if (process.env.DOCKER_CERT_PATH) {
				opts.ca = splitca(path.join(process.env.DOCKER_CERT_PATH, "ca.pem"));
				opts.cert = fs.readFileSync(path.join(process.env.DOCKER_CERT_PATH, "cert.pem"));
				opts.key = fs.readFileSync(path.join(process.env.DOCKER_CERT_PATH, "key.pem"));
			}
			if (process.env.DOCKER_CLIENT_TIMEOUT) opts.timeout = parseInt(process.env.DOCKER_CLIENT_TIMEOUT, 10);
		}
		return opts;
	};
	var findDefaultUnixSocket = function() {
		return new Promise(function(resolve) {
			var userDockerSocket = path.join(os.homedir(), ".docker", "run", "docker.sock");
			fs.access(userDockerSocket, function(err) {
				if (err) resolve("/var/run/docker.sock");
				else resolve(userDockerSocket);
			});
		});
	};
	var Modem = function(options) {
		var optDefaults = defaultOpts();
		var opts = Object.assign({}, optDefaults, options);
		this.host = opts.host;
		if (!this.host) this.socketPath = opts.socketPath;
		this.port = opts.port;
		this.pathPrefix = opts.pathPrefix;
		this.username = opts.username;
		this.password = opts.password;
		this.version = opts.version;
		this.key = opts.key;
		this.cert = opts.cert;
		this.ca = opts.ca;
		this.timeout = opts.timeout;
		this.connectionTimeout = opts.connectionTimeout;
		this.checkServerIdentity = opts.checkServerIdentity;
		this.agent = opts.agent;
		this.headers = opts.headers || {};
		this.sshOptions = Object.assign({}, options ? options.sshOptions : {}, optDefaults.sshOptions);
		if (this.sshOptions.agentForward === void 0) this.sshOptions.agentForward = opts.agentForward;
		if (this.key && this.cert && this.ca) this.protocol = "https";
		this.protocol = opts.protocol || this.protocol || "http";
	};
	Modem.prototype.dial = function(options, callback) {
		var opts, address, data;
		if (options.options) opts = options.options;
		if (opts && opts.authconfig) delete opts.authconfig;
		if (opts && opts.abortSignal) delete opts.abortSignal;
		if (this.version) options.path = "/" + this.version + options.path;
		if (this.host) {
			var parsed = url.parse(this.host);
			address = url.format({
				protocol: parsed.protocol || this.protocol,
				hostname: parsed.hostname || this.host,
				port: this.port,
				pathname: parsed.pathname || this.pathPrefix
			});
			address = url.resolve(address, options.path);
		} else address = options.path;
		if (options.path.indexOf("?") !== -1) if (opts && Object.keys(opts).length > 0) address += this.buildQuerystring(opts._query || opts);
		else address = address.substring(0, address.length - 1);
		var optionsf = {
			path: address,
			method: options.method,
			headers: options.headers || Object.assign({}, this.headers),
			key: this.key,
			cert: this.cert,
			ca: this.ca
		};
		if (this.checkServerIdentity) optionsf.checkServerIdentity = this.checkServerIdentity;
		if (this.agent) optionsf.agent = this.agent;
		if (options.authconfig) optionsf.headers["X-Registry-Auth"] = options.authconfig.key || options.authconfig.base64 || Buffer.from(JSON.stringify(options.authconfig)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
		if (options.registryconfig) optionsf.headers["X-Registry-Config"] = options.registryconfig.base64 || Buffer.from(JSON.stringify(options.registryconfig)).toString("base64");
		if (options.abortSignal) optionsf.signal = options.abortSignal;
		if (options.file) {
			if (typeof options.file === "string") data = fs.createReadStream(path.resolve(options.file));
			else data = options.file;
			optionsf.headers["Content-Type"] = "application/tar";
		} else if (opts && options.method === "POST") {
			data = JSON.stringify(opts._body || opts);
			if (options.allowEmpty) optionsf.headers["Content-Type"] = "application/json";
			else if (data !== "{}" && data !== "\"\"") optionsf.headers["Content-Type"] = "application/json";
			else data = void 0;
		}
		if (typeof data === "string") optionsf.headers["Content-Length"] = Buffer.byteLength(data);
		else if (Buffer.isBuffer(data) === true) optionsf.headers["Content-Length"] = data.length;
		else if (optionsf.method === "PUT" || options.hijack || options.openStdin) optionsf.headers["Transfer-Encoding"] = "chunked";
		if (options.hijack) {
			optionsf.headers.Connection = "Upgrade";
			optionsf.headers.Upgrade = optionsf.headers.Upgrade ?? "tcp";
		}
		if (this.socketPath) this.getSocketPath().then((socketPath) => {
			optionsf.socketPath = socketPath;
			this.buildRequest(optionsf, options, data, callback);
		});
		else {
			var urlp = url.parse(address);
			optionsf.hostname = urlp.hostname;
			optionsf.port = urlp.port;
			optionsf.path = urlp.path;
			this.buildRequest(optionsf, options, data, callback);
		}
	};
	Modem.prototype.getSocketPath = function() {
		if (!this.socketPath) return;
		if (this.socketPathCache) return Promise.resolve(this.socketPathCache);
		var socketPathValue = typeof this.socketPath === "function" ? this.socketPath() : this.socketPath;
		this.socketPathCache = socketPathValue;
		return Promise.resolve(socketPathValue);
	};
	Modem.prototype.buildRequest = function(options, context, data, callback) {
		var self = this;
		var connectionTimeoutTimer;
		var finished = false;
		var opts = self.protocol === "ssh" ? Object.assign(options, {
			agent: ssh(Object.assign({}, self.sshOptions, {
				"host": self.host,
				"port": self.port,
				"username": self.username,
				"password": self.password
			})),
			protocol: "http:"
		}) : options;
		var req = http[self.protocol === "ssh" ? "http" : self.protocol].request(opts, function() {});
		debug("Sending: %s", util.inspect(options, {
			showHidden: true,
			depth: null
		}));
		if (self.connectionTimeout) connectionTimeoutTimer = setTimeout(function() {
			debug("Connection Timeout of %s ms exceeded", self.connectionTimeout);
			req.destroy();
		}, self.connectionTimeout);
		if (self.timeout) {
			req.setTimeout(self.timeout);
			req.on("timeout", function() {
				debug("Timeout of %s ms exceeded", self.timeout);
				req.destroy();
			});
		}
		if (context.hijack === true) {
			clearTimeout(connectionTimeoutTimer);
			req.on("upgrade", function(res, sock, head) {
				if (finished === false) {
					finished = true;
					if (head.length > 0) sock.unshift(head);
					return callback(null, sock);
				}
			});
		}
		req.on("connect", function() {
			clearTimeout(connectionTimeoutTimer);
		});
		req.on("disconnect", function() {
			clearTimeout(connectionTimeoutTimer);
		});
		req.on("response", function(res) {
			clearTimeout(connectionTimeoutTimer);
			if (context.isStream === true) {
				if (finished === false) {
					finished = true;
					self.buildPayload(null, context.isStream, context.statusCodes, context.openStdin, req, res, null, callback);
				}
			} else {
				if (options.signal != null) stream.addAbortSignal(options.signal, res);
				var chunks = [];
				res.on("data", function(chunk) {
					chunks.push(chunk);
				});
				res.on("end", function() {
					var buffer = Buffer.concat(chunks);
					var result = buffer.toString();
					debug("Received: %s", result);
					var json = utils.parseJSON(result) || buffer;
					if (finished === false) {
						finished = true;
						self.buildPayload(null, context.isStream, context.statusCodes, false, req, res, json, callback);
					}
				});
			}
		});
		req.on("error", function(error) {
			clearTimeout(connectionTimeoutTimer);
			if (finished === false) {
				finished = true;
				self.buildPayload(error, context.isStream, context.statusCodes, false, {}, {}, null, callback);
			}
		});
		if (typeof data === "string" || Buffer.isBuffer(data)) req.write(data);
		else if (data) {
			data.on("error", function(error) {
				req.destroy(error);
			});
			data.pipe(req);
		}
		if (!context.openStdin && (typeof data === "string" || data === void 0 || Buffer.isBuffer(data))) req.end();
	};
	Modem.prototype.buildPayload = function(err, isStream, statusCodes, openStdin, req, res, json, cb) {
		if (err) return cb(err, null);
		if (statusCodes[res.statusCode] !== true) getCause(isStream, res, json, function(err, cause) {
			if (err) return cb(err, null);
			var msg = /* @__PURE__ */ new Error("(HTTP code " + res.statusCode + ") " + (statusCodes[res.statusCode] || "unexpected") + " - " + (cause.message || cause.error || cause) + " ");
			msg.reason = statusCodes[res.statusCode];
			msg.statusCode = res.statusCode;
			msg.json = json;
			cb(msg, null);
		});
		else if (openStdin) cb(null, new HttpDuplex(req, res));
		else if (isStream) cb(null, res);
		else cb(null, json);
		function getCause(isStream, res, json, callback) {
			var chunks = "";
			var done = false;
			if (isStream) {
				res.on("data", function(chunk) {
					chunks += chunk;
				});
				res.on("error", function(err) {
					handler(err, null);
				});
				res.on("end", function() {
					handler(null, utils.parseJSON(chunks) || chunks);
				});
			} else callback(null, json);
			function handler(err, data) {
				if (done === false) if (err) callback(err);
				else callback(null, data);
				done = true;
			}
		}
	};
	Modem.prototype.demuxStream = function(streama, stdout, stderr) {
		var nextDataType = null;
		var nextDataLength = null;
		var buffer = Buffer.from("");
		function processData(data) {
			if (data) buffer = Buffer.concat([buffer, data]);
			if (!nextDataType) {
				if (buffer.length >= 8) {
					var header = bufferSlice(8);
					nextDataType = header.readUInt8(0);
					nextDataLength = header.readUInt32BE(4);
					processData();
				}
			} else if (buffer.length >= nextDataLength) {
				var content = bufferSlice(nextDataLength);
				if (nextDataType === 1) stdout.write(content);
				else stderr.write(content);
				nextDataType = null;
				processData();
			}
		}
		function bufferSlice(end) {
			var out = buffer.subarray(0, end);
			buffer = Buffer.from(buffer.subarray(end, buffer.length));
			return out;
		}
		streama.on("data", processData);
	};
	Modem.prototype.followProgress = function(streama, onFinished, onProgress) {
		var buf = "";
		var output = [];
		var finished = false;
		streama.on("data", onStreamEvent);
		streama.on("error", onStreamError);
		streama.on("end", onStreamEnd);
		streama.on("close", onStreamEnd);
		function onStreamEvent(data) {
			buf += data.toString();
			pump();
			function pump() {
				var pos;
				while ((pos = buf.indexOf("\n")) >= 0) {
					if (pos == 0) {
						buf = buf.slice(1);
						continue;
					}
					processLine(buf.slice(0, pos));
					buf = buf.slice(pos + 1);
				}
			}
			function processLine(line) {
				if (line[line.length - 1] == "\r") line = line.substr(0, line.length - 1);
				if (line.length > 0) {
					var obj = JSON.parse(line);
					output.push(obj);
					if (onProgress) onProgress(obj);
				}
			}
		}
		function onStreamError(err) {
			finished = true;
			streama.removeListener("data", onStreamEvent);
			streama.removeListener("error", onStreamError);
			streama.removeListener("end", onStreamEnd);
			streama.removeListener("close", onStreamEnd);
			onFinished(err, output);
		}
		function onStreamEnd() {
			if (!finished) onFinished(null, output);
			finished = true;
		}
	};
	Modem.prototype.buildQuerystring = function(opts) {
		var clone = {};
		Object.keys(opts).map(function(key, i) {
			if (opts[key] && typeof opts[key] === "object" && !Array.isArray(opts[key])) clone[key] = JSON.stringify(opts[key]);
			else clone[key] = opts[key];
		});
		return querystring.stringify(clone);
	};
	module.exports = Modem;
}));
//#endregion
export { require_modem as t };
