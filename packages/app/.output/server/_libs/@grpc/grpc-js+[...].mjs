import { r as __require, t as __commonJSMin } from "../../_runtime.mjs";
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/constants.js
var require_constants = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.DEFAULT_MAX_RECEIVE_MESSAGE_LENGTH = exports.DEFAULT_MAX_SEND_MESSAGE_LENGTH = exports.Propagate = exports.LogVerbosity = exports.Status = void 0;
	var Status;
	(function(Status) {
		Status[Status["OK"] = 0] = "OK";
		Status[Status["CANCELLED"] = 1] = "CANCELLED";
		Status[Status["UNKNOWN"] = 2] = "UNKNOWN";
		Status[Status["INVALID_ARGUMENT"] = 3] = "INVALID_ARGUMENT";
		Status[Status["DEADLINE_EXCEEDED"] = 4] = "DEADLINE_EXCEEDED";
		Status[Status["NOT_FOUND"] = 5] = "NOT_FOUND";
		Status[Status["ALREADY_EXISTS"] = 6] = "ALREADY_EXISTS";
		Status[Status["PERMISSION_DENIED"] = 7] = "PERMISSION_DENIED";
		Status[Status["RESOURCE_EXHAUSTED"] = 8] = "RESOURCE_EXHAUSTED";
		Status[Status["FAILED_PRECONDITION"] = 9] = "FAILED_PRECONDITION";
		Status[Status["ABORTED"] = 10] = "ABORTED";
		Status[Status["OUT_OF_RANGE"] = 11] = "OUT_OF_RANGE";
		Status[Status["UNIMPLEMENTED"] = 12] = "UNIMPLEMENTED";
		Status[Status["INTERNAL"] = 13] = "INTERNAL";
		Status[Status["UNAVAILABLE"] = 14] = "UNAVAILABLE";
		Status[Status["DATA_LOSS"] = 15] = "DATA_LOSS";
		Status[Status["UNAUTHENTICATED"] = 16] = "UNAUTHENTICATED";
	})(Status || (exports.Status = Status = {}));
	var LogVerbosity;
	(function(LogVerbosity) {
		LogVerbosity[LogVerbosity["DEBUG"] = 0] = "DEBUG";
		LogVerbosity[LogVerbosity["INFO"] = 1] = "INFO";
		LogVerbosity[LogVerbosity["ERROR"] = 2] = "ERROR";
		LogVerbosity[LogVerbosity["NONE"] = 3] = "NONE";
	})(LogVerbosity || (exports.LogVerbosity = LogVerbosity = {}));
	/**
	* NOTE: This enum is not currently used in any implemented API in this
	* library. It is included only for type parity with the other implementation.
	*/
	var Propagate;
	(function(Propagate) {
		Propagate[Propagate["DEADLINE"] = 1] = "DEADLINE";
		Propagate[Propagate["CENSUS_STATS_CONTEXT"] = 2] = "CENSUS_STATS_CONTEXT";
		Propagate[Propagate["CENSUS_TRACING_CONTEXT"] = 4] = "CENSUS_TRACING_CONTEXT";
		Propagate[Propagate["CANCELLATION"] = 8] = "CANCELLATION";
		Propagate[Propagate["DEFAULTS"] = 65535] = "DEFAULTS";
	})(Propagate || (exports.Propagate = Propagate = {}));
	exports.DEFAULT_MAX_SEND_MESSAGE_LENGTH = -1;
	exports.DEFAULT_MAX_RECEIVE_MESSAGE_LENGTH = 4 * 1024 * 1024;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/package.json
var require_package = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = {
		"name": "@grpc/grpc-js",
		"version": "1.14.3",
		"description": "gRPC Library for Node - pure JS implementation",
		"homepage": "https://grpc.io/",
		"repository": "https://github.com/grpc/grpc-node/tree/master/packages/grpc-js",
		"main": "build/src/index.js",
		"engines": { "node": ">=12.10.0" },
		"keywords": [],
		"author": { "name": "Google Inc." },
		"types": "build/src/index.d.ts",
		"license": "Apache-2.0",
		"devDependencies": {
			"@grpc/proto-loader": "file:../proto-loader",
			"@types/gulp": "^4.0.17",
			"@types/gulp-mocha": "0.0.37",
			"@types/lodash": "^4.14.202",
			"@types/mocha": "^10.0.6",
			"@types/ncp": "^2.0.8",
			"@types/node": ">=20.11.20",
			"@types/pify": "^5.0.4",
			"@types/semver": "^7.5.8",
			"@typescript-eslint/eslint-plugin": "^7.1.0",
			"@typescript-eslint/parser": "^7.1.0",
			"@typescript-eslint/typescript-estree": "^7.1.0",
			"clang-format": "^1.8.0",
			"eslint": "^8.42.0",
			"eslint-config-prettier": "^8.8.0",
			"eslint-plugin-node": "^11.1.0",
			"eslint-plugin-prettier": "^4.2.1",
			"execa": "^2.0.3",
			"gulp": "^4.0.2",
			"gulp-mocha": "^6.0.0",
			"lodash": "^4.17.21",
			"madge": "^5.0.1",
			"mocha-jenkins-reporter": "^0.4.1",
			"ncp": "^2.0.0",
			"pify": "^4.0.1",
			"prettier": "^2.8.8",
			"rimraf": "^3.0.2",
			"semver": "^7.6.0",
			"ts-node": "^10.9.2",
			"typescript": "^5.3.3"
		},
		"contributors": [{ "name": "Google Inc." }],
		"scripts": {
			"build": "npm run compile",
			"clean": "rimraf ./build",
			"compile": "tsc -p .",
			"format": "clang-format -i -style=\"{Language: JavaScript, BasedOnStyle: Google, ColumnLimit: 80}\" src/*.ts test/*.ts",
			"lint": "eslint src/*.ts test/*.ts",
			"prepare": "npm run copy-protos && npm run generate-types && npm run generate-test-types && npm run compile",
			"test": "gulp test",
			"check": "npm run lint",
			"fix": "eslint --fix src/*.ts test/*.ts",
			"pretest": "npm run generate-types && npm run generate-test-types && npm run compile",
			"posttest": "npm run check && madge -c ./build/src",
			"generate-types": "proto-loader-gen-types --keepCase --longs String --enums String --defaults --oneofs --includeComments --includeDirs proto/ --include-dirs proto/ proto/xds/ proto/protoc-gen-validate/ -O src/generated/ --grpcLib ../index channelz.proto xds/service/orca/v3/orca.proto",
			"generate-test-types": "proto-loader-gen-types --keepCase --longs String --enums String --defaults --oneofs --includeComments --include-dirs test/fixtures/ -O test/generated/ --grpcLib ../../src/index test_service.proto echo_service.proto",
			"copy-protos": "node ./copy-protos"
		},
		"dependencies": {
			"@grpc/proto-loader": "^0.8.0",
			"@js-sdsl/ordered-map": "^4.4.2"
		},
		"files": [
			"src/**/*.ts",
			"build/src/**/*.{js,d.ts,js.map}",
			"proto/**/*.proto",
			"proto/**/LICENSE",
			"LICENSE",
			"deps/envoy-api/envoy/api/v2/**/*.proto",
			"deps/envoy-api/envoy/config/**/*.proto",
			"deps/envoy-api/envoy/service/**/*.proto",
			"deps/envoy-api/envoy/type/**/*.proto",
			"deps/udpa/udpa/**/*.proto",
			"deps/googleapis/google/api/*.proto",
			"deps/googleapis/google/rpc/*.proto",
			"deps/protoc-gen-validate/validate/**/*.proto"
		]
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/logging.js
var require_logging = /* @__PURE__ */ __commonJSMin(((exports) => {
	var _a, _b, _c, _d;
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.log = exports.setLoggerVerbosity = exports.setLogger = exports.getLogger = void 0;
	exports.trace = trace;
	exports.isTracerEnabled = isTracerEnabled;
	const constants_1 = require_constants();
	const process_1 = __require("process");
	const clientVersion = require_package().version;
	let _logger = {
		error: (message, ...optionalParams) => {
			console.error("E " + message, ...optionalParams);
		},
		info: (message, ...optionalParams) => {
			console.error("I " + message, ...optionalParams);
		},
		debug: (message, ...optionalParams) => {
			console.error("D " + message, ...optionalParams);
		}
	};
	let _logVerbosity = constants_1.LogVerbosity.ERROR;
	switch (((_b = (_a = process.env.GRPC_NODE_VERBOSITY) !== null && _a !== void 0 ? _a : process.env.GRPC_VERBOSITY) !== null && _b !== void 0 ? _b : "").toUpperCase()) {
		case "DEBUG":
			_logVerbosity = constants_1.LogVerbosity.DEBUG;
			break;
		case "INFO":
			_logVerbosity = constants_1.LogVerbosity.INFO;
			break;
		case "ERROR":
			_logVerbosity = constants_1.LogVerbosity.ERROR;
			break;
		case "NONE":
			_logVerbosity = constants_1.LogVerbosity.NONE;
			break;
		default:
	}
	const getLogger = () => {
		return _logger;
	};
	exports.getLogger = getLogger;
	const setLogger = (logger) => {
		_logger = logger;
	};
	exports.setLogger = setLogger;
	const setLoggerVerbosity = (verbosity) => {
		_logVerbosity = verbosity;
	};
	exports.setLoggerVerbosity = setLoggerVerbosity;
	const log = (severity, ...args) => {
		let logFunction;
		if (severity >= _logVerbosity) {
			switch (severity) {
				case constants_1.LogVerbosity.DEBUG:
					logFunction = _logger.debug;
					break;
				case constants_1.LogVerbosity.INFO:
					logFunction = _logger.info;
					break;
				case constants_1.LogVerbosity.ERROR:
					logFunction = _logger.error;
					break;
			}
			if (!logFunction) logFunction = _logger.error;
			if (logFunction) logFunction.bind(_logger)(...args);
		}
	};
	exports.log = log;
	const tracersString = (_d = (_c = process.env.GRPC_NODE_TRACE) !== null && _c !== void 0 ? _c : process.env.GRPC_TRACE) !== null && _d !== void 0 ? _d : "";
	const enabledTracers = /* @__PURE__ */ new Set();
	const disabledTracers = /* @__PURE__ */ new Set();
	for (const tracerName of tracersString.split(",")) if (tracerName.startsWith("-")) disabledTracers.add(tracerName.substring(1));
	else enabledTracers.add(tracerName);
	const allEnabled = enabledTracers.has("all");
	function trace(severity, tracer, text) {
		if (isTracerEnabled(tracer)) (0, exports.log)(severity, (/* @__PURE__ */ new Date()).toISOString() + " | v" + clientVersion + " " + process_1.pid + " | " + tracer + " | " + text);
	}
	function isTracerEnabled(tracer) {
		return !disabledTracers.has(tracer) && (allEnabled || enabledTracers.has(tracer));
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/error.js
var require_error = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getErrorMessage = getErrorMessage;
	exports.getErrorCode = getErrorCode;
	function getErrorMessage(error) {
		if (error instanceof Error) return error.message;
		else return String(error);
	}
	function getErrorCode(error) {
		if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "number") return error.code;
		else return null;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/metadata.js
var require_metadata = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Metadata = void 0;
	const logging_1 = require_logging();
	const constants_1 = require_constants();
	const error_1 = require_error();
	const LEGAL_KEY_REGEX = /^[:0-9a-z_.-]+$/;
	const LEGAL_NON_BINARY_VALUE_REGEX = /^[ -~]*$/;
	function isLegalKey(key) {
		return LEGAL_KEY_REGEX.test(key);
	}
	function isLegalNonBinaryValue(value) {
		return LEGAL_NON_BINARY_VALUE_REGEX.test(value);
	}
	function isBinaryKey(key) {
		return key.endsWith("-bin");
	}
	function isCustomMetadata(key) {
		return !key.startsWith("grpc-");
	}
	function normalizeKey(key) {
		return key.toLowerCase();
	}
	function validate(key, value) {
		if (!isLegalKey(key)) throw new Error("Metadata key \"" + key + "\" contains illegal characters");
		if (value !== null && value !== void 0) if (isBinaryKey(key)) {
			if (!Buffer.isBuffer(value)) throw new Error("keys that end with '-bin' must have Buffer values");
		} else {
			if (Buffer.isBuffer(value)) throw new Error("keys that don't end with '-bin' must have String values");
			if (!isLegalNonBinaryValue(value)) throw new Error("Metadata string value \"" + value + "\" contains illegal characters");
		}
	}
	exports.Metadata = class Metadata {
		constructor(options = {}) {
			this.internalRepr = /* @__PURE__ */ new Map();
			this.opaqueData = /* @__PURE__ */ new Map();
			this.options = options;
		}
		/**
		* Sets the given value for the given key by replacing any other values
		* associated with that key. Normalizes the key.
		* @param key The key to whose value should be set.
		* @param value The value to set. Must be a buffer if and only
		*   if the normalized key ends with '-bin'.
		*/
		set(key, value) {
			key = normalizeKey(key);
			validate(key, value);
			this.internalRepr.set(key, [value]);
		}
		/**
		* Adds the given value for the given key by appending to a list of previous
		* values associated with that key. Normalizes the key.
		* @param key The key for which a new value should be appended.
		* @param value The value to add. Must be a buffer if and only
		*   if the normalized key ends with '-bin'.
		*/
		add(key, value) {
			key = normalizeKey(key);
			validate(key, value);
			const existingValue = this.internalRepr.get(key);
			if (existingValue === void 0) this.internalRepr.set(key, [value]);
			else existingValue.push(value);
		}
		/**
		* Removes the given key and any associated values. Normalizes the key.
		* @param key The key whose values should be removed.
		*/
		remove(key) {
			key = normalizeKey(key);
			this.internalRepr.delete(key);
		}
		/**
		* Gets a list of all values associated with the key. Normalizes the key.
		* @param key The key whose value should be retrieved.
		* @return A list of values associated with the given key.
		*/
		get(key) {
			key = normalizeKey(key);
			return this.internalRepr.get(key) || [];
		}
		/**
		* Gets a plain object mapping each key to the first value associated with it.
		* This reflects the most common way that people will want to see metadata.
		* @return A key/value mapping of the metadata.
		*/
		getMap() {
			const result = {};
			for (const [key, values] of this.internalRepr) if (values.length > 0) {
				const v = values[0];
				result[key] = Buffer.isBuffer(v) ? Buffer.from(v) : v;
			}
			return result;
		}
		/**
		* Clones the metadata object.
		* @return The newly cloned object.
		*/
		clone() {
			const newMetadata = new Metadata(this.options);
			const newInternalRepr = newMetadata.internalRepr;
			for (const [key, value] of this.internalRepr) {
				const clonedValue = value.map((v) => {
					if (Buffer.isBuffer(v)) return Buffer.from(v);
					else return v;
				});
				newInternalRepr.set(key, clonedValue);
			}
			return newMetadata;
		}
		/**
		* Merges all key-value pairs from a given Metadata object into this one.
		* If both this object and the given object have values in the same key,
		* values from the other Metadata object will be appended to this object's
		* values.
		* @param other A Metadata object.
		*/
		merge(other) {
			for (const [key, values] of other.internalRepr) {
				const mergedValue = (this.internalRepr.get(key) || []).concat(values);
				this.internalRepr.set(key, mergedValue);
			}
		}
		setOptions(options) {
			this.options = options;
		}
		getOptions() {
			return this.options;
		}
		/**
		* Creates an OutgoingHttpHeaders object that can be used with the http2 API.
		*/
		toHttp2Headers() {
			const result = {};
			for (const [key, values] of this.internalRepr) {
				if (key.startsWith(":")) continue;
				result[key] = values.map(bufToString);
			}
			return result;
		}
		/**
		* This modifies the behavior of JSON.stringify to show an object
		* representation of the metadata map.
		*/
		toJSON() {
			const result = {};
			for (const [key, values] of this.internalRepr) result[key] = values;
			return result;
		}
		/**
		* Attach additional data of any type to the metadata object, which will not
		* be included when sending headers. The data can later be retrieved with
		* `getOpaque`. Keys with the prefix `grpc` are reserved for use by this
		* library.
		* @param key
		* @param value
		*/
		setOpaque(key, value) {
			this.opaqueData.set(key, value);
		}
		/**
		* Retrieve data previously added with `setOpaque`.
		* @param key
		* @returns
		*/
		getOpaque(key) {
			return this.opaqueData.get(key);
		}
		/**
		* Returns a new Metadata object based fields in a given IncomingHttpHeaders
		* object.
		* @param headers An IncomingHttpHeaders object.
		*/
		static fromHttp2Headers(headers) {
			const result = new Metadata();
			for (const key of Object.keys(headers)) {
				if (key.charAt(0) === ":") continue;
				const values = headers[key];
				try {
					if (isBinaryKey(key)) {
						if (Array.isArray(values)) values.forEach((value) => {
							result.add(key, Buffer.from(value, "base64"));
						});
						else if (values !== void 0) if (isCustomMetadata(key)) values.split(",").forEach((v) => {
							result.add(key, Buffer.from(v.trim(), "base64"));
						});
						else result.add(key, Buffer.from(values, "base64"));
					} else if (Array.isArray(values)) values.forEach((value) => {
						result.add(key, value);
					});
					else if (values !== void 0) result.add(key, values);
				} catch (error) {
					const message = `Failed to add metadata entry ${key}: ${values}. ${(0, error_1.getErrorMessage)(error)}. For more information see https://github.com/grpc/grpc-node/issues/1173`;
					(0, logging_1.log)(constants_1.LogVerbosity.ERROR, message);
				}
			}
			return result;
		}
	};
	const bufToString = (val) => {
		return Buffer.isBuffer(val) ? val.toString("base64") : val;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/call-credentials.js
var require_call_credentials = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CallCredentials = void 0;
	const metadata_1 = require_metadata();
	function isCurrentOauth2Client(client) {
		return "getRequestHeaders" in client && typeof client.getRequestHeaders === "function";
	}
	/**
	* A class that represents a generic method of adding authentication-related
	* metadata on a per-request basis.
	*/
	var CallCredentials = class CallCredentials {
		/**
		* Creates a new CallCredentials object from a given function that generates
		* Metadata objects.
		* @param metadataGenerator A function that accepts a set of options, and
		* generates a Metadata object based on these options, which is passed back
		* to the caller via a supplied (err, metadata) callback.
		*/
		static createFromMetadataGenerator(metadataGenerator) {
			return new SingleCallCredentials(metadataGenerator);
		}
		/**
		* Create a gRPC credential from a Google credential object.
		* @param googleCredentials The authentication client to use.
		* @return The resulting CallCredentials object.
		*/
		static createFromGoogleCredential(googleCredentials) {
			return CallCredentials.createFromMetadataGenerator((options, callback) => {
				let getHeaders;
				if (isCurrentOauth2Client(googleCredentials)) getHeaders = googleCredentials.getRequestHeaders(options.service_url);
				else getHeaders = new Promise((resolve, reject) => {
					googleCredentials.getRequestMetadata(options.service_url, (err, headers) => {
						if (err) {
							reject(err);
							return;
						}
						if (!headers) {
							reject(/* @__PURE__ */ new Error("Headers not set by metadata plugin"));
							return;
						}
						resolve(headers);
					});
				});
				getHeaders.then((headers) => {
					const metadata = new metadata_1.Metadata();
					for (const key of Object.keys(headers)) metadata.add(key, headers[key]);
					callback(null, metadata);
				}, (err) => {
					callback(err);
				});
			});
		}
		static createEmpty() {
			return new EmptyCallCredentials();
		}
	};
	exports.CallCredentials = CallCredentials;
	var ComposedCallCredentials = class ComposedCallCredentials extends CallCredentials {
		constructor(creds) {
			super();
			this.creds = creds;
		}
		async generateMetadata(options) {
			const base = new metadata_1.Metadata();
			const generated = await Promise.all(this.creds.map((cred) => cred.generateMetadata(options)));
			for (const gen of generated) base.merge(gen);
			return base;
		}
		compose(other) {
			return new ComposedCallCredentials(this.creds.concat([other]));
		}
		_equals(other) {
			if (this === other) return true;
			if (other instanceof ComposedCallCredentials) return this.creds.every((value, index) => value._equals(other.creds[index]));
			else return false;
		}
	};
	var SingleCallCredentials = class SingleCallCredentials extends CallCredentials {
		constructor(metadataGenerator) {
			super();
			this.metadataGenerator = metadataGenerator;
		}
		generateMetadata(options) {
			return new Promise((resolve, reject) => {
				this.metadataGenerator(options, (err, metadata) => {
					if (metadata !== void 0) resolve(metadata);
					else reject(err);
				});
			});
		}
		compose(other) {
			return new ComposedCallCredentials([this, other]);
		}
		_equals(other) {
			if (this === other) return true;
			if (other instanceof SingleCallCredentials) return this.metadataGenerator === other.metadataGenerator;
			else return false;
		}
	};
	var EmptyCallCredentials = class EmptyCallCredentials extends CallCredentials {
		generateMetadata(options) {
			return Promise.resolve(new metadata_1.Metadata());
		}
		compose(other) {
			return other;
		}
		_equals(other) {
			return other instanceof EmptyCallCredentials;
		}
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/tls-helpers.js
var require_tls_helpers = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CIPHER_SUITES = void 0;
	exports.getDefaultRootsData = getDefaultRootsData;
	const fs$2 = __require("fs");
	exports.CIPHER_SUITES = process.env.GRPC_SSL_CIPHER_SUITES;
	const DEFAULT_ROOTS_FILE_PATH = process.env.GRPC_DEFAULT_SSL_ROOTS_FILE_PATH;
	let defaultRootsData = null;
	function getDefaultRootsData() {
		if (DEFAULT_ROOTS_FILE_PATH) {
			if (defaultRootsData === null) defaultRootsData = fs$2.readFileSync(DEFAULT_ROOTS_FILE_PATH);
			return defaultRootsData;
		}
		return null;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/uri-parser.js
var require_uri_parser = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.parseUri = parseUri;
	exports.splitHostPort = splitHostPort;
	exports.combineHostPort = combineHostPort;
	exports.uriToString = uriToString;
	const URI_REGEX = /^(?:([A-Za-z0-9+.-]+):)?(?:\/\/([^/]*)\/)?(.+)$/;
	function parseUri(uriString) {
		const parsedUri = URI_REGEX.exec(uriString);
		if (parsedUri === null) return null;
		return {
			scheme: parsedUri[1],
			authority: parsedUri[2],
			path: parsedUri[3]
		};
	}
	const NUMBER_REGEX = /^\d+$/;
	function splitHostPort(path) {
		if (path.startsWith("[")) {
			const hostEnd = path.indexOf("]");
			if (hostEnd === -1) return null;
			const host = path.substring(1, hostEnd);
			if (host.indexOf(":") === -1) return null;
			if (path.length > hostEnd + 1) if (path[hostEnd + 1] === ":") {
				const portString = path.substring(hostEnd + 2);
				if (NUMBER_REGEX.test(portString)) return {
					host,
					port: +portString
				};
				else return null;
			} else return null;
			else return { host };
		} else {
			const splitPath = path.split(":");
			if (splitPath.length === 2) if (NUMBER_REGEX.test(splitPath[1])) return {
				host: splitPath[0],
				port: +splitPath[1]
			};
			else return null;
			else return { host: path };
		}
	}
	function combineHostPort(hostPort) {
		if (hostPort.port === void 0) return hostPort.host;
		else if (hostPort.host.includes(":")) return `[${hostPort.host}]:${hostPort.port}`;
		else return `${hostPort.host}:${hostPort.port}`;
	}
	function uriToString(uri) {
		let result = "";
		if (uri.scheme !== void 0) result += uri.scheme + ":";
		if (uri.authority !== void 0) result += "//" + uri.authority + "/";
		result += uri.path;
		return result;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/resolver.js
var require_resolver = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CHANNEL_ARGS_CONFIG_SELECTOR_KEY = void 0;
	exports.registerResolver = registerResolver;
	exports.registerDefaultScheme = registerDefaultScheme;
	exports.createResolver = createResolver;
	exports.getDefaultAuthority = getDefaultAuthority;
	exports.mapUriDefaultScheme = mapUriDefaultScheme;
	const uri_parser_1 = require_uri_parser();
	exports.CHANNEL_ARGS_CONFIG_SELECTOR_KEY = "grpc.internal.config_selector";
	const registeredResolvers = {};
	let defaultScheme = null;
	/**
	* Register a resolver class to handle target names prefixed with the `prefix`
	* string. This prefix should correspond to a URI scheme name listed in the
	* [gRPC Name Resolution document](https://github.com/grpc/grpc/blob/master/doc/naming.md)
	* @param prefix
	* @param resolverClass
	*/
	function registerResolver(scheme, resolverClass) {
		registeredResolvers[scheme] = resolverClass;
	}
	/**
	* Register a default resolver to handle target names that do not start with
	* any registered prefix.
	* @param resolverClass
	*/
	function registerDefaultScheme(scheme) {
		defaultScheme = scheme;
	}
	/**
	* Create a name resolver for the specified target, if possible. Throws an
	* error if no such name resolver can be created.
	* @param target
	* @param listener
	*/
	function createResolver(target, listener, options) {
		if (target.scheme !== void 0 && target.scheme in registeredResolvers) return new registeredResolvers[target.scheme](target, listener, options);
		else throw new Error(`No resolver could be created for target ${(0, uri_parser_1.uriToString)(target)}`);
	}
	/**
	* Get the default authority for the specified target, if possible. Throws an
	* error if no registered name resolver can parse that target string.
	* @param target
	*/
	function getDefaultAuthority(target) {
		if (target.scheme !== void 0 && target.scheme in registeredResolvers) return registeredResolvers[target.scheme].getDefaultAuthority(target);
		else throw new Error(`Invalid target ${(0, uri_parser_1.uriToString)(target)}`);
	}
	function mapUriDefaultScheme(target) {
		if (target.scheme === void 0 || !(target.scheme in registeredResolvers)) if (defaultScheme !== null) return {
			scheme: defaultScheme,
			authority: void 0,
			path: (0, uri_parser_1.uriToString)(target)
		};
		else return null;
		return target;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/channel-credentials.js
var require_channel_credentials = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ChannelCredentials = void 0;
	exports.createCertificateProviderChannelCredentials = createCertificateProviderChannelCredentials;
	const tls_1$2 = __require("tls");
	const call_credentials_1 = require_call_credentials();
	const tls_helpers_1 = require_tls_helpers();
	const uri_parser_1 = require_uri_parser();
	const resolver_1 = require_resolver();
	const logging_1 = require_logging();
	const constants_1 = require_constants();
	function verifyIsBufferOrNull(obj, friendlyName) {
		if (obj && !(obj instanceof Buffer)) throw new TypeError(`${friendlyName}, if provided, must be a Buffer.`);
	}
	/**
	* A class that contains credentials for communicating over a channel, as well
	* as a set of per-call credentials, which are applied to every method call made
	* over a channel initialized with an instance of this class.
	*/
	var ChannelCredentials = class {
		/**
		* Returns a copy of this object with the included set of per-call credentials
		* expanded to include callCredentials.
		* @param callCredentials A CallCredentials object to associate with this
		* instance.
		*/
		compose(callCredentials) {
			return new ComposedChannelCredentialsImpl(this, callCredentials);
		}
		/**
		* Return a new ChannelCredentials instance with a given set of credentials.
		* The resulting instance can be used to construct a Channel that communicates
		* over TLS.
		* @param rootCerts The root certificate data.
		* @param privateKey The client certificate private key, if available.
		* @param certChain The client certificate key chain, if available.
		* @param verifyOptions Additional options to modify certificate verification
		*/
		static createSsl(rootCerts, privateKey, certChain, verifyOptions) {
			var _a;
			verifyIsBufferOrNull(rootCerts, "Root certificate");
			verifyIsBufferOrNull(privateKey, "Private key");
			verifyIsBufferOrNull(certChain, "Certificate chain");
			if (privateKey && !certChain) throw new Error("Private key must be given with accompanying certificate chain");
			if (!privateKey && certChain) throw new Error("Certificate chain must be given with accompanying private key");
			return new SecureChannelCredentialsImpl((0, tls_1$2.createSecureContext)({
				ca: (_a = rootCerts !== null && rootCerts !== void 0 ? rootCerts : (0, tls_helpers_1.getDefaultRootsData)()) !== null && _a !== void 0 ? _a : void 0,
				key: privateKey !== null && privateKey !== void 0 ? privateKey : void 0,
				cert: certChain !== null && certChain !== void 0 ? certChain : void 0,
				ciphers: tls_helpers_1.CIPHER_SUITES
			}), verifyOptions !== null && verifyOptions !== void 0 ? verifyOptions : {});
		}
		/**
		* Return a new ChannelCredentials instance with credentials created using
		* the provided secureContext. The resulting instances can be used to
		* construct a Channel that communicates over TLS. gRPC will not override
		* anything in the provided secureContext, so the environment variables
		* GRPC_SSL_CIPHER_SUITES and GRPC_DEFAULT_SSL_ROOTS_FILE_PATH will
		* not be applied.
		* @param secureContext The return value of tls.createSecureContext()
		* @param verifyOptions Additional options to modify certificate verification
		*/
		static createFromSecureContext(secureContext, verifyOptions) {
			return new SecureChannelCredentialsImpl(secureContext, verifyOptions !== null && verifyOptions !== void 0 ? verifyOptions : {});
		}
		/**
		* Return a new ChannelCredentials instance with no credentials.
		*/
		static createInsecure() {
			return new InsecureChannelCredentialsImpl();
		}
	};
	exports.ChannelCredentials = ChannelCredentials;
	var InsecureChannelCredentialsImpl = class InsecureChannelCredentialsImpl extends ChannelCredentials {
		constructor() {
			super();
		}
		compose(callCredentials) {
			throw new Error("Cannot compose insecure credentials");
		}
		_isSecure() {
			return false;
		}
		_equals(other) {
			return other instanceof InsecureChannelCredentialsImpl;
		}
		_createSecureConnector(channelTarget, options, callCredentials) {
			return {
				connect(socket) {
					return Promise.resolve({
						socket,
						secure: false
					});
				},
				waitForReady: () => {
					return Promise.resolve();
				},
				getCallCredentials: () => {
					return callCredentials !== null && callCredentials !== void 0 ? callCredentials : call_credentials_1.CallCredentials.createEmpty();
				},
				destroy() {}
			};
		}
	};
	function getConnectionOptions(secureContext, verifyOptions, channelTarget, options) {
		var _a, _b;
		const connectionOptions = { secureContext };
		let realTarget = channelTarget;
		if ("grpc.http_connect_target" in options) {
			const parsedTarget = (0, uri_parser_1.parseUri)(options["grpc.http_connect_target"]);
			if (parsedTarget) realTarget = parsedTarget;
		}
		const targetPath = (0, resolver_1.getDefaultAuthority)(realTarget);
		const hostPort = (0, uri_parser_1.splitHostPort)(targetPath);
		const remoteHost = (_a = hostPort === null || hostPort === void 0 ? void 0 : hostPort.host) !== null && _a !== void 0 ? _a : targetPath;
		connectionOptions.host = remoteHost;
		if (verifyOptions.checkServerIdentity) connectionOptions.checkServerIdentity = verifyOptions.checkServerIdentity;
		if (verifyOptions.rejectUnauthorized !== void 0) connectionOptions.rejectUnauthorized = verifyOptions.rejectUnauthorized;
		connectionOptions.ALPNProtocols = ["h2"];
		if (options["grpc.ssl_target_name_override"]) {
			const sslTargetNameOverride = options["grpc.ssl_target_name_override"];
			const originalCheckServerIdentity = (_b = connectionOptions.checkServerIdentity) !== null && _b !== void 0 ? _b : tls_1$2.checkServerIdentity;
			connectionOptions.checkServerIdentity = (host, cert) => {
				return originalCheckServerIdentity(sslTargetNameOverride, cert);
			};
			connectionOptions.servername = sslTargetNameOverride;
		} else connectionOptions.servername = remoteHost;
		if (options["grpc-node.tls_enable_trace"]) connectionOptions.enableTrace = true;
		return connectionOptions;
	}
	var SecureConnectorImpl = class {
		constructor(connectionOptions, callCredentials) {
			this.connectionOptions = connectionOptions;
			this.callCredentials = callCredentials;
		}
		connect(socket) {
			const tlsConnectOptions = Object.assign({ socket }, this.connectionOptions);
			return new Promise((resolve, reject) => {
				const tlsSocket = (0, tls_1$2.connect)(tlsConnectOptions, () => {
					var _a;
					if (((_a = this.connectionOptions.rejectUnauthorized) !== null && _a !== void 0 ? _a : true) && !tlsSocket.authorized) {
						reject(tlsSocket.authorizationError);
						return;
					}
					resolve({
						socket: tlsSocket,
						secure: true
					});
				});
				tlsSocket.on("error", (error) => {
					reject(error);
				});
			});
		}
		waitForReady() {
			return Promise.resolve();
		}
		getCallCredentials() {
			return this.callCredentials;
		}
		destroy() {}
	};
	var SecureChannelCredentialsImpl = class SecureChannelCredentialsImpl extends ChannelCredentials {
		constructor(secureContext, verifyOptions) {
			super();
			this.secureContext = secureContext;
			this.verifyOptions = verifyOptions;
		}
		_isSecure() {
			return true;
		}
		_equals(other) {
			if (this === other) return true;
			if (other instanceof SecureChannelCredentialsImpl) return this.secureContext === other.secureContext && this.verifyOptions.checkServerIdentity === other.verifyOptions.checkServerIdentity;
			else return false;
		}
		_createSecureConnector(channelTarget, options, callCredentials) {
			return new SecureConnectorImpl(getConnectionOptions(this.secureContext, this.verifyOptions, channelTarget, options), callCredentials !== null && callCredentials !== void 0 ? callCredentials : call_credentials_1.CallCredentials.createEmpty());
		}
	};
	var CertificateProviderChannelCredentialsImpl = class CertificateProviderChannelCredentialsImpl extends ChannelCredentials {
		constructor(caCertificateProvider, identityCertificateProvider, verifyOptions) {
			super();
			this.caCertificateProvider = caCertificateProvider;
			this.identityCertificateProvider = identityCertificateProvider;
			this.verifyOptions = verifyOptions;
			this.refcount = 0;
			/**
			* `undefined` means that the certificates have not yet been loaded. `null`
			* means that an attempt to load them has completed, and has failed.
			*/
			this.latestCaUpdate = void 0;
			/**
			* `undefined` means that the certificates have not yet been loaded. `null`
			* means that an attempt to load them has completed, and has failed.
			*/
			this.latestIdentityUpdate = void 0;
			this.caCertificateUpdateListener = this.handleCaCertificateUpdate.bind(this);
			this.identityCertificateUpdateListener = this.handleIdentityCertitificateUpdate.bind(this);
			this.secureContextWatchers = [];
		}
		_isSecure() {
			return true;
		}
		_equals(other) {
			var _a, _b;
			if (this === other) return true;
			if (other instanceof CertificateProviderChannelCredentialsImpl) return this.caCertificateProvider === other.caCertificateProvider && this.identityCertificateProvider === other.identityCertificateProvider && ((_a = this.verifyOptions) === null || _a === void 0 ? void 0 : _a.checkServerIdentity) === ((_b = other.verifyOptions) === null || _b === void 0 ? void 0 : _b.checkServerIdentity);
			else return false;
		}
		ref() {
			var _a;
			if (this.refcount === 0) {
				this.caCertificateProvider.addCaCertificateListener(this.caCertificateUpdateListener);
				(_a = this.identityCertificateProvider) === null || _a === void 0 || _a.addIdentityCertificateListener(this.identityCertificateUpdateListener);
			}
			this.refcount += 1;
		}
		unref() {
			var _a;
			this.refcount -= 1;
			if (this.refcount === 0) {
				this.caCertificateProvider.removeCaCertificateListener(this.caCertificateUpdateListener);
				(_a = this.identityCertificateProvider) === null || _a === void 0 || _a.removeIdentityCertificateListener(this.identityCertificateUpdateListener);
			}
		}
		_createSecureConnector(channelTarget, options, callCredentials) {
			this.ref();
			return new CertificateProviderChannelCredentialsImpl.SecureConnectorImpl(this, channelTarget, options, callCredentials !== null && callCredentials !== void 0 ? callCredentials : call_credentials_1.CallCredentials.createEmpty());
		}
		maybeUpdateWatchers() {
			if (this.hasReceivedUpdates()) {
				for (const watcher of this.secureContextWatchers) watcher(this.getLatestSecureContext());
				this.secureContextWatchers = [];
			}
		}
		handleCaCertificateUpdate(update) {
			this.latestCaUpdate = update;
			this.maybeUpdateWatchers();
		}
		handleIdentityCertitificateUpdate(update) {
			this.latestIdentityUpdate = update;
			this.maybeUpdateWatchers();
		}
		hasReceivedUpdates() {
			if (this.latestCaUpdate === void 0) return false;
			if (this.identityCertificateProvider && this.latestIdentityUpdate === void 0) return false;
			return true;
		}
		getSecureContext() {
			if (this.hasReceivedUpdates()) return Promise.resolve(this.getLatestSecureContext());
			else return new Promise((resolve) => {
				this.secureContextWatchers.push(resolve);
			});
		}
		getLatestSecureContext() {
			var _a, _b;
			if (!this.latestCaUpdate) return null;
			if (this.identityCertificateProvider !== null && !this.latestIdentityUpdate) return null;
			try {
				return (0, tls_1$2.createSecureContext)({
					ca: this.latestCaUpdate.caCertificate,
					key: (_a = this.latestIdentityUpdate) === null || _a === void 0 ? void 0 : _a.privateKey,
					cert: (_b = this.latestIdentityUpdate) === null || _b === void 0 ? void 0 : _b.certificate,
					ciphers: tls_helpers_1.CIPHER_SUITES
				});
			} catch (e) {
				(0, logging_1.log)(constants_1.LogVerbosity.ERROR, "Failed to createSecureContext with error " + e.message);
				return null;
			}
		}
	};
	CertificateProviderChannelCredentialsImpl.SecureConnectorImpl = class {
		constructor(parent, channelTarget, options, callCredentials) {
			this.parent = parent;
			this.channelTarget = channelTarget;
			this.options = options;
			this.callCredentials = callCredentials;
		}
		connect(socket) {
			return new Promise((resolve, reject) => {
				const secureContext = this.parent.getLatestSecureContext();
				if (!secureContext) {
					reject(/* @__PURE__ */ new Error("Failed to load credentials"));
					return;
				}
				if (socket.closed) reject(/* @__PURE__ */ new Error("Socket closed while loading credentials"));
				const connnectionOptions = getConnectionOptions(secureContext, this.parent.verifyOptions, this.channelTarget, this.options);
				const tlsConnectOptions = Object.assign({ socket }, connnectionOptions);
				const closeCallback = () => {
					reject(/* @__PURE__ */ new Error("Socket closed"));
				};
				const errorCallback = (error) => {
					reject(error);
				};
				const tlsSocket = (0, tls_1$2.connect)(tlsConnectOptions, () => {
					var _a;
					tlsSocket.removeListener("close", closeCallback);
					tlsSocket.removeListener("error", errorCallback);
					if (((_a = this.parent.verifyOptions.rejectUnauthorized) !== null && _a !== void 0 ? _a : true) && !tlsSocket.authorized) {
						reject(tlsSocket.authorizationError);
						return;
					}
					resolve({
						socket: tlsSocket,
						secure: true
					});
				});
				tlsSocket.once("close", closeCallback);
				tlsSocket.once("error", errorCallback);
			});
		}
		async waitForReady() {
			await this.parent.getSecureContext();
		}
		getCallCredentials() {
			return this.callCredentials;
		}
		destroy() {
			this.parent.unref();
		}
	};
	function createCertificateProviderChannelCredentials(caCertificateProvider, identityCertificateProvider, verifyOptions) {
		return new CertificateProviderChannelCredentialsImpl(caCertificateProvider, identityCertificateProvider, verifyOptions !== null && verifyOptions !== void 0 ? verifyOptions : {});
	}
	var ComposedChannelCredentialsImpl = class ComposedChannelCredentialsImpl extends ChannelCredentials {
		constructor(channelCredentials, callCredentials) {
			super();
			this.channelCredentials = channelCredentials;
			this.callCredentials = callCredentials;
			if (!channelCredentials._isSecure()) throw new Error("Cannot compose insecure credentials");
		}
		compose(callCredentials) {
			const combinedCallCredentials = this.callCredentials.compose(callCredentials);
			return new ComposedChannelCredentialsImpl(this.channelCredentials, combinedCallCredentials);
		}
		_isSecure() {
			return true;
		}
		_equals(other) {
			if (this === other) return true;
			if (other instanceof ComposedChannelCredentialsImpl) return this.channelCredentials._equals(other.channelCredentials) && this.callCredentials._equals(other.callCredentials);
			else return false;
		}
		_createSecureConnector(channelTarget, options, callCredentials) {
			const combinedCallCredentials = this.callCredentials.compose(callCredentials !== null && callCredentials !== void 0 ? callCredentials : call_credentials_1.CallCredentials.createEmpty());
			return this.channelCredentials._createSecureConnector(channelTarget, options, combinedCallCredentials);
		}
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/load-balancer.js
var require_load_balancer = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.createChildChannelControlHelper = createChildChannelControlHelper;
	exports.registerLoadBalancerType = registerLoadBalancerType;
	exports.registerDefaultLoadBalancerType = registerDefaultLoadBalancerType;
	exports.createLoadBalancer = createLoadBalancer;
	exports.isLoadBalancerNameRegistered = isLoadBalancerNameRegistered;
	exports.parseLoadBalancingConfig = parseLoadBalancingConfig;
	exports.getDefaultConfig = getDefaultConfig;
	exports.selectLbConfigFromList = selectLbConfigFromList;
	const logging_1 = require_logging();
	const constants_1 = require_constants();
	/**
	* Create a child ChannelControlHelper that overrides some methods of the
	* parent while letting others pass through to the parent unmodified. This
	* allows other code to create these children without needing to know about
	* all of the methods to be passed through.
	* @param parent
	* @param overrides
	*/
	function createChildChannelControlHelper(parent, overrides) {
		var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
		return {
			createSubchannel: (_b = (_a = overrides.createSubchannel) === null || _a === void 0 ? void 0 : _a.bind(overrides)) !== null && _b !== void 0 ? _b : parent.createSubchannel.bind(parent),
			updateState: (_d = (_c = overrides.updateState) === null || _c === void 0 ? void 0 : _c.bind(overrides)) !== null && _d !== void 0 ? _d : parent.updateState.bind(parent),
			requestReresolution: (_f = (_e = overrides.requestReresolution) === null || _e === void 0 ? void 0 : _e.bind(overrides)) !== null && _f !== void 0 ? _f : parent.requestReresolution.bind(parent),
			addChannelzChild: (_h = (_g = overrides.addChannelzChild) === null || _g === void 0 ? void 0 : _g.bind(overrides)) !== null && _h !== void 0 ? _h : parent.addChannelzChild.bind(parent),
			removeChannelzChild: (_k = (_j = overrides.removeChannelzChild) === null || _j === void 0 ? void 0 : _j.bind(overrides)) !== null && _k !== void 0 ? _k : parent.removeChannelzChild.bind(parent)
		};
	}
	const registeredLoadBalancerTypes = {};
	let defaultLoadBalancerType = null;
	function registerLoadBalancerType(typeName, loadBalancerType, loadBalancingConfigType) {
		registeredLoadBalancerTypes[typeName] = {
			LoadBalancer: loadBalancerType,
			LoadBalancingConfig: loadBalancingConfigType
		};
	}
	function registerDefaultLoadBalancerType(typeName) {
		defaultLoadBalancerType = typeName;
	}
	function createLoadBalancer(config, channelControlHelper) {
		const typeName = config.getLoadBalancerName();
		if (typeName in registeredLoadBalancerTypes) return new registeredLoadBalancerTypes[typeName].LoadBalancer(channelControlHelper);
		else return null;
	}
	function isLoadBalancerNameRegistered(typeName) {
		return typeName in registeredLoadBalancerTypes;
	}
	function parseLoadBalancingConfig(rawConfig) {
		const keys = Object.keys(rawConfig);
		if (keys.length !== 1) throw new Error("Provided load balancing config has multiple conflicting entries");
		const typeName = keys[0];
		if (typeName in registeredLoadBalancerTypes) try {
			return registeredLoadBalancerTypes[typeName].LoadBalancingConfig.createFromJson(rawConfig[typeName]);
		} catch (e) {
			throw new Error(`${typeName}: ${e.message}`);
		}
		else throw new Error(`Unrecognized load balancing config name ${typeName}`);
	}
	function getDefaultConfig() {
		if (!defaultLoadBalancerType) throw new Error("No default load balancer type registered");
		return new registeredLoadBalancerTypes[defaultLoadBalancerType].LoadBalancingConfig();
	}
	function selectLbConfigFromList(configs, fallbackTodefault = false) {
		for (const config of configs) try {
			return parseLoadBalancingConfig(config);
		} catch (e) {
			(0, logging_1.log)(constants_1.LogVerbosity.DEBUG, "Config parsing failed with error", e.message);
			continue;
		}
		if (fallbackTodefault) if (defaultLoadBalancerType) return new registeredLoadBalancerTypes[defaultLoadBalancerType].LoadBalancingConfig();
		else return null;
		else return null;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/service-config.js
var require_service_config = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.validateRetryThrottling = validateRetryThrottling;
	exports.validateServiceConfig = validateServiceConfig;
	exports.extractAndSelectServiceConfig = extractAndSelectServiceConfig;
	const os$1 = __require("os");
	const constants_1 = require_constants();
	/**
	* Recognizes a number with up to 9 digits after the decimal point, followed by
	* an "s", representing a number of seconds.
	*/
	const DURATION_REGEX = /^\d+(\.\d{1,9})?s$/;
	/**
	* Client language name used for determining whether this client matches a
	* `ServiceConfigCanaryConfig`'s `clientLanguage` list.
	*/
	const CLIENT_LANGUAGE_STRING = "node";
	function validateName(obj) {
		if ("service" in obj && obj.service !== "") {
			if (typeof obj.service !== "string") throw new Error(`Invalid method config name: invalid service: expected type string, got ${typeof obj.service}`);
			if ("method" in obj && obj.method !== "") {
				if (typeof obj.method !== "string") throw new Error(`Invalid method config name: invalid method: expected type string, got ${typeof obj.service}`);
				return {
					service: obj.service,
					method: obj.method
				};
			} else return { service: obj.service };
		} else {
			if ("method" in obj && obj.method !== void 0) throw new Error(`Invalid method config name: method set with empty or unset service`);
			return {};
		}
	}
	function validateRetryPolicy(obj) {
		if (!("maxAttempts" in obj) || !Number.isInteger(obj.maxAttempts) || obj.maxAttempts < 2) throw new Error("Invalid method config retry policy: maxAttempts must be an integer at least 2");
		if (!("initialBackoff" in obj) || typeof obj.initialBackoff !== "string" || !DURATION_REGEX.test(obj.initialBackoff)) throw new Error("Invalid method config retry policy: initialBackoff must be a string consisting of a positive integer or decimal followed by s");
		if (!("maxBackoff" in obj) || typeof obj.maxBackoff !== "string" || !DURATION_REGEX.test(obj.maxBackoff)) throw new Error("Invalid method config retry policy: maxBackoff must be a string consisting of a positive integer or decimal followed by s");
		if (!("backoffMultiplier" in obj) || typeof obj.backoffMultiplier !== "number" || obj.backoffMultiplier <= 0) throw new Error("Invalid method config retry policy: backoffMultiplier must be a number greater than 0");
		if (!("retryableStatusCodes" in obj && Array.isArray(obj.retryableStatusCodes))) throw new Error("Invalid method config retry policy: retryableStatusCodes is required");
		if (obj.retryableStatusCodes.length === 0) throw new Error("Invalid method config retry policy: retryableStatusCodes must be non-empty");
		for (const value of obj.retryableStatusCodes) if (typeof value === "number") {
			if (!Object.values(constants_1.Status).includes(value)) throw new Error("Invalid method config retry policy: retryableStatusCodes value not in status code range");
		} else if (typeof value === "string") {
			if (!Object.values(constants_1.Status).includes(value.toUpperCase())) throw new Error("Invalid method config retry policy: retryableStatusCodes value not a status code name");
		} else throw new Error("Invalid method config retry policy: retryableStatusCodes value must be a string or number");
		return {
			maxAttempts: obj.maxAttempts,
			initialBackoff: obj.initialBackoff,
			maxBackoff: obj.maxBackoff,
			backoffMultiplier: obj.backoffMultiplier,
			retryableStatusCodes: obj.retryableStatusCodes
		};
	}
	function validateHedgingPolicy(obj) {
		if (!("maxAttempts" in obj) || !Number.isInteger(obj.maxAttempts) || obj.maxAttempts < 2) throw new Error("Invalid method config hedging policy: maxAttempts must be an integer at least 2");
		if ("hedgingDelay" in obj && (typeof obj.hedgingDelay !== "string" || !DURATION_REGEX.test(obj.hedgingDelay))) throw new Error("Invalid method config hedging policy: hedgingDelay must be a string consisting of a positive integer followed by s");
		if ("nonFatalStatusCodes" in obj && Array.isArray(obj.nonFatalStatusCodes)) for (const value of obj.nonFatalStatusCodes) if (typeof value === "number") {
			if (!Object.values(constants_1.Status).includes(value)) throw new Error("Invalid method config hedging policy: nonFatalStatusCodes value not in status code range");
		} else if (typeof value === "string") {
			if (!Object.values(constants_1.Status).includes(value.toUpperCase())) throw new Error("Invalid method config hedging policy: nonFatalStatusCodes value not a status code name");
		} else throw new Error("Invalid method config hedging policy: nonFatalStatusCodes value must be a string or number");
		const result = { maxAttempts: obj.maxAttempts };
		if (obj.hedgingDelay) result.hedgingDelay = obj.hedgingDelay;
		if (obj.nonFatalStatusCodes) result.nonFatalStatusCodes = obj.nonFatalStatusCodes;
		return result;
	}
	function validateMethodConfig(obj) {
		var _a;
		const result = { name: [] };
		if (!("name" in obj) || !Array.isArray(obj.name)) throw new Error("Invalid method config: invalid name array");
		for (const name of obj.name) result.name.push(validateName(name));
		if ("waitForReady" in obj) {
			if (typeof obj.waitForReady !== "boolean") throw new Error("Invalid method config: invalid waitForReady");
			result.waitForReady = obj.waitForReady;
		}
		if ("timeout" in obj) if (typeof obj.timeout === "object") {
			if (!("seconds" in obj.timeout) || !(typeof obj.timeout.seconds === "number")) throw new Error("Invalid method config: invalid timeout.seconds");
			if (!("nanos" in obj.timeout) || !(typeof obj.timeout.nanos === "number")) throw new Error("Invalid method config: invalid timeout.nanos");
			result.timeout = obj.timeout;
		} else if (typeof obj.timeout === "string" && DURATION_REGEX.test(obj.timeout)) {
			const timeoutParts = obj.timeout.substring(0, obj.timeout.length - 1).split(".");
			result.timeout = {
				seconds: timeoutParts[0] | 0,
				nanos: ((_a = timeoutParts[1]) !== null && _a !== void 0 ? _a : 0) | 0
			};
		} else throw new Error("Invalid method config: invalid timeout");
		if ("maxRequestBytes" in obj) {
			if (typeof obj.maxRequestBytes !== "number") throw new Error("Invalid method config: invalid maxRequestBytes");
			result.maxRequestBytes = obj.maxRequestBytes;
		}
		if ("maxResponseBytes" in obj) {
			if (typeof obj.maxResponseBytes !== "number") throw new Error("Invalid method config: invalid maxRequestBytes");
			result.maxResponseBytes = obj.maxResponseBytes;
		}
		if ("retryPolicy" in obj) if ("hedgingPolicy" in obj) throw new Error("Invalid method config: retryPolicy and hedgingPolicy cannot both be specified");
		else result.retryPolicy = validateRetryPolicy(obj.retryPolicy);
		else if ("hedgingPolicy" in obj) result.hedgingPolicy = validateHedgingPolicy(obj.hedgingPolicy);
		return result;
	}
	function validateRetryThrottling(obj) {
		if (!("maxTokens" in obj) || typeof obj.maxTokens !== "number" || obj.maxTokens <= 0 || obj.maxTokens > 1e3) throw new Error("Invalid retryThrottling: maxTokens must be a number in (0, 1000]");
		if (!("tokenRatio" in obj) || typeof obj.tokenRatio !== "number" || obj.tokenRatio <= 0) throw new Error("Invalid retryThrottling: tokenRatio must be a number greater than 0");
		return {
			maxTokens: +obj.maxTokens.toFixed(3),
			tokenRatio: +obj.tokenRatio.toFixed(3)
		};
	}
	function validateLoadBalancingConfig(obj) {
		if (!(typeof obj === "object" && obj !== null)) throw new Error(`Invalid loadBalancingConfig: unexpected type ${typeof obj}`);
		const keys = Object.keys(obj);
		if (keys.length > 1) throw new Error(`Invalid loadBalancingConfig: unexpected multiple keys ${keys}`);
		if (keys.length === 0) throw new Error("Invalid loadBalancingConfig: load balancing policy name required");
		return { [keys[0]]: obj[keys[0]] };
	}
	function validateServiceConfig(obj) {
		const result = {
			loadBalancingConfig: [],
			methodConfig: []
		};
		if ("loadBalancingPolicy" in obj) if (typeof obj.loadBalancingPolicy === "string") result.loadBalancingPolicy = obj.loadBalancingPolicy;
		else throw new Error("Invalid service config: invalid loadBalancingPolicy");
		if ("loadBalancingConfig" in obj) if (Array.isArray(obj.loadBalancingConfig)) for (const config of obj.loadBalancingConfig) result.loadBalancingConfig.push(validateLoadBalancingConfig(config));
		else throw new Error("Invalid service config: invalid loadBalancingConfig");
		if ("methodConfig" in obj) {
			if (Array.isArray(obj.methodConfig)) for (const methodConfig of obj.methodConfig) result.methodConfig.push(validateMethodConfig(methodConfig));
		}
		if ("retryThrottling" in obj) result.retryThrottling = validateRetryThrottling(obj.retryThrottling);
		const seenMethodNames = [];
		for (const methodConfig of result.methodConfig) for (const name of methodConfig.name) {
			for (const seenName of seenMethodNames) if (name.service === seenName.service && name.method === seenName.method) throw new Error(`Invalid service config: duplicate name ${name.service}/${name.method}`);
			seenMethodNames.push(name);
		}
		return result;
	}
	function validateCanaryConfig(obj) {
		if (!("serviceConfig" in obj)) throw new Error("Invalid service config choice: missing service config");
		const result = { serviceConfig: validateServiceConfig(obj.serviceConfig) };
		if ("clientLanguage" in obj) if (Array.isArray(obj.clientLanguage)) {
			result.clientLanguage = [];
			for (const lang of obj.clientLanguage) if (typeof lang === "string") result.clientLanguage.push(lang);
			else throw new Error("Invalid service config choice: invalid clientLanguage");
		} else throw new Error("Invalid service config choice: invalid clientLanguage");
		if ("clientHostname" in obj) if (Array.isArray(obj.clientHostname)) {
			result.clientHostname = [];
			for (const lang of obj.clientHostname) if (typeof lang === "string") result.clientHostname.push(lang);
			else throw new Error("Invalid service config choice: invalid clientHostname");
		} else throw new Error("Invalid service config choice: invalid clientHostname");
		if ("percentage" in obj) if (typeof obj.percentage === "number" && 0 <= obj.percentage && obj.percentage <= 100) result.percentage = obj.percentage;
		else throw new Error("Invalid service config choice: invalid percentage");
		const allowedFields = [
			"clientLanguage",
			"percentage",
			"clientHostname",
			"serviceConfig"
		];
		for (const field in obj) if (!allowedFields.includes(field)) throw new Error(`Invalid service config choice: unexpected field ${field}`);
		return result;
	}
	function validateAndSelectCanaryConfig(obj, percentage) {
		if (!Array.isArray(obj)) throw new Error("Invalid service config list");
		for (const config of obj) {
			const validatedConfig = validateCanaryConfig(config);
			if (typeof validatedConfig.percentage === "number" && percentage > validatedConfig.percentage) continue;
			if (Array.isArray(validatedConfig.clientHostname)) {
				let hostnameMatched = false;
				for (const hostname of validatedConfig.clientHostname) if (hostname === os$1.hostname()) hostnameMatched = true;
				if (!hostnameMatched) continue;
			}
			if (Array.isArray(validatedConfig.clientLanguage)) {
				let languageMatched = false;
				for (const language of validatedConfig.clientLanguage) if (language === CLIENT_LANGUAGE_STRING) languageMatched = true;
				if (!languageMatched) continue;
			}
			return validatedConfig.serviceConfig;
		}
		throw new Error("No matching service config found");
	}
	/**
	* Find the "grpc_config" record among the TXT records, parse its value as JSON, validate its contents,
	* and select a service config with selection fields that all match this client. Most of these steps
	* can fail with an error; the caller must handle any errors thrown this way.
	* @param txtRecord The TXT record array that is output from a successful call to dns.resolveTxt
	* @param percentage A number chosen from the range [0, 100) that is used to select which config to use
	* @return The service configuration to use, given the percentage value, or null if the service config
	*     data has a valid format but none of the options match the current client.
	*/
	function extractAndSelectServiceConfig(txtRecord, percentage) {
		for (const record of txtRecord) if (record.length > 0 && record[0].startsWith("grpc_config=")) {
			const recordString = record.join("").substring(12);
			return validateAndSelectCanaryConfig(JSON.parse(recordString), percentage);
		}
		return null;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/connectivity-state.js
var require_connectivity_state = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ConnectivityState = void 0;
	var ConnectivityState;
	(function(ConnectivityState) {
		ConnectivityState[ConnectivityState["IDLE"] = 0] = "IDLE";
		ConnectivityState[ConnectivityState["CONNECTING"] = 1] = "CONNECTING";
		ConnectivityState[ConnectivityState["READY"] = 2] = "READY";
		ConnectivityState[ConnectivityState["TRANSIENT_FAILURE"] = 3] = "TRANSIENT_FAILURE";
		ConnectivityState[ConnectivityState["SHUTDOWN"] = 4] = "SHUTDOWN";
	})(ConnectivityState || (exports.ConnectivityState = ConnectivityState = {}));
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/picker.js
var require_picker = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.QueuePicker = exports.UnavailablePicker = exports.PickResultType = void 0;
	const metadata_1 = require_metadata();
	const constants_1 = require_constants();
	var PickResultType;
	(function(PickResultType) {
		PickResultType[PickResultType["COMPLETE"] = 0] = "COMPLETE";
		PickResultType[PickResultType["QUEUE"] = 1] = "QUEUE";
		PickResultType[PickResultType["TRANSIENT_FAILURE"] = 2] = "TRANSIENT_FAILURE";
		PickResultType[PickResultType["DROP"] = 3] = "DROP";
	})(PickResultType || (exports.PickResultType = PickResultType = {}));
	/**
	* A standard picker representing a load balancer in the TRANSIENT_FAILURE
	* state. Always responds to every pick request with an UNAVAILABLE status.
	*/
	var UnavailablePicker = class {
		constructor(status) {
			this.status = Object.assign({
				code: constants_1.Status.UNAVAILABLE,
				details: "No connection established",
				metadata: new metadata_1.Metadata()
			}, status);
		}
		pick(pickArgs) {
			return {
				pickResultType: PickResultType.TRANSIENT_FAILURE,
				subchannel: null,
				status: this.status,
				onCallStarted: null,
				onCallEnded: null
			};
		}
	};
	exports.UnavailablePicker = UnavailablePicker;
	/**
	* A standard picker representing a load balancer in the IDLE or CONNECTING
	* state. Always responds to every pick request with a QUEUE pick result
	* indicating that the pick should be tried again with the next `Picker`. Also
	* reports back to the load balancer that a connection should be established
	* once any pick is attempted.
	* If the childPicker is provided, delegate to it instead of returning the
	* hardcoded QUEUE pick result, but still calls exitIdle.
	*/
	var QueuePicker = class {
		constructor(loadBalancer, childPicker) {
			this.loadBalancer = loadBalancer;
			this.childPicker = childPicker;
			this.calledExitIdle = false;
		}
		pick(pickArgs) {
			if (!this.calledExitIdle) {
				process.nextTick(() => {
					this.loadBalancer.exitIdle();
				});
				this.calledExitIdle = true;
			}
			if (this.childPicker) return this.childPicker.pick(pickArgs);
			else return {
				pickResultType: PickResultType.QUEUE,
				subchannel: null,
				status: null,
				onCallStarted: null,
				onCallEnded: null
			};
		}
	};
	exports.QueuePicker = QueuePicker;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/backoff-timeout.js
var require_backoff_timeout = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.BackoffTimeout = void 0;
	const constants_1 = require_constants();
	const logging = require_logging();
	const TRACER_NAME = "backoff";
	const INITIAL_BACKOFF_MS = 1e3;
	const BACKOFF_MULTIPLIER = 1.6;
	const MAX_BACKOFF_MS = 12e4;
	const BACKOFF_JITTER = .2;
	/**
	* Get a number uniformly at random in the range [min, max)
	* @param min
	* @param max
	*/
	function uniformRandom(min, max) {
		return Math.random() * (max - min) + min;
	}
	var BackoffTimeout = class BackoffTimeout {
		constructor(callback, options) {
			this.callback = callback;
			/**
			* The delay time at the start, and after each reset.
			*/
			this.initialDelay = INITIAL_BACKOFF_MS;
			/**
			* The exponential backoff multiplier.
			*/
			this.multiplier = BACKOFF_MULTIPLIER;
			/**
			* The maximum delay time
			*/
			this.maxDelay = MAX_BACKOFF_MS;
			/**
			* The maximum fraction by which the delay time can randomly vary after
			* applying the multiplier.
			*/
			this.jitter = BACKOFF_JITTER;
			/**
			* Indicates whether the timer is currently running.
			*/
			this.running = false;
			/**
			* Indicates whether the timer should keep the Node process running if no
			* other async operation is doing so.
			*/
			this.hasRef = true;
			/**
			* The time that the currently running timer was started. Only valid if
			* running is true.
			*/
			this.startTime = /* @__PURE__ */ new Date();
			/**
			* The approximate time that the currently running timer will end. Only valid
			* if running is true.
			*/
			this.endTime = /* @__PURE__ */ new Date();
			this.id = BackoffTimeout.getNextId();
			if (options) {
				if (options.initialDelay) this.initialDelay = options.initialDelay;
				if (options.multiplier) this.multiplier = options.multiplier;
				if (options.jitter) this.jitter = options.jitter;
				if (options.maxDelay) this.maxDelay = options.maxDelay;
			}
			this.trace("constructed initialDelay=" + this.initialDelay + " multiplier=" + this.multiplier + " jitter=" + this.jitter + " maxDelay=" + this.maxDelay);
			this.nextDelay = this.initialDelay;
			this.timerId = setTimeout(() => {}, 0);
			clearTimeout(this.timerId);
		}
		static getNextId() {
			return this.nextId++;
		}
		trace(text) {
			logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, "{" + this.id + "} " + text);
		}
		runTimer(delay) {
			var _a, _b;
			this.trace("runTimer(delay=" + delay + ")");
			this.endTime = this.startTime;
			this.endTime.setMilliseconds(this.endTime.getMilliseconds() + delay);
			clearTimeout(this.timerId);
			this.timerId = setTimeout(() => {
				this.trace("timer fired");
				this.running = false;
				this.callback();
			}, delay);
			if (!this.hasRef) (_b = (_a = this.timerId).unref) === null || _b === void 0 || _b.call(_a);
		}
		/**
		* Call the callback after the current amount of delay time
		*/
		runOnce() {
			this.trace("runOnce()");
			this.running = true;
			this.startTime = /* @__PURE__ */ new Date();
			this.runTimer(this.nextDelay);
			const nextBackoff = Math.min(this.nextDelay * this.multiplier, this.maxDelay);
			const jitterMagnitude = nextBackoff * this.jitter;
			this.nextDelay = nextBackoff + uniformRandom(-jitterMagnitude, jitterMagnitude);
		}
		/**
		* Stop the timer. The callback will not be called until `runOnce` is called
		* again.
		*/
		stop() {
			this.trace("stop()");
			clearTimeout(this.timerId);
			this.running = false;
		}
		/**
		* Reset the delay time to its initial value. If the timer is still running,
		* retroactively apply that reset to the current timer.
		*/
		reset() {
			this.trace("reset() running=" + this.running);
			this.nextDelay = this.initialDelay;
			if (this.running) {
				const now = /* @__PURE__ */ new Date();
				const newEndTime = this.startTime;
				newEndTime.setMilliseconds(newEndTime.getMilliseconds() + this.nextDelay);
				clearTimeout(this.timerId);
				if (now < newEndTime) this.runTimer(newEndTime.getTime() - now.getTime());
				else this.running = false;
			}
		}
		/**
		* Check whether the timer is currently running.
		*/
		isRunning() {
			return this.running;
		}
		/**
		* Set that while the timer is running, it should keep the Node process
		* running.
		*/
		ref() {
			var _a, _b;
			this.hasRef = true;
			(_b = (_a = this.timerId).ref) === null || _b === void 0 || _b.call(_a);
		}
		/**
		* Set that while the timer is running, it should not keep the Node process
		* running.
		*/
		unref() {
			var _a, _b;
			this.hasRef = false;
			(_b = (_a = this.timerId).unref) === null || _b === void 0 || _b.call(_a);
		}
		/**
		* Get the approximate timestamp of when the timer will fire. Only valid if
		* this.isRunning() is true.
		*/
		getEndTime() {
			return this.endTime;
		}
	};
	exports.BackoffTimeout = BackoffTimeout;
	BackoffTimeout.nextId = 0;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/load-balancer-child-handler.js
var require_load_balancer_child_handler = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ChildLoadBalancerHandler = void 0;
	const load_balancer_1 = require_load_balancer();
	const connectivity_state_1 = require_connectivity_state();
	const TYPE_NAME = "child_load_balancer_helper";
	var ChildLoadBalancerHandler = class {
		constructor(channelControlHelper) {
			this.channelControlHelper = channelControlHelper;
			this.currentChild = null;
			this.pendingChild = null;
			this.latestConfig = null;
			this.ChildPolicyHelper = class {
				constructor(parent) {
					this.parent = parent;
					this.child = null;
				}
				createSubchannel(subchannelAddress, subchannelArgs) {
					return this.parent.channelControlHelper.createSubchannel(subchannelAddress, subchannelArgs);
				}
				updateState(connectivityState, picker, errorMessage) {
					var _a;
					if (this.calledByPendingChild()) {
						if (connectivityState === connectivity_state_1.ConnectivityState.CONNECTING) return;
						(_a = this.parent.currentChild) === null || _a === void 0 || _a.destroy();
						this.parent.currentChild = this.parent.pendingChild;
						this.parent.pendingChild = null;
					} else if (!this.calledByCurrentChild()) return;
					this.parent.channelControlHelper.updateState(connectivityState, picker, errorMessage);
				}
				requestReresolution() {
					var _a;
					const latestChild = (_a = this.parent.pendingChild) !== null && _a !== void 0 ? _a : this.parent.currentChild;
					if (this.child === latestChild) this.parent.channelControlHelper.requestReresolution();
				}
				setChild(newChild) {
					this.child = newChild;
				}
				addChannelzChild(child) {
					this.parent.channelControlHelper.addChannelzChild(child);
				}
				removeChannelzChild(child) {
					this.parent.channelControlHelper.removeChannelzChild(child);
				}
				calledByPendingChild() {
					return this.child === this.parent.pendingChild;
				}
				calledByCurrentChild() {
					return this.child === this.parent.currentChild;
				}
			};
		}
		configUpdateRequiresNewPolicyInstance(oldConfig, newConfig) {
			return oldConfig.getLoadBalancerName() !== newConfig.getLoadBalancerName();
		}
		/**
		* Prerequisites: lbConfig !== null and lbConfig.name is registered
		* @param endpointList
		* @param lbConfig
		* @param attributes
		*/
		updateAddressList(endpointList, lbConfig, options, resolutionNote) {
			let childToUpdate;
			if (this.currentChild === null || this.latestConfig === null || this.configUpdateRequiresNewPolicyInstance(this.latestConfig, lbConfig)) {
				const newHelper = new this.ChildPolicyHelper(this);
				const newChild = (0, load_balancer_1.createLoadBalancer)(lbConfig, newHelper);
				newHelper.setChild(newChild);
				if (this.currentChild === null) {
					this.currentChild = newChild;
					childToUpdate = this.currentChild;
				} else {
					if (this.pendingChild) this.pendingChild.destroy();
					this.pendingChild = newChild;
					childToUpdate = this.pendingChild;
				}
			} else if (this.pendingChild === null) childToUpdate = this.currentChild;
			else childToUpdate = this.pendingChild;
			this.latestConfig = lbConfig;
			return childToUpdate.updateAddressList(endpointList, lbConfig, options, resolutionNote);
		}
		exitIdle() {
			if (this.currentChild) {
				this.currentChild.exitIdle();
				if (this.pendingChild) this.pendingChild.exitIdle();
			}
		}
		resetBackoff() {
			if (this.currentChild) {
				this.currentChild.resetBackoff();
				if (this.pendingChild) this.pendingChild.resetBackoff();
			}
		}
		destroy() {
			if (this.currentChild) {
				this.currentChild.destroy();
				this.currentChild = null;
			}
			if (this.pendingChild) {
				this.pendingChild.destroy();
				this.pendingChild = null;
			}
		}
		getTypeName() {
			return TYPE_NAME;
		}
	};
	exports.ChildLoadBalancerHandler = ChildLoadBalancerHandler;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/resolving-load-balancer.js
var require_resolving_load_balancer = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ResolvingLoadBalancer = void 0;
	const load_balancer_1 = require_load_balancer();
	const service_config_1 = require_service_config();
	const connectivity_state_1 = require_connectivity_state();
	const resolver_1 = require_resolver();
	const picker_1 = require_picker();
	const backoff_timeout_1 = require_backoff_timeout();
	const constants_1 = require_constants();
	const metadata_1 = require_metadata();
	const logging = require_logging();
	const constants_2 = require_constants();
	const uri_parser_1 = require_uri_parser();
	const load_balancer_child_handler_1 = require_load_balancer_child_handler();
	const TRACER_NAME = "resolving_load_balancer";
	function trace(text) {
		logging.trace(constants_2.LogVerbosity.DEBUG, TRACER_NAME, text);
	}
	/**
	* Name match levels in order from most to least specific. This is the order in
	* which searches will be performed.
	*/
	const NAME_MATCH_LEVEL_ORDER = [
		"SERVICE_AND_METHOD",
		"SERVICE",
		"EMPTY"
	];
	function hasMatchingName(service, method, methodConfig, matchLevel) {
		for (const name of methodConfig.name) switch (matchLevel) {
			case "EMPTY":
				if (!name.service && !name.method) return true;
				break;
			case "SERVICE":
				if (name.service === service && !name.method) return true;
				break;
			case "SERVICE_AND_METHOD": if (name.service === service && name.method === method) return true;
		}
		return false;
	}
	function findMatchingConfig(service, method, methodConfigs, matchLevel) {
		for (const config of methodConfigs) if (hasMatchingName(service, method, config, matchLevel)) return config;
		return null;
	}
	function getDefaultConfigSelector(serviceConfig) {
		return {
			invoke(methodName, metadata) {
				var _a, _b;
				const splitName = methodName.split("/").filter((x) => x.length > 0);
				const service = (_a = splitName[0]) !== null && _a !== void 0 ? _a : "";
				const method = (_b = splitName[1]) !== null && _b !== void 0 ? _b : "";
				if (serviceConfig && serviceConfig.methodConfig) for (const matchLevel of NAME_MATCH_LEVEL_ORDER) {
					const matchingConfig = findMatchingConfig(service, method, serviceConfig.methodConfig, matchLevel);
					if (matchingConfig) return {
						methodConfig: matchingConfig,
						pickInformation: {},
						status: constants_1.Status.OK,
						dynamicFilterFactories: []
					};
				}
				return {
					methodConfig: { name: [] },
					pickInformation: {},
					status: constants_1.Status.OK,
					dynamicFilterFactories: []
				};
			},
			unref() {}
		};
	}
	var ResolvingLoadBalancer = class {
		/**
		* Wrapper class that behaves like a `LoadBalancer` and also handles name
		* resolution internally.
		* @param target The address of the backend to connect to.
		* @param channelControlHelper `ChannelControlHelper` instance provided by
		*     this load balancer's owner.
		* @param defaultServiceConfig The default service configuration to be used
		*     if none is provided by the name resolver. A `null` value indicates
		*     that the default behavior should be the default unconfigured behavior.
		*     In practice, that means using the "pick first" load balancer
		*     implmentation
		*/
		constructor(target, channelControlHelper, channelOptions, onSuccessfulResolution, onFailedResolution) {
			this.target = target;
			this.channelControlHelper = channelControlHelper;
			this.channelOptions = channelOptions;
			this.onSuccessfulResolution = onSuccessfulResolution;
			this.onFailedResolution = onFailedResolution;
			this.latestChildState = connectivity_state_1.ConnectivityState.IDLE;
			this.latestChildPicker = new picker_1.QueuePicker(this);
			this.latestChildErrorMessage = null;
			/**
			* This resolving load balancer's current connectivity state.
			*/
			this.currentState = connectivity_state_1.ConnectivityState.IDLE;
			/**
			* The service config object from the last successful resolution, if
			* available. A value of null indicates that we have not yet received a valid
			* service config from the resolver.
			*/
			this.previousServiceConfig = null;
			/**
			* Indicates whether we should attempt to resolve again after the backoff
			* timer runs out.
			*/
			this.continueResolving = false;
			if (channelOptions["grpc.service_config"]) this.defaultServiceConfig = (0, service_config_1.validateServiceConfig)(JSON.parse(channelOptions["grpc.service_config"]));
			else this.defaultServiceConfig = {
				loadBalancingConfig: [],
				methodConfig: []
			};
			this.updateState(connectivity_state_1.ConnectivityState.IDLE, new picker_1.QueuePicker(this), null);
			this.childLoadBalancer = new load_balancer_child_handler_1.ChildLoadBalancerHandler({
				createSubchannel: channelControlHelper.createSubchannel.bind(channelControlHelper),
				requestReresolution: () => {
					if (this.backoffTimeout.isRunning()) {
						trace("requestReresolution delayed by backoff timer until " + this.backoffTimeout.getEndTime().toISOString());
						this.continueResolving = true;
					} else this.updateResolution();
				},
				updateState: (newState, picker, errorMessage) => {
					this.latestChildState = newState;
					this.latestChildPicker = picker;
					this.latestChildErrorMessage = errorMessage;
					this.updateState(newState, picker, errorMessage);
				},
				addChannelzChild: channelControlHelper.addChannelzChild.bind(channelControlHelper),
				removeChannelzChild: channelControlHelper.removeChannelzChild.bind(channelControlHelper)
			});
			this.innerResolver = (0, resolver_1.createResolver)(target, this.handleResolverResult.bind(this), channelOptions);
			const backoffOptions = {
				initialDelay: channelOptions["grpc.initial_reconnect_backoff_ms"],
				maxDelay: channelOptions["grpc.max_reconnect_backoff_ms"]
			};
			this.backoffTimeout = new backoff_timeout_1.BackoffTimeout(() => {
				if (this.continueResolving) {
					this.updateResolution();
					this.continueResolving = false;
				} else this.updateState(this.latestChildState, this.latestChildPicker, this.latestChildErrorMessage);
			}, backoffOptions);
			this.backoffTimeout.unref();
		}
		handleResolverResult(endpointList, attributes, serviceConfig, resolutionNote) {
			var _a, _b;
			this.backoffTimeout.stop();
			this.backoffTimeout.reset();
			let resultAccepted = true;
			let workingServiceConfig = null;
			if (serviceConfig === null) workingServiceConfig = this.defaultServiceConfig;
			else if (serviceConfig.ok) workingServiceConfig = serviceConfig.value;
			else if (this.previousServiceConfig !== null) workingServiceConfig = this.previousServiceConfig;
			else {
				resultAccepted = false;
				this.handleResolutionFailure(serviceConfig.error);
			}
			if (workingServiceConfig !== null) {
				const workingConfigList = (_a = workingServiceConfig === null || workingServiceConfig === void 0 ? void 0 : workingServiceConfig.loadBalancingConfig) !== null && _a !== void 0 ? _a : [];
				const loadBalancingConfig = (0, load_balancer_1.selectLbConfigFromList)(workingConfigList, true);
				if (loadBalancingConfig === null) {
					resultAccepted = false;
					this.handleResolutionFailure({
						code: constants_1.Status.UNAVAILABLE,
						details: "All load balancer options in service config are not compatible",
						metadata: new metadata_1.Metadata()
					});
				} else resultAccepted = this.childLoadBalancer.updateAddressList(endpointList, loadBalancingConfig, Object.assign(Object.assign({}, this.channelOptions), attributes), resolutionNote);
			}
			if (resultAccepted) this.onSuccessfulResolution(workingServiceConfig, (_b = attributes[resolver_1.CHANNEL_ARGS_CONFIG_SELECTOR_KEY]) !== null && _b !== void 0 ? _b : getDefaultConfigSelector(workingServiceConfig));
			return resultAccepted;
		}
		updateResolution() {
			this.innerResolver.updateResolution();
			if (this.currentState === connectivity_state_1.ConnectivityState.IDLE) this.updateState(connectivity_state_1.ConnectivityState.CONNECTING, this.latestChildPicker, this.latestChildErrorMessage);
			this.backoffTimeout.runOnce();
		}
		updateState(connectivityState, picker, errorMessage) {
			trace((0, uri_parser_1.uriToString)(this.target) + " " + connectivity_state_1.ConnectivityState[this.currentState] + " -> " + connectivity_state_1.ConnectivityState[connectivityState]);
			if (connectivityState === connectivity_state_1.ConnectivityState.IDLE) picker = new picker_1.QueuePicker(this, picker);
			this.currentState = connectivityState;
			this.channelControlHelper.updateState(connectivityState, picker, errorMessage);
		}
		handleResolutionFailure(error) {
			if (this.latestChildState === connectivity_state_1.ConnectivityState.IDLE) {
				this.updateState(connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE, new picker_1.UnavailablePicker(error), error.details);
				this.onFailedResolution(error);
			}
		}
		exitIdle() {
			if (this.currentState === connectivity_state_1.ConnectivityState.IDLE || this.currentState === connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE) if (this.backoffTimeout.isRunning()) this.continueResolving = true;
			else this.updateResolution();
			this.childLoadBalancer.exitIdle();
		}
		updateAddressList(endpointList, lbConfig) {
			throw new Error("updateAddressList not supported on ResolvingLoadBalancer");
		}
		resetBackoff() {
			this.backoffTimeout.reset();
			this.childLoadBalancer.resetBackoff();
		}
		destroy() {
			this.childLoadBalancer.destroy();
			this.innerResolver.destroy();
			this.backoffTimeout.reset();
			this.backoffTimeout.stop();
			this.latestChildState = connectivity_state_1.ConnectivityState.IDLE;
			this.latestChildPicker = new picker_1.QueuePicker(this);
			this.currentState = connectivity_state_1.ConnectivityState.IDLE;
			this.previousServiceConfig = null;
			this.continueResolving = false;
		}
		getTypeName() {
			return "resolving_load_balancer";
		}
	};
	exports.ResolvingLoadBalancer = ResolvingLoadBalancer;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/channel-options.js
var require_channel_options = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.recognizedOptions = void 0;
	exports.channelOptionsEqual = channelOptionsEqual;
	/**
	* This is for checking provided options at runtime. This is an object for
	* easier membership checking.
	*/
	exports.recognizedOptions = {
		"grpc.ssl_target_name_override": true,
		"grpc.primary_user_agent": true,
		"grpc.secondary_user_agent": true,
		"grpc.default_authority": true,
		"grpc.keepalive_time_ms": true,
		"grpc.keepalive_timeout_ms": true,
		"grpc.keepalive_permit_without_calls": true,
		"grpc.service_config": true,
		"grpc.max_concurrent_streams": true,
		"grpc.initial_reconnect_backoff_ms": true,
		"grpc.max_reconnect_backoff_ms": true,
		"grpc.use_local_subchannel_pool": true,
		"grpc.max_send_message_length": true,
		"grpc.max_receive_message_length": true,
		"grpc.enable_http_proxy": true,
		"grpc.enable_channelz": true,
		"grpc.dns_min_time_between_resolutions_ms": true,
		"grpc.enable_retries": true,
		"grpc.per_rpc_retry_buffer_size": true,
		"grpc.retry_buffer_size": true,
		"grpc.max_connection_age_ms": true,
		"grpc.max_connection_age_grace_ms": true,
		"grpc-node.max_session_memory": true,
		"grpc.service_config_disable_resolution": true,
		"grpc.client_idle_timeout_ms": true,
		"grpc-node.tls_enable_trace": true,
		"grpc.lb.ring_hash.ring_size_cap": true,
		"grpc-node.retry_max_attempts_limit": true,
		"grpc-node.flow_control_window": true,
		"grpc.server_call_metric_recording": true
	};
	function channelOptionsEqual(options1, options2) {
		const keys1 = Object.keys(options1).sort();
		const keys2 = Object.keys(options2).sort();
		if (keys1.length !== keys2.length) return false;
		for (let i = 0; i < keys1.length; i += 1) {
			if (keys1[i] !== keys2[i]) return false;
			if (options1[keys1[i]] !== options2[keys2[i]]) return false;
		}
		return true;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/subchannel-address.js
var require_subchannel_address = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.EndpointMap = void 0;
	exports.isTcpSubchannelAddress = isTcpSubchannelAddress;
	exports.subchannelAddressEqual = subchannelAddressEqual;
	exports.subchannelAddressToString = subchannelAddressToString;
	exports.stringToSubchannelAddress = stringToSubchannelAddress;
	exports.endpointEqual = endpointEqual;
	exports.endpointToString = endpointToString;
	exports.endpointHasAddress = endpointHasAddress;
	const net_1$5 = __require("net");
	function isTcpSubchannelAddress(address) {
		return "port" in address;
	}
	function subchannelAddressEqual(address1, address2) {
		if (!address1 && !address2) return true;
		if (!address1 || !address2) return false;
		if (isTcpSubchannelAddress(address1)) return isTcpSubchannelAddress(address2) && address1.host === address2.host && address1.port === address2.port;
		else return !isTcpSubchannelAddress(address2) && address1.path === address2.path;
	}
	function subchannelAddressToString(address) {
		if (isTcpSubchannelAddress(address)) if ((0, net_1$5.isIPv6)(address.host)) return "[" + address.host + "]:" + address.port;
		else return address.host + ":" + address.port;
		else return address.path;
	}
	const DEFAULT_PORT = 443;
	function stringToSubchannelAddress(addressString, port) {
		if ((0, net_1$5.isIP)(addressString)) return {
			host: addressString,
			port: port !== null && port !== void 0 ? port : DEFAULT_PORT
		};
		else return { path: addressString };
	}
	function endpointEqual(endpoint1, endpoint2) {
		if (endpoint1.addresses.length !== endpoint2.addresses.length) return false;
		for (let i = 0; i < endpoint1.addresses.length; i++) if (!subchannelAddressEqual(endpoint1.addresses[i], endpoint2.addresses[i])) return false;
		return true;
	}
	function endpointToString(endpoint) {
		return "[" + endpoint.addresses.map(subchannelAddressToString).join(", ") + "]";
	}
	function endpointHasAddress(endpoint, expectedAddress) {
		for (const address of endpoint.addresses) if (subchannelAddressEqual(address, expectedAddress)) return true;
		return false;
	}
	function endpointEqualUnordered(endpoint1, endpoint2) {
		if (endpoint1.addresses.length !== endpoint2.addresses.length) return false;
		for (const address1 of endpoint1.addresses) {
			let matchFound = false;
			for (const address2 of endpoint2.addresses) if (subchannelAddressEqual(address1, address2)) {
				matchFound = true;
				break;
			}
			if (!matchFound) return false;
		}
		return true;
	}
	var EndpointMap = class {
		constructor() {
			this.map = /* @__PURE__ */ new Set();
		}
		get size() {
			return this.map.size;
		}
		getForSubchannelAddress(address) {
			for (const entry of this.map) if (endpointHasAddress(entry.key, address)) return entry.value;
		}
		/**
		* Delete any entries in this map with keys that are not in endpoints
		* @param endpoints
		*/
		deleteMissing(endpoints) {
			const removedValues = [];
			for (const entry of this.map) {
				let foundEntry = false;
				for (const endpoint of endpoints) if (endpointEqualUnordered(endpoint, entry.key)) foundEntry = true;
				if (!foundEntry) {
					removedValues.push(entry.value);
					this.map.delete(entry);
				}
			}
			return removedValues;
		}
		get(endpoint) {
			for (const entry of this.map) if (endpointEqualUnordered(endpoint, entry.key)) return entry.value;
		}
		set(endpoint, mapEntry) {
			for (const entry of this.map) if (endpointEqualUnordered(endpoint, entry.key)) {
				entry.value = mapEntry;
				return;
			}
			this.map.add({
				key: endpoint,
				value: mapEntry
			});
		}
		delete(endpoint) {
			for (const entry of this.map) if (endpointEqualUnordered(endpoint, entry.key)) {
				this.map.delete(entry);
				return;
			}
		}
		has(endpoint) {
			for (const entry of this.map) if (endpointEqualUnordered(endpoint, entry.key)) return true;
			return false;
		}
		clear() {
			this.map.clear();
		}
		*keys() {
			for (const entry of this.map) yield entry.key;
		}
		*values() {
			for (const entry of this.map) yield entry.value;
		}
		*entries() {
			for (const entry of this.map) yield [entry.key, entry.value];
		}
	};
	exports.EndpointMap = EndpointMap;
}));
//#endregion
//#region ../../node_modules/.pnpm/@js-sdsl+ordered-map@4.4.2/node_modules/@js-sdsl/ordered-map/dist/cjs/index.js
var require_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "t", { value: true });
	var TreeNode = class {
		constructor(t, e, s = 1) {
			this.i = void 0;
			this.h = void 0;
			this.o = void 0;
			this.u = t;
			this.l = e;
			this.p = s;
		}
		I() {
			let t = this;
			const e = t.o.o === t;
			if (e && t.p === 1) t = t.h;
			else if (t.i) {
				t = t.i;
				while (t.h) t = t.h;
			} else {
				if (e) return t.o;
				let s = t.o;
				while (s.i === t) {
					t = s;
					s = t.o;
				}
				t = s;
			}
			return t;
		}
		B() {
			let t = this;
			if (t.h) {
				t = t.h;
				while (t.i) t = t.i;
				return t;
			} else {
				let e = t.o;
				while (e.h === t) {
					t = e;
					e = t.o;
				}
				if (t.h !== e) return e;
				else return t;
			}
		}
		_() {
			const t = this.o;
			const e = this.h;
			const s = e.i;
			if (t.o === this) t.o = e;
			else if (t.i === this) t.i = e;
			else t.h = e;
			e.o = t;
			e.i = this;
			this.o = e;
			this.h = s;
			if (s) s.o = this;
			return e;
		}
		g() {
			const t = this.o;
			const e = this.i;
			const s = e.h;
			if (t.o === this) t.o = e;
			else if (t.i === this) t.i = e;
			else t.h = e;
			e.o = t;
			e.h = this;
			this.o = e;
			this.i = s;
			if (s) s.o = this;
			return e;
		}
	};
	var TreeNodeEnableIndex = class extends TreeNode {
		constructor() {
			super(...arguments);
			this.M = 1;
		}
		_() {
			const t = super._();
			this.O();
			t.O();
			return t;
		}
		g() {
			const t = super.g();
			this.O();
			t.O();
			return t;
		}
		O() {
			this.M = 1;
			if (this.i) this.M += this.i.M;
			if (this.h) this.M += this.h.M;
		}
	};
	var ContainerIterator = class {
		constructor(t = 0) {
			this.iteratorType = t;
		}
		equals(t) {
			return this.T === t.T;
		}
	};
	var Base = class {
		constructor() {
			this.m = 0;
		}
		get length() {
			return this.m;
		}
		size() {
			return this.m;
		}
		empty() {
			return this.m === 0;
		}
	};
	var Container = class extends Base {};
	function throwIteratorAccessError() {
		throw new RangeError("Iterator access denied!");
	}
	var TreeContainer = class extends Container {
		constructor(t = function(t, e) {
			if (t < e) return -1;
			if (t > e) return 1;
			return 0;
		}, e = false) {
			super();
			this.v = void 0;
			this.A = t;
			this.enableIndex = e;
			this.N = e ? TreeNodeEnableIndex : TreeNode;
			this.C = new this.N();
		}
		R(t, e) {
			let s = this.C;
			while (t) {
				const i = this.A(t.u, e);
				if (i < 0) t = t.h;
				else if (i > 0) {
					s = t;
					t = t.i;
				} else return t;
			}
			return s;
		}
		K(t, e) {
			let s = this.C;
			while (t) if (this.A(t.u, e) <= 0) t = t.h;
			else {
				s = t;
				t = t.i;
			}
			return s;
		}
		L(t, e) {
			let s = this.C;
			while (t) {
				const i = this.A(t.u, e);
				if (i < 0) {
					s = t;
					t = t.h;
				} else if (i > 0) t = t.i;
				else return t;
			}
			return s;
		}
		k(t, e) {
			let s = this.C;
			while (t) if (this.A(t.u, e) < 0) {
				s = t;
				t = t.h;
			} else t = t.i;
			return s;
		}
		P(t) {
			while (true) {
				const e = t.o;
				if (e === this.C) return;
				if (t.p === 1) {
					t.p = 0;
					return;
				}
				if (t === e.i) {
					const s = e.h;
					if (s.p === 1) {
						s.p = 0;
						e.p = 1;
						if (e === this.v) this.v = e._();
						else e._();
					} else if (s.h && s.h.p === 1) {
						s.p = e.p;
						e.p = 0;
						s.h.p = 0;
						if (e === this.v) this.v = e._();
						else e._();
						return;
					} else if (s.i && s.i.p === 1) {
						s.p = 1;
						s.i.p = 0;
						s.g();
					} else {
						s.p = 1;
						t = e;
					}
				} else {
					const s = e.i;
					if (s.p === 1) {
						s.p = 0;
						e.p = 1;
						if (e === this.v) this.v = e.g();
						else e.g();
					} else if (s.i && s.i.p === 1) {
						s.p = e.p;
						e.p = 0;
						s.i.p = 0;
						if (e === this.v) this.v = e.g();
						else e.g();
						return;
					} else if (s.h && s.h.p === 1) {
						s.p = 1;
						s.h.p = 0;
						s._();
					} else {
						s.p = 1;
						t = e;
					}
				}
			}
		}
		S(t) {
			if (this.m === 1) {
				this.clear();
				return;
			}
			let e = t;
			while (e.i || e.h) {
				if (e.h) {
					e = e.h;
					while (e.i) e = e.i;
				} else e = e.i;
				const s = t.u;
				t.u = e.u;
				e.u = s;
				const i = t.l;
				t.l = e.l;
				e.l = i;
				t = e;
			}
			if (this.C.i === e) this.C.i = e.o;
			else if (this.C.h === e) this.C.h = e.o;
			this.P(e);
			let s = e.o;
			if (e === s.i) s.i = void 0;
			else s.h = void 0;
			this.m -= 1;
			this.v.p = 0;
			if (this.enableIndex) while (s !== this.C) {
				s.M -= 1;
				s = s.o;
			}
		}
		U(t) {
			const e = typeof t === "number" ? t : void 0;
			const s = typeof t === "function" ? t : void 0;
			const i = typeof t === "undefined" ? [] : void 0;
			let r = 0;
			let n = this.v;
			const h = [];
			while (h.length || n) if (n) {
				h.push(n);
				n = n.i;
			} else {
				n = h.pop();
				if (r === e) return n;
				i && i.push(n);
				s && s(n, r, this);
				r += 1;
				n = n.h;
			}
			return i;
		}
		j(t) {
			while (true) {
				const e = t.o;
				if (e.p === 0) return;
				const s = e.o;
				if (e === s.i) {
					const i = s.h;
					if (i && i.p === 1) {
						i.p = e.p = 0;
						if (s === this.v) return;
						s.p = 1;
						t = s;
						continue;
					} else if (t === e.h) {
						t.p = 0;
						if (t.i) t.i.o = e;
						if (t.h) t.h.o = s;
						e.h = t.i;
						s.i = t.h;
						t.i = e;
						t.h = s;
						if (s === this.v) {
							this.v = t;
							this.C.o = t;
						} else {
							const e = s.o;
							if (e.i === s) e.i = t;
							else e.h = t;
						}
						t.o = s.o;
						e.o = t;
						s.o = t;
						s.p = 1;
					} else {
						e.p = 0;
						if (s === this.v) this.v = s.g();
						else s.g();
						s.p = 1;
						return;
					}
				} else {
					const i = s.i;
					if (i && i.p === 1) {
						i.p = e.p = 0;
						if (s === this.v) return;
						s.p = 1;
						t = s;
						continue;
					} else if (t === e.i) {
						t.p = 0;
						if (t.i) t.i.o = s;
						if (t.h) t.h.o = e;
						s.h = t.i;
						e.i = t.h;
						t.i = s;
						t.h = e;
						if (s === this.v) {
							this.v = t;
							this.C.o = t;
						} else {
							const e = s.o;
							if (e.i === s) e.i = t;
							else e.h = t;
						}
						t.o = s.o;
						e.o = t;
						s.o = t;
						s.p = 1;
					} else {
						e.p = 0;
						if (s === this.v) this.v = s._();
						else s._();
						s.p = 1;
						return;
					}
				}
				if (this.enableIndex) {
					e.O();
					s.O();
					t.O();
				}
				return;
			}
		}
		q(t, e, s) {
			if (this.v === void 0) {
				this.m += 1;
				this.v = new this.N(t, e, 0);
				this.v.o = this.C;
				this.C.o = this.C.i = this.C.h = this.v;
				return this.m;
			}
			let i;
			const r = this.C.i;
			const n = this.A(r.u, t);
			if (n === 0) {
				r.l = e;
				return this.m;
			} else if (n > 0) {
				r.i = new this.N(t, e);
				r.i.o = r;
				i = r.i;
				this.C.i = i;
			} else {
				const r = this.C.h;
				const n = this.A(r.u, t);
				if (n === 0) {
					r.l = e;
					return this.m;
				} else if (n < 0) {
					r.h = new this.N(t, e);
					r.h.o = r;
					i = r.h;
					this.C.h = i;
				} else {
					if (s !== void 0) {
						const r = s.T;
						if (r !== this.C) {
							const s = this.A(r.u, t);
							if (s === 0) {
								r.l = e;
								return this.m;
							} else if (s > 0) {
								const s = r.I();
								const n = this.A(s.u, t);
								if (n === 0) {
									s.l = e;
									return this.m;
								} else if (n < 0) {
									i = new this.N(t, e);
									if (s.h === void 0) {
										s.h = i;
										i.o = s;
									} else {
										r.i = i;
										i.o = r;
									}
								}
							}
						}
					}
					if (i === void 0) {
						i = this.v;
						while (true) {
							const s = this.A(i.u, t);
							if (s > 0) {
								if (i.i === void 0) {
									i.i = new this.N(t, e);
									i.i.o = i;
									i = i.i;
									break;
								}
								i = i.i;
							} else if (s < 0) {
								if (i.h === void 0) {
									i.h = new this.N(t, e);
									i.h.o = i;
									i = i.h;
									break;
								}
								i = i.h;
							} else {
								i.l = e;
								return this.m;
							}
						}
					}
				}
			}
			if (this.enableIndex) {
				let t = i.o;
				while (t !== this.C) {
					t.M += 1;
					t = t.o;
				}
			}
			this.j(i);
			this.m += 1;
			return this.m;
		}
		H(t, e) {
			while (t) {
				const s = this.A(t.u, e);
				if (s < 0) t = t.h;
				else if (s > 0) t = t.i;
				else return t;
			}
			return t || this.C;
		}
		clear() {
			this.m = 0;
			this.v = void 0;
			this.C.o = void 0;
			this.C.i = this.C.h = void 0;
		}
		updateKeyByIterator(t, e) {
			const s = t.T;
			if (s === this.C) throwIteratorAccessError();
			if (this.m === 1) {
				s.u = e;
				return true;
			}
			const i = s.B().u;
			if (s === this.C.i) {
				if (this.A(i, e) > 0) {
					s.u = e;
					return true;
				}
				return false;
			}
			const r = s.I().u;
			if (s === this.C.h) {
				if (this.A(r, e) < 0) {
					s.u = e;
					return true;
				}
				return false;
			}
			if (this.A(r, e) >= 0 || this.A(i, e) <= 0) return false;
			s.u = e;
			return true;
		}
		eraseElementByPos(t) {
			if (t < 0 || t > this.m - 1) throw new RangeError();
			const e = this.U(t);
			this.S(e);
			return this.m;
		}
		eraseElementByKey(t) {
			if (this.m === 0) return false;
			const e = this.H(this.v, t);
			if (e === this.C) return false;
			this.S(e);
			return true;
		}
		eraseElementByIterator(t) {
			const e = t.T;
			if (e === this.C) throwIteratorAccessError();
			const s = e.h === void 0;
			if (t.iteratorType === 0) {
				if (s) t.next();
			} else if (!s || e.i === void 0) t.next();
			this.S(e);
			return t;
		}
		getHeight() {
			if (this.m === 0) return 0;
			function traversal(t) {
				if (!t) return 0;
				return Math.max(traversal(t.i), traversal(t.h)) + 1;
			}
			return traversal(this.v);
		}
	};
	var TreeIterator = class extends ContainerIterator {
		constructor(t, e, s) {
			super(s);
			this.T = t;
			this.C = e;
			if (this.iteratorType === 0) {
				this.pre = function() {
					if (this.T === this.C.i) throwIteratorAccessError();
					this.T = this.T.I();
					return this;
				};
				this.next = function() {
					if (this.T === this.C) throwIteratorAccessError();
					this.T = this.T.B();
					return this;
				};
			} else {
				this.pre = function() {
					if (this.T === this.C.h) throwIteratorAccessError();
					this.T = this.T.B();
					return this;
				};
				this.next = function() {
					if (this.T === this.C) throwIteratorAccessError();
					this.T = this.T.I();
					return this;
				};
			}
		}
		get index() {
			let t = this.T;
			const e = this.C.o;
			if (t === this.C) {
				if (e) return e.M - 1;
				return 0;
			}
			let s = 0;
			if (t.i) s += t.i.M;
			while (t !== e) {
				const e = t.o;
				if (t === e.h) {
					s += 1;
					if (e.i) s += e.i.M;
				}
				t = e;
			}
			return s;
		}
		isAccessible() {
			return this.T !== this.C;
		}
	};
	var OrderedMapIterator = class OrderedMapIterator extends TreeIterator {
		constructor(t, e, s, i) {
			super(t, e, i);
			this.container = s;
		}
		get pointer() {
			if (this.T === this.C) throwIteratorAccessError();
			const t = this;
			return new Proxy([], {
				get(e, s) {
					if (s === "0") return t.T.u;
					else if (s === "1") return t.T.l;
					e[0] = t.T.u;
					e[1] = t.T.l;
					return e[s];
				},
				set(e, s, i) {
					if (s !== "1") throw new TypeError("prop must be 1");
					t.T.l = i;
					return true;
				}
			});
		}
		copy() {
			return new OrderedMapIterator(this.T, this.C, this.container, this.iteratorType);
		}
	};
	var OrderedMap = class extends TreeContainer {
		constructor(t = [], e, s) {
			super(e, s);
			const i = this;
			t.forEach((function(t) {
				i.setElement(t[0], t[1]);
			}));
		}
		begin() {
			return new OrderedMapIterator(this.C.i || this.C, this.C, this);
		}
		end() {
			return new OrderedMapIterator(this.C, this.C, this);
		}
		rBegin() {
			return new OrderedMapIterator(this.C.h || this.C, this.C, this, 1);
		}
		rEnd() {
			return new OrderedMapIterator(this.C, this.C, this, 1);
		}
		front() {
			if (this.m === 0) return;
			const t = this.C.i;
			return [t.u, t.l];
		}
		back() {
			if (this.m === 0) return;
			const t = this.C.h;
			return [t.u, t.l];
		}
		lowerBound(t) {
			return new OrderedMapIterator(this.R(this.v, t), this.C, this);
		}
		upperBound(t) {
			return new OrderedMapIterator(this.K(this.v, t), this.C, this);
		}
		reverseLowerBound(t) {
			return new OrderedMapIterator(this.L(this.v, t), this.C, this);
		}
		reverseUpperBound(t) {
			return new OrderedMapIterator(this.k(this.v, t), this.C, this);
		}
		forEach(t) {
			this.U((function(e, s, i) {
				t([e.u, e.l], s, i);
			}));
		}
		setElement(t, e, s) {
			return this.q(t, e, s);
		}
		getElementByPos(t) {
			if (t < 0 || t > this.m - 1) throw new RangeError();
			const e = this.U(t);
			return [e.u, e.l];
		}
		find(t) {
			return new OrderedMapIterator(this.H(this.v, t), this.C, this);
		}
		getElementByKey(t) {
			return this.H(this.v, t).l;
		}
		union(t) {
			const e = this;
			t.forEach((function(t) {
				e.setElement(t[0], t[1]);
			}));
			return this.m;
		}
		*[Symbol.iterator]() {
			const t = this.m;
			const e = this.U();
			for (let s = 0; s < t; ++s) {
				const t = e[s];
				yield [t.u, t.l];
			}
		}
	};
	exports.OrderedMap = OrderedMap;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/admin.js
var require_admin = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.registerAdminService = registerAdminService;
	exports.addAdminServicesToServer = addAdminServicesToServer;
	const registeredAdminServices = [];
	function registerAdminService(getServiceDefinition, getHandlers) {
		registeredAdminServices.push({
			getServiceDefinition,
			getHandlers
		});
	}
	function addAdminServicesToServer(server) {
		for (const { getServiceDefinition, getHandlers } of registeredAdminServices) server.addService(getServiceDefinition(), getHandlers());
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/call.js
var require_call = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ClientDuplexStreamImpl = exports.ClientWritableStreamImpl = exports.ClientReadableStreamImpl = exports.ClientUnaryCallImpl = void 0;
	exports.callErrorFromStatus = callErrorFromStatus;
	const events_1$1 = __require("events");
	const stream_1$1 = __require("stream");
	const constants_1 = require_constants();
	/**
	* Construct a ServiceError from a StatusObject. This function exists primarily
	* as an attempt to make the error stack trace clearly communicate that the
	* error is not necessarily a problem in gRPC itself.
	* @param status
	*/
	function callErrorFromStatus(status, callerStack) {
		const message = `${status.code} ${constants_1.Status[status.code]}: ${status.details}`;
		const stack = `${new Error(message).stack}\nfor call at\n${callerStack}`;
		return Object.assign(new Error(message), status, { stack });
	}
	var ClientUnaryCallImpl = class extends events_1$1.EventEmitter {
		constructor() {
			super();
		}
		cancel() {
			var _a;
			(_a = this.call) === null || _a === void 0 || _a.cancelWithStatus(constants_1.Status.CANCELLED, "Cancelled on client");
		}
		getPeer() {
			var _a, _b;
			return (_b = (_a = this.call) === null || _a === void 0 ? void 0 : _a.getPeer()) !== null && _b !== void 0 ? _b : "unknown";
		}
		getAuthContext() {
			var _a, _b;
			return (_b = (_a = this.call) === null || _a === void 0 ? void 0 : _a.getAuthContext()) !== null && _b !== void 0 ? _b : null;
		}
	};
	exports.ClientUnaryCallImpl = ClientUnaryCallImpl;
	var ClientReadableStreamImpl = class extends stream_1$1.Readable {
		constructor(deserialize) {
			super({ objectMode: true });
			this.deserialize = deserialize;
		}
		cancel() {
			var _a;
			(_a = this.call) === null || _a === void 0 || _a.cancelWithStatus(constants_1.Status.CANCELLED, "Cancelled on client");
		}
		getPeer() {
			var _a, _b;
			return (_b = (_a = this.call) === null || _a === void 0 ? void 0 : _a.getPeer()) !== null && _b !== void 0 ? _b : "unknown";
		}
		getAuthContext() {
			var _a, _b;
			return (_b = (_a = this.call) === null || _a === void 0 ? void 0 : _a.getAuthContext()) !== null && _b !== void 0 ? _b : null;
		}
		_read(_size) {
			var _a;
			(_a = this.call) === null || _a === void 0 || _a.startRead();
		}
	};
	exports.ClientReadableStreamImpl = ClientReadableStreamImpl;
	var ClientWritableStreamImpl = class extends stream_1$1.Writable {
		constructor(serialize) {
			super({ objectMode: true });
			this.serialize = serialize;
		}
		cancel() {
			var _a;
			(_a = this.call) === null || _a === void 0 || _a.cancelWithStatus(constants_1.Status.CANCELLED, "Cancelled on client");
		}
		getPeer() {
			var _a, _b;
			return (_b = (_a = this.call) === null || _a === void 0 ? void 0 : _a.getPeer()) !== null && _b !== void 0 ? _b : "unknown";
		}
		getAuthContext() {
			var _a, _b;
			return (_b = (_a = this.call) === null || _a === void 0 ? void 0 : _a.getAuthContext()) !== null && _b !== void 0 ? _b : null;
		}
		_write(chunk, encoding, cb) {
			var _a;
			const context = { callback: cb };
			const flags = Number(encoding);
			if (!Number.isNaN(flags)) context.flags = flags;
			(_a = this.call) === null || _a === void 0 || _a.sendMessageWithContext(context, chunk);
		}
		_final(cb) {
			var _a;
			(_a = this.call) === null || _a === void 0 || _a.halfClose();
			cb();
		}
	};
	exports.ClientWritableStreamImpl = ClientWritableStreamImpl;
	var ClientDuplexStreamImpl = class extends stream_1$1.Duplex {
		constructor(serialize, deserialize) {
			super({ objectMode: true });
			this.serialize = serialize;
			this.deserialize = deserialize;
		}
		cancel() {
			var _a;
			(_a = this.call) === null || _a === void 0 || _a.cancelWithStatus(constants_1.Status.CANCELLED, "Cancelled on client");
		}
		getPeer() {
			var _a, _b;
			return (_b = (_a = this.call) === null || _a === void 0 ? void 0 : _a.getPeer()) !== null && _b !== void 0 ? _b : "unknown";
		}
		getAuthContext() {
			var _a, _b;
			return (_b = (_a = this.call) === null || _a === void 0 ? void 0 : _a.getAuthContext()) !== null && _b !== void 0 ? _b : null;
		}
		_read(_size) {
			var _a;
			(_a = this.call) === null || _a === void 0 || _a.startRead();
		}
		_write(chunk, encoding, cb) {
			var _a;
			const context = { callback: cb };
			const flags = Number(encoding);
			if (!Number.isNaN(flags)) context.flags = flags;
			(_a = this.call) === null || _a === void 0 || _a.sendMessageWithContext(context, chunk);
		}
		_final(cb) {
			var _a;
			(_a = this.call) === null || _a === void 0 || _a.halfClose();
			cb();
		}
	};
	exports.ClientDuplexStreamImpl = ClientDuplexStreamImpl;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/call-interface.js
var require_call_interface = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.InterceptingListenerImpl = void 0;
	exports.statusOrFromValue = statusOrFromValue;
	exports.statusOrFromError = statusOrFromError;
	exports.isInterceptingListener = isInterceptingListener;
	const metadata_1 = require_metadata();
	function statusOrFromValue(value) {
		return {
			ok: true,
			value
		};
	}
	function statusOrFromError(error) {
		var _a;
		return {
			ok: false,
			error: Object.assign(Object.assign({}, error), { metadata: (_a = error.metadata) !== null && _a !== void 0 ? _a : new metadata_1.Metadata() })
		};
	}
	function isInterceptingListener(listener) {
		return listener.onReceiveMetadata !== void 0 && listener.onReceiveMetadata.length === 1;
	}
	var InterceptingListenerImpl = class {
		constructor(listener, nextListener) {
			this.listener = listener;
			this.nextListener = nextListener;
			this.processingMetadata = false;
			this.hasPendingMessage = false;
			this.processingMessage = false;
			this.pendingStatus = null;
		}
		processPendingMessage() {
			if (this.hasPendingMessage) {
				this.nextListener.onReceiveMessage(this.pendingMessage);
				this.pendingMessage = null;
				this.hasPendingMessage = false;
			}
		}
		processPendingStatus() {
			if (this.pendingStatus) this.nextListener.onReceiveStatus(this.pendingStatus);
		}
		onReceiveMetadata(metadata) {
			this.processingMetadata = true;
			this.listener.onReceiveMetadata(metadata, (metadata) => {
				this.processingMetadata = false;
				this.nextListener.onReceiveMetadata(metadata);
				this.processPendingMessage();
				this.processPendingStatus();
			});
		}
		onReceiveMessage(message) {
			this.processingMessage = true;
			this.listener.onReceiveMessage(message, (msg) => {
				this.processingMessage = false;
				if (this.processingMetadata) {
					this.pendingMessage = msg;
					this.hasPendingMessage = true;
				} else {
					this.nextListener.onReceiveMessage(msg);
					this.processPendingStatus();
				}
			});
		}
		onReceiveStatus(status) {
			this.listener.onReceiveStatus(status, (processedStatus) => {
				if (this.processingMetadata || this.processingMessage) this.pendingStatus = processedStatus;
				else this.nextListener.onReceiveStatus(processedStatus);
			});
		}
	};
	exports.InterceptingListenerImpl = InterceptingListenerImpl;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/client-interceptors.js
var require_client_interceptors = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.InterceptingCall = exports.RequesterBuilder = exports.ListenerBuilder = exports.InterceptorConfigurationError = void 0;
	exports.getInterceptingCall = getInterceptingCall;
	const metadata_1 = require_metadata();
	const call_interface_1 = require_call_interface();
	const constants_1 = require_constants();
	const error_1 = require_error();
	/**
	* Error class associated with passing both interceptors and interceptor
	* providers to a client constructor or as call options.
	*/
	var InterceptorConfigurationError = class InterceptorConfigurationError extends Error {
		constructor(message) {
			super(message);
			this.name = "InterceptorConfigurationError";
			Error.captureStackTrace(this, InterceptorConfigurationError);
		}
	};
	exports.InterceptorConfigurationError = InterceptorConfigurationError;
	var ListenerBuilder = class {
		constructor() {
			this.metadata = void 0;
			this.message = void 0;
			this.status = void 0;
		}
		withOnReceiveMetadata(onReceiveMetadata) {
			this.metadata = onReceiveMetadata;
			return this;
		}
		withOnReceiveMessage(onReceiveMessage) {
			this.message = onReceiveMessage;
			return this;
		}
		withOnReceiveStatus(onReceiveStatus) {
			this.status = onReceiveStatus;
			return this;
		}
		build() {
			return {
				onReceiveMetadata: this.metadata,
				onReceiveMessage: this.message,
				onReceiveStatus: this.status
			};
		}
	};
	exports.ListenerBuilder = ListenerBuilder;
	var RequesterBuilder = class {
		constructor() {
			this.start = void 0;
			this.message = void 0;
			this.halfClose = void 0;
			this.cancel = void 0;
		}
		withStart(start) {
			this.start = start;
			return this;
		}
		withSendMessage(sendMessage) {
			this.message = sendMessage;
			return this;
		}
		withHalfClose(halfClose) {
			this.halfClose = halfClose;
			return this;
		}
		withCancel(cancel) {
			this.cancel = cancel;
			return this;
		}
		build() {
			return {
				start: this.start,
				sendMessage: this.message,
				halfClose: this.halfClose,
				cancel: this.cancel
			};
		}
	};
	exports.RequesterBuilder = RequesterBuilder;
	/**
	* A Listener with a default pass-through implementation of each method. Used
	* for filling out Listeners with some methods omitted.
	*/
	const defaultListener = {
		onReceiveMetadata: (metadata, next) => {
			next(metadata);
		},
		onReceiveMessage: (message, next) => {
			next(message);
		},
		onReceiveStatus: (status, next) => {
			next(status);
		}
	};
	/**
	* A Requester with a default pass-through implementation of each method. Used
	* for filling out Requesters with some methods omitted.
	*/
	const defaultRequester = {
		start: (metadata, listener, next) => {
			next(metadata, listener);
		},
		sendMessage: (message, next) => {
			next(message);
		},
		halfClose: (next) => {
			next();
		},
		cancel: (next) => {
			next();
		}
	};
	var InterceptingCall = class {
		constructor(nextCall, requester) {
			var _a, _b, _c, _d;
			this.nextCall = nextCall;
			/**
			* Indicates that metadata has been passed to the requester's start
			* method but it has not been passed to the corresponding next callback
			*/
			this.processingMetadata = false;
			/**
			* Message context for a pending message that is waiting for
			*/
			this.pendingMessageContext = null;
			/**
			* Indicates that a message has been passed to the requester's sendMessage
			* method but it has not been passed to the corresponding next callback
			*/
			this.processingMessage = false;
			/**
			* Indicates that a status was received but could not be propagated because
			* a message was still being processed.
			*/
			this.pendingHalfClose = false;
			if (requester) this.requester = {
				start: (_a = requester.start) !== null && _a !== void 0 ? _a : defaultRequester.start,
				sendMessage: (_b = requester.sendMessage) !== null && _b !== void 0 ? _b : defaultRequester.sendMessage,
				halfClose: (_c = requester.halfClose) !== null && _c !== void 0 ? _c : defaultRequester.halfClose,
				cancel: (_d = requester.cancel) !== null && _d !== void 0 ? _d : defaultRequester.cancel
			};
			else this.requester = defaultRequester;
		}
		cancelWithStatus(status, details) {
			this.requester.cancel(() => {
				this.nextCall.cancelWithStatus(status, details);
			});
		}
		getPeer() {
			return this.nextCall.getPeer();
		}
		processPendingMessage() {
			if (this.pendingMessageContext) {
				this.nextCall.sendMessageWithContext(this.pendingMessageContext, this.pendingMessage);
				this.pendingMessageContext = null;
				this.pendingMessage = null;
			}
		}
		processPendingHalfClose() {
			if (this.pendingHalfClose) this.nextCall.halfClose();
		}
		start(metadata, interceptingListener) {
			var _a, _b, _c, _d, _e, _f;
			const fullInterceptingListener = {
				onReceiveMetadata: (_b = (_a = interceptingListener === null || interceptingListener === void 0 ? void 0 : interceptingListener.onReceiveMetadata) === null || _a === void 0 ? void 0 : _a.bind(interceptingListener)) !== null && _b !== void 0 ? _b : ((metadata) => {}),
				onReceiveMessage: (_d = (_c = interceptingListener === null || interceptingListener === void 0 ? void 0 : interceptingListener.onReceiveMessage) === null || _c === void 0 ? void 0 : _c.bind(interceptingListener)) !== null && _d !== void 0 ? _d : ((message) => {}),
				onReceiveStatus: (_f = (_e = interceptingListener === null || interceptingListener === void 0 ? void 0 : interceptingListener.onReceiveStatus) === null || _e === void 0 ? void 0 : _e.bind(interceptingListener)) !== null && _f !== void 0 ? _f : ((status) => {})
			};
			this.processingMetadata = true;
			this.requester.start(metadata, fullInterceptingListener, (md, listener) => {
				var _a, _b, _c;
				this.processingMetadata = false;
				let finalInterceptingListener;
				if ((0, call_interface_1.isInterceptingListener)(listener)) finalInterceptingListener = listener;
				else {
					const fullListener = {
						onReceiveMetadata: (_a = listener.onReceiveMetadata) !== null && _a !== void 0 ? _a : defaultListener.onReceiveMetadata,
						onReceiveMessage: (_b = listener.onReceiveMessage) !== null && _b !== void 0 ? _b : defaultListener.onReceiveMessage,
						onReceiveStatus: (_c = listener.onReceiveStatus) !== null && _c !== void 0 ? _c : defaultListener.onReceiveStatus
					};
					finalInterceptingListener = new call_interface_1.InterceptingListenerImpl(fullListener, fullInterceptingListener);
				}
				this.nextCall.start(md, finalInterceptingListener);
				this.processPendingMessage();
				this.processPendingHalfClose();
			});
		}
		sendMessageWithContext(context, message) {
			this.processingMessage = true;
			this.requester.sendMessage(message, (finalMessage) => {
				this.processingMessage = false;
				if (this.processingMetadata) {
					this.pendingMessageContext = context;
					this.pendingMessage = message;
				} else {
					this.nextCall.sendMessageWithContext(context, finalMessage);
					this.processPendingHalfClose();
				}
			});
		}
		sendMessage(message) {
			this.sendMessageWithContext({}, message);
		}
		startRead() {
			this.nextCall.startRead();
		}
		halfClose() {
			this.requester.halfClose(() => {
				if (this.processingMetadata || this.processingMessage) this.pendingHalfClose = true;
				else this.nextCall.halfClose();
			});
		}
		getAuthContext() {
			return this.nextCall.getAuthContext();
		}
	};
	exports.InterceptingCall = InterceptingCall;
	function getCall(channel, path, options) {
		var _a, _b;
		const deadline = (_a = options.deadline) !== null && _a !== void 0 ? _a : Infinity;
		const host = options.host;
		const parent = (_b = options.parent) !== null && _b !== void 0 ? _b : null;
		const propagateFlags = options.propagate_flags;
		const credentials = options.credentials;
		const call = channel.createCall(path, deadline, host, parent, propagateFlags);
		if (credentials) call.setCredentials(credentials);
		return call;
	}
	/**
	* InterceptingCall implementation that directly owns the underlying Call
	* object and handles serialization and deseraizliation.
	*/
	var BaseInterceptingCall = class {
		constructor(call, methodDefinition) {
			this.call = call;
			this.methodDefinition = methodDefinition;
		}
		cancelWithStatus(status, details) {
			this.call.cancelWithStatus(status, details);
		}
		getPeer() {
			return this.call.getPeer();
		}
		sendMessageWithContext(context, message) {
			let serialized;
			try {
				serialized = this.methodDefinition.requestSerialize(message);
			} catch (e) {
				this.call.cancelWithStatus(constants_1.Status.INTERNAL, `Request message serialization failure: ${(0, error_1.getErrorMessage)(e)}`);
				return;
			}
			this.call.sendMessageWithContext(context, serialized);
		}
		sendMessage(message) {
			this.sendMessageWithContext({}, message);
		}
		start(metadata, interceptingListener) {
			let readError = null;
			this.call.start(metadata, {
				onReceiveMetadata: (metadata) => {
					var _a;
					(_a = interceptingListener === null || interceptingListener === void 0 ? void 0 : interceptingListener.onReceiveMetadata) === null || _a === void 0 || _a.call(interceptingListener, metadata);
				},
				onReceiveMessage: (message) => {
					var _a;
					let deserialized;
					try {
						deserialized = this.methodDefinition.responseDeserialize(message);
					} catch (e) {
						readError = {
							code: constants_1.Status.INTERNAL,
							details: `Response message parsing error: ${(0, error_1.getErrorMessage)(e)}`,
							metadata: new metadata_1.Metadata()
						};
						this.call.cancelWithStatus(readError.code, readError.details);
						return;
					}
					(_a = interceptingListener === null || interceptingListener === void 0 ? void 0 : interceptingListener.onReceiveMessage) === null || _a === void 0 || _a.call(interceptingListener, deserialized);
				},
				onReceiveStatus: (status) => {
					var _a, _b;
					if (readError) (_a = interceptingListener === null || interceptingListener === void 0 ? void 0 : interceptingListener.onReceiveStatus) === null || _a === void 0 || _a.call(interceptingListener, readError);
					else (_b = interceptingListener === null || interceptingListener === void 0 ? void 0 : interceptingListener.onReceiveStatus) === null || _b === void 0 || _b.call(interceptingListener, status);
				}
			});
		}
		startRead() {
			this.call.startRead();
		}
		halfClose() {
			this.call.halfClose();
		}
		getAuthContext() {
			return this.call.getAuthContext();
		}
	};
	/**
	* BaseInterceptingCall with special-cased behavior for methods with unary
	* responses.
	*/
	var BaseUnaryInterceptingCall = class extends BaseInterceptingCall {
		constructor(call, methodDefinition) {
			super(call, methodDefinition);
		}
		start(metadata, listener) {
			var _a, _b;
			let receivedMessage = false;
			const wrapperListener = {
				onReceiveMetadata: (_b = (_a = listener === null || listener === void 0 ? void 0 : listener.onReceiveMetadata) === null || _a === void 0 ? void 0 : _a.bind(listener)) !== null && _b !== void 0 ? _b : ((metadata) => {}),
				onReceiveMessage: (message) => {
					var _a;
					receivedMessage = true;
					(_a = listener === null || listener === void 0 ? void 0 : listener.onReceiveMessage) === null || _a === void 0 || _a.call(listener, message);
				},
				onReceiveStatus: (status) => {
					var _a, _b;
					if (!receivedMessage) (_a = listener === null || listener === void 0 ? void 0 : listener.onReceiveMessage) === null || _a === void 0 || _a.call(listener, null);
					(_b = listener === null || listener === void 0 ? void 0 : listener.onReceiveStatus) === null || _b === void 0 || _b.call(listener, status);
				}
			};
			super.start(metadata, wrapperListener);
			this.call.startRead();
		}
	};
	/**
	* BaseInterceptingCall with special-cased behavior for methods with streaming
	* responses.
	*/
	var BaseStreamingInterceptingCall = class extends BaseInterceptingCall {};
	function getBottomInterceptingCall(channel, options, methodDefinition) {
		const call = getCall(channel, methodDefinition.path, options);
		if (methodDefinition.responseStream) return new BaseStreamingInterceptingCall(call, methodDefinition);
		else return new BaseUnaryInterceptingCall(call, methodDefinition);
	}
	function getInterceptingCall(interceptorArgs, methodDefinition, options, channel) {
		if (interceptorArgs.clientInterceptors.length > 0 && interceptorArgs.clientInterceptorProviders.length > 0) throw new InterceptorConfigurationError("Both interceptors and interceptor_providers were passed as options to the client constructor. Only one of these is allowed.");
		if (interceptorArgs.callInterceptors.length > 0 && interceptorArgs.callInterceptorProviders.length > 0) throw new InterceptorConfigurationError("Both interceptors and interceptor_providers were passed as call options. Only one of these is allowed.");
		let interceptors = [];
		if (interceptorArgs.callInterceptors.length > 0 || interceptorArgs.callInterceptorProviders.length > 0) interceptors = [].concat(interceptorArgs.callInterceptors, interceptorArgs.callInterceptorProviders.map((provider) => provider(methodDefinition))).filter((interceptor) => interceptor);
		else interceptors = [].concat(interceptorArgs.clientInterceptors, interceptorArgs.clientInterceptorProviders.map((provider) => provider(methodDefinition))).filter((interceptor) => interceptor);
		const interceptorOptions = Object.assign({}, options, { method_definition: methodDefinition });
		return interceptors.reduceRight((nextCall, nextInterceptor) => {
			return (currentOptions) => nextInterceptor(currentOptions, nextCall);
		}, (finalOptions) => getBottomInterceptingCall(channel, finalOptions, methodDefinition))(interceptorOptions);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/client.js
var require_client = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Client = void 0;
	const call_1 = require_call();
	const channel_1 = require_channel();
	const connectivity_state_1 = require_connectivity_state();
	const constants_1 = require_constants();
	const metadata_1 = require_metadata();
	const client_interceptors_1 = require_client_interceptors();
	const CHANNEL_SYMBOL = Symbol();
	const INTERCEPTOR_SYMBOL = Symbol();
	const INTERCEPTOR_PROVIDER_SYMBOL = Symbol();
	const CALL_INVOCATION_TRANSFORMER_SYMBOL = Symbol();
	function isFunction(arg) {
		return typeof arg === "function";
	}
	function getErrorStackString(error) {
		var _a;
		return ((_a = error.stack) === null || _a === void 0 ? void 0 : _a.split("\n").slice(1).join("\n")) || "no stack trace available";
	}
	/**
	* A generic gRPC client. Primarily useful as a base class for all generated
	* clients.
	*/
	var Client = class {
		constructor(address, credentials, options = {}) {
			var _a, _b;
			options = Object.assign({}, options);
			this[INTERCEPTOR_SYMBOL] = (_a = options.interceptors) !== null && _a !== void 0 ? _a : [];
			delete options.interceptors;
			this[INTERCEPTOR_PROVIDER_SYMBOL] = (_b = options.interceptor_providers) !== null && _b !== void 0 ? _b : [];
			delete options.interceptor_providers;
			if (this[INTERCEPTOR_SYMBOL].length > 0 && this[INTERCEPTOR_PROVIDER_SYMBOL].length > 0) throw new Error("Both interceptors and interceptor_providers were passed as options to the client constructor. Only one of these is allowed.");
			this[CALL_INVOCATION_TRANSFORMER_SYMBOL] = options.callInvocationTransformer;
			delete options.callInvocationTransformer;
			if (options.channelOverride) this[CHANNEL_SYMBOL] = options.channelOverride;
			else if (options.channelFactoryOverride) {
				const channelFactoryOverride = options.channelFactoryOverride;
				delete options.channelFactoryOverride;
				this[CHANNEL_SYMBOL] = channelFactoryOverride(address, credentials, options);
			} else this[CHANNEL_SYMBOL] = new channel_1.ChannelImplementation(address, credentials, options);
		}
		close() {
			this[CHANNEL_SYMBOL].close();
		}
		getChannel() {
			return this[CHANNEL_SYMBOL];
		}
		waitForReady(deadline, callback) {
			const checkState = (err) => {
				if (err) {
					callback(/* @__PURE__ */ new Error("Failed to connect before the deadline"));
					return;
				}
				let newState;
				try {
					newState = this[CHANNEL_SYMBOL].getConnectivityState(true);
				} catch (e) {
					callback(/* @__PURE__ */ new Error("The channel has been closed"));
					return;
				}
				if (newState === connectivity_state_1.ConnectivityState.READY) callback();
				else try {
					this[CHANNEL_SYMBOL].watchConnectivityState(newState, deadline, checkState);
				} catch (e) {
					callback(/* @__PURE__ */ new Error("The channel has been closed"));
				}
			};
			setImmediate(checkState);
		}
		checkOptionalUnaryResponseArguments(arg1, arg2, arg3) {
			if (isFunction(arg1)) return {
				metadata: new metadata_1.Metadata(),
				options: {},
				callback: arg1
			};
			else if (isFunction(arg2)) if (arg1 instanceof metadata_1.Metadata) return {
				metadata: arg1,
				options: {},
				callback: arg2
			};
			else return {
				metadata: new metadata_1.Metadata(),
				options: arg1,
				callback: arg2
			};
			else {
				if (!(arg1 instanceof metadata_1.Metadata && arg2 instanceof Object && isFunction(arg3))) throw new Error("Incorrect arguments passed");
				return {
					metadata: arg1,
					options: arg2,
					callback: arg3
				};
			}
		}
		makeUnaryRequest(method, serialize, deserialize, argument, metadata, options, callback) {
			var _a, _b;
			const checkedArguments = this.checkOptionalUnaryResponseArguments(metadata, options, callback);
			const methodDefinition = {
				path: method,
				requestStream: false,
				responseStream: false,
				requestSerialize: serialize,
				responseDeserialize: deserialize
			};
			let callProperties = {
				argument,
				metadata: checkedArguments.metadata,
				call: new call_1.ClientUnaryCallImpl(),
				channel: this[CHANNEL_SYMBOL],
				methodDefinition,
				callOptions: checkedArguments.options,
				callback: checkedArguments.callback
			};
			if (this[CALL_INVOCATION_TRANSFORMER_SYMBOL]) callProperties = this[CALL_INVOCATION_TRANSFORMER_SYMBOL](callProperties);
			const emitter = callProperties.call;
			const interceptorArgs = {
				clientInterceptors: this[INTERCEPTOR_SYMBOL],
				clientInterceptorProviders: this[INTERCEPTOR_PROVIDER_SYMBOL],
				callInterceptors: (_a = callProperties.callOptions.interceptors) !== null && _a !== void 0 ? _a : [],
				callInterceptorProviders: (_b = callProperties.callOptions.interceptor_providers) !== null && _b !== void 0 ? _b : []
			};
			const call = (0, client_interceptors_1.getInterceptingCall)(interceptorArgs, callProperties.methodDefinition, callProperties.callOptions, callProperties.channel);
			emitter.call = call;
			let responseMessage = null;
			let receivedStatus = false;
			let callerStackError = /* @__PURE__ */ new Error();
			call.start(callProperties.metadata, {
				onReceiveMetadata: (metadata) => {
					emitter.emit("metadata", metadata);
				},
				onReceiveMessage(message) {
					if (responseMessage !== null) call.cancelWithStatus(constants_1.Status.UNIMPLEMENTED, "Too many responses received");
					responseMessage = message;
				},
				onReceiveStatus(status) {
					if (receivedStatus) return;
					receivedStatus = true;
					if (status.code === constants_1.Status.OK) if (responseMessage === null) {
						const callerStack = getErrorStackString(callerStackError);
						callProperties.callback((0, call_1.callErrorFromStatus)({
							code: constants_1.Status.UNIMPLEMENTED,
							details: "No message received",
							metadata: status.metadata
						}, callerStack));
					} else callProperties.callback(null, responseMessage);
					else {
						const callerStack = getErrorStackString(callerStackError);
						callProperties.callback((0, call_1.callErrorFromStatus)(status, callerStack));
					}
					callerStackError = null;
					emitter.emit("status", status);
				}
			});
			call.sendMessage(argument);
			call.halfClose();
			return emitter;
		}
		makeClientStreamRequest(method, serialize, deserialize, metadata, options, callback) {
			var _a, _b;
			const checkedArguments = this.checkOptionalUnaryResponseArguments(metadata, options, callback);
			const methodDefinition = {
				path: method,
				requestStream: true,
				responseStream: false,
				requestSerialize: serialize,
				responseDeserialize: deserialize
			};
			let callProperties = {
				metadata: checkedArguments.metadata,
				call: new call_1.ClientWritableStreamImpl(serialize),
				channel: this[CHANNEL_SYMBOL],
				methodDefinition,
				callOptions: checkedArguments.options,
				callback: checkedArguments.callback
			};
			if (this[CALL_INVOCATION_TRANSFORMER_SYMBOL]) callProperties = this[CALL_INVOCATION_TRANSFORMER_SYMBOL](callProperties);
			const emitter = callProperties.call;
			const interceptorArgs = {
				clientInterceptors: this[INTERCEPTOR_SYMBOL],
				clientInterceptorProviders: this[INTERCEPTOR_PROVIDER_SYMBOL],
				callInterceptors: (_a = callProperties.callOptions.interceptors) !== null && _a !== void 0 ? _a : [],
				callInterceptorProviders: (_b = callProperties.callOptions.interceptor_providers) !== null && _b !== void 0 ? _b : []
			};
			const call = (0, client_interceptors_1.getInterceptingCall)(interceptorArgs, callProperties.methodDefinition, callProperties.callOptions, callProperties.channel);
			emitter.call = call;
			let responseMessage = null;
			let receivedStatus = false;
			let callerStackError = /* @__PURE__ */ new Error();
			call.start(callProperties.metadata, {
				onReceiveMetadata: (metadata) => {
					emitter.emit("metadata", metadata);
				},
				onReceiveMessage(message) {
					if (responseMessage !== null) call.cancelWithStatus(constants_1.Status.UNIMPLEMENTED, "Too many responses received");
					responseMessage = message;
					call.startRead();
				},
				onReceiveStatus(status) {
					if (receivedStatus) return;
					receivedStatus = true;
					if (status.code === constants_1.Status.OK) if (responseMessage === null) {
						const callerStack = getErrorStackString(callerStackError);
						callProperties.callback((0, call_1.callErrorFromStatus)({
							code: constants_1.Status.UNIMPLEMENTED,
							details: "No message received",
							metadata: status.metadata
						}, callerStack));
					} else callProperties.callback(null, responseMessage);
					else {
						const callerStack = getErrorStackString(callerStackError);
						callProperties.callback((0, call_1.callErrorFromStatus)(status, callerStack));
					}
					callerStackError = null;
					emitter.emit("status", status);
				}
			});
			return emitter;
		}
		checkMetadataAndOptions(arg1, arg2) {
			let metadata;
			let options;
			if (arg1 instanceof metadata_1.Metadata) {
				metadata = arg1;
				if (arg2) options = arg2;
				else options = {};
			} else {
				if (arg1) options = arg1;
				else options = {};
				metadata = new metadata_1.Metadata();
			}
			return {
				metadata,
				options
			};
		}
		makeServerStreamRequest(method, serialize, deserialize, argument, metadata, options) {
			var _a, _b;
			const checkedArguments = this.checkMetadataAndOptions(metadata, options);
			const methodDefinition = {
				path: method,
				requestStream: false,
				responseStream: true,
				requestSerialize: serialize,
				responseDeserialize: deserialize
			};
			let callProperties = {
				argument,
				metadata: checkedArguments.metadata,
				call: new call_1.ClientReadableStreamImpl(deserialize),
				channel: this[CHANNEL_SYMBOL],
				methodDefinition,
				callOptions: checkedArguments.options
			};
			if (this[CALL_INVOCATION_TRANSFORMER_SYMBOL]) callProperties = this[CALL_INVOCATION_TRANSFORMER_SYMBOL](callProperties);
			const stream = callProperties.call;
			const interceptorArgs = {
				clientInterceptors: this[INTERCEPTOR_SYMBOL],
				clientInterceptorProviders: this[INTERCEPTOR_PROVIDER_SYMBOL],
				callInterceptors: (_a = callProperties.callOptions.interceptors) !== null && _a !== void 0 ? _a : [],
				callInterceptorProviders: (_b = callProperties.callOptions.interceptor_providers) !== null && _b !== void 0 ? _b : []
			};
			const call = (0, client_interceptors_1.getInterceptingCall)(interceptorArgs, callProperties.methodDefinition, callProperties.callOptions, callProperties.channel);
			stream.call = call;
			let receivedStatus = false;
			let callerStackError = /* @__PURE__ */ new Error();
			call.start(callProperties.metadata, {
				onReceiveMetadata(metadata) {
					stream.emit("metadata", metadata);
				},
				onReceiveMessage(message) {
					stream.push(message);
				},
				onReceiveStatus(status) {
					if (receivedStatus) return;
					receivedStatus = true;
					stream.push(null);
					if (status.code !== constants_1.Status.OK) {
						const callerStack = getErrorStackString(callerStackError);
						stream.emit("error", (0, call_1.callErrorFromStatus)(status, callerStack));
					}
					callerStackError = null;
					stream.emit("status", status);
				}
			});
			call.sendMessage(argument);
			call.halfClose();
			return stream;
		}
		makeBidiStreamRequest(method, serialize, deserialize, metadata, options) {
			var _a, _b;
			const checkedArguments = this.checkMetadataAndOptions(metadata, options);
			const methodDefinition = {
				path: method,
				requestStream: true,
				responseStream: true,
				requestSerialize: serialize,
				responseDeserialize: deserialize
			};
			let callProperties = {
				metadata: checkedArguments.metadata,
				call: new call_1.ClientDuplexStreamImpl(serialize, deserialize),
				channel: this[CHANNEL_SYMBOL],
				methodDefinition,
				callOptions: checkedArguments.options
			};
			if (this[CALL_INVOCATION_TRANSFORMER_SYMBOL]) callProperties = this[CALL_INVOCATION_TRANSFORMER_SYMBOL](callProperties);
			const stream = callProperties.call;
			const interceptorArgs = {
				clientInterceptors: this[INTERCEPTOR_SYMBOL],
				clientInterceptorProviders: this[INTERCEPTOR_PROVIDER_SYMBOL],
				callInterceptors: (_a = callProperties.callOptions.interceptors) !== null && _a !== void 0 ? _a : [],
				callInterceptorProviders: (_b = callProperties.callOptions.interceptor_providers) !== null && _b !== void 0 ? _b : []
			};
			const call = (0, client_interceptors_1.getInterceptingCall)(interceptorArgs, callProperties.methodDefinition, callProperties.callOptions, callProperties.channel);
			stream.call = call;
			let receivedStatus = false;
			let callerStackError = /* @__PURE__ */ new Error();
			call.start(callProperties.metadata, {
				onReceiveMetadata(metadata) {
					stream.emit("metadata", metadata);
				},
				onReceiveMessage(message) {
					stream.push(message);
				},
				onReceiveStatus(status) {
					if (receivedStatus) return;
					receivedStatus = true;
					stream.push(null);
					if (status.code !== constants_1.Status.OK) {
						const callerStack = getErrorStackString(callerStackError);
						stream.emit("error", (0, call_1.callErrorFromStatus)(status, callerStack));
					}
					callerStackError = null;
					stream.emit("status", status);
				}
			});
			return stream;
		}
	};
	exports.Client = Client;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/make-client.js
var require_make_client = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.makeClientConstructor = makeClientConstructor;
	exports.loadPackageDefinition = loadPackageDefinition;
	const client_1 = require_client();
	/**
	* Map with short names for each of the requester maker functions. Used in
	* makeClientConstructor
	* @private
	*/
	const requesterFuncs = {
		unary: client_1.Client.prototype.makeUnaryRequest,
		server_stream: client_1.Client.prototype.makeServerStreamRequest,
		client_stream: client_1.Client.prototype.makeClientStreamRequest,
		bidi: client_1.Client.prototype.makeBidiStreamRequest
	};
	/**
	* Returns true, if given key is included in the blacklisted
	* keys.
	* @param key key for check, string.
	*/
	function isPrototypePolluted(key) {
		return [
			"__proto__",
			"prototype",
			"constructor"
		].includes(key);
	}
	/**
	* Creates a constructor for a client with the given methods, as specified in
	* the methods argument. The resulting class will have an instance method for
	* each method in the service, which is a partial application of one of the
	* [Client]{@link grpc.Client} request methods, depending on `requestSerialize`
	* and `responseSerialize`, with the `method`, `serialize`, and `deserialize`
	* arguments predefined.
	* @param methods An object mapping method names to
	*     method attributes
	* @param serviceName The fully qualified name of the service
	* @param classOptions An options object.
	* @return New client constructor, which is a subclass of
	*     {@link grpc.Client}, and has the same arguments as that constructor.
	*/
	function makeClientConstructor(methods, serviceName, classOptions) {
		if (!classOptions) classOptions = {};
		class ServiceClientImpl extends client_1.Client {}
		Object.keys(methods).forEach((name) => {
			if (isPrototypePolluted(name)) return;
			const attrs = methods[name];
			let methodType;
			if (typeof name === "string" && name.charAt(0) === "$") throw new Error("Method names cannot start with $");
			if (attrs.requestStream) if (attrs.responseStream) methodType = "bidi";
			else methodType = "client_stream";
			else if (attrs.responseStream) methodType = "server_stream";
			else methodType = "unary";
			const serialize = attrs.requestSerialize;
			const deserialize = attrs.responseDeserialize;
			const methodFunc = partial(requesterFuncs[methodType], attrs.path, serialize, deserialize);
			ServiceClientImpl.prototype[name] = methodFunc;
			Object.assign(ServiceClientImpl.prototype[name], attrs);
			if (attrs.originalName && !isPrototypePolluted(attrs.originalName)) ServiceClientImpl.prototype[attrs.originalName] = ServiceClientImpl.prototype[name];
		});
		ServiceClientImpl.service = methods;
		ServiceClientImpl.serviceName = serviceName;
		return ServiceClientImpl;
	}
	function partial(fn, path, serialize, deserialize) {
		return function(...args) {
			return fn.call(this, path, serialize, deserialize, ...args);
		};
	}
	function isProtobufTypeDefinition(obj) {
		return "format" in obj;
	}
	/**
	* Load a gRPC package definition as a gRPC object hierarchy.
	* @param packageDef The package definition object.
	* @return The resulting gRPC object.
	*/
	function loadPackageDefinition(packageDef) {
		const result = {};
		for (const serviceFqn in packageDef) if (Object.prototype.hasOwnProperty.call(packageDef, serviceFqn)) {
			const service = packageDef[serviceFqn];
			const nameComponents = serviceFqn.split(".");
			if (nameComponents.some((comp) => isPrototypePolluted(comp))) continue;
			const serviceName = nameComponents[nameComponents.length - 1];
			let current = result;
			for (const packageName of nameComponents.slice(0, -1)) {
				if (!current[packageName]) current[packageName] = {};
				current = current[packageName];
			}
			if (isProtobufTypeDefinition(service)) current[serviceName] = service;
			else current[serviceName] = makeClientConstructor(service, serviceName, {});
		}
		return result;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/lodash.camelcase@4.3.0/node_modules/lodash.camelcase/index.js
var require_lodash_camelcase = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* lodash (Custom Build) <https://lodash.com/>
	* Build: `lodash modularize exports="npm" -o ./`
	* Copyright jQuery Foundation and other contributors <https://jquery.org/>
	* Released under MIT license <https://lodash.com/license>
	* Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
	* Copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
	*/
	/** Used as references for various `Number` constants. */
	var INFINITY = Infinity;
	/** `Object#toString` result references. */
	var symbolTag = "[object Symbol]";
	/** Used to match words composed of alphanumeric characters. */
	var reAsciiWord = /[^\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+/g;
	/** Used to match Latin Unicode letters (excluding mathematical operators). */
	var reLatin = /[\xc0-\xd6\xd8-\xf6\xf8-\xff\u0100-\u017f]/g;
	/** Used to compose unicode character classes. */
	var rsAstralRange = "\\ud800-\\udfff", rsComboMarksRange = "\\u0300-\\u036f\\ufe20-\\ufe23", rsComboSymbolsRange = "\\u20d0-\\u20f0", rsDingbatRange = "\\u2700-\\u27bf", rsLowerRange = "a-z\\xdf-\\xf6\\xf8-\\xff", rsMathOpRange = "\\xac\\xb1\\xd7\\xf7", rsNonCharRange = "\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\xbf", rsPunctuationRange = "\\u2000-\\u206f", rsSpaceRange = " \\t\\x0b\\f\\xa0\\ufeff\\n\\r\\u2028\\u2029\\u1680\\u180e\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u202f\\u205f\\u3000", rsUpperRange = "A-Z\\xc0-\\xd6\\xd8-\\xde", rsVarRange = "\\ufe0e\\ufe0f", rsBreakRange = rsMathOpRange + rsNonCharRange + rsPunctuationRange + rsSpaceRange;
	/** Used to compose unicode capture groups. */
	var rsApos = "['’]", rsAstral = "[" + rsAstralRange + "]", rsBreak = "[" + rsBreakRange + "]", rsCombo = "[" + rsComboMarksRange + rsComboSymbolsRange + "]", rsDigits = "\\d+", rsDingbat = "[" + rsDingbatRange + "]", rsLower = "[" + rsLowerRange + "]", rsMisc = "[^" + rsAstralRange + rsBreakRange + rsDigits + rsDingbatRange + rsLowerRange + rsUpperRange + "]", rsFitz = "\\ud83c[\\udffb-\\udfff]", rsModifier = "(?:" + rsCombo + "|" + rsFitz + ")", rsNonAstral = "[^" + rsAstralRange + "]", rsRegional = "(?:\\ud83c[\\udde6-\\uddff]){2}", rsSurrPair = "[\\ud800-\\udbff][\\udc00-\\udfff]", rsUpper = "[" + rsUpperRange + "]", rsZWJ = "\\u200d";
	/** Used to compose unicode regexes. */
	var rsLowerMisc = "(?:" + rsLower + "|" + rsMisc + ")", rsUpperMisc = "(?:" + rsUpper + "|" + rsMisc + ")", rsOptLowerContr = "(?:" + rsApos + "(?:d|ll|m|re|s|t|ve))?", rsOptUpperContr = "(?:" + rsApos + "(?:D|LL|M|RE|S|T|VE))?", reOptMod = rsModifier + "?", rsOptVar = "[" + rsVarRange + "]?", rsOptJoin = "(?:" + rsZWJ + "(?:" + [
		rsNonAstral,
		rsRegional,
		rsSurrPair
	].join("|") + ")" + rsOptVar + reOptMod + ")*", rsSeq = rsOptVar + reOptMod + rsOptJoin, rsEmoji = "(?:" + [
		rsDingbat,
		rsRegional,
		rsSurrPair
	].join("|") + ")" + rsSeq, rsSymbol = "(?:" + [
		rsNonAstral + rsCombo + "?",
		rsCombo,
		rsRegional,
		rsSurrPair,
		rsAstral
	].join("|") + ")";
	/** Used to match apostrophes. */
	var reApos = RegExp(rsApos, "g");
	/**
	* Used to match [combining diacritical marks](https://en.wikipedia.org/wiki/Combining_Diacritical_Marks) and
	* [combining diacritical marks for symbols](https://en.wikipedia.org/wiki/Combining_Diacritical_Marks_for_Symbols).
	*/
	var reComboMark = RegExp(rsCombo, "g");
	/** Used to match [string symbols](https://mathiasbynens.be/notes/javascript-unicode). */
	var reUnicode = RegExp(rsFitz + "(?=" + rsFitz + ")|" + rsSymbol + rsSeq, "g");
	/** Used to match complex or compound words. */
	var reUnicodeWord = RegExp([
		rsUpper + "?" + rsLower + "+" + rsOptLowerContr + "(?=" + [
			rsBreak,
			rsUpper,
			"$"
		].join("|") + ")",
		rsUpperMisc + "+" + rsOptUpperContr + "(?=" + [
			rsBreak,
			rsUpper + rsLowerMisc,
			"$"
		].join("|") + ")",
		rsUpper + "?" + rsLowerMisc + "+" + rsOptLowerContr,
		rsUpper + "+" + rsOptUpperContr,
		rsDigits,
		rsEmoji
	].join("|"), "g");
	/** Used to detect strings with [zero-width joiners or code points from the astral planes](http://eev.ee/blog/2015/09/12/dark-corners-of-unicode/). */
	var reHasUnicode = RegExp("[" + rsZWJ + rsAstralRange + rsComboMarksRange + rsComboSymbolsRange + rsVarRange + "]");
	/** Used to detect strings that need a more robust regexp to match words. */
	var reHasUnicodeWord = /[a-z][A-Z]|[A-Z]{2,}[a-z]|[0-9][a-zA-Z]|[a-zA-Z][0-9]|[^a-zA-Z0-9 ]/;
	/** Used to map Latin Unicode letters to basic Latin letters. */
	var deburredLetters = {
		"À": "A",
		"Á": "A",
		"Â": "A",
		"Ã": "A",
		"Ä": "A",
		"Å": "A",
		"à": "a",
		"á": "a",
		"â": "a",
		"ã": "a",
		"ä": "a",
		"å": "a",
		"Ç": "C",
		"ç": "c",
		"Ð": "D",
		"ð": "d",
		"È": "E",
		"É": "E",
		"Ê": "E",
		"Ë": "E",
		"è": "e",
		"é": "e",
		"ê": "e",
		"ë": "e",
		"Ì": "I",
		"Í": "I",
		"Î": "I",
		"Ï": "I",
		"ì": "i",
		"í": "i",
		"î": "i",
		"ï": "i",
		"Ñ": "N",
		"ñ": "n",
		"Ò": "O",
		"Ó": "O",
		"Ô": "O",
		"Õ": "O",
		"Ö": "O",
		"Ø": "O",
		"ò": "o",
		"ó": "o",
		"ô": "o",
		"õ": "o",
		"ö": "o",
		"ø": "o",
		"Ù": "U",
		"Ú": "U",
		"Û": "U",
		"Ü": "U",
		"ù": "u",
		"ú": "u",
		"û": "u",
		"ü": "u",
		"Ý": "Y",
		"ý": "y",
		"ÿ": "y",
		"Æ": "Ae",
		"æ": "ae",
		"Þ": "Th",
		"þ": "th",
		"ß": "ss",
		"Ā": "A",
		"Ă": "A",
		"Ą": "A",
		"ā": "a",
		"ă": "a",
		"ą": "a",
		"Ć": "C",
		"Ĉ": "C",
		"Ċ": "C",
		"Č": "C",
		"ć": "c",
		"ĉ": "c",
		"ċ": "c",
		"č": "c",
		"Ď": "D",
		"Đ": "D",
		"ď": "d",
		"đ": "d",
		"Ē": "E",
		"Ĕ": "E",
		"Ė": "E",
		"Ę": "E",
		"Ě": "E",
		"ē": "e",
		"ĕ": "e",
		"ė": "e",
		"ę": "e",
		"ě": "e",
		"Ĝ": "G",
		"Ğ": "G",
		"Ġ": "G",
		"Ģ": "G",
		"ĝ": "g",
		"ğ": "g",
		"ġ": "g",
		"ģ": "g",
		"Ĥ": "H",
		"Ħ": "H",
		"ĥ": "h",
		"ħ": "h",
		"Ĩ": "I",
		"Ī": "I",
		"Ĭ": "I",
		"Į": "I",
		"İ": "I",
		"ĩ": "i",
		"ī": "i",
		"ĭ": "i",
		"į": "i",
		"ı": "i",
		"Ĵ": "J",
		"ĵ": "j",
		"Ķ": "K",
		"ķ": "k",
		"ĸ": "k",
		"Ĺ": "L",
		"Ļ": "L",
		"Ľ": "L",
		"Ŀ": "L",
		"Ł": "L",
		"ĺ": "l",
		"ļ": "l",
		"ľ": "l",
		"ŀ": "l",
		"ł": "l",
		"Ń": "N",
		"Ņ": "N",
		"Ň": "N",
		"Ŋ": "N",
		"ń": "n",
		"ņ": "n",
		"ň": "n",
		"ŋ": "n",
		"Ō": "O",
		"Ŏ": "O",
		"Ő": "O",
		"ō": "o",
		"ŏ": "o",
		"ő": "o",
		"Ŕ": "R",
		"Ŗ": "R",
		"Ř": "R",
		"ŕ": "r",
		"ŗ": "r",
		"ř": "r",
		"Ś": "S",
		"Ŝ": "S",
		"Ş": "S",
		"Š": "S",
		"ś": "s",
		"ŝ": "s",
		"ş": "s",
		"š": "s",
		"Ţ": "T",
		"Ť": "T",
		"Ŧ": "T",
		"ţ": "t",
		"ť": "t",
		"ŧ": "t",
		"Ũ": "U",
		"Ū": "U",
		"Ŭ": "U",
		"Ů": "U",
		"Ű": "U",
		"Ų": "U",
		"ũ": "u",
		"ū": "u",
		"ŭ": "u",
		"ů": "u",
		"ű": "u",
		"ų": "u",
		"Ŵ": "W",
		"ŵ": "w",
		"Ŷ": "Y",
		"ŷ": "y",
		"Ÿ": "Y",
		"Ź": "Z",
		"Ż": "Z",
		"Ž": "Z",
		"ź": "z",
		"ż": "z",
		"ž": "z",
		"Ĳ": "IJ",
		"ĳ": "ij",
		"Œ": "Oe",
		"œ": "oe",
		"ŉ": "'n",
		"ſ": "ss"
	};
	/** Detect free variable `global` from Node.js. */
	var freeGlobal = typeof global == "object" && global && global.Object === Object && global;
	/** Detect free variable `self`. */
	var freeSelf = typeof self == "object" && self && self.Object === Object && self;
	/** Used as a reference to the global object. */
	var root = freeGlobal || freeSelf || Function("return this")();
	/**
	* A specialized version of `_.reduce` for arrays without support for
	* iteratee shorthands.
	*
	* @private
	* @param {Array} [array] The array to iterate over.
	* @param {Function} iteratee The function invoked per iteration.
	* @param {*} [accumulator] The initial value.
	* @param {boolean} [initAccum] Specify using the first element of `array` as
	*  the initial value.
	* @returns {*} Returns the accumulated value.
	*/
	function arrayReduce(array, iteratee, accumulator, initAccum) {
		var index = -1, length = array ? array.length : 0;
		if (initAccum && length) accumulator = array[++index];
		while (++index < length) accumulator = iteratee(accumulator, array[index], index, array);
		return accumulator;
	}
	/**
	* Converts an ASCII `string` to an array.
	*
	* @private
	* @param {string} string The string to convert.
	* @returns {Array} Returns the converted array.
	*/
	function asciiToArray(string) {
		return string.split("");
	}
	/**
	* Splits an ASCII `string` into an array of its words.
	*
	* @private
	* @param {string} The string to inspect.
	* @returns {Array} Returns the words of `string`.
	*/
	function asciiWords(string) {
		return string.match(reAsciiWord) || [];
	}
	/**
	* The base implementation of `_.propertyOf` without support for deep paths.
	*
	* @private
	* @param {Object} object The object to query.
	* @returns {Function} Returns the new accessor function.
	*/
	function basePropertyOf(object) {
		return function(key) {
			return object == null ? void 0 : object[key];
		};
	}
	/**
	* Used by `_.deburr` to convert Latin-1 Supplement and Latin Extended-A
	* letters to basic Latin letters.
	*
	* @private
	* @param {string} letter The matched letter to deburr.
	* @returns {string} Returns the deburred letter.
	*/
	var deburrLetter = basePropertyOf(deburredLetters);
	/**
	* Checks if `string` contains Unicode symbols.
	*
	* @private
	* @param {string} string The string to inspect.
	* @returns {boolean} Returns `true` if a symbol is found, else `false`.
	*/
	function hasUnicode(string) {
		return reHasUnicode.test(string);
	}
	/**
	* Checks if `string` contains a word composed of Unicode symbols.
	*
	* @private
	* @param {string} string The string to inspect.
	* @returns {boolean} Returns `true` if a word is found, else `false`.
	*/
	function hasUnicodeWord(string) {
		return reHasUnicodeWord.test(string);
	}
	/**
	* Converts `string` to an array.
	*
	* @private
	* @param {string} string The string to convert.
	* @returns {Array} Returns the converted array.
	*/
	function stringToArray(string) {
		return hasUnicode(string) ? unicodeToArray(string) : asciiToArray(string);
	}
	/**
	* Converts a Unicode `string` to an array.
	*
	* @private
	* @param {string} string The string to convert.
	* @returns {Array} Returns the converted array.
	*/
	function unicodeToArray(string) {
		return string.match(reUnicode) || [];
	}
	/**
	* Splits a Unicode `string` into an array of its words.
	*
	* @private
	* @param {string} The string to inspect.
	* @returns {Array} Returns the words of `string`.
	*/
	function unicodeWords(string) {
		return string.match(reUnicodeWord) || [];
	}
	/**
	* Used to resolve the
	* [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
	* of values.
	*/
	var objectToString = Object.prototype.toString;
	/** Built-in value references. */
	var Symbol = root.Symbol;
	/** Used to convert symbols to primitives and strings. */
	var symbolProto = Symbol ? Symbol.prototype : void 0, symbolToString = symbolProto ? symbolProto.toString : void 0;
	/**
	* The base implementation of `_.slice` without an iteratee call guard.
	*
	* @private
	* @param {Array} array The array to slice.
	* @param {number} [start=0] The start position.
	* @param {number} [end=array.length] The end position.
	* @returns {Array} Returns the slice of `array`.
	*/
	function baseSlice(array, start, end) {
		var index = -1, length = array.length;
		if (start < 0) start = -start > length ? 0 : length + start;
		end = end > length ? length : end;
		if (end < 0) end += length;
		length = start > end ? 0 : end - start >>> 0;
		start >>>= 0;
		var result = Array(length);
		while (++index < length) result[index] = array[index + start];
		return result;
	}
	/**
	* The base implementation of `_.toString` which doesn't convert nullish
	* values to empty strings.
	*
	* @private
	* @param {*} value The value to process.
	* @returns {string} Returns the string.
	*/
	function baseToString(value) {
		if (typeof value == "string") return value;
		if (isSymbol(value)) return symbolToString ? symbolToString.call(value) : "";
		var result = value + "";
		return result == "0" && 1 / value == -INFINITY ? "-0" : result;
	}
	/**
	* Casts `array` to a slice if it's needed.
	*
	* @private
	* @param {Array} array The array to inspect.
	* @param {number} start The start position.
	* @param {number} [end=array.length] The end position.
	* @returns {Array} Returns the cast slice.
	*/
	function castSlice(array, start, end) {
		var length = array.length;
		end = end === void 0 ? length : end;
		return !start && end >= length ? array : baseSlice(array, start, end);
	}
	/**
	* Creates a function like `_.lowerFirst`.
	*
	* @private
	* @param {string} methodName The name of the `String` case method to use.
	* @returns {Function} Returns the new case function.
	*/
	function createCaseFirst(methodName) {
		return function(string) {
			string = toString(string);
			var strSymbols = hasUnicode(string) ? stringToArray(string) : void 0;
			var chr = strSymbols ? strSymbols[0] : string.charAt(0);
			var trailing = strSymbols ? castSlice(strSymbols, 1).join("") : string.slice(1);
			return chr[methodName]() + trailing;
		};
	}
	/**
	* Creates a function like `_.camelCase`.
	*
	* @private
	* @param {Function} callback The function to combine each word.
	* @returns {Function} Returns the new compounder function.
	*/
	function createCompounder(callback) {
		return function(string) {
			return arrayReduce(words(deburr(string).replace(reApos, "")), callback, "");
		};
	}
	/**
	* Checks if `value` is object-like. A value is object-like if it's not `null`
	* and has a `typeof` result of "object".
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is object-like, else `false`.
	* @example
	*
	* _.isObjectLike({});
	* // => true
	*
	* _.isObjectLike([1, 2, 3]);
	* // => true
	*
	* _.isObjectLike(_.noop);
	* // => false
	*
	* _.isObjectLike(null);
	* // => false
	*/
	function isObjectLike(value) {
		return !!value && typeof value == "object";
	}
	/**
	* Checks if `value` is classified as a `Symbol` primitive or object.
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is a symbol, else `false`.
	* @example
	*
	* _.isSymbol(Symbol.iterator);
	* // => true
	*
	* _.isSymbol('abc');
	* // => false
	*/
	function isSymbol(value) {
		return typeof value == "symbol" || isObjectLike(value) && objectToString.call(value) == symbolTag;
	}
	/**
	* Converts `value` to a string. An empty string is returned for `null`
	* and `undefined` values. The sign of `-0` is preserved.
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to process.
	* @returns {string} Returns the string.
	* @example
	*
	* _.toString(null);
	* // => ''
	*
	* _.toString(-0);
	* // => '-0'
	*
	* _.toString([1, 2, 3]);
	* // => '1,2,3'
	*/
	function toString(value) {
		return value == null ? "" : baseToString(value);
	}
	/**
	* Converts `string` to [camel case](https://en.wikipedia.org/wiki/CamelCase).
	*
	* @static
	* @memberOf _
	* @since 3.0.0
	* @category String
	* @param {string} [string=''] The string to convert.
	* @returns {string} Returns the camel cased string.
	* @example
	*
	* _.camelCase('Foo Bar');
	* // => 'fooBar'
	*
	* _.camelCase('--foo-bar--');
	* // => 'fooBar'
	*
	* _.camelCase('__FOO_BAR__');
	* // => 'fooBar'
	*/
	var camelCase = createCompounder(function(result, word, index) {
		word = word.toLowerCase();
		return result + (index ? capitalize(word) : word);
	});
	/**
	* Converts the first character of `string` to upper case and the remaining
	* to lower case.
	*
	* @static
	* @memberOf _
	* @since 3.0.0
	* @category String
	* @param {string} [string=''] The string to capitalize.
	* @returns {string} Returns the capitalized string.
	* @example
	*
	* _.capitalize('FRED');
	* // => 'Fred'
	*/
	function capitalize(string) {
		return upperFirst(toString(string).toLowerCase());
	}
	/**
	* Deburrs `string` by converting
	* [Latin-1 Supplement](https://en.wikipedia.org/wiki/Latin-1_Supplement_(Unicode_block)#Character_table)
	* and [Latin Extended-A](https://en.wikipedia.org/wiki/Latin_Extended-A)
	* letters to basic Latin letters and removing
	* [combining diacritical marks](https://en.wikipedia.org/wiki/Combining_Diacritical_Marks).
	*
	* @static
	* @memberOf _
	* @since 3.0.0
	* @category String
	* @param {string} [string=''] The string to deburr.
	* @returns {string} Returns the deburred string.
	* @example
	*
	* _.deburr('déjà vu');
	* // => 'deja vu'
	*/
	function deburr(string) {
		string = toString(string);
		return string && string.replace(reLatin, deburrLetter).replace(reComboMark, "");
	}
	/**
	* Converts the first character of `string` to upper case.
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category String
	* @param {string} [string=''] The string to convert.
	* @returns {string} Returns the converted string.
	* @example
	*
	* _.upperFirst('fred');
	* // => 'Fred'
	*
	* _.upperFirst('FRED');
	* // => 'FRED'
	*/
	var upperFirst = createCaseFirst("toUpperCase");
	/**
	* Splits `string` into an array of its words.
	*
	* @static
	* @memberOf _
	* @since 3.0.0
	* @category String
	* @param {string} [string=''] The string to inspect.
	* @param {RegExp|string} [pattern] The pattern to match words.
	* @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
	* @returns {Array} Returns the words of `string`.
	* @example
	*
	* _.words('fred, barney, & pebbles');
	* // => ['fred', 'barney', 'pebbles']
	*
	* _.words('fred, barney, & pebbles', /[^, ]+/g);
	* // => ['fred', 'barney', '&', 'pebbles']
	*/
	function words(string, pattern, guard) {
		string = toString(string);
		pattern = guard ? void 0 : pattern;
		if (pattern === void 0) return hasUnicodeWord(string) ? unicodeWords(string) : asciiWords(string);
		return string.match(pattern) || [];
	}
	module.exports = camelCase;
}));
//#endregion
//#region ../../node_modules/.pnpm/@protobufjs+aspromise@1.1.2/node_modules/@protobufjs/aspromise/index.js
var require_aspromise = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = asPromise;
	/**
	* Callback as used by {@link util.asPromise}.
	* @typedef asPromiseCallback
	* @type {function}
	* @param {Error|null} error Error, if any
	* @param {...*} params Additional arguments
	* @returns {undefined}
	*/
	/**
	* Returns a promise from a node-style callback function.
	* @memberof util
	* @param {asPromiseCallback} fn Function to call
	* @param {*} ctx Function context
	* @param {...*} params Function arguments
	* @returns {Promise<*>} Promisified function
	*/
	function asPromise(fn, ctx) {
		var params = new Array(arguments.length - 1), offset = 0, index = 2, pending = true;
		while (index < arguments.length) params[offset++] = arguments[index++];
		return new Promise(function executor(resolve, reject) {
			params[offset] = function callback(err) {
				if (pending) {
					pending = false;
					if (err) reject(err);
					else {
						var params = new Array(arguments.length - 1), offset = 0;
						while (offset < params.length) params[offset++] = arguments[offset];
						resolve.apply(null, params);
					}
				}
			};
			try {
				fn.apply(ctx || null, params);
			} catch (err) {
				if (pending) {
					pending = false;
					reject(err);
				}
			}
		});
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@protobufjs+base64@1.1.2/node_modules/@protobufjs/base64/index.js
var require_base64 = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* A minimal base64 implementation for number arrays.
	* @memberof util
	* @namespace
	*/
	var base64 = exports;
	/**
	* Calculates the byte length of a base64 encoded string.
	* @param {string} string Base64 encoded string
	* @returns {number} Byte length
	*/
	base64.length = function length(string) {
		var p = string.length;
		if (!p) return 0;
		var n = 0;
		while (--p % 4 > 1 && string.charAt(p) === "=") ++n;
		return Math.ceil(string.length * 3) / 4 - n;
	};
	var b64 = new Array(64);
	var s64 = new Array(123);
	for (var i = 0; i < 64;) s64[b64[i] = i < 26 ? i + 65 : i < 52 ? i + 71 : i < 62 ? i - 4 : i - 59 | 43] = i++;
	/**
	* Encodes a buffer to a base64 encoded string.
	* @param {Uint8Array} buffer Source buffer
	* @param {number} start Source start
	* @param {number} end Source end
	* @returns {string} Base64 encoded string
	*/
	base64.encode = function encode(buffer, start, end) {
		var parts = null, chunk = [];
		var i = 0, j = 0, t;
		while (start < end) {
			var b = buffer[start++];
			switch (j) {
				case 0:
					chunk[i++] = b64[b >> 2];
					t = (b & 3) << 4;
					j = 1;
					break;
				case 1:
					chunk[i++] = b64[t | b >> 4];
					t = (b & 15) << 2;
					j = 2;
					break;
				case 2:
					chunk[i++] = b64[t | b >> 6];
					chunk[i++] = b64[b & 63];
					j = 0;
					break;
			}
			if (i > 8191) {
				(parts || (parts = [])).push(String.fromCharCode.apply(String, chunk));
				i = 0;
			}
		}
		if (j) {
			chunk[i++] = b64[t];
			chunk[i++] = 61;
			if (j === 1) chunk[i++] = 61;
		}
		if (parts) {
			if (i) parts.push(String.fromCharCode.apply(String, chunk.slice(0, i)));
			return parts.join("");
		}
		return String.fromCharCode.apply(String, chunk.slice(0, i));
	};
	var invalidEncoding = "invalid encoding";
	/**
	* Decodes a base64 encoded string to a buffer.
	* @param {string} string Source string
	* @param {Uint8Array} buffer Destination buffer
	* @param {number} offset Destination offset
	* @returns {number} Number of bytes written
	* @throws {Error} If encoding is invalid
	*/
	base64.decode = function decode(string, buffer, offset) {
		var start = offset;
		var j = 0, t;
		for (var i = 0; i < string.length;) {
			var c = string.charCodeAt(i++);
			if (c === 61 && j > 1) break;
			if ((c = s64[c]) === void 0) throw Error(invalidEncoding);
			switch (j) {
				case 0:
					t = c;
					j = 1;
					break;
				case 1:
					buffer[offset++] = t << 2 | (c & 48) >> 4;
					t = c;
					j = 2;
					break;
				case 2:
					buffer[offset++] = (t & 15) << 4 | (c & 60) >> 2;
					t = c;
					j = 3;
					break;
				case 3:
					buffer[offset++] = (t & 3) << 6 | c;
					j = 0;
					break;
			}
		}
		if (j === 1) throw Error(invalidEncoding);
		return offset - start;
	};
	/**
	* Tests if the specified string appears to be base64 encoded.
	* @param {string} string String to test
	* @returns {boolean} `true` if probably base64 encoded, otherwise false
	*/
	base64.test = function test(string) {
		return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(string);
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@protobufjs+eventemitter@1.1.0/node_modules/@protobufjs/eventemitter/index.js
var require_eventemitter = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = EventEmitter;
	/**
	* Constructs a new event emitter instance.
	* @classdesc A minimal event emitter.
	* @memberof util
	* @constructor
	*/
	function EventEmitter() {
		/**
		* Registered listeners.
		* @type {Object.<string,*>}
		* @private
		*/
		this._listeners = {};
	}
	/**
	* Registers an event listener.
	* @param {string} evt Event name
	* @param {function} fn Listener
	* @param {*} [ctx] Listener context
	* @returns {util.EventEmitter} `this`
	*/
	EventEmitter.prototype.on = function on(evt, fn, ctx) {
		(this._listeners[evt] || (this._listeners[evt] = [])).push({
			fn,
			ctx: ctx || this
		});
		return this;
	};
	/**
	* Removes an event listener or any matching listeners if arguments are omitted.
	* @param {string} [evt] Event name. Removes all listeners if omitted.
	* @param {function} [fn] Listener to remove. Removes all listeners of `evt` if omitted.
	* @returns {util.EventEmitter} `this`
	*/
	EventEmitter.prototype.off = function off(evt, fn) {
		if (evt === void 0) this._listeners = {};
		else if (fn === void 0) this._listeners[evt] = [];
		else {
			var listeners = this._listeners[evt];
			for (var i = 0; i < listeners.length;) if (listeners[i].fn === fn) listeners.splice(i, 1);
			else ++i;
		}
		return this;
	};
	/**
	* Emits an event by calling its listeners with the specified arguments.
	* @param {string} evt Event name
	* @param {...*} args Arguments
	* @returns {util.EventEmitter} `this`
	*/
	EventEmitter.prototype.emit = function emit(evt) {
		var listeners = this._listeners[evt];
		if (listeners) {
			var args = [], i = 1;
			for (; i < arguments.length;) args.push(arguments[i++]);
			for (i = 0; i < listeners.length;) listeners[i].fn.apply(listeners[i++].ctx, args);
		}
		return this;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@protobufjs+float@1.0.2/node_modules/@protobufjs/float/index.js
var require_float = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = factory(factory);
	/**
	* Reads / writes floats / doubles from / to buffers.
	* @name util.float
	* @namespace
	*/
	/**
	* Writes a 32 bit float to a buffer using little endian byte order.
	* @name util.float.writeFloatLE
	* @function
	* @param {number} val Value to write
	* @param {Uint8Array} buf Target buffer
	* @param {number} pos Target buffer offset
	* @returns {undefined}
	*/
	/**
	* Writes a 32 bit float to a buffer using big endian byte order.
	* @name util.float.writeFloatBE
	* @function
	* @param {number} val Value to write
	* @param {Uint8Array} buf Target buffer
	* @param {number} pos Target buffer offset
	* @returns {undefined}
	*/
	/**
	* Reads a 32 bit float from a buffer using little endian byte order.
	* @name util.float.readFloatLE
	* @function
	* @param {Uint8Array} buf Source buffer
	* @param {number} pos Source buffer offset
	* @returns {number} Value read
	*/
	/**
	* Reads a 32 bit float from a buffer using big endian byte order.
	* @name util.float.readFloatBE
	* @function
	* @param {Uint8Array} buf Source buffer
	* @param {number} pos Source buffer offset
	* @returns {number} Value read
	*/
	/**
	* Writes a 64 bit double to a buffer using little endian byte order.
	* @name util.float.writeDoubleLE
	* @function
	* @param {number} val Value to write
	* @param {Uint8Array} buf Target buffer
	* @param {number} pos Target buffer offset
	* @returns {undefined}
	*/
	/**
	* Writes a 64 bit double to a buffer using big endian byte order.
	* @name util.float.writeDoubleBE
	* @function
	* @param {number} val Value to write
	* @param {Uint8Array} buf Target buffer
	* @param {number} pos Target buffer offset
	* @returns {undefined}
	*/
	/**
	* Reads a 64 bit double from a buffer using little endian byte order.
	* @name util.float.readDoubleLE
	* @function
	* @param {Uint8Array} buf Source buffer
	* @param {number} pos Source buffer offset
	* @returns {number} Value read
	*/
	/**
	* Reads a 64 bit double from a buffer using big endian byte order.
	* @name util.float.readDoubleBE
	* @function
	* @param {Uint8Array} buf Source buffer
	* @param {number} pos Source buffer offset
	* @returns {number} Value read
	*/
	function factory(exports$4) {
		if (typeof Float32Array !== "undefined") (function() {
			var f32 = new Float32Array([-0]), f8b = new Uint8Array(f32.buffer), le = f8b[3] === 128;
			function writeFloat_f32_cpy(val, buf, pos) {
				f32[0] = val;
				buf[pos] = f8b[0];
				buf[pos + 1] = f8b[1];
				buf[pos + 2] = f8b[2];
				buf[pos + 3] = f8b[3];
			}
			function writeFloat_f32_rev(val, buf, pos) {
				f32[0] = val;
				buf[pos] = f8b[3];
				buf[pos + 1] = f8b[2];
				buf[pos + 2] = f8b[1];
				buf[pos + 3] = f8b[0];
			}
			/* istanbul ignore next */
			exports$4.writeFloatLE = le ? writeFloat_f32_cpy : writeFloat_f32_rev;
			/* istanbul ignore next */
			exports$4.writeFloatBE = le ? writeFloat_f32_rev : writeFloat_f32_cpy;
			function readFloat_f32_cpy(buf, pos) {
				f8b[0] = buf[pos];
				f8b[1] = buf[pos + 1];
				f8b[2] = buf[pos + 2];
				f8b[3] = buf[pos + 3];
				return f32[0];
			}
			function readFloat_f32_rev(buf, pos) {
				f8b[3] = buf[pos];
				f8b[2] = buf[pos + 1];
				f8b[1] = buf[pos + 2];
				f8b[0] = buf[pos + 3];
				return f32[0];
			}
			/* istanbul ignore next */
			exports$4.readFloatLE = le ? readFloat_f32_cpy : readFloat_f32_rev;
			/* istanbul ignore next */
			exports$4.readFloatBE = le ? readFloat_f32_rev : readFloat_f32_cpy;
		})();
		else (function() {
			function writeFloat_ieee754(writeUint, val, buf, pos) {
				var sign = val < 0 ? 1 : 0;
				if (sign) val = -val;
				if (val === 0) writeUint(1 / val > 0 ? 0 : 2147483648, buf, pos);
				else if (isNaN(val)) writeUint(2143289344, buf, pos);
				else if (val > 34028234663852886e22) writeUint((sign << 31 | 2139095040) >>> 0, buf, pos);
				else if (val < 11754943508222875e-54) writeUint((sign << 31 | Math.round(val / 1401298464324817e-60)) >>> 0, buf, pos);
				else {
					var exponent = Math.floor(Math.log(val) / Math.LN2), mantissa = Math.round(val * Math.pow(2, -exponent) * 8388608) & 8388607;
					writeUint((sign << 31 | exponent + 127 << 23 | mantissa) >>> 0, buf, pos);
				}
			}
			exports$4.writeFloatLE = writeFloat_ieee754.bind(null, writeUintLE);
			exports$4.writeFloatBE = writeFloat_ieee754.bind(null, writeUintBE);
			function readFloat_ieee754(readUint, buf, pos) {
				var uint = readUint(buf, pos), sign = (uint >> 31) * 2 + 1, exponent = uint >>> 23 & 255, mantissa = uint & 8388607;
				return exponent === 255 ? mantissa ? NaN : sign * Infinity : exponent === 0 ? sign * 1401298464324817e-60 * mantissa : sign * Math.pow(2, exponent - 150) * (mantissa + 8388608);
			}
			exports$4.readFloatLE = readFloat_ieee754.bind(null, readUintLE);
			exports$4.readFloatBE = readFloat_ieee754.bind(null, readUintBE);
		})();
		if (typeof Float64Array !== "undefined") (function() {
			var f64 = new Float64Array([-0]), f8b = new Uint8Array(f64.buffer), le = f8b[7] === 128;
			function writeDouble_f64_cpy(val, buf, pos) {
				f64[0] = val;
				buf[pos] = f8b[0];
				buf[pos + 1] = f8b[1];
				buf[pos + 2] = f8b[2];
				buf[pos + 3] = f8b[3];
				buf[pos + 4] = f8b[4];
				buf[pos + 5] = f8b[5];
				buf[pos + 6] = f8b[6];
				buf[pos + 7] = f8b[7];
			}
			function writeDouble_f64_rev(val, buf, pos) {
				f64[0] = val;
				buf[pos] = f8b[7];
				buf[pos + 1] = f8b[6];
				buf[pos + 2] = f8b[5];
				buf[pos + 3] = f8b[4];
				buf[pos + 4] = f8b[3];
				buf[pos + 5] = f8b[2];
				buf[pos + 6] = f8b[1];
				buf[pos + 7] = f8b[0];
			}
			/* istanbul ignore next */
			exports$4.writeDoubleLE = le ? writeDouble_f64_cpy : writeDouble_f64_rev;
			/* istanbul ignore next */
			exports$4.writeDoubleBE = le ? writeDouble_f64_rev : writeDouble_f64_cpy;
			function readDouble_f64_cpy(buf, pos) {
				f8b[0] = buf[pos];
				f8b[1] = buf[pos + 1];
				f8b[2] = buf[pos + 2];
				f8b[3] = buf[pos + 3];
				f8b[4] = buf[pos + 4];
				f8b[5] = buf[pos + 5];
				f8b[6] = buf[pos + 6];
				f8b[7] = buf[pos + 7];
				return f64[0];
			}
			function readDouble_f64_rev(buf, pos) {
				f8b[7] = buf[pos];
				f8b[6] = buf[pos + 1];
				f8b[5] = buf[pos + 2];
				f8b[4] = buf[pos + 3];
				f8b[3] = buf[pos + 4];
				f8b[2] = buf[pos + 5];
				f8b[1] = buf[pos + 6];
				f8b[0] = buf[pos + 7];
				return f64[0];
			}
			/* istanbul ignore next */
			exports$4.readDoubleLE = le ? readDouble_f64_cpy : readDouble_f64_rev;
			/* istanbul ignore next */
			exports$4.readDoubleBE = le ? readDouble_f64_rev : readDouble_f64_cpy;
		})();
		else (function() {
			function writeDouble_ieee754(writeUint, off0, off1, val, buf, pos) {
				var sign = val < 0 ? 1 : 0;
				if (sign) val = -val;
				if (val === 0) {
					writeUint(0, buf, pos + off0);
					writeUint(1 / val > 0 ? 0 : 2147483648, buf, pos + off1);
				} else if (isNaN(val)) {
					writeUint(0, buf, pos + off0);
					writeUint(2146959360, buf, pos + off1);
				} else if (val > 17976931348623157e292) {
					writeUint(0, buf, pos + off0);
					writeUint((sign << 31 | 2146435072) >>> 0, buf, pos + off1);
				} else {
					var mantissa;
					if (val < 22250738585072014e-324) {
						mantissa = val / 5e-324;
						writeUint(mantissa >>> 0, buf, pos + off0);
						writeUint((sign << 31 | mantissa / 4294967296) >>> 0, buf, pos + off1);
					} else {
						var exponent = Math.floor(Math.log(val) / Math.LN2);
						if (exponent === 1024) exponent = 1023;
						mantissa = val * Math.pow(2, -exponent);
						writeUint(mantissa * 4503599627370496 >>> 0, buf, pos + off0);
						writeUint((sign << 31 | exponent + 1023 << 20 | mantissa * 1048576 & 1048575) >>> 0, buf, pos + off1);
					}
				}
			}
			exports$4.writeDoubleLE = writeDouble_ieee754.bind(null, writeUintLE, 0, 4);
			exports$4.writeDoubleBE = writeDouble_ieee754.bind(null, writeUintBE, 4, 0);
			function readDouble_ieee754(readUint, off0, off1, buf, pos) {
				var lo = readUint(buf, pos + off0), hi = readUint(buf, pos + off1);
				var sign = (hi >> 31) * 2 + 1, exponent = hi >>> 20 & 2047, mantissa = 4294967296 * (hi & 1048575) + lo;
				return exponent === 2047 ? mantissa ? NaN : sign * Infinity : exponent === 0 ? sign * 5e-324 * mantissa : sign * Math.pow(2, exponent - 1075) * (mantissa + 4503599627370496);
			}
			exports$4.readDoubleLE = readDouble_ieee754.bind(null, readUintLE, 0, 4);
			exports$4.readDoubleBE = readDouble_ieee754.bind(null, readUintBE, 4, 0);
		})();
		return exports$4;
	}
	function writeUintLE(val, buf, pos) {
		buf[pos] = val & 255;
		buf[pos + 1] = val >>> 8 & 255;
		buf[pos + 2] = val >>> 16 & 255;
		buf[pos + 3] = val >>> 24;
	}
	function writeUintBE(val, buf, pos) {
		buf[pos] = val >>> 24;
		buf[pos + 1] = val >>> 16 & 255;
		buf[pos + 2] = val >>> 8 & 255;
		buf[pos + 3] = val & 255;
	}
	function readUintLE(buf, pos) {
		return (buf[pos] | buf[pos + 1] << 8 | buf[pos + 2] << 16 | buf[pos + 3] << 24) >>> 0;
	}
	function readUintBE(buf, pos) {
		return (buf[pos] << 24 | buf[pos + 1] << 16 | buf[pos + 2] << 8 | buf[pos + 3]) >>> 0;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@protobufjs+inquire@1.1.0/node_modules/@protobufjs/inquire/index.js
var require_inquire = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = inquire;
	/**
	* Requires a module only if available.
	* @memberof util
	* @param {string} moduleName Module to require
	* @returns {?Object} Required module if available and not empty, otherwise `null`
	*/
	function inquire(moduleName) {
		try {
			var mod = eval("quire".replace(/^/, "re"))(moduleName);
			if (mod && (mod.length || Object.keys(mod).length)) return mod;
		} catch (e) {}
		return null;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@protobufjs+utf8@1.1.0/node_modules/@protobufjs/utf8/index.js
var require_utf8 = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* A minimal UTF8 implementation for number arrays.
	* @memberof util
	* @namespace
	*/
	var utf8 = exports;
	/**
	* Calculates the UTF8 byte length of a string.
	* @param {string} string String
	* @returns {number} Byte length
	*/
	utf8.length = function utf8_length(string) {
		var len = 0, c = 0;
		for (var i = 0; i < string.length; ++i) {
			c = string.charCodeAt(i);
			if (c < 128) len += 1;
			else if (c < 2048) len += 2;
			else if ((c & 64512) === 55296 && (string.charCodeAt(i + 1) & 64512) === 56320) {
				++i;
				len += 4;
			} else len += 3;
		}
		return len;
	};
	/**
	* Reads UTF8 bytes as a string.
	* @param {Uint8Array} buffer Source buffer
	* @param {number} start Source start
	* @param {number} end Source end
	* @returns {string} String read
	*/
	utf8.read = function utf8_read(buffer, start, end) {
		if (end - start < 1) return "";
		var parts = null, chunk = [], i = 0, t;
		while (start < end) {
			t = buffer[start++];
			if (t < 128) chunk[i++] = t;
			else if (t > 191 && t < 224) chunk[i++] = (t & 31) << 6 | buffer[start++] & 63;
			else if (t > 239 && t < 365) {
				t = ((t & 7) << 18 | (buffer[start++] & 63) << 12 | (buffer[start++] & 63) << 6 | buffer[start++] & 63) - 65536;
				chunk[i++] = 55296 + (t >> 10);
				chunk[i++] = 56320 + (t & 1023);
			} else chunk[i++] = (t & 15) << 12 | (buffer[start++] & 63) << 6 | buffer[start++] & 63;
			if (i > 8191) {
				(parts || (parts = [])).push(String.fromCharCode.apply(String, chunk));
				i = 0;
			}
		}
		if (parts) {
			if (i) parts.push(String.fromCharCode.apply(String, chunk.slice(0, i)));
			return parts.join("");
		}
		return String.fromCharCode.apply(String, chunk.slice(0, i));
	};
	/**
	* Writes a string as UTF8 bytes.
	* @param {string} string Source string
	* @param {Uint8Array} buffer Destination buffer
	* @param {number} offset Destination offset
	* @returns {number} Bytes written
	*/
	utf8.write = function utf8_write(string, buffer, offset) {
		var start = offset, c1, c2;
		for (var i = 0; i < string.length; ++i) {
			c1 = string.charCodeAt(i);
			if (c1 < 128) buffer[offset++] = c1;
			else if (c1 < 2048) {
				buffer[offset++] = c1 >> 6 | 192;
				buffer[offset++] = c1 & 63 | 128;
			} else if ((c1 & 64512) === 55296 && ((c2 = string.charCodeAt(i + 1)) & 64512) === 56320) {
				c1 = 65536 + ((c1 & 1023) << 10) + (c2 & 1023);
				++i;
				buffer[offset++] = c1 >> 18 | 240;
				buffer[offset++] = c1 >> 12 & 63 | 128;
				buffer[offset++] = c1 >> 6 & 63 | 128;
				buffer[offset++] = c1 & 63 | 128;
			} else {
				buffer[offset++] = c1 >> 12 | 224;
				buffer[offset++] = c1 >> 6 & 63 | 128;
				buffer[offset++] = c1 & 63 | 128;
			}
		}
		return offset - start;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@protobufjs+pool@1.1.0/node_modules/@protobufjs/pool/index.js
var require_pool = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = pool;
	/**
	* An allocator as used by {@link util.pool}.
	* @typedef PoolAllocator
	* @type {function}
	* @param {number} size Buffer size
	* @returns {Uint8Array} Buffer
	*/
	/**
	* A slicer as used by {@link util.pool}.
	* @typedef PoolSlicer
	* @type {function}
	* @param {number} start Start offset
	* @param {number} end End offset
	* @returns {Uint8Array} Buffer slice
	* @this {Uint8Array}
	*/
	/**
	* A general purpose buffer pool.
	* @memberof util
	* @function
	* @param {PoolAllocator} alloc Allocator
	* @param {PoolSlicer} slice Slicer
	* @param {number} [size=8192] Slab size
	* @returns {PoolAllocator} Pooled allocator
	*/
	function pool(alloc, slice, size) {
		var SIZE = size || 8192;
		var MAX = SIZE >>> 1;
		var slab = null;
		var offset = SIZE;
		return function pool_alloc(size) {
			if (size < 1 || size > MAX) return alloc(size);
			if (offset + size > SIZE) {
				slab = alloc(SIZE);
				offset = 0;
			}
			var buf = slice.call(slab, offset, offset += size);
			if (offset & 7) offset = (offset | 7) + 1;
			return buf;
		};
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/util/longbits.js
var require_longbits = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = LongBits;
	var util = require_minimal();
	/**
	* Constructs new long bits.
	* @classdesc Helper class for working with the low and high bits of a 64 bit value.
	* @memberof util
	* @constructor
	* @param {number} lo Low 32 bits, unsigned
	* @param {number} hi High 32 bits, unsigned
	*/
	function LongBits(lo, hi) {
		/**
		* Low bits.
		* @type {number}
		*/
		this.lo = lo >>> 0;
		/**
		* High bits.
		* @type {number}
		*/
		this.hi = hi >>> 0;
	}
	/**
	* Zero bits.
	* @memberof util.LongBits
	* @type {util.LongBits}
	*/
	var zero = LongBits.zero = new LongBits(0, 0);
	zero.toNumber = function() {
		return 0;
	};
	zero.zzEncode = zero.zzDecode = function() {
		return this;
	};
	zero.length = function() {
		return 1;
	};
	/**
	* Zero hash.
	* @memberof util.LongBits
	* @type {string}
	*/
	var zeroHash = LongBits.zeroHash = "\0\0\0\0\0\0\0\0";
	/**
	* Constructs new long bits from the specified number.
	* @param {number} value Value
	* @returns {util.LongBits} Instance
	*/
	LongBits.fromNumber = function fromNumber(value) {
		if (value === 0) return zero;
		var sign = value < 0;
		if (sign) value = -value;
		var lo = value >>> 0, hi = (value - lo) / 4294967296 >>> 0;
		if (sign) {
			hi = ~hi >>> 0;
			lo = ~lo >>> 0;
			if (++lo > 4294967295) {
				lo = 0;
				if (++hi > 4294967295) hi = 0;
			}
		}
		return new LongBits(lo, hi);
	};
	/**
	* Constructs new long bits from a number, long or string.
	* @param {Long|number|string} value Value
	* @returns {util.LongBits} Instance
	*/
	LongBits.from = function from(value) {
		if (typeof value === "number") return LongBits.fromNumber(value);
		if (util.isString(value))
 /* istanbul ignore else */
		if (util.Long) value = util.Long.fromString(value);
		else return LongBits.fromNumber(parseInt(value, 10));
		return value.low || value.high ? new LongBits(value.low >>> 0, value.high >>> 0) : zero;
	};
	/**
	* Converts this long bits to a possibly unsafe JavaScript number.
	* @param {boolean} [unsigned=false] Whether unsigned or not
	* @returns {number} Possibly unsafe number
	*/
	LongBits.prototype.toNumber = function toNumber(unsigned) {
		if (!unsigned && this.hi >>> 31) {
			var lo = ~this.lo + 1 >>> 0, hi = ~this.hi >>> 0;
			if (!lo) hi = hi + 1 >>> 0;
			return -(lo + hi * 4294967296);
		}
		return this.lo + this.hi * 4294967296;
	};
	/**
	* Converts this long bits to a long.
	* @param {boolean} [unsigned=false] Whether unsigned or not
	* @returns {Long} Long
	*/
	LongBits.prototype.toLong = function toLong(unsigned) {
		return util.Long ? new util.Long(this.lo | 0, this.hi | 0, Boolean(unsigned)) : {
			low: this.lo | 0,
			high: this.hi | 0,
			unsigned: Boolean(unsigned)
		};
	};
	var charCodeAt = String.prototype.charCodeAt;
	/**
	* Constructs new long bits from the specified 8 characters long hash.
	* @param {string} hash Hash
	* @returns {util.LongBits} Bits
	*/
	LongBits.fromHash = function fromHash(hash) {
		if (hash === zeroHash) return zero;
		return new LongBits((charCodeAt.call(hash, 0) | charCodeAt.call(hash, 1) << 8 | charCodeAt.call(hash, 2) << 16 | charCodeAt.call(hash, 3) << 24) >>> 0, (charCodeAt.call(hash, 4) | charCodeAt.call(hash, 5) << 8 | charCodeAt.call(hash, 6) << 16 | charCodeAt.call(hash, 7) << 24) >>> 0);
	};
	/**
	* Converts this long bits to a 8 characters long hash.
	* @returns {string} Hash
	*/
	LongBits.prototype.toHash = function toHash() {
		return String.fromCharCode(this.lo & 255, this.lo >>> 8 & 255, this.lo >>> 16 & 255, this.lo >>> 24, this.hi & 255, this.hi >>> 8 & 255, this.hi >>> 16 & 255, this.hi >>> 24);
	};
	/**
	* Zig-zag encodes this long bits.
	* @returns {util.LongBits} `this`
	*/
	LongBits.prototype.zzEncode = function zzEncode() {
		var mask = this.hi >> 31;
		this.hi = ((this.hi << 1 | this.lo >>> 31) ^ mask) >>> 0;
		this.lo = (this.lo << 1 ^ mask) >>> 0;
		return this;
	};
	/**
	* Zig-zag decodes this long bits.
	* @returns {util.LongBits} `this`
	*/
	LongBits.prototype.zzDecode = function zzDecode() {
		var mask = -(this.lo & 1);
		this.lo = ((this.lo >>> 1 | this.hi << 31) ^ mask) >>> 0;
		this.hi = (this.hi >>> 1 ^ mask) >>> 0;
		return this;
	};
	/**
	* Calculates the length of this longbits when encoded as a varint.
	* @returns {number} Length
	*/
	LongBits.prototype.length = function length() {
		var part0 = this.lo, part1 = (this.lo >>> 28 | this.hi << 4) >>> 0, part2 = this.hi >>> 24;
		return part2 === 0 ? part1 === 0 ? part0 < 16384 ? part0 < 128 ? 1 : 2 : part0 < 2097152 ? 3 : 4 : part1 < 16384 ? part1 < 128 ? 5 : 6 : part1 < 2097152 ? 7 : 8 : part2 < 128 ? 9 : 10;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/util/minimal.js
var require_minimal = /* @__PURE__ */ __commonJSMin(((exports) => {
	var util = exports;
	util.asPromise = require_aspromise();
	util.base64 = require_base64();
	util.EventEmitter = require_eventemitter();
	util.float = require_float();
	util.inquire = require_inquire();
	util.utf8 = require_utf8();
	util.pool = require_pool();
	util.LongBits = require_longbits();
	/**
	* Whether running within node or not.
	* @memberof util
	* @type {boolean}
	*/
	util.isNode = Boolean(typeof global !== "undefined" && global && global.process && global.process.versions && global.process.versions.node);
	/**
	* Global object reference.
	* @memberof util
	* @type {Object}
	*/
	util.global = util.isNode && global || typeof window !== "undefined" && window || typeof self !== "undefined" && self || exports;
	/**
	* An immuable empty array.
	* @memberof util
	* @type {Array.<*>}
	* @const
	*/
	util.emptyArray = Object.freeze ? Object.freeze([]) : [];
	/**
	* An immutable empty object.
	* @type {Object}
	* @const
	*/
	util.emptyObject = Object.freeze ? Object.freeze({}) : (	/* istanbul ignore next */ {});
	/**
	* Tests if the specified value is an integer.
	* @function
	* @param {*} value Value to test
	* @returns {boolean} `true` if the value is an integer
	*/
	util.isInteger = Number.isInteger || function isInteger(value) {
		return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
	};
	/**
	* Tests if the specified value is a string.
	* @param {*} value Value to test
	* @returns {boolean} `true` if the value is a string
	*/
	util.isString = function isString(value) {
		return typeof value === "string" || value instanceof String;
	};
	/**
	* Tests if the specified value is a non-null object.
	* @param {*} value Value to test
	* @returns {boolean} `true` if the value is a non-null object
	*/
	util.isObject = function isObject(value) {
		return value && typeof value === "object";
	};
	/**
	* Checks if a property on a message is considered to be present.
	* This is an alias of {@link util.isSet}.
	* @function
	* @param {Object} obj Plain object or message instance
	* @param {string} prop Property name
	* @returns {boolean} `true` if considered to be present, otherwise `false`
	*/
	util.isset = util.isSet = function isSet(obj, prop) {
		var value = obj[prop];
		if (value != null && obj.hasOwnProperty(prop)) return typeof value !== "object" || (Array.isArray(value) ? value.length : Object.keys(value).length) > 0;
		return false;
	};
	/**
	* Any compatible Buffer instance.
	* This is a minimal stand-alone definition of a Buffer instance. The actual type is that exported by node's typings.
	* @interface Buffer
	* @extends Uint8Array
	*/
	/**
	* Node's Buffer class if available.
	* @type {Constructor<Buffer>}
	*/
	util.Buffer = (function() {
		try {
			var Buffer = util.inquire("buffer").Buffer;
			return Buffer.prototype.utf8Write ? Buffer : null;
		} catch (e) {
			/* istanbul ignore next */
			return null;
		}
	})();
	util._Buffer_from = null;
	util._Buffer_allocUnsafe = null;
	/**
	* Creates a new buffer of whatever type supported by the environment.
	* @param {number|number[]} [sizeOrArray=0] Buffer size or number array
	* @returns {Uint8Array|Buffer} Buffer
	*/
	util.newBuffer = function newBuffer(sizeOrArray) {
		/* istanbul ignore next */
		return typeof sizeOrArray === "number" ? util.Buffer ? util._Buffer_allocUnsafe(sizeOrArray) : new util.Array(sizeOrArray) : util.Buffer ? util._Buffer_from(sizeOrArray) : typeof Uint8Array === "undefined" ? sizeOrArray : new Uint8Array(sizeOrArray);
	};
	/**
	* Array implementation used in the browser. `Uint8Array` if supported, otherwise `Array`.
	* @type {Constructor<Uint8Array>}
	*/
	util.Array = typeof Uint8Array !== "undefined" ? Uint8Array : Array;
	/**
	* Any compatible Long instance.
	* This is a minimal stand-alone definition of a Long instance. The actual type is that exported by long.js.
	* @interface Long
	* @property {number} low Low bits
	* @property {number} high High bits
	* @property {boolean} unsigned Whether unsigned or not
	*/
	/**
	* Long.js's Long class if available.
	* @type {Constructor<Long>}
	*/
	util.Long = util.global.dcodeIO && util.global.dcodeIO.Long || util.global.Long || util.inquire("long");
	/**
	* Regular expression used to verify 2 bit (`bool`) map keys.
	* @type {RegExp}
	* @const
	*/
	util.key2Re = /^true|false|0|1$/;
	/**
	* Regular expression used to verify 32 bit (`int32` etc.) map keys.
	* @type {RegExp}
	* @const
	*/
	util.key32Re = /^-?(?:0|[1-9][0-9]*)$/;
	/**
	* Regular expression used to verify 64 bit (`int64` etc.) map keys.
	* @type {RegExp}
	* @const
	*/
	util.key64Re = /^(?:[\\x00-\\xff]{8}|-?(?:0|[1-9][0-9]*))$/;
	/**
	* Converts a number or long to an 8 characters long hash string.
	* @param {Long|number} value Value to convert
	* @returns {string} Hash
	*/
	util.longToHash = function longToHash(value) {
		return value ? util.LongBits.from(value).toHash() : util.LongBits.zeroHash;
	};
	/**
	* Converts an 8 characters long hash string to a long or number.
	* @param {string} hash Hash
	* @param {boolean} [unsigned=false] Whether unsigned or not
	* @returns {Long|number} Original value
	*/
	util.longFromHash = function longFromHash(hash, unsigned) {
		var bits = util.LongBits.fromHash(hash);
		if (util.Long) return util.Long.fromBits(bits.lo, bits.hi, unsigned);
		return bits.toNumber(Boolean(unsigned));
	};
	/**
	* Merges the properties of the source object into the destination object.
	* @memberof util
	* @param {Object.<string,*>} dst Destination object
	* @param {Object.<string,*>} src Source object
	* @param {boolean} [ifNotSet=false] Merges only if the key is not already set
	* @returns {Object.<string,*>} Destination object
	*/
	function merge(dst, src, ifNotSet) {
		for (var keys = Object.keys(src), i = 0; i < keys.length; ++i) if (dst[keys[i]] === void 0 || !ifNotSet) dst[keys[i]] = src[keys[i]];
		return dst;
	}
	util.merge = merge;
	/**
	* Converts the first character of a string to lower case.
	* @param {string} str String to convert
	* @returns {string} Converted string
	*/
	util.lcFirst = function lcFirst(str) {
		return str.charAt(0).toLowerCase() + str.substring(1);
	};
	/**
	* Creates a custom error constructor.
	* @memberof util
	* @param {string} name Error name
	* @returns {Constructor<Error>} Custom error constructor
	*/
	function newError(name) {
		function CustomError(message, properties) {
			if (!(this instanceof CustomError)) return new CustomError(message, properties);
			Object.defineProperty(this, "message", { get: function() {
				return message;
			} });
			/* istanbul ignore next */
			if (Error.captureStackTrace) Error.captureStackTrace(this, CustomError);
			else Object.defineProperty(this, "stack", { value: (/* @__PURE__ */ new Error()).stack || "" });
			if (properties) merge(this, properties);
		}
		CustomError.prototype = Object.create(Error.prototype, {
			constructor: {
				value: CustomError,
				writable: true,
				enumerable: false,
				configurable: true
			},
			name: {
				get: function get() {
					return name;
				},
				set: void 0,
				enumerable: false,
				configurable: true
			},
			toString: {
				value: function value() {
					return this.name + ": " + this.message;
				},
				writable: true,
				enumerable: false,
				configurable: true
			}
		});
		return CustomError;
	}
	util.newError = newError;
	/**
	* Constructs a new protocol error.
	* @classdesc Error subclass indicating a protocol specifc error.
	* @memberof util
	* @extends Error
	* @template T extends Message<T>
	* @constructor
	* @param {string} message Error message
	* @param {Object.<string,*>} [properties] Additional properties
	* @example
	* try {
	*     MyMessage.decode(someBuffer); // throws if required fields are missing
	* } catch (e) {
	*     if (e instanceof ProtocolError && e.instance)
	*         console.log("decoded so far: " + JSON.stringify(e.instance));
	* }
	*/
	util.ProtocolError = newError("ProtocolError");
	/**
	* So far decoded message instance.
	* @name util.ProtocolError#instance
	* @type {Message<T>}
	*/
	/**
	* A OneOf getter as returned by {@link util.oneOfGetter}.
	* @typedef OneOfGetter
	* @type {function}
	* @returns {string|undefined} Set field name, if any
	*/
	/**
	* Builds a getter for a oneof's present field name.
	* @param {string[]} fieldNames Field names
	* @returns {OneOfGetter} Unbound getter
	*/
	util.oneOfGetter = function getOneOf(fieldNames) {
		var fieldMap = {};
		for (var i = 0; i < fieldNames.length; ++i) fieldMap[fieldNames[i]] = 1;
		/**
		* @returns {string|undefined} Set field name, if any
		* @this Object
		* @ignore
		*/
		return function() {
			for (var keys = Object.keys(this), i = keys.length - 1; i > -1; --i) if (fieldMap[keys[i]] === 1 && this[keys[i]] !== void 0 && this[keys[i]] !== null) return keys[i];
		};
	};
	/**
	* A OneOf setter as returned by {@link util.oneOfSetter}.
	* @typedef OneOfSetter
	* @type {function}
	* @param {string|undefined} value Field name
	* @returns {undefined}
	*/
	/**
	* Builds a setter for a oneof's present field name.
	* @param {string[]} fieldNames Field names
	* @returns {OneOfSetter} Unbound setter
	*/
	util.oneOfSetter = function setOneOf(fieldNames) {
		/**
		* @param {string} name Field name
		* @returns {undefined}
		* @this Object
		* @ignore
		*/
		return function(name) {
			for (var i = 0; i < fieldNames.length; ++i) if (fieldNames[i] !== name) delete this[fieldNames[i]];
		};
	};
	/**
	* Default conversion options used for {@link Message#toJSON} implementations.
	*
	* These options are close to proto3's JSON mapping with the exception that internal types like Any are handled just like messages. More precisely:
	*
	* - Longs become strings
	* - Enums become string keys
	* - Bytes become base64 encoded strings
	* - (Sub-)Messages become plain objects
	* - Maps become plain objects with all string keys
	* - Repeated fields become arrays
	* - NaN and Infinity for float and double fields become strings
	*
	* @type {IConversionOptions}
	* @see https://developers.google.com/protocol-buffers/docs/proto3?hl=en#json
	*/
	util.toJSONOptions = {
		longs: String,
		enums: String,
		bytes: String,
		json: true
	};
	util._configure = function() {
		var Buffer = util.Buffer;
		/* istanbul ignore if */
		if (!Buffer) {
			util._Buffer_from = util._Buffer_allocUnsafe = null;
			return;
		}
		util._Buffer_from = Buffer.from !== Uint8Array.from && Buffer.from || function Buffer_from(value, encoding) {
			return new Buffer(value, encoding);
		};
		util._Buffer_allocUnsafe = Buffer.allocUnsafe || function Buffer_allocUnsafe(size) {
			return new Buffer(size);
		};
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/writer.js
var require_writer = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Writer;
	var util = require_minimal();
	var BufferWriter;
	var LongBits = util.LongBits, base64 = util.base64, utf8 = util.utf8;
	/**
	* Constructs a new writer operation instance.
	* @classdesc Scheduled writer operation.
	* @constructor
	* @param {function(*, Uint8Array, number)} fn Function to call
	* @param {number} len Value byte length
	* @param {*} val Value to write
	* @ignore
	*/
	function Op(fn, len, val) {
		/**
		* Function to call.
		* @type {function(Uint8Array, number, *)}
		*/
		this.fn = fn;
		/**
		* Value byte length.
		* @type {number}
		*/
		this.len = len;
		/**
		* Next operation.
		* @type {Writer.Op|undefined}
		*/
		this.next = void 0;
		/**
		* Value to write.
		* @type {*}
		*/
		this.val = val;
	}
	/* istanbul ignore next */
	function noop() {}
	/**
	* Constructs a new writer state instance.
	* @classdesc Copied writer state.
	* @memberof Writer
	* @constructor
	* @param {Writer} writer Writer to copy state from
	* @ignore
	*/
	function State(writer) {
		/**
		* Current head.
		* @type {Writer.Op}
		*/
		this.head = writer.head;
		/**
		* Current tail.
		* @type {Writer.Op}
		*/
		this.tail = writer.tail;
		/**
		* Current buffer length.
		* @type {number}
		*/
		this.len = writer.len;
		/**
		* Next state.
		* @type {State|null}
		*/
		this.next = writer.states;
	}
	/**
	* Constructs a new writer instance.
	* @classdesc Wire format writer using `Uint8Array` if available, otherwise `Array`.
	* @constructor
	*/
	function Writer() {
		/**
		* Current length.
		* @type {number}
		*/
		this.len = 0;
		/**
		* Operations head.
		* @type {Object}
		*/
		this.head = new Op(noop, 0, 0);
		/**
		* Operations tail
		* @type {Object}
		*/
		this.tail = this.head;
		/**
		* Linked forked states.
		* @type {Object|null}
		*/
		this.states = null;
	}
	var create = function create() {
		return util.Buffer ? function create_buffer_setup() {
			return (Writer.create = function create_buffer() {
				return new BufferWriter();
			})();
		} : function create_array() {
			return new Writer();
		};
	};
	/**
	* Creates a new writer.
	* @function
	* @returns {BufferWriter|Writer} A {@link BufferWriter} when Buffers are supported, otherwise a {@link Writer}
	*/
	Writer.create = create();
	/**
	* Allocates a buffer of the specified size.
	* @param {number} size Buffer size
	* @returns {Uint8Array} Buffer
	*/
	Writer.alloc = function alloc(size) {
		return new util.Array(size);
	};
	/* istanbul ignore else */
	if (util.Array !== Array) Writer.alloc = util.pool(Writer.alloc, util.Array.prototype.subarray);
	/**
	* Pushes a new operation to the queue.
	* @param {function(Uint8Array, number, *)} fn Function to call
	* @param {number} len Value byte length
	* @param {number} val Value to write
	* @returns {Writer} `this`
	* @private
	*/
	Writer.prototype._push = function push(fn, len, val) {
		this.tail = this.tail.next = new Op(fn, len, val);
		this.len += len;
		return this;
	};
	function writeByte(val, buf, pos) {
		buf[pos] = val & 255;
	}
	function writeVarint32(val, buf, pos) {
		while (val > 127) {
			buf[pos++] = val & 127 | 128;
			val >>>= 7;
		}
		buf[pos] = val;
	}
	/**
	* Constructs a new varint writer operation instance.
	* @classdesc Scheduled varint writer operation.
	* @extends Op
	* @constructor
	* @param {number} len Value byte length
	* @param {number} val Value to write
	* @ignore
	*/
	function VarintOp(len, val) {
		this.len = len;
		this.next = void 0;
		this.val = val;
	}
	VarintOp.prototype = Object.create(Op.prototype);
	VarintOp.prototype.fn = writeVarint32;
	/**
	* Writes an unsigned 32 bit value as a varint.
	* @param {number} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.uint32 = function write_uint32(value) {
		this.len += (this.tail = this.tail.next = new VarintOp((value = value >>> 0) < 128 ? 1 : value < 16384 ? 2 : value < 2097152 ? 3 : value < 268435456 ? 4 : 5, value)).len;
		return this;
	};
	/**
	* Writes a signed 32 bit value as a varint.
	* @function
	* @param {number} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.int32 = function write_int32(value) {
		return value < 0 ? this._push(writeVarint64, 10, LongBits.fromNumber(value)) : this.uint32(value);
	};
	/**
	* Writes a 32 bit value as a varint, zig-zag encoded.
	* @param {number} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.sint32 = function write_sint32(value) {
		return this.uint32((value << 1 ^ value >> 31) >>> 0);
	};
	function writeVarint64(val, buf, pos) {
		while (val.hi) {
			buf[pos++] = val.lo & 127 | 128;
			val.lo = (val.lo >>> 7 | val.hi << 25) >>> 0;
			val.hi >>>= 7;
		}
		while (val.lo > 127) {
			buf[pos++] = val.lo & 127 | 128;
			val.lo = val.lo >>> 7;
		}
		buf[pos++] = val.lo;
	}
	/**
	* Writes an unsigned 64 bit value as a varint.
	* @param {Long|number|string} value Value to write
	* @returns {Writer} `this`
	* @throws {TypeError} If `value` is a string and no long library is present.
	*/
	Writer.prototype.uint64 = function write_uint64(value) {
		var bits = LongBits.from(value);
		return this._push(writeVarint64, bits.length(), bits);
	};
	/**
	* Writes a signed 64 bit value as a varint.
	* @function
	* @param {Long|number|string} value Value to write
	* @returns {Writer} `this`
	* @throws {TypeError} If `value` is a string and no long library is present.
	*/
	Writer.prototype.int64 = Writer.prototype.uint64;
	/**
	* Writes a signed 64 bit value as a varint, zig-zag encoded.
	* @param {Long|number|string} value Value to write
	* @returns {Writer} `this`
	* @throws {TypeError} If `value` is a string and no long library is present.
	*/
	Writer.prototype.sint64 = function write_sint64(value) {
		var bits = LongBits.from(value).zzEncode();
		return this._push(writeVarint64, bits.length(), bits);
	};
	/**
	* Writes a boolish value as a varint.
	* @param {boolean} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.bool = function write_bool(value) {
		return this._push(writeByte, 1, value ? 1 : 0);
	};
	function writeFixed32(val, buf, pos) {
		buf[pos] = val & 255;
		buf[pos + 1] = val >>> 8 & 255;
		buf[pos + 2] = val >>> 16 & 255;
		buf[pos + 3] = val >>> 24;
	}
	/**
	* Writes an unsigned 32 bit value as fixed 32 bits.
	* @param {number} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.fixed32 = function write_fixed32(value) {
		return this._push(writeFixed32, 4, value >>> 0);
	};
	/**
	* Writes a signed 32 bit value as fixed 32 bits.
	* @function
	* @param {number} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.sfixed32 = Writer.prototype.fixed32;
	/**
	* Writes an unsigned 64 bit value as fixed 64 bits.
	* @param {Long|number|string} value Value to write
	* @returns {Writer} `this`
	* @throws {TypeError} If `value` is a string and no long library is present.
	*/
	Writer.prototype.fixed64 = function write_fixed64(value) {
		var bits = LongBits.from(value);
		return this._push(writeFixed32, 4, bits.lo)._push(writeFixed32, 4, bits.hi);
	};
	/**
	* Writes a signed 64 bit value as fixed 64 bits.
	* @function
	* @param {Long|number|string} value Value to write
	* @returns {Writer} `this`
	* @throws {TypeError} If `value` is a string and no long library is present.
	*/
	Writer.prototype.sfixed64 = Writer.prototype.fixed64;
	/**
	* Writes a float (32 bit).
	* @function
	* @param {number} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.float = function write_float(value) {
		return this._push(util.float.writeFloatLE, 4, value);
	};
	/**
	* Writes a double (64 bit float).
	* @function
	* @param {number} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.double = function write_double(value) {
		return this._push(util.float.writeDoubleLE, 8, value);
	};
	var writeBytes = util.Array.prototype.set ? function writeBytes_set(val, buf, pos) {
		buf.set(val, pos);
	} : function writeBytes_for(val, buf, pos) {
		for (var i = 0; i < val.length; ++i) buf[pos + i] = val[i];
	};
	/**
	* Writes a sequence of bytes.
	* @param {Uint8Array|string} value Buffer or base64 encoded string to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.bytes = function write_bytes(value) {
		var len = value.length >>> 0;
		if (!len) return this._push(writeByte, 1, 0);
		if (util.isString(value)) {
			var buf = Writer.alloc(len = base64.length(value));
			base64.decode(value, buf, 0);
			value = buf;
		}
		return this.uint32(len)._push(writeBytes, len, value);
	};
	/**
	* Writes a string.
	* @param {string} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.string = function write_string(value) {
		var len = utf8.length(value);
		return len ? this.uint32(len)._push(utf8.write, len, value) : this._push(writeByte, 1, 0);
	};
	/**
	* Forks this writer's state by pushing it to a stack.
	* Calling {@link Writer#reset|reset} or {@link Writer#ldelim|ldelim} resets the writer to the previous state.
	* @returns {Writer} `this`
	*/
	Writer.prototype.fork = function fork() {
		this.states = new State(this);
		this.head = this.tail = new Op(noop, 0, 0);
		this.len = 0;
		return this;
	};
	/**
	* Resets this instance to the last state.
	* @returns {Writer} `this`
	*/
	Writer.prototype.reset = function reset() {
		if (this.states) {
			this.head = this.states.head;
			this.tail = this.states.tail;
			this.len = this.states.len;
			this.states = this.states.next;
		} else {
			this.head = this.tail = new Op(noop, 0, 0);
			this.len = 0;
		}
		return this;
	};
	/**
	* Resets to the last state and appends the fork state's current write length as a varint followed by its operations.
	* @returns {Writer} `this`
	*/
	Writer.prototype.ldelim = function ldelim() {
		var head = this.head, tail = this.tail, len = this.len;
		this.reset().uint32(len);
		if (len) {
			this.tail.next = head.next;
			this.tail = tail;
			this.len += len;
		}
		return this;
	};
	/**
	* Finishes the write operation.
	* @returns {Uint8Array} Finished buffer
	*/
	Writer.prototype.finish = function finish() {
		var head = this.head.next, buf = this.constructor.alloc(this.len), pos = 0;
		while (head) {
			head.fn(head.val, buf, pos);
			pos += head.len;
			head = head.next;
		}
		return buf;
	};
	Writer._configure = function(BufferWriter_) {
		BufferWriter = BufferWriter_;
		Writer.create = create();
		BufferWriter._configure();
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/writer_buffer.js
var require_writer_buffer = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = BufferWriter;
	var Writer = require_writer();
	(BufferWriter.prototype = Object.create(Writer.prototype)).constructor = BufferWriter;
	var util = require_minimal();
	/**
	* Constructs a new buffer writer instance.
	* @classdesc Wire format writer using node buffers.
	* @extends Writer
	* @constructor
	*/
	function BufferWriter() {
		Writer.call(this);
	}
	BufferWriter._configure = function() {
		/**
		* Allocates a buffer of the specified size.
		* @function
		* @param {number} size Buffer size
		* @returns {Buffer} Buffer
		*/
		BufferWriter.alloc = util._Buffer_allocUnsafe;
		BufferWriter.writeBytesBuffer = util.Buffer && util.Buffer.prototype instanceof Uint8Array && util.Buffer.prototype.set.name === "set" ? function writeBytesBuffer_set(val, buf, pos) {
			buf.set(val, pos);
		} : function writeBytesBuffer_copy(val, buf, pos) {
			if (val.copy) val.copy(buf, pos, 0, val.length);
			else for (var i = 0; i < val.length;) buf[pos++] = val[i++];
		};
	};
	/**
	* @override
	*/
	BufferWriter.prototype.bytes = function write_bytes_buffer(value) {
		if (util.isString(value)) value = util._Buffer_from(value, "base64");
		var len = value.length >>> 0;
		this.uint32(len);
		if (len) this._push(BufferWriter.writeBytesBuffer, len, value);
		return this;
	};
	function writeStringBuffer(val, buf, pos) {
		if (val.length < 40) util.utf8.write(val, buf, pos);
		else if (buf.utf8Write) buf.utf8Write(val, pos);
		else buf.write(val, pos);
	}
	/**
	* @override
	*/
	BufferWriter.prototype.string = function write_string_buffer(value) {
		var len = util.Buffer.byteLength(value);
		this.uint32(len);
		if (len) this._push(writeStringBuffer, len, value);
		return this;
	};
	/**
	* Finishes the write operation.
	* @name BufferWriter#finish
	* @function
	* @returns {Buffer} Finished buffer
	*/
	BufferWriter._configure();
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/reader.js
var require_reader = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Reader;
	var util = require_minimal();
	var BufferReader;
	var LongBits = util.LongBits, utf8 = util.utf8;
	/* istanbul ignore next */
	function indexOutOfRange(reader, writeLength) {
		return RangeError("index out of range: " + reader.pos + " + " + (writeLength || 1) + " > " + reader.len);
	}
	/**
	* Constructs a new reader instance using the specified buffer.
	* @classdesc Wire format reader using `Uint8Array` if available, otherwise `Array`.
	* @constructor
	* @param {Uint8Array} buffer Buffer to read from
	*/
	function Reader(buffer) {
		/**
		* Read buffer.
		* @type {Uint8Array}
		*/
		this.buf = buffer;
		/**
		* Read buffer position.
		* @type {number}
		*/
		this.pos = 0;
		/**
		* Read buffer length.
		* @type {number}
		*/
		this.len = buffer.length;
	}
	var create_array = typeof Uint8Array !== "undefined" ? function create_typed_array(buffer) {
		if (buffer instanceof Uint8Array || Array.isArray(buffer)) return new Reader(buffer);
		throw Error("illegal buffer");
	} : function create_array(buffer) {
		if (Array.isArray(buffer)) return new Reader(buffer);
		throw Error("illegal buffer");
	};
	var create = function create() {
		return util.Buffer ? function create_buffer_setup(buffer) {
			return (Reader.create = function create_buffer(buffer) {
				return util.Buffer.isBuffer(buffer) ? new BufferReader(buffer) : create_array(buffer);
			})(buffer);
		} : create_array;
	};
	/**
	* Creates a new reader using the specified buffer.
	* @function
	* @param {Uint8Array|Buffer} buffer Buffer to read from
	* @returns {Reader|BufferReader} A {@link BufferReader} if `buffer` is a Buffer, otherwise a {@link Reader}
	* @throws {Error} If `buffer` is not a valid buffer
	*/
	Reader.create = create();
	Reader.prototype._slice = util.Array.prototype.subarray || util.Array.prototype.slice;
	/**
	* Reads a varint as an unsigned 32 bit value.
	* @function
	* @returns {number} Value read
	*/
	Reader.prototype.uint32 = (function read_uint32_setup() {
		var value = 4294967295;
		return function read_uint32() {
			value = (this.buf[this.pos] & 127) >>> 0;
			if (this.buf[this.pos++] < 128) return value;
			value = (value | (this.buf[this.pos] & 127) << 7) >>> 0;
			if (this.buf[this.pos++] < 128) return value;
			value = (value | (this.buf[this.pos] & 127) << 14) >>> 0;
			if (this.buf[this.pos++] < 128) return value;
			value = (value | (this.buf[this.pos] & 127) << 21) >>> 0;
			if (this.buf[this.pos++] < 128) return value;
			value = (value | (this.buf[this.pos] & 15) << 28) >>> 0;
			if (this.buf[this.pos++] < 128) return value;
			/* istanbul ignore if */
			if ((this.pos += 5) > this.len) {
				this.pos = this.len;
				throw indexOutOfRange(this, 10);
			}
			return value;
		};
	})();
	/**
	* Reads a varint as a signed 32 bit value.
	* @returns {number} Value read
	*/
	Reader.prototype.int32 = function read_int32() {
		return this.uint32() | 0;
	};
	/**
	* Reads a zig-zag encoded varint as a signed 32 bit value.
	* @returns {number} Value read
	*/
	Reader.prototype.sint32 = function read_sint32() {
		var value = this.uint32();
		return value >>> 1 ^ -(value & 1) | 0;
	};
	function readLongVarint() {
		var bits = new LongBits(0, 0);
		var i = 0;
		if (this.len - this.pos > 4) {
			for (; i < 4; ++i) {
				bits.lo = (bits.lo | (this.buf[this.pos] & 127) << i * 7) >>> 0;
				if (this.buf[this.pos++] < 128) return bits;
			}
			bits.lo = (bits.lo | (this.buf[this.pos] & 127) << 28) >>> 0;
			bits.hi = (bits.hi | (this.buf[this.pos] & 127) >> 4) >>> 0;
			if (this.buf[this.pos++] < 128) return bits;
			i = 0;
		} else {
			for (; i < 3; ++i) {
				/* istanbul ignore if */
				if (this.pos >= this.len) throw indexOutOfRange(this);
				bits.lo = (bits.lo | (this.buf[this.pos] & 127) << i * 7) >>> 0;
				if (this.buf[this.pos++] < 128) return bits;
			}
			bits.lo = (bits.lo | (this.buf[this.pos++] & 127) << i * 7) >>> 0;
			return bits;
		}
		if (this.len - this.pos > 4) for (; i < 5; ++i) {
			bits.hi = (bits.hi | (this.buf[this.pos] & 127) << i * 7 + 3) >>> 0;
			if (this.buf[this.pos++] < 128) return bits;
		}
		else for (; i < 5; ++i) {
			/* istanbul ignore if */
			if (this.pos >= this.len) throw indexOutOfRange(this);
			bits.hi = (bits.hi | (this.buf[this.pos] & 127) << i * 7 + 3) >>> 0;
			if (this.buf[this.pos++] < 128) return bits;
		}
		/* istanbul ignore next */
		throw Error("invalid varint encoding");
	}
	/**
	* Reads a varint as a signed 64 bit value.
	* @name Reader#int64
	* @function
	* @returns {Long} Value read
	*/
	/**
	* Reads a varint as an unsigned 64 bit value.
	* @name Reader#uint64
	* @function
	* @returns {Long} Value read
	*/
	/**
	* Reads a zig-zag encoded varint as a signed 64 bit value.
	* @name Reader#sint64
	* @function
	* @returns {Long} Value read
	*/
	/**
	* Reads a varint as a boolean.
	* @returns {boolean} Value read
	*/
	Reader.prototype.bool = function read_bool() {
		return this.uint32() !== 0;
	};
	function readFixed32_end(buf, end) {
		return (buf[end - 4] | buf[end - 3] << 8 | buf[end - 2] << 16 | buf[end - 1] << 24) >>> 0;
	}
	/**
	* Reads fixed 32 bits as an unsigned 32 bit integer.
	* @returns {number} Value read
	*/
	Reader.prototype.fixed32 = function read_fixed32() {
		/* istanbul ignore if */
		if (this.pos + 4 > this.len) throw indexOutOfRange(this, 4);
		return readFixed32_end(this.buf, this.pos += 4);
	};
	/**
	* Reads fixed 32 bits as a signed 32 bit integer.
	* @returns {number} Value read
	*/
	Reader.prototype.sfixed32 = function read_sfixed32() {
		/* istanbul ignore if */
		if (this.pos + 4 > this.len) throw indexOutOfRange(this, 4);
		return readFixed32_end(this.buf, this.pos += 4) | 0;
	};
	function readFixed64() {
		/* istanbul ignore if */
		if (this.pos + 8 > this.len) throw indexOutOfRange(this, 8);
		return new LongBits(readFixed32_end(this.buf, this.pos += 4), readFixed32_end(this.buf, this.pos += 4));
	}
	/**
	* Reads fixed 64 bits.
	* @name Reader#fixed64
	* @function
	* @returns {Long} Value read
	*/
	/**
	* Reads zig-zag encoded fixed 64 bits.
	* @name Reader#sfixed64
	* @function
	* @returns {Long} Value read
	*/
	/**
	* Reads a float (32 bit) as a number.
	* @function
	* @returns {number} Value read
	*/
	Reader.prototype.float = function read_float() {
		/* istanbul ignore if */
		if (this.pos + 4 > this.len) throw indexOutOfRange(this, 4);
		var value = util.float.readFloatLE(this.buf, this.pos);
		this.pos += 4;
		return value;
	};
	/**
	* Reads a double (64 bit float) as a number.
	* @function
	* @returns {number} Value read
	*/
	Reader.prototype.double = function read_double() {
		/* istanbul ignore if */
		if (this.pos + 8 > this.len) throw indexOutOfRange(this, 4);
		var value = util.float.readDoubleLE(this.buf, this.pos);
		this.pos += 8;
		return value;
	};
	/**
	* Reads a sequence of bytes preceeded by its length as a varint.
	* @returns {Uint8Array} Value read
	*/
	Reader.prototype.bytes = function read_bytes() {
		var length = this.uint32(), start = this.pos, end = this.pos + length;
		/* istanbul ignore if */
		if (end > this.len) throw indexOutOfRange(this, length);
		this.pos += length;
		if (Array.isArray(this.buf)) return this.buf.slice(start, end);
		if (start === end) {
			var nativeBuffer = util.Buffer;
			return nativeBuffer ? nativeBuffer.alloc(0) : new this.buf.constructor(0);
		}
		return this._slice.call(this.buf, start, end);
	};
	/**
	* Reads a string preceeded by its byte length as a varint.
	* @returns {string} Value read
	*/
	Reader.prototype.string = function read_string() {
		var bytes = this.bytes();
		return utf8.read(bytes, 0, bytes.length);
	};
	/**
	* Skips the specified number of bytes if specified, otherwise skips a varint.
	* @param {number} [length] Length if known, otherwise a varint is assumed
	* @returns {Reader} `this`
	*/
	Reader.prototype.skip = function skip(length) {
		if (typeof length === "number") {
			/* istanbul ignore if */
			if (this.pos + length > this.len) throw indexOutOfRange(this, length);
			this.pos += length;
		} else do
			/* istanbul ignore if */
			if (this.pos >= this.len) throw indexOutOfRange(this);
		while (this.buf[this.pos++] & 128);
		return this;
	};
	/**
	* Skips the next element of the specified wire type.
	* @param {number} wireType Wire type received
	* @returns {Reader} `this`
	*/
	Reader.prototype.skipType = function(wireType) {
		switch (wireType) {
			case 0:
				this.skip();
				break;
			case 1:
				this.skip(8);
				break;
			case 2:
				this.skip(this.uint32());
				break;
			case 3:
				while ((wireType = this.uint32() & 7) !== 4) this.skipType(wireType);
				break;
			case 5:
				this.skip(4);
				break;
			default: throw Error("invalid wire type " + wireType + " at offset " + this.pos);
		}
		return this;
	};
	Reader._configure = function(BufferReader_) {
		BufferReader = BufferReader_;
		Reader.create = create();
		BufferReader._configure();
		var fn = util.Long ? "toLong" : "toNumber";
		util.merge(Reader.prototype, {
			int64: function read_int64() {
				return readLongVarint.call(this)[fn](false);
			},
			uint64: function read_uint64() {
				return readLongVarint.call(this)[fn](true);
			},
			sint64: function read_sint64() {
				return readLongVarint.call(this).zzDecode()[fn](false);
			},
			fixed64: function read_fixed64() {
				return readFixed64.call(this)[fn](true);
			},
			sfixed64: function read_sfixed64() {
				return readFixed64.call(this)[fn](false);
			}
		});
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/reader_buffer.js
var require_reader_buffer = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = BufferReader;
	var Reader = require_reader();
	(BufferReader.prototype = Object.create(Reader.prototype)).constructor = BufferReader;
	var util = require_minimal();
	/**
	* Constructs a new buffer reader instance.
	* @classdesc Wire format reader using node buffers.
	* @extends Reader
	* @constructor
	* @param {Buffer} buffer Buffer to read from
	*/
	function BufferReader(buffer) {
		Reader.call(this, buffer);
		/**
		* Read buffer.
		* @name BufferReader#buf
		* @type {Buffer}
		*/
	}
	BufferReader._configure = function() {
		/* istanbul ignore else */
		if (util.Buffer) BufferReader.prototype._slice = util.Buffer.prototype.slice;
	};
	/**
	* @override
	*/
	BufferReader.prototype.string = function read_string_buffer() {
		var len = this.uint32();
		return this.buf.utf8Slice ? this.buf.utf8Slice(this.pos, this.pos = Math.min(this.pos + len, this.len)) : this.buf.toString("utf-8", this.pos, this.pos = Math.min(this.pos + len, this.len));
	};
	/**
	* Reads a sequence of bytes preceeded by its length as a varint.
	* @name BufferReader#bytes
	* @function
	* @returns {Buffer} Value read
	*/
	BufferReader._configure();
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/rpc/service.js
var require_service$1 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Service;
	var util = require_minimal();
	(Service.prototype = Object.create(util.EventEmitter.prototype)).constructor = Service;
	/**
	* A service method callback as used by {@link rpc.ServiceMethod|ServiceMethod}.
	*
	* Differs from {@link RPCImplCallback} in that it is an actual callback of a service method which may not return `response = null`.
	* @typedef rpc.ServiceMethodCallback
	* @template TRes extends Message<TRes>
	* @type {function}
	* @param {Error|null} error Error, if any
	* @param {TRes} [response] Response message
	* @returns {undefined}
	*/
	/**
	* A service method part of a {@link rpc.Service} as created by {@link Service.create}.
	* @typedef rpc.ServiceMethod
	* @template TReq extends Message<TReq>
	* @template TRes extends Message<TRes>
	* @type {function}
	* @param {TReq|Properties<TReq>} request Request message or plain object
	* @param {rpc.ServiceMethodCallback<TRes>} [callback] Node-style callback called with the error, if any, and the response message
	* @returns {Promise<Message<TRes>>} Promise if `callback` has been omitted, otherwise `undefined`
	*/
	/**
	* Constructs a new RPC service instance.
	* @classdesc An RPC service as returned by {@link Service#create}.
	* @exports rpc.Service
	* @extends util.EventEmitter
	* @constructor
	* @param {RPCImpl} rpcImpl RPC implementation
	* @param {boolean} [requestDelimited=false] Whether requests are length-delimited
	* @param {boolean} [responseDelimited=false] Whether responses are length-delimited
	*/
	function Service(rpcImpl, requestDelimited, responseDelimited) {
		if (typeof rpcImpl !== "function") throw TypeError("rpcImpl must be a function");
		util.EventEmitter.call(this);
		/**
		* RPC implementation. Becomes `null` once the service is ended.
		* @type {RPCImpl|null}
		*/
		this.rpcImpl = rpcImpl;
		/**
		* Whether requests are length-delimited.
		* @type {boolean}
		*/
		this.requestDelimited = Boolean(requestDelimited);
		/**
		* Whether responses are length-delimited.
		* @type {boolean}
		*/
		this.responseDelimited = Boolean(responseDelimited);
	}
	/**
	* Calls a service method through {@link rpc.Service#rpcImpl|rpcImpl}.
	* @param {Method|rpc.ServiceMethod<TReq,TRes>} method Reflected or static method
	* @param {Constructor<TReq>} requestCtor Request constructor
	* @param {Constructor<TRes>} responseCtor Response constructor
	* @param {TReq|Properties<TReq>} request Request message or plain object
	* @param {rpc.ServiceMethodCallback<TRes>} callback Service callback
	* @returns {undefined}
	* @template TReq extends Message<TReq>
	* @template TRes extends Message<TRes>
	*/
	Service.prototype.rpcCall = function rpcCall(method, requestCtor, responseCtor, request, callback) {
		if (!request) throw TypeError("request must be specified");
		var self = this;
		if (!callback) return util.asPromise(rpcCall, self, method, requestCtor, responseCtor, request);
		if (!self.rpcImpl) {
			setTimeout(function() {
				callback(Error("already ended"));
			}, 0);
			return;
		}
		try {
			return self.rpcImpl(method, requestCtor[self.requestDelimited ? "encodeDelimited" : "encode"](request).finish(), function rpcCallback(err, response) {
				if (err) {
					self.emit("error", err, method);
					return callback(err);
				}
				if (response === null) {
					self.end(true);
					return;
				}
				if (!(response instanceof responseCtor)) try {
					response = responseCtor[self.responseDelimited ? "decodeDelimited" : "decode"](response);
				} catch (err) {
					self.emit("error", err, method);
					return callback(err);
				}
				self.emit("data", response, method);
				return callback(null, response);
			});
		} catch (err) {
			self.emit("error", err, method);
			setTimeout(function() {
				callback(err);
			}, 0);
			return;
		}
	};
	/**
	* Ends this service and emits the `end` event.
	* @param {boolean} [endedByRPC=false] Whether the service has been ended by the RPC implementation.
	* @returns {rpc.Service} `this`
	*/
	Service.prototype.end = function end(endedByRPC) {
		if (this.rpcImpl) {
			if (!endedByRPC) this.rpcImpl(null, null, null);
			this.rpcImpl = null;
			this.emit("end").off();
		}
		return this;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/rpc.js
var require_rpc = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Streaming RPC helpers.
	* @namespace
	*/
	var rpc = exports;
	/**
	* RPC implementation passed to {@link Service#create} performing a service request on network level, i.e. by utilizing http requests or websockets.
	* @typedef RPCImpl
	* @type {function}
	* @param {Method|rpc.ServiceMethod<Message<{}>,Message<{}>>} method Reflected or static method being called
	* @param {Uint8Array} requestData Request data
	* @param {RPCImplCallback} callback Callback function
	* @returns {undefined}
	* @example
	* function rpcImpl(method, requestData, callback) {
	*     if (protobuf.util.lcFirst(method.name) !== "myMethod") // compatible with static code
	*         throw Error("no such method");
	*     asynchronouslyObtainAResponse(requestData, function(err, responseData) {
	*         callback(err, responseData);
	*     });
	* }
	*/
	/**
	* Node-style callback as used by {@link RPCImpl}.
	* @typedef RPCImplCallback
	* @type {function}
	* @param {Error|null} error Error, if any, otherwise `null`
	* @param {Uint8Array|null} [response] Response data or `null` to signal end of stream, if there hasn't been an error
	* @returns {undefined}
	*/
	rpc.Service = require_service$1();
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/roots.js
var require_roots = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = {};
}));
/**
* Named roots.
* This is where pbjs stores generated structures (the option `-r, --root` specifies a name).
* Can also be used manually to make roots available across modules.
* @name roots
* @type {Object.<string,Root>}
* @example
* // pbjs -r myroot -o compiled.js ...
*
* // in another module:
* require("./compiled.js");
*
* // in any subsequent module:
* var root = protobuf.roots["myroot"];
*/
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/index-minimal.js
var require_index_minimal = /* @__PURE__ */ __commonJSMin(((exports) => {
	var protobuf = exports;
	/**
	* Build type, one of `"full"`, `"light"` or `"minimal"`.
	* @name build
	* @type {string}
	* @const
	*/
	protobuf.build = "minimal";
	protobuf.Writer = require_writer();
	protobuf.BufferWriter = require_writer_buffer();
	protobuf.Reader = require_reader();
	protobuf.BufferReader = require_reader_buffer();
	protobuf.util = require_minimal();
	protobuf.rpc = require_rpc();
	protobuf.roots = require_roots();
	protobuf.configure = configure;
	/* istanbul ignore next */
	/**
	* Reconfigures the library according to the environment.
	* @returns {undefined}
	*/
	function configure() {
		protobuf.util._configure();
		protobuf.Writer._configure(protobuf.BufferWriter);
		protobuf.Reader._configure(protobuf.BufferReader);
	}
	configure();
}));
//#endregion
//#region ../../node_modules/.pnpm/@protobufjs+codegen@2.0.4/node_modules/@protobufjs/codegen/index.js
var require_codegen = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = codegen;
	/**
	* Begins generating a function.
	* @memberof util
	* @param {string[]} functionParams Function parameter names
	* @param {string} [functionName] Function name if not anonymous
	* @returns {Codegen} Appender that appends code to the function's body
	*/
	function codegen(functionParams, functionName) {
		/* istanbul ignore if */
		if (typeof functionParams === "string") {
			functionName = functionParams;
			functionParams = void 0;
		}
		var body = [];
		/**
		* Appends code to the function's body or finishes generation.
		* @typedef Codegen
		* @type {function}
		* @param {string|Object.<string,*>} [formatStringOrScope] Format string or, to finish the function, an object of additional scope variables, if any
		* @param {...*} [formatParams] Format parameters
		* @returns {Codegen|Function} Itself or the generated function if finished
		* @throws {Error} If format parameter counts do not match
		*/
		function Codegen(formatStringOrScope) {
			if (typeof formatStringOrScope !== "string") {
				var source = toString();
				if (codegen.verbose) console.log("codegen: " + source);
				source = "return " + source;
				if (formatStringOrScope) {
					var scopeKeys = Object.keys(formatStringOrScope), scopeParams = new Array(scopeKeys.length + 1), scopeValues = new Array(scopeKeys.length), scopeOffset = 0;
					while (scopeOffset < scopeKeys.length) {
						scopeParams[scopeOffset] = scopeKeys[scopeOffset];
						scopeValues[scopeOffset] = formatStringOrScope[scopeKeys[scopeOffset++]];
					}
					scopeParams[scopeOffset] = source;
					return Function.apply(null, scopeParams).apply(null, scopeValues);
				}
				return Function(source)();
			}
			var formatParams = new Array(arguments.length - 1), formatOffset = 0;
			while (formatOffset < formatParams.length) formatParams[formatOffset] = arguments[++formatOffset];
			formatOffset = 0;
			formatStringOrScope = formatStringOrScope.replace(/%([%dfijs])/g, function replace($0, $1) {
				var value = formatParams[formatOffset++];
				switch ($1) {
					case "d":
					case "f": return String(Number(value));
					case "i": return String(Math.floor(value));
					case "j": return JSON.stringify(value);
					case "s": return String(value);
				}
				return "%";
			});
			if (formatOffset !== formatParams.length) throw Error("parameter count mismatch");
			body.push(formatStringOrScope);
			return Codegen;
		}
		function toString(functionNameOverride) {
			return "function " + (functionNameOverride || functionName || "") + "(" + (functionParams && functionParams.join(",") || "") + "){\n  " + body.join("\n  ") + "\n}";
		}
		Codegen.toString = toString;
		return Codegen;
	}
	/**
	* Begins generating a function.
	* @memberof util
	* @function codegen
	* @param {string} [functionName] Function name if not anonymous
	* @returns {Codegen} Appender that appends code to the function's body
	* @variation 2
	*/
	/**
	* When set to `true`, codegen will log generated code to console. Useful for debugging.
	* @name util.codegen.verbose
	* @type {boolean}
	*/
	codegen.verbose = false;
}));
//#endregion
//#region ../../node_modules/.pnpm/@protobufjs+fetch@1.1.0/node_modules/@protobufjs/fetch/index.js
var require_fetch = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = fetch;
	var asPromise = require_aspromise();
	var fs = require_inquire()("fs");
	/**
	* Node-style callback as used by {@link util.fetch}.
	* @typedef FetchCallback
	* @type {function}
	* @param {?Error} error Error, if any, otherwise `null`
	* @param {string} [contents] File contents, if there hasn't been an error
	* @returns {undefined}
	*/
	/**
	* Options as used by {@link util.fetch}.
	* @typedef FetchOptions
	* @type {Object}
	* @property {boolean} [binary=false] Whether expecting a binary response
	* @property {boolean} [xhr=false] If `true`, forces the use of XMLHttpRequest
	*/
	/**
	* Fetches the contents of a file.
	* @memberof util
	* @param {string} filename File path or url
	* @param {FetchOptions} options Fetch options
	* @param {FetchCallback} callback Callback function
	* @returns {undefined}
	*/
	function fetch(filename, options, callback) {
		if (typeof options === "function") {
			callback = options;
			options = {};
		} else if (!options) options = {};
		if (!callback) return asPromise(fetch, this, filename, options);
		if (!options.xhr && fs && fs.readFile) return fs.readFile(filename, function fetchReadFileCallback(err, contents) {
			return err && typeof XMLHttpRequest !== "undefined" ? fetch.xhr(filename, options, callback) : err ? callback(err) : callback(null, options.binary ? contents : contents.toString("utf8"));
		});
		return fetch.xhr(filename, options, callback);
	}
	/**
	* Fetches the contents of a file.
	* @name util.fetch
	* @function
	* @param {string} path File path or url
	* @param {FetchCallback} callback Callback function
	* @returns {undefined}
	* @variation 2
	*/
	/**
	* Fetches the contents of a file.
	* @name util.fetch
	* @function
	* @param {string} path File path or url
	* @param {FetchOptions} [options] Fetch options
	* @returns {Promise<string|Uint8Array>} Promise
	* @variation 3
	*/
	fetch.xhr = function fetch_xhr(filename, options, callback) {
		var xhr = new XMLHttpRequest();
		xhr.onreadystatechange = function fetchOnReadyStateChange() {
			if (xhr.readyState !== 4) return void 0;
			if (xhr.status !== 0 && xhr.status !== 200) return callback(Error("status " + xhr.status));
			if (options.binary) {
				var buffer = xhr.response;
				if (!buffer) {
					buffer = [];
					for (var i = 0; i < xhr.responseText.length; ++i) buffer.push(xhr.responseText.charCodeAt(i) & 255);
				}
				return callback(null, typeof Uint8Array !== "undefined" ? new Uint8Array(buffer) : buffer);
			}
			return callback(null, xhr.responseText);
		};
		if (options.binary) {
			if ("overrideMimeType" in xhr) xhr.overrideMimeType("text/plain; charset=x-user-defined");
			xhr.responseType = "arraybuffer";
		}
		xhr.open("GET", filename);
		xhr.send();
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@protobufjs+path@1.1.2/node_modules/@protobufjs/path/index.js
var require_path = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* A minimal path module to resolve Unix, Windows and URL paths alike.
	* @memberof util
	* @namespace
	*/
	var path = exports;
	var isAbsolute = path.isAbsolute = function isAbsolute(path) {
		return /^(?:\/|\w+:)/.test(path);
	};
	var normalize = path.normalize = function normalize(path) {
		path = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
		var parts = path.split("/"), absolute = isAbsolute(path), prefix = "";
		if (absolute) prefix = parts.shift() + "/";
		for (var i = 0; i < parts.length;) if (parts[i] === "..") if (i > 0 && parts[i - 1] !== "..") parts.splice(--i, 2);
		else if (absolute) parts.splice(i, 1);
		else ++i;
		else if (parts[i] === ".") parts.splice(i, 1);
		else ++i;
		return prefix + parts.join("/");
	};
	/**
	* Resolves the specified include path against the specified origin path.
	* @param {string} originPath Path to the origin file
	* @param {string} includePath Include path relative to origin path
	* @param {boolean} [alreadyNormalized=false] `true` if both paths are already known to be normalized
	* @returns {string} Path to the include file
	*/
	path.resolve = function resolve(originPath, includePath, alreadyNormalized) {
		if (!alreadyNormalized) includePath = normalize(includePath);
		if (isAbsolute(includePath)) return includePath;
		if (!alreadyNormalized) originPath = normalize(originPath);
		return (originPath = originPath.replace(/(?:\/|^)[^/]+$/, "")).length ? normalize(originPath + "/" + includePath) : includePath;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/namespace.js
var require_namespace = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Namespace;
	var ReflectionObject = require_object();
	((Namespace.prototype = Object.create(ReflectionObject.prototype)).constructor = Namespace).className = "Namespace";
	var Field = require_field(), util = require_util$1(), OneOf = require_oneof();
	var Type, Service, Enum;
	/**
	* Constructs a new namespace instance.
	* @name Namespace
	* @classdesc Reflected namespace.
	* @extends NamespaceBase
	* @constructor
	* @param {string} name Namespace name
	* @param {Object.<string,*>} [options] Declared options
	*/
	/**
	* Constructs a namespace from JSON.
	* @memberof Namespace
	* @function
	* @param {string} name Namespace name
	* @param {Object.<string,*>} json JSON object
	* @returns {Namespace} Created namespace
	* @throws {TypeError} If arguments are invalid
	*/
	Namespace.fromJSON = function fromJSON(name, json) {
		return new Namespace(name, json.options).addJSON(json.nested);
	};
	/**
	* Converts an array of reflection objects to JSON.
	* @memberof Namespace
	* @param {ReflectionObject[]} array Object array
	* @param {IToJSONOptions} [toJSONOptions] JSON conversion options
	* @returns {Object.<string,*>|undefined} JSON object or `undefined` when array is empty
	*/
	function arrayToJSON(array, toJSONOptions) {
		if (!(array && array.length)) return void 0;
		var obj = {};
		for (var i = 0; i < array.length; ++i) obj[array[i].name] = array[i].toJSON(toJSONOptions);
		return obj;
	}
	Namespace.arrayToJSON = arrayToJSON;
	/**
	* Tests if the specified id is reserved.
	* @param {Array.<number[]|string>|undefined} reserved Array of reserved ranges and names
	* @param {number} id Id to test
	* @returns {boolean} `true` if reserved, otherwise `false`
	*/
	Namespace.isReservedId = function isReservedId(reserved, id) {
		if (reserved) {
			for (var i = 0; i < reserved.length; ++i) if (typeof reserved[i] !== "string" && reserved[i][0] <= id && reserved[i][1] > id) return true;
		}
		return false;
	};
	/**
	* Tests if the specified name is reserved.
	* @param {Array.<number[]|string>|undefined} reserved Array of reserved ranges and names
	* @param {string} name Name to test
	* @returns {boolean} `true` if reserved, otherwise `false`
	*/
	Namespace.isReservedName = function isReservedName(reserved, name) {
		if (reserved) {
			for (var i = 0; i < reserved.length; ++i) if (reserved[i] === name) return true;
		}
		return false;
	};
	/**
	* Not an actual constructor. Use {@link Namespace} instead.
	* @classdesc Base class of all reflection objects containing nested objects. This is not an actual class but here for the sake of having consistent type definitions.
	* @exports NamespaceBase
	* @extends ReflectionObject
	* @abstract
	* @constructor
	* @param {string} name Namespace name
	* @param {Object.<string,*>} [options] Declared options
	* @see {@link Namespace}
	*/
	function Namespace(name, options) {
		ReflectionObject.call(this, name, options);
		/**
		* Nested objects by name.
		* @type {Object.<string,ReflectionObject>|undefined}
		*/
		this.nested = void 0;
		/**
		* Cached nested objects as an array.
		* @type {ReflectionObject[]|null}
		* @private
		*/
		this._nestedArray = null;
		/**
		* Cache lookup calls for any objects contains anywhere under this namespace.
		* This drastically speeds up resolve for large cross-linked protos where the same
		* types are looked up repeatedly.
		* @type {Object.<string,ReflectionObject|null>}
		* @private
		*/
		this._lookupCache = {};
		/**
		* Whether or not objects contained in this namespace need feature resolution.
		* @type {boolean}
		* @protected
		*/
		this._needsRecursiveFeatureResolution = true;
		/**
		* Whether or not objects contained in this namespace need a resolve.
		* @type {boolean}
		* @protected
		*/
		this._needsRecursiveResolve = true;
	}
	function clearCache(namespace) {
		namespace._nestedArray = null;
		namespace._lookupCache = {};
		var parent = namespace;
		while (parent = parent.parent) parent._lookupCache = {};
		return namespace;
	}
	/**
	* Nested objects of this namespace as an array for iteration.
	* @name NamespaceBase#nestedArray
	* @type {ReflectionObject[]}
	* @readonly
	*/
	Object.defineProperty(Namespace.prototype, "nestedArray", { get: function() {
		return this._nestedArray || (this._nestedArray = util.toArray(this.nested));
	} });
	/**
	* Namespace descriptor.
	* @interface INamespace
	* @property {Object.<string,*>} [options] Namespace options
	* @property {Object.<string,AnyNestedObject>} [nested] Nested object descriptors
	*/
	/**
	* Any extension field descriptor.
	* @typedef AnyExtensionField
	* @type {IExtensionField|IExtensionMapField}
	*/
	/**
	* Any nested object descriptor.
	* @typedef AnyNestedObject
	* @type {IEnum|IType|IService|AnyExtensionField|INamespace|IOneOf}
	*/
	/**
	* Converts this namespace to a namespace descriptor.
	* @param {IToJSONOptions} [toJSONOptions] JSON conversion options
	* @returns {INamespace} Namespace descriptor
	*/
	Namespace.prototype.toJSON = function toJSON(toJSONOptions) {
		return util.toObject([
			"options",
			this.options,
			"nested",
			arrayToJSON(this.nestedArray, toJSONOptions)
		]);
	};
	/**
	* Adds nested objects to this namespace from nested object descriptors.
	* @param {Object.<string,AnyNestedObject>} nestedJson Any nested object descriptors
	* @returns {Namespace} `this`
	*/
	Namespace.prototype.addJSON = function addJSON(nestedJson) {
		var ns = this;
		/* istanbul ignore else */
		if (nestedJson) for (var names = Object.keys(nestedJson), i = 0, nested; i < names.length; ++i) {
			nested = nestedJson[names[i]];
			ns.add((nested.fields !== void 0 ? Type.fromJSON : nested.values !== void 0 ? Enum.fromJSON : nested.methods !== void 0 ? Service.fromJSON : nested.id !== void 0 ? Field.fromJSON : Namespace.fromJSON)(names[i], nested));
		}
		return this;
	};
	/**
	* Gets the nested object of the specified name.
	* @param {string} name Nested object name
	* @returns {ReflectionObject|null} The reflection object or `null` if it doesn't exist
	*/
	Namespace.prototype.get = function get(name) {
		return this.nested && this.nested[name] || null;
	};
	/**
	* Gets the values of the nested {@link Enum|enum} of the specified name.
	* This methods differs from {@link Namespace#get|get} in that it returns an enum's values directly and throws instead of returning `null`.
	* @param {string} name Nested enum name
	* @returns {Object.<string,number>} Enum values
	* @throws {Error} If there is no such enum
	*/
	Namespace.prototype.getEnum = function getEnum(name) {
		if (this.nested && this.nested[name] instanceof Enum) return this.nested[name].values;
		throw Error("no such enum: " + name);
	};
	/**
	* Adds a nested object to this namespace.
	* @param {ReflectionObject} object Nested object to add
	* @returns {Namespace} `this`
	* @throws {TypeError} If arguments are invalid
	* @throws {Error} If there is already a nested object with this name
	*/
	Namespace.prototype.add = function add(object) {
		if (!(object instanceof Field && object.extend !== void 0 || object instanceof Type || object instanceof OneOf || object instanceof Enum || object instanceof Service || object instanceof Namespace)) throw TypeError("object must be a valid nested object");
		if (!this.nested) this.nested = {};
		else {
			var prev = this.get(object.name);
			if (prev) if (prev instanceof Namespace && object instanceof Namespace && !(prev instanceof Type || prev instanceof Service)) {
				var nested = prev.nestedArray;
				for (var i = 0; i < nested.length; ++i) object.add(nested[i]);
				this.remove(prev);
				if (!this.nested) this.nested = {};
				object.setOptions(prev.options, true);
			} else throw Error("duplicate name '" + object.name + "' in " + this);
		}
		this.nested[object.name] = object;
		if (!(this instanceof Type || this instanceof Service || this instanceof Enum || this instanceof Field)) {
			if (!object._edition) object._edition = object._defaultEdition;
		}
		this._needsRecursiveFeatureResolution = true;
		this._needsRecursiveResolve = true;
		var parent = this;
		while (parent = parent.parent) {
			parent._needsRecursiveFeatureResolution = true;
			parent._needsRecursiveResolve = true;
		}
		object.onAdd(this);
		return clearCache(this);
	};
	/**
	* Removes a nested object from this namespace.
	* @param {ReflectionObject} object Nested object to remove
	* @returns {Namespace} `this`
	* @throws {TypeError} If arguments are invalid
	* @throws {Error} If `object` is not a member of this namespace
	*/
	Namespace.prototype.remove = function remove(object) {
		if (!(object instanceof ReflectionObject)) throw TypeError("object must be a ReflectionObject");
		if (object.parent !== this) throw Error(object + " is not a member of " + this);
		delete this.nested[object.name];
		if (!Object.keys(this.nested).length) this.nested = void 0;
		object.onRemove(this);
		return clearCache(this);
	};
	/**
	* Defines additial namespaces within this one if not yet existing.
	* @param {string|string[]} path Path to create
	* @param {*} [json] Nested types to create from JSON
	* @returns {Namespace} Pointer to the last namespace created or `this` if path is empty
	*/
	Namespace.prototype.define = function define(path, json) {
		if (util.isString(path)) path = path.split(".");
		else if (!Array.isArray(path)) throw TypeError("illegal path");
		if (path && path.length && path[0] === "") throw Error("path must be relative");
		var ptr = this;
		while (path.length > 0) {
			var part = path.shift();
			if (ptr.nested && ptr.nested[part]) {
				ptr = ptr.nested[part];
				if (!(ptr instanceof Namespace)) throw Error("path conflicts with non-namespace objects");
			} else ptr.add(ptr = new Namespace(part));
		}
		if (json) ptr.addJSON(json);
		return ptr;
	};
	/**
	* Resolves this namespace's and all its nested objects' type references. Useful to validate a reflection tree, but comes at a cost.
	* @returns {Namespace} `this`
	*/
	Namespace.prototype.resolveAll = function resolveAll() {
		if (!this._needsRecursiveResolve) return this;
		this._resolveFeaturesRecursive(this._edition);
		var nested = this.nestedArray, i = 0;
		this.resolve();
		while (i < nested.length) if (nested[i] instanceof Namespace) nested[i++].resolveAll();
		else nested[i++].resolve();
		this._needsRecursiveResolve = false;
		return this;
	};
	/**
	* @override
	*/
	Namespace.prototype._resolveFeaturesRecursive = function _resolveFeaturesRecursive(edition) {
		if (!this._needsRecursiveFeatureResolution) return this;
		this._needsRecursiveFeatureResolution = false;
		edition = this._edition || edition;
		ReflectionObject.prototype._resolveFeaturesRecursive.call(this, edition);
		this.nestedArray.forEach((nested) => {
			nested._resolveFeaturesRecursive(edition);
		});
		return this;
	};
	/**
	* Recursively looks up the reflection object matching the specified path in the scope of this namespace.
	* @param {string|string[]} path Path to look up
	* @param {*|Array.<*>} filterTypes Filter types, any combination of the constructors of `protobuf.Type`, `protobuf.Enum`, `protobuf.Service` etc.
	* @param {boolean} [parentAlreadyChecked=false] If known, whether the parent has already been checked
	* @returns {ReflectionObject|null} Looked up object or `null` if none could be found
	*/
	Namespace.prototype.lookup = function lookup(path, filterTypes, parentAlreadyChecked) {
		/* istanbul ignore next */
		if (typeof filterTypes === "boolean") {
			parentAlreadyChecked = filterTypes;
			filterTypes = void 0;
		} else if (filterTypes && !Array.isArray(filterTypes)) filterTypes = [filterTypes];
		if (util.isString(path) && path.length) {
			if (path === ".") return this.root;
			path = path.split(".");
		} else if (!path.length) return this;
		var flatPath = path.join(".");
		if (path[0] === "") return this.root.lookup(path.slice(1), filterTypes);
		var found = this.root._fullyQualifiedObjects && this.root._fullyQualifiedObjects["." + flatPath];
		if (found && (!filterTypes || filterTypes.indexOf(found.constructor) > -1)) return found;
		found = this._lookupImpl(path, flatPath);
		if (found && (!filterTypes || filterTypes.indexOf(found.constructor) > -1)) return found;
		if (parentAlreadyChecked) return null;
		var current = this;
		while (current.parent) {
			found = current.parent._lookupImpl(path, flatPath);
			if (found && (!filterTypes || filterTypes.indexOf(found.constructor) > -1)) return found;
			current = current.parent;
		}
		return null;
	};
	/**
	* Internal helper for lookup that handles searching just at this namespace and below along with caching.
	* @param {string[]} path Path to look up
	* @param {string} flatPath Flattened version of the path to use as a cache key
	* @returns {ReflectionObject|null} Looked up object or `null` if none could be found
	* @private
	*/
	Namespace.prototype._lookupImpl = function lookup(path, flatPath) {
		if (Object.prototype.hasOwnProperty.call(this._lookupCache, flatPath)) return this._lookupCache[flatPath];
		var found = this.get(path[0]);
		var exact = null;
		if (found) {
			if (path.length === 1) exact = found;
			else if (found instanceof Namespace) {
				path = path.slice(1);
				exact = found._lookupImpl(path, path.join("."));
			}
		} else for (var i = 0; i < this.nestedArray.length; ++i) if (this._nestedArray[i] instanceof Namespace && (found = this._nestedArray[i]._lookupImpl(path, flatPath))) exact = found;
		this._lookupCache[flatPath] = exact;
		return exact;
	};
	/**
	* Looks up the reflection object at the specified path, relative to this namespace.
	* @name NamespaceBase#lookup
	* @function
	* @param {string|string[]} path Path to look up
	* @param {boolean} [parentAlreadyChecked=false] Whether the parent has already been checked
	* @returns {ReflectionObject|null} Looked up object or `null` if none could be found
	* @variation 2
	*/
	/**
	* Looks up the {@link Type|type} at the specified path, relative to this namespace.
	* Besides its signature, this methods differs from {@link Namespace#lookup|lookup} in that it throws instead of returning `null`.
	* @param {string|string[]} path Path to look up
	* @returns {Type} Looked up type
	* @throws {Error} If `path` does not point to a type
	*/
	Namespace.prototype.lookupType = function lookupType(path) {
		var found = this.lookup(path, [Type]);
		if (!found) throw Error("no such type: " + path);
		return found;
	};
	/**
	* Looks up the values of the {@link Enum|enum} at the specified path, relative to this namespace.
	* Besides its signature, this methods differs from {@link Namespace#lookup|lookup} in that it throws instead of returning `null`.
	* @param {string|string[]} path Path to look up
	* @returns {Enum} Looked up enum
	* @throws {Error} If `path` does not point to an enum
	*/
	Namespace.prototype.lookupEnum = function lookupEnum(path) {
		var found = this.lookup(path, [Enum]);
		if (!found) throw Error("no such Enum '" + path + "' in " + this);
		return found;
	};
	/**
	* Looks up the {@link Type|type} or {@link Enum|enum} at the specified path, relative to this namespace.
	* Besides its signature, this methods differs from {@link Namespace#lookup|lookup} in that it throws instead of returning `null`.
	* @param {string|string[]} path Path to look up
	* @returns {Type} Looked up type or enum
	* @throws {Error} If `path` does not point to a type or enum
	*/
	Namespace.prototype.lookupTypeOrEnum = function lookupTypeOrEnum(path) {
		var found = this.lookup(path, [Type, Enum]);
		if (!found) throw Error("no such Type or Enum '" + path + "' in " + this);
		return found;
	};
	/**
	* Looks up the {@link Service|service} at the specified path, relative to this namespace.
	* Besides its signature, this methods differs from {@link Namespace#lookup|lookup} in that it throws instead of returning `null`.
	* @param {string|string[]} path Path to look up
	* @returns {Service} Looked up service
	* @throws {Error} If `path` does not point to a service
	*/
	Namespace.prototype.lookupService = function lookupService(path) {
		var found = this.lookup(path, [Service]);
		if (!found) throw Error("no such Service '" + path + "' in " + this);
		return found;
	};
	Namespace._configure = function(Type_, Service_, Enum_) {
		Type = Type_;
		Service = Service_;
		Enum = Enum_;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/mapfield.js
var require_mapfield = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = MapField;
	var Field = require_field();
	((MapField.prototype = Object.create(Field.prototype)).constructor = MapField).className = "MapField";
	var types = require_types(), util = require_util$1();
	/**
	* Constructs a new map field instance.
	* @classdesc Reflected map field.
	* @extends FieldBase
	* @constructor
	* @param {string} name Unique name within its namespace
	* @param {number} id Unique id within its namespace
	* @param {string} keyType Key type
	* @param {string} type Value type
	* @param {Object.<string,*>} [options] Declared options
	* @param {string} [comment] Comment associated with this field
	*/
	function MapField(name, id, keyType, type, options, comment) {
		Field.call(this, name, id, type, void 0, void 0, options, comment);
		/* istanbul ignore if */
		if (!util.isString(keyType)) throw TypeError("keyType must be a string");
		/**
		* Key type.
		* @type {string}
		*/
		this.keyType = keyType;
		/**
		* Resolved key type if not a basic type.
		* @type {ReflectionObject|null}
		*/
		this.resolvedKeyType = null;
		this.map = true;
	}
	/**
	* Map field descriptor.
	* @interface IMapField
	* @extends {IField}
	* @property {string} keyType Key type
	*/
	/**
	* Extension map field descriptor.
	* @interface IExtensionMapField
	* @extends IMapField
	* @property {string} extend Extended type
	*/
	/**
	* Constructs a map field from a map field descriptor.
	* @param {string} name Field name
	* @param {IMapField} json Map field descriptor
	* @returns {MapField} Created map field
	* @throws {TypeError} If arguments are invalid
	*/
	MapField.fromJSON = function fromJSON(name, json) {
		return new MapField(name, json.id, json.keyType, json.type, json.options, json.comment);
	};
	/**
	* Converts this map field to a map field descriptor.
	* @param {IToJSONOptions} [toJSONOptions] JSON conversion options
	* @returns {IMapField} Map field descriptor
	*/
	MapField.prototype.toJSON = function toJSON(toJSONOptions) {
		var keepComments = toJSONOptions ? Boolean(toJSONOptions.keepComments) : false;
		return util.toObject([
			"keyType",
			this.keyType,
			"type",
			this.type,
			"id",
			this.id,
			"extend",
			this.extend,
			"options",
			this.options,
			"comment",
			keepComments ? this.comment : void 0
		]);
	};
	/**
	* @override
	*/
	MapField.prototype.resolve = function resolve() {
		if (this.resolved) return this;
		if (types.mapKey[this.keyType] === void 0) throw Error("invalid key type: " + this.keyType);
		return Field.prototype.resolve.call(this);
	};
	/**
	* Map field decorator (TypeScript).
	* @name MapField.d
	* @function
	* @param {number} fieldId Field id
	* @param {"int32"|"uint32"|"sint32"|"fixed32"|"sfixed32"|"int64"|"uint64"|"sint64"|"fixed64"|"sfixed64"|"bool"|"string"} fieldKeyType Field key type
	* @param {"double"|"float"|"int32"|"uint32"|"sint32"|"fixed32"|"sfixed32"|"int64"|"uint64"|"sint64"|"fixed64"|"sfixed64"|"bool"|"string"|"bytes"|Object|Constructor<{}>} fieldValueType Field value type
	* @returns {FieldDecorator} Decorator function
	* @template T extends { [key: string]: number | Long | string | boolean | Uint8Array | Buffer | number[] | Message<{}> }
	*/
	MapField.d = function decorateMapField(fieldId, fieldKeyType, fieldValueType) {
		if (typeof fieldValueType === "function") fieldValueType = util.decorateType(fieldValueType).name;
		else if (fieldValueType && typeof fieldValueType === "object") fieldValueType = util.decorateEnum(fieldValueType).name;
		return function mapFieldDecorator(prototype, fieldName) {
			util.decorateType(prototype.constructor).add(new MapField(fieldName, fieldId, fieldKeyType, fieldValueType));
		};
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/method.js
var require_method = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Method;
	var ReflectionObject = require_object();
	((Method.prototype = Object.create(ReflectionObject.prototype)).constructor = Method).className = "Method";
	var util = require_util$1();
	/**
	* Constructs a new service method instance.
	* @classdesc Reflected service method.
	* @extends ReflectionObject
	* @constructor
	* @param {string} name Method name
	* @param {string|undefined} type Method type, usually `"rpc"`
	* @param {string} requestType Request message type
	* @param {string} responseType Response message type
	* @param {boolean|Object.<string,*>} [requestStream] Whether the request is streamed
	* @param {boolean|Object.<string,*>} [responseStream] Whether the response is streamed
	* @param {Object.<string,*>} [options] Declared options
	* @param {string} [comment] The comment for this method
	* @param {Object.<string,*>} [parsedOptions] Declared options, properly parsed into an object
	*/
	function Method(name, type, requestType, responseType, requestStream, responseStream, options, comment, parsedOptions) {
		/* istanbul ignore next */
		if (util.isObject(requestStream)) {
			options = requestStream;
			requestStream = responseStream = void 0;
		} else if (util.isObject(responseStream)) {
			options = responseStream;
			responseStream = void 0;
		}
		/* istanbul ignore if */
		if (!(type === void 0 || util.isString(type))) throw TypeError("type must be a string");
		/* istanbul ignore if */
		if (!util.isString(requestType)) throw TypeError("requestType must be a string");
		/* istanbul ignore if */
		if (!util.isString(responseType)) throw TypeError("responseType must be a string");
		ReflectionObject.call(this, name, options);
		/**
		* Method type.
		* @type {string}
		*/
		this.type = type || "rpc";
		/**
		* Request type.
		* @type {string}
		*/
		this.requestType = requestType;
		/**
		* Whether requests are streamed or not.
		* @type {boolean|undefined}
		*/
		this.requestStream = requestStream ? true : void 0;
		/**
		* Response type.
		* @type {string}
		*/
		this.responseType = responseType;
		/**
		* Whether responses are streamed or not.
		* @type {boolean|undefined}
		*/
		this.responseStream = responseStream ? true : void 0;
		/**
		* Resolved request type.
		* @type {Type|null}
		*/
		this.resolvedRequestType = null;
		/**
		* Resolved response type.
		* @type {Type|null}
		*/
		this.resolvedResponseType = null;
		/**
		* Comment for this method
		* @type {string|null}
		*/
		this.comment = comment;
		/**
		* Options properly parsed into an object
		*/
		this.parsedOptions = parsedOptions;
	}
	/**
	* Method descriptor.
	* @interface IMethod
	* @property {string} [type="rpc"] Method type
	* @property {string} requestType Request type
	* @property {string} responseType Response type
	* @property {boolean} [requestStream=false] Whether requests are streamed
	* @property {boolean} [responseStream=false] Whether responses are streamed
	* @property {Object.<string,*>} [options] Method options
	* @property {string} comment Method comments
	* @property {Object.<string,*>} [parsedOptions] Method options properly parsed into an object
	*/
	/**
	* Constructs a method from a method descriptor.
	* @param {string} name Method name
	* @param {IMethod} json Method descriptor
	* @returns {Method} Created method
	* @throws {TypeError} If arguments are invalid
	*/
	Method.fromJSON = function fromJSON(name, json) {
		return new Method(name, json.type, json.requestType, json.responseType, json.requestStream, json.responseStream, json.options, json.comment, json.parsedOptions);
	};
	/**
	* Converts this method to a method descriptor.
	* @param {IToJSONOptions} [toJSONOptions] JSON conversion options
	* @returns {IMethod} Method descriptor
	*/
	Method.prototype.toJSON = function toJSON(toJSONOptions) {
		var keepComments = toJSONOptions ? Boolean(toJSONOptions.keepComments) : false;
		return util.toObject([
			"type",
			this.type !== "rpc" && this.type || void 0,
			"requestType",
			this.requestType,
			"requestStream",
			this.requestStream,
			"responseType",
			this.responseType,
			"responseStream",
			this.responseStream,
			"options",
			this.options,
			"comment",
			keepComments ? this.comment : void 0,
			"parsedOptions",
			this.parsedOptions
		]);
	};
	/**
	* @override
	*/
	Method.prototype.resolve = function resolve() {
		/* istanbul ignore if */
		if (this.resolved) return this;
		this.resolvedRequestType = this.parent.lookupType(this.requestType);
		this.resolvedResponseType = this.parent.lookupType(this.responseType);
		return ReflectionObject.prototype.resolve.call(this);
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/service.js
var require_service = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Service;
	var Namespace = require_namespace();
	((Service.prototype = Object.create(Namespace.prototype)).constructor = Service).className = "Service";
	var Method = require_method(), util = require_util$1(), rpc = require_rpc();
	/**
	* Constructs a new service instance.
	* @classdesc Reflected service.
	* @extends NamespaceBase
	* @constructor
	* @param {string} name Service name
	* @param {Object.<string,*>} [options] Service options
	* @throws {TypeError} If arguments are invalid
	*/
	function Service(name, options) {
		Namespace.call(this, name, options);
		/**
		* Service methods.
		* @type {Object.<string,Method>}
		*/
		this.methods = {};
		/**
		* Cached methods as an array.
		* @type {Method[]|null}
		* @private
		*/
		this._methodsArray = null;
	}
	/**
	* Service descriptor.
	* @interface IService
	* @extends INamespace
	* @property {Object.<string,IMethod>} methods Method descriptors
	*/
	/**
	* Constructs a service from a service descriptor.
	* @param {string} name Service name
	* @param {IService} json Service descriptor
	* @returns {Service} Created service
	* @throws {TypeError} If arguments are invalid
	*/
	Service.fromJSON = function fromJSON(name, json) {
		var service = new Service(name, json.options);
		/* istanbul ignore else */
		if (json.methods) for (var names = Object.keys(json.methods), i = 0; i < names.length; ++i) service.add(Method.fromJSON(names[i], json.methods[names[i]]));
		if (json.nested) service.addJSON(json.nested);
		if (json.edition) service._edition = json.edition;
		service.comment = json.comment;
		service._defaultEdition = "proto3";
		return service;
	};
	/**
	* Converts this service to a service descriptor.
	* @param {IToJSONOptions} [toJSONOptions] JSON conversion options
	* @returns {IService} Service descriptor
	*/
	Service.prototype.toJSON = function toJSON(toJSONOptions) {
		var inherited = Namespace.prototype.toJSON.call(this, toJSONOptions);
		var keepComments = toJSONOptions ? Boolean(toJSONOptions.keepComments) : false;
		return util.toObject([
			"edition",
			this._editionToJSON(),
			"options",
			inherited && inherited.options || void 0,
			"methods",
			Namespace.arrayToJSON(this.methodsArray, toJSONOptions) || (			/* istanbul ignore next */ {}),
			"nested",
			inherited && inherited.nested || void 0,
			"comment",
			keepComments ? this.comment : void 0
		]);
	};
	/**
	* Methods of this service as an array for iteration.
	* @name Service#methodsArray
	* @type {Method[]}
	* @readonly
	*/
	Object.defineProperty(Service.prototype, "methodsArray", { get: function() {
		return this._methodsArray || (this._methodsArray = util.toArray(this.methods));
	} });
	function clearCache(service) {
		service._methodsArray = null;
		return service;
	}
	/**
	* @override
	*/
	Service.prototype.get = function get(name) {
		return this.methods[name] || Namespace.prototype.get.call(this, name);
	};
	/**
	* @override
	*/
	Service.prototype.resolveAll = function resolveAll() {
		if (!this._needsRecursiveResolve) return this;
		Namespace.prototype.resolve.call(this);
		var methods = this.methodsArray;
		for (var i = 0; i < methods.length; ++i) methods[i].resolve();
		return this;
	};
	/**
	* @override
	*/
	Service.prototype._resolveFeaturesRecursive = function _resolveFeaturesRecursive(edition) {
		if (!this._needsRecursiveFeatureResolution) return this;
		edition = this._edition || edition;
		Namespace.prototype._resolveFeaturesRecursive.call(this, edition);
		this.methodsArray.forEach((method) => {
			method._resolveFeaturesRecursive(edition);
		});
		return this;
	};
	/**
	* @override
	*/
	Service.prototype.add = function add(object) {
		/* istanbul ignore if */
		if (this.get(object.name)) throw Error("duplicate name '" + object.name + "' in " + this);
		if (object instanceof Method) {
			this.methods[object.name] = object;
			object.parent = this;
			return clearCache(this);
		}
		return Namespace.prototype.add.call(this, object);
	};
	/**
	* @override
	*/
	Service.prototype.remove = function remove(object) {
		if (object instanceof Method) {
			/* istanbul ignore if */
			if (this.methods[object.name] !== object) throw Error(object + " is not a member of " + this);
			delete this.methods[object.name];
			object.parent = null;
			return clearCache(this);
		}
		return Namespace.prototype.remove.call(this, object);
	};
	/**
	* Creates a runtime service using the specified rpc implementation.
	* @param {RPCImpl} rpcImpl RPC implementation
	* @param {boolean} [requestDelimited=false] Whether requests are length-delimited
	* @param {boolean} [responseDelimited=false] Whether responses are length-delimited
	* @returns {rpc.Service} RPC service. Useful where requests and/or responses are streamed.
	*/
	Service.prototype.create = function create(rpcImpl, requestDelimited, responseDelimited) {
		var rpcService = new rpc.Service(rpcImpl, requestDelimited, responseDelimited);
		for (var i = 0, method; i < this.methodsArray.length; ++i) {
			var methodName = util.lcFirst((method = this._methodsArray[i]).resolve().name).replace(/[^$\w_]/g, "");
			rpcService[methodName] = util.codegen(["r", "c"], util.isReserved(methodName) ? methodName + "_" : methodName)("return this.rpcCall(m,q,s,r,c)")({
				m: method,
				q: method.resolvedRequestType.ctor,
				s: method.resolvedResponseType.ctor
			});
		}
		return rpcService;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/message.js
var require_message = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Message;
	var util = require_minimal();
	/**
	* Constructs a new message instance.
	* @classdesc Abstract runtime message.
	* @constructor
	* @param {Properties<T>} [properties] Properties to set
	* @template T extends object = object
	*/
	function Message(properties) {
		if (properties) for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i) this[keys[i]] = properties[keys[i]];
	}
	/**
	* Reference to the reflected type.
	* @name Message.$type
	* @type {Type}
	* @readonly
	*/
	/**
	* Reference to the reflected type.
	* @name Message#$type
	* @type {Type}
	* @readonly
	*/
	/**
	* Creates a new message of this type using the specified properties.
	* @param {Object.<string,*>} [properties] Properties to set
	* @returns {Message<T>} Message instance
	* @template T extends Message<T>
	* @this Constructor<T>
	*/
	Message.create = function create(properties) {
		return this.$type.create(properties);
	};
	/**
	* Encodes a message of this type.
	* @param {T|Object.<string,*>} message Message to encode
	* @param {Writer} [writer] Writer to use
	* @returns {Writer} Writer
	* @template T extends Message<T>
	* @this Constructor<T>
	*/
	Message.encode = function encode(message, writer) {
		return this.$type.encode(message, writer);
	};
	/**
	* Encodes a message of this type preceeded by its length as a varint.
	* @param {T|Object.<string,*>} message Message to encode
	* @param {Writer} [writer] Writer to use
	* @returns {Writer} Writer
	* @template T extends Message<T>
	* @this Constructor<T>
	*/
	Message.encodeDelimited = function encodeDelimited(message, writer) {
		return this.$type.encodeDelimited(message, writer);
	};
	/**
	* Decodes a message of this type.
	* @name Message.decode
	* @function
	* @param {Reader|Uint8Array} reader Reader or buffer to decode
	* @returns {T} Decoded message
	* @template T extends Message<T>
	* @this Constructor<T>
	*/
	Message.decode = function decode(reader) {
		return this.$type.decode(reader);
	};
	/**
	* Decodes a message of this type preceeded by its length as a varint.
	* @name Message.decodeDelimited
	* @function
	* @param {Reader|Uint8Array} reader Reader or buffer to decode
	* @returns {T} Decoded message
	* @template T extends Message<T>
	* @this Constructor<T>
	*/
	Message.decodeDelimited = function decodeDelimited(reader) {
		return this.$type.decodeDelimited(reader);
	};
	/**
	* Verifies a message of this type.
	* @name Message.verify
	* @function
	* @param {Object.<string,*>} message Plain object to verify
	* @returns {string|null} `null` if valid, otherwise the reason why it is not
	*/
	Message.verify = function verify(message) {
		return this.$type.verify(message);
	};
	/**
	* Creates a new message of this type from a plain object. Also converts values to their respective internal types.
	* @param {Object.<string,*>} object Plain object
	* @returns {T} Message instance
	* @template T extends Message<T>
	* @this Constructor<T>
	*/
	Message.fromObject = function fromObject(object) {
		return this.$type.fromObject(object);
	};
	/**
	* Creates a plain object from a message of this type. Also converts values to other types if specified.
	* @param {T} message Message instance
	* @param {IConversionOptions} [options] Conversion options
	* @returns {Object.<string,*>} Plain object
	* @template T extends Message<T>
	* @this Constructor<T>
	*/
	Message.toObject = function toObject(message, options) {
		return this.$type.toObject(message, options);
	};
	/**
	* Converts this message to JSON.
	* @returns {Object.<string,*>} JSON object
	*/
	Message.prototype.toJSON = function toJSON() {
		return this.$type.toObject(this, util.toJSONOptions);
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/decoder.js
var require_decoder = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = decoder;
	var Enum = require_enum(), types = require_types(), util = require_util$1();
	function missing(field) {
		return "missing required '" + field.name + "'";
	}
	/**
	* Generates a decoder specific to the specified message type.
	* @param {Type} mtype Message type
	* @returns {Codegen} Codegen instance
	*/
	function decoder(mtype) {
		var gen = util.codegen([
			"r",
			"l",
			"e"
		], mtype.name + "$decode")("if(!(r instanceof Reader))")("r=Reader.create(r)")("var c=l===undefined?r.len:r.pos+l,m=new this.ctor" + (mtype.fieldsArray.filter(function(field) {
			return field.map;
		}).length ? ",k,value" : ""))("while(r.pos<c){")("var t=r.uint32()")("if(t===e)")("break")("switch(t>>>3){");
		var i = 0;
		for (; i < mtype.fieldsArray.length; ++i) {
			var field = mtype._fieldsArray[i].resolve(), type = field.resolvedType instanceof Enum ? "int32" : field.type, ref = "m" + util.safeProp(field.name);
			gen("case %i: {", field.id);
			if (field.map) {
				gen("if(%s===util.emptyObject)", ref)("%s={}", ref)("var c2 = r.uint32()+r.pos");
				if (types.defaults[field.keyType] !== void 0) gen("k=%j", types.defaults[field.keyType]);
				else gen("k=null");
				if (types.defaults[type] !== void 0) gen("value=%j", types.defaults[type]);
				else gen("value=null");
				gen("while(r.pos<c2){")("var tag2=r.uint32()")("switch(tag2>>>3){")("case 1: k=r.%s(); break", field.keyType)("case 2:");
				if (types.basic[type] === void 0) gen("value=types[%i].decode(r,r.uint32())", i);
				else gen("value=r.%s()", type);
				gen("break")("default:")("r.skipType(tag2&7)")("break")("}")("}");
				if (types.long[field.keyType] !== void 0) gen("%s[typeof k===\"object\"?util.longToHash(k):k]=value", ref);
				else gen("%s[k]=value", ref);
			} else if (field.repeated) {
				gen("if(!(%s&&%s.length))", ref, ref)("%s=[]", ref);
				if (types.packed[type] !== void 0) gen("if((t&7)===2){")("var c2=r.uint32()+r.pos")("while(r.pos<c2)")("%s.push(r.%s())", ref, type)("}else");
				if (types.basic[type] === void 0) gen(field.delimited ? "%s.push(types[%i].decode(r,undefined,((t&~7)|4)))" : "%s.push(types[%i].decode(r,r.uint32()))", ref, i);
				else gen("%s.push(r.%s())", ref, type);
			} else if (types.basic[type] === void 0) gen(field.delimited ? "%s=types[%i].decode(r,undefined,((t&~7)|4))" : "%s=types[%i].decode(r,r.uint32())", ref, i);
			else gen("%s=r.%s()", ref, type);
			gen("break")("}");
		}
		gen("default:")("r.skipType(t&7)")("break")("}")("}");
		for (i = 0; i < mtype._fieldsArray.length; ++i) {
			var rfield = mtype._fieldsArray[i];
			if (rfield.required) gen("if(!m.hasOwnProperty(%j))", rfield.name)("throw util.ProtocolError(%j,{instance:m})", missing(rfield));
		}
		return gen("return m");
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/verifier.js
var require_verifier = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = verifier;
	var Enum = require_enum(), util = require_util$1();
	function invalid(field, expected) {
		return field.name + ": " + expected + (field.repeated && expected !== "array" ? "[]" : field.map && expected !== "object" ? "{k:" + field.keyType + "}" : "") + " expected";
	}
	/**
	* Generates a partial value verifier.
	* @param {Codegen} gen Codegen instance
	* @param {Field} field Reflected field
	* @param {number} fieldIndex Field index
	* @param {string} ref Variable reference
	* @returns {Codegen} Codegen instance
	* @ignore
	*/
	function genVerifyValue(gen, field, fieldIndex, ref) {
		if (field.resolvedType) if (field.resolvedType instanceof Enum) {
			gen("switch(%s){", ref)("default:")("return%j", invalid(field, "enum value"));
			for (var keys = Object.keys(field.resolvedType.values), j = 0; j < keys.length; ++j) gen("case %i:", field.resolvedType.values[keys[j]]);
			gen("break")("}");
		} else gen("{")("var e=types[%i].verify(%s);", fieldIndex, ref)("if(e)")("return%j+e", field.name + ".")("}");
		else switch (field.type) {
			case "int32":
			case "uint32":
			case "sint32":
			case "fixed32":
			case "sfixed32":
				gen("if(!util.isInteger(%s))", ref)("return%j", invalid(field, "integer"));
				break;
			case "int64":
			case "uint64":
			case "sint64":
			case "fixed64":
			case "sfixed64":
				gen("if(!util.isInteger(%s)&&!(%s&&util.isInteger(%s.low)&&util.isInteger(%s.high)))", ref, ref, ref, ref)("return%j", invalid(field, "integer|Long"));
				break;
			case "float":
			case "double":
				gen("if(typeof %s!==\"number\")", ref)("return%j", invalid(field, "number"));
				break;
			case "bool":
				gen("if(typeof %s!==\"boolean\")", ref)("return%j", invalid(field, "boolean"));
				break;
			case "string":
				gen("if(!util.isString(%s))", ref)("return%j", invalid(field, "string"));
				break;
			case "bytes":
				gen("if(!(%s&&typeof %s.length===\"number\"||util.isString(%s)))", ref, ref, ref)("return%j", invalid(field, "buffer"));
				break;
		}
		return gen;
	}
	/**
	* Generates a partial key verifier.
	* @param {Codegen} gen Codegen instance
	* @param {Field} field Reflected field
	* @param {string} ref Variable reference
	* @returns {Codegen} Codegen instance
	* @ignore
	*/
	function genVerifyKey(gen, field, ref) {
		switch (field.keyType) {
			case "int32":
			case "uint32":
			case "sint32":
			case "fixed32":
			case "sfixed32":
				gen("if(!util.key32Re.test(%s))", ref)("return%j", invalid(field, "integer key"));
				break;
			case "int64":
			case "uint64":
			case "sint64":
			case "fixed64":
			case "sfixed64":
				gen("if(!util.key64Re.test(%s))", ref)("return%j", invalid(field, "integer|Long key"));
				break;
			case "bool":
				gen("if(!util.key2Re.test(%s))", ref)("return%j", invalid(field, "boolean key"));
				break;
		}
		return gen;
	}
	/**
	* Generates a verifier specific to the specified message type.
	* @param {Type} mtype Message type
	* @returns {Codegen} Codegen instance
	*/
	function verifier(mtype) {
		var gen = util.codegen(["m"], mtype.name + "$verify")("if(typeof m!==\"object\"||m===null)")("return%j", "object expected");
		var oneofs = mtype.oneofsArray, seenFirstField = {};
		if (oneofs.length) gen("var p={}");
		for (var i = 0; i < mtype.fieldsArray.length; ++i) {
			var field = mtype._fieldsArray[i].resolve(), ref = "m" + util.safeProp(field.name);
			if (field.optional) gen("if(%s!=null&&m.hasOwnProperty(%j)){", ref, field.name);
			if (field.map) {
				gen("if(!util.isObject(%s))", ref)("return%j", invalid(field, "object"))("var k=Object.keys(%s)", ref)("for(var i=0;i<k.length;++i){");
				genVerifyKey(gen, field, "k[i]");
				genVerifyValue(gen, field, i, ref + "[k[i]]")("}");
			} else if (field.repeated) {
				gen("if(!Array.isArray(%s))", ref)("return%j", invalid(field, "array"))("for(var i=0;i<%s.length;++i){", ref);
				genVerifyValue(gen, field, i, ref + "[i]")("}");
			} else {
				if (field.partOf) {
					var oneofProp = util.safeProp(field.partOf.name);
					if (seenFirstField[field.partOf.name] === 1) gen("if(p%s===1)", oneofProp)("return%j", field.partOf.name + ": multiple values");
					seenFirstField[field.partOf.name] = 1;
					gen("p%s=1", oneofProp);
				}
				genVerifyValue(gen, field, i, ref);
			}
			if (field.optional) gen("}");
		}
		return gen("return null");
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/converter.js
var require_converter = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Runtime message from/to plain object converters.
	* @namespace
	*/
	var converter = exports;
	var Enum = require_enum(), util = require_util$1();
	/**
	* Generates a partial value fromObject conveter.
	* @param {Codegen} gen Codegen instance
	* @param {Field} field Reflected field
	* @param {number} fieldIndex Field index
	* @param {string} prop Property reference
	* @returns {Codegen} Codegen instance
	* @ignore
	*/
	function genValuePartial_fromObject(gen, field, fieldIndex, prop) {
		var defaultAlreadyEmitted = false;
		if (field.resolvedType) if (field.resolvedType instanceof Enum) {
			gen("switch(d%s){", prop);
			for (var values = field.resolvedType.values, keys = Object.keys(values), i = 0; i < keys.length; ++i) {
				if (values[keys[i]] === field.typeDefault && !defaultAlreadyEmitted) {
					gen("default:")("if(typeof(d%s)===\"number\"){m%s=d%s;break}", prop, prop, prop);
					if (!field.repeated) gen("break");
					defaultAlreadyEmitted = true;
				}
				gen("case%j:", keys[i])("case %i:", values[keys[i]])("m%s=%j", prop, values[keys[i]])("break");
			}
			gen("}");
		} else gen("if(typeof d%s!==\"object\")", prop)("throw TypeError(%j)", field.fullName + ": object expected")("m%s=types[%i].fromObject(d%s)", prop, fieldIndex, prop);
		else {
			var isUnsigned = false;
			switch (field.type) {
				case "double":
				case "float":
					gen("m%s=Number(d%s)", prop, prop);
					break;
				case "uint32":
				case "fixed32":
					gen("m%s=d%s>>>0", prop, prop);
					break;
				case "int32":
				case "sint32":
				case "sfixed32":
					gen("m%s=d%s|0", prop, prop);
					break;
				case "uint64": isUnsigned = true;
				case "int64":
				case "sint64":
				case "fixed64":
				case "sfixed64":
					gen("if(util.Long)")("(m%s=util.Long.fromValue(d%s)).unsigned=%j", prop, prop, isUnsigned)("else if(typeof d%s===\"string\")", prop)("m%s=parseInt(d%s,10)", prop, prop)("else if(typeof d%s===\"number\")", prop)("m%s=d%s", prop, prop)("else if(typeof d%s===\"object\")", prop)("m%s=new util.LongBits(d%s.low>>>0,d%s.high>>>0).toNumber(%s)", prop, prop, prop, isUnsigned ? "true" : "");
					break;
				case "bytes":
					gen("if(typeof d%s===\"string\")", prop)("util.base64.decode(d%s,m%s=util.newBuffer(util.base64.length(d%s)),0)", prop, prop, prop)("else if(d%s.length >= 0)", prop)("m%s=d%s", prop, prop);
					break;
				case "string":
					gen("m%s=String(d%s)", prop, prop);
					break;
				case "bool":
					gen("m%s=Boolean(d%s)", prop, prop);
					break;
			}
		}
		return gen;
	}
	/**
	* Generates a plain object to runtime message converter specific to the specified message type.
	* @param {Type} mtype Message type
	* @returns {Codegen} Codegen instance
	*/
	converter.fromObject = function fromObject(mtype) {
		var fields = mtype.fieldsArray;
		var gen = util.codegen(["d"], mtype.name + "$fromObject")("if(d instanceof this.ctor)")("return d");
		if (!fields.length) return gen("return new this.ctor");
		gen("var m=new this.ctor");
		for (var i = 0; i < fields.length; ++i) {
			var field = fields[i].resolve(), prop = util.safeProp(field.name);
			if (field.map) {
				gen("if(d%s){", prop)("if(typeof d%s!==\"object\")", prop)("throw TypeError(%j)", field.fullName + ": object expected")("m%s={}", prop)("for(var ks=Object.keys(d%s),i=0;i<ks.length;++i){", prop);
				genValuePartial_fromObject(gen, field, i, prop + "[ks[i]]")("}")("}");
			} else if (field.repeated) {
				gen("if(d%s){", prop)("if(!Array.isArray(d%s))", prop)("throw TypeError(%j)", field.fullName + ": array expected")("m%s=[]", prop)("for(var i=0;i<d%s.length;++i){", prop);
				genValuePartial_fromObject(gen, field, i, prop + "[i]")("}")("}");
			} else {
				if (!(field.resolvedType instanceof Enum)) gen("if(d%s!=null){", prop);
				genValuePartial_fromObject(gen, field, i, prop);
				if (!(field.resolvedType instanceof Enum)) gen("}");
			}
		}
		return gen("return m");
	};
	/**
	* Generates a partial value toObject converter.
	* @param {Codegen} gen Codegen instance
	* @param {Field} field Reflected field
	* @param {number} fieldIndex Field index
	* @param {string} prop Property reference
	* @returns {Codegen} Codegen instance
	* @ignore
	*/
	function genValuePartial_toObject(gen, field, fieldIndex, prop) {
		if (field.resolvedType) if (field.resolvedType instanceof Enum) gen("d%s=o.enums===String?(types[%i].values[m%s]===undefined?m%s:types[%i].values[m%s]):m%s", prop, fieldIndex, prop, prop, fieldIndex, prop, prop);
		else gen("d%s=types[%i].toObject(m%s,o)", prop, fieldIndex, prop);
		else {
			var isUnsigned = false;
			switch (field.type) {
				case "double":
				case "float":
					gen("d%s=o.json&&!isFinite(m%s)?String(m%s):m%s", prop, prop, prop, prop);
					break;
				case "uint64": isUnsigned = true;
				case "int64":
				case "sint64":
				case "fixed64":
				case "sfixed64":
					gen("if(typeof m%s===\"number\")", prop)("d%s=o.longs===String?String(m%s):m%s", prop, prop, prop)("else")("d%s=o.longs===String?util.Long.prototype.toString.call(m%s):o.longs===Number?new util.LongBits(m%s.low>>>0,m%s.high>>>0).toNumber(%s):m%s", prop, prop, prop, prop, isUnsigned ? "true" : "", prop);
					break;
				case "bytes":
					gen("d%s=o.bytes===String?util.base64.encode(m%s,0,m%s.length):o.bytes===Array?Array.prototype.slice.call(m%s):m%s", prop, prop, prop, prop, prop);
					break;
				default:
					gen("d%s=m%s", prop, prop);
					break;
			}
		}
		return gen;
	}
	/**
	* Generates a runtime message to plain object converter specific to the specified message type.
	* @param {Type} mtype Message type
	* @returns {Codegen} Codegen instance
	*/
	converter.toObject = function toObject(mtype) {
		var fields = mtype.fieldsArray.slice().sort(util.compareFieldsById);
		if (!fields.length) return util.codegen()("return {}");
		var gen = util.codegen(["m", "o"], mtype.name + "$toObject")("if(!o)")("o={}")("var d={}");
		var repeatedFields = [], mapFields = [], normalFields = [], i = 0;
		for (; i < fields.length; ++i) if (!fields[i].partOf) (fields[i].resolve().repeated ? repeatedFields : fields[i].map ? mapFields : normalFields).push(fields[i]);
		if (repeatedFields.length) {
			gen("if(o.arrays||o.defaults){");
			for (i = 0; i < repeatedFields.length; ++i) gen("d%s=[]", util.safeProp(repeatedFields[i].name));
			gen("}");
		}
		if (mapFields.length) {
			gen("if(o.objects||o.defaults){");
			for (i = 0; i < mapFields.length; ++i) gen("d%s={}", util.safeProp(mapFields[i].name));
			gen("}");
		}
		if (normalFields.length) {
			gen("if(o.defaults){");
			for (i = 0; i < normalFields.length; ++i) {
				var field = normalFields[i], prop = util.safeProp(field.name);
				if (field.resolvedType instanceof Enum) gen("d%s=o.enums===String?%j:%j", prop, field.resolvedType.valuesById[field.typeDefault], field.typeDefault);
				else if (field.long) gen("if(util.Long){")("var n=new util.Long(%i,%i,%j)", field.typeDefault.low, field.typeDefault.high, field.typeDefault.unsigned)("d%s=o.longs===String?n.toString():o.longs===Number?n.toNumber():n", prop)("}else")("d%s=o.longs===String?%j:%i", prop, field.typeDefault.toString(), field.typeDefault.toNumber());
				else if (field.bytes) {
					var arrayDefault = "[" + Array.prototype.slice.call(field.typeDefault).join(",") + "]";
					gen("if(o.bytes===String)d%s=%j", prop, String.fromCharCode.apply(String, field.typeDefault))("else{")("d%s=%s", prop, arrayDefault)("if(o.bytes!==Array)d%s=util.newBuffer(d%s)", prop, prop)("}");
				} else gen("d%s=%j", prop, field.typeDefault);
			}
			gen("}");
		}
		var hasKs2 = false;
		for (i = 0; i < fields.length; ++i) {
			var field = fields[i], index = mtype._fieldsArray.indexOf(field), prop = util.safeProp(field.name);
			if (field.map) {
				if (!hasKs2) {
					hasKs2 = true;
					gen("var ks2");
				}
				gen("if(m%s&&(ks2=Object.keys(m%s)).length){", prop, prop)("d%s={}", prop)("for(var j=0;j<ks2.length;++j){");
				genValuePartial_toObject(gen, field, index, prop + "[ks2[j]]")("}");
			} else if (field.repeated) {
				gen("if(m%s&&m%s.length){", prop, prop)("d%s=[]", prop)("for(var j=0;j<m%s.length;++j){", prop);
				genValuePartial_toObject(gen, field, index, prop + "[j]")("}");
			} else {
				gen("if(m%s!=null&&m.hasOwnProperty(%j)){", prop, field.name);
				genValuePartial_toObject(gen, field, index, prop);
				if (field.partOf) gen("if(o.oneofs)")("d%s=%j", util.safeProp(field.partOf.name), field.name);
			}
			gen("}");
		}
		return gen("return d");
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/wrappers.js
var require_wrappers = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Wrappers for common types.
	* @type {Object.<string,IWrapper>}
	* @const
	*/
	var wrappers = exports;
	var Message = require_message();
	/**
	* From object converter part of an {@link IWrapper}.
	* @typedef WrapperFromObjectConverter
	* @type {function}
	* @param {Object.<string,*>} object Plain object
	* @returns {Message<{}>} Message instance
	* @this Type
	*/
	/**
	* To object converter part of an {@link IWrapper}.
	* @typedef WrapperToObjectConverter
	* @type {function}
	* @param {Message<{}>} message Message instance
	* @param {IConversionOptions} [options] Conversion options
	* @returns {Object.<string,*>} Plain object
	* @this Type
	*/
	/**
	* Common type wrapper part of {@link wrappers}.
	* @interface IWrapper
	* @property {WrapperFromObjectConverter} [fromObject] From object converter
	* @property {WrapperToObjectConverter} [toObject] To object converter
	*/
	wrappers[".google.protobuf.Any"] = {
		fromObject: function(object) {
			if (object && object["@type"]) {
				var name = object["@type"].substring(object["@type"].lastIndexOf("/") + 1);
				var type = this.lookup(name);
				/* istanbul ignore else */
				if (type) {
					var type_url = object["@type"].charAt(0) === "." ? object["@type"].slice(1) : object["@type"];
					if (type_url.indexOf("/") === -1) type_url = "/" + type_url;
					return this.create({
						type_url,
						value: type.encode(type.fromObject(object)).finish()
					});
				}
			}
			return this.fromObject(object);
		},
		toObject: function(message, options) {
			var googleApi = "type.googleapis.com/";
			var prefix = "";
			var name = "";
			if (options && options.json && message.type_url && message.value) {
				name = message.type_url.substring(message.type_url.lastIndexOf("/") + 1);
				prefix = message.type_url.substring(0, message.type_url.lastIndexOf("/") + 1);
				var type = this.lookup(name);
				/* istanbul ignore else */
				if (type) message = type.decode(message.value);
			}
			if (!(message instanceof this.ctor) && message instanceof Message) {
				var object = message.$type.toObject(message, options);
				var messageName = message.$type.fullName[0] === "." ? message.$type.fullName.slice(1) : message.$type.fullName;
				if (prefix === "") prefix = googleApi;
				name = prefix + messageName;
				object["@type"] = name;
				return object;
			}
			return this.toObject(message, options);
		}
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/type.js
var require_type$1 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Type;
	var Namespace = require_namespace();
	((Type.prototype = Object.create(Namespace.prototype)).constructor = Type).className = "Type";
	var Enum = require_enum(), OneOf = require_oneof(), Field = require_field(), MapField = require_mapfield(), Service = require_service(), Message = require_message(), Reader = require_reader(), Writer = require_writer(), util = require_util$1(), encoder = require_encoder(), decoder = require_decoder(), verifier = require_verifier(), converter = require_converter(), wrappers = require_wrappers();
	/**
	* Constructs a new reflected message type instance.
	* @classdesc Reflected message type.
	* @extends NamespaceBase
	* @constructor
	* @param {string} name Message name
	* @param {Object.<string,*>} [options] Declared options
	*/
	function Type(name, options) {
		Namespace.call(this, name, options);
		/**
		* Message fields.
		* @type {Object.<string,Field>}
		*/
		this.fields = {};
		/**
		* Oneofs declared within this namespace, if any.
		* @type {Object.<string,OneOf>}
		*/
		this.oneofs = void 0;
		/**
		* Extension ranges, if any.
		* @type {number[][]}
		*/
		this.extensions = void 0;
		/**
		* Reserved ranges, if any.
		* @type {Array.<number[]|string>}
		*/
		this.reserved = void 0;
		this.group = void 0;
		/**
		* Cached fields by id.
		* @type {Object.<number,Field>|null}
		* @private
		*/
		this._fieldsById = null;
		/**
		* Cached fields as an array.
		* @type {Field[]|null}
		* @private
		*/
		this._fieldsArray = null;
		/**
		* Cached oneofs as an array.
		* @type {OneOf[]|null}
		* @private
		*/
		this._oneofsArray = null;
		/**
		* Cached constructor.
		* @type {Constructor<{}>}
		* @private
		*/
		this._ctor = null;
	}
	Object.defineProperties(Type.prototype, {
		fieldsById: { get: function() {
			/* istanbul ignore if */
			if (this._fieldsById) return this._fieldsById;
			this._fieldsById = {};
			for (var names = Object.keys(this.fields), i = 0; i < names.length; ++i) {
				var field = this.fields[names[i]], id = field.id;
				/* istanbul ignore if */
				if (this._fieldsById[id]) throw Error("duplicate id " + id + " in " + this);
				this._fieldsById[id] = field;
			}
			return this._fieldsById;
		} },
		fieldsArray: { get: function() {
			return this._fieldsArray || (this._fieldsArray = util.toArray(this.fields));
		} },
		oneofsArray: { get: function() {
			return this._oneofsArray || (this._oneofsArray = util.toArray(this.oneofs));
		} },
		ctor: {
			get: function() {
				return this._ctor || (this.ctor = Type.generateConstructor(this)());
			},
			set: function(ctor) {
				var prototype = ctor.prototype;
				if (!(prototype instanceof Message)) {
					(ctor.prototype = new Message()).constructor = ctor;
					util.merge(ctor.prototype, prototype);
				}
				ctor.$type = ctor.prototype.$type = this;
				util.merge(ctor, Message, true);
				this._ctor = ctor;
				var i = 0;
				for (; i < this.fieldsArray.length; ++i) this._fieldsArray[i].resolve();
				var ctorProperties = {};
				for (i = 0; i < this.oneofsArray.length; ++i) ctorProperties[this._oneofsArray[i].resolve().name] = {
					get: util.oneOfGetter(this._oneofsArray[i].oneof),
					set: util.oneOfSetter(this._oneofsArray[i].oneof)
				};
				if (i) Object.defineProperties(ctor.prototype, ctorProperties);
			}
		}
	});
	/**
	* Generates a constructor function for the specified type.
	* @param {Type} mtype Message type
	* @returns {Codegen} Codegen instance
	*/
	Type.generateConstructor = function generateConstructor(mtype) {
		var gen = util.codegen(["p"], mtype.name);
		for (var i = 0, field; i < mtype.fieldsArray.length; ++i) if ((field = mtype._fieldsArray[i]).map) gen("this%s={}", util.safeProp(field.name));
		else if (field.repeated) gen("this%s=[]", util.safeProp(field.name));
		return gen("if(p)for(var ks=Object.keys(p),i=0;i<ks.length;++i)if(p[ks[i]]!=null)")("this[ks[i]]=p[ks[i]]");
	};
	function clearCache(type) {
		type._fieldsById = type._fieldsArray = type._oneofsArray = null;
		delete type.encode;
		delete type.decode;
		delete type.verify;
		return type;
	}
	/**
	* Message type descriptor.
	* @interface IType
	* @extends INamespace
	* @property {Object.<string,IOneOf>} [oneofs] Oneof descriptors
	* @property {Object.<string,IField>} fields Field descriptors
	* @property {number[][]} [extensions] Extension ranges
	* @property {Array.<number[]|string>} [reserved] Reserved ranges
	* @property {boolean} [group=false] Whether a legacy group or not
	*/
	/**
	* Creates a message type from a message type descriptor.
	* @param {string} name Message name
	* @param {IType} json Message type descriptor
	* @returns {Type} Created message type
	*/
	Type.fromJSON = function fromJSON(name, json) {
		var type = new Type(name, json.options);
		type.extensions = json.extensions;
		type.reserved = json.reserved;
		var names = Object.keys(json.fields), i = 0;
		for (; i < names.length; ++i) type.add((typeof json.fields[names[i]].keyType !== "undefined" ? MapField.fromJSON : Field.fromJSON)(names[i], json.fields[names[i]]));
		if (json.oneofs) for (names = Object.keys(json.oneofs), i = 0; i < names.length; ++i) type.add(OneOf.fromJSON(names[i], json.oneofs[names[i]]));
		if (json.nested) for (names = Object.keys(json.nested), i = 0; i < names.length; ++i) {
			var nested = json.nested[names[i]];
			type.add((nested.id !== void 0 ? Field.fromJSON : nested.fields !== void 0 ? Type.fromJSON : nested.values !== void 0 ? Enum.fromJSON : nested.methods !== void 0 ? Service.fromJSON : Namespace.fromJSON)(names[i], nested));
		}
		if (json.extensions && json.extensions.length) type.extensions = json.extensions;
		if (json.reserved && json.reserved.length) type.reserved = json.reserved;
		if (json.group) type.group = true;
		if (json.comment) type.comment = json.comment;
		if (json.edition) type._edition = json.edition;
		type._defaultEdition = "proto3";
		return type;
	};
	/**
	* Converts this message type to a message type descriptor.
	* @param {IToJSONOptions} [toJSONOptions] JSON conversion options
	* @returns {IType} Message type descriptor
	*/
	Type.prototype.toJSON = function toJSON(toJSONOptions) {
		var inherited = Namespace.prototype.toJSON.call(this, toJSONOptions);
		var keepComments = toJSONOptions ? Boolean(toJSONOptions.keepComments) : false;
		return util.toObject([
			"edition",
			this._editionToJSON(),
			"options",
			inherited && inherited.options || void 0,
			"oneofs",
			Namespace.arrayToJSON(this.oneofsArray, toJSONOptions),
			"fields",
			Namespace.arrayToJSON(this.fieldsArray.filter(function(obj) {
				return !obj.declaringField;
			}), toJSONOptions) || {},
			"extensions",
			this.extensions && this.extensions.length ? this.extensions : void 0,
			"reserved",
			this.reserved && this.reserved.length ? this.reserved : void 0,
			"group",
			this.group || void 0,
			"nested",
			inherited && inherited.nested || void 0,
			"comment",
			keepComments ? this.comment : void 0
		]);
	};
	/**
	* @override
	*/
	Type.prototype.resolveAll = function resolveAll() {
		if (!this._needsRecursiveResolve) return this;
		Namespace.prototype.resolveAll.call(this);
		var oneofs = this.oneofsArray;
		i = 0;
		while (i < oneofs.length) oneofs[i++].resolve();
		var fields = this.fieldsArray, i = 0;
		while (i < fields.length) fields[i++].resolve();
		return this;
	};
	/**
	* @override
	*/
	Type.prototype._resolveFeaturesRecursive = function _resolveFeaturesRecursive(edition) {
		if (!this._needsRecursiveFeatureResolution) return this;
		edition = this._edition || edition;
		Namespace.prototype._resolveFeaturesRecursive.call(this, edition);
		this.oneofsArray.forEach((oneof) => {
			oneof._resolveFeatures(edition);
		});
		this.fieldsArray.forEach((field) => {
			field._resolveFeatures(edition);
		});
		return this;
	};
	/**
	* @override
	*/
	Type.prototype.get = function get(name) {
		return this.fields[name] || this.oneofs && this.oneofs[name] || this.nested && this.nested[name] || null;
	};
	/**
	* Adds a nested object to this type.
	* @param {ReflectionObject} object Nested object to add
	* @returns {Type} `this`
	* @throws {TypeError} If arguments are invalid
	* @throws {Error} If there is already a nested object with this name or, if a field, when there is already a field with this id
	*/
	Type.prototype.add = function add(object) {
		if (this.get(object.name)) throw Error("duplicate name '" + object.name + "' in " + this);
		if (object instanceof Field && object.extend === void 0) {
			if (this._fieldsById ? this._fieldsById[object.id] : this.fieldsById[object.id]) throw Error("duplicate id " + object.id + " in " + this);
			if (this.isReservedId(object.id)) throw Error("id " + object.id + " is reserved in " + this);
			if (this.isReservedName(object.name)) throw Error("name '" + object.name + "' is reserved in " + this);
			if (object.parent) object.parent.remove(object);
			this.fields[object.name] = object;
			object.message = this;
			object.onAdd(this);
			return clearCache(this);
		}
		if (object instanceof OneOf) {
			if (!this.oneofs) this.oneofs = {};
			this.oneofs[object.name] = object;
			object.onAdd(this);
			return clearCache(this);
		}
		return Namespace.prototype.add.call(this, object);
	};
	/**
	* Removes a nested object from this type.
	* @param {ReflectionObject} object Nested object to remove
	* @returns {Type} `this`
	* @throws {TypeError} If arguments are invalid
	* @throws {Error} If `object` is not a member of this type
	*/
	Type.prototype.remove = function remove(object) {
		if (object instanceof Field && object.extend === void 0) {
			/* istanbul ignore if */
			if (!this.fields || this.fields[object.name] !== object) throw Error(object + " is not a member of " + this);
			delete this.fields[object.name];
			object.parent = null;
			object.onRemove(this);
			return clearCache(this);
		}
		if (object instanceof OneOf) {
			/* istanbul ignore if */
			if (!this.oneofs || this.oneofs[object.name] !== object) throw Error(object + " is not a member of " + this);
			delete this.oneofs[object.name];
			object.parent = null;
			object.onRemove(this);
			return clearCache(this);
		}
		return Namespace.prototype.remove.call(this, object);
	};
	/**
	* Tests if the specified id is reserved.
	* @param {number} id Id to test
	* @returns {boolean} `true` if reserved, otherwise `false`
	*/
	Type.prototype.isReservedId = function isReservedId(id) {
		return Namespace.isReservedId(this.reserved, id);
	};
	/**
	* Tests if the specified name is reserved.
	* @param {string} name Name to test
	* @returns {boolean} `true` if reserved, otherwise `false`
	*/
	Type.prototype.isReservedName = function isReservedName(name) {
		return Namespace.isReservedName(this.reserved, name);
	};
	/**
	* Creates a new message of this type using the specified properties.
	* @param {Object.<string,*>} [properties] Properties to set
	* @returns {Message<{}>} Message instance
	*/
	Type.prototype.create = function create(properties) {
		return new this.ctor(properties);
	};
	/**
	* Sets up {@link Type#encode|encode}, {@link Type#decode|decode} and {@link Type#verify|verify}.
	* @returns {Type} `this`
	*/
	Type.prototype.setup = function setup() {
		var fullName = this.fullName, types = [];
		for (var i = 0; i < this.fieldsArray.length; ++i) types.push(this._fieldsArray[i].resolve().resolvedType);
		this.encode = encoder(this)({
			Writer,
			types,
			util
		});
		this.decode = decoder(this)({
			Reader,
			types,
			util
		});
		this.verify = verifier(this)({
			types,
			util
		});
		this.fromObject = converter.fromObject(this)({
			types,
			util
		});
		this.toObject = converter.toObject(this)({
			types,
			util
		});
		var wrapper = wrappers[fullName];
		if (wrapper) {
			var originalThis = Object.create(this);
			originalThis.fromObject = this.fromObject;
			this.fromObject = wrapper.fromObject.bind(originalThis);
			originalThis.toObject = this.toObject;
			this.toObject = wrapper.toObject.bind(originalThis);
		}
		return this;
	};
	/**
	* Encodes a message of this type. Does not implicitly {@link Type#verify|verify} messages.
	* @param {Message<{}>|Object.<string,*>} message Message instance or plain object
	* @param {Writer} [writer] Writer to encode to
	* @returns {Writer} writer
	*/
	Type.prototype.encode = function encode_setup(message, writer) {
		return this.setup().encode(message, writer);
	};
	/**
	* Encodes a message of this type preceeded by its byte length as a varint. Does not implicitly {@link Type#verify|verify} messages.
	* @param {Message<{}>|Object.<string,*>} message Message instance or plain object
	* @param {Writer} [writer] Writer to encode to
	* @returns {Writer} writer
	*/
	Type.prototype.encodeDelimited = function encodeDelimited(message, writer) {
		return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
	};
	/**
	* Decodes a message of this type.
	* @param {Reader|Uint8Array} reader Reader or buffer to decode from
	* @param {number} [length] Length of the message, if known beforehand
	* @returns {Message<{}>} Decoded message
	* @throws {Error} If the payload is not a reader or valid buffer
	* @throws {util.ProtocolError<{}>} If required fields are missing
	*/
	Type.prototype.decode = function decode_setup(reader, length) {
		return this.setup().decode(reader, length);
	};
	/**
	* Decodes a message of this type preceeded by its byte length as a varint.
	* @param {Reader|Uint8Array} reader Reader or buffer to decode from
	* @returns {Message<{}>} Decoded message
	* @throws {Error} If the payload is not a reader or valid buffer
	* @throws {util.ProtocolError} If required fields are missing
	*/
	Type.prototype.decodeDelimited = function decodeDelimited(reader) {
		if (!(reader instanceof Reader)) reader = Reader.create(reader);
		return this.decode(reader, reader.uint32());
	};
	/**
	* Verifies that field values are valid and that required fields are present.
	* @param {Object.<string,*>} message Plain object to verify
	* @returns {null|string} `null` if valid, otherwise the reason why it is not
	*/
	Type.prototype.verify = function verify_setup(message) {
		return this.setup().verify(message);
	};
	/**
	* Creates a new message of this type from a plain object. Also converts values to their respective internal types.
	* @param {Object.<string,*>} object Plain object to convert
	* @returns {Message<{}>} Message instance
	*/
	Type.prototype.fromObject = function fromObject(object) {
		return this.setup().fromObject(object);
	};
	/**
	* Conversion options as used by {@link Type#toObject} and {@link Message.toObject}.
	* @interface IConversionOptions
	* @property {Function} [longs] Long conversion type.
	* Valid values are `String` and `Number` (the global types).
	* Defaults to copy the present value, which is a possibly unsafe number without and a {@link Long} with a long library.
	* @property {Function} [enums] Enum value conversion type.
	* Only valid value is `String` (the global type).
	* Defaults to copy the present value, which is the numeric id.
	* @property {Function} [bytes] Bytes value conversion type.
	* Valid values are `Array` and (a base64 encoded) `String` (the global types).
	* Defaults to copy the present value, which usually is a Buffer under node and an Uint8Array in the browser.
	* @property {boolean} [defaults=false] Also sets default values on the resulting object
	* @property {boolean} [arrays=false] Sets empty arrays for missing repeated fields even if `defaults=false`
	* @property {boolean} [objects=false] Sets empty objects for missing map fields even if `defaults=false`
	* @property {boolean} [oneofs=false] Includes virtual oneof properties set to the present field's name, if any
	* @property {boolean} [json=false] Performs additional JSON compatibility conversions, i.e. NaN and Infinity to strings
	*/
	/**
	* Creates a plain object from a message of this type. Also converts values to other types if specified.
	* @param {Message<{}>} message Message instance
	* @param {IConversionOptions} [options] Conversion options
	* @returns {Object.<string,*>} Plain object
	*/
	Type.prototype.toObject = function toObject(message, options) {
		return this.setup().toObject(message, options);
	};
	/**
	* Decorator function as returned by {@link Type.d} (TypeScript).
	* @typedef TypeDecorator
	* @type {function}
	* @param {Constructor<T>} target Target constructor
	* @returns {undefined}
	* @template T extends Message<T>
	*/
	/**
	* Type decorator (TypeScript).
	* @param {string} [typeName] Type name, defaults to the constructor's name
	* @returns {TypeDecorator<T>} Decorator function
	* @template T extends Message<T>
	*/
	Type.d = function decorateType(typeName) {
		return function typeDecorator(target) {
			util.decorateType(target, typeName);
		};
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/root.js
var require_root = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Root;
	var Namespace = require_namespace();
	((Root.prototype = Object.create(Namespace.prototype)).constructor = Root).className = "Root";
	var Field = require_field(), Enum = require_enum(), OneOf = require_oneof(), util = require_util$1();
	var Type, parse, common;
	/**
	* Constructs a new root namespace instance.
	* @classdesc Root namespace wrapping all types, enums, services, sub-namespaces etc. that belong together.
	* @extends NamespaceBase
	* @constructor
	* @param {Object.<string,*>} [options] Top level options
	*/
	function Root(options) {
		Namespace.call(this, "", options);
		/**
		* Deferred extension fields.
		* @type {Field[]}
		*/
		this.deferred = [];
		/**
		* Resolved file names of loaded files.
		* @type {string[]}
		*/
		this.files = [];
		/**
		* Edition, defaults to proto2 if unspecified.
		* @type {string}
		* @private
		*/
		this._edition = "proto2";
		/**
		* Global lookup cache of fully qualified names.
		* @type {Object.<string,ReflectionObject>}
		* @private
		*/
		this._fullyQualifiedObjects = {};
	}
	/**
	* Loads a namespace descriptor into a root namespace.
	* @param {INamespace} json Namespace descriptor
	* @param {Root} [root] Root namespace, defaults to create a new one if omitted
	* @returns {Root} Root namespace
	*/
	Root.fromJSON = function fromJSON(json, root) {
		if (!root) root = new Root();
		if (json.options) root.setOptions(json.options);
		return root.addJSON(json.nested).resolveAll();
	};
	/**
	* Resolves the path of an imported file, relative to the importing origin.
	* This method exists so you can override it with your own logic in case your imports are scattered over multiple directories.
	* @function
	* @param {string} origin The file name of the importing file
	* @param {string} target The file name being imported
	* @returns {string|null} Resolved path to `target` or `null` to skip the file
	*/
	Root.prototype.resolvePath = util.path.resolve;
	/**
	* Fetch content from file path or url
	* This method exists so you can override it with your own logic.
	* @function
	* @param {string} path File path or url
	* @param {FetchCallback} callback Callback function
	* @returns {undefined}
	*/
	Root.prototype.fetch = util.fetch;
	/* istanbul ignore next */
	function SYNC() {}
	/**
	* Loads one or multiple .proto or preprocessed .json files into this root namespace and calls the callback.
	* @param {string|string[]} filename Names of one or multiple files to load
	* @param {IParseOptions} options Parse options
	* @param {LoadCallback} callback Callback function
	* @returns {undefined}
	*/
	Root.prototype.load = function load(filename, options, callback) {
		if (typeof options === "function") {
			callback = options;
			options = void 0;
		}
		var self = this;
		if (!callback) return util.asPromise(load, self, filename, options);
		var sync = callback === SYNC;
		function finish(err, root) {
			/* istanbul ignore if */
			if (!callback) return;
			if (sync) throw err;
			if (root) root.resolveAll();
			var cb = callback;
			callback = null;
			cb(err, root);
		}
		function getBundledFileName(filename) {
			var idx = filename.lastIndexOf("google/protobuf/");
			if (idx > -1) {
				var altname = filename.substring(idx);
				if (altname in common) return altname;
			}
			return null;
		}
		function process(filename, source) {
			try {
				if (util.isString(source) && source.charAt(0) === "{") source = JSON.parse(source);
				if (!util.isString(source)) self.setOptions(source.options).addJSON(source.nested);
				else {
					parse.filename = filename;
					var parsed = parse(source, self, options), resolved, i = 0;
					if (parsed.imports) {
						for (; i < parsed.imports.length; ++i) if (resolved = getBundledFileName(parsed.imports[i]) || self.resolvePath(filename, parsed.imports[i])) fetch(resolved);
					}
					if (parsed.weakImports) {
						for (i = 0; i < parsed.weakImports.length; ++i) if (resolved = getBundledFileName(parsed.weakImports[i]) || self.resolvePath(filename, parsed.weakImports[i])) fetch(resolved, true);
					}
				}
			} catch (err) {
				finish(err);
			}
			if (!sync && !queued) finish(null, self);
		}
		function fetch(filename, weak) {
			filename = getBundledFileName(filename) || filename;
			if (self.files.indexOf(filename) > -1) return;
			self.files.push(filename);
			if (filename in common) {
				if (sync) process(filename, common[filename]);
				else {
					++queued;
					setTimeout(function() {
						--queued;
						process(filename, common[filename]);
					});
				}
				return;
			}
			if (sync) {
				var source;
				try {
					source = util.fs.readFileSync(filename).toString("utf8");
				} catch (err) {
					if (!weak) finish(err);
					return;
				}
				process(filename, source);
			} else {
				++queued;
				self.fetch(filename, function(err, source) {
					--queued;
					/* istanbul ignore if */
					if (!callback) return;
					if (err) {
						/* istanbul ignore else */
						if (!weak) finish(err);
						else if (!queued) finish(null, self);
						return;
					}
					process(filename, source);
				});
			}
		}
		var queued = 0;
		if (util.isString(filename)) filename = [filename];
		for (var i = 0, resolved; i < filename.length; ++i) if (resolved = self.resolvePath("", filename[i])) fetch(resolved);
		if (sync) {
			self.resolveAll();
			return self;
		}
		if (!queued) finish(null, self);
		return self;
	};
	/**
	* Loads one or multiple .proto or preprocessed .json files into this root namespace and calls the callback.
	* @function Root#load
	* @param {string|string[]} filename Names of one or multiple files to load
	* @param {LoadCallback} callback Callback function
	* @returns {undefined}
	* @variation 2
	*/
	/**
	* Loads one or multiple .proto or preprocessed .json files into this root namespace and returns a promise.
	* @function Root#load
	* @param {string|string[]} filename Names of one or multiple files to load
	* @param {IParseOptions} [options] Parse options. Defaults to {@link parse.defaults} when omitted.
	* @returns {Promise<Root>} Promise
	* @variation 3
	*/
	/**
	* Synchronously loads one or multiple .proto or preprocessed .json files into this root namespace (node only).
	* @function Root#loadSync
	* @param {string|string[]} filename Names of one or multiple files to load
	* @param {IParseOptions} [options] Parse options. Defaults to {@link parse.defaults} when omitted.
	* @returns {Root} Root namespace
	* @throws {Error} If synchronous fetching is not supported (i.e. in browsers) or if a file's syntax is invalid
	*/
	Root.prototype.loadSync = function loadSync(filename, options) {
		if (!util.isNode) throw Error("not supported");
		return this.load(filename, options, SYNC);
	};
	/**
	* @override
	*/
	Root.prototype.resolveAll = function resolveAll() {
		if (!this._needsRecursiveResolve) return this;
		if (this.deferred.length) throw Error("unresolvable extensions: " + this.deferred.map(function(field) {
			return "'extend " + field.extend + "' in " + field.parent.fullName;
		}).join(", "));
		return Namespace.prototype.resolveAll.call(this);
	};
	var exposeRe = /^[A-Z]/;
	/**
	* Handles a deferred declaring extension field by creating a sister field to represent it within its extended type.
	* @param {Root} root Root instance
	* @param {Field} field Declaring extension field witin the declaring type
	* @returns {boolean} `true` if successfully added to the extended type, `false` otherwise
	* @inner
	* @ignore
	*/
	function tryHandleExtension(root, field) {
		var extendedType = field.parent.lookup(field.extend);
		if (extendedType) {
			var sisterField = new Field(field.fullName, field.id, field.type, field.rule, void 0, field.options);
			if (extendedType.get(sisterField.name)) return true;
			sisterField.declaringField = field;
			field.extensionField = sisterField;
			extendedType.add(sisterField);
			return true;
		}
		return false;
	}
	/**
	* Called when any object is added to this root or its sub-namespaces.
	* @param {ReflectionObject} object Object added
	* @returns {undefined}
	* @private
	*/
	Root.prototype._handleAdd = function _handleAdd(object) {
		if (object instanceof Field) {
			if (object.extend !== void 0 && !object.extensionField) {
				if (!tryHandleExtension(this, object)) this.deferred.push(object);
			}
		} else if (object instanceof Enum) {
			if (exposeRe.test(object.name)) object.parent[object.name] = object.values;
		} else if (!(object instanceof OneOf)) {
			if (object instanceof Type) for (var i = 0; i < this.deferred.length;) if (tryHandleExtension(this, this.deferred[i])) this.deferred.splice(i, 1);
			else ++i;
			for (var j = 0; j < object.nestedArray.length; ++j) this._handleAdd(object._nestedArray[j]);
			if (exposeRe.test(object.name)) object.parent[object.name] = object;
		}
		if (object instanceof Type || object instanceof Enum || object instanceof Field) this._fullyQualifiedObjects[object.fullName] = object;
	};
	/**
	* Called when any object is removed from this root or its sub-namespaces.
	* @param {ReflectionObject} object Object removed
	* @returns {undefined}
	* @private
	*/
	Root.prototype._handleRemove = function _handleRemove(object) {
		if (object instanceof Field) {
			if (object.extend !== void 0) if (object.extensionField) {
				object.extensionField.parent.remove(object.extensionField);
				object.extensionField = null;
			} else {
				var index = this.deferred.indexOf(object);
				/* istanbul ignore else */
				if (index > -1) this.deferred.splice(index, 1);
			}
		} else if (object instanceof Enum) {
			if (exposeRe.test(object.name)) delete object.parent[object.name];
		} else if (object instanceof Namespace) {
			for (var i = 0; i < object.nestedArray.length; ++i) this._handleRemove(object._nestedArray[i]);
			if (exposeRe.test(object.name)) delete object.parent[object.name];
		}
		delete this._fullyQualifiedObjects[object.fullName];
	};
	Root._configure = function(Type_, parse_, common_) {
		Type = Type_;
		parse = parse_;
		common = common_;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/util.js
var require_util$1 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* Various utility functions.
	* @namespace
	*/
	var util = module.exports = require_minimal();
	var roots = require_roots();
	var Type, Enum;
	util.codegen = require_codegen();
	util.fetch = require_fetch();
	util.path = require_path();
	/**
	* Node's fs module if available.
	* @type {Object.<string,*>}
	*/
	util.fs = util.inquire("fs");
	/**
	* Converts an object's values to an array.
	* @param {Object.<string,*>} object Object to convert
	* @returns {Array.<*>} Converted array
	*/
	util.toArray = function toArray(object) {
		if (object) {
			var keys = Object.keys(object), array = new Array(keys.length), index = 0;
			while (index < keys.length) array[index] = object[keys[index++]];
			return array;
		}
		return [];
	};
	/**
	* Converts an array of keys immediately followed by their respective value to an object, omitting undefined values.
	* @param {Array.<*>} array Array to convert
	* @returns {Object.<string,*>} Converted object
	*/
	util.toObject = function toObject(array) {
		var object = {}, index = 0;
		while (index < array.length) {
			var key = array[index++], val = array[index++];
			if (val !== void 0) object[key] = val;
		}
		return object;
	};
	var safePropBackslashRe = /\\/g, safePropQuoteRe = /"/g;
	/**
	* Tests whether the specified name is a reserved word in JS.
	* @param {string} name Name to test
	* @returns {boolean} `true` if reserved, otherwise `false`
	*/
	util.isReserved = function isReserved(name) {
		return /^(?:do|if|in|for|let|new|try|var|case|else|enum|eval|false|null|this|true|void|with|break|catch|class|const|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof)$/.test(name);
	};
	/**
	* Returns a safe property accessor for the specified property name.
	* @param {string} prop Property name
	* @returns {string} Safe accessor
	*/
	util.safeProp = function safeProp(prop) {
		if (!/^[$\w_]+$/.test(prop) || util.isReserved(prop)) return "[\"" + prop.replace(safePropBackslashRe, "\\\\").replace(safePropQuoteRe, "\\\"") + "\"]";
		return "." + prop;
	};
	/**
	* Converts the first character of a string to upper case.
	* @param {string} str String to convert
	* @returns {string} Converted string
	*/
	util.ucFirst = function ucFirst(str) {
		return str.charAt(0).toUpperCase() + str.substring(1);
	};
	var camelCaseRe = /_([a-z])/g;
	/**
	* Converts a string to camel case.
	* @param {string} str String to convert
	* @returns {string} Converted string
	*/
	util.camelCase = function camelCase(str) {
		return str.substring(0, 1) + str.substring(1).replace(camelCaseRe, function($0, $1) {
			return $1.toUpperCase();
		});
	};
	/**
	* Compares reflected fields by id.
	* @param {Field} a First field
	* @param {Field} b Second field
	* @returns {number} Comparison value
	*/
	util.compareFieldsById = function compareFieldsById(a, b) {
		return a.id - b.id;
	};
	/**
	* Decorator helper for types (TypeScript).
	* @param {Constructor<T>} ctor Constructor function
	* @param {string} [typeName] Type name, defaults to the constructor's name
	* @returns {Type} Reflected type
	* @template T extends Message<T>
	* @property {Root} root Decorators root
	*/
	util.decorateType = function decorateType(ctor, typeName) {
		/* istanbul ignore if */
		if (ctor.$type) {
			if (typeName && ctor.$type.name !== typeName) {
				util.decorateRoot.remove(ctor.$type);
				ctor.$type.name = typeName;
				util.decorateRoot.add(ctor.$type);
			}
			return ctor.$type;
		}
		/* istanbul ignore next */
		if (!Type) Type = require_type$1();
		var type = new Type(typeName || ctor.name);
		util.decorateRoot.add(type);
		type.ctor = ctor;
		Object.defineProperty(ctor, "$type", {
			value: type,
			enumerable: false
		});
		Object.defineProperty(ctor.prototype, "$type", {
			value: type,
			enumerable: false
		});
		return type;
	};
	var decorateEnumIndex = 0;
	/**
	* Decorator helper for enums (TypeScript).
	* @param {Object} object Enum object
	* @returns {Enum} Reflected enum
	*/
	util.decorateEnum = function decorateEnum(object) {
		/* istanbul ignore if */
		if (object.$type) return object.$type;
		/* istanbul ignore next */
		if (!Enum) Enum = require_enum();
		var enm = new Enum("Enum" + decorateEnumIndex++, object);
		util.decorateRoot.add(enm);
		Object.defineProperty(object, "$type", {
			value: enm,
			enumerable: false
		});
		return enm;
	};
	/**
	* Sets the value of a property by property path. If a value already exists, it is turned to an array
	* @param {Object.<string,*>} dst Destination object
	* @param {string} path dot '.' delimited path of the property to set
	* @param {Object} value the value to set
	* @param {boolean|undefined} [ifNotSet] Sets the option only if it isn't currently set
	* @returns {Object.<string,*>} Destination object
	*/
	util.setProperty = function setProperty(dst, path, value, ifNotSet) {
		function setProp(dst, path, value) {
			var part = path.shift();
			if (part === "__proto__" || part === "prototype") return dst;
			if (path.length > 0) dst[part] = setProp(dst[part] || {}, path, value);
			else {
				var prevValue = dst[part];
				if (prevValue && ifNotSet) return dst;
				if (prevValue) value = [].concat(prevValue).concat(value);
				dst[part] = value;
			}
			return dst;
		}
		if (typeof dst !== "object") throw TypeError("dst must be an object");
		if (!path) throw TypeError("path must be specified");
		path = path.split(".");
		return setProp(dst, path, value);
	};
	/**
	* Decorator root (TypeScript).
	* @name util.decorateRoot
	* @type {Root}
	* @readonly
	*/
	Object.defineProperty(util, "decorateRoot", { get: function() {
		return roots["decorated"] || (roots["decorated"] = new (require_root())());
	} });
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/types.js
var require_types = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Common type constants.
	* @namespace
	*/
	var types = exports;
	var util = require_util$1();
	var s = [
		"double",
		"float",
		"int32",
		"uint32",
		"sint32",
		"fixed32",
		"sfixed32",
		"int64",
		"uint64",
		"sint64",
		"fixed64",
		"sfixed64",
		"bool",
		"string",
		"bytes"
	];
	function bake(values, offset) {
		var i = 0, o = {};
		offset |= 0;
		while (i < values.length) o[s[i + offset]] = values[i++];
		return o;
	}
	/**
	* Basic type wire types.
	* @type {Object.<string,number>}
	* @const
	* @property {number} double=1 Fixed64 wire type
	* @property {number} float=5 Fixed32 wire type
	* @property {number} int32=0 Varint wire type
	* @property {number} uint32=0 Varint wire type
	* @property {number} sint32=0 Varint wire type
	* @property {number} fixed32=5 Fixed32 wire type
	* @property {number} sfixed32=5 Fixed32 wire type
	* @property {number} int64=0 Varint wire type
	* @property {number} uint64=0 Varint wire type
	* @property {number} sint64=0 Varint wire type
	* @property {number} fixed64=1 Fixed64 wire type
	* @property {number} sfixed64=1 Fixed64 wire type
	* @property {number} bool=0 Varint wire type
	* @property {number} string=2 Ldelim wire type
	* @property {number} bytes=2 Ldelim wire type
	*/
	types.basic = bake([
		1,
		5,
		0,
		0,
		0,
		5,
		5,
		0,
		0,
		0,
		1,
		1,
		0,
		2,
		2
	]);
	/**
	* Basic type defaults.
	* @type {Object.<string,*>}
	* @const
	* @property {number} double=0 Double default
	* @property {number} float=0 Float default
	* @property {number} int32=0 Int32 default
	* @property {number} uint32=0 Uint32 default
	* @property {number} sint32=0 Sint32 default
	* @property {number} fixed32=0 Fixed32 default
	* @property {number} sfixed32=0 Sfixed32 default
	* @property {number} int64=0 Int64 default
	* @property {number} uint64=0 Uint64 default
	* @property {number} sint64=0 Sint32 default
	* @property {number} fixed64=0 Fixed64 default
	* @property {number} sfixed64=0 Sfixed64 default
	* @property {boolean} bool=false Bool default
	* @property {string} string="" String default
	* @property {Array.<number>} bytes=Array(0) Bytes default
	* @property {null} message=null Message default
	*/
	types.defaults = bake([
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		false,
		"",
		util.emptyArray,
		null
	]);
	/**
	* Basic long type wire types.
	* @type {Object.<string,number>}
	* @const
	* @property {number} int64=0 Varint wire type
	* @property {number} uint64=0 Varint wire type
	* @property {number} sint64=0 Varint wire type
	* @property {number} fixed64=1 Fixed64 wire type
	* @property {number} sfixed64=1 Fixed64 wire type
	*/
	types.long = bake([
		0,
		0,
		0,
		1,
		1
	], 7);
	/**
	* Allowed types for map keys with their associated wire type.
	* @type {Object.<string,number>}
	* @const
	* @property {number} int32=0 Varint wire type
	* @property {number} uint32=0 Varint wire type
	* @property {number} sint32=0 Varint wire type
	* @property {number} fixed32=5 Fixed32 wire type
	* @property {number} sfixed32=5 Fixed32 wire type
	* @property {number} int64=0 Varint wire type
	* @property {number} uint64=0 Varint wire type
	* @property {number} sint64=0 Varint wire type
	* @property {number} fixed64=1 Fixed64 wire type
	* @property {number} sfixed64=1 Fixed64 wire type
	* @property {number} bool=0 Varint wire type
	* @property {number} string=2 Ldelim wire type
	*/
	types.mapKey = bake([
		0,
		0,
		0,
		5,
		5,
		0,
		0,
		0,
		1,
		1,
		0,
		2
	], 2);
	/**
	* Allowed types for packed repeated fields with their associated wire type.
	* @type {Object.<string,number>}
	* @const
	* @property {number} double=1 Fixed64 wire type
	* @property {number} float=5 Fixed32 wire type
	* @property {number} int32=0 Varint wire type
	* @property {number} uint32=0 Varint wire type
	* @property {number} sint32=0 Varint wire type
	* @property {number} fixed32=5 Fixed32 wire type
	* @property {number} sfixed32=5 Fixed32 wire type
	* @property {number} int64=0 Varint wire type
	* @property {number} uint64=0 Varint wire type
	* @property {number} sint64=0 Varint wire type
	* @property {number} fixed64=1 Fixed64 wire type
	* @property {number} sfixed64=1 Fixed64 wire type
	* @property {number} bool=0 Varint wire type
	*/
	types.packed = bake([
		1,
		5,
		0,
		0,
		0,
		5,
		5,
		0,
		0,
		0,
		1,
		1,
		0
	]);
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/field.js
var require_field = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Field;
	var ReflectionObject = require_object();
	((Field.prototype = Object.create(ReflectionObject.prototype)).constructor = Field).className = "Field";
	var Enum = require_enum(), types = require_types(), util = require_util$1();
	var Type;
	var ruleRe = /^required|optional|repeated$/;
	/**
	* Constructs a new message field instance. Note that {@link MapField|map fields} have their own class.
	* @name Field
	* @classdesc Reflected message field.
	* @extends FieldBase
	* @constructor
	* @param {string} name Unique name within its namespace
	* @param {number} id Unique id within its namespace
	* @param {string} type Value type
	* @param {string|Object.<string,*>} [rule="optional"] Field rule
	* @param {string|Object.<string,*>} [extend] Extended type if different from parent
	* @param {Object.<string,*>} [options] Declared options
	*/
	/**
	* Constructs a field from a field descriptor.
	* @param {string} name Field name
	* @param {IField} json Field descriptor
	* @returns {Field} Created field
	* @throws {TypeError} If arguments are invalid
	*/
	Field.fromJSON = function fromJSON(name, json) {
		var field = new Field(name, json.id, json.type, json.rule, json.extend, json.options, json.comment);
		if (json.edition) field._edition = json.edition;
		field._defaultEdition = "proto3";
		return field;
	};
	/**
	* Not an actual constructor. Use {@link Field} instead.
	* @classdesc Base class of all reflected message fields. This is not an actual class but here for the sake of having consistent type definitions.
	* @exports FieldBase
	* @extends ReflectionObject
	* @constructor
	* @param {string} name Unique name within its namespace
	* @param {number} id Unique id within its namespace
	* @param {string} type Value type
	* @param {string|Object.<string,*>} [rule="optional"] Field rule
	* @param {string|Object.<string,*>} [extend] Extended type if different from parent
	* @param {Object.<string,*>} [options] Declared options
	* @param {string} [comment] Comment associated with this field
	*/
	function Field(name, id, type, rule, extend, options, comment) {
		if (util.isObject(rule)) {
			comment = extend;
			options = rule;
			rule = extend = void 0;
		} else if (util.isObject(extend)) {
			comment = options;
			options = extend;
			extend = void 0;
		}
		ReflectionObject.call(this, name, options);
		if (!util.isInteger(id) || id < 0) throw TypeError("id must be a non-negative integer");
		if (!util.isString(type)) throw TypeError("type must be a string");
		if (rule !== void 0 && !ruleRe.test(rule = rule.toString().toLowerCase())) throw TypeError("rule must be a string rule");
		if (extend !== void 0 && !util.isString(extend)) throw TypeError("extend must be a string");
		/**
		* Field rule, if any.
		* @type {string|undefined}
		*/
		if (rule === "proto3_optional") rule = "optional";
		this.rule = rule && rule !== "optional" ? rule : void 0;
		/**
		* Field type.
		* @type {string}
		*/
		this.type = type;
		/**
		* Unique field id.
		* @type {number}
		*/
		this.id = id;
		/**
		* Extended type if different from parent.
		* @type {string|undefined}
		*/
		this.extend = extend || void 0;
		/**
		* Whether this field is repeated.
		* @type {boolean}
		*/
		this.repeated = rule === "repeated";
		/**
		* Whether this field is a map or not.
		* @type {boolean}
		*/
		this.map = false;
		/**
		* Message this field belongs to.
		* @type {Type|null}
		*/
		this.message = null;
		/**
		* OneOf this field belongs to, if any,
		* @type {OneOf|null}
		*/
		this.partOf = null;
		/**
		* The field type's default value.
		* @type {*}
		*/
		this.typeDefault = null;
		/**
		* The field's default value on prototypes.
		* @type {*}
		*/
		this.defaultValue = null;
		/**
		* Whether this field's value should be treated as a long.
		* @type {boolean}
		*/
		this.long = util.Long ? types.long[type] !== void 0 : false;
		/**
		* Whether this field's value is a buffer.
		* @type {boolean}
		*/
		this.bytes = type === "bytes";
		/**
		* Resolved type if not a basic type.
		* @type {Type|Enum|null}
		*/
		this.resolvedType = null;
		/**
		* Sister-field within the extended type if a declaring extension field.
		* @type {Field|null}
		*/
		this.extensionField = null;
		/**
		* Sister-field within the declaring namespace if an extended field.
		* @type {Field|null}
		*/
		this.declaringField = null;
		/**
		* Comment for this field.
		* @type {string|null}
		*/
		this.comment = comment;
	}
	/**
	* Determines whether this field is required.
	* @name Field#required
	* @type {boolean}
	* @readonly
	*/
	Object.defineProperty(Field.prototype, "required", { get: function() {
		return this._features.field_presence === "LEGACY_REQUIRED";
	} });
	/**
	* Determines whether this field is not required.
	* @name Field#optional
	* @type {boolean}
	* @readonly
	*/
	Object.defineProperty(Field.prototype, "optional", { get: function() {
		return !this.required;
	} });
	/**
	* Determines whether this field uses tag-delimited encoding.  In proto2 this
	* corresponded to group syntax.
	* @name Field#delimited
	* @type {boolean}
	* @readonly
	*/
	Object.defineProperty(Field.prototype, "delimited", { get: function() {
		return this.resolvedType instanceof Type && this._features.message_encoding === "DELIMITED";
	} });
	/**
	* Determines whether this field is packed. Only relevant when repeated.
	* @name Field#packed
	* @type {boolean}
	* @readonly
	*/
	Object.defineProperty(Field.prototype, "packed", { get: function() {
		return this._features.repeated_field_encoding === "PACKED";
	} });
	/**
	* Determines whether this field tracks presence.
	* @name Field#hasPresence
	* @type {boolean}
	* @readonly
	*/
	Object.defineProperty(Field.prototype, "hasPresence", { get: function() {
		if (this.repeated || this.map) return false;
		return this.partOf || this.declaringField || this.extensionField || this._features.field_presence !== "IMPLICIT";
	} });
	/**
	* @override
	*/
	Field.prototype.setOption = function setOption(name, value, ifNotSet) {
		return ReflectionObject.prototype.setOption.call(this, name, value, ifNotSet);
	};
	/**
	* Field descriptor.
	* @interface IField
	* @property {string} [rule="optional"] Field rule
	* @property {string} type Field type
	* @property {number} id Field id
	* @property {Object.<string,*>} [options] Field options
	*/
	/**
	* Extension field descriptor.
	* @interface IExtensionField
	* @extends IField
	* @property {string} extend Extended type
	*/
	/**
	* Converts this field to a field descriptor.
	* @param {IToJSONOptions} [toJSONOptions] JSON conversion options
	* @returns {IField} Field descriptor
	*/
	Field.prototype.toJSON = function toJSON(toJSONOptions) {
		var keepComments = toJSONOptions ? Boolean(toJSONOptions.keepComments) : false;
		return util.toObject([
			"edition",
			this._editionToJSON(),
			"rule",
			this.rule !== "optional" && this.rule || void 0,
			"type",
			this.type,
			"id",
			this.id,
			"extend",
			this.extend,
			"options",
			this.options,
			"comment",
			keepComments ? this.comment : void 0
		]);
	};
	/**
	* Resolves this field's type references.
	* @returns {Field} `this`
	* @throws {Error} If any reference cannot be resolved
	*/
	Field.prototype.resolve = function resolve() {
		if (this.resolved) return this;
		if ((this.typeDefault = types.defaults[this.type]) === void 0) {
			this.resolvedType = (this.declaringField ? this.declaringField.parent : this.parent).lookupTypeOrEnum(this.type);
			if (this.resolvedType instanceof Type) this.typeDefault = null;
			else this.typeDefault = this.resolvedType.values[Object.keys(this.resolvedType.values)[0]];
		} else if (this.options && this.options.proto3_optional) this.typeDefault = null;
		if (this.options && this.options["default"] != null) {
			this.typeDefault = this.options["default"];
			if (this.resolvedType instanceof Enum && typeof this.typeDefault === "string") this.typeDefault = this.resolvedType.values[this.typeDefault];
		}
		if (this.options) {
			if (this.options.packed !== void 0 && this.resolvedType && !(this.resolvedType instanceof Enum)) delete this.options.packed;
			if (!Object.keys(this.options).length) this.options = void 0;
		}
		if (this.long) {
			this.typeDefault = util.Long.fromNumber(this.typeDefault, this.type.charAt(0) === "u");
			/* istanbul ignore else */
			if (Object.freeze) Object.freeze(this.typeDefault);
		} else if (this.bytes && typeof this.typeDefault === "string") {
			var buf;
			if (util.base64.test(this.typeDefault)) util.base64.decode(this.typeDefault, buf = util.newBuffer(util.base64.length(this.typeDefault)), 0);
			else util.utf8.write(this.typeDefault, buf = util.newBuffer(util.utf8.length(this.typeDefault)), 0);
			this.typeDefault = buf;
		}
		if (this.map) this.defaultValue = util.emptyObject;
		else if (this.repeated) this.defaultValue = util.emptyArray;
		else this.defaultValue = this.typeDefault;
		if (this.parent instanceof Type) this.parent.ctor.prototype[this.name] = this.defaultValue;
		return ReflectionObject.prototype.resolve.call(this);
	};
	/**
	* Infers field features from legacy syntax that may have been specified differently.
	* in older editions.
	* @param {string|undefined} edition The edition this proto is on, or undefined if pre-editions
	* @returns {object} The feature values to override
	*/
	Field.prototype._inferLegacyProtoFeatures = function _inferLegacyProtoFeatures(edition) {
		if (edition !== "proto2" && edition !== "proto3") return {};
		var features = {};
		if (this.rule === "required") features.field_presence = "LEGACY_REQUIRED";
		if (this.parent && types.defaults[this.type] === void 0) {
			var type = this.parent.get(this.type.split(".").pop());
			if (type && type instanceof Type && type.group) features.message_encoding = "DELIMITED";
		}
		if (this.getOption("packed") === true) features.repeated_field_encoding = "PACKED";
		else if (this.getOption("packed") === false) features.repeated_field_encoding = "EXPANDED";
		return features;
	};
	/**
	* @override
	*/
	Field.prototype._resolveFeatures = function _resolveFeatures(edition) {
		return ReflectionObject.prototype._resolveFeatures.call(this, this._edition || edition);
	};
	/**
	* Decorator function as returned by {@link Field.d} and {@link MapField.d} (TypeScript).
	* @typedef FieldDecorator
	* @type {function}
	* @param {Object} prototype Target prototype
	* @param {string} fieldName Field name
	* @returns {undefined}
	*/
	/**
	* Field decorator (TypeScript).
	* @name Field.d
	* @function
	* @param {number} fieldId Field id
	* @param {"double"|"float"|"int32"|"uint32"|"sint32"|"fixed32"|"sfixed32"|"int64"|"uint64"|"sint64"|"fixed64"|"sfixed64"|"string"|"bool"|"bytes"|Object} fieldType Field type
	* @param {"optional"|"required"|"repeated"} [fieldRule="optional"] Field rule
	* @param {T} [defaultValue] Default value
	* @returns {FieldDecorator} Decorator function
	* @template T extends number | number[] | Long | Long[] | string | string[] | boolean | boolean[] | Uint8Array | Uint8Array[] | Buffer | Buffer[]
	*/
	Field.d = function decorateField(fieldId, fieldType, fieldRule, defaultValue) {
		if (typeof fieldType === "function") fieldType = util.decorateType(fieldType).name;
		else if (fieldType && typeof fieldType === "object") fieldType = util.decorateEnum(fieldType).name;
		return function fieldDecorator(prototype, fieldName) {
			util.decorateType(prototype.constructor).add(new Field(fieldName, fieldId, fieldType, fieldRule, { "default": defaultValue }));
		};
	};
	/**
	* Field decorator (TypeScript).
	* @name Field.d
	* @function
	* @param {number} fieldId Field id
	* @param {Constructor<T>|string} fieldType Field type
	* @param {"optional"|"required"|"repeated"} [fieldRule="optional"] Field rule
	* @returns {FieldDecorator} Decorator function
	* @template T extends Message<T>
	* @variation 2
	*/
	Field._configure = function configure(Type_) {
		Type = Type_;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/oneof.js
var require_oneof = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = OneOf;
	var ReflectionObject = require_object();
	((OneOf.prototype = Object.create(ReflectionObject.prototype)).constructor = OneOf).className = "OneOf";
	var Field = require_field(), util = require_util$1();
	/**
	* Constructs a new oneof instance.
	* @classdesc Reflected oneof.
	* @extends ReflectionObject
	* @constructor
	* @param {string} name Oneof name
	* @param {string[]|Object.<string,*>} [fieldNames] Field names
	* @param {Object.<string,*>} [options] Declared options
	* @param {string} [comment] Comment associated with this field
	*/
	function OneOf(name, fieldNames, options, comment) {
		if (!Array.isArray(fieldNames)) {
			options = fieldNames;
			fieldNames = void 0;
		}
		ReflectionObject.call(this, name, options);
		/* istanbul ignore if */
		if (!(fieldNames === void 0 || Array.isArray(fieldNames))) throw TypeError("fieldNames must be an Array");
		/**
		* Field names that belong to this oneof.
		* @type {string[]}
		*/
		this.oneof = fieldNames || [];
		/**
		* Fields that belong to this oneof as an array for iteration.
		* @type {Field[]}
		* @readonly
		*/
		this.fieldsArray = [];
		/**
		* Comment for this field.
		* @type {string|null}
		*/
		this.comment = comment;
	}
	/**
	* Oneof descriptor.
	* @interface IOneOf
	* @property {Array.<string>} oneof Oneof field names
	* @property {Object.<string,*>} [options] Oneof options
	*/
	/**
	* Constructs a oneof from a oneof descriptor.
	* @param {string} name Oneof name
	* @param {IOneOf} json Oneof descriptor
	* @returns {OneOf} Created oneof
	* @throws {TypeError} If arguments are invalid
	*/
	OneOf.fromJSON = function fromJSON(name, json) {
		return new OneOf(name, json.oneof, json.options, json.comment);
	};
	/**
	* Converts this oneof to a oneof descriptor.
	* @param {IToJSONOptions} [toJSONOptions] JSON conversion options
	* @returns {IOneOf} Oneof descriptor
	*/
	OneOf.prototype.toJSON = function toJSON(toJSONOptions) {
		var keepComments = toJSONOptions ? Boolean(toJSONOptions.keepComments) : false;
		return util.toObject([
			"options",
			this.options,
			"oneof",
			this.oneof,
			"comment",
			keepComments ? this.comment : void 0
		]);
	};
	/**
	* Adds the fields of the specified oneof to the parent if not already done so.
	* @param {OneOf} oneof The oneof
	* @returns {undefined}
	* @inner
	* @ignore
	*/
	function addFieldsToParent(oneof) {
		if (oneof.parent) {
			for (var i = 0; i < oneof.fieldsArray.length; ++i) if (!oneof.fieldsArray[i].parent) oneof.parent.add(oneof.fieldsArray[i]);
		}
	}
	/**
	* Adds a field to this oneof and removes it from its current parent, if any.
	* @param {Field} field Field to add
	* @returns {OneOf} `this`
	*/
	OneOf.prototype.add = function add(field) {
		/* istanbul ignore if */
		if (!(field instanceof Field)) throw TypeError("field must be a Field");
		if (field.parent && field.parent !== this.parent) field.parent.remove(field);
		this.oneof.push(field.name);
		this.fieldsArray.push(field);
		field.partOf = this;
		addFieldsToParent(this);
		return this;
	};
	/**
	* Removes a field from this oneof and puts it back to the oneof's parent.
	* @param {Field} field Field to remove
	* @returns {OneOf} `this`
	*/
	OneOf.prototype.remove = function remove(field) {
		/* istanbul ignore if */
		if (!(field instanceof Field)) throw TypeError("field must be a Field");
		var index = this.fieldsArray.indexOf(field);
		/* istanbul ignore if */
		if (index < 0) throw Error(field + " is not a member of " + this);
		this.fieldsArray.splice(index, 1);
		index = this.oneof.indexOf(field.name);
		/* istanbul ignore else */
		if (index > -1) this.oneof.splice(index, 1);
		field.partOf = null;
		return this;
	};
	/**
	* @override
	*/
	OneOf.prototype.onAdd = function onAdd(parent) {
		ReflectionObject.prototype.onAdd.call(this, parent);
		var self = this;
		for (var i = 0; i < this.oneof.length; ++i) {
			var field = parent.get(this.oneof[i]);
			if (field && !field.partOf) {
				field.partOf = self;
				self.fieldsArray.push(field);
			}
		}
		addFieldsToParent(this);
	};
	/**
	* @override
	*/
	OneOf.prototype.onRemove = function onRemove(parent) {
		for (var i = 0, field; i < this.fieldsArray.length; ++i) if ((field = this.fieldsArray[i]).parent) field.parent.remove(field);
		ReflectionObject.prototype.onRemove.call(this, parent);
	};
	/**
	* Determines whether this field corresponds to a synthetic oneof created for
	* a proto3 optional field.  No behavioral logic should depend on this, but it
	* can be relevant for reflection.
	* @name OneOf#isProto3Optional
	* @type {boolean}
	* @readonly
	*/
	Object.defineProperty(OneOf.prototype, "isProto3Optional", { get: function() {
		if (this.fieldsArray == null || this.fieldsArray.length !== 1) return false;
		var field = this.fieldsArray[0];
		return field.options != null && field.options["proto3_optional"] === true;
	} });
	/**
	* Decorator function as returned by {@link OneOf.d} (TypeScript).
	* @typedef OneOfDecorator
	* @type {function}
	* @param {Object} prototype Target prototype
	* @param {string} oneofName OneOf name
	* @returns {undefined}
	*/
	/**
	* OneOf decorator (TypeScript).
	* @function
	* @param {...string} fieldNames Field names
	* @returns {OneOfDecorator} Decorator function
	* @template T extends string
	*/
	OneOf.d = function decorateOneOf() {
		var fieldNames = new Array(arguments.length), index = 0;
		while (index < arguments.length) fieldNames[index] = arguments[index++];
		return function oneOfDecorator(prototype, oneofName) {
			util.decorateType(prototype.constructor).add(new OneOf(oneofName, fieldNames));
			Object.defineProperty(prototype, oneofName, {
				get: util.oneOfGetter(fieldNames),
				set: util.oneOfSetter(fieldNames)
			});
		};
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/object.js
var require_object = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = ReflectionObject;
	ReflectionObject.className = "ReflectionObject";
	const OneOf = require_oneof();
	var util = require_util$1();
	var Root;
	var editions2023Defaults = {
		enum_type: "OPEN",
		field_presence: "EXPLICIT",
		json_format: "ALLOW",
		message_encoding: "LENGTH_PREFIXED",
		repeated_field_encoding: "PACKED",
		utf8_validation: "VERIFY"
	};
	var proto2Defaults = {
		enum_type: "CLOSED",
		field_presence: "EXPLICIT",
		json_format: "LEGACY_BEST_EFFORT",
		message_encoding: "LENGTH_PREFIXED",
		repeated_field_encoding: "EXPANDED",
		utf8_validation: "NONE"
	};
	var proto3Defaults = {
		enum_type: "OPEN",
		field_presence: "IMPLICIT",
		json_format: "ALLOW",
		message_encoding: "LENGTH_PREFIXED",
		repeated_field_encoding: "PACKED",
		utf8_validation: "VERIFY"
	};
	/**
	* Constructs a new reflection object instance.
	* @classdesc Base class of all reflection objects.
	* @constructor
	* @param {string} name Object name
	* @param {Object.<string,*>} [options] Declared options
	* @abstract
	*/
	function ReflectionObject(name, options) {
		if (!util.isString(name)) throw TypeError("name must be a string");
		if (options && !util.isObject(options)) throw TypeError("options must be an object");
		/**
		* Options.
		* @type {Object.<string,*>|undefined}
		*/
		this.options = options;
		/**
		* Parsed Options.
		* @type {Array.<Object.<string,*>>|undefined}
		*/
		this.parsedOptions = null;
		/**
		* Unique name within its namespace.
		* @type {string}
		*/
		this.name = name;
		/**
		* The edition specified for this object.  Only relevant for top-level objects.
		* @type {string}
		* @private
		*/
		this._edition = null;
		/**
		* The default edition to use for this object if none is specified.  For legacy reasons,
		* this is proto2 except in the JSON parsing case where it was proto3.
		* @type {string}
		* @private
		*/
		this._defaultEdition = "proto2";
		/**
		* Resolved Features.
		* @type {object}
		* @private
		*/
		this._features = {};
		/**
		* Whether or not features have been resolved.
		* @type {boolean}
		* @private
		*/
		this._featuresResolved = false;
		/**
		* Parent namespace.
		* @type {Namespace|null}
		*/
		this.parent = null;
		/**
		* Whether already resolved or not.
		* @type {boolean}
		*/
		this.resolved = false;
		/**
		* Comment text, if any.
		* @type {string|null}
		*/
		this.comment = null;
		/**
		* Defining file name.
		* @type {string|null}
		*/
		this.filename = null;
	}
	Object.defineProperties(ReflectionObject.prototype, {
		root: { get: function() {
			var ptr = this;
			while (ptr.parent !== null) ptr = ptr.parent;
			return ptr;
		} },
		fullName: { get: function() {
			var path = [this.name], ptr = this.parent;
			while (ptr) {
				path.unshift(ptr.name);
				ptr = ptr.parent;
			}
			return path.join(".");
		} }
	});
	/**
	* Converts this reflection object to its descriptor representation.
	* @returns {Object.<string,*>} Descriptor
	* @abstract
	*/
	ReflectionObject.prototype.toJSON = function toJSON() {
		throw Error();
	};
	/**
	* Called when this object is added to a parent.
	* @param {ReflectionObject} parent Parent added to
	* @returns {undefined}
	*/
	ReflectionObject.prototype.onAdd = function onAdd(parent) {
		if (this.parent && this.parent !== parent) this.parent.remove(this);
		this.parent = parent;
		this.resolved = false;
		var root = parent.root;
		if (root instanceof Root) root._handleAdd(this);
	};
	/**
	* Called when this object is removed from a parent.
	* @param {ReflectionObject} parent Parent removed from
	* @returns {undefined}
	*/
	ReflectionObject.prototype.onRemove = function onRemove(parent) {
		var root = parent.root;
		if (root instanceof Root) root._handleRemove(this);
		this.parent = null;
		this.resolved = false;
	};
	/**
	* Resolves this objects type references.
	* @returns {ReflectionObject} `this`
	*/
	ReflectionObject.prototype.resolve = function resolve() {
		if (this.resolved) return this;
		if (this.root instanceof Root) this.resolved = true;
		return this;
	};
	/**
	* Resolves this objects editions features.
	* @param {string} edition The edition we're currently resolving for.
	* @returns {ReflectionObject} `this`
	*/
	ReflectionObject.prototype._resolveFeaturesRecursive = function _resolveFeaturesRecursive(edition) {
		return this._resolveFeatures(this._edition || edition);
	};
	/**
	* Resolves child features from parent features
	* @param {string} edition The edition we're currently resolving for.
	* @returns {undefined}
	*/
	ReflectionObject.prototype._resolveFeatures = function _resolveFeatures(edition) {
		if (this._featuresResolved) return;
		var defaults = {};
		/* istanbul ignore if */
		if (!edition) throw new Error("Unknown edition for " + this.fullName);
		var protoFeatures = Object.assign(this.options ? Object.assign({}, this.options.features) : {}, this._inferLegacyProtoFeatures(edition));
		if (this._edition) {
			/* istanbul ignore else */
			if (edition === "proto2") defaults = Object.assign({}, proto2Defaults);
			else if (edition === "proto3") defaults = Object.assign({}, proto3Defaults);
			else if (edition === "2023") defaults = Object.assign({}, editions2023Defaults);
			else throw new Error("Unknown edition: " + edition);
			this._features = Object.assign(defaults, protoFeatures || {});
			this._featuresResolved = true;
			return;
		}
		/* istanbul ignore else */
		if (this.partOf instanceof OneOf) {
			var lexicalParentFeaturesCopy = Object.assign({}, this.partOf._features);
			this._features = Object.assign(lexicalParentFeaturesCopy, protoFeatures || {});
		} else if (this.declaringField) {} else if (this.parent) {
			var parentFeaturesCopy = Object.assign({}, this.parent._features);
			this._features = Object.assign(parentFeaturesCopy, protoFeatures || {});
		} else throw new Error("Unable to find a parent for " + this.fullName);
		if (this.extensionField) this.extensionField._features = this._features;
		this._featuresResolved = true;
	};
	/**
	* Infers features from legacy syntax that may have been specified differently.
	* in older editions.
	* @param {string|undefined} edition The edition this proto is on, or undefined if pre-editions
	* @returns {object} The feature values to override
	*/
	ReflectionObject.prototype._inferLegacyProtoFeatures = function _inferLegacyProtoFeatures() {
		return {};
	};
	/**
	* Gets an option value.
	* @param {string} name Option name
	* @returns {*} Option value or `undefined` if not set
	*/
	ReflectionObject.prototype.getOption = function getOption(name) {
		if (this.options) return this.options[name];
	};
	/**
	* Sets an option.
	* @param {string} name Option name
	* @param {*} value Option value
	* @param {boolean|undefined} [ifNotSet] Sets the option only if it isn't currently set
	* @returns {ReflectionObject} `this`
	*/
	ReflectionObject.prototype.setOption = function setOption(name, value, ifNotSet) {
		if (!this.options) this.options = {};
		if (/^features\./.test(name)) util.setProperty(this.options, name, value, ifNotSet);
		else if (!ifNotSet || this.options[name] === void 0) {
			if (this.getOption(name) !== value) this.resolved = false;
			this.options[name] = value;
		}
		return this;
	};
	/**
	* Sets a parsed option.
	* @param {string} name parsed Option name
	* @param {*} value Option value
	* @param {string} propName dot '.' delimited full path of property within the option to set. if undefined\empty, will add a new option with that value
	* @returns {ReflectionObject} `this`
	*/
	ReflectionObject.prototype.setParsedOption = function setParsedOption(name, value, propName) {
		if (!this.parsedOptions) this.parsedOptions = [];
		var parsedOptions = this.parsedOptions;
		if (propName) {
			var opt = parsedOptions.find(function(opt) {
				return Object.prototype.hasOwnProperty.call(opt, name);
			});
			if (opt) {
				var newValue = opt[name];
				util.setProperty(newValue, propName, value);
			} else {
				opt = {};
				opt[name] = util.setProperty({}, propName, value);
				parsedOptions.push(opt);
			}
		} else {
			var newOpt = {};
			newOpt[name] = value;
			parsedOptions.push(newOpt);
		}
		return this;
	};
	/**
	* Sets multiple options.
	* @param {Object.<string,*>} options Options to set
	* @param {boolean} [ifNotSet] Sets an option only if it isn't currently set
	* @returns {ReflectionObject} `this`
	*/
	ReflectionObject.prototype.setOptions = function setOptions(options, ifNotSet) {
		if (options) for (var keys = Object.keys(options), i = 0; i < keys.length; ++i) this.setOption(keys[i], options[keys[i]], ifNotSet);
		return this;
	};
	/**
	* Converts this instance to its string representation.
	* @returns {string} Class name[, space, full name]
	*/
	ReflectionObject.prototype.toString = function toString() {
		var className = this.constructor.className, fullName = this.fullName;
		if (fullName.length) return className + " " + fullName;
		return className;
	};
	/**
	* Converts the edition this object is pinned to for JSON format.
	* @returns {string|undefined} The edition string for JSON representation
	*/
	ReflectionObject.prototype._editionToJSON = function _editionToJSON() {
		if (!this._edition || this._edition === "proto3") return;
		return this._edition;
	};
	ReflectionObject._configure = function(Root_) {
		Root = Root_;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/enum.js
var require_enum = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Enum;
	var ReflectionObject = require_object();
	((Enum.prototype = Object.create(ReflectionObject.prototype)).constructor = Enum).className = "Enum";
	var Namespace = require_namespace(), util = require_util$1();
	/**
	* Constructs a new enum instance.
	* @classdesc Reflected enum.
	* @extends ReflectionObject
	* @constructor
	* @param {string} name Unique name within its namespace
	* @param {Object.<string,number>} [values] Enum values as an object, by name
	* @param {Object.<string,*>} [options] Declared options
	* @param {string} [comment] The comment for this enum
	* @param {Object.<string,string>} [comments] The value comments for this enum
	* @param {Object.<string,Object<string,*>>|undefined} [valuesOptions] The value options for this enum
	*/
	function Enum(name, values, options, comment, comments, valuesOptions) {
		ReflectionObject.call(this, name, options);
		if (values && typeof values !== "object") throw TypeError("values must be an object");
		/**
		* Enum values by id.
		* @type {Object.<number,string>}
		*/
		this.valuesById = {};
		/**
		* Enum values by name.
		* @type {Object.<string,number>}
		*/
		this.values = Object.create(this.valuesById);
		/**
		* Enum comment text.
		* @type {string|null}
		*/
		this.comment = comment;
		/**
		* Value comment texts, if any.
		* @type {Object.<string,string>}
		*/
		this.comments = comments || {};
		/**
		* Values options, if any
		* @type {Object<string, Object<string, *>>|undefined}
		*/
		this.valuesOptions = valuesOptions;
		/**
		* Resolved values features, if any
		* @type {Object<string, Object<string, *>>|undefined}
		*/
		this._valuesFeatures = {};
		/**
		* Reserved ranges, if any.
		* @type {Array.<number[]|string>}
		*/
		this.reserved = void 0;
		if (values) {
			for (var keys = Object.keys(values), i = 0; i < keys.length; ++i) if (typeof values[keys[i]] === "number") this.valuesById[this.values[keys[i]] = values[keys[i]]] = keys[i];
		}
	}
	/**
	* @override
	*/
	Enum.prototype._resolveFeatures = function _resolveFeatures(edition) {
		edition = this._edition || edition;
		ReflectionObject.prototype._resolveFeatures.call(this, edition);
		Object.keys(this.values).forEach((key) => {
			var parentFeaturesCopy = Object.assign({}, this._features);
			this._valuesFeatures[key] = Object.assign(parentFeaturesCopy, this.valuesOptions && this.valuesOptions[key] && this.valuesOptions[key].features);
		});
		return this;
	};
	/**
	* Enum descriptor.
	* @interface IEnum
	* @property {Object.<string,number>} values Enum values
	* @property {Object.<string,*>} [options] Enum options
	*/
	/**
	* Constructs an enum from an enum descriptor.
	* @param {string} name Enum name
	* @param {IEnum} json Enum descriptor
	* @returns {Enum} Created enum
	* @throws {TypeError} If arguments are invalid
	*/
	Enum.fromJSON = function fromJSON(name, json) {
		var enm = new Enum(name, json.values, json.options, json.comment, json.comments);
		enm.reserved = json.reserved;
		if (json.edition) enm._edition = json.edition;
		enm._defaultEdition = "proto3";
		return enm;
	};
	/**
	* Converts this enum to an enum descriptor.
	* @param {IToJSONOptions} [toJSONOptions] JSON conversion options
	* @returns {IEnum} Enum descriptor
	*/
	Enum.prototype.toJSON = function toJSON(toJSONOptions) {
		var keepComments = toJSONOptions ? Boolean(toJSONOptions.keepComments) : false;
		return util.toObject([
			"edition",
			this._editionToJSON(),
			"options",
			this.options,
			"valuesOptions",
			this.valuesOptions,
			"values",
			this.values,
			"reserved",
			this.reserved && this.reserved.length ? this.reserved : void 0,
			"comment",
			keepComments ? this.comment : void 0,
			"comments",
			keepComments ? this.comments : void 0
		]);
	};
	/**
	* Adds a value to this enum.
	* @param {string} name Value name
	* @param {number} id Value id
	* @param {string} [comment] Comment, if any
	* @param {Object.<string, *>|undefined} [options] Options, if any
	* @returns {Enum} `this`
	* @throws {TypeError} If arguments are invalid
	* @throws {Error} If there is already a value with this name or id
	*/
	Enum.prototype.add = function add(name, id, comment, options) {
		if (!util.isString(name)) throw TypeError("name must be a string");
		if (!util.isInteger(id)) throw TypeError("id must be an integer");
		if (this.values[name] !== void 0) throw Error("duplicate name '" + name + "' in " + this);
		if (this.isReservedId(id)) throw Error("id " + id + " is reserved in " + this);
		if (this.isReservedName(name)) throw Error("name '" + name + "' is reserved in " + this);
		if (this.valuesById[id] !== void 0) {
			if (!(this.options && this.options.allow_alias)) throw Error("duplicate id " + id + " in " + this);
			this.values[name] = id;
		} else this.valuesById[this.values[name] = id] = name;
		if (options) {
			if (this.valuesOptions === void 0) this.valuesOptions = {};
			this.valuesOptions[name] = options || null;
		}
		this.comments[name] = comment || null;
		return this;
	};
	/**
	* Removes a value from this enum
	* @param {string} name Value name
	* @returns {Enum} `this`
	* @throws {TypeError} If arguments are invalid
	* @throws {Error} If `name` is not a name of this enum
	*/
	Enum.prototype.remove = function remove(name) {
		if (!util.isString(name)) throw TypeError("name must be a string");
		var val = this.values[name];
		if (val == null) throw Error("name '" + name + "' does not exist in " + this);
		delete this.valuesById[val];
		delete this.values[name];
		delete this.comments[name];
		if (this.valuesOptions) delete this.valuesOptions[name];
		return this;
	};
	/**
	* Tests if the specified id is reserved.
	* @param {number} id Id to test
	* @returns {boolean} `true` if reserved, otherwise `false`
	*/
	Enum.prototype.isReservedId = function isReservedId(id) {
		return Namespace.isReservedId(this.reserved, id);
	};
	/**
	* Tests if the specified name is reserved.
	* @param {string} name Name to test
	* @returns {boolean} `true` if reserved, otherwise `false`
	*/
	Enum.prototype.isReservedName = function isReservedName(name) {
		return Namespace.isReservedName(this.reserved, name);
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/encoder.js
var require_encoder = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = encoder;
	var Enum = require_enum(), types = require_types(), util = require_util$1();
	/**
	* Generates a partial message type encoder.
	* @param {Codegen} gen Codegen instance
	* @param {Field} field Reflected field
	* @param {number} fieldIndex Field index
	* @param {string} ref Variable reference
	* @returns {Codegen} Codegen instance
	* @ignore
	*/
	function genTypePartial(gen, field, fieldIndex, ref) {
		return field.delimited ? gen("types[%i].encode(%s,w.uint32(%i)).uint32(%i)", fieldIndex, ref, (field.id << 3 | 3) >>> 0, (field.id << 3 | 4) >>> 0) : gen("types[%i].encode(%s,w.uint32(%i).fork()).ldelim()", fieldIndex, ref, (field.id << 3 | 2) >>> 0);
	}
	/**
	* Generates an encoder specific to the specified message type.
	* @param {Type} mtype Message type
	* @returns {Codegen} Codegen instance
	*/
	function encoder(mtype) {
		var gen = util.codegen(["m", "w"], mtype.name + "$encode")("if(!w)")("w=Writer.create()");
		var i, ref;
		var fields = mtype.fieldsArray.slice().sort(util.compareFieldsById);
		for (var i = 0; i < fields.length; ++i) {
			var field = fields[i].resolve(), index = mtype._fieldsArray.indexOf(field), type = field.resolvedType instanceof Enum ? "int32" : field.type, wireType = types.basic[type];
			ref = "m" + util.safeProp(field.name);
			if (field.map) {
				gen("if(%s!=null&&Object.hasOwnProperty.call(m,%j)){", ref, field.name)("for(var ks=Object.keys(%s),i=0;i<ks.length;++i){", ref)("w.uint32(%i).fork().uint32(%i).%s(ks[i])", (field.id << 3 | 2) >>> 0, 8 | types.mapKey[field.keyType], field.keyType);
				if (wireType === void 0) gen("types[%i].encode(%s[ks[i]],w.uint32(18).fork()).ldelim().ldelim()", index, ref);
				else gen(".uint32(%i).%s(%s[ks[i]]).ldelim()", 16 | wireType, type, ref);
				gen("}")("}");
			} else if (field.repeated) {
				gen("if(%s!=null&&%s.length){", ref, ref);
				if (field.packed && types.packed[type] !== void 0) gen("w.uint32(%i).fork()", (field.id << 3 | 2) >>> 0)("for(var i=0;i<%s.length;++i)", ref)("w.%s(%s[i])", type, ref)("w.ldelim()");
				else {
					gen("for(var i=0;i<%s.length;++i)", ref);
					if (wireType === void 0) genTypePartial(gen, field, index, ref + "[i]");
					else gen("w.uint32(%i).%s(%s[i])", (field.id << 3 | wireType) >>> 0, type, ref);
				}
				gen("}");
			} else {
				if (field.optional) gen("if(%s!=null&&Object.hasOwnProperty.call(m,%j))", ref, field.name);
				if (wireType === void 0) genTypePartial(gen, field, index, ref);
				else gen("w.uint32(%i).%s(%s)", (field.id << 3 | wireType) >>> 0, type, ref);
			}
		}
		return gen("return w");
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/index-light.js
var require_index_light = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var protobuf = module.exports = require_index_minimal();
	protobuf.build = "light";
	/**
	* A node-style callback as used by {@link load} and {@link Root#load}.
	* @typedef LoadCallback
	* @type {function}
	* @param {Error|null} error Error, if any, otherwise `null`
	* @param {Root} [root] Root, if there hasn't been an error
	* @returns {undefined}
	*/
	/**
	* Loads one or multiple .proto or preprocessed .json files into a common root namespace and calls the callback.
	* @param {string|string[]} filename One or multiple files to load
	* @param {Root} root Root namespace, defaults to create a new one if omitted.
	* @param {LoadCallback} callback Callback function
	* @returns {undefined}
	* @see {@link Root#load}
	*/
	function load(filename, root, callback) {
		if (typeof root === "function") {
			callback = root;
			root = new protobuf.Root();
		} else if (!root) root = new protobuf.Root();
		return root.load(filename, callback);
	}
	/**
	* Loads one or multiple .proto or preprocessed .json files into a common root namespace and calls the callback.
	* @name load
	* @function
	* @param {string|string[]} filename One or multiple files to load
	* @param {LoadCallback} callback Callback function
	* @returns {undefined}
	* @see {@link Root#load}
	* @variation 2
	*/
	/**
	* Loads one or multiple .proto or preprocessed .json files into a common root namespace and returns a promise.
	* @name load
	* @function
	* @param {string|string[]} filename One or multiple files to load
	* @param {Root} [root] Root namespace, defaults to create a new one if omitted.
	* @returns {Promise<Root>} Promise
	* @see {@link Root#load}
	* @variation 3
	*/
	protobuf.load = load;
	/**
	* Synchronously loads one or multiple .proto or preprocessed .json files into a common root namespace (node only).
	* @param {string|string[]} filename One or multiple files to load
	* @param {Root} [root] Root namespace, defaults to create a new one if omitted.
	* @returns {Root} Root namespace
	* @throws {Error} If synchronous fetching is not supported (i.e. in browsers) or if a file's syntax is invalid
	* @see {@link Root#loadSync}
	*/
	function loadSync(filename, root) {
		if (!root) root = new protobuf.Root();
		return root.loadSync(filename);
	}
	protobuf.loadSync = loadSync;
	protobuf.encoder = require_encoder();
	protobuf.decoder = require_decoder();
	protobuf.verifier = require_verifier();
	protobuf.converter = require_converter();
	protobuf.ReflectionObject = require_object();
	protobuf.Namespace = require_namespace();
	protobuf.Root = require_root();
	protobuf.Enum = require_enum();
	protobuf.Type = require_type$1();
	protobuf.Field = require_field();
	protobuf.OneOf = require_oneof();
	protobuf.MapField = require_mapfield();
	protobuf.Service = require_service();
	protobuf.Method = require_method();
	protobuf.Message = require_message();
	protobuf.wrappers = require_wrappers();
	protobuf.types = require_types();
	protobuf.util = require_util$1();
	protobuf.ReflectionObject._configure(protobuf.Root);
	protobuf.Namespace._configure(protobuf.Type, protobuf.Service, protobuf.Enum);
	protobuf.Root._configure(protobuf.Type);
	protobuf.Field._configure(protobuf.Type);
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/tokenize.js
var require_tokenize = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = tokenize;
	var delimRe = /[\s{}=;:[\],'"()<>]/g, stringDoubleRe = /(?:"([^"\\]*(?:\\.[^"\\]*)*)")/g, stringSingleRe = /(?:'([^'\\]*(?:\\.[^'\\]*)*)')/g;
	var setCommentRe = /^ *[*/]+ */, setCommentAltRe = /^\s*\*?\/*/, setCommentSplitRe = /\n/g, whitespaceRe = /\s/, unescapeRe = /\\(.?)/g;
	var unescapeMap = {
		"0": "\0",
		"r": "\r",
		"n": "\n",
		"t": "	"
	};
	/**
	* Unescapes a string.
	* @param {string} str String to unescape
	* @returns {string} Unescaped string
	* @property {Object.<string,string>} map Special characters map
	* @memberof tokenize
	*/
	function unescape(str) {
		return str.replace(unescapeRe, function($0, $1) {
			switch ($1) {
				case "\\":
				case "": return $1;
				default: return unescapeMap[$1] || "";
			}
		});
	}
	tokenize.unescape = unescape;
	/**
	* Gets the next token and advances.
	* @typedef TokenizerHandleNext
	* @type {function}
	* @returns {string|null} Next token or `null` on eof
	*/
	/**
	* Peeks for the next token.
	* @typedef TokenizerHandlePeek
	* @type {function}
	* @returns {string|null} Next token or `null` on eof
	*/
	/**
	* Pushes a token back to the stack.
	* @typedef TokenizerHandlePush
	* @type {function}
	* @param {string} token Token
	* @returns {undefined}
	*/
	/**
	* Skips the next token.
	* @typedef TokenizerHandleSkip
	* @type {function}
	* @param {string} expected Expected token
	* @param {boolean} [optional=false] If optional
	* @returns {boolean} Whether the token matched
	* @throws {Error} If the token didn't match and is not optional
	*/
	/**
	* Gets the comment on the previous line or, alternatively, the line comment on the specified line.
	* @typedef TokenizerHandleCmnt
	* @type {function}
	* @param {number} [line] Line number
	* @returns {string|null} Comment text or `null` if none
	*/
	/**
	* Handle object returned from {@link tokenize}.
	* @interface ITokenizerHandle
	* @property {TokenizerHandleNext} next Gets the next token and advances (`null` on eof)
	* @property {TokenizerHandlePeek} peek Peeks for the next token (`null` on eof)
	* @property {TokenizerHandlePush} push Pushes a token back to the stack
	* @property {TokenizerHandleSkip} skip Skips a token, returns its presence and advances or, if non-optional and not present, throws
	* @property {TokenizerHandleCmnt} cmnt Gets the comment on the previous line or the line comment on the specified line, if any
	* @property {number} line Current line number
	*/
	/**
	* Tokenizes the given .proto source and returns an object with useful utility functions.
	* @param {string} source Source contents
	* @param {boolean} alternateCommentMode Whether we should activate alternate comment parsing mode.
	* @returns {ITokenizerHandle} Tokenizer handle
	*/
	function tokenize(source, alternateCommentMode) {
		source = source.toString();
		var offset = 0, length = source.length, line = 1, lastCommentLine = 0, comments = {};
		var stack = [];
		var stringDelim = null;
		/* istanbul ignore next */
		/**
		* Creates an error for illegal syntax.
		* @param {string} subject Subject
		* @returns {Error} Error created
		* @inner
		*/
		function illegal(subject) {
			return Error("illegal " + subject + " (line " + line + ")");
		}
		/**
		* Reads a string till its end.
		* @returns {string} String read
		* @inner
		*/
		function readString() {
			var re = stringDelim === "'" ? stringSingleRe : stringDoubleRe;
			re.lastIndex = offset - 1;
			var match = re.exec(source);
			if (!match) throw illegal("string");
			offset = re.lastIndex;
			push(stringDelim);
			stringDelim = null;
			return unescape(match[1]);
		}
		/**
		* Gets the character at `pos` within the source.
		* @param {number} pos Position
		* @returns {string} Character
		* @inner
		*/
		function charAt(pos) {
			return source.charAt(pos);
		}
		/**
		* Sets the current comment text.
		* @param {number} start Start offset
		* @param {number} end End offset
		* @param {boolean} isLeading set if a leading comment
		* @returns {undefined}
		* @inner
		*/
		function setComment(start, end, isLeading) {
			var comment = {
				type: source.charAt(start++),
				lineEmpty: false,
				leading: isLeading
			};
			var lookback;
			if (alternateCommentMode) lookback = 2;
			else lookback = 3;
			var commentOffset = start - lookback, c;
			do
				if (--commentOffset < 0 || (c = source.charAt(commentOffset)) === "\n") {
					comment.lineEmpty = true;
					break;
				}
			while (c === " " || c === "	");
			var lines = source.substring(start, end).split(setCommentSplitRe);
			for (var i = 0; i < lines.length; ++i) lines[i] = lines[i].replace(alternateCommentMode ? setCommentAltRe : setCommentRe, "").trim();
			comment.text = lines.join("\n").trim();
			comments[line] = comment;
			lastCommentLine = line;
		}
		function isDoubleSlashCommentLine(startOffset) {
			var endOffset = findEndOfLine(startOffset);
			var lineText = source.substring(startOffset, endOffset);
			return /^\s*\/\//.test(lineText);
		}
		function findEndOfLine(cursor) {
			var endOffset = cursor;
			while (endOffset < length && charAt(endOffset) !== "\n") endOffset++;
			return endOffset;
		}
		/**
		* Obtains the next token.
		* @returns {string|null} Next token or `null` on eof
		* @inner
		*/
		function next() {
			if (stack.length > 0) return stack.shift();
			if (stringDelim) return readString();
			var repeat, prev, curr, start, isDoc, isLeadingComment = offset === 0;
			do {
				if (offset === length) return null;
				repeat = false;
				while (whitespaceRe.test(curr = charAt(offset))) {
					if (curr === "\n") {
						isLeadingComment = true;
						++line;
					}
					if (++offset === length) return null;
				}
				if (charAt(offset) === "/") {
					if (++offset === length) throw illegal("comment");
					if (charAt(offset) === "/") if (!alternateCommentMode) {
						isDoc = charAt(start = offset + 1) === "/";
						while (charAt(++offset) !== "\n") if (offset === length) return null;
						++offset;
						if (isDoc) {
							setComment(start, offset - 1, isLeadingComment);
							isLeadingComment = true;
						}
						++line;
						repeat = true;
					} else {
						start = offset;
						isDoc = false;
						if (isDoubleSlashCommentLine(offset - 1)) {
							isDoc = true;
							do {
								offset = findEndOfLine(offset);
								if (offset === length) break;
								offset++;
								if (!isLeadingComment) break;
							} while (isDoubleSlashCommentLine(offset));
						} else offset = Math.min(length, findEndOfLine(offset) + 1);
						if (isDoc) {
							setComment(start, offset, isLeadingComment);
							isLeadingComment = true;
						}
						line++;
						repeat = true;
					}
					else if ((curr = charAt(offset)) === "*") {
						start = offset + 1;
						isDoc = alternateCommentMode || charAt(start) === "*";
						do {
							if (curr === "\n") ++line;
							if (++offset === length) throw illegal("comment");
							prev = curr;
							curr = charAt(offset);
						} while (prev !== "*" || curr !== "/");
						++offset;
						if (isDoc) {
							setComment(start, offset - 2, isLeadingComment);
							isLeadingComment = true;
						}
						repeat = true;
					} else return "/";
				}
			} while (repeat);
			var end = offset;
			delimRe.lastIndex = 0;
			if (!delimRe.test(charAt(end++))) while (end < length && !delimRe.test(charAt(end))) ++end;
			var token = source.substring(offset, offset = end);
			if (token === "\"" || token === "'") stringDelim = token;
			return token;
		}
		/**
		* Pushes a token back to the stack.
		* @param {string} token Token
		* @returns {undefined}
		* @inner
		*/
		function push(token) {
			stack.push(token);
		}
		/**
		* Peeks for the next token.
		* @returns {string|null} Token or `null` on eof
		* @inner
		*/
		function peek() {
			if (!stack.length) {
				var token = next();
				if (token === null) return null;
				push(token);
			}
			return stack[0];
		}
		/**
		* Skips a token.
		* @param {string} expected Expected token
		* @param {boolean} [optional=false] Whether the token is optional
		* @returns {boolean} `true` when skipped, `false` if not
		* @throws {Error} When a required token is not present
		* @inner
		*/
		function skip(expected, optional) {
			var actual = peek();
			if (actual === expected) {
				next();
				return true;
			}
			if (!optional) throw illegal("token '" + actual + "', '" + expected + "' expected");
			return false;
		}
		/**
		* Gets a comment.
		* @param {number} [trailingLine] Line number if looking for a trailing comment
		* @returns {string|null} Comment text
		* @inner
		*/
		function cmnt(trailingLine) {
			var ret = null;
			var comment;
			if (trailingLine === void 0) {
				comment = comments[line - 1];
				delete comments[line - 1];
				if (comment && (alternateCommentMode || comment.type === "*" || comment.lineEmpty)) ret = comment.leading ? comment.text : null;
			} else {
				/* istanbul ignore else */
				if (lastCommentLine < trailingLine) peek();
				comment = comments[trailingLine];
				delete comments[trailingLine];
				if (comment && !comment.lineEmpty && (alternateCommentMode || comment.type === "/")) ret = comment.leading ? null : comment.text;
			}
			return ret;
		}
		return Object.defineProperty({
			next,
			peek,
			push,
			skip,
			cmnt
		}, "line", { get: function() {
			return line;
		} });
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/parse.js
var require_parse = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = parse;
	parse.filename = null;
	parse.defaults = { keepCase: false };
	var tokenize = require_tokenize(), Root = require_root(), Type = require_type$1(), Field = require_field(), MapField = require_mapfield(), OneOf = require_oneof(), Enum = require_enum(), Service = require_service(), Method = require_method(), ReflectionObject = require_object(), types = require_types(), util = require_util$1();
	var base10Re = /^[1-9][0-9]*$/, base10NegRe = /^-?[1-9][0-9]*$/, base16Re = /^0[x][0-9a-fA-F]+$/, base16NegRe = /^-?0[x][0-9a-fA-F]+$/, base8Re = /^0[0-7]+$/, base8NegRe = /^-?0[0-7]+$/, numberRe = /^(?![eE])[0-9]*(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?$/, nameRe = /^[a-zA-Z_][a-zA-Z_0-9]*$/, typeRefRe = /^(?:\.?[a-zA-Z_][a-zA-Z_0-9]*)(?:\.[a-zA-Z_][a-zA-Z_0-9]*)*$/;
	/**
	* Result object returned from {@link parse}.
	* @interface IParserResult
	* @property {string|undefined} package Package name, if declared
	* @property {string[]|undefined} imports Imports, if any
	* @property {string[]|undefined} weakImports Weak imports, if any
	* @property {Root} root Populated root instance
	*/
	/**
	* Options modifying the behavior of {@link parse}.
	* @interface IParseOptions
	* @property {boolean} [keepCase=false] Keeps field casing instead of converting to camel case
	* @property {boolean} [alternateCommentMode=false] Recognize double-slash comments in addition to doc-block comments.
	* @property {boolean} [preferTrailingComment=false] Use trailing comment when both leading comment and trailing comment exist.
	*/
	/**
	* Options modifying the behavior of JSON serialization.
	* @interface IToJSONOptions
	* @property {boolean} [keepComments=false] Serializes comments.
	*/
	/**
	* Parses the given .proto source and returns an object with the parsed contents.
	* @param {string} source Source contents
	* @param {Root} root Root to populate
	* @param {IParseOptions} [options] Parse options. Defaults to {@link parse.defaults} when omitted.
	* @returns {IParserResult} Parser result
	* @property {string} filename=null Currently processing file name for error reporting, if known
	* @property {IParseOptions} defaults Default {@link IParseOptions}
	*/
	function parse(source, root, options) {
		if (!(root instanceof Root)) {
			options = root;
			root = new Root();
		}
		if (!options) options = parse.defaults;
		var preferTrailingComment = options.preferTrailingComment || false;
		var tn = tokenize(source, options.alternateCommentMode || false), next = tn.next, push = tn.push, peek = tn.peek, skip = tn.skip, cmnt = tn.cmnt;
		var head = true, pkg, imports, weakImports, edition = "proto2";
		var ptr = root;
		var topLevelObjects = [];
		var topLevelOptions = {};
		var applyCase = options.keepCase ? function(name) {
			return name;
		} : util.camelCase;
		function resolveFileFeatures() {
			topLevelObjects.forEach((obj) => {
				obj._edition = edition;
				Object.keys(topLevelOptions).forEach((opt) => {
					if (obj.getOption(opt) !== void 0) return;
					obj.setOption(opt, topLevelOptions[opt], true);
				});
			});
		}
		/* istanbul ignore next */
		function illegal(token, name, insideTryCatch) {
			var filename = parse.filename;
			if (!insideTryCatch) parse.filename = null;
			return Error("illegal " + (name || "token") + " '" + token + "' (" + (filename ? filename + ", " : "") + "line " + tn.line + ")");
		}
		function readString() {
			var values = [], token;
			do {
				/* istanbul ignore if */
				if ((token = next()) !== "\"" && token !== "'") throw illegal(token);
				values.push(next());
				skip(token);
				token = peek();
			} while (token === "\"" || token === "'");
			return values.join("");
		}
		function readValue(acceptTypeRef) {
			var token = next();
			switch (token) {
				case "'":
				case "\"":
					push(token);
					return readString();
				case "true":
				case "TRUE": return true;
				case "false":
				case "FALSE": return false;
			}
			try {
				return parseNumber(token, true);
			} catch (e) {
				/* istanbul ignore else */
				if (acceptTypeRef && typeRefRe.test(token)) return token;
				/* istanbul ignore next */
				throw illegal(token, "value");
			}
		}
		function readRanges(target, acceptStrings) {
			var token, start;
			do
				if (acceptStrings && ((token = peek()) === "\"" || token === "'")) {
					var str = readString();
					target.push(str);
					if (edition >= 2023) throw illegal(str, "id");
				} else try {
					target.push([start = parseId(next()), skip("to", true) ? parseId(next()) : start]);
				} catch (err) {
					if (acceptStrings && typeRefRe.test(token) && edition >= 2023) target.push(token);
					else throw err;
				}
			while (skip(",", true));
			var dummy = { options: void 0 };
			dummy.setOption = function(name, value) {
				if (this.options === void 0) this.options = {};
				this.options[name] = value;
			};
			ifBlock(dummy, function parseRange_block(token) {
				/* istanbul ignore else */
				if (token === "option") {
					parseOption(dummy, token);
					skip(";");
				} else throw illegal(token);
			}, function parseRange_line() {
				parseInlineOptions(dummy);
			});
		}
		function parseNumber(token, insideTryCatch) {
			var sign = 1;
			if (token.charAt(0) === "-") {
				sign = -1;
				token = token.substring(1);
			}
			switch (token) {
				case "inf":
				case "INF":
				case "Inf": return sign * Infinity;
				case "nan":
				case "NAN":
				case "Nan":
				case "NaN": return NaN;
				case "0": return 0;
			}
			if (base10Re.test(token)) return sign * parseInt(token, 10);
			if (base16Re.test(token)) return sign * parseInt(token, 16);
			if (base8Re.test(token)) return sign * parseInt(token, 8);
			/* istanbul ignore else */
			if (numberRe.test(token)) return sign * parseFloat(token);
			/* istanbul ignore next */
			throw illegal(token, "number", insideTryCatch);
		}
		function parseId(token, acceptNegative) {
			switch (token) {
				case "max":
				case "MAX":
				case "Max": return 536870911;
				case "0": return 0;
			}
			/* istanbul ignore if */
			if (!acceptNegative && token.charAt(0) === "-") throw illegal(token, "id");
			if (base10NegRe.test(token)) return parseInt(token, 10);
			if (base16NegRe.test(token)) return parseInt(token, 16);
			/* istanbul ignore else */
			if (base8NegRe.test(token)) return parseInt(token, 8);
			/* istanbul ignore next */
			throw illegal(token, "id");
		}
		function parsePackage() {
			/* istanbul ignore if */
			if (pkg !== void 0) throw illegal("package");
			pkg = next();
			/* istanbul ignore if */
			if (!typeRefRe.test(pkg)) throw illegal(pkg, "name");
			ptr = ptr.define(pkg);
			skip(";");
		}
		function parseImport() {
			var token = peek();
			var whichImports;
			switch (token) {
				case "weak":
					whichImports = weakImports || (weakImports = []);
					next();
					break;
				case "public": next();
				default:
					whichImports = imports || (imports = []);
					break;
			}
			token = readString();
			skip(";");
			whichImports.push(token);
		}
		function parseSyntax() {
			skip("=");
			edition = readString();
			/* istanbul ignore if */
			if (edition < 2023) throw illegal(edition, "syntax");
			skip(";");
		}
		function parseEdition() {
			skip("=");
			edition = readString();
			/* istanbul ignore if */
			if (!["2023"].includes(edition)) throw illegal(edition, "edition");
			skip(";");
		}
		function parseCommon(parent, token) {
			switch (token) {
				case "option":
					parseOption(parent, token);
					skip(";");
					return true;
				case "message":
					parseType(parent, token);
					return true;
				case "enum":
					parseEnum(parent, token);
					return true;
				case "service":
					parseService(parent, token);
					return true;
				case "extend":
					parseExtension(parent, token);
					return true;
			}
			return false;
		}
		function ifBlock(obj, fnIf, fnElse) {
			var trailingLine = tn.line;
			if (obj) {
				if (typeof obj.comment !== "string") obj.comment = cmnt();
				obj.filename = parse.filename;
			}
			if (skip("{", true)) {
				var token;
				while ((token = next()) !== "}") fnIf(token);
				skip(";", true);
			} else {
				if (fnElse) fnElse();
				skip(";");
				if (obj && (typeof obj.comment !== "string" || preferTrailingComment)) obj.comment = cmnt(trailingLine) || obj.comment;
			}
		}
		function parseType(parent, token) {
			/* istanbul ignore if */
			if (!nameRe.test(token = next())) throw illegal(token, "type name");
			var type = new Type(token);
			ifBlock(type, function parseType_block(token) {
				if (parseCommon(type, token)) return;
				switch (token) {
					case "map":
						parseMapField(type, token);
						break;
					case "required": if (edition !== "proto2") throw illegal(token);
					case "repeated":
						parseField(type, token);
						break;
					case "optional":
						/* istanbul ignore if */
						if (edition === "proto3") parseField(type, "proto3_optional");
						else if (edition !== "proto2") throw illegal(token);
						else parseField(type, "optional");
						break;
					case "oneof":
						parseOneOf(type, token);
						break;
					case "extensions":
						readRanges(type.extensions || (type.extensions = []));
						break;
					case "reserved":
						readRanges(type.reserved || (type.reserved = []), true);
						break;
					default:
						/* istanbul ignore if */
						if (edition === "proto2" || !typeRefRe.test(token)) throw illegal(token);
						push(token);
						parseField(type, "optional");
						break;
				}
			});
			parent.add(type);
			if (parent === ptr) topLevelObjects.push(type);
		}
		function parseField(parent, rule, extend) {
			var type = next();
			if (type === "group") {
				parseGroup(parent, rule);
				return;
			}
			while (type.endsWith(".") || peek().startsWith(".")) type += next();
			/* istanbul ignore if */
			if (!typeRefRe.test(type)) throw illegal(type, "type");
			var name = next();
			/* istanbul ignore if */
			if (!nameRe.test(name)) throw illegal(name, "name");
			name = applyCase(name);
			skip("=");
			var field = new Field(name, parseId(next()), type, rule, extend);
			ifBlock(field, function parseField_block(token) {
				/* istanbul ignore else */
				if (token === "option") {
					parseOption(field, token);
					skip(";");
				} else throw illegal(token);
			}, function parseField_line() {
				parseInlineOptions(field);
			});
			if (rule === "proto3_optional") {
				var oneof = new OneOf("_" + name);
				field.setOption("proto3_optional", true);
				oneof.add(field);
				parent.add(oneof);
			} else parent.add(field);
			if (parent === ptr) topLevelObjects.push(field);
		}
		function parseGroup(parent, rule) {
			if (edition >= 2023) throw illegal("group");
			var name = next();
			/* istanbul ignore if */
			if (!nameRe.test(name)) throw illegal(name, "name");
			var fieldName = util.lcFirst(name);
			if (name === fieldName) name = util.ucFirst(name);
			skip("=");
			var id = parseId(next());
			var type = new Type(name);
			type.group = true;
			var field = new Field(fieldName, id, name, rule);
			field.filename = parse.filename;
			ifBlock(type, function parseGroup_block(token) {
				switch (token) {
					case "option":
						parseOption(type, token);
						skip(";");
						break;
					case "required":
					case "repeated":
						parseField(type, token);
						break;
					case "optional":
						/* istanbul ignore if */
						if (edition === "proto3") parseField(type, "proto3_optional");
						else parseField(type, "optional");
						break;
					case "message":
						parseType(type, token);
						break;
					case "enum":
						parseEnum(type, token);
						break;
					case "reserved":
						readRanges(type.reserved || (type.reserved = []), true);
						break;
					default: throw illegal(token);
				}
			});
			parent.add(type).add(field);
		}
		function parseMapField(parent) {
			skip("<");
			var keyType = next();
			/* istanbul ignore if */
			if (types.mapKey[keyType] === void 0) throw illegal(keyType, "type");
			skip(",");
			var valueType = next();
			/* istanbul ignore if */
			if (!typeRefRe.test(valueType)) throw illegal(valueType, "type");
			skip(">");
			var name = next();
			/* istanbul ignore if */
			if (!nameRe.test(name)) throw illegal(name, "name");
			skip("=");
			var field = new MapField(applyCase(name), parseId(next()), keyType, valueType);
			ifBlock(field, function parseMapField_block(token) {
				/* istanbul ignore else */
				if (token === "option") {
					parseOption(field, token);
					skip(";");
				} else throw illegal(token);
			}, function parseMapField_line() {
				parseInlineOptions(field);
			});
			parent.add(field);
		}
		function parseOneOf(parent, token) {
			/* istanbul ignore if */
			if (!nameRe.test(token = next())) throw illegal(token, "name");
			var oneof = new OneOf(applyCase(token));
			ifBlock(oneof, function parseOneOf_block(token) {
				if (token === "option") {
					parseOption(oneof, token);
					skip(";");
				} else {
					push(token);
					parseField(oneof, "optional");
				}
			});
			parent.add(oneof);
		}
		function parseEnum(parent, token) {
			/* istanbul ignore if */
			if (!nameRe.test(token = next())) throw illegal(token, "name");
			var enm = new Enum(token);
			ifBlock(enm, function parseEnum_block(token) {
				switch (token) {
					case "option":
						parseOption(enm, token);
						skip(";");
						break;
					case "reserved":
						readRanges(enm.reserved || (enm.reserved = []), true);
						if (enm.reserved === void 0) enm.reserved = [];
						break;
					default: parseEnumValue(enm, token);
				}
			});
			parent.add(enm);
			if (parent === ptr) topLevelObjects.push(enm);
		}
		function parseEnumValue(parent, token) {
			/* istanbul ignore if */
			if (!nameRe.test(token)) throw illegal(token, "name");
			skip("=");
			var value = parseId(next(), true), dummy = { options: void 0 };
			dummy.getOption = function(name) {
				return this.options[name];
			};
			dummy.setOption = function(name, value) {
				ReflectionObject.prototype.setOption.call(dummy, name, value);
			};
			dummy.setParsedOption = function() {};
			ifBlock(dummy, function parseEnumValue_block(token) {
				/* istanbul ignore else */
				if (token === "option") {
					parseOption(dummy, token);
					skip(";");
				} else throw illegal(token);
			}, function parseEnumValue_line() {
				parseInlineOptions(dummy);
			});
			parent.add(token, value, dummy.comment, dummy.parsedOptions || dummy.options);
		}
		function parseOption(parent, token) {
			var option;
			var propName;
			var isOption = true;
			if (token === "option") token = next();
			while (token !== "=") {
				if (token === "(") {
					var parensValue = next();
					skip(")");
					token = "(" + parensValue + ")";
				}
				if (isOption) {
					isOption = false;
					if (token.includes(".") && !token.includes("(")) {
						var tokens = token.split(".");
						option = tokens[0] + ".";
						token = tokens[1];
						continue;
					}
					option = token;
				} else propName = propName ? propName += token : token;
				token = next();
			}
			var optionValue = parseOptionValue(parent, propName ? option.concat(propName) : option);
			propName = propName && propName[0] === "." ? propName.slice(1) : propName;
			option = option && option[option.length - 1] === "." ? option.slice(0, -1) : option;
			setParsedOption(parent, option, optionValue, propName);
		}
		function parseOptionValue(parent, name) {
			if (skip("{", true)) {
				var objectResult = {};
				while (!skip("}", true)) {
					/* istanbul ignore if */
					if (!nameRe.test(token = next())) throw illegal(token, "name");
					if (token === null) throw illegal(token, "end of input");
					var value;
					var propName = token;
					skip(":", true);
					if (peek() === "{") value = parseOptionValue(parent, name + "." + token);
					else if (peek() === "[") {
						value = [];
						var lastValue;
						if (skip("[", true)) {
							do {
								lastValue = readValue(true);
								value.push(lastValue);
							} while (skip(",", true));
							skip("]");
							if (typeof lastValue !== "undefined") setOption(parent, name + "." + token, lastValue);
						}
					} else {
						value = readValue(true);
						setOption(parent, name + "." + token, value);
					}
					var prevValue = objectResult[propName];
					if (prevValue) value = [].concat(prevValue).concat(value);
					objectResult[propName] = value;
					skip(",", true);
					skip(";", true);
				}
				return objectResult;
			}
			var simpleValue = readValue(true);
			setOption(parent, name, simpleValue);
			return simpleValue;
		}
		function setOption(parent, name, value) {
			if (ptr === parent && /^features\./.test(name)) {
				topLevelOptions[name] = value;
				return;
			}
			if (parent.setOption) parent.setOption(name, value);
		}
		function setParsedOption(parent, name, value, propName) {
			if (parent.setParsedOption) parent.setParsedOption(name, value, propName);
		}
		function parseInlineOptions(parent) {
			if (skip("[", true)) {
				do
					parseOption(parent, "option");
				while (skip(",", true));
				skip("]");
			}
			return parent;
		}
		function parseService(parent, token) {
			/* istanbul ignore if */
			if (!nameRe.test(token = next())) throw illegal(token, "service name");
			var service = new Service(token);
			ifBlock(service, function parseService_block(token) {
				if (parseCommon(service, token)) return;
				/* istanbul ignore else */
				if (token === "rpc") parseMethod(service, token);
				else throw illegal(token);
			});
			parent.add(service);
			if (parent === ptr) topLevelObjects.push(service);
		}
		function parseMethod(parent, token) {
			var commentText = cmnt();
			var type = token;
			/* istanbul ignore if */
			if (!nameRe.test(token = next())) throw illegal(token, "name");
			var name = token, requestType, requestStream, responseType, responseStream;
			skip("(");
			if (skip("stream", true)) requestStream = true;
			/* istanbul ignore if */
			if (!typeRefRe.test(token = next())) throw illegal(token);
			requestType = token;
			skip(")");
			skip("returns");
			skip("(");
			if (skip("stream", true)) responseStream = true;
			/* istanbul ignore if */
			if (!typeRefRe.test(token = next())) throw illegal(token);
			responseType = token;
			skip(")");
			var method = new Method(name, type, requestType, responseType, requestStream, responseStream);
			method.comment = commentText;
			ifBlock(method, function parseMethod_block(token) {
				/* istanbul ignore else */
				if (token === "option") {
					parseOption(method, token);
					skip(";");
				} else throw illegal(token);
			});
			parent.add(method);
		}
		function parseExtension(parent, token) {
			/* istanbul ignore if */
			if (!typeRefRe.test(token = next())) throw illegal(token, "reference");
			var reference = token;
			ifBlock(null, function parseExtension_block(token) {
				switch (token) {
					case "required":
					case "repeated":
						parseField(parent, token, reference);
						break;
					case "optional":
						/* istanbul ignore if */
						if (edition === "proto3") parseField(parent, "proto3_optional", reference);
						else parseField(parent, "optional", reference);
						break;
					default:
						/* istanbul ignore if */
						if (edition === "proto2" || !typeRefRe.test(token)) throw illegal(token);
						push(token);
						parseField(parent, "optional", reference);
						break;
				}
			});
		}
		var token;
		while ((token = next()) !== null) switch (token) {
			case "package":
				/* istanbul ignore if */
				if (!head) throw illegal(token);
				parsePackage();
				break;
			case "import":
				/* istanbul ignore if */
				if (!head) throw illegal(token);
				parseImport();
				break;
			case "syntax":
				/* istanbul ignore if */
				if (!head) throw illegal(token);
				parseSyntax();
				break;
			case "edition":
				/* istanbul ignore if */
				if (!head) throw illegal(token);
				parseEdition();
				break;
			case "option":
				parseOption(ptr, token);
				skip(";", true);
				break;
			default:
				/* istanbul ignore else */
				if (parseCommon(ptr, token)) {
					head = false;
					continue;
				}
				/* istanbul ignore next */
				throw illegal(token);
		}
		resolveFileFeatures();
		parse.filename = null;
		return {
			"package": pkg,
			"imports": imports,
			weakImports,
			root
		};
	}
}));
/**
* Parses the given .proto source and returns an object with the parsed contents.
* @name parse
* @function
* @param {string} source Source contents
* @param {IParseOptions} [options] Parse options. Defaults to {@link parse.defaults} when omitted.
* @returns {IParserResult} Parser result
* @property {string} filename=null Currently processing file name for error reporting, if known
* @property {IParseOptions} defaults Default {@link IParseOptions}
* @variation 2
*/
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/common.js
var require_common = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = common;
	var commonRe = /\/|\./;
	/**
	* Provides common type definitions.
	* Can also be used to provide additional google types or your own custom types.
	* @param {string} name Short name as in `google/protobuf/[name].proto` or full file name
	* @param {Object.<string,*>} json JSON definition within `google.protobuf` if a short name, otherwise the file's root definition
	* @returns {undefined}
	* @property {INamespace} google/protobuf/any.proto Any
	* @property {INamespace} google/protobuf/duration.proto Duration
	* @property {INamespace} google/protobuf/empty.proto Empty
	* @property {INamespace} google/protobuf/field_mask.proto FieldMask
	* @property {INamespace} google/protobuf/struct.proto Struct, Value, NullValue and ListValue
	* @property {INamespace} google/protobuf/timestamp.proto Timestamp
	* @property {INamespace} google/protobuf/wrappers.proto Wrappers
	* @example
	* // manually provides descriptor.proto (assumes google/protobuf/ namespace and .proto extension)
	* protobuf.common("descriptor", descriptorJson);
	*
	* // manually provides a custom definition (uses my.foo namespace)
	* protobuf.common("my/foo/bar.proto", myFooBarJson);
	*/
	function common(name, json) {
		if (!commonRe.test(name)) {
			name = "google/protobuf/" + name + ".proto";
			json = { nested: { google: { nested: { protobuf: { nested: json } } } } };
		}
		common[name] = json;
	}
	common("any", { Any: { fields: {
		type_url: {
			type: "string",
			id: 1
		},
		value: {
			type: "bytes",
			id: 2
		}
	} } });
	var timeType;
	common("duration", { Duration: timeType = { fields: {
		seconds: {
			type: "int64",
			id: 1
		},
		nanos: {
			type: "int32",
			id: 2
		}
	} } });
	common("timestamp", { Timestamp: timeType });
	common("empty", { Empty: { fields: {} } });
	common("struct", {
		Struct: { fields: { fields: {
			keyType: "string",
			type: "Value",
			id: 1
		} } },
		Value: {
			oneofs: { kind: { oneof: [
				"nullValue",
				"numberValue",
				"stringValue",
				"boolValue",
				"structValue",
				"listValue"
			] } },
			fields: {
				nullValue: {
					type: "NullValue",
					id: 1
				},
				numberValue: {
					type: "double",
					id: 2
				},
				stringValue: {
					type: "string",
					id: 3
				},
				boolValue: {
					type: "bool",
					id: 4
				},
				structValue: {
					type: "Struct",
					id: 5
				},
				listValue: {
					type: "ListValue",
					id: 6
				}
			}
		},
		NullValue: { values: { NULL_VALUE: 0 } },
		ListValue: { fields: { values: {
			rule: "repeated",
			type: "Value",
			id: 1
		} } }
	});
	common("wrappers", {
		DoubleValue: { fields: { value: {
			type: "double",
			id: 1
		} } },
		FloatValue: { fields: { value: {
			type: "float",
			id: 1
		} } },
		Int64Value: { fields: { value: {
			type: "int64",
			id: 1
		} } },
		UInt64Value: { fields: { value: {
			type: "uint64",
			id: 1
		} } },
		Int32Value: { fields: { value: {
			type: "int32",
			id: 1
		} } },
		UInt32Value: { fields: { value: {
			type: "uint32",
			id: 1
		} } },
		BoolValue: { fields: { value: {
			type: "bool",
			id: 1
		} } },
		StringValue: { fields: { value: {
			type: "string",
			id: 1
		} } },
		BytesValue: { fields: { value: {
			type: "bytes",
			id: 1
		} } }
	});
	common("field_mask", { FieldMask: { fields: { paths: {
		rule: "repeated",
		type: "string",
		id: 1
	} } } });
	/**
	* Gets the root definition of the specified common proto file.
	*
	* Bundled definitions are:
	* - google/protobuf/any.proto
	* - google/protobuf/duration.proto
	* - google/protobuf/empty.proto
	* - google/protobuf/field_mask.proto
	* - google/protobuf/struct.proto
	* - google/protobuf/timestamp.proto
	* - google/protobuf/wrappers.proto
	*
	* @param {string} file Proto file name
	* @returns {INamespace|null} Root definition or `null` if not defined
	*/
	common.get = function get(file) {
		return common[file] || null;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/src/index.js
var require_src$2 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var protobuf = module.exports = require_index_light();
	protobuf.build = "full";
	protobuf.tokenize = require_tokenize();
	protobuf.parse = require_parse();
	protobuf.common = require_common();
	protobuf.Root._configure(protobuf.Type, protobuf.parse, protobuf.common);
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/index.js
var require_protobufjs = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_src$2();
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/google/protobuf/descriptor.json
var require_descriptor$1 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = { "nested": { "google": { "nested": { "protobuf": {
		"options": {
			"go_package": "google.golang.org/protobuf/types/descriptorpb",
			"java_package": "com.google.protobuf",
			"java_outer_classname": "DescriptorProtos",
			"csharp_namespace": "Google.Protobuf.Reflection",
			"objc_class_prefix": "GPB",
			"cc_enable_arenas": true,
			"optimize_for": "SPEED"
		},
		"nested": {
			"FileDescriptorSet": {
				"edition": "proto2",
				"fields": { "file": {
					"rule": "repeated",
					"type": "FileDescriptorProto",
					"id": 1
				} },
				"extensions": [[536e6, 536e6]]
			},
			"Edition": {
				"edition": "proto2",
				"values": {
					"EDITION_UNKNOWN": 0,
					"EDITION_LEGACY": 900,
					"EDITION_PROTO2": 998,
					"EDITION_PROTO3": 999,
					"EDITION_2023": 1e3,
					"EDITION_2024": 1001,
					"EDITION_1_TEST_ONLY": 1,
					"EDITION_2_TEST_ONLY": 2,
					"EDITION_99997_TEST_ONLY": 99997,
					"EDITION_99998_TEST_ONLY": 99998,
					"EDITION_99999_TEST_ONLY": 99999,
					"EDITION_MAX": 2147483647
				}
			},
			"FileDescriptorProto": {
				"edition": "proto2",
				"fields": {
					"name": {
						"type": "string",
						"id": 1
					},
					"package": {
						"type": "string",
						"id": 2
					},
					"dependency": {
						"rule": "repeated",
						"type": "string",
						"id": 3
					},
					"publicDependency": {
						"rule": "repeated",
						"type": "int32",
						"id": 10
					},
					"weakDependency": {
						"rule": "repeated",
						"type": "int32",
						"id": 11
					},
					"optionDependency": {
						"rule": "repeated",
						"type": "string",
						"id": 15
					},
					"messageType": {
						"rule": "repeated",
						"type": "DescriptorProto",
						"id": 4
					},
					"enumType": {
						"rule": "repeated",
						"type": "EnumDescriptorProto",
						"id": 5
					},
					"service": {
						"rule": "repeated",
						"type": "ServiceDescriptorProto",
						"id": 6
					},
					"extension": {
						"rule": "repeated",
						"type": "FieldDescriptorProto",
						"id": 7
					},
					"options": {
						"type": "FileOptions",
						"id": 8
					},
					"sourceCodeInfo": {
						"type": "SourceCodeInfo",
						"id": 9
					},
					"syntax": {
						"type": "string",
						"id": 12
					},
					"edition": {
						"type": "Edition",
						"id": 14
					}
				}
			},
			"DescriptorProto": {
				"edition": "proto2",
				"fields": {
					"name": {
						"type": "string",
						"id": 1
					},
					"field": {
						"rule": "repeated",
						"type": "FieldDescriptorProto",
						"id": 2
					},
					"extension": {
						"rule": "repeated",
						"type": "FieldDescriptorProto",
						"id": 6
					},
					"nestedType": {
						"rule": "repeated",
						"type": "DescriptorProto",
						"id": 3
					},
					"enumType": {
						"rule": "repeated",
						"type": "EnumDescriptorProto",
						"id": 4
					},
					"extensionRange": {
						"rule": "repeated",
						"type": "ExtensionRange",
						"id": 5
					},
					"oneofDecl": {
						"rule": "repeated",
						"type": "OneofDescriptorProto",
						"id": 8
					},
					"options": {
						"type": "MessageOptions",
						"id": 7
					},
					"reservedRange": {
						"rule": "repeated",
						"type": "ReservedRange",
						"id": 9
					},
					"reservedName": {
						"rule": "repeated",
						"type": "string",
						"id": 10
					},
					"visibility": {
						"type": "SymbolVisibility",
						"id": 11
					}
				},
				"nested": {
					"ExtensionRange": { "fields": {
						"start": {
							"type": "int32",
							"id": 1
						},
						"end": {
							"type": "int32",
							"id": 2
						},
						"options": {
							"type": "ExtensionRangeOptions",
							"id": 3
						}
					} },
					"ReservedRange": { "fields": {
						"start": {
							"type": "int32",
							"id": 1
						},
						"end": {
							"type": "int32",
							"id": 2
						}
					} }
				}
			},
			"ExtensionRangeOptions": {
				"edition": "proto2",
				"fields": {
					"uninterpretedOption": {
						"rule": "repeated",
						"type": "UninterpretedOption",
						"id": 999
					},
					"declaration": {
						"rule": "repeated",
						"type": "Declaration",
						"id": 2,
						"options": { "retention": "RETENTION_SOURCE" }
					},
					"features": {
						"type": "FeatureSet",
						"id": 50
					},
					"verification": {
						"type": "VerificationState",
						"id": 3,
						"options": {
							"default": "UNVERIFIED",
							"retention": "RETENTION_SOURCE"
						}
					}
				},
				"extensions": [[1e3, 536870911]],
				"nested": {
					"Declaration": {
						"fields": {
							"number": {
								"type": "int32",
								"id": 1
							},
							"fullName": {
								"type": "string",
								"id": 2
							},
							"type": {
								"type": "string",
								"id": 3
							},
							"reserved": {
								"type": "bool",
								"id": 5
							},
							"repeated": {
								"type": "bool",
								"id": 6
							}
						},
						"reserved": [[4, 4]]
					},
					"VerificationState": { "values": {
						"DECLARATION": 0,
						"UNVERIFIED": 1
					} }
				}
			},
			"FieldDescriptorProto": {
				"edition": "proto2",
				"fields": {
					"name": {
						"type": "string",
						"id": 1
					},
					"number": {
						"type": "int32",
						"id": 3
					},
					"label": {
						"type": "Label",
						"id": 4
					},
					"type": {
						"type": "Type",
						"id": 5
					},
					"typeName": {
						"type": "string",
						"id": 6
					},
					"extendee": {
						"type": "string",
						"id": 2
					},
					"defaultValue": {
						"type": "string",
						"id": 7
					},
					"oneofIndex": {
						"type": "int32",
						"id": 9
					},
					"jsonName": {
						"type": "string",
						"id": 10
					},
					"options": {
						"type": "FieldOptions",
						"id": 8
					},
					"proto3Optional": {
						"type": "bool",
						"id": 17
					}
				},
				"nested": {
					"Type": { "values": {
						"TYPE_DOUBLE": 1,
						"TYPE_FLOAT": 2,
						"TYPE_INT64": 3,
						"TYPE_UINT64": 4,
						"TYPE_INT32": 5,
						"TYPE_FIXED64": 6,
						"TYPE_FIXED32": 7,
						"TYPE_BOOL": 8,
						"TYPE_STRING": 9,
						"TYPE_GROUP": 10,
						"TYPE_MESSAGE": 11,
						"TYPE_BYTES": 12,
						"TYPE_UINT32": 13,
						"TYPE_ENUM": 14,
						"TYPE_SFIXED32": 15,
						"TYPE_SFIXED64": 16,
						"TYPE_SINT32": 17,
						"TYPE_SINT64": 18
					} },
					"Label": { "values": {
						"LABEL_OPTIONAL": 1,
						"LABEL_REPEATED": 3,
						"LABEL_REQUIRED": 2
					} }
				}
			},
			"OneofDescriptorProto": {
				"edition": "proto2",
				"fields": {
					"name": {
						"type": "string",
						"id": 1
					},
					"options": {
						"type": "OneofOptions",
						"id": 2
					}
				}
			},
			"EnumDescriptorProto": {
				"edition": "proto2",
				"fields": {
					"name": {
						"type": "string",
						"id": 1
					},
					"value": {
						"rule": "repeated",
						"type": "EnumValueDescriptorProto",
						"id": 2
					},
					"options": {
						"type": "EnumOptions",
						"id": 3
					},
					"reservedRange": {
						"rule": "repeated",
						"type": "EnumReservedRange",
						"id": 4
					},
					"reservedName": {
						"rule": "repeated",
						"type": "string",
						"id": 5
					},
					"visibility": {
						"type": "SymbolVisibility",
						"id": 6
					}
				},
				"nested": { "EnumReservedRange": { "fields": {
					"start": {
						"type": "int32",
						"id": 1
					},
					"end": {
						"type": "int32",
						"id": 2
					}
				} } }
			},
			"EnumValueDescriptorProto": {
				"edition": "proto2",
				"fields": {
					"name": {
						"type": "string",
						"id": 1
					},
					"number": {
						"type": "int32",
						"id": 2
					},
					"options": {
						"type": "EnumValueOptions",
						"id": 3
					}
				}
			},
			"ServiceDescriptorProto": {
				"edition": "proto2",
				"fields": {
					"name": {
						"type": "string",
						"id": 1
					},
					"method": {
						"rule": "repeated",
						"type": "MethodDescriptorProto",
						"id": 2
					},
					"options": {
						"type": "ServiceOptions",
						"id": 3
					}
				}
			},
			"MethodDescriptorProto": {
				"edition": "proto2",
				"fields": {
					"name": {
						"type": "string",
						"id": 1
					},
					"inputType": {
						"type": "string",
						"id": 2
					},
					"outputType": {
						"type": "string",
						"id": 3
					},
					"options": {
						"type": "MethodOptions",
						"id": 4
					},
					"clientStreaming": {
						"type": "bool",
						"id": 5
					},
					"serverStreaming": {
						"type": "bool",
						"id": 6
					}
				}
			},
			"FileOptions": {
				"edition": "proto2",
				"fields": {
					"javaPackage": {
						"type": "string",
						"id": 1
					},
					"javaOuterClassname": {
						"type": "string",
						"id": 8
					},
					"javaMultipleFiles": {
						"type": "bool",
						"id": 10
					},
					"javaGenerateEqualsAndHash": {
						"type": "bool",
						"id": 20,
						"options": { "deprecated": true }
					},
					"javaStringCheckUtf8": {
						"type": "bool",
						"id": 27
					},
					"optimizeFor": {
						"type": "OptimizeMode",
						"id": 9,
						"options": { "default": "SPEED" }
					},
					"goPackage": {
						"type": "string",
						"id": 11
					},
					"ccGenericServices": {
						"type": "bool",
						"id": 16
					},
					"javaGenericServices": {
						"type": "bool",
						"id": 17
					},
					"pyGenericServices": {
						"type": "bool",
						"id": 18
					},
					"deprecated": {
						"type": "bool",
						"id": 23
					},
					"ccEnableArenas": {
						"type": "bool",
						"id": 31,
						"options": { "default": true }
					},
					"objcClassPrefix": {
						"type": "string",
						"id": 36
					},
					"csharpNamespace": {
						"type": "string",
						"id": 37
					},
					"swiftPrefix": {
						"type": "string",
						"id": 39
					},
					"phpClassPrefix": {
						"type": "string",
						"id": 40
					},
					"phpNamespace": {
						"type": "string",
						"id": 41
					},
					"phpMetadataNamespace": {
						"type": "string",
						"id": 44
					},
					"rubyPackage": {
						"type": "string",
						"id": 45
					},
					"features": {
						"type": "FeatureSet",
						"id": 50
					},
					"uninterpretedOption": {
						"rule": "repeated",
						"type": "UninterpretedOption",
						"id": 999
					}
				},
				"extensions": [[1e3, 536870911]],
				"reserved": [
					[42, 42],
					[38, 38],
					"php_generic_services"
				],
				"nested": { "OptimizeMode": { "values": {
					"SPEED": 1,
					"CODE_SIZE": 2,
					"LITE_RUNTIME": 3
				} } }
			},
			"MessageOptions": {
				"edition": "proto2",
				"fields": {
					"messageSetWireFormat": {
						"type": "bool",
						"id": 1
					},
					"noStandardDescriptorAccessor": {
						"type": "bool",
						"id": 2
					},
					"deprecated": {
						"type": "bool",
						"id": 3
					},
					"mapEntry": {
						"type": "bool",
						"id": 7
					},
					"deprecatedLegacyJsonFieldConflicts": {
						"type": "bool",
						"id": 11,
						"options": { "deprecated": true }
					},
					"features": {
						"type": "FeatureSet",
						"id": 12
					},
					"uninterpretedOption": {
						"rule": "repeated",
						"type": "UninterpretedOption",
						"id": 999
					}
				},
				"extensions": [[1e3, 536870911]],
				"reserved": [
					[4, 4],
					[5, 5],
					[6, 6],
					[8, 8],
					[9, 9]
				]
			},
			"FieldOptions": {
				"edition": "proto2",
				"fields": {
					"ctype": {
						"type": "CType",
						"id": 1,
						"options": { "default": "STRING" }
					},
					"packed": {
						"type": "bool",
						"id": 2
					},
					"jstype": {
						"type": "JSType",
						"id": 6,
						"options": { "default": "JS_NORMAL" }
					},
					"lazy": {
						"type": "bool",
						"id": 5
					},
					"unverifiedLazy": {
						"type": "bool",
						"id": 15
					},
					"deprecated": {
						"type": "bool",
						"id": 3
					},
					"weak": {
						"type": "bool",
						"id": 10,
						"options": { "deprecated": true }
					},
					"debugRedact": {
						"type": "bool",
						"id": 16
					},
					"retention": {
						"type": "OptionRetention",
						"id": 17
					},
					"targets": {
						"rule": "repeated",
						"type": "OptionTargetType",
						"id": 19
					},
					"editionDefaults": {
						"rule": "repeated",
						"type": "EditionDefault",
						"id": 20
					},
					"features": {
						"type": "FeatureSet",
						"id": 21
					},
					"featureSupport": {
						"type": "FeatureSupport",
						"id": 22
					},
					"uninterpretedOption": {
						"rule": "repeated",
						"type": "UninterpretedOption",
						"id": 999
					}
				},
				"extensions": [[1e3, 536870911]],
				"reserved": [[4, 4], [18, 18]],
				"nested": {
					"CType": { "values": {
						"STRING": 0,
						"CORD": 1,
						"STRING_PIECE": 2
					} },
					"JSType": { "values": {
						"JS_NORMAL": 0,
						"JS_STRING": 1,
						"JS_NUMBER": 2
					} },
					"OptionRetention": { "values": {
						"RETENTION_UNKNOWN": 0,
						"RETENTION_RUNTIME": 1,
						"RETENTION_SOURCE": 2
					} },
					"OptionTargetType": { "values": {
						"TARGET_TYPE_UNKNOWN": 0,
						"TARGET_TYPE_FILE": 1,
						"TARGET_TYPE_EXTENSION_RANGE": 2,
						"TARGET_TYPE_MESSAGE": 3,
						"TARGET_TYPE_FIELD": 4,
						"TARGET_TYPE_ONEOF": 5,
						"TARGET_TYPE_ENUM": 6,
						"TARGET_TYPE_ENUM_ENTRY": 7,
						"TARGET_TYPE_SERVICE": 8,
						"TARGET_TYPE_METHOD": 9
					} },
					"EditionDefault": { "fields": {
						"edition": {
							"type": "Edition",
							"id": 3
						},
						"value": {
							"type": "string",
							"id": 2
						}
					} },
					"FeatureSupport": { "fields": {
						"editionIntroduced": {
							"type": "Edition",
							"id": 1
						},
						"editionDeprecated": {
							"type": "Edition",
							"id": 2
						},
						"deprecationWarning": {
							"type": "string",
							"id": 3
						},
						"editionRemoved": {
							"type": "Edition",
							"id": 4
						}
					} }
				}
			},
			"OneofOptions": {
				"edition": "proto2",
				"fields": {
					"features": {
						"type": "FeatureSet",
						"id": 1
					},
					"uninterpretedOption": {
						"rule": "repeated",
						"type": "UninterpretedOption",
						"id": 999
					}
				},
				"extensions": [[1e3, 536870911]]
			},
			"EnumOptions": {
				"edition": "proto2",
				"fields": {
					"allowAlias": {
						"type": "bool",
						"id": 2
					},
					"deprecated": {
						"type": "bool",
						"id": 3
					},
					"deprecatedLegacyJsonFieldConflicts": {
						"type": "bool",
						"id": 6,
						"options": { "deprecated": true }
					},
					"features": {
						"type": "FeatureSet",
						"id": 7
					},
					"uninterpretedOption": {
						"rule": "repeated",
						"type": "UninterpretedOption",
						"id": 999
					}
				},
				"extensions": [[1e3, 536870911]],
				"reserved": [[5, 5]]
			},
			"EnumValueOptions": {
				"edition": "proto2",
				"fields": {
					"deprecated": {
						"type": "bool",
						"id": 1
					},
					"features": {
						"type": "FeatureSet",
						"id": 2
					},
					"debugRedact": {
						"type": "bool",
						"id": 3
					},
					"featureSupport": {
						"type": "FieldOptions.FeatureSupport",
						"id": 4
					},
					"uninterpretedOption": {
						"rule": "repeated",
						"type": "UninterpretedOption",
						"id": 999
					}
				},
				"extensions": [[1e3, 536870911]]
			},
			"ServiceOptions": {
				"edition": "proto2",
				"fields": {
					"features": {
						"type": "FeatureSet",
						"id": 34
					},
					"deprecated": {
						"type": "bool",
						"id": 33
					},
					"uninterpretedOption": {
						"rule": "repeated",
						"type": "UninterpretedOption",
						"id": 999
					}
				},
				"extensions": [[1e3, 536870911]]
			},
			"MethodOptions": {
				"edition": "proto2",
				"fields": {
					"deprecated": {
						"type": "bool",
						"id": 33
					},
					"idempotencyLevel": {
						"type": "IdempotencyLevel",
						"id": 34,
						"options": { "default": "IDEMPOTENCY_UNKNOWN" }
					},
					"features": {
						"type": "FeatureSet",
						"id": 35
					},
					"uninterpretedOption": {
						"rule": "repeated",
						"type": "UninterpretedOption",
						"id": 999
					}
				},
				"extensions": [[1e3, 536870911]],
				"nested": { "IdempotencyLevel": { "values": {
					"IDEMPOTENCY_UNKNOWN": 0,
					"NO_SIDE_EFFECTS": 1,
					"IDEMPOTENT": 2
				} } }
			},
			"UninterpretedOption": {
				"edition": "proto2",
				"fields": {
					"name": {
						"rule": "repeated",
						"type": "NamePart",
						"id": 2
					},
					"identifierValue": {
						"type": "string",
						"id": 3
					},
					"positiveIntValue": {
						"type": "uint64",
						"id": 4
					},
					"negativeIntValue": {
						"type": "int64",
						"id": 5
					},
					"doubleValue": {
						"type": "double",
						"id": 6
					},
					"stringValue": {
						"type": "bytes",
						"id": 7
					},
					"aggregateValue": {
						"type": "string",
						"id": 8
					}
				},
				"nested": { "NamePart": { "fields": {
					"namePart": {
						"rule": "required",
						"type": "string",
						"id": 1
					},
					"isExtension": {
						"rule": "required",
						"type": "bool",
						"id": 2
					}
				} } }
			},
			"FeatureSet": {
				"edition": "proto2",
				"fields": {
					"fieldPresence": {
						"type": "FieldPresence",
						"id": 1,
						"options": {
							"retention": "RETENTION_RUNTIME",
							"targets": "TARGET_TYPE_FILE",
							"feature_support.edition_introduced": "EDITION_2023",
							"edition_defaults.edition": "EDITION_2023",
							"edition_defaults.value": "EXPLICIT"
						}
					},
					"enumType": {
						"type": "EnumType",
						"id": 2,
						"options": {
							"retention": "RETENTION_RUNTIME",
							"targets": "TARGET_TYPE_FILE",
							"feature_support.edition_introduced": "EDITION_2023",
							"edition_defaults.edition": "EDITION_PROTO3",
							"edition_defaults.value": "OPEN"
						}
					},
					"repeatedFieldEncoding": {
						"type": "RepeatedFieldEncoding",
						"id": 3,
						"options": {
							"retention": "RETENTION_RUNTIME",
							"targets": "TARGET_TYPE_FILE",
							"feature_support.edition_introduced": "EDITION_2023",
							"edition_defaults.edition": "EDITION_PROTO3",
							"edition_defaults.value": "PACKED"
						}
					},
					"utf8Validation": {
						"type": "Utf8Validation",
						"id": 4,
						"options": {
							"retention": "RETENTION_RUNTIME",
							"targets": "TARGET_TYPE_FILE",
							"feature_support.edition_introduced": "EDITION_2023",
							"edition_defaults.edition": "EDITION_PROTO3",
							"edition_defaults.value": "VERIFY"
						}
					},
					"messageEncoding": {
						"type": "MessageEncoding",
						"id": 5,
						"options": {
							"retention": "RETENTION_RUNTIME",
							"targets": "TARGET_TYPE_FILE",
							"feature_support.edition_introduced": "EDITION_2023",
							"edition_defaults.edition": "EDITION_LEGACY",
							"edition_defaults.value": "LENGTH_PREFIXED"
						}
					},
					"jsonFormat": {
						"type": "JsonFormat",
						"id": 6,
						"options": {
							"retention": "RETENTION_RUNTIME",
							"targets": "TARGET_TYPE_FILE",
							"feature_support.edition_introduced": "EDITION_2023",
							"edition_defaults.edition": "EDITION_PROTO3",
							"edition_defaults.value": "ALLOW"
						}
					},
					"enforceNamingStyle": {
						"type": "EnforceNamingStyle",
						"id": 7,
						"options": {
							"retention": "RETENTION_SOURCE",
							"targets": "TARGET_TYPE_METHOD",
							"feature_support.edition_introduced": "EDITION_2024",
							"edition_defaults.edition": "EDITION_2024",
							"edition_defaults.value": "STYLE2024"
						}
					},
					"defaultSymbolVisibility": {
						"type": "VisibilityFeature.DefaultSymbolVisibility",
						"id": 8,
						"options": {
							"retention": "RETENTION_SOURCE",
							"targets": "TARGET_TYPE_FILE",
							"feature_support.edition_introduced": "EDITION_2024",
							"edition_defaults.edition": "EDITION_2024",
							"edition_defaults.value": "EXPORT_TOP_LEVEL"
						}
					}
				},
				"extensions": [
					[1e3, 9994],
					[9995, 9999],
					[1e4, 1e4]
				],
				"reserved": [[999, 999]],
				"nested": {
					"FieldPresence": { "values": {
						"FIELD_PRESENCE_UNKNOWN": 0,
						"EXPLICIT": 1,
						"IMPLICIT": 2,
						"LEGACY_REQUIRED": 3
					} },
					"EnumType": { "values": {
						"ENUM_TYPE_UNKNOWN": 0,
						"OPEN": 1,
						"CLOSED": 2
					} },
					"RepeatedFieldEncoding": { "values": {
						"REPEATED_FIELD_ENCODING_UNKNOWN": 0,
						"PACKED": 1,
						"EXPANDED": 2
					} },
					"Utf8Validation": { "values": {
						"UTF8_VALIDATION_UNKNOWN": 0,
						"VERIFY": 2,
						"NONE": 3
					} },
					"MessageEncoding": { "values": {
						"MESSAGE_ENCODING_UNKNOWN": 0,
						"LENGTH_PREFIXED": 1,
						"DELIMITED": 2
					} },
					"JsonFormat": { "values": {
						"JSON_FORMAT_UNKNOWN": 0,
						"ALLOW": 1,
						"LEGACY_BEST_EFFORT": 2
					} },
					"EnforceNamingStyle": { "values": {
						"ENFORCE_NAMING_STYLE_UNKNOWN": 0,
						"STYLE2024": 1,
						"STYLE_LEGACY": 2
					} },
					"VisibilityFeature": {
						"fields": {},
						"reserved": [[1, 536870911]],
						"nested": { "DefaultSymbolVisibility": { "values": {
							"DEFAULT_SYMBOL_VISIBILITY_UNKNOWN": 0,
							"EXPORT_ALL": 1,
							"EXPORT_TOP_LEVEL": 2,
							"LOCAL_ALL": 3,
							"STRICT": 4
						} } }
					}
				}
			},
			"FeatureSetDefaults": {
				"edition": "proto2",
				"fields": {
					"defaults": {
						"rule": "repeated",
						"type": "FeatureSetEditionDefault",
						"id": 1
					},
					"minimumEdition": {
						"type": "Edition",
						"id": 4
					},
					"maximumEdition": {
						"type": "Edition",
						"id": 5
					}
				},
				"nested": { "FeatureSetEditionDefault": {
					"fields": {
						"edition": {
							"type": "Edition",
							"id": 3
						},
						"overridableFeatures": {
							"type": "FeatureSet",
							"id": 4
						},
						"fixedFeatures": {
							"type": "FeatureSet",
							"id": 5
						}
					},
					"reserved": [
						[1, 1],
						[2, 2],
						"features"
					]
				} }
			},
			"SourceCodeInfo": {
				"edition": "proto2",
				"fields": { "location": {
					"rule": "repeated",
					"type": "Location",
					"id": 1
				} },
				"extensions": [[536e6, 536e6]],
				"nested": { "Location": { "fields": {
					"path": {
						"rule": "repeated",
						"type": "int32",
						"id": 1,
						"options": { "packed": true }
					},
					"span": {
						"rule": "repeated",
						"type": "int32",
						"id": 2,
						"options": { "packed": true }
					},
					"leadingComments": {
						"type": "string",
						"id": 3
					},
					"trailingComments": {
						"type": "string",
						"id": 4
					},
					"leadingDetachedComments": {
						"rule": "repeated",
						"type": "string",
						"id": 6
					}
				} } }
			},
			"GeneratedCodeInfo": {
				"edition": "proto2",
				"fields": { "annotation": {
					"rule": "repeated",
					"type": "Annotation",
					"id": 1
				} },
				"nested": { "Annotation": {
					"fields": {
						"path": {
							"rule": "repeated",
							"type": "int32",
							"id": 1,
							"options": { "packed": true }
						},
						"sourceFile": {
							"type": "string",
							"id": 2
						},
						"begin": {
							"type": "int32",
							"id": 3
						},
						"end": {
							"type": "int32",
							"id": 4
						},
						"semantic": {
							"type": "Semantic",
							"id": 5
						}
					},
					"nested": { "Semantic": { "values": {
						"NONE": 0,
						"SET": 1,
						"ALIAS": 2
					} } }
				} }
			},
			"SymbolVisibility": {
				"edition": "proto2",
				"values": {
					"VISIBILITY_UNSET": 0,
					"VISIBILITY_LOCAL": 1,
					"VISIBILITY_EXPORT": 2
				}
			}
		}
	} } } } };
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/ext/descriptor/index.js
var require_descriptor = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var $protobuf = require_protobufjs();
	module.exports = exports = $protobuf.descriptor = $protobuf.Root.fromJSON(require_descriptor$1()).lookup(".google.protobuf");
	var Namespace = $protobuf.Namespace, Root = $protobuf.Root, Enum = $protobuf.Enum, Type = $protobuf.Type, Field = $protobuf.Field, MapField = $protobuf.MapField, OneOf = $protobuf.OneOf, Service = $protobuf.Service, Method = $protobuf.Method;
	/**
	* Properties of a FileDescriptorSet message.
	* @interface IFileDescriptorSet
	* @property {IFileDescriptorProto[]} file Files
	*/
	/**
	* Properties of a FileDescriptorProto message.
	* @interface IFileDescriptorProto
	* @property {string} [name] File name
	* @property {string} [package] Package
	* @property {*} [dependency] Not supported
	* @property {*} [publicDependency] Not supported
	* @property {*} [weakDependency] Not supported
	* @property {IDescriptorProto[]} [messageType] Nested message types
	* @property {IEnumDescriptorProto[]} [enumType] Nested enums
	* @property {IServiceDescriptorProto[]} [service] Nested services
	* @property {IFieldDescriptorProto[]} [extension] Nested extension fields
	* @property {IFileOptions} [options] Options
	* @property {*} [sourceCodeInfo] Not supported
	* @property {string} [syntax="proto2"] Syntax
	* @property {IEdition} [edition] Edition
	*/
	/**
	* Values of the Edition enum.
	* @typedef IEdition
	* @type {number}
	* @property {number} EDITION_UNKNOWN=0
	* @property {number} EDITION_LEGACY=900
	* @property {number} EDITION_PROTO2=998
	* @property {number} EDITION_PROTO3=999
	* @property {number} EDITION_2023=1000
	* @property {number} EDITION_2024=1001
	* @property {number} EDITION_1_TEST_ONLY=1
	* @property {number} EDITION_2_TEST_ONLY=2
	* @property {number} EDITION_99997_TEST_ONLY=99997
	* @property {number} EDITION_99998_TEST_ONLY=99998
	* @property {number} EDITION_99998_TEST_ONLY=99999
	* @property {number} EDITION_MAX=2147483647
	*/
	/**
	* Properties of a FileOptions message.
	* @interface IFileOptions
	* @property {string} [javaPackage]
	* @property {string} [javaOuterClassname]
	* @property {boolean} [javaMultipleFiles]
	* @property {boolean} [javaGenerateEqualsAndHash]
	* @property {boolean} [javaStringCheckUtf8]
	* @property {IFileOptionsOptimizeMode} [optimizeFor=1]
	* @property {string} [goPackage]
	* @property {boolean} [ccGenericServices]
	* @property {boolean} [javaGenericServices]
	* @property {boolean} [pyGenericServices]
	* @property {boolean} [deprecated]
	* @property {boolean} [ccEnableArenas]
	* @property {string} [objcClassPrefix]
	* @property {string} [csharpNamespace]
	*/
	/**
	* Values of he FileOptions.OptimizeMode enum.
	* @typedef IFileOptionsOptimizeMode
	* @type {number}
	* @property {number} SPEED=1
	* @property {number} CODE_SIZE=2
	* @property {number} LITE_RUNTIME=3
	*/
	/**
	* Creates a root from a descriptor set.
	* @param {IFileDescriptorSet|Reader|Uint8Array} descriptor Descriptor
	* @returns {Root} Root instance
	*/
	Root.fromDescriptor = function fromDescriptor(descriptor) {
		if (typeof descriptor.length === "number") descriptor = exports.FileDescriptorSet.decode(descriptor);
		var root = new Root();
		if (descriptor.file) {
			var fileDescriptor, filePackage;
			for (var j = 0, i; j < descriptor.file.length; ++j) {
				filePackage = root;
				if ((fileDescriptor = descriptor.file[j])["package"] && fileDescriptor["package"].length) filePackage = root.define(fileDescriptor["package"]);
				var edition = editionFromDescriptor(fileDescriptor);
				if (fileDescriptor.name && fileDescriptor.name.length) root.files.push(filePackage.filename = fileDescriptor.name);
				if (fileDescriptor.messageType) for (i = 0; i < fileDescriptor.messageType.length; ++i) filePackage.add(Type.fromDescriptor(fileDescriptor.messageType[i], edition));
				if (fileDescriptor.enumType) for (i = 0; i < fileDescriptor.enumType.length; ++i) filePackage.add(Enum.fromDescriptor(fileDescriptor.enumType[i], edition));
				if (fileDescriptor.extension) for (i = 0; i < fileDescriptor.extension.length; ++i) filePackage.add(Field.fromDescriptor(fileDescriptor.extension[i], edition));
				if (fileDescriptor.service) for (i = 0; i < fileDescriptor.service.length; ++i) filePackage.add(Service.fromDescriptor(fileDescriptor.service[i], edition));
				var opts = fromDescriptorOptions(fileDescriptor.options, exports.FileOptions);
				if (opts) {
					var ks = Object.keys(opts);
					for (i = 0; i < ks.length; ++i) filePackage.setOption(ks[i], opts[ks[i]]);
				}
			}
		}
		return root.resolveAll();
	};
	/**
	* Converts a root to a descriptor set.
	* @returns {Message<IFileDescriptorSet>} Descriptor
	* @param {string} [edition="proto2"] The syntax or edition to use
	*/
	Root.prototype.toDescriptor = function toDescriptor(edition) {
		var set = exports.FileDescriptorSet.create();
		Root_toDescriptorRecursive(this, set.file, edition);
		return set;
	};
	function Root_toDescriptorRecursive(ns, files, edition) {
		var file = exports.FileDescriptorProto.create({ name: ns.filename || (ns.fullName.substring(1).replace(/\./g, "_") || "root") + ".proto" });
		editionToDescriptor(edition, file);
		if (!(ns instanceof Root)) file["package"] = ns.fullName.substring(1);
		for (var i = 0, nested; i < ns.nestedArray.length; ++i) if ((nested = ns._nestedArray[i]) instanceof Type) file.messageType.push(nested.toDescriptor(edition));
		else if (nested instanceof Enum) file.enumType.push(nested.toDescriptor());
		else if (nested instanceof Field) file.extension.push(nested.toDescriptor(edition));
		else if (nested instanceof Service) file.service.push(nested.toDescriptor());
		else if (nested instanceof Namespace) Root_toDescriptorRecursive(nested, files, edition);
		file.options = toDescriptorOptions(ns.options, exports.FileOptions);
		if (file.messageType.length + file.enumType.length + file.extension.length + file.service.length) files.push(file);
	}
	/**
	* Properties of a DescriptorProto message.
	* @interface IDescriptorProto
	* @property {string} [name] Message type name
	* @property {IFieldDescriptorProto[]} [field] Fields
	* @property {IFieldDescriptorProto[]} [extension] Extension fields
	* @property {IDescriptorProto[]} [nestedType] Nested message types
	* @property {IEnumDescriptorProto[]} [enumType] Nested enums
	* @property {IDescriptorProtoExtensionRange[]} [extensionRange] Extension ranges
	* @property {IOneofDescriptorProto[]} [oneofDecl] Oneofs
	* @property {IMessageOptions} [options] Not supported
	* @property {IDescriptorProtoReservedRange[]} [reservedRange] Reserved ranges
	* @property {string[]} [reservedName] Reserved names
	*/
	/**
	* Properties of a MessageOptions message.
	* @interface IMessageOptions
	* @property {boolean} [mapEntry=false] Whether this message is a map entry
	*/
	/**
	* Properties of an ExtensionRange message.
	* @interface IDescriptorProtoExtensionRange
	* @property {number} [start] Start field id
	* @property {number} [end] End field id
	*/
	/**
	* Properties of a ReservedRange message.
	* @interface IDescriptorProtoReservedRange
	* @property {number} [start] Start field id
	* @property {number} [end] End field id
	*/
	var unnamedMessageIndex = 0;
	/**
	* Creates a type from a descriptor.
	*
	* Warning: this is not safe to use with editions protos, since it discards relevant file context.
	*
	* @param {IDescriptorProto|Reader|Uint8Array} descriptor Descriptor
	* @param {string} [edition="proto2"] The syntax or edition to use
	* @param {boolean} [nested=false] Whether or not this is a nested object
	* @returns {Type} Type instance
	*/
	Type.fromDescriptor = function fromDescriptor(descriptor, edition, nested) {
		if (typeof descriptor.length === "number") descriptor = exports.DescriptorProto.decode(descriptor);
		var type = new Type(descriptor.name.length ? descriptor.name : "Type" + unnamedMessageIndex++, fromDescriptorOptions(descriptor.options, exports.MessageOptions)), i;
		if (!nested) type._edition = edition;
		if (descriptor.oneofDecl) for (i = 0; i < descriptor.oneofDecl.length; ++i) type.add(OneOf.fromDescriptor(descriptor.oneofDecl[i]));
		if (descriptor.field) for (i = 0; i < descriptor.field.length; ++i) {
			var field = Field.fromDescriptor(descriptor.field[i], edition, true);
			type.add(field);
			if (descriptor.field[i].hasOwnProperty("oneofIndex")) type.oneofsArray[descriptor.field[i].oneofIndex].add(field);
		}
		if (descriptor.extension) for (i = 0; i < descriptor.extension.length; ++i) type.add(Field.fromDescriptor(descriptor.extension[i], edition, true));
		if (descriptor.nestedType) for (i = 0; i < descriptor.nestedType.length; ++i) {
			type.add(Type.fromDescriptor(descriptor.nestedType[i], edition, true));
			if (descriptor.nestedType[i].options && descriptor.nestedType[i].options.mapEntry) type.setOption("map_entry", true);
		}
		if (descriptor.enumType) for (i = 0; i < descriptor.enumType.length; ++i) type.add(Enum.fromDescriptor(descriptor.enumType[i], edition, true));
		if (descriptor.extensionRange && descriptor.extensionRange.length) {
			type.extensions = [];
			for (i = 0; i < descriptor.extensionRange.length; ++i) type.extensions.push([descriptor.extensionRange[i].start, descriptor.extensionRange[i].end]);
		}
		if (descriptor.reservedRange && descriptor.reservedRange.length || descriptor.reservedName && descriptor.reservedName.length) {
			type.reserved = [];
			if (descriptor.reservedRange) for (i = 0; i < descriptor.reservedRange.length; ++i) type.reserved.push([descriptor.reservedRange[i].start, descriptor.reservedRange[i].end]);
			if (descriptor.reservedName) for (i = 0; i < descriptor.reservedName.length; ++i) type.reserved.push(descriptor.reservedName[i]);
		}
		return type;
	};
	/**
	* Converts a type to a descriptor.
	* @returns {Message<IDescriptorProto>} Descriptor
	* @param {string} [edition="proto2"] The syntax or edition to use
	*/
	Type.prototype.toDescriptor = function toDescriptor(edition) {
		var descriptor = exports.DescriptorProto.create({ name: this.name }), i;
		for (i = 0; i < this.fieldsArray.length; ++i) {
			var fieldDescriptor;
			descriptor.field.push(fieldDescriptor = this._fieldsArray[i].toDescriptor(edition));
			if (this._fieldsArray[i] instanceof MapField) {
				var keyType = toDescriptorType(this._fieldsArray[i].keyType, this._fieldsArray[i].resolvedKeyType, false), valueType = toDescriptorType(this._fieldsArray[i].type, this._fieldsArray[i].resolvedType, false), valueTypeName = valueType === 11 || valueType === 14 ? this._fieldsArray[i].resolvedType && shortname(this.parent, this._fieldsArray[i].resolvedType) || this._fieldsArray[i].type : void 0;
				descriptor.nestedType.push(exports.DescriptorProto.create({
					name: fieldDescriptor.typeName,
					field: [exports.FieldDescriptorProto.create({
						name: "key",
						number: 1,
						label: 1,
						type: keyType
					}), exports.FieldDescriptorProto.create({
						name: "value",
						number: 2,
						label: 1,
						type: valueType,
						typeName: valueTypeName
					})],
					options: exports.MessageOptions.create({ mapEntry: true })
				}));
			}
		}
		for (i = 0; i < this.oneofsArray.length; ++i) descriptor.oneofDecl.push(this._oneofsArray[i].toDescriptor());
		for (i = 0; i < this.nestedArray.length; ++i) if (this._nestedArray[i] instanceof Field) descriptor.field.push(this._nestedArray[i].toDescriptor(edition));
		else if (this._nestedArray[i] instanceof Type) descriptor.nestedType.push(this._nestedArray[i].toDescriptor(edition));
		else if (this._nestedArray[i] instanceof Enum) descriptor.enumType.push(this._nestedArray[i].toDescriptor());
		if (this.extensions) for (i = 0; i < this.extensions.length; ++i) descriptor.extensionRange.push(exports.DescriptorProto.ExtensionRange.create({
			start: this.extensions[i][0],
			end: this.extensions[i][1]
		}));
		if (this.reserved) for (i = 0; i < this.reserved.length; ++i) if (typeof this.reserved[i] === "string") descriptor.reservedName.push(this.reserved[i]);
		else descriptor.reservedRange.push(exports.DescriptorProto.ReservedRange.create({
			start: this.reserved[i][0],
			end: this.reserved[i][1]
		}));
		descriptor.options = toDescriptorOptions(this.options, exports.MessageOptions);
		return descriptor;
	};
	/**
	* Properties of a FieldDescriptorProto message.
	* @interface IFieldDescriptorProto
	* @property {string} [name] Field name
	* @property {number} [number] Field id
	* @property {IFieldDescriptorProtoLabel} [label] Field rule
	* @property {IFieldDescriptorProtoType} [type] Field basic type
	* @property {string} [typeName] Field type name
	* @property {string} [extendee] Extended type name
	* @property {string} [defaultValue] Literal default value
	* @property {number} [oneofIndex] Oneof index if part of a oneof
	* @property {*} [jsonName] Not supported
	* @property {IFieldOptions} [options] Field options
	*/
	/**
	* Values of the FieldDescriptorProto.Label enum.
	* @typedef IFieldDescriptorProtoLabel
	* @type {number}
	* @property {number} LABEL_OPTIONAL=1
	* @property {number} LABEL_REQUIRED=2
	* @property {number} LABEL_REPEATED=3
	*/
	/**
	* Values of the FieldDescriptorProto.Type enum.
	* @typedef IFieldDescriptorProtoType
	* @type {number}
	* @property {number} TYPE_DOUBLE=1
	* @property {number} TYPE_FLOAT=2
	* @property {number} TYPE_INT64=3
	* @property {number} TYPE_UINT64=4
	* @property {number} TYPE_INT32=5
	* @property {number} TYPE_FIXED64=6
	* @property {number} TYPE_FIXED32=7
	* @property {number} TYPE_BOOL=8
	* @property {number} TYPE_STRING=9
	* @property {number} TYPE_GROUP=10
	* @property {number} TYPE_MESSAGE=11
	* @property {number} TYPE_BYTES=12
	* @property {number} TYPE_UINT32=13
	* @property {number} TYPE_ENUM=14
	* @property {number} TYPE_SFIXED32=15
	* @property {number} TYPE_SFIXED64=16
	* @property {number} TYPE_SINT32=17
	* @property {number} TYPE_SINT64=18
	*/
	/**
	* Properties of a FieldOptions message.
	* @interface IFieldOptions
	* @property {boolean} [packed] Whether packed or not (defaults to `false` for proto2 and `true` for proto3)
	* @property {IFieldOptionsJSType} [jstype] JavaScript value type (not used by protobuf.js)
	*/
	/**
	* Values of the FieldOptions.JSType enum.
	* @typedef IFieldOptionsJSType
	* @type {number}
	* @property {number} JS_NORMAL=0
	* @property {number} JS_STRING=1
	* @property {number} JS_NUMBER=2
	*/
	var numberRe = /^(?![eE])[0-9]*(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?$/;
	/**
	* Creates a field from a descriptor.
	*
	* Warning: this is not safe to use with editions protos, since it discards relevant file context.
	*
	* @param {IFieldDescriptorProto|Reader|Uint8Array} descriptor Descriptor
	* @param {string} [edition="proto2"] The syntax or edition to use
	* @param {boolean} [nested=false] Whether or not this is a top-level object
	* @returns {Field} Field instance
	*/
	Field.fromDescriptor = function fromDescriptor(descriptor, edition, nested) {
		if (typeof descriptor.length === "number") descriptor = exports.DescriptorProto.decode(descriptor);
		if (typeof descriptor.number !== "number") throw Error("missing field id");
		var fieldType;
		if (descriptor.typeName && descriptor.typeName.length) fieldType = descriptor.typeName;
		else fieldType = fromDescriptorType(descriptor.type);
		var fieldRule;
		switch (descriptor.label) {
			case 1:
				fieldRule = void 0;
				break;
			case 2:
				fieldRule = "required";
				break;
			case 3:
				fieldRule = "repeated";
				break;
			default: throw Error("illegal label: " + descriptor.label);
		}
		var extendee = descriptor.extendee;
		if (descriptor.extendee !== void 0) extendee = extendee.length ? extendee : void 0;
		var field = new Field(descriptor.name.length ? descriptor.name : "field" + descriptor.number, descriptor.number, fieldType, fieldRule, extendee);
		if (!nested) field._edition = edition;
		field.options = fromDescriptorOptions(descriptor.options, exports.FieldOptions);
		if (descriptor.proto3_optional) field.options.proto3_optional = true;
		if (descriptor.defaultValue && descriptor.defaultValue.length) {
			var defaultValue = descriptor.defaultValue;
			switch (defaultValue) {
				case "true":
				case "TRUE":
					defaultValue = true;
					break;
				case "false":
				case "FALSE":
					defaultValue = false;
					break;
				default:
					if (numberRe.exec(defaultValue)) defaultValue = parseInt(defaultValue);
					break;
			}
			field.setOption("default", defaultValue);
		}
		if (packableDescriptorType(descriptor.type)) {
			if (edition === "proto3") {
				if (descriptor.options && !descriptor.options.packed) field.setOption("packed", false);
			} else if ((!edition || edition === "proto2") && descriptor.options && descriptor.options.packed) field.setOption("packed", true);
		}
		return field;
	};
	/**
	* Converts a field to a descriptor.
	* @returns {Message<IFieldDescriptorProto>} Descriptor
	* @param {string} [edition="proto2"] The syntax or edition to use
	*/
	Field.prototype.toDescriptor = function toDescriptor(edition) {
		var descriptor = exports.FieldDescriptorProto.create({
			name: this.name,
			number: this.id
		});
		if (this.map) {
			descriptor.type = 11;
			descriptor.typeName = $protobuf.util.ucFirst(this.name);
			descriptor.label = 3;
		} else {
			switch (descriptor.type = toDescriptorType(this.type, this.resolve().resolvedType, this.delimited)) {
				case 10:
				case 11:
				case 14:
					descriptor.typeName = this.resolvedType ? shortname(this.parent, this.resolvedType) : this.type;
					break;
			}
			if (this.rule === "repeated") descriptor.label = 3;
			else if (this.required && edition === "proto2") descriptor.label = 2;
			else descriptor.label = 1;
		}
		descriptor.extendee = this.extensionField ? this.extensionField.parent.fullName : this.extend;
		if (this.partOf) {
			if ((descriptor.oneofIndex = this.parent.oneofsArray.indexOf(this.partOf)) < 0) throw Error("missing oneof");
		}
		if (this.options) {
			descriptor.options = toDescriptorOptions(this.options, exports.FieldOptions);
			if (this.options["default"] != null) descriptor.defaultValue = String(this.options["default"]);
			if (this.options.proto3_optional) descriptor.proto3_optional = true;
		}
		if (edition === "proto3") {
			if (!this.packed) (descriptor.options || (descriptor.options = exports.FieldOptions.create())).packed = false;
		} else if ((!edition || edition === "proto2") && this.packed) (descriptor.options || (descriptor.options = exports.FieldOptions.create())).packed = true;
		return descriptor;
	};
	/**
	* Properties of an EnumDescriptorProto message.
	* @interface IEnumDescriptorProto
	* @property {string} [name] Enum name
	* @property {IEnumValueDescriptorProto[]} [value] Enum values
	* @property {IEnumOptions} [options] Enum options
	*/
	/**
	* Properties of an EnumValueDescriptorProto message.
	* @interface IEnumValueDescriptorProto
	* @property {string} [name] Name
	* @property {number} [number] Value
	* @property {*} [options] Not supported
	*/
	/**
	* Properties of an EnumOptions message.
	* @interface IEnumOptions
	* @property {boolean} [allowAlias] Whether aliases are allowed
	* @property {boolean} [deprecated]
	*/
	var unnamedEnumIndex = 0;
	/**
	* Creates an enum from a descriptor.
	*
	* Warning: this is not safe to use with editions protos, since it discards relevant file context.
	*
	* @param {IEnumDescriptorProto|Reader|Uint8Array} descriptor Descriptor
	* @param {string} [edition="proto2"] The syntax or edition to use
	* @param {boolean} [nested=false] Whether or not this is a top-level object
	* @returns {Enum} Enum instance
	*/
	Enum.fromDescriptor = function fromDescriptor(descriptor, edition, nested) {
		if (typeof descriptor.length === "number") descriptor = exports.EnumDescriptorProto.decode(descriptor);
		var values = {};
		if (descriptor.value) for (var i = 0; i < descriptor.value.length; ++i) {
			var name = descriptor.value[i].name, value = descriptor.value[i].number || 0;
			values[name && name.length ? name : "NAME" + value] = value;
		}
		var enm = new Enum(descriptor.name && descriptor.name.length ? descriptor.name : "Enum" + unnamedEnumIndex++, values, fromDescriptorOptions(descriptor.options, exports.EnumOptions));
		if (!nested) enm._edition = edition;
		return enm;
	};
	/**
	* Converts an enum to a descriptor.
	* @returns {Message<IEnumDescriptorProto>} Descriptor
	*/
	Enum.prototype.toDescriptor = function toDescriptor() {
		var values = [];
		for (var i = 0, ks = Object.keys(this.values); i < ks.length; ++i) values.push(exports.EnumValueDescriptorProto.create({
			name: ks[i],
			number: this.values[ks[i]]
		}));
		return exports.EnumDescriptorProto.create({
			name: this.name,
			value: values,
			options: toDescriptorOptions(this.options, exports.EnumOptions)
		});
	};
	/**
	* Properties of a OneofDescriptorProto message.
	* @interface IOneofDescriptorProto
	* @property {string} [name] Oneof name
	* @property {*} [options] Not supported
	*/
	var unnamedOneofIndex = 0;
	/**
	* Creates a oneof from a descriptor.
	*
	* Warning: this is not safe to use with editions protos, since it discards relevant file context.
	*
	* @param {IOneofDescriptorProto|Reader|Uint8Array} descriptor Descriptor
	* @returns {OneOf} OneOf instance
	*/
	OneOf.fromDescriptor = function fromDescriptor(descriptor) {
		if (typeof descriptor.length === "number") descriptor = exports.OneofDescriptorProto.decode(descriptor);
		return new OneOf(descriptor.name && descriptor.name.length ? descriptor.name : "oneof" + unnamedOneofIndex++);
	};
	/**
	* Converts a oneof to a descriptor.
	* @returns {Message<IOneofDescriptorProto>} Descriptor
	*/
	OneOf.prototype.toDescriptor = function toDescriptor() {
		return exports.OneofDescriptorProto.create({ name: this.name });
	};
	/**
	* Properties of a ServiceDescriptorProto message.
	* @interface IServiceDescriptorProto
	* @property {string} [name] Service name
	* @property {IMethodDescriptorProto[]} [method] Methods
	* @property {IServiceOptions} [options] Options
	*/
	/**
	* Properties of a ServiceOptions message.
	* @interface IServiceOptions
	* @property {boolean} [deprecated]
	*/
	var unnamedServiceIndex = 0;
	/**
	* Creates a service from a descriptor.
	*
	* Warning: this is not safe to use with editions protos, since it discards relevant file context.
	*
	* @param {IServiceDescriptorProto|Reader|Uint8Array} descriptor Descriptor
	* @param {string} [edition="proto2"] The syntax or edition to use
	* @param {boolean} [nested=false] Whether or not this is a top-level object
	* @returns {Service} Service instance
	*/
	Service.fromDescriptor = function fromDescriptor(descriptor, edition, nested) {
		if (typeof descriptor.length === "number") descriptor = exports.ServiceDescriptorProto.decode(descriptor);
		var service = new Service(descriptor.name && descriptor.name.length ? descriptor.name : "Service" + unnamedServiceIndex++, fromDescriptorOptions(descriptor.options, exports.ServiceOptions));
		if (!nested) service._edition = edition;
		if (descriptor.method) for (var i = 0; i < descriptor.method.length; ++i) service.add(Method.fromDescriptor(descriptor.method[i]));
		return service;
	};
	/**
	* Converts a service to a descriptor.
	* @returns {Message<IServiceDescriptorProto>} Descriptor
	*/
	Service.prototype.toDescriptor = function toDescriptor() {
		var methods = [];
		for (var i = 0; i < this.methodsArray.length; ++i) methods.push(this._methodsArray[i].toDescriptor());
		return exports.ServiceDescriptorProto.create({
			name: this.name,
			method: methods,
			options: toDescriptorOptions(this.options, exports.ServiceOptions)
		});
	};
	/**
	* Properties of a MethodDescriptorProto message.
	* @interface IMethodDescriptorProto
	* @property {string} [name] Method name
	* @property {string} [inputType] Request type name
	* @property {string} [outputType] Response type name
	* @property {IMethodOptions} [options] Not supported
	* @property {boolean} [clientStreaming=false] Whether requests are streamed
	* @property {boolean} [serverStreaming=false] Whether responses are streamed
	*/
	/**
	* Properties of a MethodOptions message.
	*
	* Warning: this is not safe to use with editions protos, since it discards relevant file context.
	*
	* @interface IMethodOptions
	* @property {boolean} [deprecated]
	*/
	var unnamedMethodIndex = 0;
	/**
	* Creates a method from a descriptor.
	* @param {IMethodDescriptorProto|Reader|Uint8Array} descriptor Descriptor
	* @returns {Method} Reflected method instance
	*/
	Method.fromDescriptor = function fromDescriptor(descriptor) {
		if (typeof descriptor.length === "number") descriptor = exports.MethodDescriptorProto.decode(descriptor);
		return new Method(descriptor.name && descriptor.name.length ? descriptor.name : "Method" + unnamedMethodIndex++, "rpc", descriptor.inputType, descriptor.outputType, Boolean(descriptor.clientStreaming), Boolean(descriptor.serverStreaming), fromDescriptorOptions(descriptor.options, exports.MethodOptions));
	};
	/**
	* Converts a method to a descriptor.
	* @returns {Message<IMethodDescriptorProto>} Descriptor
	*/
	Method.prototype.toDescriptor = function toDescriptor() {
		return exports.MethodDescriptorProto.create({
			name: this.name,
			inputType: this.resolvedRequestType ? this.resolvedRequestType.fullName : this.requestType,
			outputType: this.resolvedResponseType ? this.resolvedResponseType.fullName : this.responseType,
			clientStreaming: this.requestStream,
			serverStreaming: this.responseStream,
			options: toDescriptorOptions(this.options, exports.MethodOptions)
		});
	};
	function fromDescriptorType(type) {
		switch (type) {
			case 1: return "double";
			case 2: return "float";
			case 3: return "int64";
			case 4: return "uint64";
			case 5: return "int32";
			case 6: return "fixed64";
			case 7: return "fixed32";
			case 8: return "bool";
			case 9: return "string";
			case 12: return "bytes";
			case 13: return "uint32";
			case 15: return "sfixed32";
			case 16: return "sfixed64";
			case 17: return "sint32";
			case 18: return "sint64";
		}
		throw Error("illegal type: " + type);
	}
	function packableDescriptorType(type) {
		switch (type) {
			case 1:
			case 2:
			case 3:
			case 4:
			case 5:
			case 6:
			case 7:
			case 8:
			case 13:
			case 14:
			case 15:
			case 16:
			case 17:
			case 18: return true;
		}
		return false;
	}
	function toDescriptorType(type, resolvedType, delimited) {
		switch (type) {
			case "double": return 1;
			case "float": return 2;
			case "int64": return 3;
			case "uint64": return 4;
			case "int32": return 5;
			case "fixed64": return 6;
			case "fixed32": return 7;
			case "bool": return 8;
			case "string": return 9;
			case "bytes": return 12;
			case "uint32": return 13;
			case "sfixed32": return 15;
			case "sfixed64": return 16;
			case "sint32": return 17;
			case "sint64": return 18;
		}
		if (resolvedType instanceof Enum) return 14;
		if (resolvedType instanceof Type) return delimited ? 10 : 11;
		throw Error("illegal type: " + type);
	}
	function fromDescriptorOptionsRecursive(obj, type) {
		var val = {};
		for (var i = 0, field, key; i < type.fieldsArray.length; ++i) {
			if ((key = (field = type._fieldsArray[i]).name) === "uninterpretedOption") continue;
			if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
			var newKey = underScore(key);
			if (field.resolvedType instanceof Type) val[newKey] = fromDescriptorOptionsRecursive(obj[key], field.resolvedType);
			else if (field.resolvedType instanceof Enum) val[newKey] = field.resolvedType.valuesById[obj[key]];
			else val[newKey] = obj[key];
		}
		return val;
	}
	function fromDescriptorOptions(options, type) {
		if (!options) return void 0;
		return fromDescriptorOptionsRecursive(type.toObject(options), type);
	}
	function toDescriptorOptionsRecursive(obj, type) {
		var val = {};
		var keys = Object.keys(obj);
		for (var i = 0; i < keys.length; ++i) {
			var key = keys[i];
			var newKey = $protobuf.util.camelCase(key);
			if (!Object.prototype.hasOwnProperty.call(type.fields, newKey)) continue;
			var field = type.fields[newKey];
			if (field.resolvedType instanceof Type) val[newKey] = toDescriptorOptionsRecursive(obj[key], field.resolvedType);
			else val[newKey] = obj[key];
			if (field.repeated && !Array.isArray(val[newKey])) val[newKey] = [val[newKey]];
		}
		return val;
	}
	function toDescriptorOptions(options, type) {
		if (!options) return void 0;
		return type.fromObject(toDescriptorOptionsRecursive(options, type));
	}
	function shortname(from, to) {
		var fromPath = from.fullName.split("."), toPath = to.fullName.split("."), i = 0, j = 0, k = toPath.length - 1;
		if (!(from instanceof Root) && to instanceof Namespace) while (i < fromPath.length && j < k && fromPath[i] === toPath[j]) {
			var other = to.lookup(fromPath[i++], true);
			if (other !== null && other !== to) break;
			++j;
		}
		else for (; i < fromPath.length && j < k && fromPath[i] === toPath[j]; ++i, ++j);
		return toPath.slice(j).join(".");
	}
	function underScore(str) {
		return str.substring(0, 1) + str.substring(1).replace(/([A-Z])(?=[a-z]|$)/g, function($0, $1) {
			return "_" + $1.toLowerCase();
		});
	}
	function editionFromDescriptor(fileDescriptor) {
		if (fileDescriptor.syntax === "editions") switch (fileDescriptor.edition) {
			case exports.Edition.EDITION_2023: return "2023";
			default: throw new Error("Unsupported edition " + fileDescriptor.edition);
		}
		if (fileDescriptor.syntax === "proto3") return "proto3";
		return "proto2";
	}
	function editionToDescriptor(edition, fileDescriptor) {
		if (!edition) return;
		if (edition === "proto2" || edition === "proto3") fileDescriptor.syntax = edition;
		else {
			fileDescriptor.syntax = "editions";
			switch (edition) {
				case "2023":
					fileDescriptor.edition = exports.Edition.EDITION_2023;
					break;
				default: throw new Error("Unsupported edition " + edition);
			}
		}
	}
}));
/**
* Reflected file descriptor set.
* @name FileDescriptorSet
* @type {Type}
* @const
* @tstype $protobuf.Type
*/
/**
* Reflected file descriptor proto.
* @name FileDescriptorProto
* @type {Type}
* @const
* @tstype $protobuf.Type
*/
/**
* Reflected descriptor proto.
* @name DescriptorProto
* @type {Type}
* @property {Type} ExtensionRange
* @property {Type} ReservedRange
* @const
* @tstype $protobuf.Type & {
*     ExtensionRange: $protobuf.Type,
*     ReservedRange: $protobuf.Type
* }
*/
/**
* Reflected field descriptor proto.
* @name FieldDescriptorProto
* @type {Type}
* @property {Enum} Label
* @property {Enum} Type
* @const
* @tstype $protobuf.Type & {
*     Label: $protobuf.Enum,
*     Type: $protobuf.Enum
* }
*/
/**
* Reflected oneof descriptor proto.
* @name OneofDescriptorProto
* @type {Type}
* @const
* @tstype $protobuf.Type
*/
/**
* Reflected enum descriptor proto.
* @name EnumDescriptorProto
* @type {Type}
* @const
* @tstype $protobuf.Type
*/
/**
* Reflected service descriptor proto.
* @name ServiceDescriptorProto
* @type {Type}
* @const
* @tstype $protobuf.Type
*/
/**
* Reflected enum value descriptor proto.
* @name EnumValueDescriptorProto
* @type {Type}
* @const
* @tstype $protobuf.Type
*/
/**
* Reflected method descriptor proto.
* @name MethodDescriptorProto
* @type {Type}
* @const
* @tstype $protobuf.Type
*/
/**
* Reflected file options.
* @name FileOptions
* @type {Type}
* @property {Enum} OptimizeMode
* @const
* @tstype $protobuf.Type & {
*     OptimizeMode: $protobuf.Enum
* }
*/
/**
* Reflected message options.
* @name MessageOptions
* @type {Type}
* @const
* @tstype $protobuf.Type
*/
/**
* Reflected field options.
* @name FieldOptions
* @type {Type}
* @property {Enum} CType
* @property {Enum} JSType
* @const
* @tstype $protobuf.Type & {
*     CType: $protobuf.Enum,
*     JSType: $protobuf.Enum
* }
*/
/**
* Reflected oneof options.
* @name OneofOptions
* @type {Type}
* @const
* @tstype $protobuf.Type
*/
/**
* Reflected enum options.
* @name EnumOptions
* @type {Type}
* @const
* @tstype $protobuf.Type
*/
/**
* Reflected enum value options.
* @name EnumValueOptions
* @type {Type}
* @const
* @tstype $protobuf.Type
*/
/**
* Reflected service options.
* @name ServiceOptions
* @type {Type}
* @const
* @tstype $protobuf.Type
*/
/**
* Reflected method options.
* @name MethodOptions
* @type {Type}
* @const
* @tstype $protobuf.Type
*/
/**
* Reflected uninterpretet option.
* @name UninterpretedOption
* @type {Type}
* @property {Type} NamePart
* @const
* @tstype $protobuf.Type & {
*     NamePart: $protobuf.Type
* }
*/
/**
* Reflected source code info.
* @name SourceCodeInfo
* @type {Type}
* @property {Type} Location
* @const
* @tstype $protobuf.Type & {
*     Location: $protobuf.Type
* }
*/
/**
* Reflected generated code info.
* @name GeneratedCodeInfo
* @type {Type}
* @property {Type} Annotation
* @const
* @tstype $protobuf.Type & {
*     Annotation: $protobuf.Type
* }
*/
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/google/protobuf/api.json
var require_api = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = { "nested": { "google": { "nested": { "protobuf": { "nested": {
		"Api": { "fields": {
			"name": {
				"type": "string",
				"id": 1
			},
			"methods": {
				"rule": "repeated",
				"type": "Method",
				"id": 2
			},
			"options": {
				"rule": "repeated",
				"type": "Option",
				"id": 3
			},
			"version": {
				"type": "string",
				"id": 4
			},
			"sourceContext": {
				"type": "SourceContext",
				"id": 5
			},
			"mixins": {
				"rule": "repeated",
				"type": "Mixin",
				"id": 6
			},
			"syntax": {
				"type": "Syntax",
				"id": 7
			}
		} },
		"Method": { "fields": {
			"name": {
				"type": "string",
				"id": 1
			},
			"requestTypeUrl": {
				"type": "string",
				"id": 2
			},
			"requestStreaming": {
				"type": "bool",
				"id": 3
			},
			"responseTypeUrl": {
				"type": "string",
				"id": 4
			},
			"responseStreaming": {
				"type": "bool",
				"id": 5
			},
			"options": {
				"rule": "repeated",
				"type": "Option",
				"id": 6
			},
			"syntax": {
				"type": "Syntax",
				"id": 7
			}
		} },
		"Mixin": { "fields": {
			"name": {
				"type": "string",
				"id": 1
			},
			"root": {
				"type": "string",
				"id": 2
			}
		} },
		"SourceContext": { "fields": { "fileName": {
			"type": "string",
			"id": 1
		} } },
		"Option": { "fields": {
			"name": {
				"type": "string",
				"id": 1
			},
			"value": {
				"type": "Any",
				"id": 2
			}
		} },
		"Syntax": { "values": {
			"SYNTAX_PROTO2": 0,
			"SYNTAX_PROTO3": 1
		} }
	} } } } } };
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/google/protobuf/source_context.json
var require_source_context = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = { "nested": { "google": { "nested": { "protobuf": { "nested": { "SourceContext": { "fields": { "fileName": {
		"type": "string",
		"id": 1
	} } } } } } } } };
}));
//#endregion
//#region ../../node_modules/.pnpm/protobufjs@7.5.4/node_modules/protobufjs/google/protobuf/type.json
var require_type = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = { "nested": { "google": { "nested": { "protobuf": { "nested": {
		"Type": { "fields": {
			"name": {
				"type": "string",
				"id": 1
			},
			"fields": {
				"rule": "repeated",
				"type": "Field",
				"id": 2
			},
			"oneofs": {
				"rule": "repeated",
				"type": "string",
				"id": 3
			},
			"options": {
				"rule": "repeated",
				"type": "Option",
				"id": 4
			},
			"sourceContext": {
				"type": "SourceContext",
				"id": 5
			},
			"syntax": {
				"type": "Syntax",
				"id": 6
			}
		} },
		"Field": {
			"fields": {
				"kind": {
					"type": "Kind",
					"id": 1
				},
				"cardinality": {
					"type": "Cardinality",
					"id": 2
				},
				"number": {
					"type": "int32",
					"id": 3
				},
				"name": {
					"type": "string",
					"id": 4
				},
				"typeUrl": {
					"type": "string",
					"id": 6
				},
				"oneofIndex": {
					"type": "int32",
					"id": 7
				},
				"packed": {
					"type": "bool",
					"id": 8
				},
				"options": {
					"rule": "repeated",
					"type": "Option",
					"id": 9
				},
				"jsonName": {
					"type": "string",
					"id": 10
				},
				"defaultValue": {
					"type": "string",
					"id": 11
				}
			},
			"nested": {
				"Kind": { "values": {
					"TYPE_UNKNOWN": 0,
					"TYPE_DOUBLE": 1,
					"TYPE_FLOAT": 2,
					"TYPE_INT64": 3,
					"TYPE_UINT64": 4,
					"TYPE_INT32": 5,
					"TYPE_FIXED64": 6,
					"TYPE_FIXED32": 7,
					"TYPE_BOOL": 8,
					"TYPE_STRING": 9,
					"TYPE_GROUP": 10,
					"TYPE_MESSAGE": 11,
					"TYPE_BYTES": 12,
					"TYPE_UINT32": 13,
					"TYPE_ENUM": 14,
					"TYPE_SFIXED32": 15,
					"TYPE_SFIXED64": 16,
					"TYPE_SINT32": 17,
					"TYPE_SINT64": 18
				} },
				"Cardinality": { "values": {
					"CARDINALITY_UNKNOWN": 0,
					"CARDINALITY_OPTIONAL": 1,
					"CARDINALITY_REQUIRED": 2,
					"CARDINALITY_REPEATED": 3
				} }
			}
		},
		"Enum": { "fields": {
			"name": {
				"type": "string",
				"id": 1
			},
			"enumvalue": {
				"rule": "repeated",
				"type": "EnumValue",
				"id": 2
			},
			"options": {
				"rule": "repeated",
				"type": "Option",
				"id": 3
			},
			"sourceContext": {
				"type": "SourceContext",
				"id": 4
			},
			"syntax": {
				"type": "Syntax",
				"id": 5
			}
		} },
		"EnumValue": { "fields": {
			"name": {
				"type": "string",
				"id": 1
			},
			"number": {
				"type": "int32",
				"id": 2
			},
			"options": {
				"rule": "repeated",
				"type": "Option",
				"id": 3
			}
		} },
		"Option": { "fields": {
			"name": {
				"type": "string",
				"id": 1
			},
			"value": {
				"type": "Any",
				"id": 2
			}
		} },
		"Syntax": { "values": {
			"SYNTAX_PROTO2": 0,
			"SYNTAX_PROTO3": 1
		} },
		"Any": { "fields": {
			"type_url": {
				"type": "string",
				"id": 1
			},
			"value": {
				"type": "bytes",
				"id": 2
			}
		} },
		"SourceContext": { "fields": { "fileName": {
			"type": "string",
			"id": 1
		} } }
	} } } } } };
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+proto-loader@0.8.0/node_modules/@grpc/proto-loader/build/src/util.js
var require_util = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* @license
	* Copyright 2018 gRPC authors.
	*
	* Licensed under the Apache License, Version 2.0 (the "License");
	* you may not use this file except in compliance with the License.
	* You may obtain a copy of the License at
	*
	*     http://www.apache.org/licenses/LICENSE-2.0
	*
	* Unless required by applicable law or agreed to in writing, software
	* distributed under the License is distributed on an "AS IS" BASIS,
	* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	* See the License for the specific language governing permissions and
	* limitations under the License.
	*
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.addCommonProtos = exports.loadProtosWithOptionsSync = exports.loadProtosWithOptions = void 0;
	const fs$1 = __require("fs");
	const path = __require("path");
	const Protobuf = require_protobufjs();
	function addIncludePathResolver(root, includePaths) {
		const originalResolvePath = root.resolvePath;
		root.resolvePath = (origin, target) => {
			if (path.isAbsolute(target)) return target;
			for (const directory of includePaths) {
				const fullPath = path.join(directory, target);
				try {
					fs$1.accessSync(fullPath, fs$1.constants.R_OK);
					return fullPath;
				} catch (err) {
					continue;
				}
			}
			process.emitWarning(`${target} not found in any of the include paths ${includePaths}`);
			return originalResolvePath(origin, target);
		};
	}
	async function loadProtosWithOptions(filename, options) {
		const root = new Protobuf.Root();
		options = options || {};
		if (!!options.includeDirs) {
			if (!Array.isArray(options.includeDirs)) return Promise.reject(/* @__PURE__ */ new Error("The includeDirs option must be an array"));
			addIncludePathResolver(root, options.includeDirs);
		}
		const loadedRoot = await root.load(filename, options);
		loadedRoot.resolveAll();
		return loadedRoot;
	}
	exports.loadProtosWithOptions = loadProtosWithOptions;
	function loadProtosWithOptionsSync(filename, options) {
		const root = new Protobuf.Root();
		options = options || {};
		if (!!options.includeDirs) {
			if (!Array.isArray(options.includeDirs)) throw new Error("The includeDirs option must be an array");
			addIncludePathResolver(root, options.includeDirs);
		}
		const loadedRoot = root.loadSync(filename, options);
		loadedRoot.resolveAll();
		return loadedRoot;
	}
	exports.loadProtosWithOptionsSync = loadProtosWithOptionsSync;
	/**
	* Load Google's well-known proto files that aren't exposed by Protobuf.js.
	*/
	function addCommonProtos() {
		const apiDescriptor = require_api();
		const descriptorDescriptor = require_descriptor$1();
		const sourceContextDescriptor = require_source_context();
		const typeDescriptor = require_type();
		Protobuf.common("api", apiDescriptor.nested.google.nested.protobuf.nested);
		Protobuf.common("descriptor", descriptorDescriptor.nested.google.nested.protobuf.nested);
		Protobuf.common("source_context", sourceContextDescriptor.nested.google.nested.protobuf.nested);
		Protobuf.common("type", typeDescriptor.nested.google.nested.protobuf.nested);
	}
	exports.addCommonProtos = addCommonProtos;
}));
//#endregion
//#region ../../node_modules/.pnpm/long@5.3.2/node_modules/long/umd/index.js
var require_umd = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(global, factory) {
		function preferDefault(exports$1) {
			return exports$1.default || exports$1;
		}
		if (typeof define === "function" && define.amd) define([], function() {
			var exports$2 = {};
			factory(exports$2);
			return preferDefault(exports$2);
		});
		else if (typeof exports === "object") {
			factory(exports);
			if (typeof module === "object") module.exports = preferDefault(exports);
		} else (function() {
			var exports$3 = {};
			factory(exports$3);
			global.Long = preferDefault(exports$3);
		})();
	})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : exports, function(_exports) {
		"use strict";
		Object.defineProperty(_exports, "__esModule", { value: true });
		_exports.default = void 0;
		/**
		* @license
		* Copyright 2009 The Closure Library Authors
		* Copyright 2020 Daniel Wirtz / The long.js Authors.
		*
		* Licensed under the Apache License, Version 2.0 (the "License");
		* you may not use this file except in compliance with the License.
		* You may obtain a copy of the License at
		*
		*     http://www.apache.org/licenses/LICENSE-2.0
		*
		* Unless required by applicable law or agreed to in writing, software
		* distributed under the License is distributed on an "AS IS" BASIS,
		* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
		* See the License for the specific language governing permissions and
		* limitations under the License.
		*
		* SPDX-License-Identifier: Apache-2.0
		*/
		var wasm = null;
		try {
			wasm = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([
				0,
				97,
				115,
				109,
				1,
				0,
				0,
				0,
				1,
				13,
				2,
				96,
				0,
				1,
				127,
				96,
				4,
				127,
				127,
				127,
				127,
				1,
				127,
				3,
				7,
				6,
				0,
				1,
				1,
				1,
				1,
				1,
				6,
				6,
				1,
				127,
				1,
				65,
				0,
				11,
				7,
				50,
				6,
				3,
				109,
				117,
				108,
				0,
				1,
				5,
				100,
				105,
				118,
				95,
				115,
				0,
				2,
				5,
				100,
				105,
				118,
				95,
				117,
				0,
				3,
				5,
				114,
				101,
				109,
				95,
				115,
				0,
				4,
				5,
				114,
				101,
				109,
				95,
				117,
				0,
				5,
				8,
				103,
				101,
				116,
				95,
				104,
				105,
				103,
				104,
				0,
				0,
				10,
				191,
				1,
				6,
				4,
				0,
				35,
				0,
				11,
				36,
				1,
				1,
				126,
				32,
				0,
				173,
				32,
				1,
				173,
				66,
				32,
				134,
				132,
				32,
				2,
				173,
				32,
				3,
				173,
				66,
				32,
				134,
				132,
				126,
				34,
				4,
				66,
				32,
				135,
				167,
				36,
				0,
				32,
				4,
				167,
				11,
				36,
				1,
				1,
				126,
				32,
				0,
				173,
				32,
				1,
				173,
				66,
				32,
				134,
				132,
				32,
				2,
				173,
				32,
				3,
				173,
				66,
				32,
				134,
				132,
				127,
				34,
				4,
				66,
				32,
				135,
				167,
				36,
				0,
				32,
				4,
				167,
				11,
				36,
				1,
				1,
				126,
				32,
				0,
				173,
				32,
				1,
				173,
				66,
				32,
				134,
				132,
				32,
				2,
				173,
				32,
				3,
				173,
				66,
				32,
				134,
				132,
				128,
				34,
				4,
				66,
				32,
				135,
				167,
				36,
				0,
				32,
				4,
				167,
				11,
				36,
				1,
				1,
				126,
				32,
				0,
				173,
				32,
				1,
				173,
				66,
				32,
				134,
				132,
				32,
				2,
				173,
				32,
				3,
				173,
				66,
				32,
				134,
				132,
				129,
				34,
				4,
				66,
				32,
				135,
				167,
				36,
				0,
				32,
				4,
				167,
				11,
				36,
				1,
				1,
				126,
				32,
				0,
				173,
				32,
				1,
				173,
				66,
				32,
				134,
				132,
				32,
				2,
				173,
				32,
				3,
				173,
				66,
				32,
				134,
				132,
				130,
				34,
				4,
				66,
				32,
				135,
				167,
				36,
				0,
				32,
				4,
				167,
				11
			])), {}).exports;
		} catch {}
		/**
		* Constructs a 64 bit two's-complement integer, given its low and high 32 bit values as *signed* integers.
		*  See the from* functions below for more convenient ways of constructing Longs.
		* @exports Long
		* @class A Long class for representing a 64 bit two's-complement integer value.
		* @param {number} low The low (signed) 32 bits of the long
		* @param {number} high The high (signed) 32 bits of the long
		* @param {boolean=} unsigned Whether unsigned or not, defaults to signed
		* @constructor
		*/
		function Long(low, high, unsigned) {
			/**
			* The low 32 bits as a signed value.
			* @type {number}
			*/
			this.low = low | 0;
			/**
			* The high 32 bits as a signed value.
			* @type {number}
			*/
			this.high = high | 0;
			/**
			* Whether unsigned or not.
			* @type {boolean}
			*/
			this.unsigned = !!unsigned;
		}
		/**
		* An indicator used to reliably determine if an object is a Long or not.
		* @type {boolean}
		* @const
		* @private
		*/
		Long.prototype.__isLong__;
		Object.defineProperty(Long.prototype, "__isLong__", { value: true });
		/**
		* @function
		* @param {*} obj Object
		* @returns {boolean}
		* @inner
		*/
		function isLong(obj) {
			return (obj && obj["__isLong__"]) === true;
		}
		/**
		* @function
		* @param {*} value number
		* @returns {number}
		* @inner
		*/
		function ctz32(value) {
			var c = Math.clz32(value & -value);
			return value ? 31 - c : c;
		}
		/**
		* Tests if the specified object is a Long.
		* @function
		* @param {*} obj Object
		* @returns {boolean}
		*/
		Long.isLong = isLong;
		/**
		* A cache of the Long representations of small integer values.
		* @type {!Object}
		* @inner
		*/
		var INT_CACHE = {};
		/**
		* A cache of the Long representations of small unsigned integer values.
		* @type {!Object}
		* @inner
		*/
		var UINT_CACHE = {};
		/**
		* @param {number} value
		* @param {boolean=} unsigned
		* @returns {!Long}
		* @inner
		*/
		function fromInt(value, unsigned) {
			var obj, cachedObj, cache;
			if (unsigned) {
				value >>>= 0;
				if (cache = 0 <= value && value < 256) {
					cachedObj = UINT_CACHE[value];
					if (cachedObj) return cachedObj;
				}
				obj = fromBits(value, 0, true);
				if (cache) UINT_CACHE[value] = obj;
				return obj;
			} else {
				value |= 0;
				if (cache = -128 <= value && value < 128) {
					cachedObj = INT_CACHE[value];
					if (cachedObj) return cachedObj;
				}
				obj = fromBits(value, value < 0 ? -1 : 0, false);
				if (cache) INT_CACHE[value] = obj;
				return obj;
			}
		}
		/**
		* Returns a Long representing the given 32 bit integer value.
		* @function
		* @param {number} value The 32 bit integer in question
		* @param {boolean=} unsigned Whether unsigned or not, defaults to signed
		* @returns {!Long} The corresponding Long value
		*/
		Long.fromInt = fromInt;
		/**
		* @param {number} value
		* @param {boolean=} unsigned
		* @returns {!Long}
		* @inner
		*/
		function fromNumber(value, unsigned) {
			if (isNaN(value)) return unsigned ? UZERO : ZERO;
			if (unsigned) {
				if (value < 0) return UZERO;
				if (value >= TWO_PWR_64_DBL) return MAX_UNSIGNED_VALUE;
			} else {
				if (value <= -TWO_PWR_63_DBL) return MIN_VALUE;
				if (value + 1 >= TWO_PWR_63_DBL) return MAX_VALUE;
			}
			if (value < 0) return fromNumber(-value, unsigned).neg();
			return fromBits(value % TWO_PWR_32_DBL | 0, value / TWO_PWR_32_DBL | 0, unsigned);
		}
		/**
		* Returns a Long representing the given value, provided that it is a finite number. Otherwise, zero is returned.
		* @function
		* @param {number} value The number in question
		* @param {boolean=} unsigned Whether unsigned or not, defaults to signed
		* @returns {!Long} The corresponding Long value
		*/
		Long.fromNumber = fromNumber;
		/**
		* @param {number} lowBits
		* @param {number} highBits
		* @param {boolean=} unsigned
		* @returns {!Long}
		* @inner
		*/
		function fromBits(lowBits, highBits, unsigned) {
			return new Long(lowBits, highBits, unsigned);
		}
		/**
		* Returns a Long representing the 64 bit integer that comes by concatenating the given low and high bits. Each is
		*  assumed to use 32 bits.
		* @function
		* @param {number} lowBits The low 32 bits
		* @param {number} highBits The high 32 bits
		* @param {boolean=} unsigned Whether unsigned or not, defaults to signed
		* @returns {!Long} The corresponding Long value
		*/
		Long.fromBits = fromBits;
		/**
		* @function
		* @param {number} base
		* @param {number} exponent
		* @returns {number}
		* @inner
		*/
		var pow_dbl = Math.pow;
		/**
		* @param {string} str
		* @param {(boolean|number)=} unsigned
		* @param {number=} radix
		* @returns {!Long}
		* @inner
		*/
		function fromString(str, unsigned, radix) {
			if (str.length === 0) throw Error("empty string");
			if (typeof unsigned === "number") {
				radix = unsigned;
				unsigned = false;
			} else unsigned = !!unsigned;
			if (str === "NaN" || str === "Infinity" || str === "+Infinity" || str === "-Infinity") return unsigned ? UZERO : ZERO;
			radix = radix || 10;
			if (radix < 2 || 36 < radix) throw RangeError("radix");
			var p;
			if ((p = str.indexOf("-")) > 0) throw Error("interior hyphen");
			else if (p === 0) return fromString(str.substring(1), unsigned, radix).neg();
			var radixToPower = fromNumber(pow_dbl(radix, 8));
			var result = ZERO;
			for (var i = 0; i < str.length; i += 8) {
				var size = Math.min(8, str.length - i), value = parseInt(str.substring(i, i + size), radix);
				if (size < 8) {
					var power = fromNumber(pow_dbl(radix, size));
					result = result.mul(power).add(fromNumber(value));
				} else {
					result = result.mul(radixToPower);
					result = result.add(fromNumber(value));
				}
			}
			result.unsigned = unsigned;
			return result;
		}
		/**
		* Returns a Long representation of the given string, written using the specified radix.
		* @function
		* @param {string} str The textual representation of the Long
		* @param {(boolean|number)=} unsigned Whether unsigned or not, defaults to signed
		* @param {number=} radix The radix in which the text is written (2-36), defaults to 10
		* @returns {!Long} The corresponding Long value
		*/
		Long.fromString = fromString;
		/**
		* @function
		* @param {!Long|number|string|!{low: number, high: number, unsigned: boolean}} val
		* @param {boolean=} unsigned
		* @returns {!Long}
		* @inner
		*/
		function fromValue(val, unsigned) {
			if (typeof val === "number") return fromNumber(val, unsigned);
			if (typeof val === "string") return fromString(val, unsigned);
			return fromBits(val.low, val.high, typeof unsigned === "boolean" ? unsigned : val.unsigned);
		}
		/**
		* Converts the specified value to a Long using the appropriate from* function for its type.
		* @function
		* @param {!Long|number|bigint|string|!{low: number, high: number, unsigned: boolean}} val Value
		* @param {boolean=} unsigned Whether unsigned or not, defaults to signed
		* @returns {!Long}
		*/
		Long.fromValue = fromValue;
		/**
		* @type {number}
		* @const
		* @inner
		*/
		var TWO_PWR_16_DBL = 65536;
		/**
		* @type {number}
		* @const
		* @inner
		*/
		var TWO_PWR_24_DBL = 1 << 24;
		/**
		* @type {number}
		* @const
		* @inner
		*/
		var TWO_PWR_32_DBL = TWO_PWR_16_DBL * TWO_PWR_16_DBL;
		/**
		* @type {number}
		* @const
		* @inner
		*/
		var TWO_PWR_64_DBL = TWO_PWR_32_DBL * TWO_PWR_32_DBL;
		/**
		* @type {number}
		* @const
		* @inner
		*/
		var TWO_PWR_63_DBL = TWO_PWR_64_DBL / 2;
		/**
		* @type {!Long}
		* @const
		* @inner
		*/
		var TWO_PWR_24 = fromInt(TWO_PWR_24_DBL);
		/**
		* @type {!Long}
		* @inner
		*/
		var ZERO = fromInt(0);
		/**
		* Signed zero.
		* @type {!Long}
		*/
		Long.ZERO = ZERO;
		/**
		* @type {!Long}
		* @inner
		*/
		var UZERO = fromInt(0, true);
		/**
		* Unsigned zero.
		* @type {!Long}
		*/
		Long.UZERO = UZERO;
		/**
		* @type {!Long}
		* @inner
		*/
		var ONE = fromInt(1);
		/**
		* Signed one.
		* @type {!Long}
		*/
		Long.ONE = ONE;
		/**
		* @type {!Long}
		* @inner
		*/
		var UONE = fromInt(1, true);
		/**
		* Unsigned one.
		* @type {!Long}
		*/
		Long.UONE = UONE;
		/**
		* @type {!Long}
		* @inner
		*/
		var NEG_ONE = fromInt(-1);
		/**
		* Signed negative one.
		* @type {!Long}
		*/
		Long.NEG_ONE = NEG_ONE;
		/**
		* @type {!Long}
		* @inner
		*/
		var MAX_VALUE = fromBits(-1, 2147483647, false);
		/**
		* Maximum signed value.
		* @type {!Long}
		*/
		Long.MAX_VALUE = MAX_VALUE;
		/**
		* @type {!Long}
		* @inner
		*/
		var MAX_UNSIGNED_VALUE = fromBits(-1, -1, true);
		/**
		* Maximum unsigned value.
		* @type {!Long}
		*/
		Long.MAX_UNSIGNED_VALUE = MAX_UNSIGNED_VALUE;
		/**
		* @type {!Long}
		* @inner
		*/
		var MIN_VALUE = fromBits(0, -2147483648, false);
		/**
		* Minimum signed value.
		* @type {!Long}
		*/
		Long.MIN_VALUE = MIN_VALUE;
		/**
		* @alias Long.prototype
		* @inner
		*/
		var LongPrototype = Long.prototype;
		/**
		* Converts the Long to a 32 bit integer, assuming it is a 32 bit integer.
		* @this {!Long}
		* @returns {number}
		*/
		LongPrototype.toInt = function toInt() {
			return this.unsigned ? this.low >>> 0 : this.low;
		};
		/**
		* Converts the Long to a the nearest floating-point representation of this value (double, 53 bit mantissa).
		* @this {!Long}
		* @returns {number}
		*/
		LongPrototype.toNumber = function toNumber() {
			if (this.unsigned) return (this.high >>> 0) * TWO_PWR_32_DBL + (this.low >>> 0);
			return this.high * TWO_PWR_32_DBL + (this.low >>> 0);
		};
		/**
		* Converts the Long to a string written in the specified radix.
		* @this {!Long}
		* @param {number=} radix Radix (2-36), defaults to 10
		* @returns {string}
		* @override
		* @throws {RangeError} If `radix` is out of range
		*/
		LongPrototype.toString = function toString(radix) {
			radix = radix || 10;
			if (radix < 2 || 36 < radix) throw RangeError("radix");
			if (this.isZero()) return "0";
			if (this.isNegative()) if (this.eq(MIN_VALUE)) {
				var radixLong = fromNumber(radix), div = this.div(radixLong), rem1 = div.mul(radixLong).sub(this);
				return div.toString(radix) + rem1.toInt().toString(radix);
			} else return "-" + this.neg().toString(radix);
			var radixToPower = fromNumber(pow_dbl(radix, 6), this.unsigned), rem = this;
			var result = "";
			while (true) {
				var remDiv = rem.div(radixToPower), digits = (rem.sub(remDiv.mul(radixToPower)).toInt() >>> 0).toString(radix);
				rem = remDiv;
				if (rem.isZero()) return digits + result;
				else {
					while (digits.length < 6) digits = "0" + digits;
					result = "" + digits + result;
				}
			}
		};
		/**
		* Gets the high 32 bits as a signed integer.
		* @this {!Long}
		* @returns {number} Signed high bits
		*/
		LongPrototype.getHighBits = function getHighBits() {
			return this.high;
		};
		/**
		* Gets the high 32 bits as an unsigned integer.
		* @this {!Long}
		* @returns {number} Unsigned high bits
		*/
		LongPrototype.getHighBitsUnsigned = function getHighBitsUnsigned() {
			return this.high >>> 0;
		};
		/**
		* Gets the low 32 bits as a signed integer.
		* @this {!Long}
		* @returns {number} Signed low bits
		*/
		LongPrototype.getLowBits = function getLowBits() {
			return this.low;
		};
		/**
		* Gets the low 32 bits as an unsigned integer.
		* @this {!Long}
		* @returns {number} Unsigned low bits
		*/
		LongPrototype.getLowBitsUnsigned = function getLowBitsUnsigned() {
			return this.low >>> 0;
		};
		/**
		* Gets the number of bits needed to represent the absolute value of this Long.
		* @this {!Long}
		* @returns {number}
		*/
		LongPrototype.getNumBitsAbs = function getNumBitsAbs() {
			if (this.isNegative()) return this.eq(MIN_VALUE) ? 64 : this.neg().getNumBitsAbs();
			var val = this.high != 0 ? this.high : this.low;
			for (var bit = 31; bit > 0; bit--) if ((val & 1 << bit) != 0) break;
			return this.high != 0 ? bit + 33 : bit + 1;
		};
		/**
		* Tests if this Long can be safely represented as a JavaScript number.
		* @this {!Long}
		* @returns {boolean}
		*/
		LongPrototype.isSafeInteger = function isSafeInteger() {
			var top11Bits = this.high >> 21;
			if (!top11Bits) return true;
			if (this.unsigned) return false;
			return top11Bits === -1 && !(this.low === 0 && this.high === -2097152);
		};
		/**
		* Tests if this Long's value equals zero.
		* @this {!Long}
		* @returns {boolean}
		*/
		LongPrototype.isZero = function isZero() {
			return this.high === 0 && this.low === 0;
		};
		/**
		* Tests if this Long's value equals zero. This is an alias of {@link Long#isZero}.
		* @returns {boolean}
		*/
		LongPrototype.eqz = LongPrototype.isZero;
		/**
		* Tests if this Long's value is negative.
		* @this {!Long}
		* @returns {boolean}
		*/
		LongPrototype.isNegative = function isNegative() {
			return !this.unsigned && this.high < 0;
		};
		/**
		* Tests if this Long's value is positive or zero.
		* @this {!Long}
		* @returns {boolean}
		*/
		LongPrototype.isPositive = function isPositive() {
			return this.unsigned || this.high >= 0;
		};
		/**
		* Tests if this Long's value is odd.
		* @this {!Long}
		* @returns {boolean}
		*/
		LongPrototype.isOdd = function isOdd() {
			return (this.low & 1) === 1;
		};
		/**
		* Tests if this Long's value is even.
		* @this {!Long}
		* @returns {boolean}
		*/
		LongPrototype.isEven = function isEven() {
			return (this.low & 1) === 0;
		};
		/**
		* Tests if this Long's value equals the specified's.
		* @this {!Long}
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.equals = function equals(other) {
			if (!isLong(other)) other = fromValue(other);
			if (this.unsigned !== other.unsigned && this.high >>> 31 === 1 && other.high >>> 31 === 1) return false;
			return this.high === other.high && this.low === other.low;
		};
		/**
		* Tests if this Long's value equals the specified's. This is an alias of {@link Long#equals}.
		* @function
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.eq = LongPrototype.equals;
		/**
		* Tests if this Long's value differs from the specified's.
		* @this {!Long}
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.notEquals = function notEquals(other) {
			return !this.eq(other);
		};
		/**
		* Tests if this Long's value differs from the specified's. This is an alias of {@link Long#notEquals}.
		* @function
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.neq = LongPrototype.notEquals;
		/**
		* Tests if this Long's value differs from the specified's. This is an alias of {@link Long#notEquals}.
		* @function
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.ne = LongPrototype.notEquals;
		/**
		* Tests if this Long's value is less than the specified's.
		* @this {!Long}
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.lessThan = function lessThan(other) {
			return this.comp(other) < 0;
		};
		/**
		* Tests if this Long's value is less than the specified's. This is an alias of {@link Long#lessThan}.
		* @function
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.lt = LongPrototype.lessThan;
		/**
		* Tests if this Long's value is less than or equal the specified's.
		* @this {!Long}
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.lessThanOrEqual = function lessThanOrEqual(other) {
			return this.comp(other) <= 0;
		};
		/**
		* Tests if this Long's value is less than or equal the specified's. This is an alias of {@link Long#lessThanOrEqual}.
		* @function
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.lte = LongPrototype.lessThanOrEqual;
		/**
		* Tests if this Long's value is less than or equal the specified's. This is an alias of {@link Long#lessThanOrEqual}.
		* @function
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.le = LongPrototype.lessThanOrEqual;
		/**
		* Tests if this Long's value is greater than the specified's.
		* @this {!Long}
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.greaterThan = function greaterThan(other) {
			return this.comp(other) > 0;
		};
		/**
		* Tests if this Long's value is greater than the specified's. This is an alias of {@link Long#greaterThan}.
		* @function
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.gt = LongPrototype.greaterThan;
		/**
		* Tests if this Long's value is greater than or equal the specified's.
		* @this {!Long}
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.greaterThanOrEqual = function greaterThanOrEqual(other) {
			return this.comp(other) >= 0;
		};
		/**
		* Tests if this Long's value is greater than or equal the specified's. This is an alias of {@link Long#greaterThanOrEqual}.
		* @function
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.gte = LongPrototype.greaterThanOrEqual;
		/**
		* Tests if this Long's value is greater than or equal the specified's. This is an alias of {@link Long#greaterThanOrEqual}.
		* @function
		* @param {!Long|number|bigint|string} other Other value
		* @returns {boolean}
		*/
		LongPrototype.ge = LongPrototype.greaterThanOrEqual;
		/**
		* Compares this Long's value with the specified's.
		* @this {!Long}
		* @param {!Long|number|bigint|string} other Other value
		* @returns {number} 0 if they are the same, 1 if the this is greater and -1
		*  if the given one is greater
		*/
		LongPrototype.compare = function compare(other) {
			if (!isLong(other)) other = fromValue(other);
			if (this.eq(other)) return 0;
			var thisNeg = this.isNegative(), otherNeg = other.isNegative();
			if (thisNeg && !otherNeg) return -1;
			if (!thisNeg && otherNeg) return 1;
			if (!this.unsigned) return this.sub(other).isNegative() ? -1 : 1;
			return other.high >>> 0 > this.high >>> 0 || other.high === this.high && other.low >>> 0 > this.low >>> 0 ? -1 : 1;
		};
		/**
		* Compares this Long's value with the specified's. This is an alias of {@link Long#compare}.
		* @function
		* @param {!Long|number|bigint|string} other Other value
		* @returns {number} 0 if they are the same, 1 if the this is greater and -1
		*  if the given one is greater
		*/
		LongPrototype.comp = LongPrototype.compare;
		/**
		* Negates this Long's value.
		* @this {!Long}
		* @returns {!Long} Negated Long
		*/
		LongPrototype.negate = function negate() {
			if (!this.unsigned && this.eq(MIN_VALUE)) return MIN_VALUE;
			return this.not().add(ONE);
		};
		/**
		* Negates this Long's value. This is an alias of {@link Long#negate}.
		* @function
		* @returns {!Long} Negated Long
		*/
		LongPrototype.neg = LongPrototype.negate;
		/**
		* Returns the sum of this and the specified Long.
		* @this {!Long}
		* @param {!Long|number|bigint|string} addend Addend
		* @returns {!Long} Sum
		*/
		LongPrototype.add = function add(addend) {
			if (!isLong(addend)) addend = fromValue(addend);
			var a48 = this.high >>> 16;
			var a32 = this.high & 65535;
			var a16 = this.low >>> 16;
			var a00 = this.low & 65535;
			var b48 = addend.high >>> 16;
			var b32 = addend.high & 65535;
			var b16 = addend.low >>> 16;
			var b00 = addend.low & 65535;
			var c48 = 0, c32 = 0, c16 = 0, c00 = 0;
			c00 += a00 + b00;
			c16 += c00 >>> 16;
			c00 &= 65535;
			c16 += a16 + b16;
			c32 += c16 >>> 16;
			c16 &= 65535;
			c32 += a32 + b32;
			c48 += c32 >>> 16;
			c32 &= 65535;
			c48 += a48 + b48;
			c48 &= 65535;
			return fromBits(c16 << 16 | c00, c48 << 16 | c32, this.unsigned);
		};
		/**
		* Returns the difference of this and the specified Long.
		* @this {!Long}
		* @param {!Long|number|bigint|string} subtrahend Subtrahend
		* @returns {!Long} Difference
		*/
		LongPrototype.subtract = function subtract(subtrahend) {
			if (!isLong(subtrahend)) subtrahend = fromValue(subtrahend);
			return this.add(subtrahend.neg());
		};
		/**
		* Returns the difference of this and the specified Long. This is an alias of {@link Long#subtract}.
		* @function
		* @param {!Long|number|bigint|string} subtrahend Subtrahend
		* @returns {!Long} Difference
		*/
		LongPrototype.sub = LongPrototype.subtract;
		/**
		* Returns the product of this and the specified Long.
		* @this {!Long}
		* @param {!Long|number|bigint|string} multiplier Multiplier
		* @returns {!Long} Product
		*/
		LongPrototype.multiply = function multiply(multiplier) {
			if (this.isZero()) return this;
			if (!isLong(multiplier)) multiplier = fromValue(multiplier);
			if (wasm) return fromBits(wasm["mul"](this.low, this.high, multiplier.low, multiplier.high), wasm["get_high"](), this.unsigned);
			if (multiplier.isZero()) return this.unsigned ? UZERO : ZERO;
			if (this.eq(MIN_VALUE)) return multiplier.isOdd() ? MIN_VALUE : ZERO;
			if (multiplier.eq(MIN_VALUE)) return this.isOdd() ? MIN_VALUE : ZERO;
			if (this.isNegative()) if (multiplier.isNegative()) return this.neg().mul(multiplier.neg());
			else return this.neg().mul(multiplier).neg();
			else if (multiplier.isNegative()) return this.mul(multiplier.neg()).neg();
			if (this.lt(TWO_PWR_24) && multiplier.lt(TWO_PWR_24)) return fromNumber(this.toNumber() * multiplier.toNumber(), this.unsigned);
			var a48 = this.high >>> 16;
			var a32 = this.high & 65535;
			var a16 = this.low >>> 16;
			var a00 = this.low & 65535;
			var b48 = multiplier.high >>> 16;
			var b32 = multiplier.high & 65535;
			var b16 = multiplier.low >>> 16;
			var b00 = multiplier.low & 65535;
			var c48 = 0, c32 = 0, c16 = 0, c00 = 0;
			c00 += a00 * b00;
			c16 += c00 >>> 16;
			c00 &= 65535;
			c16 += a16 * b00;
			c32 += c16 >>> 16;
			c16 &= 65535;
			c16 += a00 * b16;
			c32 += c16 >>> 16;
			c16 &= 65535;
			c32 += a32 * b00;
			c48 += c32 >>> 16;
			c32 &= 65535;
			c32 += a16 * b16;
			c48 += c32 >>> 16;
			c32 &= 65535;
			c32 += a00 * b32;
			c48 += c32 >>> 16;
			c32 &= 65535;
			c48 += a48 * b00 + a32 * b16 + a16 * b32 + a00 * b48;
			c48 &= 65535;
			return fromBits(c16 << 16 | c00, c48 << 16 | c32, this.unsigned);
		};
		/**
		* Returns the product of this and the specified Long. This is an alias of {@link Long#multiply}.
		* @function
		* @param {!Long|number|bigint|string} multiplier Multiplier
		* @returns {!Long} Product
		*/
		LongPrototype.mul = LongPrototype.multiply;
		/**
		* Returns this Long divided by the specified. The result is signed if this Long is signed or
		*  unsigned if this Long is unsigned.
		* @this {!Long}
		* @param {!Long|number|bigint|string} divisor Divisor
		* @returns {!Long} Quotient
		*/
		LongPrototype.divide = function divide(divisor) {
			if (!isLong(divisor)) divisor = fromValue(divisor);
			if (divisor.isZero()) throw Error("division by zero");
			if (wasm) {
				if (!this.unsigned && this.high === -2147483648 && divisor.low === -1 && divisor.high === -1) return this;
				return fromBits((this.unsigned ? wasm["div_u"] : wasm["div_s"])(this.low, this.high, divisor.low, divisor.high), wasm["get_high"](), this.unsigned);
			}
			if (this.isZero()) return this.unsigned ? UZERO : ZERO;
			var approx, rem, res;
			if (!this.unsigned) {
				if (this.eq(MIN_VALUE)) if (divisor.eq(ONE) || divisor.eq(NEG_ONE)) return MIN_VALUE;
				else if (divisor.eq(MIN_VALUE)) return ONE;
				else {
					approx = this.shr(1).div(divisor).shl(1);
					if (approx.eq(ZERO)) return divisor.isNegative() ? ONE : NEG_ONE;
					else {
						rem = this.sub(divisor.mul(approx));
						res = approx.add(rem.div(divisor));
						return res;
					}
				}
				else if (divisor.eq(MIN_VALUE)) return this.unsigned ? UZERO : ZERO;
				if (this.isNegative()) {
					if (divisor.isNegative()) return this.neg().div(divisor.neg());
					return this.neg().div(divisor).neg();
				} else if (divisor.isNegative()) return this.div(divisor.neg()).neg();
				res = ZERO;
			} else {
				if (!divisor.unsigned) divisor = divisor.toUnsigned();
				if (divisor.gt(this)) return UZERO;
				if (divisor.gt(this.shru(1))) return UONE;
				res = UZERO;
			}
			rem = this;
			while (rem.gte(divisor)) {
				approx = Math.max(1, Math.floor(rem.toNumber() / divisor.toNumber()));
				var log2 = Math.ceil(Math.log(approx) / Math.LN2), delta = log2 <= 48 ? 1 : pow_dbl(2, log2 - 48), approxRes = fromNumber(approx), approxRem = approxRes.mul(divisor);
				while (approxRem.isNegative() || approxRem.gt(rem)) {
					approx -= delta;
					approxRes = fromNumber(approx, this.unsigned);
					approxRem = approxRes.mul(divisor);
				}
				if (approxRes.isZero()) approxRes = ONE;
				res = res.add(approxRes);
				rem = rem.sub(approxRem);
			}
			return res;
		};
		/**
		* Returns this Long divided by the specified. This is an alias of {@link Long#divide}.
		* @function
		* @param {!Long|number|bigint|string} divisor Divisor
		* @returns {!Long} Quotient
		*/
		LongPrototype.div = LongPrototype.divide;
		/**
		* Returns this Long modulo the specified.
		* @this {!Long}
		* @param {!Long|number|bigint|string} divisor Divisor
		* @returns {!Long} Remainder
		*/
		LongPrototype.modulo = function modulo(divisor) {
			if (!isLong(divisor)) divisor = fromValue(divisor);
			if (wasm) return fromBits((this.unsigned ? wasm["rem_u"] : wasm["rem_s"])(this.low, this.high, divisor.low, divisor.high), wasm["get_high"](), this.unsigned);
			return this.sub(this.div(divisor).mul(divisor));
		};
		/**
		* Returns this Long modulo the specified. This is an alias of {@link Long#modulo}.
		* @function
		* @param {!Long|number|bigint|string} divisor Divisor
		* @returns {!Long} Remainder
		*/
		LongPrototype.mod = LongPrototype.modulo;
		/**
		* Returns this Long modulo the specified. This is an alias of {@link Long#modulo}.
		* @function
		* @param {!Long|number|bigint|string} divisor Divisor
		* @returns {!Long} Remainder
		*/
		LongPrototype.rem = LongPrototype.modulo;
		/**
		* Returns the bitwise NOT of this Long.
		* @this {!Long}
		* @returns {!Long}
		*/
		LongPrototype.not = function not() {
			return fromBits(~this.low, ~this.high, this.unsigned);
		};
		/**
		* Returns count leading zeros of this Long.
		* @this {!Long}
		* @returns {!number}
		*/
		LongPrototype.countLeadingZeros = function countLeadingZeros() {
			return this.high ? Math.clz32(this.high) : Math.clz32(this.low) + 32;
		};
		/**
		* Returns count leading zeros. This is an alias of {@link Long#countLeadingZeros}.
		* @function
		* @param {!Long}
		* @returns {!number}
		*/
		LongPrototype.clz = LongPrototype.countLeadingZeros;
		/**
		* Returns count trailing zeros of this Long.
		* @this {!Long}
		* @returns {!number}
		*/
		LongPrototype.countTrailingZeros = function countTrailingZeros() {
			return this.low ? ctz32(this.low) : ctz32(this.high) + 32;
		};
		/**
		* Returns count trailing zeros. This is an alias of {@link Long#countTrailingZeros}.
		* @function
		* @param {!Long}
		* @returns {!number}
		*/
		LongPrototype.ctz = LongPrototype.countTrailingZeros;
		/**
		* Returns the bitwise AND of this Long and the specified.
		* @this {!Long}
		* @param {!Long|number|bigint|string} other Other Long
		* @returns {!Long}
		*/
		LongPrototype.and = function and(other) {
			if (!isLong(other)) other = fromValue(other);
			return fromBits(this.low & other.low, this.high & other.high, this.unsigned);
		};
		/**
		* Returns the bitwise OR of this Long and the specified.
		* @this {!Long}
		* @param {!Long|number|bigint|string} other Other Long
		* @returns {!Long}
		*/
		LongPrototype.or = function or(other) {
			if (!isLong(other)) other = fromValue(other);
			return fromBits(this.low | other.low, this.high | other.high, this.unsigned);
		};
		/**
		* Returns the bitwise XOR of this Long and the given one.
		* @this {!Long}
		* @param {!Long|number|bigint|string} other Other Long
		* @returns {!Long}
		*/
		LongPrototype.xor = function xor(other) {
			if (!isLong(other)) other = fromValue(other);
			return fromBits(this.low ^ other.low, this.high ^ other.high, this.unsigned);
		};
		/**
		* Returns this Long with bits shifted to the left by the given amount.
		* @this {!Long}
		* @param {number|!Long} numBits Number of bits
		* @returns {!Long} Shifted Long
		*/
		LongPrototype.shiftLeft = function shiftLeft(numBits) {
			if (isLong(numBits)) numBits = numBits.toInt();
			if ((numBits &= 63) === 0) return this;
			else if (numBits < 32) return fromBits(this.low << numBits, this.high << numBits | this.low >>> 32 - numBits, this.unsigned);
			else return fromBits(0, this.low << numBits - 32, this.unsigned);
		};
		/**
		* Returns this Long with bits shifted to the left by the given amount. This is an alias of {@link Long#shiftLeft}.
		* @function
		* @param {number|!Long} numBits Number of bits
		* @returns {!Long} Shifted Long
		*/
		LongPrototype.shl = LongPrototype.shiftLeft;
		/**
		* Returns this Long with bits arithmetically shifted to the right by the given amount.
		* @this {!Long}
		* @param {number|!Long} numBits Number of bits
		* @returns {!Long} Shifted Long
		*/
		LongPrototype.shiftRight = function shiftRight(numBits) {
			if (isLong(numBits)) numBits = numBits.toInt();
			if ((numBits &= 63) === 0) return this;
			else if (numBits < 32) return fromBits(this.low >>> numBits | this.high << 32 - numBits, this.high >> numBits, this.unsigned);
			else return fromBits(this.high >> numBits - 32, this.high >= 0 ? 0 : -1, this.unsigned);
		};
		/**
		* Returns this Long with bits arithmetically shifted to the right by the given amount. This is an alias of {@link Long#shiftRight}.
		* @function
		* @param {number|!Long} numBits Number of bits
		* @returns {!Long} Shifted Long
		*/
		LongPrototype.shr = LongPrototype.shiftRight;
		/**
		* Returns this Long with bits logically shifted to the right by the given amount.
		* @this {!Long}
		* @param {number|!Long} numBits Number of bits
		* @returns {!Long} Shifted Long
		*/
		LongPrototype.shiftRightUnsigned = function shiftRightUnsigned(numBits) {
			if (isLong(numBits)) numBits = numBits.toInt();
			if ((numBits &= 63) === 0) return this;
			if (numBits < 32) return fromBits(this.low >>> numBits | this.high << 32 - numBits, this.high >>> numBits, this.unsigned);
			if (numBits === 32) return fromBits(this.high, 0, this.unsigned);
			return fromBits(this.high >>> numBits - 32, 0, this.unsigned);
		};
		/**
		* Returns this Long with bits logically shifted to the right by the given amount. This is an alias of {@link Long#shiftRightUnsigned}.
		* @function
		* @param {number|!Long} numBits Number of bits
		* @returns {!Long} Shifted Long
		*/
		LongPrototype.shru = LongPrototype.shiftRightUnsigned;
		/**
		* Returns this Long with bits logically shifted to the right by the given amount. This is an alias of {@link Long#shiftRightUnsigned}.
		* @function
		* @param {number|!Long} numBits Number of bits
		* @returns {!Long} Shifted Long
		*/
		LongPrototype.shr_u = LongPrototype.shiftRightUnsigned;
		/**
		* Returns this Long with bits rotated to the left by the given amount.
		* @this {!Long}
		* @param {number|!Long} numBits Number of bits
		* @returns {!Long} Rotated Long
		*/
		LongPrototype.rotateLeft = function rotateLeft(numBits) {
			var b;
			if (isLong(numBits)) numBits = numBits.toInt();
			if ((numBits &= 63) === 0) return this;
			if (numBits === 32) return fromBits(this.high, this.low, this.unsigned);
			if (numBits < 32) {
				b = 32 - numBits;
				return fromBits(this.low << numBits | this.high >>> b, this.high << numBits | this.low >>> b, this.unsigned);
			}
			numBits -= 32;
			b = 32 - numBits;
			return fromBits(this.high << numBits | this.low >>> b, this.low << numBits | this.high >>> b, this.unsigned);
		};
		/**
		* Returns this Long with bits rotated to the left by the given amount. This is an alias of {@link Long#rotateLeft}.
		* @function
		* @param {number|!Long} numBits Number of bits
		* @returns {!Long} Rotated Long
		*/
		LongPrototype.rotl = LongPrototype.rotateLeft;
		/**
		* Returns this Long with bits rotated to the right by the given amount.
		* @this {!Long}
		* @param {number|!Long} numBits Number of bits
		* @returns {!Long} Rotated Long
		*/
		LongPrototype.rotateRight = function rotateRight(numBits) {
			var b;
			if (isLong(numBits)) numBits = numBits.toInt();
			if ((numBits &= 63) === 0) return this;
			if (numBits === 32) return fromBits(this.high, this.low, this.unsigned);
			if (numBits < 32) {
				b = 32 - numBits;
				return fromBits(this.high << b | this.low >>> numBits, this.low << b | this.high >>> numBits, this.unsigned);
			}
			numBits -= 32;
			b = 32 - numBits;
			return fromBits(this.low << b | this.high >>> numBits, this.high << b | this.low >>> numBits, this.unsigned);
		};
		/**
		* Returns this Long with bits rotated to the right by the given amount. This is an alias of {@link Long#rotateRight}.
		* @function
		* @param {number|!Long} numBits Number of bits
		* @returns {!Long} Rotated Long
		*/
		LongPrototype.rotr = LongPrototype.rotateRight;
		/**
		* Converts this Long to signed.
		* @this {!Long}
		* @returns {!Long} Signed long
		*/
		LongPrototype.toSigned = function toSigned() {
			if (!this.unsigned) return this;
			return fromBits(this.low, this.high, false);
		};
		/**
		* Converts this Long to unsigned.
		* @this {!Long}
		* @returns {!Long} Unsigned long
		*/
		LongPrototype.toUnsigned = function toUnsigned() {
			if (this.unsigned) return this;
			return fromBits(this.low, this.high, true);
		};
		/**
		* Converts this Long to its byte representation.
		* @param {boolean=} le Whether little or big endian, defaults to big endian
		* @this {!Long}
		* @returns {!Array.<number>} Byte representation
		*/
		LongPrototype.toBytes = function toBytes(le) {
			return le ? this.toBytesLE() : this.toBytesBE();
		};
		/**
		* Converts this Long to its little endian byte representation.
		* @this {!Long}
		* @returns {!Array.<number>} Little endian byte representation
		*/
		LongPrototype.toBytesLE = function toBytesLE() {
			var hi = this.high, lo = this.low;
			return [
				lo & 255,
				lo >>> 8 & 255,
				lo >>> 16 & 255,
				lo >>> 24,
				hi & 255,
				hi >>> 8 & 255,
				hi >>> 16 & 255,
				hi >>> 24
			];
		};
		/**
		* Converts this Long to its big endian byte representation.
		* @this {!Long}
		* @returns {!Array.<number>} Big endian byte representation
		*/
		LongPrototype.toBytesBE = function toBytesBE() {
			var hi = this.high, lo = this.low;
			return [
				hi >>> 24,
				hi >>> 16 & 255,
				hi >>> 8 & 255,
				hi & 255,
				lo >>> 24,
				lo >>> 16 & 255,
				lo >>> 8 & 255,
				lo & 255
			];
		};
		/**
		* Creates a Long from its byte representation.
		* @param {!Array.<number>} bytes Byte representation
		* @param {boolean=} unsigned Whether unsigned or not, defaults to signed
		* @param {boolean=} le Whether little or big endian, defaults to big endian
		* @returns {Long} The corresponding Long value
		*/
		Long.fromBytes = function fromBytes(bytes, unsigned, le) {
			return le ? Long.fromBytesLE(bytes, unsigned) : Long.fromBytesBE(bytes, unsigned);
		};
		/**
		* Creates a Long from its little endian byte representation.
		* @param {!Array.<number>} bytes Little endian byte representation
		* @param {boolean=} unsigned Whether unsigned or not, defaults to signed
		* @returns {Long} The corresponding Long value
		*/
		Long.fromBytesLE = function fromBytesLE(bytes, unsigned) {
			return new Long(bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24, bytes[4] | bytes[5] << 8 | bytes[6] << 16 | bytes[7] << 24, unsigned);
		};
		/**
		* Creates a Long from its big endian byte representation.
		* @param {!Array.<number>} bytes Big endian byte representation
		* @param {boolean=} unsigned Whether unsigned or not, defaults to signed
		* @returns {Long} The corresponding Long value
		*/
		Long.fromBytesBE = function fromBytesBE(bytes, unsigned) {
			return new Long(bytes[4] << 24 | bytes[5] << 16 | bytes[6] << 8 | bytes[7], bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3], unsigned);
		};
		if (typeof BigInt === "function") {
			/**
			* Returns a Long representing the given big integer.
			* @function
			* @param {number} value The big integer value
			* @param {boolean=} unsigned Whether unsigned or not, defaults to signed
			* @returns {!Long} The corresponding Long value
			*/
			Long.fromBigInt = function fromBigInt(value, unsigned) {
				return fromBits(Number(BigInt.asIntN(32, value)), Number(BigInt.asIntN(32, value >> BigInt(32))), unsigned);
			};
			Long.fromValue = function fromValueWithBigInt(value, unsigned) {
				if (typeof value === "bigint") return Long.fromBigInt(value, unsigned);
				return fromValue(value, unsigned);
			};
			/**
			* Converts the Long to its big integer representation.
			* @this {!Long}
			* @returns {bigint}
			*/
			LongPrototype.toBigInt = function toBigInt() {
				var lowBigInt = BigInt(this.low >>> 0);
				return BigInt(this.unsigned ? this.high >>> 0 : this.high) << BigInt(32) | lowBigInt;
			};
		}
		_exports.default = Long;
	});
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+proto-loader@0.8.0/node_modules/@grpc/proto-loader/build/src/index.js
var require_src$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* @license
	* Copyright 2018 gRPC authors.
	*
	* Licensed under the Apache License, Version 2.0 (the "License");
	* you may not use this file except in compliance with the License.
	* You may obtain a copy of the License at
	*
	*     http://www.apache.org/licenses/LICENSE-2.0
	*
	* Unless required by applicable law or agreed to in writing, software
	* distributed under the License is distributed on an "AS IS" BASIS,
	* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	* See the License for the specific language governing permissions and
	* limitations under the License.
	*
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.loadFileDescriptorSetFromObject = exports.loadFileDescriptorSetFromBuffer = exports.fromJSON = exports.loadSync = exports.load = exports.IdempotencyLevel = exports.isAnyExtension = exports.Long = void 0;
	const camelCase = require_lodash_camelcase();
	const Protobuf = require_protobufjs();
	const descriptor = require_descriptor();
	const util_1 = require_util();
	exports.Long = require_umd();
	function isAnyExtension(obj) {
		return "@type" in obj && typeof obj["@type"] === "string";
	}
	exports.isAnyExtension = isAnyExtension;
	var IdempotencyLevel;
	(function(IdempotencyLevel) {
		IdempotencyLevel["IDEMPOTENCY_UNKNOWN"] = "IDEMPOTENCY_UNKNOWN";
		IdempotencyLevel["NO_SIDE_EFFECTS"] = "NO_SIDE_EFFECTS";
		IdempotencyLevel["IDEMPOTENT"] = "IDEMPOTENT";
	})(IdempotencyLevel = exports.IdempotencyLevel || (exports.IdempotencyLevel = {}));
	const descriptorOptions = {
		longs: String,
		enums: String,
		bytes: String,
		defaults: true,
		oneofs: true,
		json: true
	};
	function joinName(baseName, name) {
		if (baseName === "") return name;
		else return baseName + "." + name;
	}
	function isHandledReflectionObject(obj) {
		return obj instanceof Protobuf.Service || obj instanceof Protobuf.Type || obj instanceof Protobuf.Enum;
	}
	function isNamespaceBase(obj) {
		return obj instanceof Protobuf.Namespace || obj instanceof Protobuf.Root;
	}
	function getAllHandledReflectionObjects(obj, parentName) {
		const objName = joinName(parentName, obj.name);
		if (isHandledReflectionObject(obj)) return [[objName, obj]];
		else if (isNamespaceBase(obj) && typeof obj.nested !== "undefined") return Object.keys(obj.nested).map((name) => {
			return getAllHandledReflectionObjects(obj.nested[name], objName);
		}).reduce((accumulator, currentValue) => accumulator.concat(currentValue), []);
		return [];
	}
	function createDeserializer(cls, options) {
		return function deserialize(argBuf) {
			return cls.toObject(cls.decode(argBuf), options);
		};
	}
	function createSerializer(cls) {
		return function serialize(arg) {
			if (Array.isArray(arg)) throw new Error(`Failed to serialize message: expected object with ${cls.name} structure, got array instead`);
			const message = cls.fromObject(arg);
			return cls.encode(message).finish();
		};
	}
	function mapMethodOptions(options) {
		return (options || []).reduce((obj, item) => {
			for (const [key, value] of Object.entries(item)) switch (key) {
				case "uninterpreted_option":
					obj.uninterpreted_option.push(item.uninterpreted_option);
					break;
				default: obj[key] = value;
			}
			return obj;
		}, {
			deprecated: false,
			idempotency_level: IdempotencyLevel.IDEMPOTENCY_UNKNOWN,
			uninterpreted_option: []
		});
	}
	function createMethodDefinition(method, serviceName, options, fileDescriptors) {
		const requestType = method.resolvedRequestType;
		const responseType = method.resolvedResponseType;
		return {
			path: "/" + serviceName + "/" + method.name,
			requestStream: !!method.requestStream,
			responseStream: !!method.responseStream,
			requestSerialize: createSerializer(requestType),
			requestDeserialize: createDeserializer(requestType, options),
			responseSerialize: createSerializer(responseType),
			responseDeserialize: createDeserializer(responseType, options),
			originalName: camelCase(method.name),
			requestType: createMessageDefinition(requestType, options, fileDescriptors),
			responseType: createMessageDefinition(responseType, options, fileDescriptors),
			options: mapMethodOptions(method.parsedOptions)
		};
	}
	function createServiceDefinition(service, name, options, fileDescriptors) {
		const def = {};
		for (const method of service.methodsArray) def[method.name] = createMethodDefinition(method, name, options, fileDescriptors);
		return def;
	}
	function createMessageDefinition(message, options, fileDescriptors) {
		const messageDescriptor = message.toDescriptor("proto3");
		return {
			format: "Protocol Buffer 3 DescriptorProto",
			type: messageDescriptor.$type.toObject(messageDescriptor, descriptorOptions),
			fileDescriptorProtos: fileDescriptors,
			serialize: createSerializer(message),
			deserialize: createDeserializer(message, options)
		};
	}
	function createEnumDefinition(enumType, fileDescriptors) {
		const enumDescriptor = enumType.toDescriptor("proto3");
		return {
			format: "Protocol Buffer 3 EnumDescriptorProto",
			type: enumDescriptor.$type.toObject(enumDescriptor, descriptorOptions),
			fileDescriptorProtos: fileDescriptors
		};
	}
	/**
	* function createDefinition(obj: Protobuf.Service, name: string, options:
	* Options): ServiceDefinition; function createDefinition(obj: Protobuf.Type,
	* name: string, options: Options): MessageTypeDefinition; function
	* createDefinition(obj: Protobuf.Enum, name: string, options: Options):
	* EnumTypeDefinition;
	*/
	function createDefinition(obj, name, options, fileDescriptors) {
		if (obj instanceof Protobuf.Service) return createServiceDefinition(obj, name, options, fileDescriptors);
		else if (obj instanceof Protobuf.Type) return createMessageDefinition(obj, options, fileDescriptors);
		else if (obj instanceof Protobuf.Enum) return createEnumDefinition(obj, fileDescriptors);
		else throw new Error("Type mismatch in reflection object handling");
	}
	function createPackageDefinition(root, options) {
		const def = {};
		root.resolveAll();
		const bufferList = root.toDescriptor("proto3").file.map((value) => Buffer.from(descriptor.FileDescriptorProto.encode(value).finish()));
		for (const [name, obj] of getAllHandledReflectionObjects(root, "")) def[name] = createDefinition(obj, name, options, bufferList);
		return def;
	}
	function createPackageDefinitionFromDescriptorSet(decodedDescriptorSet, options) {
		options = options || {};
		const root = Protobuf.Root.fromDescriptor(decodedDescriptorSet);
		root.resolveAll();
		return createPackageDefinition(root, options);
	}
	/**
	* Load a .proto file with the specified options.
	* @param filename One or multiple file paths to load. Can be an absolute path
	*     or relative to an include path.
	* @param options.keepCase Preserve field names. The default is to change them
	*     to camel case.
	* @param options.longs The type that should be used to represent `long` values.
	*     Valid options are `Number` and `String`. Defaults to a `Long` object type
	*     from a library.
	* @param options.enums The type that should be used to represent `enum` values.
	*     The only valid option is `String`. Defaults to the numeric value.
	* @param options.bytes The type that should be used to represent `bytes`
	*     values. Valid options are `Array` and `String`. The default is to use
	*     `Buffer`.
	* @param options.defaults Set default values on output objects. Defaults to
	*     `false`.
	* @param options.arrays Set empty arrays for missing array values even if
	*     `defaults` is `false`. Defaults to `false`.
	* @param options.objects Set empty objects for missing object values even if
	*     `defaults` is `false`. Defaults to `false`.
	* @param options.oneofs Set virtual oneof properties to the present field's
	*     name
	* @param options.json Represent Infinity and NaN as strings in float fields,
	*     and automatically decode google.protobuf.Any values.
	* @param options.includeDirs Paths to search for imported `.proto` files.
	*/
	function load(filename, options) {
		return (0, util_1.loadProtosWithOptions)(filename, options).then((loadedRoot) => {
			return createPackageDefinition(loadedRoot, options);
		});
	}
	exports.load = load;
	function loadSync(filename, options) {
		return createPackageDefinition((0, util_1.loadProtosWithOptionsSync)(filename, options), options);
	}
	exports.loadSync = loadSync;
	function fromJSON(json, options) {
		options = options || {};
		const loadedRoot = Protobuf.Root.fromJSON(json);
		loadedRoot.resolveAll();
		return createPackageDefinition(loadedRoot, options);
	}
	exports.fromJSON = fromJSON;
	function loadFileDescriptorSetFromBuffer(descriptorSet, options) {
		return createPackageDefinitionFromDescriptorSet(descriptor.FileDescriptorSet.decode(descriptorSet), options);
	}
	exports.loadFileDescriptorSetFromBuffer = loadFileDescriptorSetFromBuffer;
	function loadFileDescriptorSetFromObject(descriptorSet, options) {
		return createPackageDefinitionFromDescriptorSet(descriptor.FileDescriptorSet.fromObject(descriptorSet), options);
	}
	exports.loadFileDescriptorSetFromObject = loadFileDescriptorSetFromObject;
	(0, util_1.addCommonProtos)();
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/channelz.js
var require_channelz = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.registerChannelzSocket = exports.registerChannelzServer = exports.registerChannelzSubchannel = exports.registerChannelzChannel = exports.ChannelzCallTrackerStub = exports.ChannelzCallTracker = exports.ChannelzChildrenTrackerStub = exports.ChannelzChildrenTracker = exports.ChannelzTrace = exports.ChannelzTraceStub = void 0;
	exports.unregisterChannelzRef = unregisterChannelzRef;
	exports.getChannelzHandlers = getChannelzHandlers;
	exports.getChannelzServiceDefinition = getChannelzServiceDefinition;
	exports.setup = setup;
	const net_1$4 = __require("net");
	const ordered_map_1 = require_cjs();
	const connectivity_state_1 = require_connectivity_state();
	const constants_1 = require_constants();
	const subchannel_address_1 = require_subchannel_address();
	const admin_1 = require_admin();
	const make_client_1 = require_make_client();
	function channelRefToMessage(ref) {
		return {
			channel_id: ref.id,
			name: ref.name
		};
	}
	function subchannelRefToMessage(ref) {
		return {
			subchannel_id: ref.id,
			name: ref.name
		};
	}
	function serverRefToMessage(ref) {
		return { server_id: ref.id };
	}
	function socketRefToMessage(ref) {
		return {
			socket_id: ref.id,
			name: ref.name
		};
	}
	/**
	* The loose upper bound on the number of events that should be retained in a
	* trace. This may be exceeded by up to a factor of 2. Arbitrarily chosen as a
	* number that should be large enough to contain the recent relevant
	* information, but small enough to not use excessive memory.
	*/
	const TARGET_RETAINED_TRACES = 32;
	/**
	* Default number of sockets/servers/channels/subchannels to return
	*/
	const DEFAULT_MAX_RESULTS = 100;
	var ChannelzTraceStub = class {
		constructor() {
			this.events = [];
			this.creationTimestamp = /* @__PURE__ */ new Date();
			this.eventsLogged = 0;
		}
		addTrace() {}
		getTraceMessage() {
			return {
				creation_timestamp: dateToProtoTimestamp(this.creationTimestamp),
				num_events_logged: this.eventsLogged,
				events: []
			};
		}
	};
	exports.ChannelzTraceStub = ChannelzTraceStub;
	var ChannelzTrace = class {
		constructor() {
			this.events = [];
			this.eventsLogged = 0;
			this.creationTimestamp = /* @__PURE__ */ new Date();
		}
		addTrace(severity, description, child) {
			const timestamp = /* @__PURE__ */ new Date();
			this.events.push({
				description,
				severity,
				timestamp,
				childChannel: (child === null || child === void 0 ? void 0 : child.kind) === "channel" ? child : void 0,
				childSubchannel: (child === null || child === void 0 ? void 0 : child.kind) === "subchannel" ? child : void 0
			});
			if (this.events.length >= TARGET_RETAINED_TRACES * 2) this.events = this.events.slice(TARGET_RETAINED_TRACES);
			this.eventsLogged += 1;
		}
		getTraceMessage() {
			return {
				creation_timestamp: dateToProtoTimestamp(this.creationTimestamp),
				num_events_logged: this.eventsLogged,
				events: this.events.map((event) => {
					return {
						description: event.description,
						severity: event.severity,
						timestamp: dateToProtoTimestamp(event.timestamp),
						channel_ref: event.childChannel ? channelRefToMessage(event.childChannel) : null,
						subchannel_ref: event.childSubchannel ? subchannelRefToMessage(event.childSubchannel) : null
					};
				})
			};
		}
	};
	exports.ChannelzTrace = ChannelzTrace;
	var ChannelzChildrenTracker = class {
		constructor() {
			this.channelChildren = new ordered_map_1.OrderedMap();
			this.subchannelChildren = new ordered_map_1.OrderedMap();
			this.socketChildren = new ordered_map_1.OrderedMap();
			this.trackerMap = {
				["channel"]: this.channelChildren,
				["subchannel"]: this.subchannelChildren,
				["socket"]: this.socketChildren
			};
		}
		refChild(child) {
			const tracker = this.trackerMap[child.kind];
			const trackedChild = tracker.find(child.id);
			if (trackedChild.equals(tracker.end())) tracker.setElement(child.id, {
				ref: child,
				count: 1
			}, trackedChild);
			else trackedChild.pointer[1].count += 1;
		}
		unrefChild(child) {
			const tracker = this.trackerMap[child.kind];
			const trackedChild = tracker.getElementByKey(child.id);
			if (trackedChild !== void 0) {
				trackedChild.count -= 1;
				if (trackedChild.count === 0) tracker.eraseElementByKey(child.id);
			}
		}
		getChildLists() {
			return {
				channels: this.channelChildren,
				subchannels: this.subchannelChildren,
				sockets: this.socketChildren
			};
		}
	};
	exports.ChannelzChildrenTracker = ChannelzChildrenTracker;
	var ChannelzChildrenTrackerStub = class extends ChannelzChildrenTracker {
		refChild() {}
		unrefChild() {}
	};
	exports.ChannelzChildrenTrackerStub = ChannelzChildrenTrackerStub;
	var ChannelzCallTracker = class {
		constructor() {
			this.callsStarted = 0;
			this.callsSucceeded = 0;
			this.callsFailed = 0;
			this.lastCallStartedTimestamp = null;
		}
		addCallStarted() {
			this.callsStarted += 1;
			this.lastCallStartedTimestamp = /* @__PURE__ */ new Date();
		}
		addCallSucceeded() {
			this.callsSucceeded += 1;
		}
		addCallFailed() {
			this.callsFailed += 1;
		}
	};
	exports.ChannelzCallTracker = ChannelzCallTracker;
	var ChannelzCallTrackerStub = class extends ChannelzCallTracker {
		addCallStarted() {}
		addCallSucceeded() {}
		addCallFailed() {}
	};
	exports.ChannelzCallTrackerStub = ChannelzCallTrackerStub;
	const entityMaps = {
		["channel"]: new ordered_map_1.OrderedMap(),
		["subchannel"]: new ordered_map_1.OrderedMap(),
		["server"]: new ordered_map_1.OrderedMap(),
		["socket"]: new ordered_map_1.OrderedMap()
	};
	const generateRegisterFn = (kind) => {
		let nextId = 1;
		function getNextId() {
			return nextId++;
		}
		const entityMap = entityMaps[kind];
		return (name, getInfo, channelzEnabled) => {
			const id = getNextId();
			const ref = {
				id,
				name,
				kind
			};
			if (channelzEnabled) entityMap.setElement(id, {
				ref,
				getInfo
			});
			return ref;
		};
	};
	exports.registerChannelzChannel = generateRegisterFn("channel");
	exports.registerChannelzSubchannel = generateRegisterFn("subchannel");
	exports.registerChannelzServer = generateRegisterFn("server");
	exports.registerChannelzSocket = generateRegisterFn("socket");
	function unregisterChannelzRef(ref) {
		entityMaps[ref.kind].eraseElementByKey(ref.id);
	}
	/**
	* Parse a single section of an IPv6 address as two bytes
	* @param addressSection A hexadecimal string of length up to 4
	* @returns The pair of bytes representing this address section
	*/
	function parseIPv6Section(addressSection) {
		const numberValue = Number.parseInt(addressSection, 16);
		return [numberValue / 256 | 0, numberValue % 256];
	}
	/**
	* Parse a chunk of an IPv6 address string to some number of bytes
	* @param addressChunk Some number of segments of up to 4 hexadecimal
	*   characters each, joined by colons.
	* @returns The list of bytes representing this address chunk
	*/
	function parseIPv6Chunk(addressChunk) {
		if (addressChunk === "") return [];
		const bytePairs = addressChunk.split(":").map((section) => parseIPv6Section(section));
		return [].concat(...bytePairs);
	}
	function isIPv6MappedIPv4(ipAddress) {
		return (0, net_1$4.isIPv6)(ipAddress) && ipAddress.toLowerCase().startsWith("::ffff:") && (0, net_1$4.isIPv4)(ipAddress.substring(7));
	}
	/**
	* Prerequisite: isIPv4(ipAddress)
	* @param ipAddress
	* @returns
	*/
	function ipv4AddressStringToBuffer(ipAddress) {
		return Buffer.from(Uint8Array.from(ipAddress.split(".").map((segment) => Number.parseInt(segment))));
	}
	/**
	* Converts an IPv4 or IPv6 address from string representation to binary
	* representation
	* @param ipAddress an IP address in standard IPv4 or IPv6 text format
	* @returns
	*/
	function ipAddressStringToBuffer(ipAddress) {
		if ((0, net_1$4.isIPv4)(ipAddress)) return ipv4AddressStringToBuffer(ipAddress);
		else if (isIPv6MappedIPv4(ipAddress)) return ipv4AddressStringToBuffer(ipAddress.substring(7));
		else if ((0, net_1$4.isIPv6)(ipAddress)) {
			let leftSection;
			let rightSection;
			const doubleColonIndex = ipAddress.indexOf("::");
			if (doubleColonIndex === -1) {
				leftSection = ipAddress;
				rightSection = "";
			} else {
				leftSection = ipAddress.substring(0, doubleColonIndex);
				rightSection = ipAddress.substring(doubleColonIndex + 2);
			}
			const leftBuffer = Buffer.from(parseIPv6Chunk(leftSection));
			const rightBuffer = Buffer.from(parseIPv6Chunk(rightSection));
			const middleBuffer = Buffer.alloc(16 - leftBuffer.length - rightBuffer.length, 0);
			return Buffer.concat([
				leftBuffer,
				middleBuffer,
				rightBuffer
			]);
		} else return null;
	}
	function connectivityStateToMessage(state) {
		switch (state) {
			case connectivity_state_1.ConnectivityState.CONNECTING: return { state: "CONNECTING" };
			case connectivity_state_1.ConnectivityState.IDLE: return { state: "IDLE" };
			case connectivity_state_1.ConnectivityState.READY: return { state: "READY" };
			case connectivity_state_1.ConnectivityState.SHUTDOWN: return { state: "SHUTDOWN" };
			case connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE: return { state: "TRANSIENT_FAILURE" };
			default: return { state: "UNKNOWN" };
		}
	}
	function dateToProtoTimestamp(date) {
		if (!date) return null;
		const millisSinceEpoch = date.getTime();
		return {
			seconds: millisSinceEpoch / 1e3 | 0,
			nanos: millisSinceEpoch % 1e3 * 1e6
		};
	}
	function getChannelMessage(channelEntry) {
		const resolvedInfo = channelEntry.getInfo();
		const channelRef = [];
		const subchannelRef = [];
		resolvedInfo.children.channels.forEach((el) => {
			channelRef.push(channelRefToMessage(el[1].ref));
		});
		resolvedInfo.children.subchannels.forEach((el) => {
			subchannelRef.push(subchannelRefToMessage(el[1].ref));
		});
		return {
			ref: channelRefToMessage(channelEntry.ref),
			data: {
				target: resolvedInfo.target,
				state: connectivityStateToMessage(resolvedInfo.state),
				calls_started: resolvedInfo.callTracker.callsStarted,
				calls_succeeded: resolvedInfo.callTracker.callsSucceeded,
				calls_failed: resolvedInfo.callTracker.callsFailed,
				last_call_started_timestamp: dateToProtoTimestamp(resolvedInfo.callTracker.lastCallStartedTimestamp),
				trace: resolvedInfo.trace.getTraceMessage()
			},
			channel_ref: channelRef,
			subchannel_ref: subchannelRef
		};
	}
	function GetChannel(call, callback) {
		const channelId = parseInt(call.request.channel_id, 10);
		const channelEntry = entityMaps["channel"].getElementByKey(channelId);
		if (channelEntry === void 0) {
			callback({
				code: constants_1.Status.NOT_FOUND,
				details: "No channel data found for id " + channelId
			});
			return;
		}
		callback(null, { channel: getChannelMessage(channelEntry) });
	}
	function GetTopChannels(call, callback) {
		const maxResults = parseInt(call.request.max_results, 10) || DEFAULT_MAX_RESULTS;
		const resultList = [];
		const startId = parseInt(call.request.start_channel_id, 10);
		const channelEntries = entityMaps["channel"];
		let i;
		for (i = channelEntries.lowerBound(startId); !i.equals(channelEntries.end()) && resultList.length < maxResults; i = i.next()) resultList.push(getChannelMessage(i.pointer[1]));
		callback(null, {
			channel: resultList,
			end: i.equals(channelEntries.end())
		});
	}
	function getServerMessage(serverEntry) {
		const resolvedInfo = serverEntry.getInfo();
		const listenSocket = [];
		resolvedInfo.listenerChildren.sockets.forEach((el) => {
			listenSocket.push(socketRefToMessage(el[1].ref));
		});
		return {
			ref: serverRefToMessage(serverEntry.ref),
			data: {
				calls_started: resolvedInfo.callTracker.callsStarted,
				calls_succeeded: resolvedInfo.callTracker.callsSucceeded,
				calls_failed: resolvedInfo.callTracker.callsFailed,
				last_call_started_timestamp: dateToProtoTimestamp(resolvedInfo.callTracker.lastCallStartedTimestamp),
				trace: resolvedInfo.trace.getTraceMessage()
			},
			listen_socket: listenSocket
		};
	}
	function GetServer(call, callback) {
		const serverId = parseInt(call.request.server_id, 10);
		const serverEntry = entityMaps["server"].getElementByKey(serverId);
		if (serverEntry === void 0) {
			callback({
				code: constants_1.Status.NOT_FOUND,
				details: "No server data found for id " + serverId
			});
			return;
		}
		callback(null, { server: getServerMessage(serverEntry) });
	}
	function GetServers(call, callback) {
		const maxResults = parseInt(call.request.max_results, 10) || DEFAULT_MAX_RESULTS;
		const startId = parseInt(call.request.start_server_id, 10);
		const serverEntries = entityMaps["server"];
		const resultList = [];
		let i;
		for (i = serverEntries.lowerBound(startId); !i.equals(serverEntries.end()) && resultList.length < maxResults; i = i.next()) resultList.push(getServerMessage(i.pointer[1]));
		callback(null, {
			server: resultList,
			end: i.equals(serverEntries.end())
		});
	}
	function GetSubchannel(call, callback) {
		const subchannelId = parseInt(call.request.subchannel_id, 10);
		const subchannelEntry = entityMaps["subchannel"].getElementByKey(subchannelId);
		if (subchannelEntry === void 0) {
			callback({
				code: constants_1.Status.NOT_FOUND,
				details: "No subchannel data found for id " + subchannelId
			});
			return;
		}
		const resolvedInfo = subchannelEntry.getInfo();
		const listenSocket = [];
		resolvedInfo.children.sockets.forEach((el) => {
			listenSocket.push(socketRefToMessage(el[1].ref));
		});
		callback(null, { subchannel: {
			ref: subchannelRefToMessage(subchannelEntry.ref),
			data: {
				target: resolvedInfo.target,
				state: connectivityStateToMessage(resolvedInfo.state),
				calls_started: resolvedInfo.callTracker.callsStarted,
				calls_succeeded: resolvedInfo.callTracker.callsSucceeded,
				calls_failed: resolvedInfo.callTracker.callsFailed,
				last_call_started_timestamp: dateToProtoTimestamp(resolvedInfo.callTracker.lastCallStartedTimestamp),
				trace: resolvedInfo.trace.getTraceMessage()
			},
			socket_ref: listenSocket
		} });
	}
	function subchannelAddressToAddressMessage(subchannelAddress) {
		var _a;
		if ((0, subchannel_address_1.isTcpSubchannelAddress)(subchannelAddress)) return {
			address: "tcpip_address",
			tcpip_address: {
				ip_address: (_a = ipAddressStringToBuffer(subchannelAddress.host)) !== null && _a !== void 0 ? _a : void 0,
				port: subchannelAddress.port
			}
		};
		else return {
			address: "uds_address",
			uds_address: { filename: subchannelAddress.path }
		};
	}
	function GetSocket(call, callback) {
		var _a, _b, _c, _d, _e;
		const socketId = parseInt(call.request.socket_id, 10);
		const socketEntry = entityMaps["socket"].getElementByKey(socketId);
		if (socketEntry === void 0) {
			callback({
				code: constants_1.Status.NOT_FOUND,
				details: "No socket data found for id " + socketId
			});
			return;
		}
		const resolvedInfo = socketEntry.getInfo();
		const securityMessage = resolvedInfo.security ? {
			model: "tls",
			tls: {
				cipher_suite: resolvedInfo.security.cipherSuiteStandardName ? "standard_name" : "other_name",
				standard_name: (_a = resolvedInfo.security.cipherSuiteStandardName) !== null && _a !== void 0 ? _a : void 0,
				other_name: (_b = resolvedInfo.security.cipherSuiteOtherName) !== null && _b !== void 0 ? _b : void 0,
				local_certificate: (_c = resolvedInfo.security.localCertificate) !== null && _c !== void 0 ? _c : void 0,
				remote_certificate: (_d = resolvedInfo.security.remoteCertificate) !== null && _d !== void 0 ? _d : void 0
			}
		} : null;
		callback(null, { socket: {
			ref: socketRefToMessage(socketEntry.ref),
			local: resolvedInfo.localAddress ? subchannelAddressToAddressMessage(resolvedInfo.localAddress) : null,
			remote: resolvedInfo.remoteAddress ? subchannelAddressToAddressMessage(resolvedInfo.remoteAddress) : null,
			remote_name: (_e = resolvedInfo.remoteName) !== null && _e !== void 0 ? _e : void 0,
			security: securityMessage,
			data: {
				keep_alives_sent: resolvedInfo.keepAlivesSent,
				streams_started: resolvedInfo.streamsStarted,
				streams_succeeded: resolvedInfo.streamsSucceeded,
				streams_failed: resolvedInfo.streamsFailed,
				last_local_stream_created_timestamp: dateToProtoTimestamp(resolvedInfo.lastLocalStreamCreatedTimestamp),
				last_remote_stream_created_timestamp: dateToProtoTimestamp(resolvedInfo.lastRemoteStreamCreatedTimestamp),
				messages_received: resolvedInfo.messagesReceived,
				messages_sent: resolvedInfo.messagesSent,
				last_message_received_timestamp: dateToProtoTimestamp(resolvedInfo.lastMessageReceivedTimestamp),
				last_message_sent_timestamp: dateToProtoTimestamp(resolvedInfo.lastMessageSentTimestamp),
				local_flow_control_window: resolvedInfo.localFlowControlWindow ? { value: resolvedInfo.localFlowControlWindow } : null,
				remote_flow_control_window: resolvedInfo.remoteFlowControlWindow ? { value: resolvedInfo.remoteFlowControlWindow } : null
			}
		} });
	}
	function GetServerSockets(call, callback) {
		const serverId = parseInt(call.request.server_id, 10);
		const serverEntry = entityMaps["server"].getElementByKey(serverId);
		if (serverEntry === void 0) {
			callback({
				code: constants_1.Status.NOT_FOUND,
				details: "No server data found for id " + serverId
			});
			return;
		}
		const startId = parseInt(call.request.start_socket_id, 10);
		const maxResults = parseInt(call.request.max_results, 10) || DEFAULT_MAX_RESULTS;
		const allSockets = serverEntry.getInfo().sessionChildren.sockets;
		const resultList = [];
		let i;
		for (i = allSockets.lowerBound(startId); !i.equals(allSockets.end()) && resultList.length < maxResults; i = i.next()) resultList.push(socketRefToMessage(i.pointer[1].ref));
		callback(null, {
			socket_ref: resultList,
			end: i.equals(allSockets.end())
		});
	}
	function getChannelzHandlers() {
		return {
			GetChannel,
			GetTopChannels,
			GetServer,
			GetServers,
			GetSubchannel,
			GetSocket,
			GetServerSockets
		};
	}
	let loadedChannelzDefinition = null;
	function getChannelzServiceDefinition() {
		if (loadedChannelzDefinition) return loadedChannelzDefinition;
		const loaderLoadSync = require_src$1().loadSync;
		const loadedProto = loaderLoadSync("channelz.proto", {
			keepCase: true,
			longs: String,
			enums: String,
			defaults: true,
			oneofs: true,
			includeDirs: [`${__dirname}/../../proto`]
		});
		loadedChannelzDefinition = (0, make_client_1.loadPackageDefinition)(loadedProto).grpc.channelz.v1.Channelz.service;
		return loadedChannelzDefinition;
	}
	function setup() {
		(0, admin_1.registerAdminService)(getChannelzServiceDefinition, getChannelzHandlers);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/call-number.js
var require_call_number = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getNextCallNumber = getNextCallNumber;
	let nextCallNumber = 0;
	function getNextCallNumber() {
		return nextCallNumber++;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/compression-algorithms.js
var require_compression_algorithms = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CompressionAlgorithms = void 0;
	var CompressionAlgorithms;
	(function(CompressionAlgorithms) {
		CompressionAlgorithms[CompressionAlgorithms["identity"] = 0] = "identity";
		CompressionAlgorithms[CompressionAlgorithms["deflate"] = 1] = "deflate";
		CompressionAlgorithms[CompressionAlgorithms["gzip"] = 2] = "gzip";
	})(CompressionAlgorithms || (exports.CompressionAlgorithms = CompressionAlgorithms = {}));
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/filter.js
var require_filter = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.BaseFilter = void 0;
	var BaseFilter = class {
		async sendMetadata(metadata) {
			return metadata;
		}
		receiveMetadata(metadata) {
			return metadata;
		}
		async sendMessage(message) {
			return message;
		}
		async receiveMessage(message) {
			return message;
		}
		receiveTrailers(status) {
			return status;
		}
	};
	exports.BaseFilter = BaseFilter;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/compression-filter.js
var require_compression_filter = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CompressionFilterFactory = exports.CompressionFilter = void 0;
	const zlib$1 = __require("zlib");
	const compression_algorithms_1 = require_compression_algorithms();
	const constants_1 = require_constants();
	const filter_1 = require_filter();
	const logging = require_logging();
	const isCompressionAlgorithmKey = (key) => {
		return typeof key === "number" && typeof compression_algorithms_1.CompressionAlgorithms[key] === "string";
	};
	var CompressionHandler = class {
		/**
		* @param message Raw uncompressed message bytes
		* @param compress Indicates whether the message should be compressed
		* @return Framed message, compressed if applicable
		*/
		async writeMessage(message, compress) {
			let messageBuffer = message;
			if (compress) messageBuffer = await this.compressMessage(messageBuffer);
			const output = Buffer.allocUnsafe(messageBuffer.length + 5);
			output.writeUInt8(compress ? 1 : 0, 0);
			output.writeUInt32BE(messageBuffer.length, 1);
			messageBuffer.copy(output, 5);
			return output;
		}
		/**
		* @param data Framed message, possibly compressed
		* @return Uncompressed message
		*/
		async readMessage(data) {
			const compressed = data.readUInt8(0) === 1;
			let messageBuffer = data.slice(5);
			if (compressed) messageBuffer = await this.decompressMessage(messageBuffer);
			return messageBuffer;
		}
	};
	var IdentityHandler = class extends CompressionHandler {
		async compressMessage(message) {
			return message;
		}
		async writeMessage(message, compress) {
			const output = Buffer.allocUnsafe(message.length + 5);
			output.writeUInt8(0, 0);
			output.writeUInt32BE(message.length, 1);
			message.copy(output, 5);
			return output;
		}
		decompressMessage(message) {
			return Promise.reject(/* @__PURE__ */ new Error("Received compressed message but \"grpc-encoding\" header was identity"));
		}
	};
	var DeflateHandler = class extends CompressionHandler {
		constructor(maxRecvMessageLength) {
			super();
			this.maxRecvMessageLength = maxRecvMessageLength;
		}
		compressMessage(message) {
			return new Promise((resolve, reject) => {
				zlib$1.deflate(message, (err, output) => {
					if (err) reject(err);
					else resolve(output);
				});
			});
		}
		decompressMessage(message) {
			return new Promise((resolve, reject) => {
				let totalLength = 0;
				const messageParts = [];
				const decompresser = zlib$1.createInflate();
				decompresser.on("data", (chunk) => {
					messageParts.push(chunk);
					totalLength += chunk.byteLength;
					if (this.maxRecvMessageLength !== -1 && totalLength > this.maxRecvMessageLength) {
						decompresser.destroy();
						reject({
							code: constants_1.Status.RESOURCE_EXHAUSTED,
							details: `Received message that decompresses to a size larger than ${this.maxRecvMessageLength}`
						});
					}
				});
				decompresser.on("end", () => {
					resolve(Buffer.concat(messageParts));
				});
				decompresser.write(message);
				decompresser.end();
			});
		}
	};
	var GzipHandler = class extends CompressionHandler {
		constructor(maxRecvMessageLength) {
			super();
			this.maxRecvMessageLength = maxRecvMessageLength;
		}
		compressMessage(message) {
			return new Promise((resolve, reject) => {
				zlib$1.gzip(message, (err, output) => {
					if (err) reject(err);
					else resolve(output);
				});
			});
		}
		decompressMessage(message) {
			return new Promise((resolve, reject) => {
				let totalLength = 0;
				const messageParts = [];
				const decompresser = zlib$1.createGunzip();
				decompresser.on("data", (chunk) => {
					messageParts.push(chunk);
					totalLength += chunk.byteLength;
					if (this.maxRecvMessageLength !== -1 && totalLength > this.maxRecvMessageLength) {
						decompresser.destroy();
						reject({
							code: constants_1.Status.RESOURCE_EXHAUSTED,
							details: `Received message that decompresses to a size larger than ${this.maxRecvMessageLength}`
						});
					}
				});
				decompresser.on("end", () => {
					resolve(Buffer.concat(messageParts));
				});
				decompresser.write(message);
				decompresser.end();
			});
		}
	};
	var UnknownHandler = class extends CompressionHandler {
		constructor(compressionName) {
			super();
			this.compressionName = compressionName;
		}
		compressMessage(message) {
			return Promise.reject(/* @__PURE__ */ new Error(`Received message compressed with unsupported compression method ${this.compressionName}`));
		}
		decompressMessage(message) {
			return Promise.reject(/* @__PURE__ */ new Error(`Compression method not supported: ${this.compressionName}`));
		}
	};
	function getCompressionHandler(compressionName, maxReceiveMessageSize) {
		switch (compressionName) {
			case "identity": return new IdentityHandler();
			case "deflate": return new DeflateHandler(maxReceiveMessageSize);
			case "gzip": return new GzipHandler(maxReceiveMessageSize);
			default: return new UnknownHandler(compressionName);
		}
	}
	var CompressionFilter = class extends filter_1.BaseFilter {
		constructor(channelOptions, sharedFilterConfig) {
			var _a, _b, _c;
			super();
			this.sharedFilterConfig = sharedFilterConfig;
			this.sendCompression = new IdentityHandler();
			this.receiveCompression = new IdentityHandler();
			this.currentCompressionAlgorithm = "identity";
			const compressionAlgorithmKey = channelOptions["grpc.default_compression_algorithm"];
			this.maxReceiveMessageLength = (_a = channelOptions["grpc.max_receive_message_length"]) !== null && _a !== void 0 ? _a : constants_1.DEFAULT_MAX_RECEIVE_MESSAGE_LENGTH;
			this.maxSendMessageLength = (_b = channelOptions["grpc.max_send_message_length"]) !== null && _b !== void 0 ? _b : constants_1.DEFAULT_MAX_SEND_MESSAGE_LENGTH;
			if (compressionAlgorithmKey !== void 0) if (isCompressionAlgorithmKey(compressionAlgorithmKey)) {
				const clientSelectedEncoding = compression_algorithms_1.CompressionAlgorithms[compressionAlgorithmKey];
				const serverSupportedEncodings = (_c = sharedFilterConfig.serverSupportedEncodingHeader) === null || _c === void 0 ? void 0 : _c.split(",");
				/**
				* There are two possible situations here:
				* 1) We don't have any info yet from the server about what compression it supports
				*    In that case we should just use what the client tells us to use
				* 2) We've previously received a response from the server including a grpc-accept-encoding header
				*    In that case we only want to use the encoding chosen by the client if the server supports it
				*/
				if (!serverSupportedEncodings || serverSupportedEncodings.includes(clientSelectedEncoding)) {
					this.currentCompressionAlgorithm = clientSelectedEncoding;
					this.sendCompression = getCompressionHandler(this.currentCompressionAlgorithm, -1);
				}
			} else logging.log(constants_1.LogVerbosity.ERROR, `Invalid value provided for grpc.default_compression_algorithm option: ${compressionAlgorithmKey}`);
		}
		async sendMetadata(metadata) {
			const headers = await metadata;
			headers.set("grpc-accept-encoding", "identity,deflate,gzip");
			headers.set("accept-encoding", "identity");
			if (this.currentCompressionAlgorithm === "identity") headers.remove("grpc-encoding");
			else headers.set("grpc-encoding", this.currentCompressionAlgorithm);
			return headers;
		}
		receiveMetadata(metadata) {
			const receiveEncoding = metadata.get("grpc-encoding");
			if (receiveEncoding.length > 0) {
				const encoding = receiveEncoding[0];
				if (typeof encoding === "string") this.receiveCompression = getCompressionHandler(encoding, this.maxReceiveMessageLength);
			}
			metadata.remove("grpc-encoding");
			const serverSupportedEncodingsHeader = metadata.get("grpc-accept-encoding")[0];
			if (serverSupportedEncodingsHeader) {
				this.sharedFilterConfig.serverSupportedEncodingHeader = serverSupportedEncodingsHeader;
				if (!serverSupportedEncodingsHeader.split(",").includes(this.currentCompressionAlgorithm)) {
					this.sendCompression = new IdentityHandler();
					this.currentCompressionAlgorithm = "identity";
				}
			}
			metadata.remove("grpc-accept-encoding");
			return metadata;
		}
		async sendMessage(message) {
			var _a;
			const resolvedMessage = await message;
			if (this.maxSendMessageLength !== -1 && resolvedMessage.message.length > this.maxSendMessageLength) throw {
				code: constants_1.Status.RESOURCE_EXHAUSTED,
				details: `Attempted to send message with a size larger than ${this.maxSendMessageLength}`
			};
			let compress;
			if (this.sendCompression instanceof IdentityHandler) compress = false;
			else compress = (((_a = resolvedMessage.flags) !== null && _a !== void 0 ? _a : 0) & 2) === 0;
			return {
				message: await this.sendCompression.writeMessage(resolvedMessage.message, compress),
				flags: resolvedMessage.flags
			};
		}
		async receiveMessage(message) {
			return this.receiveCompression.readMessage(await message);
		}
	};
	exports.CompressionFilter = CompressionFilter;
	var CompressionFilterFactory = class {
		constructor(channel, options) {
			this.options = options;
			this.sharedFilterConfig = {};
		}
		createFilter() {
			return new CompressionFilter(this.options, this.sharedFilterConfig);
		}
	};
	exports.CompressionFilterFactory = CompressionFilterFactory;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/control-plane-status.js
var require_control_plane_status = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.restrictControlPlaneStatusCode = restrictControlPlaneStatusCode;
	const constants_1 = require_constants();
	const INAPPROPRIATE_CONTROL_PLANE_CODES = [
		constants_1.Status.OK,
		constants_1.Status.INVALID_ARGUMENT,
		constants_1.Status.NOT_FOUND,
		constants_1.Status.ALREADY_EXISTS,
		constants_1.Status.FAILED_PRECONDITION,
		constants_1.Status.ABORTED,
		constants_1.Status.OUT_OF_RANGE,
		constants_1.Status.DATA_LOSS
	];
	function restrictControlPlaneStatusCode(code, details) {
		if (INAPPROPRIATE_CONTROL_PLANE_CODES.includes(code)) return {
			code: constants_1.Status.INTERNAL,
			details: `Invalid status from control plane: ${code} ${constants_1.Status[code]} ${details}`
		};
		else return {
			code,
			details
		};
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/deadline.js
var require_deadline = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.minDeadline = minDeadline;
	exports.getDeadlineTimeoutString = getDeadlineTimeoutString;
	exports.getRelativeTimeout = getRelativeTimeout;
	exports.deadlineToString = deadlineToString;
	exports.formatDateDifference = formatDateDifference;
	function minDeadline(...deadlineList) {
		let minValue = Infinity;
		for (const deadline of deadlineList) {
			const deadlineMsecs = deadline instanceof Date ? deadline.getTime() : deadline;
			if (deadlineMsecs < minValue) minValue = deadlineMsecs;
		}
		return minValue;
	}
	const units = [
		["m", 1],
		["S", 1e3],
		["M", 60 * 1e3],
		["H", 3600 * 1e3]
	];
	function getDeadlineTimeoutString(deadline) {
		const now = (/* @__PURE__ */ new Date()).getTime();
		if (deadline instanceof Date) deadline = deadline.getTime();
		const timeoutMs = Math.max(deadline - now, 0);
		for (const [unit, factor] of units) {
			const amount = timeoutMs / factor;
			if (amount < 1e8) return String(Math.ceil(amount)) + unit;
		}
		throw new Error("Deadline is too far in the future");
	}
	/**
	* See https://nodejs.org/api/timers.html#settimeoutcallback-delay-args
	* In particular, "When delay is larger than 2147483647 or less than 1, the
	* delay will be set to 1. Non-integer delays are truncated to an integer."
	* This number of milliseconds is almost 25 days.
	*/
	const MAX_TIMEOUT_TIME = 2147483647;
	/**
	* Get the timeout value that should be passed to setTimeout now for the timer
	* to end at the deadline. For any deadline before now, the timer should end
	* immediately, represented by a value of 0. For any deadline more than
	* MAX_TIMEOUT_TIME milliseconds in the future, a timer cannot be set that will
	* end at that time, so it is treated as infinitely far in the future.
	* @param deadline
	* @returns
	*/
	function getRelativeTimeout(deadline) {
		const timeout = (deadline instanceof Date ? deadline.getTime() : deadline) - (/* @__PURE__ */ new Date()).getTime();
		if (timeout < 0) return 0;
		else if (timeout > MAX_TIMEOUT_TIME) return Infinity;
		else return timeout;
	}
	function deadlineToString(deadline) {
		if (deadline instanceof Date) return deadline.toISOString();
		else {
			const dateDeadline = new Date(deadline);
			if (Number.isNaN(dateDeadline.getTime())) return "" + deadline;
			else return dateDeadline.toISOString();
		}
	}
	/**
	* Calculate the difference between two dates as a number of seconds and format
	* it as a string.
	* @param startDate
	* @param endDate
	* @returns
	*/
	function formatDateDifference(startDate, endDate) {
		return ((endDate.getTime() - startDate.getTime()) / 1e3).toFixed(3) + "s";
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/filter-stack.js
var require_filter_stack = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.FilterStackFactory = exports.FilterStack = void 0;
	var FilterStack = class {
		constructor(filters) {
			this.filters = filters;
		}
		sendMetadata(metadata) {
			let result = metadata;
			for (let i = 0; i < this.filters.length; i++) result = this.filters[i].sendMetadata(result);
			return result;
		}
		receiveMetadata(metadata) {
			let result = metadata;
			for (let i = this.filters.length - 1; i >= 0; i--) result = this.filters[i].receiveMetadata(result);
			return result;
		}
		sendMessage(message) {
			let result = message;
			for (let i = 0; i < this.filters.length; i++) result = this.filters[i].sendMessage(result);
			return result;
		}
		receiveMessage(message) {
			let result = message;
			for (let i = this.filters.length - 1; i >= 0; i--) result = this.filters[i].receiveMessage(result);
			return result;
		}
		receiveTrailers(status) {
			let result = status;
			for (let i = this.filters.length - 1; i >= 0; i--) result = this.filters[i].receiveTrailers(result);
			return result;
		}
		push(filters) {
			this.filters.unshift(...filters);
		}
		getFilters() {
			return this.filters;
		}
	};
	exports.FilterStack = FilterStack;
	exports.FilterStackFactory = class FilterStackFactory {
		constructor(factories) {
			this.factories = factories;
		}
		push(filterFactories) {
			this.factories.unshift(...filterFactories);
		}
		clone() {
			return new FilterStackFactory([...this.factories]);
		}
		createFilter() {
			return new FilterStack(this.factories.map((factory) => factory.createFilter()));
		}
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/single-subchannel-channel.js
var require_single_subchannel_channel = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.SingleSubchannelChannel = void 0;
	const call_number_1 = require_call_number();
	const channelz_1 = require_channelz();
	const compression_filter_1 = require_compression_filter();
	const connectivity_state_1 = require_connectivity_state();
	const constants_1 = require_constants();
	const control_plane_status_1 = require_control_plane_status();
	const deadline_1 = require_deadline();
	const filter_stack_1 = require_filter_stack();
	const metadata_1 = require_metadata();
	const resolver_1 = require_resolver();
	const uri_parser_1 = require_uri_parser();
	var SubchannelCallWrapper = class {
		constructor(subchannel, method, filterStackFactory, options, callNumber) {
			var _a, _b;
			this.subchannel = subchannel;
			this.method = method;
			this.options = options;
			this.callNumber = callNumber;
			this.childCall = null;
			this.pendingMessage = null;
			this.readPending = false;
			this.halfClosePending = false;
			this.pendingStatus = null;
			this.readFilterPending = false;
			this.writeFilterPending = false;
			const splitPath = this.method.split("/");
			let serviceName = "";
			if (splitPath.length >= 2) serviceName = splitPath[1];
			this.serviceUrl = `https://${(_b = (_a = (0, uri_parser_1.splitHostPort)(this.options.host)) === null || _a === void 0 ? void 0 : _a.host) !== null && _b !== void 0 ? _b : "localhost"}/${serviceName}`;
			const timeout = (0, deadline_1.getRelativeTimeout)(options.deadline);
			if (timeout !== Infinity) if (timeout <= 0) this.cancelWithStatus(constants_1.Status.DEADLINE_EXCEEDED, "Deadline exceeded");
			else setTimeout(() => {
				this.cancelWithStatus(constants_1.Status.DEADLINE_EXCEEDED, "Deadline exceeded");
			}, timeout);
			this.filterStack = filterStackFactory.createFilter();
		}
		cancelWithStatus(status, details) {
			if (this.childCall) this.childCall.cancelWithStatus(status, details);
			else this.pendingStatus = {
				code: status,
				details,
				metadata: new metadata_1.Metadata()
			};
		}
		getPeer() {
			var _a, _b;
			return (_b = (_a = this.childCall) === null || _a === void 0 ? void 0 : _a.getPeer()) !== null && _b !== void 0 ? _b : this.subchannel.getAddress();
		}
		async start(metadata, listener) {
			if (this.pendingStatus) {
				listener.onReceiveStatus(this.pendingStatus);
				return;
			}
			if (this.subchannel.getConnectivityState() !== connectivity_state_1.ConnectivityState.READY) {
				listener.onReceiveStatus({
					code: constants_1.Status.UNAVAILABLE,
					details: "Subchannel not ready",
					metadata: new metadata_1.Metadata()
				});
				return;
			}
			const filteredMetadata = await this.filterStack.sendMetadata(Promise.resolve(metadata));
			let credsMetadata;
			try {
				credsMetadata = await this.subchannel.getCallCredentials().generateMetadata({
					method_name: this.method,
					service_url: this.serviceUrl
				});
			} catch (e) {
				const error = e;
				const { code, details } = (0, control_plane_status_1.restrictControlPlaneStatusCode)(typeof error.code === "number" ? error.code : constants_1.Status.UNKNOWN, `Getting metadata from plugin failed with error: ${error.message}`);
				listener.onReceiveStatus({
					code,
					details,
					metadata: new metadata_1.Metadata()
				});
				return;
			}
			credsMetadata.merge(filteredMetadata);
			this.childCall = this.subchannel.createCall(credsMetadata, this.options.host, this.method, {
				onReceiveMetadata: async (metadata) => {
					listener.onReceiveMetadata(await this.filterStack.receiveMetadata(metadata));
				},
				onReceiveMessage: async (message) => {
					this.readFilterPending = true;
					const filteredMessage = await this.filterStack.receiveMessage(message);
					this.readFilterPending = false;
					listener.onReceiveMessage(filteredMessage);
					if (this.pendingStatus) listener.onReceiveStatus(this.pendingStatus);
				},
				onReceiveStatus: async (status) => {
					const filteredStatus = await this.filterStack.receiveTrailers(status);
					if (this.readFilterPending) this.pendingStatus = filteredStatus;
					else listener.onReceiveStatus(filteredStatus);
				}
			});
			if (this.readPending) this.childCall.startRead();
			if (this.pendingMessage) this.childCall.sendMessageWithContext(this.pendingMessage.context, this.pendingMessage.message);
			if (this.halfClosePending && !this.writeFilterPending) this.childCall.halfClose();
		}
		async sendMessageWithContext(context, message) {
			this.writeFilterPending = true;
			const filteredMessage = await this.filterStack.sendMessage(Promise.resolve({
				message,
				flags: context.flags
			}));
			this.writeFilterPending = false;
			if (this.childCall) {
				this.childCall.sendMessageWithContext(context, filteredMessage.message);
				if (this.halfClosePending) this.childCall.halfClose();
			} else this.pendingMessage = {
				context,
				message: filteredMessage.message
			};
		}
		startRead() {
			if (this.childCall) this.childCall.startRead();
			else this.readPending = true;
		}
		halfClose() {
			if (this.childCall && !this.writeFilterPending) this.childCall.halfClose();
			else this.halfClosePending = true;
		}
		getCallNumber() {
			return this.callNumber;
		}
		setCredentials(credentials) {
			throw new Error("Method not implemented.");
		}
		getAuthContext() {
			if (this.childCall) return this.childCall.getAuthContext();
			else return null;
		}
	};
	var SingleSubchannelChannel = class {
		constructor(subchannel, target, options) {
			this.subchannel = subchannel;
			this.target = target;
			this.channelzEnabled = false;
			this.channelzTrace = new channelz_1.ChannelzTrace();
			this.callTracker = new channelz_1.ChannelzCallTracker();
			this.childrenTracker = new channelz_1.ChannelzChildrenTracker();
			this.channelzEnabled = options["grpc.enable_channelz"] !== 0;
			this.channelzRef = (0, channelz_1.registerChannelzChannel)((0, uri_parser_1.uriToString)(target), () => ({
				target: `${(0, uri_parser_1.uriToString)(target)} (${subchannel.getAddress()})`,
				state: this.subchannel.getConnectivityState(),
				trace: this.channelzTrace,
				callTracker: this.callTracker,
				children: this.childrenTracker.getChildLists()
			}), this.channelzEnabled);
			if (this.channelzEnabled) this.childrenTracker.refChild(subchannel.getChannelzRef());
			this.filterStackFactory = new filter_stack_1.FilterStackFactory([new compression_filter_1.CompressionFilterFactory(this, options)]);
		}
		close() {
			if (this.channelzEnabled) this.childrenTracker.unrefChild(this.subchannel.getChannelzRef());
			(0, channelz_1.unregisterChannelzRef)(this.channelzRef);
		}
		getTarget() {
			return (0, uri_parser_1.uriToString)(this.target);
		}
		getConnectivityState(tryToConnect) {
			throw new Error("Method not implemented.");
		}
		watchConnectivityState(currentState, deadline, callback) {
			throw new Error("Method not implemented.");
		}
		getChannelzRef() {
			return this.channelzRef;
		}
		createCall(method, deadline) {
			const callOptions = {
				deadline,
				host: (0, resolver_1.getDefaultAuthority)(this.target),
				flags: constants_1.Propagate.DEFAULTS,
				parentCall: null
			};
			return new SubchannelCallWrapper(this.subchannel, method, this.filterStackFactory, callOptions, (0, call_number_1.getNextCallNumber)());
		}
	};
	exports.SingleSubchannelChannel = SingleSubchannelChannel;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/subchannel.js
var require_subchannel = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Subchannel = void 0;
	const connectivity_state_1 = require_connectivity_state();
	const backoff_timeout_1 = require_backoff_timeout();
	const logging = require_logging();
	const constants_1 = require_constants();
	const uri_parser_1 = require_uri_parser();
	const subchannel_address_1 = require_subchannel_address();
	const channelz_1 = require_channelz();
	const single_subchannel_channel_1 = require_single_subchannel_channel();
	const TRACER_NAME = "subchannel";
	const KEEPALIVE_MAX_TIME_MS = 2147483647;
	var Subchannel = class {
		/**
		* A class representing a connection to a single backend.
		* @param channelTarget The target string for the channel as a whole
		* @param subchannelAddress The address for the backend that this subchannel
		*     will connect to
		* @param options The channel options, plus any specific subchannel options
		*     for this subchannel
		* @param credentials The channel credentials used to establish this
		*     connection
		*/
		constructor(channelTarget, subchannelAddress, options, credentials, connector) {
			var _a;
			this.channelTarget = channelTarget;
			this.subchannelAddress = subchannelAddress;
			this.options = options;
			this.connector = connector;
			/**
			* The subchannel's current connectivity state. Invariant: `session` === `null`
			* if and only if `connectivityState` is IDLE or TRANSIENT_FAILURE.
			*/
			this.connectivityState = connectivity_state_1.ConnectivityState.IDLE;
			/**
			* The underlying http2 session used to make requests.
			*/
			this.transport = null;
			/**
			* Indicates that the subchannel should transition from TRANSIENT_FAILURE to
			* CONNECTING instead of IDLE when the backoff timeout ends.
			*/
			this.continueConnecting = false;
			/**
			* A list of listener functions that will be called whenever the connectivity
			* state changes. Will be modified by `addConnectivityStateListener` and
			* `removeConnectivityStateListener`
			*/
			this.stateListeners = /* @__PURE__ */ new Set();
			/**
			* Tracks channels and subchannel pools with references to this subchannel
			*/
			this.refcount = 0;
			this.channelzEnabled = true;
			this.dataProducers = /* @__PURE__ */ new Map();
			this.subchannelChannel = null;
			const backoffOptions = {
				initialDelay: options["grpc.initial_reconnect_backoff_ms"],
				maxDelay: options["grpc.max_reconnect_backoff_ms"]
			};
			this.backoffTimeout = new backoff_timeout_1.BackoffTimeout(() => {
				this.handleBackoffTimer();
			}, backoffOptions);
			this.backoffTimeout.unref();
			this.subchannelAddressString = (0, subchannel_address_1.subchannelAddressToString)(subchannelAddress);
			this.keepaliveTime = (_a = options["grpc.keepalive_time_ms"]) !== null && _a !== void 0 ? _a : -1;
			if (options["grpc.enable_channelz"] === 0) {
				this.channelzEnabled = false;
				this.channelzTrace = new channelz_1.ChannelzTraceStub();
				this.callTracker = new channelz_1.ChannelzCallTrackerStub();
				this.childrenTracker = new channelz_1.ChannelzChildrenTrackerStub();
				this.streamTracker = new channelz_1.ChannelzCallTrackerStub();
			} else {
				this.channelzTrace = new channelz_1.ChannelzTrace();
				this.callTracker = new channelz_1.ChannelzCallTracker();
				this.childrenTracker = new channelz_1.ChannelzChildrenTracker();
				this.streamTracker = new channelz_1.ChannelzCallTracker();
			}
			this.channelzRef = (0, channelz_1.registerChannelzSubchannel)(this.subchannelAddressString, () => this.getChannelzInfo(), this.channelzEnabled);
			this.channelzTrace.addTrace("CT_INFO", "Subchannel created");
			this.trace("Subchannel constructed with options " + JSON.stringify(options, void 0, 2));
			this.secureConnector = credentials._createSecureConnector(channelTarget, options);
		}
		getChannelzInfo() {
			return {
				state: this.connectivityState,
				trace: this.channelzTrace,
				callTracker: this.callTracker,
				children: this.childrenTracker.getChildLists(),
				target: this.subchannelAddressString
			};
		}
		trace(text) {
			logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, "(" + this.channelzRef.id + ") " + this.subchannelAddressString + " " + text);
		}
		refTrace(text) {
			logging.trace(constants_1.LogVerbosity.DEBUG, "subchannel_refcount", "(" + this.channelzRef.id + ") " + this.subchannelAddressString + " " + text);
		}
		handleBackoffTimer() {
			if (this.continueConnecting) this.transitionToState([connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE], connectivity_state_1.ConnectivityState.CONNECTING);
			else this.transitionToState([connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE], connectivity_state_1.ConnectivityState.IDLE);
		}
		/**
		* Start a backoff timer with the current nextBackoff timeout
		*/
		startBackoff() {
			this.backoffTimeout.runOnce();
		}
		stopBackoff() {
			this.backoffTimeout.stop();
			this.backoffTimeout.reset();
		}
		startConnectingInternal() {
			let options = this.options;
			if (options["grpc.keepalive_time_ms"]) {
				const adjustedKeepaliveTime = Math.min(this.keepaliveTime, KEEPALIVE_MAX_TIME_MS);
				options = Object.assign(Object.assign({}, options), { "grpc.keepalive_time_ms": adjustedKeepaliveTime });
			}
			this.connector.connect(this.subchannelAddress, this.secureConnector, options).then((transport) => {
				if (this.transitionToState([connectivity_state_1.ConnectivityState.CONNECTING], connectivity_state_1.ConnectivityState.READY)) {
					this.transport = transport;
					if (this.channelzEnabled) this.childrenTracker.refChild(transport.getChannelzRef());
					transport.addDisconnectListener((tooManyPings) => {
						this.transitionToState([connectivity_state_1.ConnectivityState.READY], connectivity_state_1.ConnectivityState.IDLE);
						if (tooManyPings && this.keepaliveTime > 0) {
							this.keepaliveTime *= 2;
							logging.log(constants_1.LogVerbosity.ERROR, `Connection to ${(0, uri_parser_1.uriToString)(this.channelTarget)} at ${this.subchannelAddressString} rejected by server because of excess pings. Increasing ping interval to ${this.keepaliveTime} ms`);
						}
					});
				} else transport.shutdown();
			}, (error) => {
				this.transitionToState([connectivity_state_1.ConnectivityState.CONNECTING], connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE, `${error}`);
			});
		}
		/**
		* Initiate a state transition from any element of oldStates to the new
		* state. If the current connectivityState is not in oldStates, do nothing.
		* @param oldStates The set of states to transition from
		* @param newState The state to transition to
		* @returns True if the state changed, false otherwise
		*/
		transitionToState(oldStates, newState, errorMessage) {
			var _a, _b;
			if (oldStates.indexOf(this.connectivityState) === -1) return false;
			if (errorMessage) this.trace(connectivity_state_1.ConnectivityState[this.connectivityState] + " -> " + connectivity_state_1.ConnectivityState[newState] + " with error \"" + errorMessage + "\"");
			else this.trace(connectivity_state_1.ConnectivityState[this.connectivityState] + " -> " + connectivity_state_1.ConnectivityState[newState]);
			if (this.channelzEnabled) this.channelzTrace.addTrace("CT_INFO", "Connectivity state change to " + connectivity_state_1.ConnectivityState[newState]);
			const previousState = this.connectivityState;
			this.connectivityState = newState;
			switch (newState) {
				case connectivity_state_1.ConnectivityState.READY:
					this.stopBackoff();
					break;
				case connectivity_state_1.ConnectivityState.CONNECTING:
					this.startBackoff();
					this.startConnectingInternal();
					this.continueConnecting = false;
					break;
				case connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE:
					if (this.channelzEnabled && this.transport) this.childrenTracker.unrefChild(this.transport.getChannelzRef());
					(_a = this.transport) === null || _a === void 0 || _a.shutdown();
					this.transport = null;
					if (!this.backoffTimeout.isRunning()) process.nextTick(() => {
						this.handleBackoffTimer();
					});
					break;
				case connectivity_state_1.ConnectivityState.IDLE:
					if (this.channelzEnabled && this.transport) this.childrenTracker.unrefChild(this.transport.getChannelzRef());
					(_b = this.transport) === null || _b === void 0 || _b.shutdown();
					this.transport = null;
					break;
				default: throw new Error(`Invalid state: unknown ConnectivityState ${newState}`);
			}
			for (const listener of this.stateListeners) listener(this, previousState, newState, this.keepaliveTime, errorMessage);
			return true;
		}
		ref() {
			this.refTrace("refcount " + this.refcount + " -> " + (this.refcount + 1));
			this.refcount += 1;
		}
		unref() {
			this.refTrace("refcount " + this.refcount + " -> " + (this.refcount - 1));
			this.refcount -= 1;
			if (this.refcount === 0) {
				this.channelzTrace.addTrace("CT_INFO", "Shutting down");
				(0, channelz_1.unregisterChannelzRef)(this.channelzRef);
				this.secureConnector.destroy();
				process.nextTick(() => {
					this.transitionToState([connectivity_state_1.ConnectivityState.CONNECTING, connectivity_state_1.ConnectivityState.READY], connectivity_state_1.ConnectivityState.IDLE);
				});
			}
		}
		unrefIfOneRef() {
			if (this.refcount === 1) {
				this.unref();
				return true;
			}
			return false;
		}
		createCall(metadata, host, method, listener) {
			if (!this.transport) throw new Error("Cannot create call, subchannel not READY");
			let statsTracker;
			if (this.channelzEnabled) {
				this.callTracker.addCallStarted();
				this.streamTracker.addCallStarted();
				statsTracker = { onCallEnd: (status) => {
					if (status.code === constants_1.Status.OK) this.callTracker.addCallSucceeded();
					else this.callTracker.addCallFailed();
				} };
			} else statsTracker = {};
			return this.transport.createCall(metadata, host, method, listener, statsTracker);
		}
		/**
		* If the subchannel is currently IDLE, start connecting and switch to the
		* CONNECTING state. If the subchannel is current in TRANSIENT_FAILURE,
		* the next time it would transition to IDLE, start connecting again instead.
		* Otherwise, do nothing.
		*/
		startConnecting() {
			process.nextTick(() => {
				if (!this.transitionToState([connectivity_state_1.ConnectivityState.IDLE], connectivity_state_1.ConnectivityState.CONNECTING)) {
					if (this.connectivityState === connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE) this.continueConnecting = true;
				}
			});
		}
		/**
		* Get the subchannel's current connectivity state.
		*/
		getConnectivityState() {
			return this.connectivityState;
		}
		/**
		* Add a listener function to be called whenever the subchannel's
		* connectivity state changes.
		* @param listener
		*/
		addConnectivityStateListener(listener) {
			this.stateListeners.add(listener);
		}
		/**
		* Remove a listener previously added with `addConnectivityStateListener`
		* @param listener A reference to a function previously passed to
		*     `addConnectivityStateListener`
		*/
		removeConnectivityStateListener(listener) {
			this.stateListeners.delete(listener);
		}
		/**
		* Reset the backoff timeout, and immediately start connecting if in backoff.
		*/
		resetBackoff() {
			process.nextTick(() => {
				this.backoffTimeout.reset();
				this.transitionToState([connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE], connectivity_state_1.ConnectivityState.CONNECTING);
			});
		}
		getAddress() {
			return this.subchannelAddressString;
		}
		getChannelzRef() {
			return this.channelzRef;
		}
		isHealthy() {
			return true;
		}
		addHealthStateWatcher(listener) {}
		removeHealthStateWatcher(listener) {}
		getRealSubchannel() {
			return this;
		}
		realSubchannelEquals(other) {
			return other.getRealSubchannel() === this;
		}
		throttleKeepalive(newKeepaliveTime) {
			if (newKeepaliveTime > this.keepaliveTime) this.keepaliveTime = newKeepaliveTime;
		}
		getCallCredentials() {
			return this.secureConnector.getCallCredentials();
		}
		getChannel() {
			if (!this.subchannelChannel) this.subchannelChannel = new single_subchannel_channel_1.SingleSubchannelChannel(this, this.channelTarget, this.options);
			return this.subchannelChannel;
		}
		addDataWatcher(dataWatcher) {
			throw new Error("Not implemented");
		}
		getOrCreateDataProducer(name, createDataProducer) {
			const existingProducer = this.dataProducers.get(name);
			if (existingProducer) return existingProducer;
			const newProducer = createDataProducer(this);
			this.dataProducers.set(name, newProducer);
			return newProducer;
		}
		removeDataProducer(name) {
			this.dataProducers.delete(name);
		}
	};
	exports.Subchannel = Subchannel;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/environment.js
var require_environment = /* @__PURE__ */ __commonJSMin(((exports) => {
	var _a;
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.GRPC_NODE_USE_ALTERNATIVE_RESOLVER = void 0;
	exports.GRPC_NODE_USE_ALTERNATIVE_RESOLVER = ((_a = process.env.GRPC_NODE_USE_ALTERNATIVE_RESOLVER) !== null && _a !== void 0 ? _a : "false") === "true";
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/resolver-dns.js
var require_resolver_dns = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.DEFAULT_PORT = void 0;
	exports.setup = setup;
	const resolver_1 = require_resolver();
	const dns_1 = __require("dns");
	const service_config_1 = require_service_config();
	const constants_1 = require_constants();
	const call_interface_1 = require_call_interface();
	const metadata_1 = require_metadata();
	const logging = require_logging();
	const constants_2 = require_constants();
	const uri_parser_1 = require_uri_parser();
	const net_1$3 = __require("net");
	const backoff_timeout_1 = require_backoff_timeout();
	const environment_1 = require_environment();
	const TRACER_NAME = "dns_resolver";
	function trace(text) {
		logging.trace(constants_2.LogVerbosity.DEBUG, TRACER_NAME, text);
	}
	/**
	* The default TCP port to connect to if not explicitly specified in the target.
	*/
	exports.DEFAULT_PORT = 443;
	const DEFAULT_MIN_TIME_BETWEEN_RESOLUTIONS_MS = 3e4;
	/**
	* Resolver implementation that handles DNS names and IP addresses.
	*/
	var DnsResolver = class {
		constructor(target, listener, channelOptions) {
			var _a, _b, _c;
			this.target = target;
			this.listener = listener;
			this.pendingLookupPromise = null;
			this.pendingTxtPromise = null;
			this.latestLookupResult = null;
			this.latestServiceConfigResult = null;
			this.continueResolving = false;
			this.isNextResolutionTimerRunning = false;
			this.isServiceConfigEnabled = true;
			this.returnedIpResult = false;
			this.alternativeResolver = new dns_1.promises.Resolver();
			trace("Resolver constructed for target " + (0, uri_parser_1.uriToString)(target));
			if (target.authority) this.alternativeResolver.setServers([target.authority]);
			const hostPort = (0, uri_parser_1.splitHostPort)(target.path);
			if (hostPort === null) {
				this.ipResult = null;
				this.dnsHostname = null;
				this.port = null;
			} else if ((0, net_1$3.isIPv4)(hostPort.host) || (0, net_1$3.isIPv6)(hostPort.host)) {
				this.ipResult = [{ addresses: [{
					host: hostPort.host,
					port: (_a = hostPort.port) !== null && _a !== void 0 ? _a : exports.DEFAULT_PORT
				}] }];
				this.dnsHostname = null;
				this.port = null;
			} else {
				this.ipResult = null;
				this.dnsHostname = hostPort.host;
				this.port = (_b = hostPort.port) !== null && _b !== void 0 ? _b : exports.DEFAULT_PORT;
			}
			this.percentage = Math.random() * 100;
			if (channelOptions["grpc.service_config_disable_resolution"] === 1) this.isServiceConfigEnabled = false;
			this.defaultResolutionError = {
				code: constants_1.Status.UNAVAILABLE,
				details: `Name resolution failed for target ${(0, uri_parser_1.uriToString)(this.target)}`,
				metadata: new metadata_1.Metadata()
			};
			const backoffOptions = {
				initialDelay: channelOptions["grpc.initial_reconnect_backoff_ms"],
				maxDelay: channelOptions["grpc.max_reconnect_backoff_ms"]
			};
			this.backoff = new backoff_timeout_1.BackoffTimeout(() => {
				if (this.continueResolving) this.startResolutionWithBackoff();
			}, backoffOptions);
			this.backoff.unref();
			this.minTimeBetweenResolutionsMs = (_c = channelOptions["grpc.dns_min_time_between_resolutions_ms"]) !== null && _c !== void 0 ? _c : DEFAULT_MIN_TIME_BETWEEN_RESOLUTIONS_MS;
			this.nextResolutionTimer = setTimeout(() => {}, 0);
			clearTimeout(this.nextResolutionTimer);
		}
		/**
		* If the target is an IP address, just provide that address as a result.
		* Otherwise, initiate A, AAAA, and TXT lookups
		*/
		startResolution() {
			if (this.ipResult !== null) {
				if (!this.returnedIpResult) {
					trace("Returning IP address for target " + (0, uri_parser_1.uriToString)(this.target));
					setImmediate(() => {
						this.listener((0, call_interface_1.statusOrFromValue)(this.ipResult), {}, null, "");
					});
					this.returnedIpResult = true;
				}
				this.backoff.stop();
				this.backoff.reset();
				this.stopNextResolutionTimer();
				return;
			}
			if (this.dnsHostname === null) {
				trace("Failed to parse DNS address " + (0, uri_parser_1.uriToString)(this.target));
				setImmediate(() => {
					this.listener((0, call_interface_1.statusOrFromError)({
						code: constants_1.Status.UNAVAILABLE,
						details: `Failed to parse DNS address ${(0, uri_parser_1.uriToString)(this.target)}`
					}), {}, null, "");
				});
				this.stopNextResolutionTimer();
			} else {
				if (this.pendingLookupPromise !== null) return;
				trace("Looking up DNS hostname " + this.dnsHostname);
				this.latestLookupResult = null;
				const hostname = this.dnsHostname;
				this.pendingLookupPromise = this.lookup(hostname);
				this.pendingLookupPromise.then((addressList) => {
					if (this.pendingLookupPromise === null) return;
					this.pendingLookupPromise = null;
					this.latestLookupResult = (0, call_interface_1.statusOrFromValue)(addressList.map((address) => ({ addresses: [address] })));
					const allAddressesString = "[" + addressList.map((addr) => addr.host + ":" + addr.port).join(",") + "]";
					trace("Resolved addresses for target " + (0, uri_parser_1.uriToString)(this.target) + ": " + allAddressesString);
					const healthStatus = this.listener(this.latestLookupResult, {}, this.latestServiceConfigResult, "");
					this.handleHealthStatus(healthStatus);
				}, (err) => {
					if (this.pendingLookupPromise === null) return;
					trace("Resolution error for target " + (0, uri_parser_1.uriToString)(this.target) + ": " + err.message);
					this.pendingLookupPromise = null;
					this.stopNextResolutionTimer();
					this.listener((0, call_interface_1.statusOrFromError)(this.defaultResolutionError), {}, this.latestServiceConfigResult, "");
				});
				if (this.isServiceConfigEnabled && this.pendingTxtPromise === null) {
					this.pendingTxtPromise = this.resolveTxt(hostname);
					this.pendingTxtPromise.then((txtRecord) => {
						if (this.pendingTxtPromise === null) return;
						this.pendingTxtPromise = null;
						let serviceConfig;
						try {
							serviceConfig = (0, service_config_1.extractAndSelectServiceConfig)(txtRecord, this.percentage);
							if (serviceConfig) this.latestServiceConfigResult = (0, call_interface_1.statusOrFromValue)(serviceConfig);
							else this.latestServiceConfigResult = null;
						} catch (err) {
							this.latestServiceConfigResult = (0, call_interface_1.statusOrFromError)({
								code: constants_1.Status.UNAVAILABLE,
								details: `Parsing service config failed with error ${err.message}`
							});
						}
						if (this.latestLookupResult !== null) this.listener(this.latestLookupResult, {}, this.latestServiceConfigResult, "");
					}, (err) => {});
				}
			}
		}
		/**
		* The ResolverListener returns a boolean indicating whether the LB policy
		* accepted the resolution result. A false result on an otherwise successful
		* resolution should be treated as a resolution failure.
		* @param healthStatus
		*/
		handleHealthStatus(healthStatus) {
			if (healthStatus) {
				this.backoff.stop();
				this.backoff.reset();
			} else this.continueResolving = true;
		}
		async lookup(hostname) {
			if (environment_1.GRPC_NODE_USE_ALTERNATIVE_RESOLVER) {
				trace("Using alternative DNS resolver.");
				const records = await Promise.allSettled([this.alternativeResolver.resolve4(hostname), this.alternativeResolver.resolve6(hostname)]);
				if (records.every((result) => result.status === "rejected")) throw new Error(records[0].reason);
				return records.reduce((acc, result) => {
					return result.status === "fulfilled" ? [...acc, ...result.value] : acc;
				}, []).map((addr) => ({
					host: addr,
					port: +this.port
				}));
			}
			return (await dns_1.promises.lookup(hostname, { all: true })).map((addr) => ({
				host: addr.address,
				port: +this.port
			}));
		}
		async resolveTxt(hostname) {
			if (environment_1.GRPC_NODE_USE_ALTERNATIVE_RESOLVER) {
				trace("Using alternative DNS resolver.");
				return this.alternativeResolver.resolveTxt(hostname);
			}
			return dns_1.promises.resolveTxt(hostname);
		}
		startNextResolutionTimer() {
			var _a, _b;
			clearTimeout(this.nextResolutionTimer);
			this.nextResolutionTimer = setTimeout(() => {
				this.stopNextResolutionTimer();
				if (this.continueResolving) this.startResolutionWithBackoff();
			}, this.minTimeBetweenResolutionsMs);
			(_b = (_a = this.nextResolutionTimer).unref) === null || _b === void 0 || _b.call(_a);
			this.isNextResolutionTimerRunning = true;
		}
		stopNextResolutionTimer() {
			clearTimeout(this.nextResolutionTimer);
			this.isNextResolutionTimerRunning = false;
		}
		startResolutionWithBackoff() {
			if (this.pendingLookupPromise === null) {
				this.continueResolving = false;
				this.backoff.runOnce();
				this.startNextResolutionTimer();
				this.startResolution();
			}
		}
		updateResolution() {
			if (this.pendingLookupPromise === null) if (this.isNextResolutionTimerRunning || this.backoff.isRunning()) {
				if (this.isNextResolutionTimerRunning) trace("resolution update delayed by \"min time between resolutions\" rate limit");
				else trace("resolution update delayed by backoff timer until " + this.backoff.getEndTime().toISOString());
				this.continueResolving = true;
			} else this.startResolutionWithBackoff();
		}
		/**
		* Reset the resolver to the same state it had when it was created. In-flight
		* DNS requests cannot be cancelled, but they are discarded and their results
		* will be ignored.
		*/
		destroy() {
			this.continueResolving = false;
			this.backoff.reset();
			this.backoff.stop();
			this.stopNextResolutionTimer();
			this.pendingLookupPromise = null;
			this.pendingTxtPromise = null;
			this.latestLookupResult = null;
			this.latestServiceConfigResult = null;
			this.returnedIpResult = false;
		}
		/**
		* Get the default authority for the given target. For IP targets, that is
		* the IP address. For DNS targets, it is the hostname.
		* @param target
		*/
		static getDefaultAuthority(target) {
			return target.path;
		}
	};
	/**
	* Set up the DNS resolver class by registering it as the handler for the
	* "dns:" prefix and as the default resolver.
	*/
	function setup() {
		(0, resolver_1.registerResolver)("dns", DnsResolver);
		(0, resolver_1.registerDefaultScheme)("dns");
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/http_proxy.js
var require_http_proxy = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.parseCIDR = parseCIDR;
	exports.mapProxyName = mapProxyName;
	exports.getProxiedConnection = getProxiedConnection;
	const logging_1 = require_logging();
	const constants_1 = require_constants();
	const net_1$2 = __require("net");
	const http = __require("http");
	const logging = require_logging();
	const subchannel_address_1 = require_subchannel_address();
	const uri_parser_1 = require_uri_parser();
	const url_1 = __require("url");
	const resolver_dns_1 = require_resolver_dns();
	const TRACER_NAME = "proxy";
	function trace(text) {
		logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, text);
	}
	function getProxyInfo() {
		let proxyEnv = "";
		let envVar = "";
		if (process.env.grpc_proxy) {
			envVar = "grpc_proxy";
			proxyEnv = process.env.grpc_proxy;
		} else if (process.env.https_proxy) {
			envVar = "https_proxy";
			proxyEnv = process.env.https_proxy;
		} else if (process.env.http_proxy) {
			envVar = "http_proxy";
			proxyEnv = process.env.http_proxy;
		} else return {};
		let proxyUrl;
		try {
			proxyUrl = new url_1.URL(proxyEnv);
		} catch (e) {
			(0, logging_1.log)(constants_1.LogVerbosity.ERROR, `cannot parse value of "${envVar}" env var`);
			return {};
		}
		if (proxyUrl.protocol !== "http:") {
			(0, logging_1.log)(constants_1.LogVerbosity.ERROR, `"${proxyUrl.protocol}" scheme not supported in proxy URI`);
			return {};
		}
		let userCred = null;
		if (proxyUrl.username) if (proxyUrl.password) {
			(0, logging_1.log)(constants_1.LogVerbosity.INFO, "userinfo found in proxy URI");
			userCred = decodeURIComponent(`${proxyUrl.username}:${proxyUrl.password}`);
		} else userCred = proxyUrl.username;
		const hostname = proxyUrl.hostname;
		let port = proxyUrl.port;
		if (port === "") port = "80";
		const result = { address: `${hostname}:${port}` };
		if (userCred) result.creds = userCred;
		trace("Proxy server " + result.address + " set by environment variable " + envVar);
		return result;
	}
	function getNoProxyHostList() {
		let noProxyStr = process.env.no_grpc_proxy;
		let envVar = "no_grpc_proxy";
		if (!noProxyStr) {
			noProxyStr = process.env.no_proxy;
			envVar = "no_proxy";
		}
		if (noProxyStr) {
			trace("No proxy server list set by environment variable " + envVar);
			return noProxyStr.split(",");
		} else return [];
	}
	function parseCIDR(cidrString) {
		const splitRange = cidrString.split("/");
		if (splitRange.length !== 2) return null;
		const prefixLength = parseInt(splitRange[1], 10);
		if (!(0, net_1$2.isIPv4)(splitRange[0]) || Number.isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) return null;
		return {
			ip: ipToInt(splitRange[0]),
			prefixLength
		};
	}
	function ipToInt(ip) {
		return ip.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
	}
	function isIpInCIDR(cidr, serverHost) {
		const ip = cidr.ip;
		const mask = -1 << 32 - cidr.prefixLength;
		return (ipToInt(serverHost) & mask) === (ip & mask);
	}
	function hostMatchesNoProxyList(serverHost) {
		for (const host of getNoProxyHostList()) {
			const parsedCIDR = parseCIDR(host);
			if ((0, net_1$2.isIPv4)(serverHost) && parsedCIDR && isIpInCIDR(parsedCIDR, serverHost)) return true;
			else if (serverHost.endsWith(host)) return true;
		}
		return false;
	}
	function mapProxyName(target, options) {
		var _a;
		const noProxyResult = {
			target,
			extraOptions: {}
		};
		if (((_a = options["grpc.enable_http_proxy"]) !== null && _a !== void 0 ? _a : 1) === 0) return noProxyResult;
		if (target.scheme === "unix") return noProxyResult;
		const proxyInfo = getProxyInfo();
		if (!proxyInfo.address) return noProxyResult;
		const hostPort = (0, uri_parser_1.splitHostPort)(target.path);
		if (!hostPort) return noProxyResult;
		const serverHost = hostPort.host;
		if (hostMatchesNoProxyList(serverHost)) {
			trace("Not using proxy for target in no_proxy list: " + (0, uri_parser_1.uriToString)(target));
			return noProxyResult;
		}
		const extraOptions = { "grpc.http_connect_target": (0, uri_parser_1.uriToString)(target) };
		if (proxyInfo.creds) extraOptions["grpc.http_connect_creds"] = proxyInfo.creds;
		return {
			target: {
				scheme: "dns",
				path: proxyInfo.address
			},
			extraOptions
		};
	}
	function getProxiedConnection(address, channelOptions) {
		var _a;
		if (!("grpc.http_connect_target" in channelOptions)) return Promise.resolve(null);
		const realTarget = channelOptions["grpc.http_connect_target"];
		const parsedTarget = (0, uri_parser_1.parseUri)(realTarget);
		if (parsedTarget === null) return Promise.resolve(null);
		const splitHostPost = (0, uri_parser_1.splitHostPort)(parsedTarget.path);
		if (splitHostPost === null) return Promise.resolve(null);
		const hostPort = `${splitHostPost.host}:${(_a = splitHostPost.port) !== null && _a !== void 0 ? _a : resolver_dns_1.DEFAULT_PORT}`;
		const options = {
			method: "CONNECT",
			path: hostPort
		};
		const headers = { Host: hostPort };
		if ((0, subchannel_address_1.isTcpSubchannelAddress)(address)) {
			options.host = address.host;
			options.port = address.port;
		} else options.socketPath = address.path;
		if ("grpc.http_connect_creds" in channelOptions) headers["Proxy-Authorization"] = "Basic " + Buffer.from(channelOptions["grpc.http_connect_creds"]).toString("base64");
		options.headers = headers;
		const proxyAddressString = (0, subchannel_address_1.subchannelAddressToString)(address);
		trace("Using proxy " + proxyAddressString + " to connect to " + options.path);
		return new Promise((resolve, reject) => {
			const request = http.request(options);
			request.once("connect", (res, socket, head) => {
				request.removeAllListeners();
				socket.removeAllListeners();
				if (res.statusCode === 200) {
					trace("Successfully connected to " + options.path + " through proxy " + proxyAddressString);
					if (head.length > 0) socket.unshift(head);
					trace("Successfully established a plaintext connection to " + options.path + " through proxy " + proxyAddressString);
					resolve(socket);
				} else {
					(0, logging_1.log)(constants_1.LogVerbosity.ERROR, "Failed to connect to " + options.path + " through proxy " + proxyAddressString + " with status " + res.statusCode);
					reject();
				}
			});
			request.once("error", (err) => {
				request.removeAllListeners();
				(0, logging_1.log)(constants_1.LogVerbosity.ERROR, "Failed to connect to proxy " + proxyAddressString + " with error " + err.message);
				reject();
			});
			request.end();
		});
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/stream-decoder.js
var require_stream_decoder = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.StreamDecoder = void 0;
	var ReadState;
	(function(ReadState) {
		ReadState[ReadState["NO_DATA"] = 0] = "NO_DATA";
		ReadState[ReadState["READING_SIZE"] = 1] = "READING_SIZE";
		ReadState[ReadState["READING_MESSAGE"] = 2] = "READING_MESSAGE";
	})(ReadState || (ReadState = {}));
	var StreamDecoder = class {
		constructor(maxReadMessageLength) {
			this.maxReadMessageLength = maxReadMessageLength;
			this.readState = ReadState.NO_DATA;
			this.readCompressFlag = Buffer.alloc(1);
			this.readPartialSize = Buffer.alloc(4);
			this.readSizeRemaining = 4;
			this.readMessageSize = 0;
			this.readPartialMessage = [];
			this.readMessageRemaining = 0;
		}
		write(data) {
			let readHead = 0;
			let toRead;
			const result = [];
			while (readHead < data.length) switch (this.readState) {
				case ReadState.NO_DATA:
					this.readCompressFlag = data.slice(readHead, readHead + 1);
					readHead += 1;
					this.readState = ReadState.READING_SIZE;
					this.readPartialSize.fill(0);
					this.readSizeRemaining = 4;
					this.readMessageSize = 0;
					this.readMessageRemaining = 0;
					this.readPartialMessage = [];
					break;
				case ReadState.READING_SIZE:
					toRead = Math.min(data.length - readHead, this.readSizeRemaining);
					data.copy(this.readPartialSize, 4 - this.readSizeRemaining, readHead, readHead + toRead);
					this.readSizeRemaining -= toRead;
					readHead += toRead;
					if (this.readSizeRemaining === 0) {
						this.readMessageSize = this.readPartialSize.readUInt32BE(0);
						if (this.maxReadMessageLength !== -1 && this.readMessageSize > this.maxReadMessageLength) throw new Error(`Received message larger than max (${this.readMessageSize} vs ${this.maxReadMessageLength})`);
						this.readMessageRemaining = this.readMessageSize;
						if (this.readMessageRemaining > 0) this.readState = ReadState.READING_MESSAGE;
						else {
							const message = Buffer.concat([this.readCompressFlag, this.readPartialSize], 5);
							this.readState = ReadState.NO_DATA;
							result.push(message);
						}
					}
					break;
				case ReadState.READING_MESSAGE:
					toRead = Math.min(data.length - readHead, this.readMessageRemaining);
					this.readPartialMessage.push(data.slice(readHead, readHead + toRead));
					this.readMessageRemaining -= toRead;
					readHead += toRead;
					if (this.readMessageRemaining === 0) {
						const framedMessageBuffers = [this.readCompressFlag, this.readPartialSize].concat(this.readPartialMessage);
						const framedMessage = Buffer.concat(framedMessageBuffers, this.readMessageSize + 5);
						this.readState = ReadState.NO_DATA;
						result.push(framedMessage);
					}
					break;
				default: throw new Error("Unexpected read state");
			}
			return result;
		}
	};
	exports.StreamDecoder = StreamDecoder;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/subchannel-call.js
var require_subchannel_call = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Http2SubchannelCall = void 0;
	const http2$4 = __require("http2");
	const os = __require("os");
	const constants_1 = require_constants();
	const metadata_1 = require_metadata();
	const stream_decoder_1 = require_stream_decoder();
	const logging = require_logging();
	const constants_2 = require_constants();
	const TRACER_NAME = "subchannel_call";
	/**
	* Should do approximately the same thing as util.getSystemErrorName but the
	* TypeScript types don't have that function for some reason so I just made my
	* own.
	* @param errno
	*/
	function getSystemErrorName(errno) {
		for (const [name, num] of Object.entries(os.constants.errno)) if (num === errno) return name;
		return "Unknown system error " + errno;
	}
	function mapHttpStatusCode(code) {
		const details = `Received HTTP status code ${code}`;
		let mappedStatusCode;
		switch (code) {
			case 400:
				mappedStatusCode = constants_1.Status.INTERNAL;
				break;
			case 401:
				mappedStatusCode = constants_1.Status.UNAUTHENTICATED;
				break;
			case 403:
				mappedStatusCode = constants_1.Status.PERMISSION_DENIED;
				break;
			case 404:
				mappedStatusCode = constants_1.Status.UNIMPLEMENTED;
				break;
			case 429:
			case 502:
			case 503:
			case 504:
				mappedStatusCode = constants_1.Status.UNAVAILABLE;
				break;
			default: mappedStatusCode = constants_1.Status.UNKNOWN;
		}
		return {
			code: mappedStatusCode,
			details,
			metadata: new metadata_1.Metadata()
		};
	}
	var Http2SubchannelCall = class {
		constructor(http2Stream, callEventTracker, listener, transport, callId) {
			var _a;
			this.http2Stream = http2Stream;
			this.callEventTracker = callEventTracker;
			this.listener = listener;
			this.transport = transport;
			this.callId = callId;
			this.isReadFilterPending = false;
			this.isPushPending = false;
			this.canPush = false;
			/**
			* Indicates that an 'end' event has come from the http2 stream, so there
			* will be no more data events.
			*/
			this.readsClosed = false;
			this.statusOutput = false;
			this.unpushedReadMessages = [];
			this.finalStatus = null;
			this.internalError = null;
			this.serverEndedCall = false;
			this.connectionDropped = false;
			const maxReceiveMessageLength = (_a = transport.getOptions()["grpc.max_receive_message_length"]) !== null && _a !== void 0 ? _a : constants_1.DEFAULT_MAX_RECEIVE_MESSAGE_LENGTH;
			this.decoder = new stream_decoder_1.StreamDecoder(maxReceiveMessageLength);
			http2Stream.on("response", (headers, flags) => {
				let headersString = "";
				for (const header of Object.keys(headers)) headersString += "		" + header + ": " + headers[header] + "\n";
				this.trace("Received server headers:\n" + headersString);
				this.httpStatusCode = headers[":status"];
				if (flags & http2$4.constants.NGHTTP2_FLAG_END_STREAM) this.handleTrailers(headers);
				else {
					let metadata;
					try {
						metadata = metadata_1.Metadata.fromHttp2Headers(headers);
					} catch (error) {
						this.endCall({
							code: constants_1.Status.UNKNOWN,
							details: error.message,
							metadata: new metadata_1.Metadata()
						});
						return;
					}
					this.listener.onReceiveMetadata(metadata);
				}
			});
			http2Stream.on("trailers", (headers) => {
				this.handleTrailers(headers);
			});
			http2Stream.on("data", (data) => {
				if (this.statusOutput) return;
				this.trace("receive HTTP/2 data frame of length " + data.length);
				let messages;
				try {
					messages = this.decoder.write(data);
				} catch (e) {
					if (this.httpStatusCode !== void 0 && this.httpStatusCode !== 200) {
						const mappedStatus = mapHttpStatusCode(this.httpStatusCode);
						this.cancelWithStatus(mappedStatus.code, mappedStatus.details);
					} else this.cancelWithStatus(constants_1.Status.RESOURCE_EXHAUSTED, e.message);
					return;
				}
				for (const message of messages) {
					this.trace("parsed message of length " + message.length);
					this.callEventTracker.addMessageReceived();
					this.tryPush(message);
				}
			});
			http2Stream.on("end", () => {
				this.readsClosed = true;
				this.maybeOutputStatus();
			});
			http2Stream.on("close", () => {
				this.serverEndedCall = true;
				process.nextTick(() => {
					var _a;
					this.trace("HTTP/2 stream closed with code " + http2Stream.rstCode);
					if (((_a = this.finalStatus) === null || _a === void 0 ? void 0 : _a.code) === constants_1.Status.OK) return;
					let code;
					let details = "";
					switch (http2Stream.rstCode) {
						case http2$4.constants.NGHTTP2_NO_ERROR:
							if (this.finalStatus !== null) return;
							if (this.httpStatusCode && this.httpStatusCode !== 200) {
								const mappedStatus = mapHttpStatusCode(this.httpStatusCode);
								code = mappedStatus.code;
								details = mappedStatus.details;
							} else {
								code = constants_1.Status.INTERNAL;
								details = `Received RST_STREAM with code ${http2Stream.rstCode} (Call ended without gRPC status)`;
							}
							break;
						case http2$4.constants.NGHTTP2_REFUSED_STREAM:
							code = constants_1.Status.UNAVAILABLE;
							details = "Stream refused by server";
							break;
						case http2$4.constants.NGHTTP2_CANCEL:
							if (this.connectionDropped) {
								code = constants_1.Status.UNAVAILABLE;
								details = "Connection dropped";
							} else {
								code = constants_1.Status.CANCELLED;
								details = "Call cancelled";
							}
							break;
						case http2$4.constants.NGHTTP2_ENHANCE_YOUR_CALM:
							code = constants_1.Status.RESOURCE_EXHAUSTED;
							details = "Bandwidth exhausted or memory limit exceeded";
							break;
						case http2$4.constants.NGHTTP2_INADEQUATE_SECURITY:
							code = constants_1.Status.PERMISSION_DENIED;
							details = "Protocol not secure enough";
							break;
						case http2$4.constants.NGHTTP2_INTERNAL_ERROR:
							code = constants_1.Status.INTERNAL;
							if (this.internalError === null) details = `Received RST_STREAM with code ${http2Stream.rstCode} (Internal server error)`;
							else if (this.internalError.code === "ECONNRESET" || this.internalError.code === "ETIMEDOUT") {
								code = constants_1.Status.UNAVAILABLE;
								details = this.internalError.message;
							} else details = `Received RST_STREAM with code ${http2Stream.rstCode} triggered by internal client error: ${this.internalError.message}`;
							break;
						default:
							code = constants_1.Status.INTERNAL;
							details = `Received RST_STREAM with code ${http2Stream.rstCode}`;
					}
					this.endCall({
						code,
						details,
						metadata: new metadata_1.Metadata(),
						rstCode: http2Stream.rstCode
					});
				});
			});
			http2Stream.on("error", (err) => {
				if (err.code !== "ERR_HTTP2_STREAM_ERROR") {
					this.trace("Node error event: message=" + err.message + " code=" + err.code + " errno=" + getSystemErrorName(err.errno) + " syscall=" + err.syscall);
					this.internalError = err;
				}
				this.callEventTracker.onStreamEnd(false);
			});
		}
		getDeadlineInfo() {
			return [`remote_addr=${this.getPeer()}`];
		}
		onDisconnect() {
			this.connectionDropped = true;
			setImmediate(() => {
				this.endCall({
					code: constants_1.Status.UNAVAILABLE,
					details: "Connection dropped",
					metadata: new metadata_1.Metadata()
				});
			});
		}
		outputStatus() {
			if (!this.statusOutput) {
				this.statusOutput = true;
				this.trace("ended with status: code=" + this.finalStatus.code + " details=\"" + this.finalStatus.details + "\"");
				this.callEventTracker.onCallEnd(this.finalStatus);
				process.nextTick(() => {
					this.listener.onReceiveStatus(this.finalStatus);
				});
				this.http2Stream.resume();
			}
		}
		trace(text) {
			logging.trace(constants_2.LogVerbosity.DEBUG, TRACER_NAME, "[" + this.callId + "] " + text);
		}
		/**
		* On first call, emits a 'status' event with the given StatusObject.
		* Subsequent calls are no-ops.
		* @param status The status of the call.
		*/
		endCall(status) {
			if (this.finalStatus === null || this.finalStatus.code === constants_1.Status.OK) {
				this.finalStatus = status;
				this.maybeOutputStatus();
			}
			this.destroyHttp2Stream();
		}
		maybeOutputStatus() {
			if (this.finalStatus !== null) {
				if (this.finalStatus.code !== constants_1.Status.OK || this.readsClosed && this.unpushedReadMessages.length === 0 && !this.isReadFilterPending && !this.isPushPending) this.outputStatus();
			}
		}
		push(message) {
			this.trace("pushing to reader message of length " + (message instanceof Buffer ? message.length : null));
			this.canPush = false;
			this.isPushPending = true;
			process.nextTick(() => {
				this.isPushPending = false;
				if (this.statusOutput) return;
				this.listener.onReceiveMessage(message);
				this.maybeOutputStatus();
			});
		}
		tryPush(messageBytes) {
			if (this.canPush) {
				this.http2Stream.pause();
				this.push(messageBytes);
			} else {
				this.trace("unpushedReadMessages.push message of length " + messageBytes.length);
				this.unpushedReadMessages.push(messageBytes);
			}
		}
		handleTrailers(headers) {
			this.serverEndedCall = true;
			this.callEventTracker.onStreamEnd(true);
			let headersString = "";
			for (const header of Object.keys(headers)) headersString += "		" + header + ": " + headers[header] + "\n";
			this.trace("Received server trailers:\n" + headersString);
			let metadata;
			try {
				metadata = metadata_1.Metadata.fromHttp2Headers(headers);
			} catch (e) {
				metadata = new metadata_1.Metadata();
			}
			const metadataMap = metadata.getMap();
			let status;
			if (typeof metadataMap["grpc-status"] === "string") {
				const receivedStatus = Number(metadataMap["grpc-status"]);
				this.trace("received status code " + receivedStatus + " from server");
				metadata.remove("grpc-status");
				let details = "";
				if (typeof metadataMap["grpc-message"] === "string") {
					try {
						details = decodeURI(metadataMap["grpc-message"]);
					} catch (e) {
						details = metadataMap["grpc-message"];
					}
					metadata.remove("grpc-message");
					this.trace("received status details string \"" + details + "\" from server");
				}
				status = {
					code: receivedStatus,
					details,
					metadata
				};
			} else if (this.httpStatusCode) {
				status = mapHttpStatusCode(this.httpStatusCode);
				status.metadata = metadata;
			} else status = {
				code: constants_1.Status.UNKNOWN,
				details: "No status information received",
				metadata
			};
			this.endCall(status);
		}
		destroyHttp2Stream() {
			var _a;
			if (this.http2Stream.destroyed) return;
			if (this.serverEndedCall) this.http2Stream.end();
			else {
				let code;
				if (((_a = this.finalStatus) === null || _a === void 0 ? void 0 : _a.code) === constants_1.Status.OK) code = http2$4.constants.NGHTTP2_NO_ERROR;
				else code = http2$4.constants.NGHTTP2_CANCEL;
				this.trace("close http2 stream with code " + code);
				this.http2Stream.close(code);
			}
		}
		cancelWithStatus(status, details) {
			this.trace("cancelWithStatus code: " + status + " details: \"" + details + "\"");
			this.endCall({
				code: status,
				details,
				metadata: new metadata_1.Metadata()
			});
		}
		getStatus() {
			return this.finalStatus;
		}
		getPeer() {
			return this.transport.getPeerName();
		}
		getCallNumber() {
			return this.callId;
		}
		getAuthContext() {
			return this.transport.getAuthContext();
		}
		startRead() {
			if (this.finalStatus !== null && this.finalStatus.code !== constants_1.Status.OK) {
				this.readsClosed = true;
				this.maybeOutputStatus();
				return;
			}
			this.canPush = true;
			if (this.unpushedReadMessages.length > 0) {
				const nextMessage = this.unpushedReadMessages.shift();
				this.push(nextMessage);
				return;
			}
			this.http2Stream.resume();
		}
		sendMessageWithContext(context, message) {
			this.trace("write() called with message of length " + message.length);
			const cb = (error) => {
				process.nextTick(() => {
					var _a;
					let code = constants_1.Status.UNAVAILABLE;
					if ((error === null || error === void 0 ? void 0 : error.code) === "ERR_STREAM_WRITE_AFTER_END") code = constants_1.Status.INTERNAL;
					if (error) this.cancelWithStatus(code, `Write error: ${error.message}`);
					(_a = context.callback) === null || _a === void 0 || _a.call(context);
				});
			};
			this.trace("sending data chunk of length " + message.length);
			this.callEventTracker.addMessageSent();
			try {
				this.http2Stream.write(message, cb);
			} catch (error) {
				this.endCall({
					code: constants_1.Status.UNAVAILABLE,
					details: `Write failed with error ${error.message}`,
					metadata: new metadata_1.Metadata()
				});
			}
		}
		halfClose() {
			this.trace("end() called");
			this.trace("calling end() on HTTP/2 stream");
			this.http2Stream.end();
		}
	};
	exports.Http2SubchannelCall = Http2SubchannelCall;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/transport.js
var require_transport = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Http2SubchannelConnector = void 0;
	const http2$3 = __require("http2");
	const tls_1$1 = __require("tls");
	const channelz_1 = require_channelz();
	const constants_1 = require_constants();
	const http_proxy_1 = require_http_proxy();
	const logging = require_logging();
	const resolver_1 = require_resolver();
	const subchannel_address_1 = require_subchannel_address();
	const uri_parser_1 = require_uri_parser();
	const net = __require("net");
	const subchannel_call_1 = require_subchannel_call();
	const call_number_1 = require_call_number();
	const TRACER_NAME = "transport";
	const FLOW_CONTROL_TRACER_NAME = "transport_flowctrl";
	const clientVersion = require_package().version;
	const { HTTP2_HEADER_AUTHORITY, HTTP2_HEADER_CONTENT_TYPE, HTTP2_HEADER_METHOD, HTTP2_HEADER_PATH, HTTP2_HEADER_TE, HTTP2_HEADER_USER_AGENT } = http2$3.constants;
	const KEEPALIVE_TIMEOUT_MS = 2e4;
	const tooManyPingsData = Buffer.from("too_many_pings", "ascii");
	var Http2Transport = class {
		constructor(session, subchannelAddress, options, remoteName) {
			this.session = session;
			this.options = options;
			this.remoteName = remoteName;
			/**
			* Timer reference indicating when to send the next ping or when the most recent ping will be considered lost.
			*/
			this.keepaliveTimer = null;
			/**
			* Indicates that the keepalive timer ran out while there were no active
			* calls, and a ping should be sent the next time a call starts.
			*/
			this.pendingSendKeepalivePing = false;
			this.activeCalls = /* @__PURE__ */ new Set();
			this.disconnectListeners = [];
			this.disconnectHandled = false;
			this.channelzEnabled = true;
			this.keepalivesSent = 0;
			this.messagesSent = 0;
			this.messagesReceived = 0;
			this.lastMessageSentTimestamp = null;
			this.lastMessageReceivedTimestamp = null;
			this.subchannelAddressString = (0, subchannel_address_1.subchannelAddressToString)(subchannelAddress);
			if (options["grpc.enable_channelz"] === 0) {
				this.channelzEnabled = false;
				this.streamTracker = new channelz_1.ChannelzCallTrackerStub();
			} else this.streamTracker = new channelz_1.ChannelzCallTracker();
			this.channelzRef = (0, channelz_1.registerChannelzSocket)(this.subchannelAddressString, () => this.getChannelzInfo(), this.channelzEnabled);
			this.userAgent = [
				options["grpc.primary_user_agent"],
				`grpc-node-js/${clientVersion}`,
				options["grpc.secondary_user_agent"]
			].filter((e) => e).join(" ");
			if ("grpc.keepalive_time_ms" in options) this.keepaliveTimeMs = options["grpc.keepalive_time_ms"];
			else this.keepaliveTimeMs = -1;
			if ("grpc.keepalive_timeout_ms" in options) this.keepaliveTimeoutMs = options["grpc.keepalive_timeout_ms"];
			else this.keepaliveTimeoutMs = KEEPALIVE_TIMEOUT_MS;
			if ("grpc.keepalive_permit_without_calls" in options) this.keepaliveWithoutCalls = options["grpc.keepalive_permit_without_calls"] === 1;
			else this.keepaliveWithoutCalls = false;
			session.once("close", () => {
				this.trace("session closed");
				this.handleDisconnect();
			});
			session.once("goaway", (errorCode, lastStreamID, opaqueData) => {
				let tooManyPings = false;
				if (errorCode === http2$3.constants.NGHTTP2_ENHANCE_YOUR_CALM && opaqueData && opaqueData.equals(tooManyPingsData)) tooManyPings = true;
				this.trace("connection closed by GOAWAY with code " + errorCode + " and data " + (opaqueData === null || opaqueData === void 0 ? void 0 : opaqueData.toString()));
				this.reportDisconnectToOwner(tooManyPings);
			});
			session.once("error", (error) => {
				this.trace("connection closed with error " + error.message);
				this.handleDisconnect();
			});
			session.socket.once("close", (hadError) => {
				this.trace("connection closed. hadError=" + hadError);
				this.handleDisconnect();
			});
			if (logging.isTracerEnabled(TRACER_NAME)) {
				session.on("remoteSettings", (settings) => {
					this.trace("new settings received" + (this.session !== session ? " on the old connection" : "") + ": " + JSON.stringify(settings));
				});
				session.on("localSettings", (settings) => {
					this.trace("local settings acknowledged by remote" + (this.session !== session ? " on the old connection" : "") + ": " + JSON.stringify(settings));
				});
			}
			if (this.keepaliveWithoutCalls) this.maybeStartKeepalivePingTimer();
			if (session.socket instanceof tls_1$1.TLSSocket) this.authContext = {
				transportSecurityType: "ssl",
				sslPeerCertificate: session.socket.getPeerCertificate()
			};
			else this.authContext = {};
		}
		getChannelzInfo() {
			var _a, _b, _c;
			const sessionSocket = this.session.socket;
			const remoteAddress = sessionSocket.remoteAddress ? (0, subchannel_address_1.stringToSubchannelAddress)(sessionSocket.remoteAddress, sessionSocket.remotePort) : null;
			const localAddress = sessionSocket.localAddress ? (0, subchannel_address_1.stringToSubchannelAddress)(sessionSocket.localAddress, sessionSocket.localPort) : null;
			let tlsInfo;
			if (this.session.encrypted) {
				const tlsSocket = sessionSocket;
				const cipherInfo = tlsSocket.getCipher();
				const certificate = tlsSocket.getCertificate();
				const peerCertificate = tlsSocket.getPeerCertificate();
				tlsInfo = {
					cipherSuiteStandardName: (_a = cipherInfo.standardName) !== null && _a !== void 0 ? _a : null,
					cipherSuiteOtherName: cipherInfo.standardName ? null : cipherInfo.name,
					localCertificate: certificate && "raw" in certificate ? certificate.raw : null,
					remoteCertificate: peerCertificate && "raw" in peerCertificate ? peerCertificate.raw : null
				};
			} else tlsInfo = null;
			return {
				remoteAddress,
				localAddress,
				security: tlsInfo,
				remoteName: this.remoteName,
				streamsStarted: this.streamTracker.callsStarted,
				streamsSucceeded: this.streamTracker.callsSucceeded,
				streamsFailed: this.streamTracker.callsFailed,
				messagesSent: this.messagesSent,
				messagesReceived: this.messagesReceived,
				keepAlivesSent: this.keepalivesSent,
				lastLocalStreamCreatedTimestamp: this.streamTracker.lastCallStartedTimestamp,
				lastRemoteStreamCreatedTimestamp: null,
				lastMessageSentTimestamp: this.lastMessageSentTimestamp,
				lastMessageReceivedTimestamp: this.lastMessageReceivedTimestamp,
				localFlowControlWindow: (_b = this.session.state.localWindowSize) !== null && _b !== void 0 ? _b : null,
				remoteFlowControlWindow: (_c = this.session.state.remoteWindowSize) !== null && _c !== void 0 ? _c : null
			};
		}
		trace(text) {
			logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, "(" + this.channelzRef.id + ") " + this.subchannelAddressString + " " + text);
		}
		keepaliveTrace(text) {
			logging.trace(constants_1.LogVerbosity.DEBUG, "keepalive", "(" + this.channelzRef.id + ") " + this.subchannelAddressString + " " + text);
		}
		flowControlTrace(text) {
			logging.trace(constants_1.LogVerbosity.DEBUG, FLOW_CONTROL_TRACER_NAME, "(" + this.channelzRef.id + ") " + this.subchannelAddressString + " " + text);
		}
		internalsTrace(text) {
			logging.trace(constants_1.LogVerbosity.DEBUG, "transport_internals", "(" + this.channelzRef.id + ") " + this.subchannelAddressString + " " + text);
		}
		/**
		* Indicate to the owner of this object that this transport should no longer
		* be used. That happens if the connection drops, or if the server sends a
		* GOAWAY.
		* @param tooManyPings If true, this was triggered by a GOAWAY with data
		* indicating that the session was closed becaues the client sent too many
		* pings.
		* @returns
		*/
		reportDisconnectToOwner(tooManyPings) {
			if (this.disconnectHandled) return;
			this.disconnectHandled = true;
			this.disconnectListeners.forEach((listener) => listener(tooManyPings));
		}
		/**
		* Handle connection drops, but not GOAWAYs.
		*/
		handleDisconnect() {
			this.clearKeepaliveTimeout();
			this.reportDisconnectToOwner(false);
			for (const call of this.activeCalls) call.onDisconnect();
			setImmediate(() => {
				this.session.destroy();
			});
		}
		addDisconnectListener(listener) {
			this.disconnectListeners.push(listener);
		}
		canSendPing() {
			return !this.session.destroyed && this.keepaliveTimeMs > 0 && (this.keepaliveWithoutCalls || this.activeCalls.size > 0);
		}
		maybeSendPing() {
			var _a, _b;
			if (!this.canSendPing()) {
				this.pendingSendKeepalivePing = true;
				return;
			}
			if (this.keepaliveTimer) {
				console.error("keepaliveTimeout is not null");
				return;
			}
			if (this.channelzEnabled) this.keepalivesSent += 1;
			this.keepaliveTrace("Sending ping with timeout " + this.keepaliveTimeoutMs + "ms");
			this.keepaliveTimer = setTimeout(() => {
				this.keepaliveTimer = null;
				this.keepaliveTrace("Ping timeout passed without response");
				this.handleDisconnect();
			}, this.keepaliveTimeoutMs);
			(_b = (_a = this.keepaliveTimer).unref) === null || _b === void 0 || _b.call(_a);
			let pingSendError = "";
			try {
				if (!this.session.ping((err, duration, payload) => {
					this.clearKeepaliveTimeout();
					if (err) {
						this.keepaliveTrace("Ping failed with error " + err.message);
						this.handleDisconnect();
					} else {
						this.keepaliveTrace("Received ping response");
						this.maybeStartKeepalivePingTimer();
					}
				})) pingSendError = "Ping returned false";
			} catch (e) {
				pingSendError = (e instanceof Error ? e.message : "") || "Unknown error";
			}
			if (pingSendError) {
				this.keepaliveTrace("Ping send failed: " + pingSendError);
				this.handleDisconnect();
			}
		}
		/**
		* Starts the keepalive ping timer if appropriate. If the timer already ran
		* out while there were no active requests, instead send a ping immediately.
		* If the ping timer is already running or a ping is currently in flight,
		* instead do nothing and wait for them to resolve.
		*/
		maybeStartKeepalivePingTimer() {
			var _a, _b;
			if (!this.canSendPing()) return;
			if (this.pendingSendKeepalivePing) {
				this.pendingSendKeepalivePing = false;
				this.maybeSendPing();
			} else if (!this.keepaliveTimer) {
				this.keepaliveTrace("Starting keepalive timer for " + this.keepaliveTimeMs + "ms");
				this.keepaliveTimer = setTimeout(() => {
					this.keepaliveTimer = null;
					this.maybeSendPing();
				}, this.keepaliveTimeMs);
				(_b = (_a = this.keepaliveTimer).unref) === null || _b === void 0 || _b.call(_a);
			}
		}
		/**
		* Clears whichever keepalive timeout is currently active, if any.
		*/
		clearKeepaliveTimeout() {
			if (this.keepaliveTimer) {
				clearTimeout(this.keepaliveTimer);
				this.keepaliveTimer = null;
			}
		}
		removeActiveCall(call) {
			this.activeCalls.delete(call);
			if (this.activeCalls.size === 0) this.session.unref();
		}
		addActiveCall(call) {
			this.activeCalls.add(call);
			if (this.activeCalls.size === 1) {
				this.session.ref();
				if (!this.keepaliveWithoutCalls) this.maybeStartKeepalivePingTimer();
			}
		}
		createCall(metadata, host, method, listener, subchannelCallStatsTracker) {
			const headers = metadata.toHttp2Headers();
			headers[HTTP2_HEADER_AUTHORITY] = host;
			headers[HTTP2_HEADER_USER_AGENT] = this.userAgent;
			headers[HTTP2_HEADER_CONTENT_TYPE] = "application/grpc";
			headers[HTTP2_HEADER_METHOD] = "POST";
			headers[HTTP2_HEADER_PATH] = method;
			headers[HTTP2_HEADER_TE] = "trailers";
			let http2Stream;
			try {
				http2Stream = this.session.request(headers);
			} catch (e) {
				this.handleDisconnect();
				throw e;
			}
			this.flowControlTrace("local window size: " + this.session.state.localWindowSize + " remote window size: " + this.session.state.remoteWindowSize);
			this.internalsTrace("session.closed=" + this.session.closed + " session.destroyed=" + this.session.destroyed + " session.socket.destroyed=" + this.session.socket.destroyed);
			let eventTracker;
			let call;
			if (this.channelzEnabled) {
				this.streamTracker.addCallStarted();
				eventTracker = {
					addMessageSent: () => {
						var _a;
						this.messagesSent += 1;
						this.lastMessageSentTimestamp = /* @__PURE__ */ new Date();
						(_a = subchannelCallStatsTracker.addMessageSent) === null || _a === void 0 || _a.call(subchannelCallStatsTracker);
					},
					addMessageReceived: () => {
						var _a;
						this.messagesReceived += 1;
						this.lastMessageReceivedTimestamp = /* @__PURE__ */ new Date();
						(_a = subchannelCallStatsTracker.addMessageReceived) === null || _a === void 0 || _a.call(subchannelCallStatsTracker);
					},
					onCallEnd: (status) => {
						var _a;
						(_a = subchannelCallStatsTracker.onCallEnd) === null || _a === void 0 || _a.call(subchannelCallStatsTracker, status);
						this.removeActiveCall(call);
					},
					onStreamEnd: (success) => {
						var _a;
						if (success) this.streamTracker.addCallSucceeded();
						else this.streamTracker.addCallFailed();
						(_a = subchannelCallStatsTracker.onStreamEnd) === null || _a === void 0 || _a.call(subchannelCallStatsTracker, success);
					}
				};
			} else eventTracker = {
				addMessageSent: () => {
					var _a;
					(_a = subchannelCallStatsTracker.addMessageSent) === null || _a === void 0 || _a.call(subchannelCallStatsTracker);
				},
				addMessageReceived: () => {
					var _a;
					(_a = subchannelCallStatsTracker.addMessageReceived) === null || _a === void 0 || _a.call(subchannelCallStatsTracker);
				},
				onCallEnd: (status) => {
					var _a;
					(_a = subchannelCallStatsTracker.onCallEnd) === null || _a === void 0 || _a.call(subchannelCallStatsTracker, status);
					this.removeActiveCall(call);
				},
				onStreamEnd: (success) => {
					var _a;
					(_a = subchannelCallStatsTracker.onStreamEnd) === null || _a === void 0 || _a.call(subchannelCallStatsTracker, success);
				}
			};
			call = new subchannel_call_1.Http2SubchannelCall(http2Stream, eventTracker, listener, this, (0, call_number_1.getNextCallNumber)());
			this.addActiveCall(call);
			return call;
		}
		getChannelzRef() {
			return this.channelzRef;
		}
		getPeerName() {
			return this.subchannelAddressString;
		}
		getOptions() {
			return this.options;
		}
		getAuthContext() {
			return this.authContext;
		}
		shutdown() {
			this.session.close();
			(0, channelz_1.unregisterChannelzRef)(this.channelzRef);
		}
	};
	var Http2SubchannelConnector = class {
		constructor(channelTarget) {
			this.channelTarget = channelTarget;
			this.session = null;
			this.isShutdown = false;
		}
		trace(text) {
			logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, (0, uri_parser_1.uriToString)(this.channelTarget) + " " + text);
		}
		createSession(secureConnectResult, address, options) {
			if (this.isShutdown) return Promise.reject();
			if (secureConnectResult.socket.closed) return Promise.reject("Connection closed before starting HTTP/2 handshake");
			return new Promise((resolve, reject) => {
				var _a, _b, _c, _d, _e, _f, _g, _h;
				let remoteName = null;
				let realTarget = this.channelTarget;
				if ("grpc.http_connect_target" in options) {
					const parsedTarget = (0, uri_parser_1.parseUri)(options["grpc.http_connect_target"]);
					if (parsedTarget) {
						realTarget = parsedTarget;
						remoteName = (0, uri_parser_1.uriToString)(parsedTarget);
					}
				}
				const scheme = secureConnectResult.secure ? "https" : "http";
				const targetPath = (0, resolver_1.getDefaultAuthority)(realTarget);
				const closeHandler = () => {
					var _a;
					(_a = this.session) === null || _a === void 0 || _a.destroy();
					this.session = null;
					setImmediate(() => {
						if (!reportedError) {
							reportedError = true;
							reject(`${errorMessage.trim()} (${(/* @__PURE__ */ new Date()).toISOString()})`);
						}
					});
				};
				const errorHandler = (error) => {
					var _a;
					(_a = this.session) === null || _a === void 0 || _a.destroy();
					errorMessage = error.message;
					this.trace("connection failed with error " + errorMessage);
					if (!reportedError) {
						reportedError = true;
						reject(`${errorMessage} (${(/* @__PURE__ */ new Date()).toISOString()})`);
					}
				};
				const sessionOptions = {
					createConnection: (authority, option) => {
						return secureConnectResult.socket;
					},
					settings: { initialWindowSize: (_d = (_a = options["grpc-node.flow_control_window"]) !== null && _a !== void 0 ? _a : (_c = (_b = http2$3.getDefaultSettings) === null || _b === void 0 ? void 0 : _b.call(http2$3)) === null || _c === void 0 ? void 0 : _c.initialWindowSize) !== null && _d !== void 0 ? _d : 65535 },
					maxSendHeaderBlockLength: Number.MAX_SAFE_INTEGER,
					maxSessionMemory: (_e = options["grpc-node.max_session_memory"]) !== null && _e !== void 0 ? _e : Number.MAX_SAFE_INTEGER
				};
				const session = http2$3.connect(`${scheme}://${targetPath}`, sessionOptions);
				const defaultWin = (_h = (_g = (_f = http2$3.getDefaultSettings) === null || _f === void 0 ? void 0 : _f.call(http2$3)) === null || _g === void 0 ? void 0 : _g.initialWindowSize) !== null && _h !== void 0 ? _h : 65535;
				const connWin = options["grpc-node.flow_control_window"];
				this.session = session;
				let errorMessage = "Failed to connect";
				let reportedError = false;
				session.unref();
				session.once("remoteSettings", () => {
					var _a;
					if (connWin && connWin > defaultWin) try {
						session.setLocalWindowSize(connWin);
					} catch (_b) {
						const delta = connWin - ((_a = session.state.localWindowSize) !== null && _a !== void 0 ? _a : defaultWin);
						if (delta > 0) session.incrementWindowSize(delta);
					}
					session.removeAllListeners();
					secureConnectResult.socket.removeListener("close", closeHandler);
					secureConnectResult.socket.removeListener("error", errorHandler);
					resolve(new Http2Transport(session, address, options, remoteName));
					this.session = null;
				});
				session.once("close", closeHandler);
				session.once("error", errorHandler);
				secureConnectResult.socket.once("close", closeHandler);
				secureConnectResult.socket.once("error", errorHandler);
			});
		}
		tcpConnect(address, options) {
			return (0, http_proxy_1.getProxiedConnection)(address, options).then((proxiedSocket) => {
				if (proxiedSocket) return proxiedSocket;
				else return new Promise((resolve, reject) => {
					const closeCallback = () => {
						reject(/* @__PURE__ */ new Error("Socket closed"));
					};
					const errorCallback = (error) => {
						reject(error);
					};
					const socket = net.connect(address, () => {
						socket.removeListener("close", closeCallback);
						socket.removeListener("error", errorCallback);
						resolve(socket);
					});
					socket.once("close", closeCallback);
					socket.once("error", errorCallback);
				});
			});
		}
		async connect(address, secureConnector, options) {
			if (this.isShutdown) return Promise.reject();
			let tcpConnection = null;
			let secureConnectResult = null;
			const addressString = (0, subchannel_address_1.subchannelAddressToString)(address);
			try {
				this.trace(addressString + " Waiting for secureConnector to be ready");
				await secureConnector.waitForReady();
				this.trace(addressString + " secureConnector is ready");
				tcpConnection = await this.tcpConnect(address, options);
				tcpConnection.setNoDelay();
				this.trace(addressString + " Established TCP connection");
				secureConnectResult = await secureConnector.connect(tcpConnection);
				this.trace(addressString + " Established secure connection");
				return this.createSession(secureConnectResult, address, options);
			} catch (e) {
				tcpConnection === null || tcpConnection === void 0 || tcpConnection.destroy();
				secureConnectResult === null || secureConnectResult === void 0 || secureConnectResult.socket.destroy();
				throw e;
			}
		}
		shutdown() {
			var _a;
			this.isShutdown = true;
			(_a = this.session) === null || _a === void 0 || _a.close();
			this.session = null;
		}
	};
	exports.Http2SubchannelConnector = Http2SubchannelConnector;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/subchannel-pool.js
var require_subchannel_pool = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.SubchannelPool = void 0;
	exports.getSubchannelPool = getSubchannelPool;
	const channel_options_1 = require_channel_options();
	const subchannel_1 = require_subchannel();
	const subchannel_address_1 = require_subchannel_address();
	const uri_parser_1 = require_uri_parser();
	const transport_1 = require_transport();
	/**
	* The amount of time in between checks for dropping subchannels that have no
	* other references
	*/
	const REF_CHECK_INTERVAL = 1e4;
	var SubchannelPool = class {
		/**
		* A pool of subchannels use for making connections. Subchannels with the
		* exact same parameters will be reused.
		*/
		constructor() {
			this.pool = Object.create(null);
			/**
			* A timer of a task performing a periodic subchannel cleanup.
			*/
			this.cleanupTimer = null;
		}
		/**
		* Unrefs all unused subchannels and cancels the cleanup task if all
		* subchannels have been unrefed.
		*/
		unrefUnusedSubchannels() {
			let allSubchannelsUnrefed = true;
			for (const channelTarget in this.pool) {
				const refedSubchannels = this.pool[channelTarget].filter((value) => !value.subchannel.unrefIfOneRef());
				if (refedSubchannels.length > 0) allSubchannelsUnrefed = false;
				this.pool[channelTarget] = refedSubchannels;
			}
			if (allSubchannelsUnrefed && this.cleanupTimer !== null) {
				clearInterval(this.cleanupTimer);
				this.cleanupTimer = null;
			}
		}
		/**
		* Ensures that the cleanup task is spawned.
		*/
		ensureCleanupTask() {
			var _a, _b;
			if (this.cleanupTimer === null) {
				this.cleanupTimer = setInterval(() => {
					this.unrefUnusedSubchannels();
				}, REF_CHECK_INTERVAL);
				(_b = (_a = this.cleanupTimer).unref) === null || _b === void 0 || _b.call(_a);
			}
		}
		/**
		* Get a subchannel if one already exists with exactly matching parameters.
		* Otherwise, create and save a subchannel with those parameters.
		* @param channelTarget
		* @param subchannelTarget
		* @param channelArguments
		* @param channelCredentials
		*/
		getOrCreateSubchannel(channelTargetUri, subchannelTarget, channelArguments, channelCredentials) {
			this.ensureCleanupTask();
			const channelTarget = (0, uri_parser_1.uriToString)(channelTargetUri);
			if (channelTarget in this.pool) {
				const subchannelObjArray = this.pool[channelTarget];
				for (const subchannelObj of subchannelObjArray) if ((0, subchannel_address_1.subchannelAddressEqual)(subchannelTarget, subchannelObj.subchannelAddress) && (0, channel_options_1.channelOptionsEqual)(channelArguments, subchannelObj.channelArguments) && channelCredentials._equals(subchannelObj.channelCredentials)) return subchannelObj.subchannel;
			}
			const subchannel = new subchannel_1.Subchannel(channelTargetUri, subchannelTarget, channelArguments, channelCredentials, new transport_1.Http2SubchannelConnector(channelTargetUri));
			if (!(channelTarget in this.pool)) this.pool[channelTarget] = [];
			this.pool[channelTarget].push({
				subchannelAddress: subchannelTarget,
				channelArguments,
				channelCredentials,
				subchannel
			});
			subchannel.ref();
			return subchannel;
		}
	};
	exports.SubchannelPool = SubchannelPool;
	const globalSubchannelPool = new SubchannelPool();
	/**
	* Get either the global subchannel pool, or a new subchannel pool.
	* @param global
	*/
	function getSubchannelPool(global) {
		if (global) return globalSubchannelPool;
		else return new SubchannelPool();
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/load-balancing-call.js
var require_load_balancing_call = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.LoadBalancingCall = void 0;
	const connectivity_state_1 = require_connectivity_state();
	const constants_1 = require_constants();
	const deadline_1 = require_deadline();
	const metadata_1 = require_metadata();
	const picker_1 = require_picker();
	const uri_parser_1 = require_uri_parser();
	const logging = require_logging();
	const control_plane_status_1 = require_control_plane_status();
	const http2$2 = __require("http2");
	const TRACER_NAME = "load_balancing_call";
	var LoadBalancingCall = class {
		constructor(channel, callConfig, methodName, host, credentials, deadline, callNumber) {
			var _a, _b;
			this.channel = channel;
			this.callConfig = callConfig;
			this.methodName = methodName;
			this.host = host;
			this.credentials = credentials;
			this.deadline = deadline;
			this.callNumber = callNumber;
			this.child = null;
			this.readPending = false;
			this.pendingMessage = null;
			this.pendingHalfClose = false;
			this.ended = false;
			this.metadata = null;
			this.listener = null;
			this.onCallEnded = null;
			this.childStartTime = null;
			const splitPath = this.methodName.split("/");
			let serviceName = "";
			if (splitPath.length >= 2) serviceName = splitPath[1];
			this.serviceUrl = `https://${(_b = (_a = (0, uri_parser_1.splitHostPort)(this.host)) === null || _a === void 0 ? void 0 : _a.host) !== null && _b !== void 0 ? _b : "localhost"}/${serviceName}`;
			this.startTime = /* @__PURE__ */ new Date();
		}
		getDeadlineInfo() {
			var _a, _b;
			const deadlineInfo = [];
			if (this.childStartTime) {
				if (this.childStartTime > this.startTime) {
					if ((_a = this.metadata) === null || _a === void 0 ? void 0 : _a.getOptions().waitForReady) deadlineInfo.push("wait_for_ready");
					deadlineInfo.push(`LB pick: ${(0, deadline_1.formatDateDifference)(this.startTime, this.childStartTime)}`);
				}
				deadlineInfo.push(...this.child.getDeadlineInfo());
				return deadlineInfo;
			} else {
				if ((_b = this.metadata) === null || _b === void 0 ? void 0 : _b.getOptions().waitForReady) deadlineInfo.push("wait_for_ready");
				deadlineInfo.push("Waiting for LB pick");
			}
			return deadlineInfo;
		}
		trace(text) {
			logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, "[" + this.callNumber + "] " + text);
		}
		outputStatus(status, progress) {
			var _a, _b;
			if (!this.ended) {
				this.ended = true;
				this.trace("ended with status: code=" + status.code + " details=\"" + status.details + "\" start time=" + this.startTime.toISOString());
				const finalStatus = Object.assign(Object.assign({}, status), { progress });
				(_a = this.listener) === null || _a === void 0 || _a.onReceiveStatus(finalStatus);
				(_b = this.onCallEnded) === null || _b === void 0 || _b.call(this, finalStatus.code, finalStatus.details, finalStatus.metadata);
			}
		}
		doPick() {
			var _a, _b;
			if (this.ended) return;
			if (!this.metadata) throw new Error("doPick called before start");
			this.trace("Pick called");
			const finalMetadata = this.metadata.clone();
			const pickResult = this.channel.doPick(finalMetadata, this.callConfig.pickInformation);
			const subchannelString = pickResult.subchannel ? "(" + pickResult.subchannel.getChannelzRef().id + ") " + pickResult.subchannel.getAddress() : "" + pickResult.subchannel;
			this.trace("Pick result: " + picker_1.PickResultType[pickResult.pickResultType] + " subchannel: " + subchannelString + " status: " + ((_a = pickResult.status) === null || _a === void 0 ? void 0 : _a.code) + " " + ((_b = pickResult.status) === null || _b === void 0 ? void 0 : _b.details));
			switch (pickResult.pickResultType) {
				case picker_1.PickResultType.COMPLETE:
					this.credentials.compose(pickResult.subchannel.getCallCredentials()).generateMetadata({
						method_name: this.methodName,
						service_url: this.serviceUrl
					}).then((credsMetadata) => {
						var _a;
						if (this.ended) {
							this.trace("Credentials metadata generation finished after call ended");
							return;
						}
						finalMetadata.merge(credsMetadata);
						if (finalMetadata.get("authorization").length > 1) this.outputStatus({
							code: constants_1.Status.INTERNAL,
							details: "\"authorization\" metadata cannot have multiple values",
							metadata: new metadata_1.Metadata()
						}, "PROCESSED");
						if (pickResult.subchannel.getConnectivityState() !== connectivity_state_1.ConnectivityState.READY) {
							this.trace("Picked subchannel " + subchannelString + " has state " + connectivity_state_1.ConnectivityState[pickResult.subchannel.getConnectivityState()] + " after getting credentials metadata. Retrying pick");
							this.doPick();
							return;
						}
						if (this.deadline !== Infinity) finalMetadata.set("grpc-timeout", (0, deadline_1.getDeadlineTimeoutString)(this.deadline));
						try {
							this.child = pickResult.subchannel.getRealSubchannel().createCall(finalMetadata, this.host, this.methodName, {
								onReceiveMetadata: (metadata) => {
									this.trace("Received metadata");
									this.listener.onReceiveMetadata(metadata);
								},
								onReceiveMessage: (message) => {
									this.trace("Received message");
									this.listener.onReceiveMessage(message);
								},
								onReceiveStatus: (status) => {
									this.trace("Received status");
									if (status.rstCode === http2$2.constants.NGHTTP2_REFUSED_STREAM) this.outputStatus(status, "REFUSED");
									else this.outputStatus(status, "PROCESSED");
								}
							});
							this.childStartTime = /* @__PURE__ */ new Date();
						} catch (error) {
							this.trace("Failed to start call on picked subchannel " + subchannelString + " with error " + error.message);
							this.outputStatus({
								code: constants_1.Status.INTERNAL,
								details: "Failed to start HTTP/2 stream with error " + error.message,
								metadata: new metadata_1.Metadata()
							}, "NOT_STARTED");
							return;
						}
						(_a = pickResult.onCallStarted) === null || _a === void 0 || _a.call(pickResult);
						this.onCallEnded = pickResult.onCallEnded;
						this.trace("Created child call [" + this.child.getCallNumber() + "]");
						if (this.readPending) this.child.startRead();
						if (this.pendingMessage) this.child.sendMessageWithContext(this.pendingMessage.context, this.pendingMessage.message);
						if (this.pendingHalfClose) this.child.halfClose();
					}, (error) => {
						const { code, details } = (0, control_plane_status_1.restrictControlPlaneStatusCode)(typeof error.code === "number" ? error.code : constants_1.Status.UNKNOWN, `Getting metadata from plugin failed with error: ${error.message}`);
						this.outputStatus({
							code,
							details,
							metadata: new metadata_1.Metadata()
						}, "PROCESSED");
					});
					break;
				case picker_1.PickResultType.DROP:
					const { code, details } = (0, control_plane_status_1.restrictControlPlaneStatusCode)(pickResult.status.code, pickResult.status.details);
					setImmediate(() => {
						this.outputStatus({
							code,
							details,
							metadata: pickResult.status.metadata
						}, "DROP");
					});
					break;
				case picker_1.PickResultType.TRANSIENT_FAILURE:
					if (this.metadata.getOptions().waitForReady) this.channel.queueCallForPick(this);
					else {
						const { code, details } = (0, control_plane_status_1.restrictControlPlaneStatusCode)(pickResult.status.code, pickResult.status.details);
						setImmediate(() => {
							this.outputStatus({
								code,
								details,
								metadata: pickResult.status.metadata
							}, "PROCESSED");
						});
					}
					break;
				case picker_1.PickResultType.QUEUE: this.channel.queueCallForPick(this);
			}
		}
		cancelWithStatus(status, details) {
			var _a;
			this.trace("cancelWithStatus code: " + status + " details: \"" + details + "\"");
			(_a = this.child) === null || _a === void 0 || _a.cancelWithStatus(status, details);
			this.outputStatus({
				code: status,
				details,
				metadata: new metadata_1.Metadata()
			}, "PROCESSED");
		}
		getPeer() {
			var _a, _b;
			return (_b = (_a = this.child) === null || _a === void 0 ? void 0 : _a.getPeer()) !== null && _b !== void 0 ? _b : this.channel.getTarget();
		}
		start(metadata, listener) {
			this.trace("start called");
			this.listener = listener;
			this.metadata = metadata;
			this.doPick();
		}
		sendMessageWithContext(context, message) {
			this.trace("write() called with message of length " + message.length);
			if (this.child) this.child.sendMessageWithContext(context, message);
			else this.pendingMessage = {
				context,
				message
			};
		}
		startRead() {
			this.trace("startRead called");
			if (this.child) this.child.startRead();
			else this.readPending = true;
		}
		halfClose() {
			this.trace("halfClose called");
			if (this.child) this.child.halfClose();
			else this.pendingHalfClose = true;
		}
		setCredentials(credentials) {
			throw new Error("Method not implemented.");
		}
		getCallNumber() {
			return this.callNumber;
		}
		getAuthContext() {
			if (this.child) return this.child.getAuthContext();
			else return null;
		}
	};
	exports.LoadBalancingCall = LoadBalancingCall;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/resolving-call.js
var require_resolving_call = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ResolvingCall = void 0;
	const call_credentials_1 = require_call_credentials();
	const constants_1 = require_constants();
	const deadline_1 = require_deadline();
	const metadata_1 = require_metadata();
	const logging = require_logging();
	const control_plane_status_1 = require_control_plane_status();
	const TRACER_NAME = "resolving_call";
	var ResolvingCall = class {
		constructor(channel, method, options, filterStackFactory, callNumber) {
			this.channel = channel;
			this.method = method;
			this.filterStackFactory = filterStackFactory;
			this.callNumber = callNumber;
			this.child = null;
			this.readPending = false;
			this.pendingMessage = null;
			this.pendingHalfClose = false;
			this.ended = false;
			this.readFilterPending = false;
			this.writeFilterPending = false;
			this.pendingChildStatus = null;
			this.metadata = null;
			this.listener = null;
			this.statusWatchers = [];
			this.deadlineTimer = setTimeout(() => {}, 0);
			this.filterStack = null;
			this.deadlineStartTime = null;
			this.configReceivedTime = null;
			this.childStartTime = null;
			/**
			* Credentials configured for this specific call. Does not include
			* call credentials associated with the channel credentials used to create
			* the channel.
			*/
			this.credentials = call_credentials_1.CallCredentials.createEmpty();
			this.deadline = options.deadline;
			this.host = options.host;
			if (options.parentCall) {
				if (options.flags & constants_1.Propagate.CANCELLATION) options.parentCall.on("cancelled", () => {
					this.cancelWithStatus(constants_1.Status.CANCELLED, "Cancelled by parent call");
				});
				if (options.flags & constants_1.Propagate.DEADLINE) {
					this.trace("Propagating deadline from parent: " + options.parentCall.getDeadline());
					this.deadline = (0, deadline_1.minDeadline)(this.deadline, options.parentCall.getDeadline());
				}
			}
			this.trace("Created");
			this.runDeadlineTimer();
		}
		trace(text) {
			logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, "[" + this.callNumber + "] " + text);
		}
		runDeadlineTimer() {
			clearTimeout(this.deadlineTimer);
			this.deadlineStartTime = /* @__PURE__ */ new Date();
			this.trace("Deadline: " + (0, deadline_1.deadlineToString)(this.deadline));
			const timeout = (0, deadline_1.getRelativeTimeout)(this.deadline);
			if (timeout !== Infinity) {
				this.trace("Deadline will be reached in " + timeout + "ms");
				const handleDeadline = () => {
					if (!this.deadlineStartTime) {
						this.cancelWithStatus(constants_1.Status.DEADLINE_EXCEEDED, "Deadline exceeded");
						return;
					}
					const deadlineInfo = [];
					const deadlineEndTime = /* @__PURE__ */ new Date();
					deadlineInfo.push(`Deadline exceeded after ${(0, deadline_1.formatDateDifference)(this.deadlineStartTime, deadlineEndTime)}`);
					if (this.configReceivedTime) {
						if (this.configReceivedTime > this.deadlineStartTime) deadlineInfo.push(`name resolution: ${(0, deadline_1.formatDateDifference)(this.deadlineStartTime, this.configReceivedTime)}`);
						if (this.childStartTime) {
							if (this.childStartTime > this.configReceivedTime) deadlineInfo.push(`metadata filters: ${(0, deadline_1.formatDateDifference)(this.configReceivedTime, this.childStartTime)}`);
						} else deadlineInfo.push("waiting for metadata filters");
					} else deadlineInfo.push("waiting for name resolution");
					if (this.child) deadlineInfo.push(...this.child.getDeadlineInfo());
					this.cancelWithStatus(constants_1.Status.DEADLINE_EXCEEDED, deadlineInfo.join(","));
				};
				if (timeout <= 0) process.nextTick(handleDeadline);
				else this.deadlineTimer = setTimeout(handleDeadline, timeout);
			}
		}
		outputStatus(status) {
			if (!this.ended) {
				this.ended = true;
				if (!this.filterStack) this.filterStack = this.filterStackFactory.createFilter();
				clearTimeout(this.deadlineTimer);
				const filteredStatus = this.filterStack.receiveTrailers(status);
				this.trace("ended with status: code=" + filteredStatus.code + " details=\"" + filteredStatus.details + "\"");
				this.statusWatchers.forEach((watcher) => watcher(filteredStatus));
				process.nextTick(() => {
					var _a;
					(_a = this.listener) === null || _a === void 0 || _a.onReceiveStatus(filteredStatus);
				});
			}
		}
		sendMessageOnChild(context, message) {
			if (!this.child) throw new Error("sendMessageonChild called with child not populated");
			const child = this.child;
			this.writeFilterPending = true;
			this.filterStack.sendMessage(Promise.resolve({
				message,
				flags: context.flags
			})).then((filteredMessage) => {
				this.writeFilterPending = false;
				child.sendMessageWithContext(context, filteredMessage.message);
				if (this.pendingHalfClose) child.halfClose();
			}, (status) => {
				this.cancelWithStatus(status.code, status.details);
			});
		}
		getConfig() {
			if (this.ended) return;
			if (!this.metadata || !this.listener) throw new Error("getConfig called before start");
			const configResult = this.channel.getConfig(this.method, this.metadata);
			if (configResult.type === "NONE") {
				this.channel.queueCallForConfig(this);
				return;
			} else if (configResult.type === "ERROR") {
				if (this.metadata.getOptions().waitForReady) this.channel.queueCallForConfig(this);
				else this.outputStatus(configResult.error);
				return;
			}
			this.configReceivedTime = /* @__PURE__ */ new Date();
			const config = configResult.config;
			if (config.status !== constants_1.Status.OK) {
				const { code, details } = (0, control_plane_status_1.restrictControlPlaneStatusCode)(config.status, "Failed to route call to method " + this.method);
				this.outputStatus({
					code,
					details,
					metadata: new metadata_1.Metadata()
				});
				return;
			}
			if (config.methodConfig.timeout) {
				const configDeadline = /* @__PURE__ */ new Date();
				configDeadline.setSeconds(configDeadline.getSeconds() + config.methodConfig.timeout.seconds);
				configDeadline.setMilliseconds(configDeadline.getMilliseconds() + config.methodConfig.timeout.nanos / 1e6);
				this.deadline = (0, deadline_1.minDeadline)(this.deadline, configDeadline);
				this.runDeadlineTimer();
			}
			this.filterStackFactory.push(config.dynamicFilterFactories);
			this.filterStack = this.filterStackFactory.createFilter();
			this.filterStack.sendMetadata(Promise.resolve(this.metadata)).then((filteredMetadata) => {
				this.child = this.channel.createRetryingCall(config, this.method, this.host, this.credentials, this.deadline);
				this.trace("Created child [" + this.child.getCallNumber() + "]");
				this.childStartTime = /* @__PURE__ */ new Date();
				this.child.start(filteredMetadata, {
					onReceiveMetadata: (metadata) => {
						this.trace("Received metadata");
						this.listener.onReceiveMetadata(this.filterStack.receiveMetadata(metadata));
					},
					onReceiveMessage: (message) => {
						this.trace("Received message");
						this.readFilterPending = true;
						this.filterStack.receiveMessage(message).then((filteredMesssage) => {
							this.trace("Finished filtering received message");
							this.readFilterPending = false;
							this.listener.onReceiveMessage(filteredMesssage);
							if (this.pendingChildStatus) this.outputStatus(this.pendingChildStatus);
						}, (status) => {
							this.cancelWithStatus(status.code, status.details);
						});
					},
					onReceiveStatus: (status) => {
						this.trace("Received status");
						if (this.readFilterPending) this.pendingChildStatus = status;
						else this.outputStatus(status);
					}
				});
				if (this.readPending) this.child.startRead();
				if (this.pendingMessage) this.sendMessageOnChild(this.pendingMessage.context, this.pendingMessage.message);
				else if (this.pendingHalfClose) this.child.halfClose();
			}, (status) => {
				this.outputStatus(status);
			});
		}
		reportResolverError(status) {
			var _a;
			if ((_a = this.metadata) === null || _a === void 0 ? void 0 : _a.getOptions().waitForReady) this.channel.queueCallForConfig(this);
			else this.outputStatus(status);
		}
		cancelWithStatus(status, details) {
			var _a;
			this.trace("cancelWithStatus code: " + status + " details: \"" + details + "\"");
			(_a = this.child) === null || _a === void 0 || _a.cancelWithStatus(status, details);
			this.outputStatus({
				code: status,
				details,
				metadata: new metadata_1.Metadata()
			});
		}
		getPeer() {
			var _a, _b;
			return (_b = (_a = this.child) === null || _a === void 0 ? void 0 : _a.getPeer()) !== null && _b !== void 0 ? _b : this.channel.getTarget();
		}
		start(metadata, listener) {
			this.trace("start called");
			this.metadata = metadata.clone();
			this.listener = listener;
			this.getConfig();
		}
		sendMessageWithContext(context, message) {
			this.trace("write() called with message of length " + message.length);
			if (this.child) this.sendMessageOnChild(context, message);
			else this.pendingMessage = {
				context,
				message
			};
		}
		startRead() {
			this.trace("startRead called");
			if (this.child) this.child.startRead();
			else this.readPending = true;
		}
		halfClose() {
			this.trace("halfClose called");
			if (this.child && !this.writeFilterPending) this.child.halfClose();
			else this.pendingHalfClose = true;
		}
		setCredentials(credentials) {
			this.credentials = credentials;
		}
		addStatusWatcher(watcher) {
			this.statusWatchers.push(watcher);
		}
		getCallNumber() {
			return this.callNumber;
		}
		getAuthContext() {
			if (this.child) return this.child.getAuthContext();
			else return null;
		}
	};
	exports.ResolvingCall = ResolvingCall;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/retrying-call.js
var require_retrying_call = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.RetryingCall = exports.MessageBufferTracker = exports.RetryThrottler = void 0;
	const constants_1 = require_constants();
	const deadline_1 = require_deadline();
	const metadata_1 = require_metadata();
	const logging = require_logging();
	const TRACER_NAME = "retrying_call";
	var RetryThrottler = class {
		constructor(maxTokens, tokenRatio, previousRetryThrottler) {
			this.maxTokens = maxTokens;
			this.tokenRatio = tokenRatio;
			if (previousRetryThrottler) this.tokens = previousRetryThrottler.tokens * (maxTokens / previousRetryThrottler.maxTokens);
			else this.tokens = maxTokens;
		}
		addCallSucceeded() {
			this.tokens = Math.min(this.tokens + this.tokenRatio, this.maxTokens);
		}
		addCallFailed() {
			this.tokens = Math.max(this.tokens - 1, 0);
		}
		canRetryCall() {
			return this.tokens > this.maxTokens / 2;
		}
	};
	exports.RetryThrottler = RetryThrottler;
	var MessageBufferTracker = class {
		constructor(totalLimit, limitPerCall) {
			this.totalLimit = totalLimit;
			this.limitPerCall = limitPerCall;
			this.totalAllocated = 0;
			this.allocatedPerCall = /* @__PURE__ */ new Map();
		}
		allocate(size, callId) {
			var _a;
			const currentPerCall = (_a = this.allocatedPerCall.get(callId)) !== null && _a !== void 0 ? _a : 0;
			if (this.limitPerCall - currentPerCall < size || this.totalLimit - this.totalAllocated < size) return false;
			this.allocatedPerCall.set(callId, currentPerCall + size);
			this.totalAllocated += size;
			return true;
		}
		free(size, callId) {
			var _a;
			if (this.totalAllocated < size) throw new Error(`Invalid buffer allocation state: call ${callId} freed ${size} > total allocated ${this.totalAllocated}`);
			this.totalAllocated -= size;
			const currentPerCall = (_a = this.allocatedPerCall.get(callId)) !== null && _a !== void 0 ? _a : 0;
			if (currentPerCall < size) throw new Error(`Invalid buffer allocation state: call ${callId} freed ${size} > allocated for call ${currentPerCall}`);
			this.allocatedPerCall.set(callId, currentPerCall - size);
		}
		freeAll(callId) {
			var _a;
			const currentPerCall = (_a = this.allocatedPerCall.get(callId)) !== null && _a !== void 0 ? _a : 0;
			if (this.totalAllocated < currentPerCall) throw new Error(`Invalid buffer allocation state: call ${callId} allocated ${currentPerCall} > total allocated ${this.totalAllocated}`);
			this.totalAllocated -= currentPerCall;
			this.allocatedPerCall.delete(callId);
		}
	};
	exports.MessageBufferTracker = MessageBufferTracker;
	const PREVIONS_RPC_ATTEMPTS_METADATA_KEY = "grpc-previous-rpc-attempts";
	const DEFAULT_MAX_ATTEMPTS_LIMIT = 5;
	var RetryingCall = class {
		constructor(channel, callConfig, methodName, host, credentials, deadline, callNumber, bufferTracker, retryThrottler) {
			var _a;
			this.channel = channel;
			this.callConfig = callConfig;
			this.methodName = methodName;
			this.host = host;
			this.credentials = credentials;
			this.deadline = deadline;
			this.callNumber = callNumber;
			this.bufferTracker = bufferTracker;
			this.retryThrottler = retryThrottler;
			this.listener = null;
			this.initialMetadata = null;
			this.underlyingCalls = [];
			this.writeBuffer = [];
			/**
			* The offset of message indices in the writeBuffer. For example, if
			* writeBufferOffset is 10, message 10 is in writeBuffer[0] and message 15
			* is in writeBuffer[5].
			*/
			this.writeBufferOffset = 0;
			/**
			* Tracks whether a read has been started, so that we know whether to start
			* reads on new child calls. This only matters for the first read, because
			* once a message comes in the child call becomes committed and there will
			* be no new child calls.
			*/
			this.readStarted = false;
			this.transparentRetryUsed = false;
			/**
			* Number of attempts so far
			*/
			this.attempts = 0;
			this.hedgingTimer = null;
			this.committedCallIndex = null;
			this.initialRetryBackoffSec = 0;
			this.nextRetryBackoffSec = 0;
			const maxAttemptsLimit = (_a = channel.getOptions()["grpc-node.retry_max_attempts_limit"]) !== null && _a !== void 0 ? _a : DEFAULT_MAX_ATTEMPTS_LIMIT;
			if (channel.getOptions()["grpc.enable_retries"] === 0) {
				this.state = "NO_RETRY";
				this.maxAttempts = 1;
			} else if (callConfig.methodConfig.retryPolicy) {
				this.state = "RETRY";
				const retryPolicy = callConfig.methodConfig.retryPolicy;
				this.nextRetryBackoffSec = this.initialRetryBackoffSec = Number(retryPolicy.initialBackoff.substring(0, retryPolicy.initialBackoff.length - 1));
				this.maxAttempts = Math.min(retryPolicy.maxAttempts, maxAttemptsLimit);
			} else if (callConfig.methodConfig.hedgingPolicy) {
				this.state = "HEDGING";
				this.maxAttempts = Math.min(callConfig.methodConfig.hedgingPolicy.maxAttempts, maxAttemptsLimit);
			} else {
				this.state = "TRANSPARENT_ONLY";
				this.maxAttempts = 1;
			}
			this.startTime = /* @__PURE__ */ new Date();
		}
		getDeadlineInfo() {
			if (this.underlyingCalls.length === 0) return [];
			const deadlineInfo = [];
			const latestCall = this.underlyingCalls[this.underlyingCalls.length - 1];
			if (this.underlyingCalls.length > 1) deadlineInfo.push(`previous attempts: ${this.underlyingCalls.length - 1}`);
			if (latestCall.startTime > this.startTime) deadlineInfo.push(`time to current attempt start: ${(0, deadline_1.formatDateDifference)(this.startTime, latestCall.startTime)}`);
			deadlineInfo.push(...latestCall.call.getDeadlineInfo());
			return deadlineInfo;
		}
		getCallNumber() {
			return this.callNumber;
		}
		trace(text) {
			logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, "[" + this.callNumber + "] " + text);
		}
		reportStatus(statusObject) {
			this.trace("ended with status: code=" + statusObject.code + " details=\"" + statusObject.details + "\" start time=" + this.startTime.toISOString());
			this.bufferTracker.freeAll(this.callNumber);
			this.writeBufferOffset = this.writeBufferOffset + this.writeBuffer.length;
			this.writeBuffer = [];
			process.nextTick(() => {
				var _a;
				(_a = this.listener) === null || _a === void 0 || _a.onReceiveStatus({
					code: statusObject.code,
					details: statusObject.details,
					metadata: statusObject.metadata
				});
			});
		}
		cancelWithStatus(status, details) {
			this.trace("cancelWithStatus code: " + status + " details: \"" + details + "\"");
			this.reportStatus({
				code: status,
				details,
				metadata: new metadata_1.Metadata()
			});
			for (const { call } of this.underlyingCalls) call.cancelWithStatus(status, details);
		}
		getPeer() {
			if (this.committedCallIndex !== null) return this.underlyingCalls[this.committedCallIndex].call.getPeer();
			else return "unknown";
		}
		getBufferEntry(messageIndex) {
			var _a;
			return (_a = this.writeBuffer[messageIndex - this.writeBufferOffset]) !== null && _a !== void 0 ? _a : {
				entryType: "FREED",
				allocated: false
			};
		}
		getNextBufferIndex() {
			return this.writeBufferOffset + this.writeBuffer.length;
		}
		clearSentMessages() {
			if (this.state !== "COMMITTED") return;
			let earliestNeededMessageIndex;
			if (this.underlyingCalls[this.committedCallIndex].state === "COMPLETED") earliestNeededMessageIndex = this.getNextBufferIndex();
			else earliestNeededMessageIndex = this.underlyingCalls[this.committedCallIndex].nextMessageToSend;
			for (let messageIndex = this.writeBufferOffset; messageIndex < earliestNeededMessageIndex; messageIndex++) {
				const bufferEntry = this.getBufferEntry(messageIndex);
				if (bufferEntry.allocated) this.bufferTracker.free(bufferEntry.message.message.length, this.callNumber);
			}
			this.writeBuffer = this.writeBuffer.slice(earliestNeededMessageIndex - this.writeBufferOffset);
			this.writeBufferOffset = earliestNeededMessageIndex;
		}
		commitCall(index) {
			var _a, _b;
			if (this.state === "COMMITTED") return;
			this.trace("Committing call [" + this.underlyingCalls[index].call.getCallNumber() + "] at index " + index);
			this.state = "COMMITTED";
			(_b = (_a = this.callConfig).onCommitted) === null || _b === void 0 || _b.call(_a);
			this.committedCallIndex = index;
			for (let i = 0; i < this.underlyingCalls.length; i++) {
				if (i === index) continue;
				if (this.underlyingCalls[i].state === "COMPLETED") continue;
				this.underlyingCalls[i].state = "COMPLETED";
				this.underlyingCalls[i].call.cancelWithStatus(constants_1.Status.CANCELLED, "Discarded in favor of other hedged attempt");
			}
			this.clearSentMessages();
		}
		commitCallWithMostMessages() {
			if (this.state === "COMMITTED") return;
			let mostMessages = -1;
			let callWithMostMessages = -1;
			for (const [index, childCall] of this.underlyingCalls.entries()) if (childCall.state === "ACTIVE" && childCall.nextMessageToSend > mostMessages) {
				mostMessages = childCall.nextMessageToSend;
				callWithMostMessages = index;
			}
			if (callWithMostMessages === -1) this.state = "TRANSPARENT_ONLY";
			else this.commitCall(callWithMostMessages);
		}
		isStatusCodeInList(list, code) {
			return list.some((value) => {
				var _a;
				return value === code || value.toString().toLowerCase() === ((_a = constants_1.Status[code]) === null || _a === void 0 ? void 0 : _a.toLowerCase());
			});
		}
		getNextRetryJitter() {
			return Math.random() * .3999999999999999 + .8;
		}
		getNextRetryBackoffMs() {
			var _a;
			const retryPolicy = (_a = this.callConfig) === null || _a === void 0 ? void 0 : _a.methodConfig.retryPolicy;
			if (!retryPolicy) return 0;
			const nextBackoffMs = this.getNextRetryJitter() * this.nextRetryBackoffSec * 1e3;
			const maxBackoffSec = Number(retryPolicy.maxBackoff.substring(0, retryPolicy.maxBackoff.length - 1));
			this.nextRetryBackoffSec = Math.min(this.nextRetryBackoffSec * retryPolicy.backoffMultiplier, maxBackoffSec);
			return nextBackoffMs;
		}
		maybeRetryCall(pushback, callback) {
			if (this.state !== "RETRY") {
				callback(false);
				return;
			}
			if (this.attempts >= this.maxAttempts) {
				callback(false);
				return;
			}
			let retryDelayMs;
			if (pushback === null) retryDelayMs = this.getNextRetryBackoffMs();
			else if (pushback < 0) {
				this.state = "TRANSPARENT_ONLY";
				callback(false);
				return;
			} else {
				retryDelayMs = pushback;
				this.nextRetryBackoffSec = this.initialRetryBackoffSec;
			}
			setTimeout(() => {
				var _a, _b;
				if (this.state !== "RETRY") {
					callback(false);
					return;
				}
				if ((_b = (_a = this.retryThrottler) === null || _a === void 0 ? void 0 : _a.canRetryCall()) !== null && _b !== void 0 ? _b : true) {
					callback(true);
					this.attempts += 1;
					this.startNewAttempt();
				} else {
					this.trace("Retry attempt denied by throttling policy");
					callback(false);
				}
			}, retryDelayMs);
		}
		countActiveCalls() {
			let count = 0;
			for (const call of this.underlyingCalls) if ((call === null || call === void 0 ? void 0 : call.state) === "ACTIVE") count += 1;
			return count;
		}
		handleProcessedStatus(status, callIndex, pushback) {
			var _a, _b, _c;
			switch (this.state) {
				case "COMMITTED":
				case "NO_RETRY":
				case "TRANSPARENT_ONLY":
					this.commitCall(callIndex);
					this.reportStatus(status);
					break;
				case "HEDGING":
					if (this.isStatusCodeInList((_a = this.callConfig.methodConfig.hedgingPolicy.nonFatalStatusCodes) !== null && _a !== void 0 ? _a : [], status.code)) {
						(_b = this.retryThrottler) === null || _b === void 0 || _b.addCallFailed();
						let delayMs;
						if (pushback === null) delayMs = 0;
						else if (pushback < 0) {
							this.state = "TRANSPARENT_ONLY";
							this.commitCall(callIndex);
							this.reportStatus(status);
							return;
						} else delayMs = pushback;
						setTimeout(() => {
							this.maybeStartHedgingAttempt();
							if (this.countActiveCalls() === 0) {
								this.commitCall(callIndex);
								this.reportStatus(status);
							}
						}, delayMs);
					} else {
						this.commitCall(callIndex);
						this.reportStatus(status);
					}
					break;
				case "RETRY":
					if (this.isStatusCodeInList(this.callConfig.methodConfig.retryPolicy.retryableStatusCodes, status.code)) {
						(_c = this.retryThrottler) === null || _c === void 0 || _c.addCallFailed();
						this.maybeRetryCall(pushback, (retried) => {
							if (!retried) {
								this.commitCall(callIndex);
								this.reportStatus(status);
							}
						});
					} else {
						this.commitCall(callIndex);
						this.reportStatus(status);
					}
					break;
			}
		}
		getPushback(metadata) {
			const mdValue = metadata.get("grpc-retry-pushback-ms");
			if (mdValue.length === 0) return null;
			try {
				return parseInt(mdValue[0]);
			} catch (e) {
				return -1;
			}
		}
		handleChildStatus(status, callIndex) {
			var _a;
			if (this.underlyingCalls[callIndex].state === "COMPLETED") return;
			this.trace("state=" + this.state + " handling status with progress " + status.progress + " from child [" + this.underlyingCalls[callIndex].call.getCallNumber() + "] in state " + this.underlyingCalls[callIndex].state);
			this.underlyingCalls[callIndex].state = "COMPLETED";
			if (status.code === constants_1.Status.OK) {
				(_a = this.retryThrottler) === null || _a === void 0 || _a.addCallSucceeded();
				this.commitCall(callIndex);
				this.reportStatus(status);
				return;
			}
			if (this.state === "NO_RETRY") {
				this.commitCall(callIndex);
				this.reportStatus(status);
				return;
			}
			if (this.state === "COMMITTED") {
				this.reportStatus(status);
				return;
			}
			const pushback = this.getPushback(status.metadata);
			switch (status.progress) {
				case "NOT_STARTED":
					this.startNewAttempt();
					break;
				case "REFUSED":
					if (this.transparentRetryUsed) this.handleProcessedStatus(status, callIndex, pushback);
					else {
						this.transparentRetryUsed = true;
						this.startNewAttempt();
					}
					break;
				case "DROP":
					this.commitCall(callIndex);
					this.reportStatus(status);
					break;
				case "PROCESSED":
					this.handleProcessedStatus(status, callIndex, pushback);
					break;
			}
		}
		maybeStartHedgingAttempt() {
			if (this.state !== "HEDGING") return;
			if (!this.callConfig.methodConfig.hedgingPolicy) return;
			if (this.attempts >= this.maxAttempts) return;
			this.attempts += 1;
			this.startNewAttempt();
			this.maybeStartHedgingTimer();
		}
		maybeStartHedgingTimer() {
			var _a, _b, _c;
			if (this.hedgingTimer) clearTimeout(this.hedgingTimer);
			if (this.state !== "HEDGING") return;
			if (!this.callConfig.methodConfig.hedgingPolicy) return;
			const hedgingPolicy = this.callConfig.methodConfig.hedgingPolicy;
			if (this.attempts >= this.maxAttempts) return;
			const hedgingDelayString = (_a = hedgingPolicy.hedgingDelay) !== null && _a !== void 0 ? _a : "0s";
			const hedgingDelaySec = Number(hedgingDelayString.substring(0, hedgingDelayString.length - 1));
			this.hedgingTimer = setTimeout(() => {
				this.maybeStartHedgingAttempt();
			}, hedgingDelaySec * 1e3);
			(_c = (_b = this.hedgingTimer).unref) === null || _c === void 0 || _c.call(_b);
		}
		startNewAttempt() {
			const child = this.channel.createLoadBalancingCall(this.callConfig, this.methodName, this.host, this.credentials, this.deadline);
			this.trace("Created child call [" + child.getCallNumber() + "] for attempt " + this.attempts);
			const index = this.underlyingCalls.length;
			this.underlyingCalls.push({
				state: "ACTIVE",
				call: child,
				nextMessageToSend: 0,
				startTime: /* @__PURE__ */ new Date()
			});
			const previousAttempts = this.attempts - 1;
			const initialMetadata = this.initialMetadata.clone();
			if (previousAttempts > 0) initialMetadata.set(PREVIONS_RPC_ATTEMPTS_METADATA_KEY, `${previousAttempts}`);
			let receivedMetadata = false;
			child.start(initialMetadata, {
				onReceiveMetadata: (metadata) => {
					this.trace("Received metadata from child [" + child.getCallNumber() + "]");
					this.commitCall(index);
					receivedMetadata = true;
					if (previousAttempts > 0) metadata.set(PREVIONS_RPC_ATTEMPTS_METADATA_KEY, `${previousAttempts}`);
					if (this.underlyingCalls[index].state === "ACTIVE") this.listener.onReceiveMetadata(metadata);
				},
				onReceiveMessage: (message) => {
					this.trace("Received message from child [" + child.getCallNumber() + "]");
					this.commitCall(index);
					if (this.underlyingCalls[index].state === "ACTIVE") this.listener.onReceiveMessage(message);
				},
				onReceiveStatus: (status) => {
					this.trace("Received status from child [" + child.getCallNumber() + "]");
					if (!receivedMetadata && previousAttempts > 0) status.metadata.set(PREVIONS_RPC_ATTEMPTS_METADATA_KEY, `${previousAttempts}`);
					this.handleChildStatus(status, index);
				}
			});
			this.sendNextChildMessage(index);
			if (this.readStarted) child.startRead();
		}
		start(metadata, listener) {
			this.trace("start called");
			this.listener = listener;
			this.initialMetadata = metadata;
			this.attempts += 1;
			this.startNewAttempt();
			this.maybeStartHedgingTimer();
		}
		handleChildWriteCompleted(childIndex, messageIndex) {
			var _a, _b;
			(_b = (_a = this.getBufferEntry(messageIndex)).callback) === null || _b === void 0 || _b.call(_a);
			this.clearSentMessages();
			const childCall = this.underlyingCalls[childIndex];
			childCall.nextMessageToSend += 1;
			this.sendNextChildMessage(childIndex);
		}
		sendNextChildMessage(childIndex) {
			const childCall = this.underlyingCalls[childIndex];
			if (childCall.state === "COMPLETED") return;
			const messageIndex = childCall.nextMessageToSend;
			if (this.getBufferEntry(messageIndex)) {
				const bufferEntry = this.getBufferEntry(messageIndex);
				switch (bufferEntry.entryType) {
					case "MESSAGE":
						childCall.call.sendMessageWithContext({ callback: (error) => {
							this.handleChildWriteCompleted(childIndex, messageIndex);
						} }, bufferEntry.message.message);
						if (this.getBufferEntry(messageIndex + 1).entryType === "HALF_CLOSE") {
							this.trace("Sending halfClose immediately after message to child [" + childCall.call.getCallNumber() + "] - optimizing for unary/final message");
							childCall.nextMessageToSend += 1;
							childCall.call.halfClose();
						}
						break;
					case "HALF_CLOSE":
						childCall.nextMessageToSend += 1;
						childCall.call.halfClose();
						break;
					case "FREED": break;
				}
			}
		}
		sendMessageWithContext(context, message) {
			this.trace("write() called with message of length " + message.length);
			const writeObj = {
				message,
				flags: context.flags
			};
			const messageIndex = this.getNextBufferIndex();
			const bufferEntry = {
				entryType: "MESSAGE",
				message: writeObj,
				allocated: this.bufferTracker.allocate(message.length, this.callNumber)
			};
			this.writeBuffer.push(bufferEntry);
			if (bufferEntry.allocated) {
				process.nextTick(() => {
					var _a;
					(_a = context.callback) === null || _a === void 0 || _a.call(context);
				});
				for (const [callIndex, call] of this.underlyingCalls.entries()) if (call.state === "ACTIVE" && call.nextMessageToSend === messageIndex) call.call.sendMessageWithContext({ callback: (error) => {
					this.handleChildWriteCompleted(callIndex, messageIndex);
				} }, message);
			} else {
				this.commitCallWithMostMessages();
				if (this.committedCallIndex === null) return;
				const call = this.underlyingCalls[this.committedCallIndex];
				bufferEntry.callback = context.callback;
				if (call.state === "ACTIVE" && call.nextMessageToSend === messageIndex) call.call.sendMessageWithContext({ callback: (error) => {
					this.handleChildWriteCompleted(this.committedCallIndex, messageIndex);
				} }, message);
			}
		}
		startRead() {
			this.trace("startRead called");
			this.readStarted = true;
			for (const underlyingCall of this.underlyingCalls) if ((underlyingCall === null || underlyingCall === void 0 ? void 0 : underlyingCall.state) === "ACTIVE") underlyingCall.call.startRead();
		}
		halfClose() {
			this.trace("halfClose called");
			const halfCloseIndex = this.getNextBufferIndex();
			this.writeBuffer.push({
				entryType: "HALF_CLOSE",
				allocated: false
			});
			for (const call of this.underlyingCalls) if ((call === null || call === void 0 ? void 0 : call.state) === "ACTIVE") {
				if (call.nextMessageToSend === halfCloseIndex || call.nextMessageToSend === halfCloseIndex - 1) {
					this.trace("Sending halfClose immediately to child [" + call.call.getCallNumber() + "] - all messages already sent");
					call.nextMessageToSend += 1;
					call.call.halfClose();
				}
			}
		}
		setCredentials(newCredentials) {
			throw new Error("Method not implemented.");
		}
		getMethod() {
			return this.methodName;
		}
		getHost() {
			return this.host;
		}
		getAuthContext() {
			if (this.committedCallIndex !== null) return this.underlyingCalls[this.committedCallIndex].call.getAuthContext();
			else return null;
		}
	};
	exports.RetryingCall = RetryingCall;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/subchannel-interface.js
var require_subchannel_interface = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.BaseSubchannelWrapper = void 0;
	var BaseSubchannelWrapper = class {
		constructor(child) {
			this.child = child;
			this.healthy = true;
			this.healthListeners = /* @__PURE__ */ new Set();
			this.refcount = 0;
			this.dataWatchers = /* @__PURE__ */ new Set();
			child.addHealthStateWatcher((childHealthy) => {
				if (this.healthy) this.updateHealthListeners();
			});
		}
		updateHealthListeners() {
			for (const listener of this.healthListeners) listener(this.isHealthy());
		}
		getConnectivityState() {
			return this.child.getConnectivityState();
		}
		addConnectivityStateListener(listener) {
			this.child.addConnectivityStateListener(listener);
		}
		removeConnectivityStateListener(listener) {
			this.child.removeConnectivityStateListener(listener);
		}
		startConnecting() {
			this.child.startConnecting();
		}
		getAddress() {
			return this.child.getAddress();
		}
		throttleKeepalive(newKeepaliveTime) {
			this.child.throttleKeepalive(newKeepaliveTime);
		}
		ref() {
			this.child.ref();
			this.refcount += 1;
		}
		unref() {
			this.child.unref();
			this.refcount -= 1;
			if (this.refcount === 0) this.destroy();
		}
		destroy() {
			for (const watcher of this.dataWatchers) watcher.destroy();
		}
		getChannelzRef() {
			return this.child.getChannelzRef();
		}
		isHealthy() {
			return this.healthy && this.child.isHealthy();
		}
		addHealthStateWatcher(listener) {
			this.healthListeners.add(listener);
		}
		removeHealthStateWatcher(listener) {
			this.healthListeners.delete(listener);
		}
		addDataWatcher(dataWatcher) {
			dataWatcher.setSubchannel(this.getRealSubchannel());
			this.dataWatchers.add(dataWatcher);
		}
		setHealthy(healthy) {
			if (healthy !== this.healthy) {
				this.healthy = healthy;
				if (this.child.isHealthy()) this.updateHealthListeners();
			}
		}
		getRealSubchannel() {
			return this.child.getRealSubchannel();
		}
		realSubchannelEquals(other) {
			return this.getRealSubchannel() === other.getRealSubchannel();
		}
		getCallCredentials() {
			return this.child.getCallCredentials();
		}
		getChannel() {
			return this.child.getChannel();
		}
	};
	exports.BaseSubchannelWrapper = BaseSubchannelWrapper;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/internal-channel.js
var require_internal_channel = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.InternalChannel = exports.SUBCHANNEL_ARGS_EXCLUDE_KEY_PREFIX = void 0;
	const channel_credentials_1 = require_channel_credentials();
	const resolving_load_balancer_1 = require_resolving_load_balancer();
	const subchannel_pool_1 = require_subchannel_pool();
	const picker_1 = require_picker();
	const metadata_1 = require_metadata();
	const constants_1 = require_constants();
	const filter_stack_1 = require_filter_stack();
	const compression_filter_1 = require_compression_filter();
	const resolver_1 = require_resolver();
	const logging_1 = require_logging();
	const http_proxy_1 = require_http_proxy();
	const uri_parser_1 = require_uri_parser();
	const connectivity_state_1 = require_connectivity_state();
	const channelz_1 = require_channelz();
	const load_balancing_call_1 = require_load_balancing_call();
	const deadline_1 = require_deadline();
	const resolving_call_1 = require_resolving_call();
	const call_number_1 = require_call_number();
	const control_plane_status_1 = require_control_plane_status();
	const retrying_call_1 = require_retrying_call();
	const subchannel_interface_1 = require_subchannel_interface();
	/**
	* See https://nodejs.org/api/timers.html#timers_setinterval_callback_delay_args
	*/
	const MAX_TIMEOUT_TIME = 2147483647;
	const MIN_IDLE_TIMEOUT_MS = 1e3;
	const DEFAULT_IDLE_TIMEOUT_MS = 1800 * 1e3;
	const RETRY_THROTTLER_MAP = /* @__PURE__ */ new Map();
	const DEFAULT_RETRY_BUFFER_SIZE_BYTES = 1 << 24;
	const DEFAULT_PER_RPC_RETRY_BUFFER_SIZE_BYTES = 1 << 20;
	var ChannelSubchannelWrapper = class extends subchannel_interface_1.BaseSubchannelWrapper {
		constructor(childSubchannel, channel) {
			super(childSubchannel);
			this.channel = channel;
			this.refCount = 0;
			this.subchannelStateListener = (subchannel, previousState, newState, keepaliveTime) => {
				channel.throttleKeepalive(keepaliveTime);
			};
		}
		ref() {
			if (this.refCount === 0) {
				this.child.addConnectivityStateListener(this.subchannelStateListener);
				this.channel.addWrappedSubchannel(this);
			}
			this.child.ref();
			this.refCount += 1;
		}
		unref() {
			this.child.unref();
			this.refCount -= 1;
			if (this.refCount <= 0) {
				this.child.removeConnectivityStateListener(this.subchannelStateListener);
				this.channel.removeWrappedSubchannel(this);
			}
		}
	};
	var ShutdownPicker = class {
		pick(pickArgs) {
			return {
				pickResultType: picker_1.PickResultType.DROP,
				status: {
					code: constants_1.Status.UNAVAILABLE,
					details: "Channel closed before call started",
					metadata: new metadata_1.Metadata()
				},
				subchannel: null,
				onCallStarted: null,
				onCallEnded: null
			};
		}
	};
	exports.SUBCHANNEL_ARGS_EXCLUDE_KEY_PREFIX = "grpc.internal.no_subchannel";
	var ChannelzInfoTracker = class {
		constructor(target) {
			this.target = target;
			this.trace = new channelz_1.ChannelzTrace();
			this.callTracker = new channelz_1.ChannelzCallTracker();
			this.childrenTracker = new channelz_1.ChannelzChildrenTracker();
			this.state = connectivity_state_1.ConnectivityState.IDLE;
		}
		getChannelzInfoCallback() {
			return () => {
				return {
					target: this.target,
					state: this.state,
					trace: this.trace,
					callTracker: this.callTracker,
					children: this.childrenTracker.getChildLists()
				};
			};
		}
	};
	var InternalChannel = class {
		constructor(target, credentials, options) {
			var _a, _b, _c, _d, _e, _f;
			this.credentials = credentials;
			this.options = options;
			this.connectivityState = connectivity_state_1.ConnectivityState.IDLE;
			this.currentPicker = new picker_1.UnavailablePicker();
			/**
			* Calls queued up to get a call config. Should only be populated before the
			* first time the resolver returns a result, which includes the ConfigSelector.
			*/
			this.configSelectionQueue = [];
			this.pickQueue = [];
			this.connectivityStateWatchers = [];
			/**
			* This timer does not do anything on its own. Its purpose is to hold the
			* event loop open while there are any pending calls for the channel that
			* have not yet been assigned to specific subchannels. In other words,
			* the invariant is that callRefTimer is reffed if and only if pickQueue
			* is non-empty. In addition, the timer is null while the state is IDLE or
			* SHUTDOWN and there are no pending calls.
			*/
			this.callRefTimer = null;
			this.configSelector = null;
			/**
			* This is the error from the name resolver if it failed most recently. It
			* is only used to end calls that start while there is no config selector
			* and the name resolver is in backoff, so it should be nulled if
			* configSelector becomes set or the channel state becomes anything other
			* than TRANSIENT_FAILURE.
			*/
			this.currentResolutionError = null;
			this.wrappedSubchannels = /* @__PURE__ */ new Set();
			this.callCount = 0;
			this.idleTimer = null;
			this.channelzEnabled = true;
			/**
			* Randomly generated ID to be passed to the config selector, for use by
			* ring_hash in xDS. An integer distributed approximately uniformly between
			* 0 and MAX_SAFE_INTEGER.
			*/
			this.randomChannelId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
			if (typeof target !== "string") throw new TypeError("Channel target must be a string");
			if (!(credentials instanceof channel_credentials_1.ChannelCredentials)) throw new TypeError("Channel credentials must be a ChannelCredentials object");
			if (options) {
				if (typeof options !== "object") throw new TypeError("Channel options must be an object");
			}
			this.channelzInfoTracker = new ChannelzInfoTracker(target);
			const originalTargetUri = (0, uri_parser_1.parseUri)(target);
			if (originalTargetUri === null) throw new Error(`Could not parse target name "${target}"`);
			const defaultSchemeMapResult = (0, resolver_1.mapUriDefaultScheme)(originalTargetUri);
			if (defaultSchemeMapResult === null) throw new Error(`Could not find a default scheme for target name "${target}"`);
			if (this.options["grpc.enable_channelz"] === 0) this.channelzEnabled = false;
			this.channelzRef = (0, channelz_1.registerChannelzChannel)(target, this.channelzInfoTracker.getChannelzInfoCallback(), this.channelzEnabled);
			if (this.channelzEnabled) this.channelzInfoTracker.trace.addTrace("CT_INFO", "Channel created");
			if (this.options["grpc.default_authority"]) this.defaultAuthority = this.options["grpc.default_authority"];
			else this.defaultAuthority = (0, resolver_1.getDefaultAuthority)(defaultSchemeMapResult);
			const proxyMapResult = (0, http_proxy_1.mapProxyName)(defaultSchemeMapResult, options);
			this.target = proxyMapResult.target;
			this.options = Object.assign({}, this.options, proxyMapResult.extraOptions);
			this.subchannelPool = (0, subchannel_pool_1.getSubchannelPool)(((_a = this.options["grpc.use_local_subchannel_pool"]) !== null && _a !== void 0 ? _a : 0) === 0);
			this.retryBufferTracker = new retrying_call_1.MessageBufferTracker((_b = this.options["grpc.retry_buffer_size"]) !== null && _b !== void 0 ? _b : DEFAULT_RETRY_BUFFER_SIZE_BYTES, (_c = this.options["grpc.per_rpc_retry_buffer_size"]) !== null && _c !== void 0 ? _c : DEFAULT_PER_RPC_RETRY_BUFFER_SIZE_BYTES);
			this.keepaliveTime = (_d = this.options["grpc.keepalive_time_ms"]) !== null && _d !== void 0 ? _d : -1;
			this.idleTimeoutMs = Math.max((_e = this.options["grpc.client_idle_timeout_ms"]) !== null && _e !== void 0 ? _e : DEFAULT_IDLE_TIMEOUT_MS, MIN_IDLE_TIMEOUT_MS);
			this.resolvingLoadBalancer = new resolving_load_balancer_1.ResolvingLoadBalancer(this.target, {
				createSubchannel: (subchannelAddress, subchannelArgs) => {
					const finalSubchannelArgs = {};
					for (const [key, value] of Object.entries(subchannelArgs)) if (!key.startsWith(exports.SUBCHANNEL_ARGS_EXCLUDE_KEY_PREFIX)) finalSubchannelArgs[key] = value;
					const subchannel = this.subchannelPool.getOrCreateSubchannel(this.target, subchannelAddress, finalSubchannelArgs, this.credentials);
					subchannel.throttleKeepalive(this.keepaliveTime);
					if (this.channelzEnabled) this.channelzInfoTracker.trace.addTrace("CT_INFO", "Created subchannel or used existing subchannel", subchannel.getChannelzRef());
					return new ChannelSubchannelWrapper(subchannel, this);
				},
				updateState: (connectivityState, picker) => {
					this.currentPicker = picker;
					const queueCopy = this.pickQueue.slice();
					this.pickQueue = [];
					if (queueCopy.length > 0) this.callRefTimerUnref();
					for (const call of queueCopy) call.doPick();
					this.updateState(connectivityState);
				},
				requestReresolution: () => {
					throw new Error("Resolving load balancer should never call requestReresolution");
				},
				addChannelzChild: (child) => {
					if (this.channelzEnabled) this.channelzInfoTracker.childrenTracker.refChild(child);
				},
				removeChannelzChild: (child) => {
					if (this.channelzEnabled) this.channelzInfoTracker.childrenTracker.unrefChild(child);
				}
			}, this.options, (serviceConfig, configSelector) => {
				var _a;
				if (serviceConfig.retryThrottling) RETRY_THROTTLER_MAP.set(this.getTarget(), new retrying_call_1.RetryThrottler(serviceConfig.retryThrottling.maxTokens, serviceConfig.retryThrottling.tokenRatio, RETRY_THROTTLER_MAP.get(this.getTarget())));
				else RETRY_THROTTLER_MAP.delete(this.getTarget());
				if (this.channelzEnabled) this.channelzInfoTracker.trace.addTrace("CT_INFO", "Address resolution succeeded");
				(_a = this.configSelector) === null || _a === void 0 || _a.unref();
				this.configSelector = configSelector;
				this.currentResolutionError = null;
				process.nextTick(() => {
					const localQueue = this.configSelectionQueue;
					this.configSelectionQueue = [];
					if (localQueue.length > 0) this.callRefTimerUnref();
					for (const call of localQueue) call.getConfig();
				});
			}, (status) => {
				if (this.channelzEnabled) this.channelzInfoTracker.trace.addTrace("CT_WARNING", "Address resolution failed with code " + status.code + " and details \"" + status.details + "\"");
				if (this.configSelectionQueue.length > 0) this.trace("Name resolution failed with calls queued for config selection");
				if (this.configSelector === null) this.currentResolutionError = Object.assign(Object.assign({}, (0, control_plane_status_1.restrictControlPlaneStatusCode)(status.code, status.details)), { metadata: status.metadata });
				const localQueue = this.configSelectionQueue;
				this.configSelectionQueue = [];
				if (localQueue.length > 0) this.callRefTimerUnref();
				for (const call of localQueue) call.reportResolverError(status);
			});
			this.filterStackFactory = new filter_stack_1.FilterStackFactory([new compression_filter_1.CompressionFilterFactory(this, this.options)]);
			this.trace("Channel constructed with options " + JSON.stringify(options, void 0, 2));
			const error = /* @__PURE__ */ new Error();
			if ((0, logging_1.isTracerEnabled)("channel_stacktrace")) (0, logging_1.trace)(constants_1.LogVerbosity.DEBUG, "channel_stacktrace", "(" + this.channelzRef.id + ") Channel constructed \n" + ((_f = error.stack) === null || _f === void 0 ? void 0 : _f.substring(error.stack.indexOf("\n") + 1)));
			this.lastActivityTimestamp = /* @__PURE__ */ new Date();
		}
		trace(text, verbosityOverride) {
			(0, logging_1.trace)(verbosityOverride !== null && verbosityOverride !== void 0 ? verbosityOverride : constants_1.LogVerbosity.DEBUG, "channel", "(" + this.channelzRef.id + ") " + (0, uri_parser_1.uriToString)(this.target) + " " + text);
		}
		callRefTimerRef() {
			var _a, _b, _c, _d;
			if (!this.callRefTimer) this.callRefTimer = setInterval(() => {}, MAX_TIMEOUT_TIME);
			if (!((_b = (_a = this.callRefTimer).hasRef) === null || _b === void 0 ? void 0 : _b.call(_a))) {
				this.trace("callRefTimer.ref | configSelectionQueue.length=" + this.configSelectionQueue.length + " pickQueue.length=" + this.pickQueue.length);
				(_d = (_c = this.callRefTimer).ref) === null || _d === void 0 || _d.call(_c);
			}
		}
		callRefTimerUnref() {
			var _a, _b, _c;
			if (!((_a = this.callRefTimer) === null || _a === void 0 ? void 0 : _a.hasRef) || this.callRefTimer.hasRef()) {
				this.trace("callRefTimer.unref | configSelectionQueue.length=" + this.configSelectionQueue.length + " pickQueue.length=" + this.pickQueue.length);
				(_c = (_b = this.callRefTimer) === null || _b === void 0 ? void 0 : _b.unref) === null || _c === void 0 || _c.call(_b);
			}
		}
		removeConnectivityStateWatcher(watcherObject) {
			const watcherIndex = this.connectivityStateWatchers.findIndex((value) => value === watcherObject);
			if (watcherIndex >= 0) this.connectivityStateWatchers.splice(watcherIndex, 1);
		}
		updateState(newState) {
			(0, logging_1.trace)(constants_1.LogVerbosity.DEBUG, "connectivity_state", "(" + this.channelzRef.id + ") " + (0, uri_parser_1.uriToString)(this.target) + " " + connectivity_state_1.ConnectivityState[this.connectivityState] + " -> " + connectivity_state_1.ConnectivityState[newState]);
			if (this.channelzEnabled) this.channelzInfoTracker.trace.addTrace("CT_INFO", "Connectivity state change to " + connectivity_state_1.ConnectivityState[newState]);
			this.connectivityState = newState;
			this.channelzInfoTracker.state = newState;
			const watchersCopy = this.connectivityStateWatchers.slice();
			for (const watcherObject of watchersCopy) if (newState !== watcherObject.currentState) {
				if (watcherObject.timer) clearTimeout(watcherObject.timer);
				this.removeConnectivityStateWatcher(watcherObject);
				watcherObject.callback();
			}
			if (newState !== connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE) this.currentResolutionError = null;
		}
		throttleKeepalive(newKeepaliveTime) {
			if (newKeepaliveTime > this.keepaliveTime) {
				this.keepaliveTime = newKeepaliveTime;
				for (const wrappedSubchannel of this.wrappedSubchannels) wrappedSubchannel.throttleKeepalive(newKeepaliveTime);
			}
		}
		addWrappedSubchannel(wrappedSubchannel) {
			this.wrappedSubchannels.add(wrappedSubchannel);
		}
		removeWrappedSubchannel(wrappedSubchannel) {
			this.wrappedSubchannels.delete(wrappedSubchannel);
		}
		doPick(metadata, extraPickInfo) {
			return this.currentPicker.pick({
				metadata,
				extraPickInfo
			});
		}
		queueCallForPick(call) {
			this.pickQueue.push(call);
			this.callRefTimerRef();
		}
		getConfig(method, metadata) {
			if (this.connectivityState !== connectivity_state_1.ConnectivityState.SHUTDOWN) this.resolvingLoadBalancer.exitIdle();
			if (this.configSelector) return {
				type: "SUCCESS",
				config: this.configSelector.invoke(method, metadata, this.randomChannelId)
			};
			else if (this.currentResolutionError) return {
				type: "ERROR",
				error: this.currentResolutionError
			};
			else return { type: "NONE" };
		}
		queueCallForConfig(call) {
			this.configSelectionQueue.push(call);
			this.callRefTimerRef();
		}
		enterIdle() {
			this.resolvingLoadBalancer.destroy();
			this.updateState(connectivity_state_1.ConnectivityState.IDLE);
			this.currentPicker = new picker_1.QueuePicker(this.resolvingLoadBalancer);
			if (this.idleTimer) {
				clearTimeout(this.idleTimer);
				this.idleTimer = null;
			}
			if (this.callRefTimer) {
				clearInterval(this.callRefTimer);
				this.callRefTimer = null;
			}
		}
		startIdleTimeout(timeoutMs) {
			var _a, _b;
			this.idleTimer = setTimeout(() => {
				if (this.callCount > 0) {
					this.startIdleTimeout(this.idleTimeoutMs);
					return;
				}
				const timeSinceLastActivity = (/* @__PURE__ */ new Date()).valueOf() - this.lastActivityTimestamp.valueOf();
				if (timeSinceLastActivity >= this.idleTimeoutMs) {
					this.trace("Idle timer triggered after " + this.idleTimeoutMs + "ms of inactivity");
					this.enterIdle();
				} else this.startIdleTimeout(this.idleTimeoutMs - timeSinceLastActivity);
			}, timeoutMs);
			(_b = (_a = this.idleTimer).unref) === null || _b === void 0 || _b.call(_a);
		}
		maybeStartIdleTimer() {
			if (this.connectivityState !== connectivity_state_1.ConnectivityState.SHUTDOWN && !this.idleTimer) this.startIdleTimeout(this.idleTimeoutMs);
		}
		onCallStart() {
			if (this.channelzEnabled) this.channelzInfoTracker.callTracker.addCallStarted();
			this.callCount += 1;
		}
		onCallEnd(status) {
			if (this.channelzEnabled) if (status.code === constants_1.Status.OK) this.channelzInfoTracker.callTracker.addCallSucceeded();
			else this.channelzInfoTracker.callTracker.addCallFailed();
			this.callCount -= 1;
			this.lastActivityTimestamp = /* @__PURE__ */ new Date();
			this.maybeStartIdleTimer();
		}
		createLoadBalancingCall(callConfig, method, host, credentials, deadline) {
			const callNumber = (0, call_number_1.getNextCallNumber)();
			this.trace("createLoadBalancingCall [" + callNumber + "] method=\"" + method + "\"");
			return new load_balancing_call_1.LoadBalancingCall(this, callConfig, method, host, credentials, deadline, callNumber);
		}
		createRetryingCall(callConfig, method, host, credentials, deadline) {
			const callNumber = (0, call_number_1.getNextCallNumber)();
			this.trace("createRetryingCall [" + callNumber + "] method=\"" + method + "\"");
			return new retrying_call_1.RetryingCall(this, callConfig, method, host, credentials, deadline, callNumber, this.retryBufferTracker, RETRY_THROTTLER_MAP.get(this.getTarget()));
		}
		createResolvingCall(method, deadline, host, parentCall, propagateFlags) {
			const callNumber = (0, call_number_1.getNextCallNumber)();
			this.trace("createResolvingCall [" + callNumber + "] method=\"" + method + "\", deadline=" + (0, deadline_1.deadlineToString)(deadline));
			const finalOptions = {
				deadline,
				flags: propagateFlags !== null && propagateFlags !== void 0 ? propagateFlags : constants_1.Propagate.DEFAULTS,
				host: host !== null && host !== void 0 ? host : this.defaultAuthority,
				parentCall
			};
			const call = new resolving_call_1.ResolvingCall(this, method, finalOptions, this.filterStackFactory.clone(), callNumber);
			this.onCallStart();
			call.addStatusWatcher((status) => {
				this.onCallEnd(status);
			});
			return call;
		}
		close() {
			var _a;
			this.resolvingLoadBalancer.destroy();
			this.updateState(connectivity_state_1.ConnectivityState.SHUTDOWN);
			this.currentPicker = new ShutdownPicker();
			for (const call of this.configSelectionQueue) call.cancelWithStatus(constants_1.Status.UNAVAILABLE, "Channel closed before call started");
			this.configSelectionQueue = [];
			for (const call of this.pickQueue) call.cancelWithStatus(constants_1.Status.UNAVAILABLE, "Channel closed before call started");
			this.pickQueue = [];
			if (this.callRefTimer) clearInterval(this.callRefTimer);
			if (this.idleTimer) clearTimeout(this.idleTimer);
			if (this.channelzEnabled) (0, channelz_1.unregisterChannelzRef)(this.channelzRef);
			this.subchannelPool.unrefUnusedSubchannels();
			(_a = this.configSelector) === null || _a === void 0 || _a.unref();
			this.configSelector = null;
		}
		getTarget() {
			return (0, uri_parser_1.uriToString)(this.target);
		}
		getConnectivityState(tryToConnect) {
			const connectivityState = this.connectivityState;
			if (tryToConnect) {
				this.resolvingLoadBalancer.exitIdle();
				this.lastActivityTimestamp = /* @__PURE__ */ new Date();
				this.maybeStartIdleTimer();
			}
			return connectivityState;
		}
		watchConnectivityState(currentState, deadline, callback) {
			if (this.connectivityState === connectivity_state_1.ConnectivityState.SHUTDOWN) throw new Error("Channel has been shut down");
			let timer = null;
			if (deadline !== Infinity) {
				const deadlineDate = deadline instanceof Date ? deadline : new Date(deadline);
				const now = /* @__PURE__ */ new Date();
				if (deadline === -Infinity || deadlineDate <= now) {
					process.nextTick(callback, /* @__PURE__ */ new Error("Deadline passed without connectivity state change"));
					return;
				}
				timer = setTimeout(() => {
					this.removeConnectivityStateWatcher(watcherObject);
					callback(/* @__PURE__ */ new Error("Deadline passed without connectivity state change"));
				}, deadlineDate.getTime() - now.getTime());
			}
			const watcherObject = {
				currentState,
				callback,
				timer
			};
			this.connectivityStateWatchers.push(watcherObject);
		}
		/**
		* Get the channelz reference object for this channel. The returned value is
		* garbage if channelz is disabled for this channel.
		* @returns
		*/
		getChannelzRef() {
			return this.channelzRef;
		}
		createCall(method, deadline, host, parentCall, propagateFlags) {
			if (typeof method !== "string") throw new TypeError("Channel#createCall: method must be a string");
			if (!(typeof deadline === "number" || deadline instanceof Date)) throw new TypeError("Channel#createCall: deadline must be a number or Date");
			if (this.connectivityState === connectivity_state_1.ConnectivityState.SHUTDOWN) throw new Error("Channel has been shut down");
			return this.createResolvingCall(method, deadline, host, parentCall, propagateFlags);
		}
		getOptions() {
			return this.options;
		}
	};
	exports.InternalChannel = InternalChannel;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/channel.js
var require_channel = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ChannelImplementation = void 0;
	const channel_credentials_1 = require_channel_credentials();
	const internal_channel_1 = require_internal_channel();
	var ChannelImplementation = class {
		constructor(target, credentials, options) {
			if (typeof target !== "string") throw new TypeError("Channel target must be a string");
			if (!(credentials instanceof channel_credentials_1.ChannelCredentials)) throw new TypeError("Channel credentials must be a ChannelCredentials object");
			if (options) {
				if (typeof options !== "object") throw new TypeError("Channel options must be an object");
			}
			this.internalChannel = new internal_channel_1.InternalChannel(target, credentials, options);
		}
		close() {
			this.internalChannel.close();
		}
		getTarget() {
			return this.internalChannel.getTarget();
		}
		getConnectivityState(tryToConnect) {
			return this.internalChannel.getConnectivityState(tryToConnect);
		}
		watchConnectivityState(currentState, deadline, callback) {
			this.internalChannel.watchConnectivityState(currentState, deadline, callback);
		}
		/**
		* Get the channelz reference object for this channel. The returned value is
		* garbage if channelz is disabled for this channel.
		* @returns
		*/
		getChannelzRef() {
			return this.internalChannel.getChannelzRef();
		}
		createCall(method, deadline, host, parentCall, propagateFlags) {
			if (typeof method !== "string") throw new TypeError("Channel#createCall: method must be a string");
			if (!(typeof deadline === "number" || deadline instanceof Date)) throw new TypeError("Channel#createCall: deadline must be a number or Date");
			return this.internalChannel.createCall(method, deadline, host, parentCall, propagateFlags);
		}
	};
	exports.ChannelImplementation = ChannelImplementation;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/server-call.js
var require_server_call = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ServerDuplexStreamImpl = exports.ServerWritableStreamImpl = exports.ServerReadableStreamImpl = exports.ServerUnaryCallImpl = void 0;
	exports.serverErrorToStatus = serverErrorToStatus;
	const events_1 = __require("events");
	const stream_1 = __require("stream");
	const constants_1 = require_constants();
	const metadata_1 = require_metadata();
	function serverErrorToStatus(error, overrideTrailers) {
		var _a;
		const status = {
			code: constants_1.Status.UNKNOWN,
			details: "message" in error ? error.message : "Unknown Error",
			metadata: (_a = overrideTrailers !== null && overrideTrailers !== void 0 ? overrideTrailers : error.metadata) !== null && _a !== void 0 ? _a : null
		};
		if ("code" in error && typeof error.code === "number" && Number.isInteger(error.code)) {
			status.code = error.code;
			if ("details" in error && typeof error.details === "string") status.details = error.details;
		}
		return status;
	}
	var ServerUnaryCallImpl = class extends events_1.EventEmitter {
		constructor(path, call, metadata, request) {
			super();
			this.path = path;
			this.call = call;
			this.metadata = metadata;
			this.request = request;
			this.cancelled = false;
		}
		getPeer() {
			return this.call.getPeer();
		}
		sendMetadata(responseMetadata) {
			this.call.sendMetadata(responseMetadata);
		}
		getDeadline() {
			return this.call.getDeadline();
		}
		getPath() {
			return this.path;
		}
		getHost() {
			return this.call.getHost();
		}
		getAuthContext() {
			return this.call.getAuthContext();
		}
		getMetricsRecorder() {
			return this.call.getMetricsRecorder();
		}
	};
	exports.ServerUnaryCallImpl = ServerUnaryCallImpl;
	var ServerReadableStreamImpl = class extends stream_1.Readable {
		constructor(path, call, metadata) {
			super({ objectMode: true });
			this.path = path;
			this.call = call;
			this.metadata = metadata;
			this.cancelled = false;
		}
		_read(size) {
			this.call.startRead();
		}
		getPeer() {
			return this.call.getPeer();
		}
		sendMetadata(responseMetadata) {
			this.call.sendMetadata(responseMetadata);
		}
		getDeadline() {
			return this.call.getDeadline();
		}
		getPath() {
			return this.path;
		}
		getHost() {
			return this.call.getHost();
		}
		getAuthContext() {
			return this.call.getAuthContext();
		}
		getMetricsRecorder() {
			return this.call.getMetricsRecorder();
		}
	};
	exports.ServerReadableStreamImpl = ServerReadableStreamImpl;
	var ServerWritableStreamImpl = class extends stream_1.Writable {
		constructor(path, call, metadata, request) {
			super({ objectMode: true });
			this.path = path;
			this.call = call;
			this.metadata = metadata;
			this.request = request;
			this.pendingStatus = {
				code: constants_1.Status.OK,
				details: "OK"
			};
			this.cancelled = false;
			this.trailingMetadata = new metadata_1.Metadata();
			this.on("error", (err) => {
				this.pendingStatus = serverErrorToStatus(err);
				this.end();
			});
		}
		getPeer() {
			return this.call.getPeer();
		}
		sendMetadata(responseMetadata) {
			this.call.sendMetadata(responseMetadata);
		}
		getDeadline() {
			return this.call.getDeadline();
		}
		getPath() {
			return this.path;
		}
		getHost() {
			return this.call.getHost();
		}
		getAuthContext() {
			return this.call.getAuthContext();
		}
		getMetricsRecorder() {
			return this.call.getMetricsRecorder();
		}
		_write(chunk, encoding, callback) {
			this.call.sendMessage(chunk, callback);
		}
		_final(callback) {
			var _a;
			callback(null);
			this.call.sendStatus(Object.assign(Object.assign({}, this.pendingStatus), { metadata: (_a = this.pendingStatus.metadata) !== null && _a !== void 0 ? _a : this.trailingMetadata }));
		}
		end(metadata) {
			if (metadata) this.trailingMetadata = metadata;
			return super.end();
		}
	};
	exports.ServerWritableStreamImpl = ServerWritableStreamImpl;
	var ServerDuplexStreamImpl = class extends stream_1.Duplex {
		constructor(path, call, metadata) {
			super({ objectMode: true });
			this.path = path;
			this.call = call;
			this.metadata = metadata;
			this.pendingStatus = {
				code: constants_1.Status.OK,
				details: "OK"
			};
			this.cancelled = false;
			this.trailingMetadata = new metadata_1.Metadata();
			this.on("error", (err) => {
				this.pendingStatus = serverErrorToStatus(err);
				this.end();
			});
		}
		getPeer() {
			return this.call.getPeer();
		}
		sendMetadata(responseMetadata) {
			this.call.sendMetadata(responseMetadata);
		}
		getDeadline() {
			return this.call.getDeadline();
		}
		getPath() {
			return this.path;
		}
		getHost() {
			return this.call.getHost();
		}
		getAuthContext() {
			return this.call.getAuthContext();
		}
		getMetricsRecorder() {
			return this.call.getMetricsRecorder();
		}
		_read(size) {
			this.call.startRead();
		}
		_write(chunk, encoding, callback) {
			this.call.sendMessage(chunk, callback);
		}
		_final(callback) {
			var _a;
			callback(null);
			this.call.sendStatus(Object.assign(Object.assign({}, this.pendingStatus), { metadata: (_a = this.pendingStatus.metadata) !== null && _a !== void 0 ? _a : this.trailingMetadata }));
		}
		end(metadata) {
			if (metadata) this.trailingMetadata = metadata;
			return super.end();
		}
	};
	exports.ServerDuplexStreamImpl = ServerDuplexStreamImpl;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/server-credentials.js
var require_server_credentials = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ServerCredentials = void 0;
	exports.createCertificateProviderServerCredentials = createCertificateProviderServerCredentials;
	exports.createServerCredentialsWithInterceptors = createServerCredentialsWithInterceptors;
	const tls_helpers_1 = require_tls_helpers();
	var ServerCredentials = class {
		constructor(serverConstructorOptions, contextOptions) {
			this.serverConstructorOptions = serverConstructorOptions;
			this.watchers = /* @__PURE__ */ new Set();
			this.latestContextOptions = null;
			this.latestContextOptions = contextOptions !== null && contextOptions !== void 0 ? contextOptions : null;
		}
		_addWatcher(watcher) {
			this.watchers.add(watcher);
		}
		_removeWatcher(watcher) {
			this.watchers.delete(watcher);
		}
		getWatcherCount() {
			return this.watchers.size;
		}
		updateSecureContextOptions(options) {
			this.latestContextOptions = options;
			for (const watcher of this.watchers) watcher(this.latestContextOptions);
		}
		_isSecure() {
			return this.serverConstructorOptions !== null;
		}
		_getSecureContextOptions() {
			return this.latestContextOptions;
		}
		_getConstructorOptions() {
			return this.serverConstructorOptions;
		}
		_getInterceptors() {
			return [];
		}
		static createInsecure() {
			return new InsecureServerCredentials();
		}
		static createSsl(rootCerts, keyCertPairs, checkClientCertificate = false) {
			var _a;
			if (rootCerts !== null && !Buffer.isBuffer(rootCerts)) throw new TypeError("rootCerts must be null or a Buffer");
			if (!Array.isArray(keyCertPairs)) throw new TypeError("keyCertPairs must be an array");
			if (typeof checkClientCertificate !== "boolean") throw new TypeError("checkClientCertificate must be a boolean");
			const cert = [];
			const key = [];
			for (let i = 0; i < keyCertPairs.length; i++) {
				const pair = keyCertPairs[i];
				if (pair === null || typeof pair !== "object") throw new TypeError(`keyCertPair[${i}] must be an object`);
				if (!Buffer.isBuffer(pair.private_key)) throw new TypeError(`keyCertPair[${i}].private_key must be a Buffer`);
				if (!Buffer.isBuffer(pair.cert_chain)) throw new TypeError(`keyCertPair[${i}].cert_chain must be a Buffer`);
				cert.push(pair.cert_chain);
				key.push(pair.private_key);
			}
			return new SecureServerCredentials({
				requestCert: checkClientCertificate,
				ciphers: tls_helpers_1.CIPHER_SUITES
			}, {
				ca: (_a = rootCerts !== null && rootCerts !== void 0 ? rootCerts : (0, tls_helpers_1.getDefaultRootsData)()) !== null && _a !== void 0 ? _a : void 0,
				cert,
				key
			});
		}
	};
	exports.ServerCredentials = ServerCredentials;
	var InsecureServerCredentials = class InsecureServerCredentials extends ServerCredentials {
		constructor() {
			super(null);
		}
		_getSettings() {
			return null;
		}
		_equals(other) {
			return other instanceof InsecureServerCredentials;
		}
	};
	var SecureServerCredentials = class SecureServerCredentials extends ServerCredentials {
		constructor(constructorOptions, contextOptions) {
			super(constructorOptions, contextOptions);
			this.options = Object.assign(Object.assign({}, constructorOptions), contextOptions);
		}
		/**
		* Checks equality by checking the options that are actually set by
		* createSsl.
		* @param other
		* @returns
		*/
		_equals(other) {
			if (this === other) return true;
			if (!(other instanceof SecureServerCredentials)) return false;
			if (Buffer.isBuffer(this.options.ca) && Buffer.isBuffer(other.options.ca)) {
				if (!this.options.ca.equals(other.options.ca)) return false;
			} else if (this.options.ca !== other.options.ca) return false;
			if (Array.isArray(this.options.cert) && Array.isArray(other.options.cert)) {
				if (this.options.cert.length !== other.options.cert.length) return false;
				for (let i = 0; i < this.options.cert.length; i++) {
					const thisCert = this.options.cert[i];
					const otherCert = other.options.cert[i];
					if (Buffer.isBuffer(thisCert) && Buffer.isBuffer(otherCert)) {
						if (!thisCert.equals(otherCert)) return false;
					} else if (thisCert !== otherCert) return false;
				}
			} else if (this.options.cert !== other.options.cert) return false;
			if (Array.isArray(this.options.key) && Array.isArray(other.options.key)) {
				if (this.options.key.length !== other.options.key.length) return false;
				for (let i = 0; i < this.options.key.length; i++) {
					const thisKey = this.options.key[i];
					const otherKey = other.options.key[i];
					if (Buffer.isBuffer(thisKey) && Buffer.isBuffer(otherKey)) {
						if (!thisKey.equals(otherKey)) return false;
					} else if (thisKey !== otherKey) return false;
				}
			} else if (this.options.key !== other.options.key) return false;
			if (this.options.requestCert !== other.options.requestCert) return false;
			return true;
		}
	};
	var CertificateProviderServerCredentials = class CertificateProviderServerCredentials extends ServerCredentials {
		constructor(identityCertificateProvider, caCertificateProvider, requireClientCertificate) {
			super({
				requestCert: caCertificateProvider !== null,
				rejectUnauthorized: requireClientCertificate,
				ciphers: tls_helpers_1.CIPHER_SUITES
			});
			this.identityCertificateProvider = identityCertificateProvider;
			this.caCertificateProvider = caCertificateProvider;
			this.requireClientCertificate = requireClientCertificate;
			this.latestCaUpdate = null;
			this.latestIdentityUpdate = null;
			this.caCertificateUpdateListener = this.handleCaCertificateUpdate.bind(this);
			this.identityCertificateUpdateListener = this.handleIdentityCertitificateUpdate.bind(this);
		}
		_addWatcher(watcher) {
			var _a;
			if (this.getWatcherCount() === 0) {
				(_a = this.caCertificateProvider) === null || _a === void 0 || _a.addCaCertificateListener(this.caCertificateUpdateListener);
				this.identityCertificateProvider.addIdentityCertificateListener(this.identityCertificateUpdateListener);
			}
			super._addWatcher(watcher);
		}
		_removeWatcher(watcher) {
			var _a;
			super._removeWatcher(watcher);
			if (this.getWatcherCount() === 0) {
				(_a = this.caCertificateProvider) === null || _a === void 0 || _a.removeCaCertificateListener(this.caCertificateUpdateListener);
				this.identityCertificateProvider.removeIdentityCertificateListener(this.identityCertificateUpdateListener);
			}
		}
		_equals(other) {
			if (this === other) return true;
			if (!(other instanceof CertificateProviderServerCredentials)) return false;
			return this.caCertificateProvider === other.caCertificateProvider && this.identityCertificateProvider === other.identityCertificateProvider && this.requireClientCertificate === other.requireClientCertificate;
		}
		calculateSecureContextOptions() {
			var _a;
			if (this.latestIdentityUpdate === null) return null;
			if (this.caCertificateProvider !== null && this.latestCaUpdate === null) return null;
			return {
				ca: (_a = this.latestCaUpdate) === null || _a === void 0 ? void 0 : _a.caCertificate,
				cert: [this.latestIdentityUpdate.certificate],
				key: [this.latestIdentityUpdate.privateKey]
			};
		}
		finalizeUpdate() {
			const secureContextOptions = this.calculateSecureContextOptions();
			this.updateSecureContextOptions(secureContextOptions);
		}
		handleCaCertificateUpdate(update) {
			this.latestCaUpdate = update;
			this.finalizeUpdate();
		}
		handleIdentityCertitificateUpdate(update) {
			this.latestIdentityUpdate = update;
			this.finalizeUpdate();
		}
	};
	function createCertificateProviderServerCredentials(caCertificateProvider, identityCertificateProvider, requireClientCertificate) {
		return new CertificateProviderServerCredentials(caCertificateProvider, identityCertificateProvider, requireClientCertificate);
	}
	var InterceptorServerCredentials = class InterceptorServerCredentials extends ServerCredentials {
		constructor(childCredentials, interceptors) {
			super({});
			this.childCredentials = childCredentials;
			this.interceptors = interceptors;
		}
		_isSecure() {
			return this.childCredentials._isSecure();
		}
		_equals(other) {
			if (!(other instanceof InterceptorServerCredentials)) return false;
			if (!this.childCredentials._equals(other.childCredentials)) return false;
			if (this.interceptors.length !== other.interceptors.length) return false;
			for (let i = 0; i < this.interceptors.length; i++) if (this.interceptors[i] !== other.interceptors[i]) return false;
			return true;
		}
		_getInterceptors() {
			return this.interceptors;
		}
		_addWatcher(watcher) {
			this.childCredentials._addWatcher(watcher);
		}
		_removeWatcher(watcher) {
			this.childCredentials._removeWatcher(watcher);
		}
		_getConstructorOptions() {
			return this.childCredentials._getConstructorOptions();
		}
		_getSecureContextOptions() {
			return this.childCredentials._getSecureContextOptions();
		}
	};
	function createServerCredentialsWithInterceptors(credentials, interceptors) {
		return new InterceptorServerCredentials(credentials, interceptors);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/duration.js
var require_duration = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.durationMessageToDuration = durationMessageToDuration;
	exports.msToDuration = msToDuration;
	exports.durationToMs = durationToMs;
	exports.isDuration = isDuration;
	exports.isDurationMessage = isDurationMessage;
	exports.parseDuration = parseDuration;
	exports.durationToString = durationToString;
	function durationMessageToDuration(message) {
		return {
			seconds: Number.parseInt(message.seconds),
			nanos: message.nanos
		};
	}
	function msToDuration(millis) {
		return {
			seconds: millis / 1e3 | 0,
			nanos: millis % 1e3 * 1e6 | 0
		};
	}
	function durationToMs(duration) {
		return duration.seconds * 1e3 + duration.nanos / 1e6 | 0;
	}
	function isDuration(value) {
		return typeof value.seconds === "number" && typeof value.nanos === "number";
	}
	function isDurationMessage(value) {
		return typeof value.seconds === "string" && typeof value.nanos === "number";
	}
	const durationRegex = /^(\d+)(?:\.(\d+))?s$/;
	function parseDuration(value) {
		const match = value.match(durationRegex);
		if (!match) return null;
		return {
			seconds: Number.parseInt(match[1], 10),
			nanos: match[2] ? Number.parseInt(match[2].padEnd(9, "0"), 10) : 0
		};
	}
	function durationToString(duration) {
		if (duration.nanos === 0) return `${duration.seconds}s`;
		let scaleFactor;
		if (duration.nanos % 1e6 === 0) scaleFactor = 1e6;
		else if (duration.nanos % 1e3 === 0) scaleFactor = 1e3;
		else scaleFactor = 1;
		return `${duration.seconds}.${duration.nanos / scaleFactor}s`;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/orca.js
var require_orca = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.OrcaOobMetricsSubchannelWrapper = exports.GRPC_METRICS_HEADER = exports.ServerMetricRecorder = exports.PerRequestMetricRecorder = void 0;
	exports.createOrcaClient = createOrcaClient;
	exports.createMetricsReader = createMetricsReader;
	const make_client_1 = require_make_client();
	const duration_1 = require_duration();
	const channel_credentials_1 = require_channel_credentials();
	const subchannel_interface_1 = require_subchannel_interface();
	const constants_1 = require_constants();
	const backoff_timeout_1 = require_backoff_timeout();
	const connectivity_state_1 = require_connectivity_state();
	function loadOrcaProto() {
		const loaderLoadSync = require_src$1().loadSync;
		const loadedProto = loaderLoadSync("xds/service/orca/v3/orca.proto", {
			keepCase: true,
			longs: String,
			enums: String,
			defaults: true,
			oneofs: true,
			includeDirs: [`${__dirname}/../../proto/xds`, `${__dirname}/../../proto/protoc-gen-validate`]
		});
		return (0, make_client_1.loadPackageDefinition)(loadedProto);
	}
	/**
	* ORCA metrics recorder for a single request
	*/
	var PerRequestMetricRecorder = class {
		constructor() {
			this.message = {};
		}
		/**
		* Records a request cost metric measurement for the call.
		* @param name
		* @param value
		*/
		recordRequestCostMetric(name, value) {
			if (!this.message.request_cost) this.message.request_cost = {};
			this.message.request_cost[name] = value;
		}
		/**
		* Records a request cost metric measurement for the call.
		* @param name
		* @param value
		*/
		recordUtilizationMetric(name, value) {
			if (!this.message.utilization) this.message.utilization = {};
			this.message.utilization[name] = value;
		}
		/**
		* Records an opaque named metric measurement for the call.
		* @param name
		* @param value
		*/
		recordNamedMetric(name, value) {
			if (!this.message.named_metrics) this.message.named_metrics = {};
			this.message.named_metrics[name] = value;
		}
		/**
		* Records the CPU utilization metric measurement for the call.
		* @param value
		*/
		recordCPUUtilizationMetric(value) {
			this.message.cpu_utilization = value;
		}
		/**
		* Records the memory utilization metric measurement for the call.
		* @param value
		*/
		recordMemoryUtilizationMetric(value) {
			this.message.mem_utilization = value;
		}
		/**
		* Records the memory utilization metric measurement for the call.
		* @param value
		*/
		recordApplicationUtilizationMetric(value) {
			this.message.application_utilization = value;
		}
		/**
		* Records the queries per second measurement.
		* @param value
		*/
		recordQpsMetric(value) {
			this.message.rps_fractional = value;
		}
		/**
		* Records the errors per second measurement.
		* @param value
		*/
		recordEpsMetric(value) {
			this.message.eps = value;
		}
		serialize() {
			return loadOrcaProto().xds.data.orca.v3.OrcaLoadReport.serialize(this.message);
		}
	};
	exports.PerRequestMetricRecorder = PerRequestMetricRecorder;
	const DEFAULT_REPORT_INTERVAL_MS = 3e4;
	var ServerMetricRecorder = class {
		constructor() {
			this.message = {};
			this.serviceImplementation = { StreamCoreMetrics: (call) => {
				const reportInterval = call.request.report_interval ? (0, duration_1.durationToMs)((0, duration_1.durationMessageToDuration)(call.request.report_interval)) : DEFAULT_REPORT_INTERVAL_MS;
				const reportTimer = setInterval(() => {
					call.write(this.message);
				}, reportInterval);
				call.on("cancelled", () => {
					clearInterval(reportTimer);
				});
			} };
		}
		putUtilizationMetric(name, value) {
			if (!this.message.utilization) this.message.utilization = {};
			this.message.utilization[name] = value;
		}
		setAllUtilizationMetrics(metrics) {
			this.message.utilization = Object.assign({}, metrics);
		}
		deleteUtilizationMetric(name) {
			var _a;
			(_a = this.message.utilization) === null || _a === void 0 || delete _a[name];
		}
		setCpuUtilizationMetric(value) {
			this.message.cpu_utilization = value;
		}
		deleteCpuUtilizationMetric() {
			delete this.message.cpu_utilization;
		}
		setApplicationUtilizationMetric(value) {
			this.message.application_utilization = value;
		}
		deleteApplicationUtilizationMetric() {
			delete this.message.application_utilization;
		}
		setQpsMetric(value) {
			this.message.rps_fractional = value;
		}
		deleteQpsMetric() {
			delete this.message.rps_fractional;
		}
		setEpsMetric(value) {
			this.message.eps = value;
		}
		deleteEpsMetric() {
			delete this.message.eps;
		}
		addToServer(server) {
			const serviceDefinition = loadOrcaProto().xds.service.orca.v3.OpenRcaService.service;
			server.addService(serviceDefinition, this.serviceImplementation);
		}
	};
	exports.ServerMetricRecorder = ServerMetricRecorder;
	function createOrcaClient(channel) {
		const ClientClass = loadOrcaProto().xds.service.orca.v3.OpenRcaService;
		return new ClientClass("unused", channel_credentials_1.ChannelCredentials.createInsecure(), { channelOverride: channel });
	}
	exports.GRPC_METRICS_HEADER = "endpoint-load-metrics-bin";
	const PARSED_LOAD_REPORT_KEY = "grpc_orca_load_report";
	/**
	* Create an onCallEnded callback for use in a picker.
	* @param listener The listener to handle metrics, whenever they are provided.
	* @param previousOnCallEnded The previous onCallEnded callback to propagate
	* to, if applicable.
	* @returns
	*/
	function createMetricsReader(listener, previousOnCallEnded) {
		return (code, details, metadata) => {
			let parsedLoadReport = metadata.getOpaque(PARSED_LOAD_REPORT_KEY);
			if (parsedLoadReport) listener(parsedLoadReport);
			else {
				const serializedLoadReport = metadata.get(exports.GRPC_METRICS_HEADER);
				if (serializedLoadReport.length > 0) {
					parsedLoadReport = loadOrcaProto().xds.data.orca.v3.OrcaLoadReport.deserialize(serializedLoadReport[0]);
					listener(parsedLoadReport);
					metadata.setOpaque(PARSED_LOAD_REPORT_KEY, parsedLoadReport);
				}
			}
			if (previousOnCallEnded) previousOnCallEnded(code, details, metadata);
		};
	}
	const DATA_PRODUCER_KEY = "orca_oob_metrics";
	var OobMetricsDataWatcher = class {
		constructor(metricsListener, intervalMs) {
			this.metricsListener = metricsListener;
			this.intervalMs = intervalMs;
			this.dataProducer = null;
		}
		setSubchannel(subchannel) {
			const producer = subchannel.getOrCreateDataProducer(DATA_PRODUCER_KEY, createOobMetricsDataProducer);
			this.dataProducer = producer;
			producer.addDataWatcher(this);
		}
		destroy() {
			var _a;
			(_a = this.dataProducer) === null || _a === void 0 || _a.removeDataWatcher(this);
		}
		getInterval() {
			return this.intervalMs;
		}
		onMetricsUpdate(metrics) {
			this.metricsListener(metrics);
		}
	};
	var OobMetricsDataProducer = class {
		constructor(subchannel) {
			this.subchannel = subchannel;
			this.dataWatchers = /* @__PURE__ */ new Set();
			this.orcaSupported = true;
			this.metricsCall = null;
			this.currentInterval = Infinity;
			this.backoffTimer = new backoff_timeout_1.BackoffTimeout(() => this.updateMetricsSubscription());
			this.subchannelStateListener = () => this.updateMetricsSubscription();
			this.client = createOrcaClient(subchannel.getChannel());
			subchannel.addConnectivityStateListener(this.subchannelStateListener);
		}
		addDataWatcher(dataWatcher) {
			this.dataWatchers.add(dataWatcher);
			this.updateMetricsSubscription();
		}
		removeDataWatcher(dataWatcher) {
			var _a;
			this.dataWatchers.delete(dataWatcher);
			if (this.dataWatchers.size === 0) {
				this.subchannel.removeDataProducer(DATA_PRODUCER_KEY);
				(_a = this.metricsCall) === null || _a === void 0 || _a.cancel();
				this.metricsCall = null;
				this.client.close();
				this.subchannel.removeConnectivityStateListener(this.subchannelStateListener);
			} else this.updateMetricsSubscription();
		}
		updateMetricsSubscription() {
			var _a;
			if (this.dataWatchers.size === 0 || !this.orcaSupported || this.subchannel.getConnectivityState() !== connectivity_state_1.ConnectivityState.READY) return;
			const newInterval = Math.min(...Array.from(this.dataWatchers).map((watcher) => watcher.getInterval()));
			if (!this.metricsCall || newInterval !== this.currentInterval) {
				(_a = this.metricsCall) === null || _a === void 0 || _a.cancel();
				this.currentInterval = newInterval;
				const metricsCall = this.client.streamCoreMetrics({ report_interval: (0, duration_1.msToDuration)(newInterval) });
				this.metricsCall = metricsCall;
				metricsCall.on("data", (report) => {
					this.dataWatchers.forEach((watcher) => {
						watcher.onMetricsUpdate(report);
					});
				});
				metricsCall.on("error", (error) => {
					this.metricsCall = null;
					if (error.code === constants_1.Status.UNIMPLEMENTED) {
						this.orcaSupported = false;
						return;
					}
					if (error.code === constants_1.Status.CANCELLED) return;
					this.backoffTimer.runOnce();
				});
			}
		}
	};
	var OrcaOobMetricsSubchannelWrapper = class extends subchannel_interface_1.BaseSubchannelWrapper {
		constructor(child, metricsListener, intervalMs) {
			super(child);
			this.addDataWatcher(new OobMetricsDataWatcher(metricsListener, intervalMs));
		}
		getWrappedSubchannel() {
			return this.child;
		}
	};
	exports.OrcaOobMetricsSubchannelWrapper = OrcaOobMetricsSubchannelWrapper;
	function createOobMetricsDataProducer(subchannel) {
		return new OobMetricsDataProducer(subchannel);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/server-interceptors.js
var require_server_interceptors = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.BaseServerInterceptingCall = exports.ServerInterceptingCall = exports.ResponderBuilder = exports.ServerListenerBuilder = void 0;
	exports.isInterceptingServerListener = isInterceptingServerListener;
	exports.getServerInterceptingCall = getServerInterceptingCall;
	const metadata_1 = require_metadata();
	const constants_1 = require_constants();
	const http2$1 = __require("http2");
	const error_1 = require_error();
	const zlib = __require("zlib");
	const stream_decoder_1 = require_stream_decoder();
	const logging = require_logging();
	const tls_1 = __require("tls");
	const orca_1 = require_orca();
	const TRACER_NAME = "server_call";
	function trace(text) {
		logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, text);
	}
	var ServerListenerBuilder = class {
		constructor() {
			this.metadata = void 0;
			this.message = void 0;
			this.halfClose = void 0;
			this.cancel = void 0;
		}
		withOnReceiveMetadata(onReceiveMetadata) {
			this.metadata = onReceiveMetadata;
			return this;
		}
		withOnReceiveMessage(onReceiveMessage) {
			this.message = onReceiveMessage;
			return this;
		}
		withOnReceiveHalfClose(onReceiveHalfClose) {
			this.halfClose = onReceiveHalfClose;
			return this;
		}
		withOnCancel(onCancel) {
			this.cancel = onCancel;
			return this;
		}
		build() {
			return {
				onReceiveMetadata: this.metadata,
				onReceiveMessage: this.message,
				onReceiveHalfClose: this.halfClose,
				onCancel: this.cancel
			};
		}
	};
	exports.ServerListenerBuilder = ServerListenerBuilder;
	function isInterceptingServerListener(listener) {
		return listener.onReceiveMetadata !== void 0 && listener.onReceiveMetadata.length === 1;
	}
	var InterceptingServerListenerImpl = class {
		constructor(listener, nextListener) {
			this.listener = listener;
			this.nextListener = nextListener;
			/**
			* Once the call is cancelled, ignore all other events.
			*/
			this.cancelled = false;
			this.processingMetadata = false;
			this.hasPendingMessage = false;
			this.pendingMessage = null;
			this.processingMessage = false;
			this.hasPendingHalfClose = false;
		}
		processPendingMessage() {
			if (this.hasPendingMessage) {
				this.nextListener.onReceiveMessage(this.pendingMessage);
				this.pendingMessage = null;
				this.hasPendingMessage = false;
			}
		}
		processPendingHalfClose() {
			if (this.hasPendingHalfClose) {
				this.nextListener.onReceiveHalfClose();
				this.hasPendingHalfClose = false;
			}
		}
		onReceiveMetadata(metadata) {
			if (this.cancelled) return;
			this.processingMetadata = true;
			this.listener.onReceiveMetadata(metadata, (interceptedMetadata) => {
				this.processingMetadata = false;
				if (this.cancelled) return;
				this.nextListener.onReceiveMetadata(interceptedMetadata);
				this.processPendingMessage();
				this.processPendingHalfClose();
			});
		}
		onReceiveMessage(message) {
			if (this.cancelled) return;
			this.processingMessage = true;
			this.listener.onReceiveMessage(message, (msg) => {
				this.processingMessage = false;
				if (this.cancelled) return;
				if (this.processingMetadata) {
					this.pendingMessage = msg;
					this.hasPendingMessage = true;
				} else {
					this.nextListener.onReceiveMessage(msg);
					this.processPendingHalfClose();
				}
			});
		}
		onReceiveHalfClose() {
			if (this.cancelled) return;
			this.listener.onReceiveHalfClose(() => {
				if (this.cancelled) return;
				if (this.processingMetadata || this.processingMessage) this.hasPendingHalfClose = true;
				else this.nextListener.onReceiveHalfClose();
			});
		}
		onCancel() {
			this.cancelled = true;
			this.listener.onCancel();
			this.nextListener.onCancel();
		}
	};
	var ResponderBuilder = class {
		constructor() {
			this.start = void 0;
			this.metadata = void 0;
			this.message = void 0;
			this.status = void 0;
		}
		withStart(start) {
			this.start = start;
			return this;
		}
		withSendMetadata(sendMetadata) {
			this.metadata = sendMetadata;
			return this;
		}
		withSendMessage(sendMessage) {
			this.message = sendMessage;
			return this;
		}
		withSendStatus(sendStatus) {
			this.status = sendStatus;
			return this;
		}
		build() {
			return {
				start: this.start,
				sendMetadata: this.metadata,
				sendMessage: this.message,
				sendStatus: this.status
			};
		}
	};
	exports.ResponderBuilder = ResponderBuilder;
	const defaultServerListener = {
		onReceiveMetadata: (metadata, next) => {
			next(metadata);
		},
		onReceiveMessage: (message, next) => {
			next(message);
		},
		onReceiveHalfClose: (next) => {
			next();
		},
		onCancel: () => {}
	};
	const defaultResponder = {
		start: (next) => {
			next();
		},
		sendMetadata: (metadata, next) => {
			next(metadata);
		},
		sendMessage: (message, next) => {
			next(message);
		},
		sendStatus: (status, next) => {
			next(status);
		}
	};
	var ServerInterceptingCall = class {
		constructor(nextCall, responder) {
			var _a, _b, _c, _d;
			this.nextCall = nextCall;
			this.processingMetadata = false;
			this.sentMetadata = false;
			this.processingMessage = false;
			this.pendingMessage = null;
			this.pendingMessageCallback = null;
			this.pendingStatus = null;
			this.responder = {
				start: (_a = responder === null || responder === void 0 ? void 0 : responder.start) !== null && _a !== void 0 ? _a : defaultResponder.start,
				sendMetadata: (_b = responder === null || responder === void 0 ? void 0 : responder.sendMetadata) !== null && _b !== void 0 ? _b : defaultResponder.sendMetadata,
				sendMessage: (_c = responder === null || responder === void 0 ? void 0 : responder.sendMessage) !== null && _c !== void 0 ? _c : defaultResponder.sendMessage,
				sendStatus: (_d = responder === null || responder === void 0 ? void 0 : responder.sendStatus) !== null && _d !== void 0 ? _d : defaultResponder.sendStatus
			};
		}
		processPendingMessage() {
			if (this.pendingMessageCallback) {
				this.nextCall.sendMessage(this.pendingMessage, this.pendingMessageCallback);
				this.pendingMessage = null;
				this.pendingMessageCallback = null;
			}
		}
		processPendingStatus() {
			if (this.pendingStatus) {
				this.nextCall.sendStatus(this.pendingStatus);
				this.pendingStatus = null;
			}
		}
		start(listener) {
			this.responder.start((interceptedListener) => {
				var _a, _b, _c, _d;
				const finalInterceptingListener = new InterceptingServerListenerImpl({
					onReceiveMetadata: (_a = interceptedListener === null || interceptedListener === void 0 ? void 0 : interceptedListener.onReceiveMetadata) !== null && _a !== void 0 ? _a : defaultServerListener.onReceiveMetadata,
					onReceiveMessage: (_b = interceptedListener === null || interceptedListener === void 0 ? void 0 : interceptedListener.onReceiveMessage) !== null && _b !== void 0 ? _b : defaultServerListener.onReceiveMessage,
					onReceiveHalfClose: (_c = interceptedListener === null || interceptedListener === void 0 ? void 0 : interceptedListener.onReceiveHalfClose) !== null && _c !== void 0 ? _c : defaultServerListener.onReceiveHalfClose,
					onCancel: (_d = interceptedListener === null || interceptedListener === void 0 ? void 0 : interceptedListener.onCancel) !== null && _d !== void 0 ? _d : defaultServerListener.onCancel
				}, listener);
				this.nextCall.start(finalInterceptingListener);
			});
		}
		sendMetadata(metadata) {
			this.processingMetadata = true;
			this.sentMetadata = true;
			this.responder.sendMetadata(metadata, (interceptedMetadata) => {
				this.processingMetadata = false;
				this.nextCall.sendMetadata(interceptedMetadata);
				this.processPendingMessage();
				this.processPendingStatus();
			});
		}
		sendMessage(message, callback) {
			this.processingMessage = true;
			if (!this.sentMetadata) this.sendMetadata(new metadata_1.Metadata());
			this.responder.sendMessage(message, (interceptedMessage) => {
				this.processingMessage = false;
				if (this.processingMetadata) {
					this.pendingMessage = interceptedMessage;
					this.pendingMessageCallback = callback;
				} else this.nextCall.sendMessage(interceptedMessage, callback);
			});
		}
		sendStatus(status) {
			this.responder.sendStatus(status, (interceptedStatus) => {
				if (this.processingMetadata || this.processingMessage) this.pendingStatus = interceptedStatus;
				else this.nextCall.sendStatus(interceptedStatus);
			});
		}
		startRead() {
			this.nextCall.startRead();
		}
		getPeer() {
			return this.nextCall.getPeer();
		}
		getDeadline() {
			return this.nextCall.getDeadline();
		}
		getHost() {
			return this.nextCall.getHost();
		}
		getAuthContext() {
			return this.nextCall.getAuthContext();
		}
		getConnectionInfo() {
			return this.nextCall.getConnectionInfo();
		}
		getMetricsRecorder() {
			return this.nextCall.getMetricsRecorder();
		}
	};
	exports.ServerInterceptingCall = ServerInterceptingCall;
	const GRPC_ACCEPT_ENCODING_HEADER = "grpc-accept-encoding";
	const GRPC_ENCODING_HEADER = "grpc-encoding";
	const GRPC_MESSAGE_HEADER = "grpc-message";
	const GRPC_STATUS_HEADER = "grpc-status";
	const GRPC_TIMEOUT_HEADER = "grpc-timeout";
	const DEADLINE_REGEX = /(\d{1,8})\s*([HMSmun])/;
	const deadlineUnitsToMs = {
		H: 36e5,
		M: 6e4,
		S: 1e3,
		m: 1,
		u: .001,
		n: 1e-6
	};
	const defaultCompressionHeaders = {
		[GRPC_ACCEPT_ENCODING_HEADER]: "identity,deflate,gzip",
		[GRPC_ENCODING_HEADER]: "identity"
	};
	const defaultResponseHeaders = {
		[http2$1.constants.HTTP2_HEADER_STATUS]: http2$1.constants.HTTP_STATUS_OK,
		[http2$1.constants.HTTP2_HEADER_CONTENT_TYPE]: "application/grpc+proto"
	};
	const defaultResponseOptions = { waitForTrailers: true };
	var BaseServerInterceptingCall = class {
		constructor(stream, headers, callEventTracker, handler, options) {
			var _a, _b;
			this.stream = stream;
			this.callEventTracker = callEventTracker;
			this.handler = handler;
			this.listener = null;
			this.deadlineTimer = null;
			this.deadline = Infinity;
			this.maxSendMessageSize = constants_1.DEFAULT_MAX_SEND_MESSAGE_LENGTH;
			this.maxReceiveMessageSize = constants_1.DEFAULT_MAX_RECEIVE_MESSAGE_LENGTH;
			this.cancelled = false;
			this.metadataSent = false;
			this.wantTrailers = false;
			this.cancelNotified = false;
			this.incomingEncoding = "identity";
			this.readQueue = [];
			this.isReadPending = false;
			this.receivedHalfClose = false;
			this.streamEnded = false;
			this.metricsRecorder = new orca_1.PerRequestMetricRecorder();
			this.stream.once("error", (err) => {});
			this.stream.once("close", () => {
				var _a;
				trace("Request to method " + ((_a = this.handler) === null || _a === void 0 ? void 0 : _a.path) + " stream closed with rstCode " + this.stream.rstCode);
				if (this.callEventTracker && !this.streamEnded) {
					this.streamEnded = true;
					this.callEventTracker.onStreamEnd(false);
					this.callEventTracker.onCallEnd({
						code: constants_1.Status.CANCELLED,
						details: "Stream closed before sending status",
						metadata: null
					});
				}
				this.notifyOnCancel();
			});
			this.stream.on("data", (data) => {
				this.handleDataFrame(data);
			});
			this.stream.pause();
			this.stream.on("end", () => {
				this.handleEndEvent();
			});
			if ("grpc.max_send_message_length" in options) this.maxSendMessageSize = options["grpc.max_send_message_length"];
			if ("grpc.max_receive_message_length" in options) this.maxReceiveMessageSize = options["grpc.max_receive_message_length"];
			this.host = (_a = headers[":authority"]) !== null && _a !== void 0 ? _a : headers.host;
			this.decoder = new stream_decoder_1.StreamDecoder(this.maxReceiveMessageSize);
			const metadata = metadata_1.Metadata.fromHttp2Headers(headers);
			if (logging.isTracerEnabled(TRACER_NAME)) trace("Request to " + this.handler.path + " received headers " + JSON.stringify(metadata.toJSON()));
			const timeoutHeader = metadata.get(GRPC_TIMEOUT_HEADER);
			if (timeoutHeader.length > 0) this.handleTimeoutHeader(timeoutHeader[0]);
			const encodingHeader = metadata.get(GRPC_ENCODING_HEADER);
			if (encodingHeader.length > 0) this.incomingEncoding = encodingHeader[0];
			metadata.remove(GRPC_TIMEOUT_HEADER);
			metadata.remove(GRPC_ENCODING_HEADER);
			metadata.remove(GRPC_ACCEPT_ENCODING_HEADER);
			metadata.remove(http2$1.constants.HTTP2_HEADER_ACCEPT_ENCODING);
			metadata.remove(http2$1.constants.HTTP2_HEADER_TE);
			metadata.remove(http2$1.constants.HTTP2_HEADER_CONTENT_TYPE);
			this.metadata = metadata;
			const socket = (_b = stream.session) === null || _b === void 0 ? void 0 : _b.socket;
			this.connectionInfo = {
				localAddress: socket === null || socket === void 0 ? void 0 : socket.localAddress,
				localPort: socket === null || socket === void 0 ? void 0 : socket.localPort,
				remoteAddress: socket === null || socket === void 0 ? void 0 : socket.remoteAddress,
				remotePort: socket === null || socket === void 0 ? void 0 : socket.remotePort
			};
			this.shouldSendMetrics = !!options["grpc.server_call_metric_recording"];
		}
		handleTimeoutHeader(timeoutHeader) {
			const match = timeoutHeader.toString().match(DEADLINE_REGEX);
			if (match === null) {
				const status = {
					code: constants_1.Status.INTERNAL,
					details: `Invalid ${GRPC_TIMEOUT_HEADER} value "${timeoutHeader}"`,
					metadata: null
				};
				process.nextTick(() => {
					this.sendStatus(status);
				});
				return;
			}
			const timeout = +match[1] * deadlineUnitsToMs[match[2]] | 0;
			const now = /* @__PURE__ */ new Date();
			this.deadline = now.setMilliseconds(now.getMilliseconds() + timeout);
			this.deadlineTimer = setTimeout(() => {
				const status = {
					code: constants_1.Status.DEADLINE_EXCEEDED,
					details: "Deadline exceeded",
					metadata: null
				};
				this.sendStatus(status);
			}, timeout);
		}
		checkCancelled() {
			if (!this.cancelled && (this.stream.destroyed || this.stream.closed)) {
				this.notifyOnCancel();
				this.cancelled = true;
			}
			return this.cancelled;
		}
		notifyOnCancel() {
			if (this.cancelNotified) return;
			this.cancelNotified = true;
			this.cancelled = true;
			process.nextTick(() => {
				var _a;
				(_a = this.listener) === null || _a === void 0 || _a.onCancel();
			});
			if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
			this.stream.resume();
		}
		/**
		* A server handler can start sending messages without explicitly sending
		* metadata. In that case, we need to send headers before sending any
		* messages. This function does that if necessary.
		*/
		maybeSendMetadata() {
			if (!this.metadataSent) this.sendMetadata(new metadata_1.Metadata());
		}
		/**
		* Serialize a message to a length-delimited byte string.
		* @param value
		* @returns
		*/
		serializeMessage(value) {
			const messageBuffer = this.handler.serialize(value);
			const byteLength = messageBuffer.byteLength;
			const output = Buffer.allocUnsafe(byteLength + 5);
			output.writeUInt8(0, 0);
			output.writeUInt32BE(byteLength, 1);
			messageBuffer.copy(output, 5);
			return output;
		}
		decompressMessage(message, encoding) {
			const messageContents = message.subarray(5);
			if (encoding === "identity") return messageContents;
			else if (encoding === "deflate" || encoding === "gzip") {
				let decompresser;
				if (encoding === "deflate") decompresser = zlib.createInflate();
				else decompresser = zlib.createGunzip();
				return new Promise((resolve, reject) => {
					let totalLength = 0;
					const messageParts = [];
					decompresser.on("data", (chunk) => {
						messageParts.push(chunk);
						totalLength += chunk.byteLength;
						if (this.maxReceiveMessageSize !== -1 && totalLength > this.maxReceiveMessageSize) {
							decompresser.destroy();
							reject({
								code: constants_1.Status.RESOURCE_EXHAUSTED,
								details: `Received message that decompresses to a size larger than ${this.maxReceiveMessageSize}`
							});
						}
					});
					decompresser.on("end", () => {
						resolve(Buffer.concat(messageParts));
					});
					decompresser.write(messageContents);
					decompresser.end();
				});
			} else return Promise.reject({
				code: constants_1.Status.UNIMPLEMENTED,
				details: `Received message compressed with unsupported encoding "${encoding}"`
			});
		}
		async decompressAndMaybePush(queueEntry) {
			if (queueEntry.type !== "COMPRESSED") throw new Error(`Invalid queue entry type: ${queueEntry.type}`);
			const compressedMessageEncoding = queueEntry.compressedMessage.readUInt8(0) === 1 ? this.incomingEncoding : "identity";
			let decompressedMessage;
			try {
				decompressedMessage = await this.decompressMessage(queueEntry.compressedMessage, compressedMessageEncoding);
			} catch (err) {
				this.sendStatus(err);
				return;
			}
			try {
				queueEntry.parsedMessage = this.handler.deserialize(decompressedMessage);
			} catch (err) {
				this.sendStatus({
					code: constants_1.Status.INTERNAL,
					details: `Error deserializing request: ${err.message}`
				});
				return;
			}
			queueEntry.type = "READABLE";
			this.maybePushNextMessage();
		}
		maybePushNextMessage() {
			if (this.listener && this.isReadPending && this.readQueue.length > 0 && this.readQueue[0].type !== "COMPRESSED") {
				this.isReadPending = false;
				const nextQueueEntry = this.readQueue.shift();
				if (nextQueueEntry.type === "READABLE") this.listener.onReceiveMessage(nextQueueEntry.parsedMessage);
				else this.listener.onReceiveHalfClose();
			}
		}
		handleDataFrame(data) {
			var _a;
			if (this.checkCancelled()) return;
			trace("Request to " + this.handler.path + " received data frame of size " + data.length);
			let rawMessages;
			try {
				rawMessages = this.decoder.write(data);
			} catch (e) {
				this.sendStatus({
					code: constants_1.Status.RESOURCE_EXHAUSTED,
					details: e.message
				});
				return;
			}
			for (const messageBytes of rawMessages) {
				this.stream.pause();
				const queueEntry = {
					type: "COMPRESSED",
					compressedMessage: messageBytes,
					parsedMessage: null
				};
				this.readQueue.push(queueEntry);
				this.decompressAndMaybePush(queueEntry);
				(_a = this.callEventTracker) === null || _a === void 0 || _a.addMessageReceived();
			}
		}
		handleEndEvent() {
			this.readQueue.push({
				type: "HALF_CLOSE",
				compressedMessage: null,
				parsedMessage: null
			});
			this.receivedHalfClose = true;
			this.maybePushNextMessage();
		}
		start(listener) {
			trace("Request to " + this.handler.path + " start called");
			if (this.checkCancelled()) return;
			this.listener = listener;
			listener.onReceiveMetadata(this.metadata);
		}
		sendMetadata(metadata) {
			if (this.checkCancelled()) return;
			if (this.metadataSent) return;
			this.metadataSent = true;
			const custom = metadata ? metadata.toHttp2Headers() : null;
			const headers = Object.assign(Object.assign(Object.assign({}, defaultResponseHeaders), defaultCompressionHeaders), custom);
			this.stream.respond(headers, defaultResponseOptions);
		}
		sendMessage(message, callback) {
			if (this.checkCancelled()) return;
			let response;
			try {
				response = this.serializeMessage(message);
			} catch (e) {
				this.sendStatus({
					code: constants_1.Status.INTERNAL,
					details: `Error serializing response: ${(0, error_1.getErrorMessage)(e)}`,
					metadata: null
				});
				return;
			}
			if (this.maxSendMessageSize !== -1 && response.length - 5 > this.maxSendMessageSize) {
				this.sendStatus({
					code: constants_1.Status.RESOURCE_EXHAUSTED,
					details: `Sent message larger than max (${response.length} vs. ${this.maxSendMessageSize})`,
					metadata: null
				});
				return;
			}
			this.maybeSendMetadata();
			trace("Request to " + this.handler.path + " sent data frame of size " + response.length);
			this.stream.write(response, (error) => {
				var _a;
				if (error) {
					this.sendStatus({
						code: constants_1.Status.INTERNAL,
						details: `Error writing message: ${(0, error_1.getErrorMessage)(error)}`,
						metadata: null
					});
					return;
				}
				(_a = this.callEventTracker) === null || _a === void 0 || _a.addMessageSent();
				callback();
			});
		}
		sendStatus(status) {
			var _a, _b, _c;
			if (this.checkCancelled()) return;
			trace("Request to method " + ((_a = this.handler) === null || _a === void 0 ? void 0 : _a.path) + " ended with status code: " + constants_1.Status[status.code] + " details: " + status.details);
			const statusMetadata = (_c = (_b = status.metadata) === null || _b === void 0 ? void 0 : _b.clone()) !== null && _c !== void 0 ? _c : new metadata_1.Metadata();
			if (this.shouldSendMetrics) statusMetadata.set(orca_1.GRPC_METRICS_HEADER, this.metricsRecorder.serialize());
			if (this.metadataSent) if (!this.wantTrailers) {
				this.wantTrailers = true;
				this.stream.once("wantTrailers", () => {
					if (this.callEventTracker && !this.streamEnded) {
						this.streamEnded = true;
						this.callEventTracker.onStreamEnd(true);
						this.callEventTracker.onCallEnd(status);
					}
					const trailersToSend = Object.assign({
						[GRPC_STATUS_HEADER]: status.code,
						[GRPC_MESSAGE_HEADER]: encodeURI(status.details)
					}, statusMetadata.toHttp2Headers());
					this.stream.sendTrailers(trailersToSend);
					this.notifyOnCancel();
				});
				this.stream.end();
			} else this.notifyOnCancel();
			else {
				if (this.callEventTracker && !this.streamEnded) {
					this.streamEnded = true;
					this.callEventTracker.onStreamEnd(true);
					this.callEventTracker.onCallEnd(status);
				}
				const trailersToSend = Object.assign(Object.assign({
					[GRPC_STATUS_HEADER]: status.code,
					[GRPC_MESSAGE_HEADER]: encodeURI(status.details)
				}, defaultResponseHeaders), statusMetadata.toHttp2Headers());
				this.stream.respond(trailersToSend, { endStream: true });
				this.notifyOnCancel();
			}
		}
		startRead() {
			trace("Request to " + this.handler.path + " startRead called");
			if (this.checkCancelled()) return;
			this.isReadPending = true;
			if (this.readQueue.length === 0) {
				if (!this.receivedHalfClose) this.stream.resume();
			} else this.maybePushNextMessage();
		}
		getPeer() {
			var _a;
			const socket = (_a = this.stream.session) === null || _a === void 0 ? void 0 : _a.socket;
			if (socket === null || socket === void 0 ? void 0 : socket.remoteAddress) if (socket.remotePort) return `${socket.remoteAddress}:${socket.remotePort}`;
			else return socket.remoteAddress;
			else return "unknown";
		}
		getDeadline() {
			return this.deadline;
		}
		getHost() {
			return this.host;
		}
		getAuthContext() {
			var _a;
			if (((_a = this.stream.session) === null || _a === void 0 ? void 0 : _a.socket) instanceof tls_1.TLSSocket) {
				const peerCertificate = this.stream.session.socket.getPeerCertificate();
				return {
					transportSecurityType: "ssl",
					sslPeerCertificate: peerCertificate.raw ? peerCertificate : void 0
				};
			} else return {};
		}
		getConnectionInfo() {
			return this.connectionInfo;
		}
		getMetricsRecorder() {
			return this.metricsRecorder;
		}
	};
	exports.BaseServerInterceptingCall = BaseServerInterceptingCall;
	function getServerInterceptingCall(interceptors, stream, headers, callEventTracker, handler, options) {
		const methodDefinition = {
			path: handler.path,
			requestStream: handler.type === "clientStream" || handler.type === "bidi",
			responseStream: handler.type === "serverStream" || handler.type === "bidi",
			requestDeserialize: handler.deserialize,
			responseSerialize: handler.serialize
		};
		const baseCall = new BaseServerInterceptingCall(stream, headers, callEventTracker, handler, options);
		return interceptors.reduce((call, interceptor) => {
			return interceptor(methodDefinition, call);
		}, baseCall);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/server.js
var require_server = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __runInitializers = exports && exports.__runInitializers || function(thisArg, initializers, value) {
		var useValue = arguments.length > 2;
		for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
		return useValue ? value : void 0;
	};
	var __esDecorate = exports && exports.__esDecorate || function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
		function accept(f) {
			if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
			return f;
		}
		var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
		var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
		var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
		var _, done = false;
		for (var i = decorators.length - 1; i >= 0; i--) {
			var context = {};
			for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
			for (var p in contextIn.access) context.access[p] = contextIn.access[p];
			context.addInitializer = function(f) {
				if (done) throw new TypeError("Cannot add initializers after decoration has completed");
				extraInitializers.push(accept(f || null));
			};
			var result = (0, decorators[i])(kind === "accessor" ? {
				get: descriptor.get,
				set: descriptor.set
			} : descriptor[key], context);
			if (kind === "accessor") {
				if (result === void 0) continue;
				if (result === null || typeof result !== "object") throw new TypeError("Object expected");
				if (_ = accept(result.get)) descriptor.get = _;
				if (_ = accept(result.set)) descriptor.set = _;
				if (_ = accept(result.init)) initializers.unshift(_);
			} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
		if (target) Object.defineProperty(target, contextIn.name, descriptor);
		done = true;
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Server = void 0;
	const http2 = __require("http2");
	const util = __require("util");
	const constants_1 = require_constants();
	const server_call_1 = require_server_call();
	const server_credentials_1 = require_server_credentials();
	const resolver_1 = require_resolver();
	const logging = require_logging();
	const subchannel_address_1 = require_subchannel_address();
	const uri_parser_1 = require_uri_parser();
	const channelz_1 = require_channelz();
	const server_interceptors_1 = require_server_interceptors();
	const UNLIMITED_CONNECTION_AGE_MS = 2147483647;
	const KEEPALIVE_MAX_TIME_MS = 2147483647;
	const KEEPALIVE_TIMEOUT_MS = 2e4;
	const MAX_CONNECTION_IDLE_MS = 2147483647;
	const { HTTP2_HEADER_PATH } = http2.constants;
	const TRACER_NAME = "server";
	const kMaxAge = Buffer.from("max_age");
	function serverCallTrace(text) {
		logging.trace(constants_1.LogVerbosity.DEBUG, "server_call", text);
	}
	function noop() {}
	/**
	* Decorator to wrap a class method with util.deprecate
	* @param message The message to output if the deprecated method is called
	* @returns
	*/
	function deprecate(message) {
		return function(target, context) {
			return util.deprecate(target, message);
		};
	}
	function getUnimplementedStatusResponse(methodName) {
		return {
			code: constants_1.Status.UNIMPLEMENTED,
			details: `The server does not implement the method ${methodName}`
		};
	}
	function getDefaultHandler(handlerType, methodName) {
		const unimplementedStatusResponse = getUnimplementedStatusResponse(methodName);
		switch (handlerType) {
			case "unary": return (call, callback) => {
				callback(unimplementedStatusResponse, null);
			};
			case "clientStream": return (call, callback) => {
				callback(unimplementedStatusResponse, null);
			};
			case "serverStream": return (call) => {
				call.emit("error", unimplementedStatusResponse);
			};
			case "bidi": return (call) => {
				call.emit("error", unimplementedStatusResponse);
			};
			default: throw new Error(`Invalid handlerType ${handlerType}`);
		}
	}
	exports.Server = (() => {
		var _a;
		let _instanceExtraInitializers = [];
		let _start_decorators;
		return _a = class Server {
			constructor(options) {
				var _b, _c, _d, _e, _f, _g;
				this.boundPorts = (__runInitializers(this, _instanceExtraInitializers), /* @__PURE__ */ new Map());
				this.http2Servers = /* @__PURE__ */ new Map();
				this.sessionIdleTimeouts = /* @__PURE__ */ new Map();
				this.handlers = /* @__PURE__ */ new Map();
				this.sessions = /* @__PURE__ */ new Map();
				/**
				* This field only exists to ensure that the start method throws an error if
				* it is called twice, as it did previously.
				*/
				this.started = false;
				this.shutdown = false;
				this.serverAddressString = "null";
				this.channelzEnabled = true;
				this.options = options !== null && options !== void 0 ? options : {};
				if (this.options["grpc.enable_channelz"] === 0) {
					this.channelzEnabled = false;
					this.channelzTrace = new channelz_1.ChannelzTraceStub();
					this.callTracker = new channelz_1.ChannelzCallTrackerStub();
					this.listenerChildrenTracker = new channelz_1.ChannelzChildrenTrackerStub();
					this.sessionChildrenTracker = new channelz_1.ChannelzChildrenTrackerStub();
				} else {
					this.channelzTrace = new channelz_1.ChannelzTrace();
					this.callTracker = new channelz_1.ChannelzCallTracker();
					this.listenerChildrenTracker = new channelz_1.ChannelzChildrenTracker();
					this.sessionChildrenTracker = new channelz_1.ChannelzChildrenTracker();
				}
				this.channelzRef = (0, channelz_1.registerChannelzServer)("server", () => this.getChannelzInfo(), this.channelzEnabled);
				this.channelzTrace.addTrace("CT_INFO", "Server created");
				this.maxConnectionAgeMs = (_b = this.options["grpc.max_connection_age_ms"]) !== null && _b !== void 0 ? _b : UNLIMITED_CONNECTION_AGE_MS;
				this.maxConnectionAgeGraceMs = (_c = this.options["grpc.max_connection_age_grace_ms"]) !== null && _c !== void 0 ? _c : UNLIMITED_CONNECTION_AGE_MS;
				this.keepaliveTimeMs = (_d = this.options["grpc.keepalive_time_ms"]) !== null && _d !== void 0 ? _d : KEEPALIVE_MAX_TIME_MS;
				this.keepaliveTimeoutMs = (_e = this.options["grpc.keepalive_timeout_ms"]) !== null && _e !== void 0 ? _e : KEEPALIVE_TIMEOUT_MS;
				this.sessionIdleTimeout = (_f = this.options["grpc.max_connection_idle_ms"]) !== null && _f !== void 0 ? _f : MAX_CONNECTION_IDLE_MS;
				this.commonServerOptions = { maxSendHeaderBlockLength: Number.MAX_SAFE_INTEGER };
				if ("grpc-node.max_session_memory" in this.options) this.commonServerOptions.maxSessionMemory = this.options["grpc-node.max_session_memory"];
				else this.commonServerOptions.maxSessionMemory = Number.MAX_SAFE_INTEGER;
				if ("grpc.max_concurrent_streams" in this.options) this.commonServerOptions.settings = { maxConcurrentStreams: this.options["grpc.max_concurrent_streams"] };
				this.interceptors = (_g = this.options.interceptors) !== null && _g !== void 0 ? _g : [];
				this.trace("Server constructed");
			}
			getChannelzInfo() {
				return {
					trace: this.channelzTrace,
					callTracker: this.callTracker,
					listenerChildren: this.listenerChildrenTracker.getChildLists(),
					sessionChildren: this.sessionChildrenTracker.getChildLists()
				};
			}
			getChannelzSessionInfo(session) {
				var _b, _c, _d;
				const sessionInfo = this.sessions.get(session);
				const sessionSocket = session.socket;
				const remoteAddress = sessionSocket.remoteAddress ? (0, subchannel_address_1.stringToSubchannelAddress)(sessionSocket.remoteAddress, sessionSocket.remotePort) : null;
				const localAddress = sessionSocket.localAddress ? (0, subchannel_address_1.stringToSubchannelAddress)(sessionSocket.localAddress, sessionSocket.localPort) : null;
				let tlsInfo;
				if (session.encrypted) {
					const tlsSocket = sessionSocket;
					const cipherInfo = tlsSocket.getCipher();
					const certificate = tlsSocket.getCertificate();
					const peerCertificate = tlsSocket.getPeerCertificate();
					tlsInfo = {
						cipherSuiteStandardName: (_b = cipherInfo.standardName) !== null && _b !== void 0 ? _b : null,
						cipherSuiteOtherName: cipherInfo.standardName ? null : cipherInfo.name,
						localCertificate: certificate && "raw" in certificate ? certificate.raw : null,
						remoteCertificate: peerCertificate && "raw" in peerCertificate ? peerCertificate.raw : null
					};
				} else tlsInfo = null;
				return {
					remoteAddress,
					localAddress,
					security: tlsInfo,
					remoteName: null,
					streamsStarted: sessionInfo.streamTracker.callsStarted,
					streamsSucceeded: sessionInfo.streamTracker.callsSucceeded,
					streamsFailed: sessionInfo.streamTracker.callsFailed,
					messagesSent: sessionInfo.messagesSent,
					messagesReceived: sessionInfo.messagesReceived,
					keepAlivesSent: sessionInfo.keepAlivesSent,
					lastLocalStreamCreatedTimestamp: null,
					lastRemoteStreamCreatedTimestamp: sessionInfo.streamTracker.lastCallStartedTimestamp,
					lastMessageSentTimestamp: sessionInfo.lastMessageSentTimestamp,
					lastMessageReceivedTimestamp: sessionInfo.lastMessageReceivedTimestamp,
					localFlowControlWindow: (_c = session.state.localWindowSize) !== null && _c !== void 0 ? _c : null,
					remoteFlowControlWindow: (_d = session.state.remoteWindowSize) !== null && _d !== void 0 ? _d : null
				};
			}
			trace(text) {
				logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, "(" + this.channelzRef.id + ") " + text);
			}
			keepaliveTrace(text) {
				logging.trace(constants_1.LogVerbosity.DEBUG, "keepalive", "(" + this.channelzRef.id + ") " + text);
			}
			addProtoService() {
				throw new Error("Not implemented. Use addService() instead");
			}
			addService(service, implementation) {
				if (service === null || typeof service !== "object" || implementation === null || typeof implementation !== "object") throw new Error("addService() requires two objects as arguments");
				const serviceKeys = Object.keys(service);
				if (serviceKeys.length === 0) throw new Error("Cannot add an empty service to a server");
				serviceKeys.forEach((name) => {
					const attrs = service[name];
					let methodType;
					if (attrs.requestStream) if (attrs.responseStream) methodType = "bidi";
					else methodType = "clientStream";
					else if (attrs.responseStream) methodType = "serverStream";
					else methodType = "unary";
					let implFn = implementation[name];
					let impl;
					if (implFn === void 0 && typeof attrs.originalName === "string") implFn = implementation[attrs.originalName];
					if (implFn !== void 0) impl = implFn.bind(implementation);
					else impl = getDefaultHandler(methodType, name);
					if (this.register(attrs.path, impl, attrs.responseSerialize, attrs.requestDeserialize, methodType) === false) throw new Error(`Method handler for ${attrs.path} already provided.`);
				});
			}
			removeService(service) {
				if (service === null || typeof service !== "object") throw new Error("removeService() requires object as argument");
				Object.keys(service).forEach((name) => {
					const attrs = service[name];
					this.unregister(attrs.path);
				});
			}
			bind(port, creds) {
				throw new Error("Not implemented. Use bindAsync() instead");
			}
			/**
			* This API is experimental, so API stability is not guaranteed across minor versions.
			* @param boundAddress
			* @returns
			*/
			experimentalRegisterListenerToChannelz(boundAddress) {
				return (0, channelz_1.registerChannelzSocket)((0, subchannel_address_1.subchannelAddressToString)(boundAddress), () => {
					return {
						localAddress: boundAddress,
						remoteAddress: null,
						security: null,
						remoteName: null,
						streamsStarted: 0,
						streamsSucceeded: 0,
						streamsFailed: 0,
						messagesSent: 0,
						messagesReceived: 0,
						keepAlivesSent: 0,
						lastLocalStreamCreatedTimestamp: null,
						lastRemoteStreamCreatedTimestamp: null,
						lastMessageSentTimestamp: null,
						lastMessageReceivedTimestamp: null,
						localFlowControlWindow: null,
						remoteFlowControlWindow: null
					};
				}, this.channelzEnabled);
			}
			experimentalUnregisterListenerFromChannelz(channelzRef) {
				(0, channelz_1.unregisterChannelzRef)(channelzRef);
			}
			createHttp2Server(credentials) {
				let http2Server;
				if (credentials._isSecure()) {
					const constructorOptions = credentials._getConstructorOptions();
					const contextOptions = credentials._getSecureContextOptions();
					const secureServerOptions = Object.assign(Object.assign(Object.assign(Object.assign({}, this.commonServerOptions), constructorOptions), contextOptions), { enableTrace: this.options["grpc-node.tls_enable_trace"] === 1 });
					let areCredentialsValid = contextOptions !== null;
					this.trace("Initial credentials valid: " + areCredentialsValid);
					http2Server = http2.createSecureServer(secureServerOptions);
					http2Server.prependListener("connection", (socket) => {
						if (!areCredentialsValid) {
							this.trace("Dropped connection from " + JSON.stringify(socket.address()) + " due to unloaded credentials");
							socket.destroy();
						}
					});
					http2Server.on("secureConnection", (socket) => {
						socket.on("error", (e) => {
							this.trace("An incoming TLS connection closed with error: " + e.message);
						});
					});
					const credsWatcher = (options) => {
						if (options) {
							const secureServer = http2Server;
							try {
								secureServer.setSecureContext(options);
							} catch (e) {
								logging.log(constants_1.LogVerbosity.ERROR, "Failed to set secure context with error " + e.message);
								options = null;
							}
						}
						areCredentialsValid = options !== null;
						this.trace("Post-update credentials valid: " + areCredentialsValid);
					};
					credentials._addWatcher(credsWatcher);
					http2Server.on("close", () => {
						credentials._removeWatcher(credsWatcher);
					});
				} else http2Server = http2.createServer(this.commonServerOptions);
				http2Server.setTimeout(0, noop);
				this._setupHandlers(http2Server, credentials._getInterceptors());
				return http2Server;
			}
			bindOneAddress(address, boundPortObject) {
				this.trace("Attempting to bind " + (0, subchannel_address_1.subchannelAddressToString)(address));
				const http2Server = this.createHttp2Server(boundPortObject.credentials);
				return new Promise((resolve, reject) => {
					const onError = (err) => {
						this.trace("Failed to bind " + (0, subchannel_address_1.subchannelAddressToString)(address) + " with error " + err.message);
						resolve({
							port: "port" in address ? address.port : 1,
							error: err.message
						});
					};
					http2Server.once("error", onError);
					http2Server.listen(address, () => {
						const boundAddress = http2Server.address();
						let boundSubchannelAddress;
						if (typeof boundAddress === "string") boundSubchannelAddress = { path: boundAddress };
						else boundSubchannelAddress = {
							host: boundAddress.address,
							port: boundAddress.port
						};
						const channelzRef = this.experimentalRegisterListenerToChannelz(boundSubchannelAddress);
						this.listenerChildrenTracker.refChild(channelzRef);
						this.http2Servers.set(http2Server, {
							channelzRef,
							sessions: /* @__PURE__ */ new Set(),
							ownsChannelzRef: true
						});
						boundPortObject.listeningServers.add(http2Server);
						this.trace("Successfully bound " + (0, subchannel_address_1.subchannelAddressToString)(boundSubchannelAddress));
						resolve({ port: "port" in boundSubchannelAddress ? boundSubchannelAddress.port : 1 });
						http2Server.removeListener("error", onError);
					});
				});
			}
			async bindManyPorts(addressList, boundPortObject) {
				if (addressList.length === 0) return {
					count: 0,
					port: 0,
					errors: []
				};
				if ((0, subchannel_address_1.isTcpSubchannelAddress)(addressList[0]) && addressList[0].port === 0) {
					const firstAddressResult = await this.bindOneAddress(addressList[0], boundPortObject);
					if (firstAddressResult.error) {
						const restAddressResult = await this.bindManyPorts(addressList.slice(1), boundPortObject);
						return Object.assign(Object.assign({}, restAddressResult), { errors: [firstAddressResult.error, ...restAddressResult.errors] });
					} else {
						const restAddresses = addressList.slice(1).map((address) => (0, subchannel_address_1.isTcpSubchannelAddress)(address) ? {
							host: address.host,
							port: firstAddressResult.port
						} : address);
						const allResults = [firstAddressResult, ...await Promise.all(restAddresses.map((address) => this.bindOneAddress(address, boundPortObject)))];
						return {
							count: allResults.filter((result) => result.error === void 0).length,
							port: firstAddressResult.port,
							errors: allResults.filter((result) => result.error).map((result) => result.error)
						};
					}
				} else {
					const allResults = await Promise.all(addressList.map((address) => this.bindOneAddress(address, boundPortObject)));
					return {
						count: allResults.filter((result) => result.error === void 0).length,
						port: allResults[0].port,
						errors: allResults.filter((result) => result.error).map((result) => result.error)
					};
				}
			}
			async bindAddressList(addressList, boundPortObject) {
				const bindResult = await this.bindManyPorts(addressList, boundPortObject);
				if (bindResult.count > 0) {
					if (bindResult.count < addressList.length) logging.log(constants_1.LogVerbosity.INFO, `WARNING Only ${bindResult.count} addresses added out of total ${addressList.length} resolved`);
					return bindResult.port;
				} else {
					const errorString = `No address added out of total ${addressList.length} resolved`;
					logging.log(constants_1.LogVerbosity.ERROR, errorString);
					throw new Error(`${errorString} errors: [${bindResult.errors.join(",")}]`);
				}
			}
			resolvePort(port) {
				return new Promise((resolve, reject) => {
					let seenResolution = false;
					const resolverListener = (endpointList, attributes, serviceConfig, resolutionNote) => {
						if (seenResolution) return true;
						seenResolution = true;
						if (!endpointList.ok) {
							reject(new Error(endpointList.error.details));
							return true;
						}
						const addressList = [].concat(...endpointList.value.map((endpoint) => endpoint.addresses));
						if (addressList.length === 0) {
							reject(/* @__PURE__ */ new Error(`No addresses resolved for port ${port}`));
							return true;
						}
						resolve(addressList);
						return true;
					};
					(0, resolver_1.createResolver)(port, resolverListener, this.options).updateResolution();
				});
			}
			async bindPort(port, boundPortObject) {
				const addressList = await this.resolvePort(port);
				if (boundPortObject.cancelled) {
					this.completeUnbind(boundPortObject);
					throw new Error("bindAsync operation cancelled by unbind call");
				}
				const portNumber = await this.bindAddressList(addressList, boundPortObject);
				if (boundPortObject.cancelled) {
					this.completeUnbind(boundPortObject);
					throw new Error("bindAsync operation cancelled by unbind call");
				}
				return portNumber;
			}
			normalizePort(port) {
				const initialPortUri = (0, uri_parser_1.parseUri)(port);
				if (initialPortUri === null) throw new Error(`Could not parse port "${port}"`);
				const portUri = (0, resolver_1.mapUriDefaultScheme)(initialPortUri);
				if (portUri === null) throw new Error(`Could not get a default scheme for port "${port}"`);
				return portUri;
			}
			bindAsync(port, creds, callback) {
				if (this.shutdown) throw new Error("bindAsync called after shutdown");
				if (typeof port !== "string") throw new TypeError("port must be a string");
				if (creds === null || !(creds instanceof server_credentials_1.ServerCredentials)) throw new TypeError("creds must be a ServerCredentials object");
				if (typeof callback !== "function") throw new TypeError("callback must be a function");
				this.trace("bindAsync port=" + port);
				const portUri = this.normalizePort(port);
				const deferredCallback = (error, port) => {
					process.nextTick(() => callback(error, port));
				};
				let boundPortObject = this.boundPorts.get((0, uri_parser_1.uriToString)(portUri));
				if (boundPortObject) {
					if (!creds._equals(boundPortObject.credentials)) {
						deferredCallback(/* @__PURE__ */ new Error(`${port} already bound with incompatible credentials`), 0);
						return;
					}
					boundPortObject.cancelled = false;
					if (boundPortObject.completionPromise) boundPortObject.completionPromise.then((portNum) => callback(null, portNum), (error) => callback(error, 0));
					else deferredCallback(null, boundPortObject.portNumber);
					return;
				}
				boundPortObject = {
					mapKey: (0, uri_parser_1.uriToString)(portUri),
					originalUri: portUri,
					completionPromise: null,
					cancelled: false,
					portNumber: 0,
					credentials: creds,
					listeningServers: /* @__PURE__ */ new Set()
				};
				const splitPort = (0, uri_parser_1.splitHostPort)(portUri.path);
				const completionPromise = this.bindPort(portUri, boundPortObject);
				boundPortObject.completionPromise = completionPromise;
				if ((splitPort === null || splitPort === void 0 ? void 0 : splitPort.port) === 0) completionPromise.then((portNum) => {
					const finalUri = {
						scheme: portUri.scheme,
						authority: portUri.authority,
						path: (0, uri_parser_1.combineHostPort)({
							host: splitPort.host,
							port: portNum
						})
					};
					boundPortObject.mapKey = (0, uri_parser_1.uriToString)(finalUri);
					boundPortObject.completionPromise = null;
					boundPortObject.portNumber = portNum;
					this.boundPorts.set(boundPortObject.mapKey, boundPortObject);
					callback(null, portNum);
				}, (error) => {
					callback(error, 0);
				});
				else {
					this.boundPorts.set(boundPortObject.mapKey, boundPortObject);
					completionPromise.then((portNum) => {
						boundPortObject.completionPromise = null;
						boundPortObject.portNumber = portNum;
						callback(null, portNum);
					}, (error) => {
						callback(error, 0);
					});
				}
			}
			registerInjectorToChannelz() {
				return (0, channelz_1.registerChannelzSocket)("injector", () => {
					return {
						localAddress: null,
						remoteAddress: null,
						security: null,
						remoteName: null,
						streamsStarted: 0,
						streamsSucceeded: 0,
						streamsFailed: 0,
						messagesSent: 0,
						messagesReceived: 0,
						keepAlivesSent: 0,
						lastLocalStreamCreatedTimestamp: null,
						lastRemoteStreamCreatedTimestamp: null,
						lastMessageSentTimestamp: null,
						lastMessageReceivedTimestamp: null,
						localFlowControlWindow: null,
						remoteFlowControlWindow: null
					};
				}, this.channelzEnabled);
			}
			/**
			* This API is experimental, so API stability is not guaranteed across minor versions.
			* @param credentials
			* @param channelzRef
			* @returns
			*/
			experimentalCreateConnectionInjectorWithChannelzRef(credentials, channelzRef, ownsChannelzRef = false) {
				if (credentials === null || !(credentials instanceof server_credentials_1.ServerCredentials)) throw new TypeError("creds must be a ServerCredentials object");
				if (this.channelzEnabled) this.listenerChildrenTracker.refChild(channelzRef);
				const server = this.createHttp2Server(credentials);
				const sessionsSet = /* @__PURE__ */ new Set();
				this.http2Servers.set(server, {
					channelzRef,
					sessions: sessionsSet,
					ownsChannelzRef
				});
				return {
					injectConnection: (connection) => {
						server.emit("connection", connection);
					},
					drain: (graceTimeMs) => {
						var _b, _c;
						for (const session of sessionsSet) this.closeSession(session);
						(_c = (_b = setTimeout(() => {
							for (const session of sessionsSet) session.destroy(http2.constants.NGHTTP2_CANCEL);
						}, graceTimeMs)).unref) === null || _c === void 0 || _c.call(_b);
					},
					destroy: () => {
						this.closeServer(server);
						for (const session of sessionsSet) this.closeSession(session);
					}
				};
			}
			createConnectionInjector(credentials) {
				if (credentials === null || !(credentials instanceof server_credentials_1.ServerCredentials)) throw new TypeError("creds must be a ServerCredentials object");
				const channelzRef = this.registerInjectorToChannelz();
				return this.experimentalCreateConnectionInjectorWithChannelzRef(credentials, channelzRef, true);
			}
			closeServer(server, callback) {
				this.trace("Closing server with address " + JSON.stringify(server.address()));
				const serverInfo = this.http2Servers.get(server);
				server.close(() => {
					if (serverInfo && serverInfo.ownsChannelzRef) {
						this.listenerChildrenTracker.unrefChild(serverInfo.channelzRef);
						(0, channelz_1.unregisterChannelzRef)(serverInfo.channelzRef);
					}
					this.http2Servers.delete(server);
					callback === null || callback === void 0 || callback();
				});
			}
			closeSession(session, callback) {
				var _b;
				this.trace("Closing session initiated by " + ((_b = session.socket) === null || _b === void 0 ? void 0 : _b.remoteAddress));
				const sessionInfo = this.sessions.get(session);
				const closeCallback = () => {
					if (sessionInfo) {
						this.sessionChildrenTracker.unrefChild(sessionInfo.ref);
						(0, channelz_1.unregisterChannelzRef)(sessionInfo.ref);
					}
					callback === null || callback === void 0 || callback();
				};
				if (session.closed) queueMicrotask(closeCallback);
				else session.close(closeCallback);
			}
			completeUnbind(boundPortObject) {
				for (const server of boundPortObject.listeningServers) {
					const serverInfo = this.http2Servers.get(server);
					this.closeServer(server, () => {
						boundPortObject.listeningServers.delete(server);
					});
					if (serverInfo) for (const session of serverInfo.sessions) this.closeSession(session);
				}
				this.boundPorts.delete(boundPortObject.mapKey);
			}
			/**
			* Unbind a previously bound port, or cancel an in-progress bindAsync
			* operation. If port 0 was bound, only the actual bound port can be
			* unbound. For example, if bindAsync was called with "localhost:0" and the
			* bound port result was 54321, it can be unbound as "localhost:54321".
			* @param port
			*/
			unbind(port) {
				this.trace("unbind port=" + port);
				const portUri = this.normalizePort(port);
				const splitPort = (0, uri_parser_1.splitHostPort)(portUri.path);
				if ((splitPort === null || splitPort === void 0 ? void 0 : splitPort.port) === 0) throw new Error("Cannot unbind port 0");
				const boundPortObject = this.boundPorts.get((0, uri_parser_1.uriToString)(portUri));
				if (boundPortObject) {
					this.trace("unbinding " + boundPortObject.mapKey + " originally bound as " + (0, uri_parser_1.uriToString)(boundPortObject.originalUri));
					if (boundPortObject.completionPromise) boundPortObject.cancelled = true;
					else this.completeUnbind(boundPortObject);
				}
			}
			/**
			* Gracefully close all connections associated with a previously bound port.
			* After the grace time, forcefully close all remaining open connections.
			*
			* If port 0 was bound, only the actual bound port can be
			* drained. For example, if bindAsync was called with "localhost:0" and the
			* bound port result was 54321, it can be drained as "localhost:54321".
			* @param port
			* @param graceTimeMs
			* @returns
			*/
			drain(port, graceTimeMs) {
				var _b, _c;
				this.trace("drain port=" + port + " graceTimeMs=" + graceTimeMs);
				const portUri = this.normalizePort(port);
				const splitPort = (0, uri_parser_1.splitHostPort)(portUri.path);
				if ((splitPort === null || splitPort === void 0 ? void 0 : splitPort.port) === 0) throw new Error("Cannot drain port 0");
				const boundPortObject = this.boundPorts.get((0, uri_parser_1.uriToString)(portUri));
				if (!boundPortObject) return;
				const allSessions = /* @__PURE__ */ new Set();
				for (const http2Server of boundPortObject.listeningServers) {
					const serverEntry = this.http2Servers.get(http2Server);
					if (serverEntry) for (const session of serverEntry.sessions) {
						allSessions.add(session);
						this.closeSession(session, () => {
							allSessions.delete(session);
						});
					}
				}
				(_c = (_b = setTimeout(() => {
					for (const session of allSessions) session.destroy(http2.constants.NGHTTP2_CANCEL);
				}, graceTimeMs)).unref) === null || _c === void 0 || _c.call(_b);
			}
			forceShutdown() {
				for (const boundPortObject of this.boundPorts.values()) boundPortObject.cancelled = true;
				this.boundPorts.clear();
				for (const server of this.http2Servers.keys()) this.closeServer(server);
				this.sessions.forEach((channelzInfo, session) => {
					this.closeSession(session);
					session.destroy(http2.constants.NGHTTP2_CANCEL);
				});
				this.sessions.clear();
				(0, channelz_1.unregisterChannelzRef)(this.channelzRef);
				this.shutdown = true;
			}
			register(name, handler, serialize, deserialize, type) {
				if (this.handlers.has(name)) return false;
				this.handlers.set(name, {
					func: handler,
					serialize,
					deserialize,
					type,
					path: name
				});
				return true;
			}
			unregister(name) {
				return this.handlers.delete(name);
			}
			/**
			* @deprecated No longer needed as of version 1.10.x
			*/
			start() {
				if (this.http2Servers.size === 0 || [...this.http2Servers.keys()].every((server) => !server.listening)) throw new Error("server must be bound in order to start");
				if (this.started === true) throw new Error("server is already started");
				this.started = true;
			}
			tryShutdown(callback) {
				var _b;
				const wrappedCallback = (error) => {
					(0, channelz_1.unregisterChannelzRef)(this.channelzRef);
					callback(error);
				};
				let pendingChecks = 0;
				function maybeCallback() {
					pendingChecks--;
					if (pendingChecks === 0) wrappedCallback();
				}
				this.shutdown = true;
				for (const [serverKey, server] of this.http2Servers.entries()) {
					pendingChecks++;
					const serverString = server.channelzRef.name;
					this.trace("Waiting for server " + serverString + " to close");
					this.closeServer(serverKey, () => {
						this.trace("Server " + serverString + " finished closing");
						maybeCallback();
					});
					for (const session of server.sessions.keys()) {
						pendingChecks++;
						const sessionString = (_b = session.socket) === null || _b === void 0 ? void 0 : _b.remoteAddress;
						this.trace("Waiting for session " + sessionString + " to close");
						this.closeSession(session, () => {
							this.trace("Session " + sessionString + " finished closing");
							maybeCallback();
						});
					}
				}
				if (pendingChecks === 0) wrappedCallback();
			}
			addHttp2Port() {
				throw new Error("Not yet implemented");
			}
			/**
			* Get the channelz reference object for this server. The returned value is
			* garbage if channelz is disabled for this server.
			* @returns
			*/
			getChannelzRef() {
				return this.channelzRef;
			}
			_verifyContentType(stream, headers) {
				const contentType = headers[http2.constants.HTTP2_HEADER_CONTENT_TYPE];
				if (typeof contentType !== "string" || !contentType.startsWith("application/grpc")) {
					stream.respond({ [http2.constants.HTTP2_HEADER_STATUS]: http2.constants.HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE }, { endStream: true });
					return false;
				}
				return true;
			}
			_retrieveHandler(path) {
				serverCallTrace("Received call to method " + path + " at address " + this.serverAddressString);
				const handler = this.handlers.get(path);
				if (handler === void 0) {
					serverCallTrace("No handler registered for method " + path + ". Sending UNIMPLEMENTED status.");
					return null;
				}
				return handler;
			}
			_respondWithError(err, stream, channelzSessionInfo = null) {
				var _b, _c;
				const trailersToSend = Object.assign({
					"grpc-status": (_b = err.code) !== null && _b !== void 0 ? _b : constants_1.Status.INTERNAL,
					"grpc-message": err.details,
					[http2.constants.HTTP2_HEADER_STATUS]: http2.constants.HTTP_STATUS_OK,
					[http2.constants.HTTP2_HEADER_CONTENT_TYPE]: "application/grpc+proto"
				}, (_c = err.metadata) === null || _c === void 0 ? void 0 : _c.toHttp2Headers());
				stream.respond(trailersToSend, { endStream: true });
				this.callTracker.addCallFailed();
				channelzSessionInfo === null || channelzSessionInfo === void 0 || channelzSessionInfo.streamTracker.addCallFailed();
			}
			_channelzHandler(extraInterceptors, stream, headers) {
				this.onStreamOpened(stream);
				const channelzSessionInfo = this.sessions.get(stream.session);
				this.callTracker.addCallStarted();
				channelzSessionInfo === null || channelzSessionInfo === void 0 || channelzSessionInfo.streamTracker.addCallStarted();
				if (!this._verifyContentType(stream, headers)) {
					this.callTracker.addCallFailed();
					channelzSessionInfo === null || channelzSessionInfo === void 0 || channelzSessionInfo.streamTracker.addCallFailed();
					return;
				}
				const path = headers[HTTP2_HEADER_PATH];
				const handler = this._retrieveHandler(path);
				if (!handler) {
					this._respondWithError(getUnimplementedStatusResponse(path), stream, channelzSessionInfo);
					return;
				}
				const callEventTracker = {
					addMessageSent: () => {
						if (channelzSessionInfo) {
							channelzSessionInfo.messagesSent += 1;
							channelzSessionInfo.lastMessageSentTimestamp = /* @__PURE__ */ new Date();
						}
					},
					addMessageReceived: () => {
						if (channelzSessionInfo) {
							channelzSessionInfo.messagesReceived += 1;
							channelzSessionInfo.lastMessageReceivedTimestamp = /* @__PURE__ */ new Date();
						}
					},
					onCallEnd: (status) => {
						if (status.code === constants_1.Status.OK) this.callTracker.addCallSucceeded();
						else this.callTracker.addCallFailed();
					},
					onStreamEnd: (success) => {
						if (channelzSessionInfo) if (success) channelzSessionInfo.streamTracker.addCallSucceeded();
						else channelzSessionInfo.streamTracker.addCallFailed();
					}
				};
				const call = (0, server_interceptors_1.getServerInterceptingCall)([...extraInterceptors, ...this.interceptors], stream, headers, callEventTracker, handler, this.options);
				if (!this._runHandlerForCall(call, handler)) {
					this.callTracker.addCallFailed();
					channelzSessionInfo === null || channelzSessionInfo === void 0 || channelzSessionInfo.streamTracker.addCallFailed();
					call.sendStatus({
						code: constants_1.Status.INTERNAL,
						details: `Unknown handler type: ${handler.type}`
					});
				}
			}
			_streamHandler(extraInterceptors, stream, headers) {
				this.onStreamOpened(stream);
				if (this._verifyContentType(stream, headers) !== true) return;
				const path = headers[HTTP2_HEADER_PATH];
				const handler = this._retrieveHandler(path);
				if (!handler) {
					this._respondWithError(getUnimplementedStatusResponse(path), stream, null);
					return;
				}
				const call = (0, server_interceptors_1.getServerInterceptingCall)([...extraInterceptors, ...this.interceptors], stream, headers, null, handler, this.options);
				if (!this._runHandlerForCall(call, handler)) call.sendStatus({
					code: constants_1.Status.INTERNAL,
					details: `Unknown handler type: ${handler.type}`
				});
			}
			_runHandlerForCall(call, handler) {
				const { type } = handler;
				if (type === "unary") handleUnary(call, handler);
				else if (type === "clientStream") handleClientStreaming(call, handler);
				else if (type === "serverStream") handleServerStreaming(call, handler);
				else if (type === "bidi") handleBidiStreaming(call, handler);
				else return false;
				return true;
			}
			_setupHandlers(http2Server, extraInterceptors) {
				if (http2Server === null) return;
				const serverAddress = http2Server.address();
				let serverAddressString = "null";
				if (serverAddress) if (typeof serverAddress === "string") serverAddressString = serverAddress;
				else serverAddressString = serverAddress.address + ":" + serverAddress.port;
				this.serverAddressString = serverAddressString;
				const handler = this.channelzEnabled ? this._channelzHandler : this._streamHandler;
				const sessionHandler = this.channelzEnabled ? this._channelzSessionHandler(http2Server) : this._sessionHandler(http2Server);
				http2Server.on("stream", handler.bind(this, extraInterceptors));
				http2Server.on("session", sessionHandler);
			}
			_sessionHandler(http2Server) {
				return (session) => {
					var _b, _c;
					(_b = this.http2Servers.get(http2Server)) === null || _b === void 0 || _b.sessions.add(session);
					let connectionAgeTimer = null;
					let connectionAgeGraceTimer = null;
					let keepaliveTimer = null;
					let sessionClosedByServer = false;
					const idleTimeoutObj = this.enableIdleTimeout(session);
					if (this.maxConnectionAgeMs !== UNLIMITED_CONNECTION_AGE_MS) {
						const jitterMagnitude = this.maxConnectionAgeMs / 10;
						const jitter = Math.random() * jitterMagnitude * 2 - jitterMagnitude;
						connectionAgeTimer = setTimeout(() => {
							var _b, _c;
							sessionClosedByServer = true;
							this.trace("Connection dropped by max connection age: " + ((_b = session.socket) === null || _b === void 0 ? void 0 : _b.remoteAddress));
							try {
								session.goaway(http2.constants.NGHTTP2_NO_ERROR, 2147483647, kMaxAge);
							} catch (e) {
								session.destroy();
								return;
							}
							session.close();
							if (this.maxConnectionAgeGraceMs !== UNLIMITED_CONNECTION_AGE_MS) {
								connectionAgeGraceTimer = setTimeout(() => {
									session.destroy();
								}, this.maxConnectionAgeGraceMs);
								(_c = connectionAgeGraceTimer.unref) === null || _c === void 0 || _c.call(connectionAgeGraceTimer);
							}
						}, this.maxConnectionAgeMs + jitter);
						(_c = connectionAgeTimer.unref) === null || _c === void 0 || _c.call(connectionAgeTimer);
					}
					const clearKeepaliveTimeout = () => {
						if (keepaliveTimer) {
							clearTimeout(keepaliveTimer);
							keepaliveTimer = null;
						}
					};
					const canSendPing = () => {
						return !session.destroyed && this.keepaliveTimeMs < KEEPALIVE_MAX_TIME_MS && this.keepaliveTimeMs > 0;
					};
					let sendPing;
					const maybeStartKeepalivePingTimer = () => {
						var _b;
						if (!canSendPing()) return;
						this.keepaliveTrace("Starting keepalive timer for " + this.keepaliveTimeMs + "ms");
						keepaliveTimer = setTimeout(() => {
							clearKeepaliveTimeout();
							sendPing();
						}, this.keepaliveTimeMs);
						(_b = keepaliveTimer.unref) === null || _b === void 0 || _b.call(keepaliveTimer);
					};
					sendPing = () => {
						var _b;
						if (!canSendPing()) return;
						this.keepaliveTrace("Sending ping with timeout " + this.keepaliveTimeoutMs + "ms");
						let pingSendError = "";
						try {
							if (!session.ping((err, duration, payload) => {
								clearKeepaliveTimeout();
								if (err) {
									this.keepaliveTrace("Ping failed with error: " + err.message);
									sessionClosedByServer = true;
									session.destroy();
								} else {
									this.keepaliveTrace("Received ping response");
									maybeStartKeepalivePingTimer();
								}
							})) pingSendError = "Ping returned false";
						} catch (e) {
							pingSendError = (e instanceof Error ? e.message : "") || "Unknown error";
						}
						if (pingSendError) {
							this.keepaliveTrace("Ping send failed: " + pingSendError);
							this.trace("Connection dropped due to ping send error: " + pingSendError);
							sessionClosedByServer = true;
							session.destroy();
							return;
						}
						keepaliveTimer = setTimeout(() => {
							clearKeepaliveTimeout();
							this.keepaliveTrace("Ping timeout passed without response");
							this.trace("Connection dropped by keepalive timeout");
							sessionClosedByServer = true;
							session.destroy();
						}, this.keepaliveTimeoutMs);
						(_b = keepaliveTimer.unref) === null || _b === void 0 || _b.call(keepaliveTimer);
					};
					maybeStartKeepalivePingTimer();
					session.on("close", () => {
						var _b, _c;
						if (!sessionClosedByServer) this.trace(`Connection dropped by client ${(_b = session.socket) === null || _b === void 0 ? void 0 : _b.remoteAddress}`);
						if (connectionAgeTimer) clearTimeout(connectionAgeTimer);
						if (connectionAgeGraceTimer) clearTimeout(connectionAgeGraceTimer);
						clearKeepaliveTimeout();
						if (idleTimeoutObj !== null) {
							clearTimeout(idleTimeoutObj.timeout);
							this.sessionIdleTimeouts.delete(session);
						}
						(_c = this.http2Servers.get(http2Server)) === null || _c === void 0 || _c.sessions.delete(session);
					});
				};
			}
			_channelzSessionHandler(http2Server) {
				return (session) => {
					var _b, _c, _d, _e;
					const channelzRef = (0, channelz_1.registerChannelzSocket)((_c = (_b = session.socket) === null || _b === void 0 ? void 0 : _b.remoteAddress) !== null && _c !== void 0 ? _c : "unknown", this.getChannelzSessionInfo.bind(this, session), this.channelzEnabled);
					const channelzSessionInfo = {
						ref: channelzRef,
						streamTracker: new channelz_1.ChannelzCallTracker(),
						messagesSent: 0,
						messagesReceived: 0,
						keepAlivesSent: 0,
						lastMessageSentTimestamp: null,
						lastMessageReceivedTimestamp: null
					};
					(_d = this.http2Servers.get(http2Server)) === null || _d === void 0 || _d.sessions.add(session);
					this.sessions.set(session, channelzSessionInfo);
					const clientAddress = `${session.socket.remoteAddress}:${session.socket.remotePort}`;
					this.channelzTrace.addTrace("CT_INFO", "Connection established by client " + clientAddress);
					this.trace("Connection established by client " + clientAddress);
					this.sessionChildrenTracker.refChild(channelzRef);
					let connectionAgeTimer = null;
					let connectionAgeGraceTimer = null;
					let keepaliveTimeout = null;
					let sessionClosedByServer = false;
					const idleTimeoutObj = this.enableIdleTimeout(session);
					if (this.maxConnectionAgeMs !== UNLIMITED_CONNECTION_AGE_MS) {
						const jitterMagnitude = this.maxConnectionAgeMs / 10;
						const jitter = Math.random() * jitterMagnitude * 2 - jitterMagnitude;
						connectionAgeTimer = setTimeout(() => {
							var _b;
							sessionClosedByServer = true;
							this.channelzTrace.addTrace("CT_INFO", "Connection dropped by max connection age from " + clientAddress);
							try {
								session.goaway(http2.constants.NGHTTP2_NO_ERROR, 2147483647, kMaxAge);
							} catch (e) {
								session.destroy();
								return;
							}
							session.close();
							if (this.maxConnectionAgeGraceMs !== UNLIMITED_CONNECTION_AGE_MS) {
								connectionAgeGraceTimer = setTimeout(() => {
									session.destroy();
								}, this.maxConnectionAgeGraceMs);
								(_b = connectionAgeGraceTimer.unref) === null || _b === void 0 || _b.call(connectionAgeGraceTimer);
							}
						}, this.maxConnectionAgeMs + jitter);
						(_e = connectionAgeTimer.unref) === null || _e === void 0 || _e.call(connectionAgeTimer);
					}
					const clearKeepaliveTimeout = () => {
						if (keepaliveTimeout) {
							clearTimeout(keepaliveTimeout);
							keepaliveTimeout = null;
						}
					};
					const canSendPing = () => {
						return !session.destroyed && this.keepaliveTimeMs < KEEPALIVE_MAX_TIME_MS && this.keepaliveTimeMs > 0;
					};
					let sendPing;
					const maybeStartKeepalivePingTimer = () => {
						var _b;
						if (!canSendPing()) return;
						this.keepaliveTrace("Starting keepalive timer for " + this.keepaliveTimeMs + "ms");
						keepaliveTimeout = setTimeout(() => {
							clearKeepaliveTimeout();
							sendPing();
						}, this.keepaliveTimeMs);
						(_b = keepaliveTimeout.unref) === null || _b === void 0 || _b.call(keepaliveTimeout);
					};
					sendPing = () => {
						var _b;
						if (!canSendPing()) return;
						this.keepaliveTrace("Sending ping with timeout " + this.keepaliveTimeoutMs + "ms");
						let pingSendError = "";
						try {
							if (!session.ping((err, duration, payload) => {
								clearKeepaliveTimeout();
								if (err) {
									this.keepaliveTrace("Ping failed with error: " + err.message);
									this.channelzTrace.addTrace("CT_INFO", "Connection dropped due to error of a ping frame " + err.message + " return in " + duration);
									sessionClosedByServer = true;
									session.destroy();
								} else {
									this.keepaliveTrace("Received ping response");
									maybeStartKeepalivePingTimer();
								}
							})) pingSendError = "Ping returned false";
						} catch (e) {
							pingSendError = (e instanceof Error ? e.message : "") || "Unknown error";
						}
						if (pingSendError) {
							this.keepaliveTrace("Ping send failed: " + pingSendError);
							this.channelzTrace.addTrace("CT_INFO", "Connection dropped due to ping send error: " + pingSendError);
							sessionClosedByServer = true;
							session.destroy();
							return;
						}
						channelzSessionInfo.keepAlivesSent += 1;
						keepaliveTimeout = setTimeout(() => {
							clearKeepaliveTimeout();
							this.keepaliveTrace("Ping timeout passed without response");
							this.channelzTrace.addTrace("CT_INFO", "Connection dropped by keepalive timeout from " + clientAddress);
							sessionClosedByServer = true;
							session.destroy();
						}, this.keepaliveTimeoutMs);
						(_b = keepaliveTimeout.unref) === null || _b === void 0 || _b.call(keepaliveTimeout);
					};
					maybeStartKeepalivePingTimer();
					session.on("close", () => {
						var _b;
						if (!sessionClosedByServer) this.channelzTrace.addTrace("CT_INFO", "Connection dropped by client " + clientAddress);
						this.sessionChildrenTracker.unrefChild(channelzRef);
						(0, channelz_1.unregisterChannelzRef)(channelzRef);
						if (connectionAgeTimer) clearTimeout(connectionAgeTimer);
						if (connectionAgeGraceTimer) clearTimeout(connectionAgeGraceTimer);
						clearKeepaliveTimeout();
						if (idleTimeoutObj !== null) {
							clearTimeout(idleTimeoutObj.timeout);
							this.sessionIdleTimeouts.delete(session);
						}
						(_b = this.http2Servers.get(http2Server)) === null || _b === void 0 || _b.sessions.delete(session);
						this.sessions.delete(session);
					});
				};
			}
			enableIdleTimeout(session) {
				var _b, _c;
				if (this.sessionIdleTimeout >= MAX_CONNECTION_IDLE_MS) return null;
				const idleTimeoutObj = {
					activeStreams: 0,
					lastIdle: Date.now(),
					onClose: this.onStreamClose.bind(this, session),
					timeout: setTimeout(this.onIdleTimeout, this.sessionIdleTimeout, this, session)
				};
				(_c = (_b = idleTimeoutObj.timeout).unref) === null || _c === void 0 || _c.call(_b);
				this.sessionIdleTimeouts.set(session, idleTimeoutObj);
				const { socket } = session;
				this.trace("Enable idle timeout for " + socket.remoteAddress + ":" + socket.remotePort);
				return idleTimeoutObj;
			}
			onIdleTimeout(ctx, session) {
				const { socket } = session;
				const sessionInfo = ctx.sessionIdleTimeouts.get(session);
				if (sessionInfo !== void 0 && sessionInfo.activeStreams === 0) if (Date.now() - sessionInfo.lastIdle >= ctx.sessionIdleTimeout) {
					ctx.trace("Session idle timeout triggered for " + (socket === null || socket === void 0 ? void 0 : socket.remoteAddress) + ":" + (socket === null || socket === void 0 ? void 0 : socket.remotePort) + " last idle at " + sessionInfo.lastIdle);
					ctx.closeSession(session);
				} else sessionInfo.timeout.refresh();
			}
			onStreamOpened(stream) {
				const session = stream.session;
				const idleTimeoutObj = this.sessionIdleTimeouts.get(session);
				if (idleTimeoutObj) {
					idleTimeoutObj.activeStreams += 1;
					stream.once("close", idleTimeoutObj.onClose);
				}
			}
			onStreamClose(session) {
				var _b, _c;
				const idleTimeoutObj = this.sessionIdleTimeouts.get(session);
				if (idleTimeoutObj) {
					idleTimeoutObj.activeStreams -= 1;
					if (idleTimeoutObj.activeStreams === 0) {
						idleTimeoutObj.lastIdle = Date.now();
						idleTimeoutObj.timeout.refresh();
						this.trace("Session onStreamClose" + ((_b = session.socket) === null || _b === void 0 ? void 0 : _b.remoteAddress) + ":" + ((_c = session.socket) === null || _c === void 0 ? void 0 : _c.remotePort) + " at " + idleTimeoutObj.lastIdle);
					}
				}
			}
		}, (() => {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
			_start_decorators = [deprecate("Calling start() is no longer necessary. It can be safely omitted.")];
			__esDecorate(_a, null, _start_decorators, {
				kind: "method",
				name: "start",
				static: false,
				private: false,
				access: {
					has: (obj) => "start" in obj,
					get: (obj) => obj.start
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(_a, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		})(), _a;
	})();
	async function handleUnary(call, handler) {
		let stream;
		function respond(err, value, trailer, flags) {
			if (err) {
				call.sendStatus((0, server_call_1.serverErrorToStatus)(err, trailer));
				return;
			}
			call.sendMessage(value, () => {
				call.sendStatus({
					code: constants_1.Status.OK,
					details: "OK",
					metadata: trailer !== null && trailer !== void 0 ? trailer : null
				});
			});
		}
		let requestMetadata;
		let requestMessage = null;
		call.start({
			onReceiveMetadata(metadata) {
				requestMetadata = metadata;
				call.startRead();
			},
			onReceiveMessage(message) {
				if (requestMessage) {
					call.sendStatus({
						code: constants_1.Status.UNIMPLEMENTED,
						details: `Received a second request message for server streaming method ${handler.path}`,
						metadata: null
					});
					return;
				}
				requestMessage = message;
				call.startRead();
			},
			onReceiveHalfClose() {
				if (!requestMessage) {
					call.sendStatus({
						code: constants_1.Status.UNIMPLEMENTED,
						details: `Received no request message for server streaming method ${handler.path}`,
						metadata: null
					});
					return;
				}
				stream = new server_call_1.ServerWritableStreamImpl(handler.path, call, requestMetadata, requestMessage);
				try {
					handler.func(stream, respond);
				} catch (err) {
					call.sendStatus({
						code: constants_1.Status.UNKNOWN,
						details: `Server method handler threw error ${err.message}`,
						metadata: null
					});
				}
			},
			onCancel() {
				if (stream) {
					stream.cancelled = true;
					stream.emit("cancelled", "cancelled");
				}
			}
		});
	}
	function handleClientStreaming(call, handler) {
		let stream;
		function respond(err, value, trailer, flags) {
			if (err) {
				call.sendStatus((0, server_call_1.serverErrorToStatus)(err, trailer));
				return;
			}
			call.sendMessage(value, () => {
				call.sendStatus({
					code: constants_1.Status.OK,
					details: "OK",
					metadata: trailer !== null && trailer !== void 0 ? trailer : null
				});
			});
		}
		call.start({
			onReceiveMetadata(metadata) {
				stream = new server_call_1.ServerDuplexStreamImpl(handler.path, call, metadata);
				try {
					handler.func(stream, respond);
				} catch (err) {
					call.sendStatus({
						code: constants_1.Status.UNKNOWN,
						details: `Server method handler threw error ${err.message}`,
						metadata: null
					});
				}
			},
			onReceiveMessage(message) {
				stream.push(message);
			},
			onReceiveHalfClose() {
				stream.push(null);
			},
			onCancel() {
				if (stream) {
					stream.cancelled = true;
					stream.emit("cancelled", "cancelled");
					stream.destroy();
				}
			}
		});
	}
	function handleServerStreaming(call, handler) {
		let stream;
		let requestMetadata;
		let requestMessage = null;
		call.start({
			onReceiveMetadata(metadata) {
				requestMetadata = metadata;
				call.startRead();
			},
			onReceiveMessage(message) {
				if (requestMessage) {
					call.sendStatus({
						code: constants_1.Status.UNIMPLEMENTED,
						details: `Received a second request message for server streaming method ${handler.path}`,
						metadata: null
					});
					return;
				}
				requestMessage = message;
				call.startRead();
			},
			onReceiveHalfClose() {
				if (!requestMessage) {
					call.sendStatus({
						code: constants_1.Status.UNIMPLEMENTED,
						details: `Received no request message for server streaming method ${handler.path}`,
						metadata: null
					});
					return;
				}
				stream = new server_call_1.ServerWritableStreamImpl(handler.path, call, requestMetadata, requestMessage);
				try {
					handler.func(stream);
				} catch (err) {
					call.sendStatus({
						code: constants_1.Status.UNKNOWN,
						details: `Server method handler threw error ${err.message}`,
						metadata: null
					});
				}
			},
			onCancel() {
				if (stream) {
					stream.cancelled = true;
					stream.emit("cancelled", "cancelled");
					stream.destroy();
				}
			}
		});
	}
	function handleBidiStreaming(call, handler) {
		let stream;
		call.start({
			onReceiveMetadata(metadata) {
				stream = new server_call_1.ServerDuplexStreamImpl(handler.path, call, metadata);
				try {
					handler.func(stream);
				} catch (err) {
					call.sendStatus({
						code: constants_1.Status.UNKNOWN,
						details: `Server method handler threw error ${err.message}`,
						metadata: null
					});
				}
			},
			onReceiveMessage(message) {
				stream.push(message);
			},
			onReceiveHalfClose() {
				stream.push(null);
			},
			onCancel() {
				if (stream) {
					stream.cancelled = true;
					stream.emit("cancelled", "cancelled");
					stream.destroy();
				}
			}
		});
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/status-builder.js
var require_status_builder = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.StatusBuilder = void 0;
	/**
	* A builder for gRPC status objects.
	*/
	var StatusBuilder = class {
		constructor() {
			this.code = null;
			this.details = null;
			this.metadata = null;
		}
		/**
		* Adds a status code to the builder.
		*/
		withCode(code) {
			this.code = code;
			return this;
		}
		/**
		* Adds details to the builder.
		*/
		withDetails(details) {
			this.details = details;
			return this;
		}
		/**
		* Adds metadata to the builder.
		*/
		withMetadata(metadata) {
			this.metadata = metadata;
			return this;
		}
		/**
		* Builds the status object.
		*/
		build() {
			const status = {};
			if (this.code !== null) status.code = this.code;
			if (this.details !== null) status.details = this.details;
			if (this.metadata !== null) status.metadata = this.metadata;
			return status;
		}
	};
	exports.StatusBuilder = StatusBuilder;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/load-balancer-pick-first.js
var require_load_balancer_pick_first = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.LeafLoadBalancer = exports.PickFirstLoadBalancer = exports.PickFirstLoadBalancingConfig = void 0;
	exports.shuffled = shuffled;
	exports.setup = setup;
	const load_balancer_1 = require_load_balancer();
	const connectivity_state_1 = require_connectivity_state();
	const picker_1 = require_picker();
	const subchannel_address_1 = require_subchannel_address();
	const logging = require_logging();
	const constants_1 = require_constants();
	const subchannel_address_2 = require_subchannel_address();
	const net_1$1 = __require("net");
	const call_interface_1 = require_call_interface();
	const TRACER_NAME = "pick_first";
	function trace(text) {
		logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, text);
	}
	const TYPE_NAME = "pick_first";
	/**
	* Delay after starting a connection on a subchannel before starting a
	* connection on the next subchannel in the list, for Happy Eyeballs algorithm.
	*/
	const CONNECTION_DELAY_INTERVAL_MS = 250;
	var PickFirstLoadBalancingConfig = class PickFirstLoadBalancingConfig {
		constructor(shuffleAddressList) {
			this.shuffleAddressList = shuffleAddressList;
		}
		getLoadBalancerName() {
			return TYPE_NAME;
		}
		toJsonObject() {
			return { [TYPE_NAME]: { shuffleAddressList: this.shuffleAddressList } };
		}
		getShuffleAddressList() {
			return this.shuffleAddressList;
		}
		static createFromJson(obj) {
			if ("shuffleAddressList" in obj && !(typeof obj.shuffleAddressList === "boolean")) throw new Error("pick_first config field shuffleAddressList must be a boolean if provided");
			return new PickFirstLoadBalancingConfig(obj.shuffleAddressList === true);
		}
	};
	exports.PickFirstLoadBalancingConfig = PickFirstLoadBalancingConfig;
	/**
	* Picker for a `PickFirstLoadBalancer` in the READY state. Always returns the
	* picked subchannel.
	*/
	var PickFirstPicker = class {
		constructor(subchannel) {
			this.subchannel = subchannel;
		}
		pick(pickArgs) {
			return {
				pickResultType: picker_1.PickResultType.COMPLETE,
				subchannel: this.subchannel,
				status: null,
				onCallStarted: null,
				onCallEnded: null
			};
		}
	};
	/**
	* Return a new array with the elements of the input array in a random order
	* @param list The input array
	* @returns A shuffled array of the elements of list
	*/
	function shuffled(list) {
		const result = list.slice();
		for (let i = result.length - 1; i > 1; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			const temp = result[i];
			result[i] = result[j];
			result[j] = temp;
		}
		return result;
	}
	/**
	* Interleave addresses in addressList by family in accordance with RFC-8304 section 4
	* @param addressList
	* @returns
	*/
	function interleaveAddressFamilies(addressList) {
		if (addressList.length === 0) return [];
		const result = [];
		const ipv6Addresses = [];
		const ipv4Addresses = [];
		const ipv6First = (0, subchannel_address_2.isTcpSubchannelAddress)(addressList[0]) && (0, net_1$1.isIPv6)(addressList[0].host);
		for (const address of addressList) if ((0, subchannel_address_2.isTcpSubchannelAddress)(address) && (0, net_1$1.isIPv6)(address.host)) ipv6Addresses.push(address);
		else ipv4Addresses.push(address);
		const firstList = ipv6First ? ipv6Addresses : ipv4Addresses;
		const secondList = ipv6First ? ipv4Addresses : ipv6Addresses;
		for (let i = 0; i < Math.max(firstList.length, secondList.length); i++) {
			if (i < firstList.length) result.push(firstList[i]);
			if (i < secondList.length) result.push(secondList[i]);
		}
		return result;
	}
	const REPORT_HEALTH_STATUS_OPTION_NAME = "grpc-node.internal.pick-first.report_health_status";
	var PickFirstLoadBalancer = class {
		/**
		* Load balancer that attempts to connect to each backend in the address list
		* in order, and picks the first one that connects, using it for every
		* request.
		* @param channelControlHelper `ChannelControlHelper` instance provided by
		*     this load balancer's owner.
		*/
		constructor(channelControlHelper) {
			this.channelControlHelper = channelControlHelper;
			/**
			* The list of subchannels this load balancer is currently attempting to
			* connect to.
			*/
			this.children = [];
			/**
			* The current connectivity state of the load balancer.
			*/
			this.currentState = connectivity_state_1.ConnectivityState.IDLE;
			/**
			* The index within the `subchannels` array of the subchannel with the most
			* recently started connection attempt.
			*/
			this.currentSubchannelIndex = 0;
			/**
			* The currently picked subchannel used for making calls. Populated if
			* and only if the load balancer's current state is READY. In that case,
			* the subchannel's current state is also READY.
			*/
			this.currentPick = null;
			/**
			* Listener callback attached to each subchannel in the `subchannels` list
			* while establishing a connection.
			*/
			this.subchannelStateListener = (subchannel, previousState, newState, keepaliveTime, errorMessage) => {
				this.onSubchannelStateUpdate(subchannel, previousState, newState, errorMessage);
			};
			this.pickedSubchannelHealthListener = () => this.calculateAndReportNewState();
			/**
			* The LB policy enters sticky TRANSIENT_FAILURE mode when all
			* subchannels have failed to connect at least once, and it stays in that
			* mode until a connection attempt is successful. While in sticky TF mode,
			* the LB policy continuously attempts to connect to all of its subchannels.
			*/
			this.stickyTransientFailureMode = false;
			this.reportHealthStatus = false;
			/**
			* The most recent error reported by any subchannel as it transitioned to
			* TRANSIENT_FAILURE.
			*/
			this.lastError = null;
			this.latestAddressList = null;
			this.latestOptions = {};
			this.latestResolutionNote = "";
			this.connectionDelayTimeout = setTimeout(() => {}, 0);
			clearTimeout(this.connectionDelayTimeout);
		}
		allChildrenHaveReportedTF() {
			return this.children.every((child) => child.hasReportedTransientFailure);
		}
		resetChildrenReportedTF() {
			this.children.every((child) => child.hasReportedTransientFailure = false);
		}
		calculateAndReportNewState() {
			var _a;
			if (this.currentPick) if (this.reportHealthStatus && !this.currentPick.isHealthy()) {
				const errorMessage = `Picked subchannel ${this.currentPick.getAddress()} is unhealthy`;
				this.updateState(connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE, new picker_1.UnavailablePicker({ details: errorMessage }), errorMessage);
			} else this.updateState(connectivity_state_1.ConnectivityState.READY, new PickFirstPicker(this.currentPick), null);
			else if (((_a = this.latestAddressList) === null || _a === void 0 ? void 0 : _a.length) === 0) {
				const errorMessage = `No connection established. Last error: ${this.lastError}. Resolution note: ${this.latestResolutionNote}`;
				this.updateState(connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE, new picker_1.UnavailablePicker({ details: errorMessage }), errorMessage);
			} else if (this.children.length === 0) this.updateState(connectivity_state_1.ConnectivityState.IDLE, new picker_1.QueuePicker(this), null);
			else if (this.stickyTransientFailureMode) {
				const errorMessage = `No connection established. Last error: ${this.lastError}. Resolution note: ${this.latestResolutionNote}`;
				this.updateState(connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE, new picker_1.UnavailablePicker({ details: errorMessage }), errorMessage);
			} else this.updateState(connectivity_state_1.ConnectivityState.CONNECTING, new picker_1.QueuePicker(this), null);
		}
		requestReresolution() {
			this.channelControlHelper.requestReresolution();
		}
		maybeEnterStickyTransientFailureMode() {
			if (!this.allChildrenHaveReportedTF()) return;
			this.requestReresolution();
			this.resetChildrenReportedTF();
			if (this.stickyTransientFailureMode) {
				this.calculateAndReportNewState();
				return;
			}
			this.stickyTransientFailureMode = true;
			for (const { subchannel } of this.children) subchannel.startConnecting();
			this.calculateAndReportNewState();
		}
		removeCurrentPick() {
			if (this.currentPick !== null) {
				this.currentPick.removeConnectivityStateListener(this.subchannelStateListener);
				this.channelControlHelper.removeChannelzChild(this.currentPick.getChannelzRef());
				this.currentPick.removeHealthStateWatcher(this.pickedSubchannelHealthListener);
				this.currentPick.unref();
				this.currentPick = null;
			}
		}
		onSubchannelStateUpdate(subchannel, previousState, newState, errorMessage) {
			var _a;
			if ((_a = this.currentPick) === null || _a === void 0 ? void 0 : _a.realSubchannelEquals(subchannel)) {
				if (newState !== connectivity_state_1.ConnectivityState.READY) {
					this.removeCurrentPick();
					this.calculateAndReportNewState();
				}
				return;
			}
			for (const [index, child] of this.children.entries()) if (subchannel.realSubchannelEquals(child.subchannel)) {
				if (newState === connectivity_state_1.ConnectivityState.READY) this.pickSubchannel(child.subchannel);
				if (newState === connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE) {
					child.hasReportedTransientFailure = true;
					if (errorMessage) this.lastError = errorMessage;
					this.maybeEnterStickyTransientFailureMode();
					if (index === this.currentSubchannelIndex) this.startNextSubchannelConnecting(index + 1);
				}
				child.subchannel.startConnecting();
				return;
			}
		}
		startNextSubchannelConnecting(startIndex) {
			clearTimeout(this.connectionDelayTimeout);
			for (const [index, child] of this.children.entries()) if (index >= startIndex) {
				const subchannelState = child.subchannel.getConnectivityState();
				if (subchannelState === connectivity_state_1.ConnectivityState.IDLE || subchannelState === connectivity_state_1.ConnectivityState.CONNECTING) {
					this.startConnecting(index);
					return;
				}
			}
			this.maybeEnterStickyTransientFailureMode();
		}
		/**
		* Have a single subchannel in the `subchannels` list start connecting.
		* @param subchannelIndex The index into the `subchannels` list.
		*/
		startConnecting(subchannelIndex) {
			var _a, _b;
			clearTimeout(this.connectionDelayTimeout);
			this.currentSubchannelIndex = subchannelIndex;
			if (this.children[subchannelIndex].subchannel.getConnectivityState() === connectivity_state_1.ConnectivityState.IDLE) {
				trace("Start connecting to subchannel with address " + this.children[subchannelIndex].subchannel.getAddress());
				process.nextTick(() => {
					var _a;
					(_a = this.children[subchannelIndex]) === null || _a === void 0 || _a.subchannel.startConnecting();
				});
			}
			this.connectionDelayTimeout = setTimeout(() => {
				this.startNextSubchannelConnecting(subchannelIndex + 1);
			}, CONNECTION_DELAY_INTERVAL_MS);
			(_b = (_a = this.connectionDelayTimeout).unref) === null || _b === void 0 || _b.call(_a);
		}
		/**
		* Declare that the specified subchannel should be used to make requests.
		* This functions the same independent of whether subchannel is a member of
		* this.children and whether it is equal to this.currentPick.
		* Prerequisite: subchannel.getConnectivityState() === READY.
		* @param subchannel
		*/
		pickSubchannel(subchannel) {
			trace("Pick subchannel with address " + subchannel.getAddress());
			this.stickyTransientFailureMode = false;
			subchannel.ref();
			this.channelControlHelper.addChannelzChild(subchannel.getChannelzRef());
			this.removeCurrentPick();
			this.resetSubchannelList();
			subchannel.addConnectivityStateListener(this.subchannelStateListener);
			subchannel.addHealthStateWatcher(this.pickedSubchannelHealthListener);
			this.currentPick = subchannel;
			clearTimeout(this.connectionDelayTimeout);
			this.calculateAndReportNewState();
		}
		updateState(newState, picker, errorMessage) {
			trace(connectivity_state_1.ConnectivityState[this.currentState] + " -> " + connectivity_state_1.ConnectivityState[newState]);
			this.currentState = newState;
			this.channelControlHelper.updateState(newState, picker, errorMessage);
		}
		resetSubchannelList() {
			for (const child of this.children) {
				child.subchannel.removeConnectivityStateListener(this.subchannelStateListener);
				child.subchannel.unref();
				this.channelControlHelper.removeChannelzChild(child.subchannel.getChannelzRef());
			}
			this.currentSubchannelIndex = 0;
			this.children = [];
		}
		connectToAddressList(addressList, options) {
			trace("connectToAddressList([" + addressList.map((address) => (0, subchannel_address_1.subchannelAddressToString)(address)) + "])");
			const newChildrenList = addressList.map((address) => ({
				subchannel: this.channelControlHelper.createSubchannel(address, options),
				hasReportedTransientFailure: false
			}));
			for (const { subchannel } of newChildrenList) if (subchannel.getConnectivityState() === connectivity_state_1.ConnectivityState.READY) {
				this.pickSubchannel(subchannel);
				return;
			}
			for (const { subchannel } of newChildrenList) {
				subchannel.ref();
				this.channelControlHelper.addChannelzChild(subchannel.getChannelzRef());
			}
			this.resetSubchannelList();
			this.children = newChildrenList;
			for (const { subchannel } of this.children) subchannel.addConnectivityStateListener(this.subchannelStateListener);
			for (const child of this.children) if (child.subchannel.getConnectivityState() === connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE) child.hasReportedTransientFailure = true;
			this.startNextSubchannelConnecting(0);
			this.calculateAndReportNewState();
		}
		updateAddressList(maybeEndpointList, lbConfig, options, resolutionNote) {
			if (!(lbConfig instanceof PickFirstLoadBalancingConfig)) return false;
			if (!maybeEndpointList.ok) {
				if (this.children.length === 0 && this.currentPick === null) this.channelControlHelper.updateState(connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE, new picker_1.UnavailablePicker(maybeEndpointList.error), maybeEndpointList.error.details);
				return true;
			}
			let endpointList = maybeEndpointList.value;
			this.reportHealthStatus = options[REPORT_HEALTH_STATUS_OPTION_NAME];
			if (lbConfig.getShuffleAddressList()) endpointList = shuffled(endpointList);
			const rawAddressList = [].concat(...endpointList.map((endpoint) => endpoint.addresses));
			trace("updateAddressList([" + rawAddressList.map((address) => (0, subchannel_address_1.subchannelAddressToString)(address)) + "])");
			const addressList = interleaveAddressFamilies(rawAddressList);
			this.latestAddressList = addressList;
			this.latestOptions = options;
			this.connectToAddressList(addressList, options);
			this.latestResolutionNote = resolutionNote;
			if (rawAddressList.length > 0) return true;
			else {
				this.lastError = "No addresses resolved";
				return false;
			}
		}
		exitIdle() {
			if (this.currentState === connectivity_state_1.ConnectivityState.IDLE && this.latestAddressList) this.connectToAddressList(this.latestAddressList, this.latestOptions);
		}
		resetBackoff() {}
		destroy() {
			this.resetSubchannelList();
			this.removeCurrentPick();
		}
		getTypeName() {
			return TYPE_NAME;
		}
	};
	exports.PickFirstLoadBalancer = PickFirstLoadBalancer;
	const LEAF_CONFIG = new PickFirstLoadBalancingConfig(false);
	/**
	* This class handles the leaf load balancing operations for a single endpoint.
	* It is a thin wrapper around a PickFirstLoadBalancer with a different API
	* that more closely reflects how it will be used as a leaf balancer.
	*/
	var LeafLoadBalancer = class {
		constructor(endpoint, channelControlHelper, options, resolutionNote) {
			this.endpoint = endpoint;
			this.options = options;
			this.resolutionNote = resolutionNote;
			this.latestState = connectivity_state_1.ConnectivityState.IDLE;
			this.pickFirstBalancer = new PickFirstLoadBalancer((0, load_balancer_1.createChildChannelControlHelper)(channelControlHelper, { updateState: (connectivityState, picker, errorMessage) => {
				this.latestState = connectivityState;
				this.latestPicker = picker;
				channelControlHelper.updateState(connectivityState, picker, errorMessage);
			} }));
			this.latestPicker = new picker_1.QueuePicker(this.pickFirstBalancer);
		}
		startConnecting() {
			this.pickFirstBalancer.updateAddressList((0, call_interface_1.statusOrFromValue)([this.endpoint]), LEAF_CONFIG, Object.assign(Object.assign({}, this.options), { [REPORT_HEALTH_STATUS_OPTION_NAME]: true }), this.resolutionNote);
		}
		/**
		* Update the endpoint associated with this LeafLoadBalancer to a new
		* endpoint. Does not trigger connection establishment if a connection
		* attempt is not already in progress.
		* @param newEndpoint
		*/
		updateEndpoint(newEndpoint, newOptions) {
			this.options = newOptions;
			this.endpoint = newEndpoint;
			if (this.latestState !== connectivity_state_1.ConnectivityState.IDLE) this.startConnecting();
		}
		getConnectivityState() {
			return this.latestState;
		}
		getPicker() {
			return this.latestPicker;
		}
		getEndpoint() {
			return this.endpoint;
		}
		exitIdle() {
			this.pickFirstBalancer.exitIdle();
		}
		destroy() {
			this.pickFirstBalancer.destroy();
		}
	};
	exports.LeafLoadBalancer = LeafLoadBalancer;
	function setup() {
		(0, load_balancer_1.registerLoadBalancerType)(TYPE_NAME, PickFirstLoadBalancer, PickFirstLoadBalancingConfig);
		(0, load_balancer_1.registerDefaultLoadBalancerType)(TYPE_NAME);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/certificate-provider.js
var require_certificate_provider = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.FileWatcherCertificateProvider = void 0;
	const fs = __require("fs");
	const logging = require_logging();
	const constants_1 = require_constants();
	const util_1 = __require("util");
	const TRACER_NAME = "certificate_provider";
	function trace(text) {
		logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, text);
	}
	const readFilePromise = (0, util_1.promisify)(fs.readFile);
	var FileWatcherCertificateProvider = class {
		constructor(config) {
			this.config = config;
			this.refreshTimer = null;
			this.fileResultPromise = null;
			this.latestCaUpdate = void 0;
			this.caListeners = /* @__PURE__ */ new Set();
			this.latestIdentityUpdate = void 0;
			this.identityListeners = /* @__PURE__ */ new Set();
			this.lastUpdateTime = null;
			if (config.certificateFile === void 0 !== (config.privateKeyFile === void 0)) throw new Error("certificateFile and privateKeyFile must be set or unset together");
			if (config.certificateFile === void 0 && config.caCertificateFile === void 0) throw new Error("At least one of certificateFile and caCertificateFile must be set");
			trace("File watcher constructed with config " + JSON.stringify(config));
		}
		updateCertificates() {
			if (this.fileResultPromise) return;
			this.fileResultPromise = Promise.allSettled([
				this.config.certificateFile ? readFilePromise(this.config.certificateFile) : Promise.reject(),
				this.config.privateKeyFile ? readFilePromise(this.config.privateKeyFile) : Promise.reject(),
				this.config.caCertificateFile ? readFilePromise(this.config.caCertificateFile) : Promise.reject()
			]);
			this.fileResultPromise.then(([certificateResult, privateKeyResult, caCertificateResult]) => {
				if (!this.refreshTimer) return;
				trace("File watcher read certificates certificate " + certificateResult.status + ", privateKey " + privateKeyResult.status + ", CA certificate " + caCertificateResult.status);
				this.lastUpdateTime = /* @__PURE__ */ new Date();
				this.fileResultPromise = null;
				if (certificateResult.status === "fulfilled" && privateKeyResult.status === "fulfilled") this.latestIdentityUpdate = {
					certificate: certificateResult.value,
					privateKey: privateKeyResult.value
				};
				else this.latestIdentityUpdate = null;
				if (caCertificateResult.status === "fulfilled") this.latestCaUpdate = { caCertificate: caCertificateResult.value };
				else this.latestCaUpdate = null;
				for (const listener of this.identityListeners) listener(this.latestIdentityUpdate);
				for (const listener of this.caListeners) listener(this.latestCaUpdate);
			});
			trace("File watcher initiated certificate update");
		}
		maybeStartWatchingFiles() {
			if (!this.refreshTimer) {
				const timeSinceLastUpdate = this.lastUpdateTime ? (/* @__PURE__ */ new Date()).getTime() - this.lastUpdateTime.getTime() : Infinity;
				if (timeSinceLastUpdate > this.config.refreshIntervalMs) this.updateCertificates();
				if (timeSinceLastUpdate > this.config.refreshIntervalMs * 2) {
					this.latestCaUpdate = void 0;
					this.latestIdentityUpdate = void 0;
				}
				this.refreshTimer = setInterval(() => this.updateCertificates(), this.config.refreshIntervalMs);
				trace("File watcher started watching");
			}
		}
		maybeStopWatchingFiles() {
			if (this.caListeners.size === 0 && this.identityListeners.size === 0) {
				this.fileResultPromise = null;
				if (this.refreshTimer) {
					clearInterval(this.refreshTimer);
					this.refreshTimer = null;
				}
			}
		}
		addCaCertificateListener(listener) {
			this.caListeners.add(listener);
			this.maybeStartWatchingFiles();
			if (this.latestCaUpdate !== void 0) process.nextTick(listener, this.latestCaUpdate);
		}
		removeCaCertificateListener(listener) {
			this.caListeners.delete(listener);
			this.maybeStopWatchingFiles();
		}
		addIdentityCertificateListener(listener) {
			this.identityListeners.add(listener);
			this.maybeStartWatchingFiles();
			if (this.latestIdentityUpdate !== void 0) process.nextTick(listener, this.latestIdentityUpdate);
		}
		removeIdentityCertificateListener(listener) {
			this.identityListeners.delete(listener);
			this.maybeStopWatchingFiles();
		}
	};
	exports.FileWatcherCertificateProvider = FileWatcherCertificateProvider;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/experimental.js
var require_experimental = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.SUBCHANNEL_ARGS_EXCLUDE_KEY_PREFIX = exports.createCertificateProviderChannelCredentials = exports.FileWatcherCertificateProvider = exports.createCertificateProviderServerCredentials = exports.createServerCredentialsWithInterceptors = exports.BaseSubchannelWrapper = exports.registerAdminService = exports.FilterStackFactory = exports.BaseFilter = exports.statusOrFromError = exports.statusOrFromValue = exports.PickResultType = exports.QueuePicker = exports.UnavailablePicker = exports.ChildLoadBalancerHandler = exports.EndpointMap = exports.endpointHasAddress = exports.endpointToString = exports.subchannelAddressToString = exports.LeafLoadBalancer = exports.isLoadBalancerNameRegistered = exports.parseLoadBalancingConfig = exports.selectLbConfigFromList = exports.registerLoadBalancerType = exports.createChildChannelControlHelper = exports.BackoffTimeout = exports.parseDuration = exports.durationToMs = exports.splitHostPort = exports.uriToString = exports.CHANNEL_ARGS_CONFIG_SELECTOR_KEY = exports.createResolver = exports.registerResolver = exports.log = exports.trace = void 0;
	var logging_1 = require_logging();
	Object.defineProperty(exports, "trace", {
		enumerable: true,
		get: function() {
			return logging_1.trace;
		}
	});
	Object.defineProperty(exports, "log", {
		enumerable: true,
		get: function() {
			return logging_1.log;
		}
	});
	var resolver_1 = require_resolver();
	Object.defineProperty(exports, "registerResolver", {
		enumerable: true,
		get: function() {
			return resolver_1.registerResolver;
		}
	});
	Object.defineProperty(exports, "createResolver", {
		enumerable: true,
		get: function() {
			return resolver_1.createResolver;
		}
	});
	Object.defineProperty(exports, "CHANNEL_ARGS_CONFIG_SELECTOR_KEY", {
		enumerable: true,
		get: function() {
			return resolver_1.CHANNEL_ARGS_CONFIG_SELECTOR_KEY;
		}
	});
	var uri_parser_1 = require_uri_parser();
	Object.defineProperty(exports, "uriToString", {
		enumerable: true,
		get: function() {
			return uri_parser_1.uriToString;
		}
	});
	Object.defineProperty(exports, "splitHostPort", {
		enumerable: true,
		get: function() {
			return uri_parser_1.splitHostPort;
		}
	});
	var duration_1 = require_duration();
	Object.defineProperty(exports, "durationToMs", {
		enumerable: true,
		get: function() {
			return duration_1.durationToMs;
		}
	});
	Object.defineProperty(exports, "parseDuration", {
		enumerable: true,
		get: function() {
			return duration_1.parseDuration;
		}
	});
	var backoff_timeout_1 = require_backoff_timeout();
	Object.defineProperty(exports, "BackoffTimeout", {
		enumerable: true,
		get: function() {
			return backoff_timeout_1.BackoffTimeout;
		}
	});
	var load_balancer_1 = require_load_balancer();
	Object.defineProperty(exports, "createChildChannelControlHelper", {
		enumerable: true,
		get: function() {
			return load_balancer_1.createChildChannelControlHelper;
		}
	});
	Object.defineProperty(exports, "registerLoadBalancerType", {
		enumerable: true,
		get: function() {
			return load_balancer_1.registerLoadBalancerType;
		}
	});
	Object.defineProperty(exports, "selectLbConfigFromList", {
		enumerable: true,
		get: function() {
			return load_balancer_1.selectLbConfigFromList;
		}
	});
	Object.defineProperty(exports, "parseLoadBalancingConfig", {
		enumerable: true,
		get: function() {
			return load_balancer_1.parseLoadBalancingConfig;
		}
	});
	Object.defineProperty(exports, "isLoadBalancerNameRegistered", {
		enumerable: true,
		get: function() {
			return load_balancer_1.isLoadBalancerNameRegistered;
		}
	});
	var load_balancer_pick_first_1 = require_load_balancer_pick_first();
	Object.defineProperty(exports, "LeafLoadBalancer", {
		enumerable: true,
		get: function() {
			return load_balancer_pick_first_1.LeafLoadBalancer;
		}
	});
	var subchannel_address_1 = require_subchannel_address();
	Object.defineProperty(exports, "subchannelAddressToString", {
		enumerable: true,
		get: function() {
			return subchannel_address_1.subchannelAddressToString;
		}
	});
	Object.defineProperty(exports, "endpointToString", {
		enumerable: true,
		get: function() {
			return subchannel_address_1.endpointToString;
		}
	});
	Object.defineProperty(exports, "endpointHasAddress", {
		enumerable: true,
		get: function() {
			return subchannel_address_1.endpointHasAddress;
		}
	});
	Object.defineProperty(exports, "EndpointMap", {
		enumerable: true,
		get: function() {
			return subchannel_address_1.EndpointMap;
		}
	});
	var load_balancer_child_handler_1 = require_load_balancer_child_handler();
	Object.defineProperty(exports, "ChildLoadBalancerHandler", {
		enumerable: true,
		get: function() {
			return load_balancer_child_handler_1.ChildLoadBalancerHandler;
		}
	});
	var picker_1 = require_picker();
	Object.defineProperty(exports, "UnavailablePicker", {
		enumerable: true,
		get: function() {
			return picker_1.UnavailablePicker;
		}
	});
	Object.defineProperty(exports, "QueuePicker", {
		enumerable: true,
		get: function() {
			return picker_1.QueuePicker;
		}
	});
	Object.defineProperty(exports, "PickResultType", {
		enumerable: true,
		get: function() {
			return picker_1.PickResultType;
		}
	});
	var call_interface_1 = require_call_interface();
	Object.defineProperty(exports, "statusOrFromValue", {
		enumerable: true,
		get: function() {
			return call_interface_1.statusOrFromValue;
		}
	});
	Object.defineProperty(exports, "statusOrFromError", {
		enumerable: true,
		get: function() {
			return call_interface_1.statusOrFromError;
		}
	});
	var filter_1 = require_filter();
	Object.defineProperty(exports, "BaseFilter", {
		enumerable: true,
		get: function() {
			return filter_1.BaseFilter;
		}
	});
	var filter_stack_1 = require_filter_stack();
	Object.defineProperty(exports, "FilterStackFactory", {
		enumerable: true,
		get: function() {
			return filter_stack_1.FilterStackFactory;
		}
	});
	var admin_1 = require_admin();
	Object.defineProperty(exports, "registerAdminService", {
		enumerable: true,
		get: function() {
			return admin_1.registerAdminService;
		}
	});
	var subchannel_interface_1 = require_subchannel_interface();
	Object.defineProperty(exports, "BaseSubchannelWrapper", {
		enumerable: true,
		get: function() {
			return subchannel_interface_1.BaseSubchannelWrapper;
		}
	});
	var server_credentials_1 = require_server_credentials();
	Object.defineProperty(exports, "createServerCredentialsWithInterceptors", {
		enumerable: true,
		get: function() {
			return server_credentials_1.createServerCredentialsWithInterceptors;
		}
	});
	Object.defineProperty(exports, "createCertificateProviderServerCredentials", {
		enumerable: true,
		get: function() {
			return server_credentials_1.createCertificateProviderServerCredentials;
		}
	});
	var certificate_provider_1 = require_certificate_provider();
	Object.defineProperty(exports, "FileWatcherCertificateProvider", {
		enumerable: true,
		get: function() {
			return certificate_provider_1.FileWatcherCertificateProvider;
		}
	});
	var channel_credentials_1 = require_channel_credentials();
	Object.defineProperty(exports, "createCertificateProviderChannelCredentials", {
		enumerable: true,
		get: function() {
			return channel_credentials_1.createCertificateProviderChannelCredentials;
		}
	});
	var internal_channel_1 = require_internal_channel();
	Object.defineProperty(exports, "SUBCHANNEL_ARGS_EXCLUDE_KEY_PREFIX", {
		enumerable: true,
		get: function() {
			return internal_channel_1.SUBCHANNEL_ARGS_EXCLUDE_KEY_PREFIX;
		}
	});
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/resolver-uds.js
var require_resolver_uds = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.setup = setup;
	const resolver_1 = require_resolver();
	const call_interface_1 = require_call_interface();
	var UdsResolver = class {
		constructor(target, listener, channelOptions) {
			this.listener = listener;
			this.hasReturnedResult = false;
			this.endpoints = [];
			let path;
			if (target.authority === "") path = "/" + target.path;
			else path = target.path;
			this.endpoints = [{ addresses: [{ path }] }];
		}
		updateResolution() {
			if (!this.hasReturnedResult) {
				this.hasReturnedResult = true;
				process.nextTick(this.listener, (0, call_interface_1.statusOrFromValue)(this.endpoints), {}, null, "");
			}
		}
		destroy() {
			this.hasReturnedResult = false;
		}
		static getDefaultAuthority(target) {
			return "localhost";
		}
	};
	function setup() {
		(0, resolver_1.registerResolver)("unix", UdsResolver);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/resolver-ip.js
var require_resolver_ip = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.setup = setup;
	const net_1 = __require("net");
	const call_interface_1 = require_call_interface();
	const constants_1 = require_constants();
	const metadata_1 = require_metadata();
	const resolver_1 = require_resolver();
	const subchannel_address_1 = require_subchannel_address();
	const uri_parser_1 = require_uri_parser();
	const logging = require_logging();
	const TRACER_NAME = "ip_resolver";
	function trace(text) {
		logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, text);
	}
	const IPV4_SCHEME = "ipv4";
	const IPV6_SCHEME = "ipv6";
	/**
	* The default TCP port to connect to if not explicitly specified in the target.
	*/
	const DEFAULT_PORT = 443;
	var IpResolver = class {
		constructor(target, listener, channelOptions) {
			var _a;
			this.listener = listener;
			this.endpoints = [];
			this.error = null;
			this.hasReturnedResult = false;
			trace("Resolver constructed for target " + (0, uri_parser_1.uriToString)(target));
			const addresses = [];
			if (!(target.scheme === IPV4_SCHEME || target.scheme === IPV6_SCHEME)) {
				this.error = {
					code: constants_1.Status.UNAVAILABLE,
					details: `Unrecognized scheme ${target.scheme} in IP resolver`,
					metadata: new metadata_1.Metadata()
				};
				return;
			}
			const pathList = target.path.split(",");
			for (const path of pathList) {
				const hostPort = (0, uri_parser_1.splitHostPort)(path);
				if (hostPort === null) {
					this.error = {
						code: constants_1.Status.UNAVAILABLE,
						details: `Failed to parse ${target.scheme} address ${path}`,
						metadata: new metadata_1.Metadata()
					};
					return;
				}
				if (target.scheme === IPV4_SCHEME && !(0, net_1.isIPv4)(hostPort.host) || target.scheme === IPV6_SCHEME && !(0, net_1.isIPv6)(hostPort.host)) {
					this.error = {
						code: constants_1.Status.UNAVAILABLE,
						details: `Failed to parse ${target.scheme} address ${path}`,
						metadata: new metadata_1.Metadata()
					};
					return;
				}
				addresses.push({
					host: hostPort.host,
					port: (_a = hostPort.port) !== null && _a !== void 0 ? _a : DEFAULT_PORT
				});
			}
			this.endpoints = addresses.map((address) => ({ addresses: [address] }));
			trace("Parsed " + target.scheme + " address list " + addresses.map(subchannel_address_1.subchannelAddressToString));
		}
		updateResolution() {
			if (!this.hasReturnedResult) {
				this.hasReturnedResult = true;
				process.nextTick(() => {
					if (this.error) this.listener((0, call_interface_1.statusOrFromError)(this.error), {}, null, "");
					else this.listener((0, call_interface_1.statusOrFromValue)(this.endpoints), {}, null, "");
				});
			}
		}
		destroy() {
			this.hasReturnedResult = false;
		}
		static getDefaultAuthority(target) {
			return target.path.split(",")[0];
		}
	};
	function setup() {
		(0, resolver_1.registerResolver)(IPV4_SCHEME, IpResolver);
		(0, resolver_1.registerResolver)(IPV6_SCHEME, IpResolver);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/load-balancer-round-robin.js
var require_load_balancer_round_robin = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.RoundRobinLoadBalancer = void 0;
	exports.setup = setup;
	const load_balancer_1 = require_load_balancer();
	const connectivity_state_1 = require_connectivity_state();
	const picker_1 = require_picker();
	const logging = require_logging();
	const constants_1 = require_constants();
	const subchannel_address_1 = require_subchannel_address();
	const load_balancer_pick_first_1 = require_load_balancer_pick_first();
	const TRACER_NAME = "round_robin";
	function trace(text) {
		logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, text);
	}
	const TYPE_NAME = "round_robin";
	var RoundRobinLoadBalancingConfig = class RoundRobinLoadBalancingConfig {
		getLoadBalancerName() {
			return TYPE_NAME;
		}
		constructor() {}
		toJsonObject() {
			return { [TYPE_NAME]: {} };
		}
		static createFromJson(obj) {
			return new RoundRobinLoadBalancingConfig();
		}
	};
	var RoundRobinPicker = class {
		constructor(children, nextIndex = 0) {
			this.children = children;
			this.nextIndex = nextIndex;
		}
		pick(pickArgs) {
			const childPicker = this.children[this.nextIndex].picker;
			this.nextIndex = (this.nextIndex + 1) % this.children.length;
			return childPicker.pick(pickArgs);
		}
		/**
		* Check what the next subchannel returned would be. Used by the load
		* balancer implementation to preserve this part of the picker state if
		* possible when a subchannel connects or disconnects.
		*/
		peekNextEndpoint() {
			return this.children[this.nextIndex].endpoint;
		}
	};
	function rotateArray(list, startIndex) {
		return [...list.slice(startIndex), ...list.slice(0, startIndex)];
	}
	var RoundRobinLoadBalancer = class {
		constructor(channelControlHelper) {
			this.channelControlHelper = channelControlHelper;
			this.children = [];
			this.currentState = connectivity_state_1.ConnectivityState.IDLE;
			this.currentReadyPicker = null;
			this.updatesPaused = false;
			this.lastError = null;
			this.childChannelControlHelper = (0, load_balancer_1.createChildChannelControlHelper)(channelControlHelper, { updateState: (connectivityState, picker, errorMessage) => {
				if (this.currentState === connectivity_state_1.ConnectivityState.READY && connectivityState !== connectivity_state_1.ConnectivityState.READY) this.channelControlHelper.requestReresolution();
				if (errorMessage) this.lastError = errorMessage;
				this.calculateAndUpdateState();
			} });
		}
		countChildrenWithState(state) {
			return this.children.filter((child) => child.getConnectivityState() === state).length;
		}
		calculateAndUpdateState() {
			if (this.updatesPaused) return;
			if (this.countChildrenWithState(connectivity_state_1.ConnectivityState.READY) > 0) {
				const readyChildren = this.children.filter((child) => child.getConnectivityState() === connectivity_state_1.ConnectivityState.READY);
				let index = 0;
				if (this.currentReadyPicker !== null) {
					const nextPickedEndpoint = this.currentReadyPicker.peekNextEndpoint();
					index = readyChildren.findIndex((child) => (0, subchannel_address_1.endpointEqual)(child.getEndpoint(), nextPickedEndpoint));
					if (index < 0) index = 0;
				}
				this.updateState(connectivity_state_1.ConnectivityState.READY, new RoundRobinPicker(readyChildren.map((child) => ({
					endpoint: child.getEndpoint(),
					picker: child.getPicker()
				})), index), null);
			} else if (this.countChildrenWithState(connectivity_state_1.ConnectivityState.CONNECTING) > 0) this.updateState(connectivity_state_1.ConnectivityState.CONNECTING, new picker_1.QueuePicker(this), null);
			else if (this.countChildrenWithState(connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE) > 0) {
				const errorMessage = `round_robin: No connection established. Last error: ${this.lastError}`;
				this.updateState(connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE, new picker_1.UnavailablePicker({ details: errorMessage }), errorMessage);
			} else this.updateState(connectivity_state_1.ConnectivityState.IDLE, new picker_1.QueuePicker(this), null);
			for (const child of this.children) if (child.getConnectivityState() === connectivity_state_1.ConnectivityState.IDLE) child.exitIdle();
		}
		updateState(newState, picker, errorMessage) {
			trace(connectivity_state_1.ConnectivityState[this.currentState] + " -> " + connectivity_state_1.ConnectivityState[newState]);
			if (newState === connectivity_state_1.ConnectivityState.READY) this.currentReadyPicker = picker;
			else this.currentReadyPicker = null;
			this.currentState = newState;
			this.channelControlHelper.updateState(newState, picker, errorMessage);
		}
		resetSubchannelList() {
			for (const child of this.children) child.destroy();
			this.children = [];
		}
		updateAddressList(maybeEndpointList, lbConfig, options, resolutionNote) {
			if (!(lbConfig instanceof RoundRobinLoadBalancingConfig)) return false;
			if (!maybeEndpointList.ok) {
				if (this.children.length === 0) this.updateState(connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE, new picker_1.UnavailablePicker(maybeEndpointList.error), maybeEndpointList.error.details);
				return true;
			}
			const startIndex = Math.random() * maybeEndpointList.value.length | 0;
			const endpointList = rotateArray(maybeEndpointList.value, startIndex);
			this.resetSubchannelList();
			if (endpointList.length === 0) {
				const errorMessage = `No addresses resolved. Resolution note: ${resolutionNote}`;
				this.updateState(connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE, new picker_1.UnavailablePicker({ details: errorMessage }), errorMessage);
			}
			trace("Connect to endpoint list " + endpointList.map(subchannel_address_1.endpointToString));
			this.updatesPaused = true;
			this.children = endpointList.map((endpoint) => new load_balancer_pick_first_1.LeafLoadBalancer(endpoint, this.childChannelControlHelper, options, resolutionNote));
			for (const child of this.children) child.startConnecting();
			this.updatesPaused = false;
			this.calculateAndUpdateState();
			return true;
		}
		exitIdle() {}
		resetBackoff() {}
		destroy() {
			this.resetSubchannelList();
		}
		getTypeName() {
			return TYPE_NAME;
		}
	};
	exports.RoundRobinLoadBalancer = RoundRobinLoadBalancer;
	function setup() {
		(0, load_balancer_1.registerLoadBalancerType)(TYPE_NAME, RoundRobinLoadBalancer, RoundRobinLoadBalancingConfig);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/load-balancer-outlier-detection.js
var require_load_balancer_outlier_detection = /* @__PURE__ */ __commonJSMin(((exports) => {
	var _a;
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.OutlierDetectionLoadBalancer = exports.OutlierDetectionLoadBalancingConfig = void 0;
	exports.setup = setup;
	const connectivity_state_1 = require_connectivity_state();
	const constants_1 = require_constants();
	const duration_1 = require_duration();
	const experimental_1 = require_experimental();
	const load_balancer_1 = require_load_balancer();
	const load_balancer_child_handler_1 = require_load_balancer_child_handler();
	const picker_1 = require_picker();
	const subchannel_address_1 = require_subchannel_address();
	const subchannel_interface_1 = require_subchannel_interface();
	const logging = require_logging();
	const TRACER_NAME = "outlier_detection";
	function trace(text) {
		logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, text);
	}
	const TYPE_NAME = "outlier_detection";
	const OUTLIER_DETECTION_ENABLED = ((_a = process.env.GRPC_EXPERIMENTAL_ENABLE_OUTLIER_DETECTION) !== null && _a !== void 0 ? _a : "true") === "true";
	const defaultSuccessRateEjectionConfig = {
		stdev_factor: 1900,
		enforcement_percentage: 100,
		minimum_hosts: 5,
		request_volume: 100
	};
	const defaultFailurePercentageEjectionConfig = {
		threshold: 85,
		enforcement_percentage: 100,
		minimum_hosts: 5,
		request_volume: 50
	};
	function validateFieldType(obj, fieldName, expectedType, objectName) {
		if (fieldName in obj && obj[fieldName] !== void 0 && typeof obj[fieldName] !== expectedType) {
			const fullFieldName = objectName ? `${objectName}.${fieldName}` : fieldName;
			throw new Error(`outlier detection config ${fullFieldName} parse error: expected ${expectedType}, got ${typeof obj[fieldName]}`);
		}
	}
	function validatePositiveDuration(obj, fieldName, objectName) {
		const fullFieldName = objectName ? `${objectName}.${fieldName}` : fieldName;
		if (fieldName in obj && obj[fieldName] !== void 0) {
			if (!(0, duration_1.isDuration)(obj[fieldName])) throw new Error(`outlier detection config ${fullFieldName} parse error: expected Duration, got ${typeof obj[fieldName]}`);
			if (!(obj[fieldName].seconds >= 0 && obj[fieldName].seconds <= 315576e6 && obj[fieldName].nanos >= 0 && obj[fieldName].nanos <= 999999999)) throw new Error(`outlier detection config ${fullFieldName} parse error: values out of range for non-negative Duaration`);
		}
	}
	function validatePercentage(obj, fieldName, objectName) {
		const fullFieldName = objectName ? `${objectName}.${fieldName}` : fieldName;
		validateFieldType(obj, fieldName, "number", objectName);
		if (fieldName in obj && obj[fieldName] !== void 0 && !(obj[fieldName] >= 0 && obj[fieldName] <= 100)) throw new Error(`outlier detection config ${fullFieldName} parse error: value out of range for percentage (0-100)`);
	}
	var OutlierDetectionLoadBalancingConfig = class OutlierDetectionLoadBalancingConfig {
		constructor(intervalMs, baseEjectionTimeMs, maxEjectionTimeMs, maxEjectionPercent, successRateEjection, failurePercentageEjection, childPolicy) {
			this.childPolicy = childPolicy;
			if (childPolicy.getLoadBalancerName() === "pick_first") throw new Error("outlier_detection LB policy cannot have a pick_first child policy");
			this.intervalMs = intervalMs !== null && intervalMs !== void 0 ? intervalMs : 1e4;
			this.baseEjectionTimeMs = baseEjectionTimeMs !== null && baseEjectionTimeMs !== void 0 ? baseEjectionTimeMs : 3e4;
			this.maxEjectionTimeMs = maxEjectionTimeMs !== null && maxEjectionTimeMs !== void 0 ? maxEjectionTimeMs : 3e5;
			this.maxEjectionPercent = maxEjectionPercent !== null && maxEjectionPercent !== void 0 ? maxEjectionPercent : 10;
			this.successRateEjection = successRateEjection ? Object.assign(Object.assign({}, defaultSuccessRateEjectionConfig), successRateEjection) : null;
			this.failurePercentageEjection = failurePercentageEjection ? Object.assign(Object.assign({}, defaultFailurePercentageEjectionConfig), failurePercentageEjection) : null;
		}
		getLoadBalancerName() {
			return TYPE_NAME;
		}
		toJsonObject() {
			var _a, _b;
			return { outlier_detection: {
				interval: (0, duration_1.msToDuration)(this.intervalMs),
				base_ejection_time: (0, duration_1.msToDuration)(this.baseEjectionTimeMs),
				max_ejection_time: (0, duration_1.msToDuration)(this.maxEjectionTimeMs),
				max_ejection_percent: this.maxEjectionPercent,
				success_rate_ejection: (_a = this.successRateEjection) !== null && _a !== void 0 ? _a : void 0,
				failure_percentage_ejection: (_b = this.failurePercentageEjection) !== null && _b !== void 0 ? _b : void 0,
				child_policy: [this.childPolicy.toJsonObject()]
			} };
		}
		getIntervalMs() {
			return this.intervalMs;
		}
		getBaseEjectionTimeMs() {
			return this.baseEjectionTimeMs;
		}
		getMaxEjectionTimeMs() {
			return this.maxEjectionTimeMs;
		}
		getMaxEjectionPercent() {
			return this.maxEjectionPercent;
		}
		getSuccessRateEjectionConfig() {
			return this.successRateEjection;
		}
		getFailurePercentageEjectionConfig() {
			return this.failurePercentageEjection;
		}
		getChildPolicy() {
			return this.childPolicy;
		}
		static createFromJson(obj) {
			var _a;
			validatePositiveDuration(obj, "interval");
			validatePositiveDuration(obj, "base_ejection_time");
			validatePositiveDuration(obj, "max_ejection_time");
			validatePercentage(obj, "max_ejection_percent");
			if ("success_rate_ejection" in obj && obj.success_rate_ejection !== void 0) {
				if (typeof obj.success_rate_ejection !== "object") throw new Error("outlier detection config success_rate_ejection must be an object");
				validateFieldType(obj.success_rate_ejection, "stdev_factor", "number", "success_rate_ejection");
				validatePercentage(obj.success_rate_ejection, "enforcement_percentage", "success_rate_ejection");
				validateFieldType(obj.success_rate_ejection, "minimum_hosts", "number", "success_rate_ejection");
				validateFieldType(obj.success_rate_ejection, "request_volume", "number", "success_rate_ejection");
			}
			if ("failure_percentage_ejection" in obj && obj.failure_percentage_ejection !== void 0) {
				if (typeof obj.failure_percentage_ejection !== "object") throw new Error("outlier detection config failure_percentage_ejection must be an object");
				validatePercentage(obj.failure_percentage_ejection, "threshold", "failure_percentage_ejection");
				validatePercentage(obj.failure_percentage_ejection, "enforcement_percentage", "failure_percentage_ejection");
				validateFieldType(obj.failure_percentage_ejection, "minimum_hosts", "number", "failure_percentage_ejection");
				validateFieldType(obj.failure_percentage_ejection, "request_volume", "number", "failure_percentage_ejection");
			}
			if (!("child_policy" in obj) || !Array.isArray(obj.child_policy)) throw new Error("outlier detection config child_policy must be an array");
			const childPolicy = (0, load_balancer_1.selectLbConfigFromList)(obj.child_policy);
			if (!childPolicy) throw new Error("outlier detection config child_policy: no valid recognized policy found");
			return new OutlierDetectionLoadBalancingConfig(obj.interval ? (0, duration_1.durationToMs)(obj.interval) : null, obj.base_ejection_time ? (0, duration_1.durationToMs)(obj.base_ejection_time) : null, obj.max_ejection_time ? (0, duration_1.durationToMs)(obj.max_ejection_time) : null, (_a = obj.max_ejection_percent) !== null && _a !== void 0 ? _a : null, obj.success_rate_ejection, obj.failure_percentage_ejection, childPolicy);
		}
	};
	exports.OutlierDetectionLoadBalancingConfig = OutlierDetectionLoadBalancingConfig;
	var OutlierDetectionSubchannelWrapper = class extends subchannel_interface_1.BaseSubchannelWrapper {
		constructor(childSubchannel, mapEntry) {
			super(childSubchannel);
			this.mapEntry = mapEntry;
			this.refCount = 0;
		}
		ref() {
			this.child.ref();
			this.refCount += 1;
		}
		unref() {
			this.child.unref();
			this.refCount -= 1;
			if (this.refCount <= 0) {
				if (this.mapEntry) {
					const index = this.mapEntry.subchannelWrappers.indexOf(this);
					if (index >= 0) this.mapEntry.subchannelWrappers.splice(index, 1);
				}
			}
		}
		eject() {
			this.setHealthy(false);
		}
		uneject() {
			this.setHealthy(true);
		}
		getMapEntry() {
			return this.mapEntry;
		}
		getWrappedSubchannel() {
			return this.child;
		}
	};
	function createEmptyBucket() {
		return {
			success: 0,
			failure: 0
		};
	}
	var CallCounter = class {
		constructor() {
			this.activeBucket = createEmptyBucket();
			this.inactiveBucket = createEmptyBucket();
		}
		addSuccess() {
			this.activeBucket.success += 1;
		}
		addFailure() {
			this.activeBucket.failure += 1;
		}
		switchBuckets() {
			this.inactiveBucket = this.activeBucket;
			this.activeBucket = createEmptyBucket();
		}
		getLastSuccesses() {
			return this.inactiveBucket.success;
		}
		getLastFailures() {
			return this.inactiveBucket.failure;
		}
	};
	var OutlierDetectionPicker = class {
		constructor(wrappedPicker, countCalls) {
			this.wrappedPicker = wrappedPicker;
			this.countCalls = countCalls;
		}
		pick(pickArgs) {
			const wrappedPick = this.wrappedPicker.pick(pickArgs);
			if (wrappedPick.pickResultType === picker_1.PickResultType.COMPLETE) {
				const subchannelWrapper = wrappedPick.subchannel;
				const mapEntry = subchannelWrapper.getMapEntry();
				if (mapEntry) {
					let onCallEnded = wrappedPick.onCallEnded;
					if (this.countCalls) onCallEnded = (statusCode, details, metadata) => {
						var _a;
						if (statusCode === constants_1.Status.OK) mapEntry.counter.addSuccess();
						else mapEntry.counter.addFailure();
						(_a = wrappedPick.onCallEnded) === null || _a === void 0 || _a.call(wrappedPick, statusCode, details, metadata);
					};
					return Object.assign(Object.assign({}, wrappedPick), {
						subchannel: subchannelWrapper.getWrappedSubchannel(),
						onCallEnded
					});
				} else return Object.assign(Object.assign({}, wrappedPick), { subchannel: subchannelWrapper.getWrappedSubchannel() });
			} else return wrappedPick;
		}
	};
	var OutlierDetectionLoadBalancer = class {
		constructor(channelControlHelper) {
			this.entryMap = new subchannel_address_1.EndpointMap();
			this.latestConfig = null;
			this.timerStartTime = null;
			this.childBalancer = new load_balancer_child_handler_1.ChildLoadBalancerHandler((0, experimental_1.createChildChannelControlHelper)(channelControlHelper, {
				createSubchannel: (subchannelAddress, subchannelArgs) => {
					const originalSubchannel = channelControlHelper.createSubchannel(subchannelAddress, subchannelArgs);
					const mapEntry = this.entryMap.getForSubchannelAddress(subchannelAddress);
					const subchannelWrapper = new OutlierDetectionSubchannelWrapper(originalSubchannel, mapEntry);
					if ((mapEntry === null || mapEntry === void 0 ? void 0 : mapEntry.currentEjectionTimestamp) !== null) subchannelWrapper.eject();
					mapEntry === null || mapEntry === void 0 || mapEntry.subchannelWrappers.push(subchannelWrapper);
					return subchannelWrapper;
				},
				updateState: (connectivityState, picker, errorMessage) => {
					if (connectivityState === connectivity_state_1.ConnectivityState.READY) channelControlHelper.updateState(connectivityState, new OutlierDetectionPicker(picker, this.isCountingEnabled()), errorMessage);
					else channelControlHelper.updateState(connectivityState, picker, errorMessage);
				}
			}));
			this.ejectionTimer = setInterval(() => {}, 0);
			clearInterval(this.ejectionTimer);
		}
		isCountingEnabled() {
			return this.latestConfig !== null && (this.latestConfig.getSuccessRateEjectionConfig() !== null || this.latestConfig.getFailurePercentageEjectionConfig() !== null);
		}
		getCurrentEjectionPercent() {
			let ejectionCount = 0;
			for (const mapEntry of this.entryMap.values()) if (mapEntry.currentEjectionTimestamp !== null) ejectionCount += 1;
			return ejectionCount * 100 / this.entryMap.size;
		}
		runSuccessRateCheck(ejectionTimestamp) {
			if (!this.latestConfig) return;
			const successRateConfig = this.latestConfig.getSuccessRateEjectionConfig();
			if (!successRateConfig) return;
			trace("Running success rate check");
			const targetRequestVolume = successRateConfig.request_volume;
			let addresesWithTargetVolume = 0;
			const successRates = [];
			for (const [endpoint, mapEntry] of this.entryMap.entries()) {
				const successes = mapEntry.counter.getLastSuccesses();
				const failures = mapEntry.counter.getLastFailures();
				trace("Stats for " + (0, subchannel_address_1.endpointToString)(endpoint) + ": successes=" + successes + " failures=" + failures + " targetRequestVolume=" + targetRequestVolume);
				if (successes + failures >= targetRequestVolume) {
					addresesWithTargetVolume += 1;
					successRates.push(successes / (successes + failures));
				}
			}
			trace("Found " + addresesWithTargetVolume + " success rate candidates; currentEjectionPercent=" + this.getCurrentEjectionPercent() + " successRates=[" + successRates + "]");
			if (addresesWithTargetVolume < successRateConfig.minimum_hosts) return;
			const successRateMean = successRates.reduce((a, b) => a + b) / successRates.length;
			let successRateDeviationSum = 0;
			for (const rate of successRates) {
				const deviation = rate - successRateMean;
				successRateDeviationSum += deviation * deviation;
			}
			const successRateVariance = successRateDeviationSum / successRates.length;
			const successRateStdev = Math.sqrt(successRateVariance);
			const ejectionThreshold = successRateMean - successRateStdev * (successRateConfig.stdev_factor / 1e3);
			trace("stdev=" + successRateStdev + " ejectionThreshold=" + ejectionThreshold);
			for (const [address, mapEntry] of this.entryMap.entries()) {
				if (this.getCurrentEjectionPercent() >= this.latestConfig.getMaxEjectionPercent()) break;
				const successes = mapEntry.counter.getLastSuccesses();
				const failures = mapEntry.counter.getLastFailures();
				if (successes + failures < targetRequestVolume) continue;
				const successRate = successes / (successes + failures);
				trace("Checking candidate " + address + " successRate=" + successRate);
				if (successRate < ejectionThreshold) {
					const randomNumber = Math.random() * 100;
					trace("Candidate " + address + " randomNumber=" + randomNumber + " enforcement_percentage=" + successRateConfig.enforcement_percentage);
					if (randomNumber < successRateConfig.enforcement_percentage) {
						trace("Ejecting candidate " + address);
						this.eject(mapEntry, ejectionTimestamp);
					}
				}
			}
		}
		runFailurePercentageCheck(ejectionTimestamp) {
			if (!this.latestConfig) return;
			const failurePercentageConfig = this.latestConfig.getFailurePercentageEjectionConfig();
			if (!failurePercentageConfig) return;
			trace("Running failure percentage check. threshold=" + failurePercentageConfig.threshold + " request volume threshold=" + failurePercentageConfig.request_volume);
			let addressesWithTargetVolume = 0;
			for (const mapEntry of this.entryMap.values()) if (mapEntry.counter.getLastSuccesses() + mapEntry.counter.getLastFailures() >= failurePercentageConfig.request_volume) addressesWithTargetVolume += 1;
			if (addressesWithTargetVolume < failurePercentageConfig.minimum_hosts) return;
			for (const [address, mapEntry] of this.entryMap.entries()) {
				if (this.getCurrentEjectionPercent() >= this.latestConfig.getMaxEjectionPercent()) break;
				const successes = mapEntry.counter.getLastSuccesses();
				const failures = mapEntry.counter.getLastFailures();
				trace("Candidate successes=" + successes + " failures=" + failures);
				if (successes + failures < failurePercentageConfig.request_volume) continue;
				if (failures * 100 / (failures + successes) > failurePercentageConfig.threshold) {
					const randomNumber = Math.random() * 100;
					trace("Candidate " + address + " randomNumber=" + randomNumber + " enforcement_percentage=" + failurePercentageConfig.enforcement_percentage);
					if (randomNumber < failurePercentageConfig.enforcement_percentage) {
						trace("Ejecting candidate " + address);
						this.eject(mapEntry, ejectionTimestamp);
					}
				}
			}
		}
		eject(mapEntry, ejectionTimestamp) {
			mapEntry.currentEjectionTimestamp = /* @__PURE__ */ new Date();
			mapEntry.ejectionTimeMultiplier += 1;
			for (const subchannelWrapper of mapEntry.subchannelWrappers) subchannelWrapper.eject();
		}
		uneject(mapEntry) {
			mapEntry.currentEjectionTimestamp = null;
			for (const subchannelWrapper of mapEntry.subchannelWrappers) subchannelWrapper.uneject();
		}
		switchAllBuckets() {
			for (const mapEntry of this.entryMap.values()) mapEntry.counter.switchBuckets();
		}
		startTimer(delayMs) {
			var _a, _b;
			this.ejectionTimer = setTimeout(() => this.runChecks(), delayMs);
			(_b = (_a = this.ejectionTimer).unref) === null || _b === void 0 || _b.call(_a);
		}
		runChecks() {
			const ejectionTimestamp = /* @__PURE__ */ new Date();
			trace("Ejection timer running");
			this.switchAllBuckets();
			if (!this.latestConfig) return;
			this.timerStartTime = ejectionTimestamp;
			this.startTimer(this.latestConfig.getIntervalMs());
			this.runSuccessRateCheck(ejectionTimestamp);
			this.runFailurePercentageCheck(ejectionTimestamp);
			for (const [address, mapEntry] of this.entryMap.entries()) if (mapEntry.currentEjectionTimestamp === null) {
				if (mapEntry.ejectionTimeMultiplier > 0) mapEntry.ejectionTimeMultiplier -= 1;
			} else {
				const baseEjectionTimeMs = this.latestConfig.getBaseEjectionTimeMs();
				const maxEjectionTimeMs = this.latestConfig.getMaxEjectionTimeMs();
				const returnTime = new Date(mapEntry.currentEjectionTimestamp.getTime());
				returnTime.setMilliseconds(returnTime.getMilliseconds() + Math.min(baseEjectionTimeMs * mapEntry.ejectionTimeMultiplier, Math.max(baseEjectionTimeMs, maxEjectionTimeMs)));
				if (returnTime < /* @__PURE__ */ new Date()) {
					trace("Unejecting " + address);
					this.uneject(mapEntry);
				}
			}
		}
		updateAddressList(endpointList, lbConfig, options, resolutionNote) {
			if (!(lbConfig instanceof OutlierDetectionLoadBalancingConfig)) return false;
			trace("Received update with config: " + JSON.stringify(lbConfig.toJsonObject(), void 0, 2));
			if (endpointList.ok) {
				for (const endpoint of endpointList.value) if (!this.entryMap.has(endpoint)) {
					trace("Adding map entry for " + (0, subchannel_address_1.endpointToString)(endpoint));
					this.entryMap.set(endpoint, {
						counter: new CallCounter(),
						currentEjectionTimestamp: null,
						ejectionTimeMultiplier: 0,
						subchannelWrappers: []
					});
				}
				this.entryMap.deleteMissing(endpointList.value);
			}
			const childPolicy = lbConfig.getChildPolicy();
			this.childBalancer.updateAddressList(endpointList, childPolicy, options, resolutionNote);
			if (lbConfig.getSuccessRateEjectionConfig() || lbConfig.getFailurePercentageEjectionConfig()) if (this.timerStartTime) {
				trace("Previous timer existed. Replacing timer");
				clearTimeout(this.ejectionTimer);
				const remainingDelay = lbConfig.getIntervalMs() - ((/* @__PURE__ */ new Date()).getTime() - this.timerStartTime.getTime());
				this.startTimer(remainingDelay);
			} else {
				trace("Starting new timer");
				this.timerStartTime = /* @__PURE__ */ new Date();
				this.startTimer(lbConfig.getIntervalMs());
				this.switchAllBuckets();
			}
			else {
				trace("Counting disabled. Cancelling timer.");
				this.timerStartTime = null;
				clearTimeout(this.ejectionTimer);
				for (const mapEntry of this.entryMap.values()) {
					this.uneject(mapEntry);
					mapEntry.ejectionTimeMultiplier = 0;
				}
			}
			this.latestConfig = lbConfig;
			return true;
		}
		exitIdle() {
			this.childBalancer.exitIdle();
		}
		resetBackoff() {
			this.childBalancer.resetBackoff();
		}
		destroy() {
			clearTimeout(this.ejectionTimer);
			this.childBalancer.destroy();
		}
		getTypeName() {
			return TYPE_NAME;
		}
	};
	exports.OutlierDetectionLoadBalancer = OutlierDetectionLoadBalancer;
	function setup() {
		if (OUTLIER_DETECTION_ENABLED) (0, experimental_1.registerLoadBalancerType)(TYPE_NAME, OutlierDetectionLoadBalancer, OutlierDetectionLoadBalancingConfig);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/priority-queue.js
var require_priority_queue = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.PriorityQueue = void 0;
	const top = 0;
	const parent = (i) => Math.floor(i / 2);
	const left = (i) => i * 2 + 1;
	const right = (i) => i * 2 + 2;
	/**
	* A generic priority queue implemented as an array-based binary heap.
	* Adapted from https://stackoverflow.com/a/42919752/159388
	*/
	var PriorityQueue = class {
		/**
		*
		* @param comparator Returns true if the first argument should precede the
		*   second in the queue. Defaults to `(a, b) => a > b`
		*/
		constructor(comparator = (a, b) => a > b) {
			this.comparator = comparator;
			this.heap = [];
		}
		/**
		* @returns The number of items currently in the queue
		*/
		size() {
			return this.heap.length;
		}
		/**
		* @returns True if there are no items in the queue, false otherwise
		*/
		isEmpty() {
			return this.size() == 0;
		}
		/**
		* Look at the front item that would be popped, without modifying the contents
		* of the queue
		* @returns The front item in the queue, or undefined if the queue is empty
		*/
		peek() {
			return this.heap[top];
		}
		/**
		* Add the items to the queue
		* @param values The items to add
		* @returns The new size of the queue after adding the items
		*/
		push(...values) {
			values.forEach((value) => {
				this.heap.push(value);
				this.siftUp();
			});
			return this.size();
		}
		/**
		* Remove the front item in the queue and return it
		* @returns The front item in the queue, or undefined if the queue is empty
		*/
		pop() {
			const poppedValue = this.peek();
			const bottom = this.size() - 1;
			if (bottom > top) this.swap(top, bottom);
			this.heap.pop();
			this.siftDown();
			return poppedValue;
		}
		/**
		* Simultaneously remove the front item in the queue and add the provided
		* item.
		* @param value The item to add
		* @returns The front item in the queue, or undefined if the queue is empty
		*/
		replace(value) {
			const replacedValue = this.peek();
			this.heap[top] = value;
			this.siftDown();
			return replacedValue;
		}
		greater(i, j) {
			return this.comparator(this.heap[i], this.heap[j]);
		}
		swap(i, j) {
			[this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
		}
		siftUp() {
			let node = this.size() - 1;
			while (node > top && this.greater(node, parent(node))) {
				this.swap(node, parent(node));
				node = parent(node);
			}
		}
		siftDown() {
			let node = top;
			while (left(node) < this.size() && this.greater(left(node), node) || right(node) < this.size() && this.greater(right(node), node)) {
				let maxChild = right(node) < this.size() && this.greater(right(node), left(node)) ? right(node) : left(node);
				this.swap(node, maxChild);
				node = maxChild;
			}
		}
	};
	exports.PriorityQueue = PriorityQueue;
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/load-balancer-weighted-round-robin.js
var require_load_balancer_weighted_round_robin = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.WeightedRoundRobinLoadBalancingConfig = void 0;
	exports.setup = setup;
	const connectivity_state_1 = require_connectivity_state();
	const constants_1 = require_constants();
	const duration_1 = require_duration();
	const load_balancer_1 = require_load_balancer();
	const load_balancer_pick_first_1 = require_load_balancer_pick_first();
	const logging = require_logging();
	const orca_1 = require_orca();
	const picker_1 = require_picker();
	const priority_queue_1 = require_priority_queue();
	const subchannel_address_1 = require_subchannel_address();
	const TRACER_NAME = "weighted_round_robin";
	function trace(text) {
		logging.trace(constants_1.LogVerbosity.DEBUG, TRACER_NAME, text);
	}
	const TYPE_NAME = "weighted_round_robin";
	const DEFAULT_OOB_REPORTING_PERIOD_MS = 1e4;
	const DEFAULT_BLACKOUT_PERIOD_MS = 1e4;
	const DEFAULT_WEIGHT_EXPIRATION_PERIOD_MS = 3 * 6e4;
	const DEFAULT_WEIGHT_UPDATE_PERIOD_MS = 1e3;
	const DEFAULT_ERROR_UTILIZATION_PENALTY = 1;
	function validateFieldType(obj, fieldName, expectedType) {
		if (fieldName in obj && obj[fieldName] !== void 0 && typeof obj[fieldName] !== expectedType) throw new Error(`weighted round robin config ${fieldName} parse error: expected ${expectedType}, got ${typeof obj[fieldName]}`);
	}
	function parseDurationField(obj, fieldName) {
		if (fieldName in obj && obj[fieldName] !== void 0 && obj[fieldName] !== null) {
			let durationObject;
			if ((0, duration_1.isDuration)(obj[fieldName])) durationObject = obj[fieldName];
			else if ((0, duration_1.isDurationMessage)(obj[fieldName])) durationObject = (0, duration_1.durationMessageToDuration)(obj[fieldName]);
			else if (typeof obj[fieldName] === "string") {
				const parsedDuration = (0, duration_1.parseDuration)(obj[fieldName]);
				if (!parsedDuration) throw new Error(`weighted round robin config ${fieldName}: failed to parse duration string ${obj[fieldName]}`);
				durationObject = parsedDuration;
			} else throw new Error(`weighted round robin config ${fieldName}: expected duration, got ${typeof obj[fieldName]}`);
			return (0, duration_1.durationToMs)(durationObject);
		}
		return null;
	}
	var WeightedRoundRobinLoadBalancingConfig = class WeightedRoundRobinLoadBalancingConfig {
		constructor(enableOobLoadReport, oobLoadReportingPeriodMs, blackoutPeriodMs, weightExpirationPeriodMs, weightUpdatePeriodMs, errorUtilizationPenalty) {
			this.enableOobLoadReport = enableOobLoadReport !== null && enableOobLoadReport !== void 0 ? enableOobLoadReport : false;
			this.oobLoadReportingPeriodMs = oobLoadReportingPeriodMs !== null && oobLoadReportingPeriodMs !== void 0 ? oobLoadReportingPeriodMs : DEFAULT_OOB_REPORTING_PERIOD_MS;
			this.blackoutPeriodMs = blackoutPeriodMs !== null && blackoutPeriodMs !== void 0 ? blackoutPeriodMs : DEFAULT_BLACKOUT_PERIOD_MS;
			this.weightExpirationPeriodMs = weightExpirationPeriodMs !== null && weightExpirationPeriodMs !== void 0 ? weightExpirationPeriodMs : DEFAULT_WEIGHT_EXPIRATION_PERIOD_MS;
			this.weightUpdatePeriodMs = Math.max(weightUpdatePeriodMs !== null && weightUpdatePeriodMs !== void 0 ? weightUpdatePeriodMs : DEFAULT_WEIGHT_UPDATE_PERIOD_MS, 100);
			this.errorUtilizationPenalty = errorUtilizationPenalty !== null && errorUtilizationPenalty !== void 0 ? errorUtilizationPenalty : DEFAULT_ERROR_UTILIZATION_PENALTY;
		}
		getLoadBalancerName() {
			return TYPE_NAME;
		}
		toJsonObject() {
			return {
				enable_oob_load_report: this.enableOobLoadReport,
				oob_load_reporting_period: (0, duration_1.durationToString)((0, duration_1.msToDuration)(this.oobLoadReportingPeriodMs)),
				blackout_period: (0, duration_1.durationToString)((0, duration_1.msToDuration)(this.blackoutPeriodMs)),
				weight_expiration_period: (0, duration_1.durationToString)((0, duration_1.msToDuration)(this.weightExpirationPeriodMs)),
				weight_update_period: (0, duration_1.durationToString)((0, duration_1.msToDuration)(this.weightUpdatePeriodMs)),
				error_utilization_penalty: this.errorUtilizationPenalty
			};
		}
		static createFromJson(obj) {
			validateFieldType(obj, "enable_oob_load_report", "boolean");
			validateFieldType(obj, "error_utilization_penalty", "number");
			if (obj.error_utilization_penalty < 0) throw new Error("weighted round robin config error_utilization_penalty < 0");
			return new WeightedRoundRobinLoadBalancingConfig(obj.enable_oob_load_report, parseDurationField(obj, "oob_load_reporting_period"), parseDurationField(obj, "blackout_period"), parseDurationField(obj, "weight_expiration_period"), parseDurationField(obj, "weight_update_period"), obj.error_utilization_penalty);
		}
		getEnableOobLoadReport() {
			return this.enableOobLoadReport;
		}
		getOobLoadReportingPeriodMs() {
			return this.oobLoadReportingPeriodMs;
		}
		getBlackoutPeriodMs() {
			return this.blackoutPeriodMs;
		}
		getWeightExpirationPeriodMs() {
			return this.weightExpirationPeriodMs;
		}
		getWeightUpdatePeriodMs() {
			return this.weightUpdatePeriodMs;
		}
		getErrorUtilizationPenalty() {
			return this.errorUtilizationPenalty;
		}
	};
	exports.WeightedRoundRobinLoadBalancingConfig = WeightedRoundRobinLoadBalancingConfig;
	var WeightedRoundRobinPicker = class {
		constructor(children, metricsHandler) {
			this.metricsHandler = metricsHandler;
			this.queue = new priority_queue_1.PriorityQueue((a, b) => a.deadline < b.deadline);
			const positiveWeight = children.filter((picker) => picker.weight > 0);
			let averageWeight;
			if (positiveWeight.length < 2) averageWeight = 1;
			else {
				let weightSum = 0;
				for (const { weight } of positiveWeight) weightSum += weight;
				averageWeight = weightSum / positiveWeight.length;
			}
			for (const child of children) {
				const period = child.weight > 0 ? 1 / child.weight : averageWeight;
				this.queue.push({
					endpointName: child.endpointName,
					picker: child.picker,
					period,
					deadline: Math.random() * period
				});
			}
		}
		pick(pickArgs) {
			const entry = this.queue.pop();
			this.queue.push(Object.assign(Object.assign({}, entry), { deadline: entry.deadline + entry.period }));
			const childPick = entry.picker.pick(pickArgs);
			if (childPick.pickResultType === picker_1.PickResultType.COMPLETE) if (this.metricsHandler) return Object.assign(Object.assign({}, childPick), { onCallEnded: (0, orca_1.createMetricsReader)((loadReport) => this.metricsHandler(loadReport, entry.endpointName), childPick.onCallEnded) });
			else {
				const subchannelWrapper = childPick.subchannel;
				return Object.assign(Object.assign({}, childPick), { subchannel: subchannelWrapper.getWrappedSubchannel() });
			}
			else return childPick;
		}
	};
	var WeightedRoundRobinLoadBalancer = class {
		constructor(channelControlHelper) {
			this.channelControlHelper = channelControlHelper;
			this.latestConfig = null;
			this.children = /* @__PURE__ */ new Map();
			this.currentState = connectivity_state_1.ConnectivityState.IDLE;
			this.updatesPaused = false;
			this.lastError = null;
			this.weightUpdateTimer = null;
		}
		countChildrenWithState(state) {
			let count = 0;
			for (const entry of this.children.values()) if (entry.child.getConnectivityState() === state) count += 1;
			return count;
		}
		updateWeight(entry, loadReport) {
			var _a, _b;
			const qps = loadReport.rps_fractional;
			let utilization = loadReport.application_utilization;
			if (utilization > 0 && qps > 0) utilization += loadReport.eps / qps * ((_b = (_a = this.latestConfig) === null || _a === void 0 ? void 0 : _a.getErrorUtilizationPenalty()) !== null && _b !== void 0 ? _b : 0);
			const newWeight = utilization === 0 ? 0 : qps / utilization;
			if (newWeight === 0) return;
			const now = /* @__PURE__ */ new Date();
			if (entry.nonEmptySince === null) entry.nonEmptySince = now;
			entry.lastUpdated = now;
			entry.weight = newWeight;
		}
		getWeight(entry) {
			if (!this.latestConfig) return 0;
			const now = (/* @__PURE__ */ new Date()).getTime();
			if (now - entry.lastUpdated.getTime() >= this.latestConfig.getWeightExpirationPeriodMs()) {
				entry.nonEmptySince = null;
				return 0;
			}
			const blackoutPeriod = this.latestConfig.getBlackoutPeriodMs();
			if (blackoutPeriod > 0 && (entry.nonEmptySince === null || now - entry.nonEmptySince.getTime() < blackoutPeriod)) return 0;
			return entry.weight;
		}
		calculateAndUpdateState() {
			if (this.updatesPaused || !this.latestConfig) return;
			if (this.countChildrenWithState(connectivity_state_1.ConnectivityState.READY) > 0) {
				const weightedPickers = [];
				for (const [endpoint, entry] of this.children) {
					if (entry.child.getConnectivityState() !== connectivity_state_1.ConnectivityState.READY) continue;
					weightedPickers.push({
						endpointName: endpoint,
						picker: entry.child.getPicker(),
						weight: this.getWeight(entry)
					});
				}
				trace("Created picker with weights: " + weightedPickers.map((entry) => entry.endpointName + ":" + entry.weight).join(","));
				let metricsHandler;
				if (!this.latestConfig.getEnableOobLoadReport()) metricsHandler = (loadReport, endpointName) => {
					const childEntry = this.children.get(endpointName);
					if (childEntry) this.updateWeight(childEntry, loadReport);
				};
				else metricsHandler = null;
				this.updateState(connectivity_state_1.ConnectivityState.READY, new WeightedRoundRobinPicker(weightedPickers, metricsHandler), null);
			} else if (this.countChildrenWithState(connectivity_state_1.ConnectivityState.CONNECTING) > 0) this.updateState(connectivity_state_1.ConnectivityState.CONNECTING, new picker_1.QueuePicker(this), null);
			else if (this.countChildrenWithState(connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE) > 0) {
				const errorMessage = `weighted_round_robin: No connection established. Last error: ${this.lastError}`;
				this.updateState(connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE, new picker_1.UnavailablePicker({ details: errorMessage }), errorMessage);
			} else this.updateState(connectivity_state_1.ConnectivityState.IDLE, new picker_1.QueuePicker(this), null);
			for (const { child } of this.children.values()) if (child.getConnectivityState() === connectivity_state_1.ConnectivityState.IDLE) child.exitIdle();
		}
		updateState(newState, picker, errorMessage) {
			trace(connectivity_state_1.ConnectivityState[this.currentState] + " -> " + connectivity_state_1.ConnectivityState[newState]);
			this.currentState = newState;
			this.channelControlHelper.updateState(newState, picker, errorMessage);
		}
		updateAddressList(maybeEndpointList, lbConfig, options, resolutionNote) {
			var _a, _b;
			if (!(lbConfig instanceof WeightedRoundRobinLoadBalancingConfig)) return false;
			if (!maybeEndpointList.ok) {
				if (this.children.size === 0) this.updateState(connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE, new picker_1.UnavailablePicker(maybeEndpointList.error), maybeEndpointList.error.details);
				return true;
			}
			if (maybeEndpointList.value.length === 0) {
				const errorMessage = `No addresses resolved. Resolution note: ${resolutionNote}`;
				this.updateState(connectivity_state_1.ConnectivityState.TRANSIENT_FAILURE, new picker_1.UnavailablePicker({ details: errorMessage }), errorMessage);
				return false;
			}
			trace("Connect to endpoint list " + maybeEndpointList.value.map(subchannel_address_1.endpointToString));
			const now = /* @__PURE__ */ new Date();
			const seenEndpointNames = /* @__PURE__ */ new Set();
			this.updatesPaused = true;
			this.latestConfig = lbConfig;
			for (const endpoint of maybeEndpointList.value) {
				const name = (0, subchannel_address_1.endpointToString)(endpoint);
				seenEndpointNames.add(name);
				let entry = this.children.get(name);
				if (!entry) {
					entry = {
						child: new load_balancer_pick_first_1.LeafLoadBalancer(endpoint, (0, load_balancer_1.createChildChannelControlHelper)(this.channelControlHelper, {
							updateState: (connectivityState, picker, errorMessage) => {
								if (this.currentState === connectivity_state_1.ConnectivityState.READY && connectivityState !== connectivity_state_1.ConnectivityState.READY) this.channelControlHelper.requestReresolution();
								if (connectivityState === connectivity_state_1.ConnectivityState.READY) entry.nonEmptySince = null;
								if (errorMessage) this.lastError = errorMessage;
								this.calculateAndUpdateState();
							},
							createSubchannel: (subchannelAddress, subchannelArgs) => {
								const subchannel = this.channelControlHelper.createSubchannel(subchannelAddress, subchannelArgs);
								if (entry === null || entry === void 0 ? void 0 : entry.oobMetricsListener) return new orca_1.OrcaOobMetricsSubchannelWrapper(subchannel, entry.oobMetricsListener, this.latestConfig.getOobLoadReportingPeriodMs());
								else return subchannel;
							}
						}), options, resolutionNote),
						lastUpdated: now,
						nonEmptySince: null,
						weight: 0,
						oobMetricsListener: null
					};
					this.children.set(name, entry);
				}
				if (lbConfig.getEnableOobLoadReport()) entry.oobMetricsListener = (loadReport) => {
					this.updateWeight(entry, loadReport);
				};
				else entry.oobMetricsListener = null;
			}
			for (const [endpointName, entry] of this.children) if (seenEndpointNames.has(endpointName)) entry.child.startConnecting();
			else {
				entry.child.destroy();
				this.children.delete(endpointName);
			}
			this.updatesPaused = false;
			this.calculateAndUpdateState();
			if (this.weightUpdateTimer) clearInterval(this.weightUpdateTimer);
			this.weightUpdateTimer = (_b = (_a = setInterval(() => {
				if (this.currentState === connectivity_state_1.ConnectivityState.READY) this.calculateAndUpdateState();
			}, lbConfig.getWeightUpdatePeriodMs())).unref) === null || _b === void 0 ? void 0 : _b.call(_a);
			return true;
		}
		exitIdle() {}
		resetBackoff() {}
		destroy() {
			for (const entry of this.children.values()) entry.child.destroy();
			this.children.clear();
			if (this.weightUpdateTimer) clearInterval(this.weightUpdateTimer);
		}
		getTypeName() {
			return TYPE_NAME;
		}
	};
	function setup() {
		(0, load_balancer_1.registerLoadBalancerType)(TYPE_NAME, WeightedRoundRobinLoadBalancer, WeightedRoundRobinLoadBalancingConfig);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@grpc+grpc-js@1.14.3/node_modules/@grpc/grpc-js/build/src/index.js
var require_src = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.experimental = exports.ServerMetricRecorder = exports.ServerInterceptingCall = exports.ResponderBuilder = exports.ServerListenerBuilder = exports.addAdminServicesToServer = exports.getChannelzHandlers = exports.getChannelzServiceDefinition = exports.InterceptorConfigurationError = exports.InterceptingCall = exports.RequesterBuilder = exports.ListenerBuilder = exports.StatusBuilder = exports.getClientChannel = exports.ServerCredentials = exports.Server = exports.setLogVerbosity = exports.setLogger = exports.load = exports.loadObject = exports.CallCredentials = exports.ChannelCredentials = exports.waitForClientReady = exports.closeClient = exports.Channel = exports.makeGenericClientConstructor = exports.makeClientConstructor = exports.loadPackageDefinition = exports.Client = exports.compressionAlgorithms = exports.propagate = exports.connectivityState = exports.status = exports.logVerbosity = exports.Metadata = exports.credentials = void 0;
	const call_credentials_1 = require_call_credentials();
	Object.defineProperty(exports, "CallCredentials", {
		enumerable: true,
		get: function() {
			return call_credentials_1.CallCredentials;
		}
	});
	const channel_1 = require_channel();
	Object.defineProperty(exports, "Channel", {
		enumerable: true,
		get: function() {
			return channel_1.ChannelImplementation;
		}
	});
	const compression_algorithms_1 = require_compression_algorithms();
	Object.defineProperty(exports, "compressionAlgorithms", {
		enumerable: true,
		get: function() {
			return compression_algorithms_1.CompressionAlgorithms;
		}
	});
	const connectivity_state_1 = require_connectivity_state();
	Object.defineProperty(exports, "connectivityState", {
		enumerable: true,
		get: function() {
			return connectivity_state_1.ConnectivityState;
		}
	});
	const channel_credentials_1 = require_channel_credentials();
	Object.defineProperty(exports, "ChannelCredentials", {
		enumerable: true,
		get: function() {
			return channel_credentials_1.ChannelCredentials;
		}
	});
	const client_1 = require_client();
	Object.defineProperty(exports, "Client", {
		enumerable: true,
		get: function() {
			return client_1.Client;
		}
	});
	const constants_1 = require_constants();
	Object.defineProperty(exports, "logVerbosity", {
		enumerable: true,
		get: function() {
			return constants_1.LogVerbosity;
		}
	});
	Object.defineProperty(exports, "status", {
		enumerable: true,
		get: function() {
			return constants_1.Status;
		}
	});
	Object.defineProperty(exports, "propagate", {
		enumerable: true,
		get: function() {
			return constants_1.Propagate;
		}
	});
	const logging = require_logging();
	const make_client_1 = require_make_client();
	Object.defineProperty(exports, "loadPackageDefinition", {
		enumerable: true,
		get: function() {
			return make_client_1.loadPackageDefinition;
		}
	});
	Object.defineProperty(exports, "makeClientConstructor", {
		enumerable: true,
		get: function() {
			return make_client_1.makeClientConstructor;
		}
	});
	Object.defineProperty(exports, "makeGenericClientConstructor", {
		enumerable: true,
		get: function() {
			return make_client_1.makeClientConstructor;
		}
	});
	const metadata_1 = require_metadata();
	Object.defineProperty(exports, "Metadata", {
		enumerable: true,
		get: function() {
			return metadata_1.Metadata;
		}
	});
	const server_1 = require_server();
	Object.defineProperty(exports, "Server", {
		enumerable: true,
		get: function() {
			return server_1.Server;
		}
	});
	const server_credentials_1 = require_server_credentials();
	Object.defineProperty(exports, "ServerCredentials", {
		enumerable: true,
		get: function() {
			return server_credentials_1.ServerCredentials;
		}
	});
	const status_builder_1 = require_status_builder();
	Object.defineProperty(exports, "StatusBuilder", {
		enumerable: true,
		get: function() {
			return status_builder_1.StatusBuilder;
		}
	});
	/**** Client Credentials ****/
	exports.credentials = {
		combineChannelCredentials: (channelCredentials, ...callCredentials) => {
			return callCredentials.reduce((acc, other) => acc.compose(other), channelCredentials);
		},
		combineCallCredentials: (first, ...additional) => {
			return additional.reduce((acc, other) => acc.compose(other), first);
		},
		createInsecure: channel_credentials_1.ChannelCredentials.createInsecure,
		createSsl: channel_credentials_1.ChannelCredentials.createSsl,
		createFromSecureContext: channel_credentials_1.ChannelCredentials.createFromSecureContext,
		createFromMetadataGenerator: call_credentials_1.CallCredentials.createFromMetadataGenerator,
		createFromGoogleCredential: call_credentials_1.CallCredentials.createFromGoogleCredential,
		createEmpty: call_credentials_1.CallCredentials.createEmpty
	};
	/**
	* Close a Client object.
	* @param client The client to close.
	*/
	const closeClient = (client) => client.close();
	exports.closeClient = closeClient;
	const waitForClientReady = (client, deadline, callback) => client.waitForReady(deadline, callback);
	exports.waitForClientReady = waitForClientReady;
	/**** Unimplemented function stubs ****/
	const loadObject = (value, options) => {
		throw new Error("Not available in this library. Use @grpc/proto-loader and loadPackageDefinition instead");
	};
	exports.loadObject = loadObject;
	const load = (filename, format, options) => {
		throw new Error("Not available in this library. Use @grpc/proto-loader and loadPackageDefinition instead");
	};
	exports.load = load;
	const setLogger = (logger) => {
		logging.setLogger(logger);
	};
	exports.setLogger = setLogger;
	const setLogVerbosity = (verbosity) => {
		logging.setLoggerVerbosity(verbosity);
	};
	exports.setLogVerbosity = setLogVerbosity;
	const getClientChannel = (client) => {
		return client_1.Client.prototype.getChannel.call(client);
	};
	exports.getClientChannel = getClientChannel;
	var client_interceptors_1 = require_client_interceptors();
	Object.defineProperty(exports, "ListenerBuilder", {
		enumerable: true,
		get: function() {
			return client_interceptors_1.ListenerBuilder;
		}
	});
	Object.defineProperty(exports, "RequesterBuilder", {
		enumerable: true,
		get: function() {
			return client_interceptors_1.RequesterBuilder;
		}
	});
	Object.defineProperty(exports, "InterceptingCall", {
		enumerable: true,
		get: function() {
			return client_interceptors_1.InterceptingCall;
		}
	});
	Object.defineProperty(exports, "InterceptorConfigurationError", {
		enumerable: true,
		get: function() {
			return client_interceptors_1.InterceptorConfigurationError;
		}
	});
	var channelz_1 = require_channelz();
	Object.defineProperty(exports, "getChannelzServiceDefinition", {
		enumerable: true,
		get: function() {
			return channelz_1.getChannelzServiceDefinition;
		}
	});
	Object.defineProperty(exports, "getChannelzHandlers", {
		enumerable: true,
		get: function() {
			return channelz_1.getChannelzHandlers;
		}
	});
	var admin_1 = require_admin();
	Object.defineProperty(exports, "addAdminServicesToServer", {
		enumerable: true,
		get: function() {
			return admin_1.addAdminServicesToServer;
		}
	});
	var server_interceptors_1 = require_server_interceptors();
	Object.defineProperty(exports, "ServerListenerBuilder", {
		enumerable: true,
		get: function() {
			return server_interceptors_1.ServerListenerBuilder;
		}
	});
	Object.defineProperty(exports, "ResponderBuilder", {
		enumerable: true,
		get: function() {
			return server_interceptors_1.ResponderBuilder;
		}
	});
	Object.defineProperty(exports, "ServerInterceptingCall", {
		enumerable: true,
		get: function() {
			return server_interceptors_1.ServerInterceptingCall;
		}
	});
	var orca_1 = require_orca();
	Object.defineProperty(exports, "ServerMetricRecorder", {
		enumerable: true,
		get: function() {
			return orca_1.ServerMetricRecorder;
		}
	});
	exports.experimental = require_experimental();
	const resolver_dns = require_resolver_dns();
	const resolver_uds = require_resolver_uds();
	const resolver_ip = require_resolver_ip();
	const load_balancer_pick_first = require_load_balancer_pick_first();
	const load_balancer_round_robin = require_load_balancer_round_robin();
	const load_balancer_outlier_detection = require_load_balancer_outlier_detection();
	const load_balancer_weighted_round_robin = require_load_balancer_weighted_round_robin();
	const channelz = require_channelz();
	(() => {
		resolver_dns.setup();
		resolver_uds.setup();
		resolver_ip.setup();
		load_balancer_pick_first.setup();
		load_balancer_round_robin.setup();
		load_balancer_outlier_detection.setup();
		load_balancer_weighted_round_robin.setup();
		channelz.setup();
	})();
}));
//#endregion
export { require_api as a, require_protobufjs as c, require_source_context as i, require_lodash_camelcase as l, require_umd as n, require_descriptor as o, require_type as r, require_descriptor$1 as s, require_src as t };
