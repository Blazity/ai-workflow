import { t as __commonJSMin } from "../../_runtime.mjs";
import { t as createTokenAuth } from "../octokit__auth-token.mjs";
//#region ../../node_modules/.pnpm/universal-user-agent@7.0.3/node_modules/universal-user-agent/index.js
function getUserAgent() {
	if (typeof navigator === "object" && "userAgent" in navigator) return navigator.userAgent;
	if (typeof process === "object" && process.version !== void 0) return `Node.js/${process.version.substr(1)} (${process.platform}; ${process.arch})`;
	return "<environment undetectable>";
}
//#endregion
//#region ../../node_modules/.pnpm/before-after-hook@4.0.0/node_modules/before-after-hook/lib/register.js
function register(state, name, method, options) {
	if (typeof method !== "function") throw new Error("method for before hook must be a function");
	if (!options) options = {};
	if (Array.isArray(name)) return name.reverse().reduce((callback, name) => {
		return register.bind(null, state, name, callback, options);
	}, method)();
	return Promise.resolve().then(() => {
		if (!state.registry[name]) return method(options);
		return state.registry[name].reduce((method, registered) => {
			return registered.hook.bind(null, method, options);
		}, method)();
	});
}
//#endregion
//#region ../../node_modules/.pnpm/before-after-hook@4.0.0/node_modules/before-after-hook/lib/add.js
function addHook(state, kind, name, hook) {
	const orig = hook;
	if (!state.registry[name]) state.registry[name] = [];
	if (kind === "before") hook = (method, options) => {
		return Promise.resolve().then(orig.bind(null, options)).then(method.bind(null, options));
	};
	if (kind === "after") hook = (method, options) => {
		let result;
		return Promise.resolve().then(method.bind(null, options)).then((result_) => {
			result = result_;
			return orig(result, options);
		}).then(() => {
			return result;
		});
	};
	if (kind === "error") hook = (method, options) => {
		return Promise.resolve().then(method.bind(null, options)).catch((error) => {
			return orig(error, options);
		});
	};
	state.registry[name].push({
		hook,
		orig
	});
}
//#endregion
//#region ../../node_modules/.pnpm/before-after-hook@4.0.0/node_modules/before-after-hook/lib/remove.js
function removeHook(state, name, method) {
	if (!state.registry[name]) return;
	const index = state.registry[name].map((registered) => {
		return registered.orig;
	}).indexOf(method);
	if (index === -1) return;
	state.registry[name].splice(index, 1);
}
//#endregion
//#region ../../node_modules/.pnpm/before-after-hook@4.0.0/node_modules/before-after-hook/index.js
const bind = Function.bind;
const bindable = bind.bind(bind);
function bindApi(hook, state, name) {
	const removeHookRef = bindable(removeHook, null).apply(null, name ? [state, name] : [state]);
	hook.api = { remove: removeHookRef };
	hook.remove = removeHookRef;
	[
		"before",
		"error",
		"after",
		"wrap"
	].forEach((kind) => {
		const args = name ? [
			state,
			kind,
			name
		] : [state, kind];
		hook[kind] = hook.api[kind] = bindable(addHook, null).apply(null, args);
	});
}
function Singular() {
	const singularHookName = Symbol("Singular");
	const singularHookState = { registry: {} };
	const singularHook = register.bind(null, singularHookState, singularHookName);
	bindApi(singularHook, singularHookState, singularHookName);
	return singularHook;
}
function Collection() {
	const state = { registry: {} };
	const hook = register.bind(null, state);
	bindApi(hook, state);
	return hook;
}
var before_after_hook_default = {
	Singular,
	Collection
};
//#endregion
//#region ../../node_modules/.pnpm/@octokit+endpoint@11.0.3/node_modules/@octokit/endpoint/dist-bundle/index.js
var userAgent = `octokit-endpoint.js/0.0.0-development ${getUserAgent()}`;
var DEFAULTS = {
	method: "GET",
	baseUrl: "https://api.github.com",
	headers: {
		accept: "application/vnd.github.v3+json",
		"user-agent": userAgent
	},
	mediaType: { format: "" }
};
function lowercaseKeys(object) {
	if (!object) return {};
	return Object.keys(object).reduce((newObj, key) => {
		newObj[key.toLowerCase()] = object[key];
		return newObj;
	}, {});
}
function isPlainObject$1(value) {
	if (typeof value !== "object" || value === null) return false;
	if (Object.prototype.toString.call(value) !== "[object Object]") return false;
	const proto = Object.getPrototypeOf(value);
	if (proto === null) return true;
	const Ctor = Object.prototype.hasOwnProperty.call(proto, "constructor") && proto.constructor;
	return typeof Ctor === "function" && Ctor instanceof Ctor && Function.prototype.call(Ctor) === Function.prototype.call(value);
}
function mergeDeep(defaults, options) {
	const result = Object.assign({}, defaults);
	Object.keys(options).forEach((key) => {
		if (isPlainObject$1(options[key])) if (!(key in defaults)) Object.assign(result, { [key]: options[key] });
		else result[key] = mergeDeep(defaults[key], options[key]);
		else Object.assign(result, { [key]: options[key] });
	});
	return result;
}
function removeUndefinedProperties(obj) {
	for (const key in obj) if (obj[key] === void 0) delete obj[key];
	return obj;
}
function merge(defaults, route, options) {
	if (typeof route === "string") {
		let [method, url] = route.split(" ");
		options = Object.assign(url ? {
			method,
			url
		} : { url: method }, options);
	} else options = Object.assign({}, route);
	options.headers = lowercaseKeys(options.headers);
	removeUndefinedProperties(options);
	removeUndefinedProperties(options.headers);
	const mergedOptions = mergeDeep(defaults || {}, options);
	if (options.url === "/graphql") {
		if (defaults && defaults.mediaType.previews?.length) mergedOptions.mediaType.previews = defaults.mediaType.previews.filter((preview) => !mergedOptions.mediaType.previews.includes(preview)).concat(mergedOptions.mediaType.previews);
		mergedOptions.mediaType.previews = (mergedOptions.mediaType.previews || []).map((preview) => preview.replace(/-preview/, ""));
	}
	return mergedOptions;
}
function addQueryParameters(url, parameters) {
	const separator = /\?/.test(url) ? "&" : "?";
	const names = Object.keys(parameters);
	if (names.length === 0) return url;
	return url + separator + names.map((name) => {
		if (name === "q") return "q=" + parameters.q.split("+").map(encodeURIComponent).join("+");
		return `${name}=${encodeURIComponent(parameters[name])}`;
	}).join("&");
}
var urlVariableRegex = /\{[^{}}]+\}/g;
function removeNonChars(variableName) {
	return variableName.replace(/(?:^\W+)|(?:(?<!\W)\W+$)/g, "").split(/,/);
}
function extractUrlVariableNames(url) {
	const matches = url.match(urlVariableRegex);
	if (!matches) return [];
	return matches.map(removeNonChars).reduce((a, b) => a.concat(b), []);
}
function omit(object, keysToOmit) {
	const result = { __proto__: null };
	for (const key of Object.keys(object)) if (keysToOmit.indexOf(key) === -1) result[key] = object[key];
	return result;
}
function encodeReserved(str) {
	return str.split(/(%[0-9A-Fa-f]{2})/g).map(function(part) {
		if (!/%[0-9A-Fa-f]/.test(part)) part = encodeURI(part).replace(/%5B/g, "[").replace(/%5D/g, "]");
		return part;
	}).join("");
}
function encodeUnreserved(str) {
	return encodeURIComponent(str).replace(/[!'()*]/g, function(c) {
		return "%" + c.charCodeAt(0).toString(16).toUpperCase();
	});
}
function encodeValue(operator, value, key) {
	value = operator === "+" || operator === "#" ? encodeReserved(value) : encodeUnreserved(value);
	if (key) return encodeUnreserved(key) + "=" + value;
	else return value;
}
function isDefined(value) {
	return value !== void 0 && value !== null;
}
function isKeyOperator(operator) {
	return operator === ";" || operator === "&" || operator === "?";
}
function getValues(context, operator, key, modifier) {
	var value = context[key], result = [];
	if (isDefined(value) && value !== "") if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
		value = value.toString();
		if (modifier && modifier !== "*") value = value.substring(0, parseInt(modifier, 10));
		result.push(encodeValue(operator, value, isKeyOperator(operator) ? key : ""));
	} else if (modifier === "*") if (Array.isArray(value)) value.filter(isDefined).forEach(function(value2) {
		result.push(encodeValue(operator, value2, isKeyOperator(operator) ? key : ""));
	});
	else Object.keys(value).forEach(function(k) {
		if (isDefined(value[k])) result.push(encodeValue(operator, value[k], k));
	});
	else {
		const tmp = [];
		if (Array.isArray(value)) value.filter(isDefined).forEach(function(value2) {
			tmp.push(encodeValue(operator, value2));
		});
		else Object.keys(value).forEach(function(k) {
			if (isDefined(value[k])) {
				tmp.push(encodeUnreserved(k));
				tmp.push(encodeValue(operator, value[k].toString()));
			}
		});
		if (isKeyOperator(operator)) result.push(encodeUnreserved(key) + "=" + tmp.join(","));
		else if (tmp.length !== 0) result.push(tmp.join(","));
	}
	else if (operator === ";") {
		if (isDefined(value)) result.push(encodeUnreserved(key));
	} else if (value === "" && (operator === "&" || operator === "?")) result.push(encodeUnreserved(key) + "=");
	else if (value === "") result.push("");
	return result;
}
function parseUrl(template) {
	return { expand: expand.bind(null, template) };
}
function expand(template, context) {
	var operators = [
		"+",
		"#",
		".",
		"/",
		";",
		"?",
		"&"
	];
	template = template.replace(/\{([^\{\}]+)\}|([^\{\}]+)/g, function(_, expression, literal) {
		if (expression) {
			let operator = "";
			const values = [];
			if (operators.indexOf(expression.charAt(0)) !== -1) {
				operator = expression.charAt(0);
				expression = expression.substr(1);
			}
			expression.split(/,/g).forEach(function(variable) {
				var tmp = /([^:\*]*)(?::(\d+)|(\*))?/.exec(variable);
				values.push(getValues(context, operator, tmp[1], tmp[2] || tmp[3]));
			});
			if (operator && operator !== "+") {
				var separator = ",";
				if (operator === "?") separator = "&";
				else if (operator !== "#") separator = operator;
				return (values.length !== 0 ? operator : "") + values.join(separator);
			} else return values.join(",");
		} else return encodeReserved(literal);
	});
	if (template === "/") return template;
	else return template.replace(/\/$/, "");
}
function parse(options) {
	let method = options.method.toUpperCase();
	let url = (options.url || "/").replace(/:([a-z]\w+)/g, "{$1}");
	let headers = Object.assign({}, options.headers);
	let body;
	let parameters = omit(options, [
		"method",
		"baseUrl",
		"url",
		"headers",
		"request",
		"mediaType"
	]);
	const urlVariableNames = extractUrlVariableNames(url);
	url = parseUrl(url).expand(parameters);
	if (!/^http/.test(url)) url = options.baseUrl + url;
	const remainingParameters = omit(parameters, Object.keys(options).filter((option) => urlVariableNames.includes(option)).concat("baseUrl"));
	if (!/application\/octet-stream/i.test(headers.accept)) {
		if (options.mediaType.format) headers.accept = headers.accept.split(/,/).map((format) => format.replace(/application\/vnd(\.\w+)(\.v3)?(\.\w+)?(\+json)?$/, `application/vnd$1$2.${options.mediaType.format}`)).join(",");
		if (url.endsWith("/graphql")) {
			if (options.mediaType.previews?.length) headers.accept = (headers.accept.match(/(?<![\w-])[\w-]+(?=-preview)/g) || []).concat(options.mediaType.previews).map((preview) => {
				return `application/vnd.github.${preview}-preview${options.mediaType.format ? `.${options.mediaType.format}` : "+json"}`;
			}).join(",");
		}
	}
	if (["GET", "HEAD"].includes(method)) url = addQueryParameters(url, remainingParameters);
	else if ("data" in remainingParameters) body = remainingParameters.data;
	else if (Object.keys(remainingParameters).length) body = remainingParameters;
	if (!headers["content-type"] && typeof body !== "undefined") headers["content-type"] = "application/json; charset=utf-8";
	if (["PATCH", "PUT"].includes(method) && typeof body === "undefined") body = "";
	return Object.assign({
		method,
		url,
		headers
	}, typeof body !== "undefined" ? { body } : null, options.request ? { request: options.request } : null);
}
function endpointWithDefaults(defaults, route, options) {
	return parse(merge(defaults, route, options));
}
function withDefaults$2(oldDefaults, newDefaults) {
	const DEFAULTS2 = merge(oldDefaults, newDefaults);
	const endpoint2 = endpointWithDefaults.bind(null, DEFAULTS2);
	return Object.assign(endpoint2, {
		DEFAULTS: DEFAULTS2,
		defaults: withDefaults$2.bind(null, DEFAULTS2),
		merge: merge.bind(null, DEFAULTS2),
		parse
	});
}
var endpoint = withDefaults$2(null, DEFAULTS);
//#endregion
//#region ../../node_modules/.pnpm/fast-content-type-parse@3.0.0/node_modules/fast-content-type-parse/index.js
var require_fast_content_type_parse = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const NullObject = function NullObject() {};
	NullObject.prototype = Object.create(null);
	/**
	* RegExp to match *( ";" parameter ) in RFC 7231 sec 3.1.1.1
	*
	* parameter     = token "=" ( token / quoted-string )
	* token         = 1*tchar
	* tchar         = "!" / "#" / "$" / "%" / "&" / "'" / "*"
	*               / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~"
	*               / DIGIT / ALPHA
	*               ; any VCHAR, except delimiters
	* quoted-string = DQUOTE *( qdtext / quoted-pair ) DQUOTE
	* qdtext        = HTAB / SP / %x21 / %x23-5B / %x5D-7E / obs-text
	* obs-text      = %x80-FF
	* quoted-pair   = "\" ( HTAB / SP / VCHAR / obs-text )
	*/
	const paramRE = /; *([!#$%&'*+.^\w`|~-]+)=("(?:[\v\u0020\u0021\u0023-\u005b\u005d-\u007e\u0080-\u00ff]|\\[\v\u0020-\u00ff])*"|[!#$%&'*+.^\w`|~-]+) */gu;
	/**
	* RegExp to match quoted-pair in RFC 7230 sec 3.2.6
	*
	* quoted-pair = "\" ( HTAB / SP / VCHAR / obs-text )
	* obs-text    = %x80-FF
	*/
	const quotedPairRE = /\\([\v\u0020-\u00ff])/gu;
	/**
	* RegExp to match type in RFC 7231 sec 3.1.1.1
	*
	* media-type = type "/" subtype
	* type       = token
	* subtype    = token
	*/
	const mediaTypeRE = /^[!#$%&'*+.^\w|~-]+\/[!#$%&'*+.^\w|~-]+$/u;
	const defaultContentType = {
		type: "",
		parameters: new NullObject()
	};
	Object.freeze(defaultContentType.parameters);
	Object.freeze(defaultContentType);
	/**
	* Parse media type to object.
	*
	* @param {string|object} header
	* @return {Object}
	* @public
	*/
	function parse(header) {
		if (typeof header !== "string") throw new TypeError("argument header is required and must be a string");
		let index = header.indexOf(";");
		const type = index !== -1 ? header.slice(0, index).trim() : header.trim();
		if (mediaTypeRE.test(type) === false) throw new TypeError("invalid media type");
		const result = {
			type: type.toLowerCase(),
			parameters: new NullObject()
		};
		if (index === -1) return result;
		let key;
		let match;
		let value;
		paramRE.lastIndex = index;
		while (match = paramRE.exec(header)) {
			if (match.index !== index) throw new TypeError("invalid parameter format");
			index += match[0].length;
			key = match[1].toLowerCase();
			value = match[2];
			if (value[0] === "\"") {
				value = value.slice(1, value.length - 1);
				quotedPairRE.test(value) && (value = value.replace(quotedPairRE, "$1"));
			}
			result.parameters[key] = value;
		}
		if (index !== header.length) throw new TypeError("invalid parameter format");
		return result;
	}
	function safeParse(header) {
		if (typeof header !== "string") return defaultContentType;
		let index = header.indexOf(";");
		const type = index !== -1 ? header.slice(0, index).trim() : header.trim();
		if (mediaTypeRE.test(type) === false) return defaultContentType;
		const result = {
			type: type.toLowerCase(),
			parameters: new NullObject()
		};
		if (index === -1) return result;
		let key;
		let match;
		let value;
		paramRE.lastIndex = index;
		while (match = paramRE.exec(header)) {
			if (match.index !== index) return defaultContentType;
			index += match[0].length;
			key = match[1].toLowerCase();
			value = match[2];
			if (value[0] === "\"") {
				value = value.slice(1, value.length - 1);
				quotedPairRE.test(value) && (value = value.replace(quotedPairRE, "$1"));
			}
			result.parameters[key] = value;
		}
		if (index !== header.length) return defaultContentType;
		return result;
	}
	module.exports.default = {
		parse,
		safeParse
	};
	module.exports.parse = parse;
	module.exports.safeParse = safeParse;
	module.exports.defaultContentType = defaultContentType;
}));
//#endregion
//#region ../../node_modules/.pnpm/json-with-bigint@3.5.7/node_modules/json-with-bigint/json-with-bigint.js
const intRegex = /^-?\d+$/;
const noiseValue = /^-?\d+n+$/;
const originalStringify = JSON.stringify;
const originalParse = JSON.parse;
const customFormat = /^-?\d+n$/;
const bigIntsStringify = /([\[:])?"(-?\d+)n"($|([\\n]|\s)*(\s|[\\n])*[,\}\]])/g;
const noiseStringify = /([\[:])?("-?\d+n+)n("$|"([\\n]|\s)*(\s|[\\n])*[,\}\]])/g;
/** @typedef {(key: string, value: any, context?: { source: string }) => any} Reviver */
/**
* Function to serialize value to a JSON string.
* Converts BigInt values to a custom format (strings with digits and "n" at the end) and then converts them to proper big integers in a JSON string.
* @param {*} value - The value to convert to a JSON string.
* @param {(Function|Array<string>|null)} [replacer] - A function that alters the behavior of the stringification process, or an array of strings to indicate properties to exclude.
* @param {(string|number)} [space] - A string or number to specify indentation or pretty-printing.
* @returns {string} The JSON string representation.
*/
const JSONStringify = (value, replacer, space) => {
	if ("rawJSON" in JSON) return originalStringify(value, (key, value) => {
		if (typeof value === "bigint") return JSON.rawJSON(value.toString());
		if (typeof replacer === "function") return replacer(key, value);
		if (Array.isArray(replacer) && replacer.includes(key)) return value;
		return value;
	}, space);
	if (!value) return originalStringify(value, replacer, space);
	return originalStringify(value, (key, value) => {
		if (typeof value === "string" && Boolean(value.match(noiseValue))) return value.toString() + "n";
		if (typeof value === "bigint") return value.toString() + "n";
		if (typeof replacer === "function") return replacer(key, value);
		if (Array.isArray(replacer) && replacer.includes(key)) return value;
		return value;
	}, space).replace(bigIntsStringify, "$1$2$3").replace(noiseStringify, "$1$2$3");
};
/**
* Support for JSON.parse's context.source feature detection.
* @type {boolean}
*/
const isContextSourceSupported = () => JSON.parse("1", (_, __, context) => !!context && context.source === "1");
/**
* Convert marked big numbers to BigInt
* @type {Reviver}
*/
const convertMarkedBigIntsReviver = (key, value, context, userReviver) => {
	if (typeof value === "string" && value.match(customFormat)) return BigInt(value.slice(0, -1));
	if (typeof value === "string" && value.match(noiseValue)) return value.slice(0, -1);
	if (typeof userReviver !== "function") return value;
	return userReviver(key, value, context);
};
/**
* Faster (2x) and simpler function to parse JSON.
* Based on JSON.parse's context.source feature, which is not universally available now.
* Does not support the legacy custom format, used in the first version of this library.
*/
const JSONParseV2 = (text, reviver) => {
	return JSON.parse(text, (key, value, context) => {
		const isBigNumber = typeof value === "number" && (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER);
		const isInt = context && intRegex.test(context.source);
		if (isBigNumber && isInt) return BigInt(context.source);
		if (typeof reviver !== "function") return value;
		return reviver(key, value, context);
	});
};
const MAX_INT = Number.MAX_SAFE_INTEGER.toString();
const MAX_DIGITS = MAX_INT.length;
const stringsOrLargeNumbers = /"(?:\\.|[^"])*"|-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/g;
const noiseValueWithQuotes = /^"-?\d+n+"$/;
/**
* Function to parse JSON.
* If JSON has number values greater than Number.MAX_SAFE_INTEGER, we convert those values to a custom format, then parse them to BigInt values.
* Other types of values are not affected and parsed as native JSON.parse() would parse them.
*/
const JSONParse = (text, reviver) => {
	if (!text) return originalParse(text, reviver);
	if (isContextSourceSupported()) return JSONParseV2(text, reviver);
	return originalParse(text.replace(stringsOrLargeNumbers, (text, digits, fractional, exponential) => {
		const isString = text[0] === "\"";
		if (isString && Boolean(text.match(noiseValueWithQuotes))) return text.substring(0, text.length - 1) + "n\"";
		const isFractionalOrExponential = fractional || exponential;
		const isLessThanMaxSafeInt = digits && (digits.length < MAX_DIGITS || digits.length === MAX_DIGITS && digits <= MAX_INT);
		if (isString || isFractionalOrExponential || isLessThanMaxSafeInt) return text;
		return "\"" + text + "n\"";
	}), (key, value, context) => convertMarkedBigIntsReviver(key, value, context, reviver));
};
//#endregion
//#region ../../node_modules/.pnpm/@octokit+request-error@7.1.0/node_modules/@octokit/request-error/dist-src/index.js
var RequestError = class extends Error {
	name;
	/**
	* http status code
	*/
	status;
	/**
	* Request options that lead to the error.
	*/
	request;
	/**
	* Response object if a response was received
	*/
	response;
	constructor(message, statusCode, options) {
		super(message, { cause: options.cause });
		this.name = "HttpError";
		this.status = Number.parseInt(statusCode);
		if (Number.isNaN(this.status)) this.status = 0;
		/* v8 ignore else -- @preserve -- Bug with vitest coverage where it sees an else branch that doesn't exist */
		if ("response" in options) this.response = options.response;
		const requestCopy = Object.assign({}, options.request);
		if (options.request.headers.authorization) requestCopy.headers = Object.assign({}, options.request.headers, { authorization: options.request.headers.authorization.replace(/(?<! ) .*$/, " [REDACTED]") });
		requestCopy.url = requestCopy.url.replace(/\bclient_secret=\w+/g, "client_secret=[REDACTED]").replace(/\baccess_token=\w+/g, "access_token=[REDACTED]");
		this.request = requestCopy;
	}
};
//#endregion
//#region ../../node_modules/.pnpm/@octokit+request@10.0.8/node_modules/@octokit/request/dist-bundle/index.js
var import_fast_content_type_parse = require_fast_content_type_parse();
var VERSION$1 = "10.0.8";
var defaults_default = { headers: { "user-agent": `octokit-request.js/${VERSION$1} ${getUserAgent()}` } };
function isPlainObject(value) {
	if (typeof value !== "object" || value === null) return false;
	if (Object.prototype.toString.call(value) !== "[object Object]") return false;
	const proto = Object.getPrototypeOf(value);
	if (proto === null) return true;
	const Ctor = Object.prototype.hasOwnProperty.call(proto, "constructor") && proto.constructor;
	return typeof Ctor === "function" && Ctor instanceof Ctor && Function.prototype.call(Ctor) === Function.prototype.call(value);
}
var noop$1 = () => "";
async function fetchWrapper(requestOptions) {
	const fetch = requestOptions.request?.fetch || globalThis.fetch;
	if (!fetch) throw new Error("fetch is not set. Please pass a fetch implementation as new Octokit({ request: { fetch }}). Learn more at https://github.com/octokit/octokit.js/#fetch-missing");
	const log = requestOptions.request?.log || console;
	const parseSuccessResponseBody = requestOptions.request?.parseSuccessResponseBody !== false;
	const body = isPlainObject(requestOptions.body) || Array.isArray(requestOptions.body) ? JSONStringify(requestOptions.body) : requestOptions.body;
	const requestHeaders = Object.fromEntries(Object.entries(requestOptions.headers).map(([name, value]) => [name, String(value)]));
	let fetchResponse;
	try {
		fetchResponse = await fetch(requestOptions.url, {
			method: requestOptions.method,
			body,
			redirect: requestOptions.request?.redirect,
			headers: requestHeaders,
			signal: requestOptions.request?.signal,
			...requestOptions.body && { duplex: "half" }
		});
	} catch (error) {
		let message = "Unknown Error";
		if (error instanceof Error) {
			if (error.name === "AbortError") {
				error.status = 500;
				throw error;
			}
			message = error.message;
			if (error.name === "TypeError" && "cause" in error) {
				if (error.cause instanceof Error) message = error.cause.message;
				else if (typeof error.cause === "string") message = error.cause;
			}
		}
		const requestError = new RequestError(message, 500, { request: requestOptions });
		requestError.cause = error;
		throw requestError;
	}
	const status = fetchResponse.status;
	const url = fetchResponse.url;
	const responseHeaders = {};
	for (const [key, value] of fetchResponse.headers) responseHeaders[key] = value;
	const octokitResponse = {
		url,
		status,
		headers: responseHeaders,
		data: ""
	};
	if ("deprecation" in responseHeaders) {
		const matches = responseHeaders.link && responseHeaders.link.match(/<([^<>]+)>; rel="deprecation"/);
		const deprecationLink = matches && matches.pop();
		log.warn(`[@octokit/request] "${requestOptions.method} ${requestOptions.url}" is deprecated. It is scheduled to be removed on ${responseHeaders.sunset}${deprecationLink ? `. See ${deprecationLink}` : ""}`);
	}
	if (status === 204 || status === 205) return octokitResponse;
	if (requestOptions.method === "HEAD") {
		if (status < 400) return octokitResponse;
		throw new RequestError(fetchResponse.statusText, status, {
			response: octokitResponse,
			request: requestOptions
		});
	}
	if (status === 304) {
		octokitResponse.data = await getResponseData(fetchResponse);
		throw new RequestError("Not modified", status, {
			response: octokitResponse,
			request: requestOptions
		});
	}
	if (status >= 400) {
		octokitResponse.data = await getResponseData(fetchResponse);
		throw new RequestError(toErrorMessage(octokitResponse.data), status, {
			response: octokitResponse,
			request: requestOptions
		});
	}
	octokitResponse.data = parseSuccessResponseBody ? await getResponseData(fetchResponse) : fetchResponse.body;
	return octokitResponse;
}
async function getResponseData(response) {
	const contentType = response.headers.get("content-type");
	if (!contentType) return response.text().catch(noop$1);
	const mimetype = (0, import_fast_content_type_parse.safeParse)(contentType);
	if (isJSONResponse(mimetype)) {
		let text = "";
		try {
			text = await response.text();
			return JSONParse(text);
		} catch (err) {
			return text;
		}
	} else if (mimetype.type.startsWith("text/") || mimetype.parameters.charset?.toLowerCase() === "utf-8") return response.text().catch(noop$1);
	else return response.arrayBuffer().catch(
		/* v8 ignore next -- @preserve */
		() => /* @__PURE__ */ new ArrayBuffer(0)
	);
}
function isJSONResponse(mimetype) {
	return mimetype.type === "application/json" || mimetype.type === "application/scim+json";
}
function toErrorMessage(data) {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return "Unknown error";
	if ("message" in data) {
		const suffix = "documentation_url" in data ? ` - ${data.documentation_url}` : "";
		return Array.isArray(data.errors) ? `${data.message}: ${data.errors.map((v) => JSON.stringify(v)).join(", ")}${suffix}` : `${data.message}${suffix}`;
	}
	return `Unknown error: ${JSON.stringify(data)}`;
}
function withDefaults$1(oldEndpoint, newDefaults) {
	const endpoint2 = oldEndpoint.defaults(newDefaults);
	const newApi = function(route, parameters) {
		const endpointOptions = endpoint2.merge(route, parameters);
		if (!endpointOptions.request || !endpointOptions.request.hook) return fetchWrapper(endpoint2.parse(endpointOptions));
		const request2 = (route2, parameters2) => {
			return fetchWrapper(endpoint2.parse(endpoint2.merge(route2, parameters2)));
		};
		Object.assign(request2, {
			endpoint: endpoint2,
			defaults: withDefaults$1.bind(null, endpoint2)
		});
		return endpointOptions.request.hook(request2, endpointOptions);
	};
	return Object.assign(newApi, {
		endpoint: endpoint2,
		defaults: withDefaults$1.bind(null, endpoint2)
	});
}
var request = withDefaults$1(endpoint, defaults_default);
/* v8 ignore next -- @preserve */
/* v8 ignore else -- @preserve */
//#endregion
//#region ../../node_modules/.pnpm/@octokit+graphql@9.0.3/node_modules/@octokit/graphql/dist-bundle/index.js
var VERSION = "0.0.0-development";
function _buildMessageForResponseErrors(data) {
	return `Request failed due to following response errors:
` + data.errors.map((e) => ` - ${e.message}`).join("\n");
}
var GraphqlResponseError = class extends Error {
	constructor(request2, headers, response) {
		super(_buildMessageForResponseErrors(response));
		this.request = request2;
		this.headers = headers;
		this.response = response;
		this.errors = response.errors;
		this.data = response.data;
		if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
	}
	name = "GraphqlResponseError";
	errors;
	data;
};
var NON_VARIABLE_OPTIONS = [
	"method",
	"baseUrl",
	"url",
	"headers",
	"request",
	"query",
	"mediaType",
	"operationName"
];
var FORBIDDEN_VARIABLE_OPTIONS = [
	"query",
	"method",
	"url"
];
var GHES_V3_SUFFIX_REGEX = /\/api\/v3\/?$/;
function graphql(request2, query, options) {
	if (options) {
		if (typeof query === "string" && "query" in options) return Promise.reject(/* @__PURE__ */ new Error(`[@octokit/graphql] "query" cannot be used as variable name`));
		for (const key in options) {
			if (!FORBIDDEN_VARIABLE_OPTIONS.includes(key)) continue;
			return Promise.reject(/* @__PURE__ */ new Error(`[@octokit/graphql] "${key}" cannot be used as variable name`));
		}
	}
	const parsedOptions = typeof query === "string" ? Object.assign({ query }, options) : query;
	const requestOptions = Object.keys(parsedOptions).reduce((result, key) => {
		if (NON_VARIABLE_OPTIONS.includes(key)) {
			result[key] = parsedOptions[key];
			return result;
		}
		if (!result.variables) result.variables = {};
		result.variables[key] = parsedOptions[key];
		return result;
	}, {});
	const baseUrl = parsedOptions.baseUrl || request2.endpoint.DEFAULTS.baseUrl;
	if (GHES_V3_SUFFIX_REGEX.test(baseUrl)) requestOptions.url = baseUrl.replace(GHES_V3_SUFFIX_REGEX, "/api/graphql");
	return request2(requestOptions).then((response) => {
		if (response.data.errors) {
			const headers = {};
			for (const key of Object.keys(response.headers)) headers[key] = response.headers[key];
			throw new GraphqlResponseError(requestOptions, headers, response.data);
		}
		return response.data.data;
	});
}
function withDefaults(request2, newDefaults) {
	const newRequest = request2.defaults(newDefaults);
	const newApi = (query, options) => {
		return graphql(newRequest, query, options);
	};
	return Object.assign(newApi, {
		defaults: withDefaults.bind(null, newRequest),
		endpoint: newRequest.endpoint
	});
}
withDefaults(request, {
	headers: { "user-agent": `octokit-graphql.js/${VERSION} ${getUserAgent()}` },
	method: "POST",
	url: "/graphql"
});
function withCustomRequest(customRequest) {
	return withDefaults(customRequest, {
		method: "POST",
		url: "/graphql"
	});
}
//#endregion
//#region ../../node_modules/.pnpm/@octokit+core@7.0.6/node_modules/@octokit/core/dist-src/index.js
const noop = () => {};
const consoleWarn = console.warn.bind(console);
const consoleError = console.error.bind(console);
function createLogger(logger = {}) {
	if (typeof logger.debug !== "function") logger.debug = noop;
	if (typeof logger.info !== "function") logger.info = noop;
	if (typeof logger.warn !== "function") logger.warn = consoleWarn;
	if (typeof logger.error !== "function") logger.error = consoleError;
	return logger;
}
const userAgentTrail = `octokit-core.js/7.0.6 ${getUserAgent()}`;
var Octokit = class {
	static VERSION = "7.0.6";
	static defaults(defaults) {
		const OctokitWithDefaults = class extends this {
			constructor(...args) {
				const options = args[0] || {};
				if (typeof defaults === "function") {
					super(defaults(options));
					return;
				}
				super(Object.assign({}, defaults, options, options.userAgent && defaults.userAgent ? { userAgent: `${options.userAgent} ${defaults.userAgent}` } : null));
			}
		};
		return OctokitWithDefaults;
	}
	static plugins = [];
	/**
	* Attach a plugin (or many) to your Octokit instance.
	*
	* @example
	* const API = Octokit.plugin(plugin1, plugin2, plugin3, ...)
	*/
	static plugin(...newPlugins) {
		const currentPlugins = this.plugins;
		const NewOctokit = class extends this {
			static plugins = currentPlugins.concat(newPlugins.filter((plugin) => !currentPlugins.includes(plugin)));
		};
		return NewOctokit;
	}
	constructor(options = {}) {
		const hook = new before_after_hook_default.Collection();
		const requestDefaults = {
			baseUrl: request.endpoint.DEFAULTS.baseUrl,
			headers: {},
			request: Object.assign({}, options.request, { hook: hook.bind(null, "request") }),
			mediaType: {
				previews: [],
				format: ""
			}
		};
		requestDefaults.headers["user-agent"] = options.userAgent ? `${options.userAgent} ${userAgentTrail}` : userAgentTrail;
		if (options.baseUrl) requestDefaults.baseUrl = options.baseUrl;
		if (options.previews) requestDefaults.mediaType.previews = options.previews;
		if (options.timeZone) requestDefaults.headers["time-zone"] = options.timeZone;
		this.request = request.defaults(requestDefaults);
		this.graphql = withCustomRequest(this.request).defaults(requestDefaults);
		this.log = createLogger(options.log);
		this.hook = hook;
		if (!options.authStrategy) if (!options.auth) this.auth = async () => ({ type: "unauthenticated" });
		else {
			const auth = createTokenAuth(options.auth);
			hook.wrap("request", auth.hook);
			this.auth = auth;
		}
		else {
			const { authStrategy, ...otherOptions } = options;
			const auth = authStrategy(Object.assign({
				request: this.request,
				log: this.log,
				octokit: this,
				octokitOptions: otherOptions
			}, options.auth));
			hook.wrap("request", auth.hook);
			this.auth = auth;
		}
		const classConstructor = this.constructor;
		for (let i = 0; i < classConstructor.plugins.length; ++i) Object.assign(this, classConstructor.plugins[i](this, options));
	}
	request;
	graphql;
	log;
	hook;
	auth;
};
//#endregion
export { Octokit as t };
