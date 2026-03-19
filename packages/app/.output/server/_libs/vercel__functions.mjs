import { t as __commonJSMin } from "../_runtime.mjs";
//#region ../../node_modules/.pnpm/@vercel+functions@3.4.3_@aws-sdk+credential-provider-web-identity@3.972.13/node_modules/@vercel/functions/headers.js
var require_headers = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var headers_exports = {};
	__export(headers_exports, {
		CITY_HEADER_NAME: () => CITY_HEADER_NAME,
		COUNTRY_HEADER_NAME: () => COUNTRY_HEADER_NAME,
		EMOJI_FLAG_UNICODE_STARTING_POSITION: () => EMOJI_FLAG_UNICODE_STARTING_POSITION,
		IP_HEADER_NAME: () => IP_HEADER_NAME,
		LATITUDE_HEADER_NAME: () => LATITUDE_HEADER_NAME,
		LONGITUDE_HEADER_NAME: () => LONGITUDE_HEADER_NAME,
		POSTAL_CODE_HEADER_NAME: () => POSTAL_CODE_HEADER_NAME,
		REGION_HEADER_NAME: () => REGION_HEADER_NAME,
		REQUEST_ID_HEADER_NAME: () => REQUEST_ID_HEADER_NAME,
		geolocation: () => geolocation,
		ipAddress: () => ipAddress
	});
	module.exports = __toCommonJS(headers_exports);
	const CITY_HEADER_NAME = "x-vercel-ip-city";
	const COUNTRY_HEADER_NAME = "x-vercel-ip-country";
	const IP_HEADER_NAME = "x-real-ip";
	const LATITUDE_HEADER_NAME = "x-vercel-ip-latitude";
	const LONGITUDE_HEADER_NAME = "x-vercel-ip-longitude";
	const REGION_HEADER_NAME = "x-vercel-ip-country-region";
	const POSTAL_CODE_HEADER_NAME = "x-vercel-ip-postal-code";
	const REQUEST_ID_HEADER_NAME = "x-vercel-id";
	const EMOJI_FLAG_UNICODE_STARTING_POSITION = 127397;
	function getHeader(headers, key) {
		return headers.get(key) ?? void 0;
	}
	function getHeaderWithDecode(request, key) {
		const header = getHeader(request.headers, key);
		return header ? decodeURIComponent(header) : void 0;
	}
	function getFlag(countryCode) {
		const regex = (/* @__PURE__ */ new RegExp("^[A-Z]{2}$")).test(countryCode);
		if (!countryCode || !regex) return void 0;
		return String.fromCodePoint(...countryCode.split("").map((char) => EMOJI_FLAG_UNICODE_STARTING_POSITION + char.charCodeAt(0)));
	}
	function ipAddress(input) {
		return getHeader("headers" in input ? input.headers : input, IP_HEADER_NAME);
	}
	function getRegionFromRequestId(requestId) {
		if (!requestId) return "dev1";
		return requestId.split(":")[0];
	}
	function geolocation(request) {
		return {
			city: getHeaderWithDecode(request, CITY_HEADER_NAME),
			country: getHeader(request.headers, COUNTRY_HEADER_NAME),
			flag: getFlag(getHeader(request.headers, COUNTRY_HEADER_NAME)),
			countryRegion: getHeader(request.headers, REGION_HEADER_NAME),
			region: getRegionFromRequestId(getHeader(request.headers, REQUEST_ID_HEADER_NAME)),
			latitude: getHeader(request.headers, LATITUDE_HEADER_NAME),
			longitude: getHeader(request.headers, LONGITUDE_HEADER_NAME),
			postalCode: getHeader(request.headers, POSTAL_CODE_HEADER_NAME)
		};
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@vercel+functions@3.4.3_@aws-sdk+credential-provider-web-identity@3.972.13/node_modules/@vercel/functions/get-env.js
var require_get_env = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var get_env_exports = {};
	__export(get_env_exports, { getEnv: () => getEnv });
	module.exports = __toCommonJS(get_env_exports);
	const getEnv = (env = process.env) => ({
		VERCEL: get(env, "VERCEL"),
		CI: get(env, "CI"),
		VERCEL_ENV: get(env, "VERCEL_ENV"),
		VERCEL_URL: get(env, "VERCEL_URL"),
		VERCEL_BRANCH_URL: get(env, "VERCEL_BRANCH_URL"),
		VERCEL_PROJECT_PRODUCTION_URL: get(env, "VERCEL_PROJECT_PRODUCTION_URL"),
		VERCEL_REGION: get(env, "VERCEL_REGION"),
		VERCEL_DEPLOYMENT_ID: get(env, "VERCEL_DEPLOYMENT_ID"),
		VERCEL_SKEW_PROTECTION_ENABLED: get(env, "VERCEL_SKEW_PROTECTION_ENABLED"),
		VERCEL_AUTOMATION_BYPASS_SECRET: get(env, "VERCEL_AUTOMATION_BYPASS_SECRET"),
		VERCEL_GIT_PROVIDER: get(env, "VERCEL_GIT_PROVIDER"),
		VERCEL_GIT_REPO_SLUG: get(env, "VERCEL_GIT_REPO_SLUG"),
		VERCEL_GIT_REPO_OWNER: get(env, "VERCEL_GIT_REPO_OWNER"),
		VERCEL_GIT_REPO_ID: get(env, "VERCEL_GIT_REPO_ID"),
		VERCEL_GIT_COMMIT_REF: get(env, "VERCEL_GIT_COMMIT_REF"),
		VERCEL_GIT_COMMIT_SHA: get(env, "VERCEL_GIT_COMMIT_SHA"),
		VERCEL_GIT_COMMIT_MESSAGE: get(env, "VERCEL_GIT_COMMIT_MESSAGE"),
		VERCEL_GIT_COMMIT_AUTHOR_LOGIN: get(env, "VERCEL_GIT_COMMIT_AUTHOR_LOGIN"),
		VERCEL_GIT_COMMIT_AUTHOR_NAME: get(env, "VERCEL_GIT_COMMIT_AUTHOR_NAME"),
		VERCEL_GIT_PREVIOUS_SHA: get(env, "VERCEL_GIT_PREVIOUS_SHA"),
		VERCEL_GIT_PULL_REQUEST_ID: get(env, "VERCEL_GIT_PULL_REQUEST_ID")
	});
	const get = (env, key) => {
		const value = env[key];
		return value === "" ? void 0 : value;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@vercel+functions@3.4.3_@aws-sdk+credential-provider-web-identity@3.972.13/node_modules/@vercel/functions/get-context.js
var require_get_context = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var get_context_exports = {};
	__export(get_context_exports, {
		SYMBOL_FOR_REQ_CONTEXT: () => SYMBOL_FOR_REQ_CONTEXT,
		getContext: () => getContext
	});
	module.exports = __toCommonJS(get_context_exports);
	const SYMBOL_FOR_REQ_CONTEXT = Symbol.for("@vercel/request-context");
	function getContext() {
		return globalThis[SYMBOL_FOR_REQ_CONTEXT]?.get?.() ?? {};
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@vercel+functions@3.4.3_@aws-sdk+credential-provider-web-identity@3.972.13/node_modules/@vercel/functions/wait-until.js
var require_wait_until = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var wait_until_exports = {};
	__export(wait_until_exports, { waitUntil: () => waitUntil });
	module.exports = __toCommonJS(wait_until_exports);
	var import_get_context = require_get_context();
	const waitUntil = (promise) => {
		if (promise === null || typeof promise !== "object" || typeof promise.then !== "function") throw new TypeError(`waitUntil can only be called with a Promise, got ${typeof promise}`);
		return (0, import_get_context.getContext)().waitUntil?.(promise);
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@vercel+functions@3.4.3_@aws-sdk+credential-provider-web-identity@3.972.13/node_modules/@vercel/functions/middleware.js
var require_middleware = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var middleware_exports = {};
	__export(middleware_exports, {
		next: () => next,
		rewrite: () => rewrite
	});
	module.exports = __toCommonJS(middleware_exports);
	function handleMiddlewareField(init, headers) {
		if (init?.request?.headers) {
			if (!(init.request.headers instanceof Headers)) throw new Error("request.headers must be an instance of Headers");
			const keys = [];
			for (const [key, value] of init.request.headers) {
				headers.set("x-middleware-request-" + key, value);
				keys.push(key);
			}
			headers.set("x-middleware-override-headers", keys.join(","));
		}
	}
	function rewrite(destination, init) {
		const headers = new Headers(init?.headers ?? {});
		headers.set("x-middleware-rewrite", String(destination));
		handleMiddlewareField(init, headers);
		return new Response(null, {
			...init,
			headers
		});
	}
	function next(init) {
		const headers = new Headers(init?.headers ?? {});
		headers.set("x-middleware-next", "1");
		handleMiddlewareField(init, headers);
		return new Response(null, {
			...init,
			headers
		});
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/@vercel+functions@3.4.3_@aws-sdk+credential-provider-web-identity@3.972.13/node_modules/@vercel/functions/cache/in-memory-cache.js
var require_in_memory_cache = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var in_memory_cache_exports = {};
	__export(in_memory_cache_exports, { InMemoryCache: () => InMemoryCache });
	module.exports = __toCommonJS(in_memory_cache_exports);
	var InMemoryCache = class {
		constructor() {
			this.cache = {};
		}
		async get(key) {
			const entry = this.cache[key];
			if (entry) {
				if (entry.ttl && entry.lastModified + entry.ttl * 1e3 < Date.now()) {
					await this.delete(key);
					return null;
				}
				return JSON.parse(entry.value);
			}
			return null;
		}
		async set(key, value, options) {
			const serialized = JSON.stringify(value ?? null);
			this.cache[key] = {
				value: serialized,
				lastModified: Date.now(),
				ttl: options?.ttl,
				tags: new Set(options?.tags || [])
			};
		}
		async delete(key) {
			delete this.cache[key];
		}
		async expireTag(tag) {
			const tags = Array.isArray(tag) ? tag : [tag];
			for (const key in this.cache) if (Object.prototype.hasOwnProperty.call(this.cache, key)) {
				const entry = this.cache[key];
				if (tags.some((t) => entry.tags.has(t))) delete this.cache[key];
			}
		}
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@vercel+functions@3.4.3_@aws-sdk+credential-provider-web-identity@3.972.13/node_modules/@vercel/functions/cache/build-client.js
var require_build_client = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var build_client_exports = {};
	__export(build_client_exports, { BuildCache: () => BuildCache });
	module.exports = __toCommonJS(build_client_exports);
	var import_index = require_cache();
	var BuildCache = class {
		constructor({ endpoint, headers, onError, timeout = 500 }) {
			this.get = async (key) => {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), this.timeout);
				try {
					const res = await fetch(`${this.endpoint}${key}`, {
						headers: this.headers,
						method: "GET",
						signal: controller.signal
					});
					if (res.status === 404) {
						clearTimeout(timeoutId);
						return null;
					}
					if (res.status === 200) {
						if (res.headers.get(import_index.HEADERS_VERCEL_CACHE_STATE) !== import_index.PkgCacheState.Fresh) {
							res.body?.cancel?.();
							clearTimeout(timeoutId);
							return null;
						}
						const result = await res.json();
						clearTimeout(timeoutId);
						return result;
					} else {
						clearTimeout(timeoutId);
						throw new Error(`Failed to get cache: ${res.statusText}`);
					}
				} catch (error) {
					clearTimeout(timeoutId);
					if (error.name === "AbortError") {
						const timeoutError = /* @__PURE__ */ new Error(`Cache request timed out after ${this.timeout}ms`);
						timeoutError.stack = error.stack;
						this.onError?.(timeoutError);
					} else this.onError?.(error);
					return null;
				}
			};
			this.set = async (key, value, options) => {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), this.timeout);
				try {
					const optionalHeaders = {};
					if (options?.ttl) optionalHeaders[import_index.HEADERS_VERCEL_REVALIDATE] = options.ttl.toString();
					if (options?.tags && options.tags.length > 0) optionalHeaders[import_index.HEADERS_VERCEL_CACHE_TAGS] = options.tags.join(",");
					if (options?.name) optionalHeaders[import_index.HEADERS_VERCEL_CACHE_ITEM_NAME] = options.name;
					const res = await fetch(`${this.endpoint}${key}`, {
						method: "POST",
						headers: {
							...this.headers,
							...optionalHeaders
						},
						body: JSON.stringify(value),
						signal: controller.signal
					});
					clearTimeout(timeoutId);
					if (res.status !== 200) throw new Error(`Failed to set cache: ${res.status} ${res.statusText}`);
				} catch (error) {
					clearTimeout(timeoutId);
					if (error.name === "AbortError") {
						const timeoutError = /* @__PURE__ */ new Error(`Cache request timed out after ${this.timeout}ms`);
						timeoutError.stack = error.stack;
						this.onError?.(timeoutError);
					} else this.onError?.(error);
				}
			};
			this.delete = async (key) => {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), this.timeout);
				try {
					const res = await fetch(`${this.endpoint}${key}`, {
						method: "DELETE",
						headers: this.headers,
						signal: controller.signal
					});
					clearTimeout(timeoutId);
					if (res.status !== 200) throw new Error(`Failed to delete cache: ${res.statusText}`);
				} catch (error) {
					clearTimeout(timeoutId);
					if (error.name === "AbortError") {
						const timeoutError = /* @__PURE__ */ new Error(`Cache request timed out after ${this.timeout}ms`);
						timeoutError.stack = error.stack;
						this.onError?.(timeoutError);
					} else this.onError?.(error);
				}
			};
			this.expireTag = async (tag) => {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), this.timeout);
				try {
					if (Array.isArray(tag)) tag = tag.join(",");
					const res = await fetch(`${this.endpoint}revalidate?tags=${tag}`, {
						method: "POST",
						headers: this.headers,
						signal: controller.signal
					});
					clearTimeout(timeoutId);
					if (res.status !== 200) throw new Error(`Failed to revalidate tag: ${res.statusText}`);
				} catch (error) {
					clearTimeout(timeoutId);
					if (error.name === "AbortError") {
						const timeoutError = /* @__PURE__ */ new Error(`Cache request timed out after ${this.timeout}ms`);
						timeoutError.stack = error.stack;
						this.onError?.(timeoutError);
					} else this.onError?.(error);
				}
			};
			this.endpoint = endpoint;
			this.headers = headers;
			this.onError = onError;
			this.timeout = timeout;
		}
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@vercel+functions@3.4.3_@aws-sdk+credential-provider-web-identity@3.972.13/node_modules/@vercel/functions/cache/index.js
var require_cache = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var cache_exports = {};
	__export(cache_exports, {
		HEADERS_VERCEL_CACHE_ITEM_NAME: () => HEADERS_VERCEL_CACHE_ITEM_NAME,
		HEADERS_VERCEL_CACHE_STATE: () => HEADERS_VERCEL_CACHE_STATE,
		HEADERS_VERCEL_CACHE_TAGS: () => HEADERS_VERCEL_CACHE_TAGS,
		HEADERS_VERCEL_REVALIDATE: () => HEADERS_VERCEL_REVALIDATE,
		PkgCacheState: () => PkgCacheState,
		getCache: () => getCache
	});
	module.exports = __toCommonJS(cache_exports);
	var import_get_context = require_get_context();
	var import_in_memory_cache = require_in_memory_cache();
	var import_build_client = require_build_client();
	const defaultKeyHashFunction = (key) => {
		let hash = 5381;
		for (let i = 0; i < key.length; i++) hash = hash * 33 ^ key.charCodeAt(i);
		return (hash >>> 0).toString(16);
	};
	const defaultNamespaceSeparator = "$";
	let inMemoryCacheInstance = null;
	let buildCacheInstance = null;
	const getCache = (cacheOptions) => {
		const resolveCache = () => {
			let cache;
			if ((0, import_get_context.getContext)().cache) cache = (0, import_get_context.getContext)().cache;
			else cache = getCacheImplementation(process.env.SUSPENSE_CACHE_DEBUG === "true");
			return cache;
		};
		return wrapWithKeyTransformation(resolveCache, createKeyTransformer(cacheOptions));
	};
	function createKeyTransformer(cacheOptions) {
		const hashFunction = cacheOptions?.keyHashFunction || defaultKeyHashFunction;
		return (key) => {
			if (!cacheOptions?.namespace) return hashFunction(key);
			const separator = cacheOptions.namespaceSeparator || defaultNamespaceSeparator;
			return `${cacheOptions.namespace}${separator}${hashFunction(key)}`;
		};
	}
	function wrapWithKeyTransformation(resolveCache, makeKey) {
		return {
			get: (key) => {
				return resolveCache().get(makeKey(key));
			},
			set: (key, value, options) => {
				return resolveCache().set(makeKey(key), value, options);
			},
			delete: (key) => {
				return resolveCache().delete(makeKey(key));
			},
			expireTag: (tag) => {
				return resolveCache().expireTag(tag);
			}
		};
	}
	let warnedCacheUnavailable = false;
	function getCacheImplementation(debug) {
		if (!inMemoryCacheInstance) inMemoryCacheInstance = new import_in_memory_cache.InMemoryCache();
		if (process.env.RUNTIME_CACHE_DISABLE_BUILD_CACHE === "true") {
			debug && console.log("Using InMemoryCache as build cache is disabled");
			return inMemoryCacheInstance;
		}
		const { RUNTIME_CACHE_ENDPOINT, RUNTIME_CACHE_HEADERS } = process.env;
		if (debug) console.log("Runtime cache environment variables:", {
			RUNTIME_CACHE_ENDPOINT,
			RUNTIME_CACHE_HEADERS
		});
		if (!RUNTIME_CACHE_ENDPOINT || !RUNTIME_CACHE_HEADERS) {
			if (!warnedCacheUnavailable) {
				console.warn("Runtime Cache unavailable in this environment. Falling back to in-memory cache.");
				warnedCacheUnavailable = true;
			}
			return inMemoryCacheInstance;
		}
		if (!buildCacheInstance) {
			let parsedHeaders = {};
			try {
				parsedHeaders = JSON.parse(RUNTIME_CACHE_HEADERS);
			} catch (e) {
				console.error("Failed to parse RUNTIME_CACHE_HEADERS:", e);
				return inMemoryCacheInstance;
			}
			let timeout = 500;
			if (process.env.RUNTIME_CACHE_TIMEOUT) {
				const parsed = parseInt(process.env.RUNTIME_CACHE_TIMEOUT, 10);
				if (!isNaN(parsed) && parsed > 0) timeout = parsed;
				else console.warn(`Invalid RUNTIME_CACHE_TIMEOUT value: "${process.env.RUNTIME_CACHE_TIMEOUT}". Using default: ${timeout}ms`);
			}
			buildCacheInstance = new import_build_client.BuildCache({
				endpoint: RUNTIME_CACHE_ENDPOINT,
				headers: parsedHeaders,
				onError: (error) => console.error(error),
				timeout
			});
		}
		return buildCacheInstance;
	}
	var PkgCacheState = /* @__PURE__ */ ((PkgCacheState2) => {
		PkgCacheState2["Fresh"] = "fresh";
		PkgCacheState2["Stale"] = "stale";
		PkgCacheState2["Expired"] = "expired";
		PkgCacheState2["NotFound"] = "notFound";
		PkgCacheState2["Error"] = "error";
		return PkgCacheState2;
	})(PkgCacheState || {});
	const HEADERS_VERCEL_CACHE_STATE = "x-vercel-cache-state";
	const HEADERS_VERCEL_REVALIDATE = "x-vercel-revalidate";
	const HEADERS_VERCEL_CACHE_TAGS = "x-vercel-cache-tags";
	const HEADERS_VERCEL_CACHE_ITEM_NAME = "x-vercel-cache-item-name";
}));
//#endregion
//#region ../../node_modules/.pnpm/@vercel+functions@3.4.3_@aws-sdk+credential-provider-web-identity@3.972.13/node_modules/@vercel/functions/db-connections/index.js
var require_db_connections = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var db_connections_exports = {};
	__export(db_connections_exports, {
		attachDatabasePool: () => attachDatabasePool,
		experimental_attachDatabasePool: () => experimental_attachDatabasePool
	});
	module.exports = __toCommonJS(db_connections_exports);
	var import_get_context = require_get_context();
	const DEBUG = !!process.env.DEBUG;
	function getIdleTimeout(dbPool) {
		if ("options" in dbPool && dbPool.options) {
			if ("idleTimeoutMillis" in dbPool.options) return typeof dbPool.options.idleTimeoutMillis === "number" ? dbPool.options.idleTimeoutMillis : 1e4;
			if ("maxIdleTimeMS" in dbPool.options) return typeof dbPool.options.maxIdleTimeMS === "number" ? dbPool.options.maxIdleTimeMS : 0;
			if ("status" in dbPool) return 5e3;
			if ("connect" in dbPool && "execute" in dbPool) return 3e4;
		}
		if ("config" in dbPool && dbPool.config) {
			if ("connectionConfig" in dbPool.config && dbPool.config.connectionConfig) return dbPool.config.connectionConfig.idleTimeout || 6e4;
			if ("idleTimeout" in dbPool.config) return typeof dbPool.config.idleTimeout === "number" ? dbPool.config.idleTimeout : 6e4;
		}
		if ("poolTimeout" in dbPool) return typeof dbPool.poolTimeout === "number" ? dbPool.poolTimeout : 6e4;
		if ("idleTimeout" in dbPool) return typeof dbPool.idleTimeout === "number" ? dbPool.idleTimeout : 0;
		return 1e4;
	}
	let idleTimeout = null;
	let idleTimeoutResolve = () => {};
	const bootTime = Date.now();
	const maximumDuration = 900 * 1e3 - 1e3;
	function waitUntilIdleTimeout(dbPool) {
		if (!process.env.VERCEL_URL || !process.env.VERCEL_REGION) return;
		if (idleTimeout) {
			clearTimeout(idleTimeout);
			idleTimeoutResolve();
		}
		const promise = new Promise((resolve) => {
			idleTimeoutResolve = resolve;
		});
		const waitTime = Math.min(getIdleTimeout(dbPool) + 100, Math.max(100, maximumDuration - (Date.now() - bootTime)));
		idleTimeout = setTimeout(() => {
			idleTimeoutResolve?.();
			if (DEBUG) console.log("Database pool idle timeout reached. Releasing connections.");
		}, waitTime);
		const requestContext = (0, import_get_context.getContext)();
		if (requestContext?.waitUntil) requestContext.waitUntil(promise);
		else console.warn("Pool release event triggered outside of request scope.");
	}
	function attachDatabasePool(dbPool) {
		if (idleTimeout) {
			idleTimeoutResolve?.();
			clearTimeout(idleTimeout);
		}
		if ("on" in dbPool && dbPool.on && "options" in dbPool && "idleTimeoutMillis" in dbPool.options) {
			dbPool.on("release", () => {
				if (DEBUG) console.log("Client released from pool");
				waitUntilIdleTimeout(dbPool);
			});
			return;
		} else if ("on" in dbPool && dbPool.on && "config" in dbPool && dbPool.config && "connectionConfig" in dbPool.config) {
			dbPool.on("release", () => {
				if (DEBUG) console.log("MySQL client released from pool");
				waitUntilIdleTimeout(dbPool);
			});
			return;
		} else if ("on" in dbPool && dbPool.on && "config" in dbPool && dbPool.config && "idleTimeout" in dbPool.config) {
			dbPool.on("release", () => {
				if (DEBUG) console.log("MySQL2/MariaDB client released from pool");
				waitUntilIdleTimeout(dbPool);
			});
			return;
		}
		if ("on" in dbPool && dbPool.on && "options" in dbPool && dbPool.options && "maxIdleTimeMS" in dbPool.options) {
			dbPool.on("connectionCheckedOut", () => {
				if (DEBUG) console.log("MongoDB connection checked out");
				waitUntilIdleTimeout(dbPool);
			});
			return;
		}
		if ("on" in dbPool && dbPool.on && "options" in dbPool && dbPool.options && "socket" in dbPool.options) {
			dbPool.on("end", () => {
				if (DEBUG) console.log("Redis connection ended");
				waitUntilIdleTimeout(dbPool);
			});
			return;
		}
		throw new Error("Unsupported database pool type");
	}
	const experimental_attachDatabasePool = attachDatabasePool;
}));
//#endregion
//#region ../../node_modules/.pnpm/@vercel+functions@3.4.3_@aws-sdk+credential-provider-web-identity@3.972.13/node_modules/@vercel/functions/purge/index.js
var require_purge = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var purge_exports = {};
	__export(purge_exports, {
		dangerouslyDeleteBySrcImage: () => dangerouslyDeleteBySrcImage,
		dangerouslyDeleteByTag: () => dangerouslyDeleteByTag,
		invalidateBySrcImage: () => invalidateBySrcImage,
		invalidateByTag: () => invalidateByTag
	});
	module.exports = __toCommonJS(purge_exports);
	var import_get_context = require_get_context();
	const invalidateByTag = (tag) => {
		const api = (0, import_get_context.getContext)().purge;
		if (api) return api.invalidateByTag(tag);
		return Promise.resolve();
	};
	const dangerouslyDeleteByTag = (tag, options) => {
		const api = (0, import_get_context.getContext)().purge;
		if (api) return api.dangerouslyDeleteByTag(tag, options);
		return Promise.resolve();
	};
	const invalidateBySrcImage = (src) => {
		const api = (0, import_get_context.getContext)().purge;
		return api ? api.invalidateBySrcImage(src) : Promise.resolve();
	};
	const dangerouslyDeleteBySrcImage = (src, options) => {
		const api = (0, import_get_context.getContext)().purge;
		return api ? api.dangerouslyDeleteBySrcImage(src, options) : Promise.resolve();
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@vercel+functions@3.4.3_@aws-sdk+credential-provider-web-identity@3.972.13/node_modules/@vercel/functions/addcachetag/index.js
var require_addcachetag = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var addcachetag_exports = {};
	__export(addcachetag_exports, { addCacheTag: () => addCacheTag });
	module.exports = __toCommonJS(addcachetag_exports);
	var import_get_context = require_get_context();
	const addCacheTag = (tag) => {
		const addCacheTag2 = (0, import_get_context.getContext)().addCacheTag;
		if (addCacheTag2) return addCacheTag2(tag);
		return Promise.resolve();
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/@vercel+functions@3.4.3_@aws-sdk+credential-provider-web-identity@3.972.13/node_modules/@vercel/functions/index.js
var require_functions = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var src_exports = {};
	__export(src_exports, {
		addCacheTag: () => import_addcachetag.addCacheTag,
		attachDatabasePool: () => import_db_connections.attachDatabasePool,
		dangerouslyDeleteBySrcImage: () => import_purge.dangerouslyDeleteBySrcImage,
		dangerouslyDeleteByTag: () => import_purge.dangerouslyDeleteByTag,
		experimental_attachDatabasePool: () => import_db_connections.experimental_attachDatabasePool,
		geolocation: () => import_headers.geolocation,
		getCache: () => import_cache.getCache,
		getEnv: () => import_get_env.getEnv,
		invalidateBySrcImage: () => import_purge.invalidateBySrcImage,
		invalidateByTag: () => import_purge.invalidateByTag,
		ipAddress: () => import_headers.ipAddress,
		next: () => import_middleware.next,
		rewrite: () => import_middleware.rewrite,
		waitUntil: () => import_wait_until.waitUntil
	});
	module.exports = __toCommonJS(src_exports);
	var import_headers = require_headers();
	var import_get_env = require_get_env();
	var import_wait_until = require_wait_until();
	var import_middleware = require_middleware();
	var import_cache = require_cache();
	var import_db_connections = require_db_connections();
	var import_purge = require_purge();
	var import_addcachetag = require_addcachetag();
}));
//#endregion
export { require_functions as t };
