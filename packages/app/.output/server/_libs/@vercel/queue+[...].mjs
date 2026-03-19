import { i as __toESM, t as __commonJSMin } from "../../_runtime.mjs";
import { n as require_dist } from "../vercel__oidc.mjs";
import * as fs$1 from "fs";
import * as net$1 from "net";
import * as path from "path";
//#region ../../node_modules/.pnpm/mixpart@0.0.5/node_modules/mixpart/dist/index.mjs
var MultipartParseError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "MultipartParseError";
	}
};
function createSearch(pattern) {
	const needle = new TextEncoder().encode(pattern);
	return (haystack, start = 0) => Buffer.prototype.indexOf.call(haystack, needle, start);
}
function createPartialTailSearch(pattern) {
	const needle = new TextEncoder().encode(pattern);
	const byteIndexes = {};
	for (let i = 0; i < needle.length; ++i) {
		const byte = needle[i];
		if (byteIndexes[byte] === void 0) byteIndexes[byte] = [];
		byteIndexes[byte].push(i);
	}
	return function(haystack) {
		const haystackEnd = haystack.length - 1;
		if (haystack[haystackEnd] in byteIndexes) {
			const indexes = byteIndexes[haystack[haystackEnd]];
			for (let i = indexes.length - 1; i >= 0; --i) for (let j = indexes[i], k = haystackEnd; j >= 0 && haystack[k] === needle[j]; --j, --k) if (j === 0) return k;
		}
		return -1;
	};
}
function parseHeaders(headerBytes) {
	const lines = new TextDecoder("iso-8859-1").decode(headerBytes).trim().split(/\r?\n/);
	const headerInit = [];
	for (const line of lines) {
		const colonIndex = line.indexOf(":");
		if (colonIndex > 0) {
			const name = line.slice(0, colonIndex).trim();
			const value = line.slice(colonIndex + 1).trim();
			headerInit.push([name, value]);
		}
	}
	return new Headers(headerInit);
}
function extractBoundary(contentType) {
	const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
	if (!boundaryMatch) throw new MultipartParseError("No boundary found in Content-Type header");
	return boundaryMatch[1] ?? boundaryMatch[2];
}
var AsyncMessageQueue = class {
	queue = [];
	waiters = [];
	finished = false;
	cancelled = false;
	error = null;
	/**
	* Producer: Enqueue a message for consumption
	*/
	enqueue(message) {
		if (this.finished || this.cancelled) return;
		if (this.waiters.length > 0) this.waiters.shift().resolve(message);
		else this.queue.push(message);
	}
	/**
	* Producer: Signal completion (with optional error)
	*/
	finish(error) {
		if (this.finished) return;
		this.finished = true;
		this.error = error || null;
		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			if (error) waiter.reject(error);
			else waiter.resolve(null);
		}
	}
	/**
	* Consumer: Cancel the queue (stops accepting new messages and notifies waiters)
	*/
	cancel() {
		if (this.cancelled || this.finished) return;
		this.cancelled = true;
		while (this.waiters.length > 0) this.waiters.shift().resolve(null);
	}
	/**
	* Consumer: Dequeue next message (or null if finished/cancelled)
	*/
	async dequeue() {
		if (this.queue.length > 0) return this.queue.shift();
		if (this.finished || this.cancelled) {
			if (this.error) throw this.error;
			return null;
		}
		return new Promise((resolve, reject) => {
			this.waiters.push({
				resolve,
				reject
			});
		});
	}
	/**
	* Check if the queue is in a terminal state
	*/
	get isTerminal() {
		return this.finished || this.cancelled;
	}
};
async function* parseMultipartStream(response, options) {
	if (!response.body) throw new MultipartParseError("Response body is null");
	const contentType = response.headers.get("content-type");
	if (!contentType) throw new MultipartParseError("Missing Content-Type header");
	yield* new StreamingMultipartParser(extractBoundary(contentType), options).parseStream(response.body);
}
var StreamingMultipartParser = class {
	boundary;
	findOpeningBoundary;
	openingBoundaryLength;
	findBoundary;
	findPartialTailBoundary;
	boundaryLength;
	findDoubleNewline;
	maxHeaderSize;
	maxBoundaryBuffer;
	state = 0;
	buffer = null;
	currentHeaders = new Headers();
	currentPayloadController = null;
	constructor(boundary, options = {}) {
		this.boundary = boundary;
		this.findOpeningBoundary = createSearch(`--${boundary}`);
		this.openingBoundaryLength = 2 + boundary.length;
		this.findBoundary = createSearch(`\r
--${boundary}`);
		this.findPartialTailBoundary = createPartialTailSearch(`\r
--${boundary}`);
		this.boundaryLength = 4 + boundary.length;
		this.findDoubleNewline = createSearch("\r\n\r\n");
		this.maxHeaderSize = options.maxHeaderSize ?? 65536;
		this.maxBoundaryBuffer = options.maxBoundaryBuffer ?? 8192;
	}
	async *parseStream(stream) {
		const reader = stream.getReader();
		const messageQueue = new AsyncMessageQueue();
		const producer = this.startProducer(reader, messageQueue);
		try {
			yield* this.consumeMessages(messageQueue);
		} finally {
			messageQueue.cancel();
			this.closeCurrentPayload();
			try {
				await reader.cancel();
			} catch (error) {}
			await producer;
		}
	}
	/**
	* Producer: Continuously read chunks and parse messages
	*/
	async startProducer(reader, messageQueue) {
		try {
			while (!messageQueue.isTerminal) {
				let result;
				try {
					result = await reader.read();
				} catch (readError) {
					if (readError instanceof Error && (readError.name === "AbortError" || readError.constructor.name === "AbortError" || readError.name === "TimeoutError" || readError.constructor.name === "TimeoutError")) break;
					throw readError;
				}
				const { done, value } = result;
				if (done) {
					if (this.buffer !== null && this.buffer.length > 0) {
						const messages2 = this.write(new Uint8Array(0));
						for (const message of messages2) {
							if (messageQueue.isTerminal) break;
							messageQueue.enqueue(message);
						}
					}
					if (this.state !== 4) {
						if (this.state === 0) throw new MultipartParseError("Invalid multipart stream: missing initial boundary");
						throw new MultipartParseError("Unexpected end of stream");
					}
					break;
				}
				if (!(value instanceof Uint8Array)) throw new MultipartParseError(`Invalid chunk type: expected Uint8Array, got ${typeof value}`);
				const messages = this.write(value);
				for (const message of messages) {
					if (messageQueue.isTerminal) break;
					messageQueue.enqueue(message);
				}
			}
			if (!messageQueue.isTerminal) messageQueue.finish();
		} catch (error) {
			this.closeCurrentPayload(error);
			if (!messageQueue.isTerminal) messageQueue.finish(error);
		} finally {
			try {
				reader.releaseLock();
			} catch (error) {}
		}
	}
	/**
	* Consumer: Yield messages from the queue
	*/
	async *consumeMessages(messageQueue) {
		while (true) {
			const message = await messageQueue.dequeue();
			if (message === null) break;
			yield message;
		}
	}
	/**
	* Process a chunk of data through the state machine and return any complete messages.
	*
	* Returns an array because a single chunk can contain multiple complete messages
	* when small messages with headers + body + boundary all fit in one network chunk.
	* All messages must be captured and queued to maintain proper message ordering.
	*/
	write(chunk) {
		const newMessages = [];
		if (this.state === 4) throw new MultipartParseError("Unexpected data after end of stream");
		let index = 0;
		let chunkLength = chunk.length;
		if (this.buffer !== null) {
			const newSize = this.buffer.length + chunkLength;
			const maxAllowedSize = this.state === 2 ? this.maxHeaderSize : this.maxBoundaryBuffer;
			if (newSize > maxAllowedSize) throw new MultipartParseError(`Buffer size limit exceeded: ${newSize} bytes > ${maxAllowedSize} bytes. This may indicate malformed multipart data with ${this.state === 2 ? "oversized headers" : "invalid boundaries"}.`);
			const newChunk = new Uint8Array(newSize);
			newChunk.set(this.buffer, 0);
			newChunk.set(chunk, this.buffer.length);
			chunk = newChunk;
			chunkLength = chunk.length;
			this.buffer = null;
		}
		if (chunkLength === 0 && this.state === 0) throw new MultipartParseError("Invalid multipart stream: missing initial boundary");
		while (true) {
			if (this.state === 3) {
				if (chunkLength - index < this.boundaryLength) {
					const remainingData = chunk.subarray(index);
					if (remainingData.length > this.maxBoundaryBuffer) throw new MultipartParseError(`Boundary buffer limit exceeded: ${remainingData.length} > ${this.maxBoundaryBuffer}`);
					this.buffer = remainingData;
					break;
				}
				const boundaryIndex = this.findBoundary(chunk, index);
				if (boundaryIndex === -1) {
					const partialTailIndex = this.findPartialTailBoundary(chunk);
					if (partialTailIndex === -1) this.writeBody(index === 0 ? chunk : chunk.subarray(index));
					else {
						this.writeBody(chunk.subarray(index, partialTailIndex));
						const partialBoundary = chunk.subarray(partialTailIndex);
						if (partialBoundary.length > this.maxBoundaryBuffer) throw new MultipartParseError(`Partial boundary too large: ${partialBoundary.length} > ${this.maxBoundaryBuffer}`);
						this.buffer = partialBoundary;
					}
					break;
				}
				this.writeBody(chunk.subarray(index, boundaryIndex));
				this.finishMessage();
				index = boundaryIndex + this.boundaryLength;
				this.state = 1;
			}
			if (this.state === 1) {
				if (chunkLength - index < 2) {
					const remainingData = chunk.subarray(index);
					if (remainingData.length > this.maxBoundaryBuffer) throw new MultipartParseError(`After-boundary buffer limit exceeded: ${remainingData.length} > ${this.maxBoundaryBuffer}`);
					this.buffer = remainingData;
					break;
				}
				if (chunk[index] === 45 && chunk[index + 1] === 45) {
					this.state = 4;
					break;
				}
				if (chunk[index] === 13 && chunk[index + 1] === 10) index += 2;
				else if (chunk[index] === 10) index += 1;
				else throw new MultipartParseError(`Invalid character after boundary: expected CRLF or LF, got 0x${chunk[index].toString(16)}`);
				this.state = 2;
			}
			if (this.state === 2) {
				if (chunkLength - index < 4) {
					const remainingData = chunk.subarray(index);
					if (remainingData.length > this.maxHeaderSize) throw new MultipartParseError(`Header buffer limit exceeded: ${remainingData.length} > ${this.maxHeaderSize}`);
					this.buffer = remainingData;
					break;
				}
				let headerEndIndex = this.findDoubleNewline(chunk, index);
				let headerEndOffset = 4;
				if (headerEndIndex === -1) {
					headerEndIndex = createSearch("\n\n")(chunk, index);
					headerEndOffset = 2;
				}
				if (headerEndIndex === -1) {
					const headerData = chunk.subarray(index);
					if (headerData.length > this.maxHeaderSize) throw new MultipartParseError(`Headers too large: ${headerData.length} > ${this.maxHeaderSize} bytes`);
					this.buffer = headerData;
					break;
				}
				this.currentHeaders = parseHeaders(chunk.subarray(index, headerEndIndex));
				const message = this.createStreamingMessage();
				newMessages.push(message);
				index = headerEndIndex + headerEndOffset;
				this.state = 3;
				continue;
			}
			if (this.state === 0) {
				if (chunkLength < this.openingBoundaryLength) {
					if (chunk.length > this.maxBoundaryBuffer) throw new MultipartParseError(`Initial chunk too large for boundary detection: ${chunk.length} > ${this.maxBoundaryBuffer}`);
					this.buffer = chunk;
					break;
				}
				if (this.findOpeningBoundary(chunk) !== 0) throw new MultipartParseError("Invalid multipart stream: missing initial boundary");
				index = this.openingBoundaryLength;
				this.state = 1;
			}
		}
		return newMessages;
	}
	createStreamingMessage() {
		const headers = new Headers(this.currentHeaders);
		const payload = new ReadableStream({ start: (controller) => {
			this.currentPayloadController = controller;
		} });
		this.currentHeaders = new Headers();
		return {
			headers,
			payload
		};
	}
	writeBody(chunk) {
		if (this.currentPayloadController) this.currentPayloadController.enqueue(chunk);
	}
	finishMessage() {
		if (this.currentPayloadController) {
			this.currentPayloadController.close();
			this.currentPayloadController = null;
		}
	}
	/**
	* Close current payload controller if open (used during cleanup)
	* If an error is provided, forwards it to the payload consumer
	*/
	closeCurrentPayload(error) {
		if (this.currentPayloadController) {
			try {
				if (error) this.currentPayloadController.error(error);
				else this.currentPayloadController.close();
			} catch (controllerError) {}
			this.currentPayloadController = null;
		}
	}
};
//#endregion
//#region ../../node_modules/.pnpm/balanced-match@4.0.4/node_modules/balanced-match/dist/esm/index.js
const balanced = (a, b, str) => {
	const ma = a instanceof RegExp ? maybeMatch(a, str) : a;
	const mb = b instanceof RegExp ? maybeMatch(b, str) : b;
	const r = ma !== null && mb != null && range(ma, mb, str);
	return r && {
		start: r[0],
		end: r[1],
		pre: str.slice(0, r[0]),
		body: str.slice(r[0] + ma.length, r[1]),
		post: str.slice(r[1] + mb.length)
	};
};
const maybeMatch = (reg, str) => {
	const m = str.match(reg);
	return m ? m[0] : null;
};
const range = (a, b, str) => {
	let begs, beg, left, right = void 0, result;
	let ai = str.indexOf(a);
	let bi = str.indexOf(b, ai + 1);
	let i = ai;
	if (ai >= 0 && bi > 0) {
		if (a === b) return [ai, bi];
		begs = [];
		left = str.length;
		while (i >= 0 && !result) {
			if (i === ai) {
				begs.push(i);
				ai = str.indexOf(a, i + 1);
			} else if (begs.length === 1) {
				const r = begs.pop();
				if (r !== void 0) result = [r, bi];
			} else {
				beg = begs.pop();
				if (beg !== void 0 && beg < left) {
					left = beg;
					right = bi;
				}
				bi = str.indexOf(b, i + 1);
			}
			i = ai < bi && ai >= 0 ? ai : bi;
		}
		if (begs.length && right !== void 0) result = [left, right];
	}
	return result;
};
//#endregion
//#region ../../node_modules/.pnpm/brace-expansion@5.0.4/node_modules/brace-expansion/dist/esm/index.js
const escSlash = "\0SLASH" + Math.random() + "\0";
const escOpen = "\0OPEN" + Math.random() + "\0";
const escClose = "\0CLOSE" + Math.random() + "\0";
const escComma = "\0COMMA" + Math.random() + "\0";
const escPeriod = "\0PERIOD" + Math.random() + "\0";
const escSlashPattern = new RegExp(escSlash, "g");
const escOpenPattern = new RegExp(escOpen, "g");
const escClosePattern = new RegExp(escClose, "g");
const escCommaPattern = new RegExp(escComma, "g");
const escPeriodPattern = new RegExp(escPeriod, "g");
const slashPattern = /\\\\/g;
const openPattern = /\\{/g;
const closePattern = /\\}/g;
const commaPattern = /\\,/g;
const periodPattern = /\\\./g;
function numeric(str) {
	return !isNaN(str) ? parseInt(str, 10) : str.charCodeAt(0);
}
function escapeBraces(str) {
	return str.replace(slashPattern, escSlash).replace(openPattern, escOpen).replace(closePattern, escClose).replace(commaPattern, escComma).replace(periodPattern, escPeriod);
}
function unescapeBraces(str) {
	return str.replace(escSlashPattern, "\\").replace(escOpenPattern, "{").replace(escClosePattern, "}").replace(escCommaPattern, ",").replace(escPeriodPattern, ".");
}
/**
* Basically just str.split(","), but handling cases
* where we have nested braced sections, which should be
* treated as individual members, like {a,{b,c},d}
*/
function parseCommaParts(str) {
	if (!str) return [""];
	const parts = [];
	const m = balanced("{", "}", str);
	if (!m) return str.split(",");
	const { pre, body, post } = m;
	const p = pre.split(",");
	p[p.length - 1] += "{" + body + "}";
	const postParts = parseCommaParts(post);
	if (post.length) {
		p[p.length - 1] += postParts.shift();
		p.push.apply(p, postParts);
	}
	parts.push.apply(parts, p);
	return parts;
}
function expand(str, options = {}) {
	if (!str) return [];
	const { max = 1e5 } = options;
	if (str.slice(0, 2) === "{}") str = "\\{\\}" + str.slice(2);
	return expand_(escapeBraces(str), max, true).map(unescapeBraces);
}
function embrace(str) {
	return "{" + str + "}";
}
function isPadded(el) {
	return /^-?0\d/.test(el);
}
function lte(i, y) {
	return i <= y;
}
function gte(i, y) {
	return i >= y;
}
function expand_(str, max, isTop) {
	/** @type {string[]} */
	const expansions = [];
	const m = balanced("{", "}", str);
	if (!m) return [str];
	const pre = m.pre;
	const post = m.post.length ? expand_(m.post, max, false) : [""];
	if (/\$$/.test(m.pre)) for (let k = 0; k < post.length && k < max; k++) {
		const expansion = pre + "{" + m.body + "}" + post[k];
		expansions.push(expansion);
	}
	else {
		const isNumericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(m.body);
		const isAlphaSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(m.body);
		const isSequence = isNumericSequence || isAlphaSequence;
		const isOptions = m.body.indexOf(",") >= 0;
		if (!isSequence && !isOptions) {
			if (m.post.match(/,(?!,).*\}/)) {
				str = m.pre + "{" + m.body + escClose + m.post;
				return expand_(str, max, true);
			}
			return [str];
		}
		let n;
		if (isSequence) n = m.body.split(/\.\./);
		else {
			n = parseCommaParts(m.body);
			if (n.length === 1 && n[0] !== void 0) {
				n = expand_(n[0], max, false).map(embrace);
				/* c8 ignore start */
				if (n.length === 1) return post.map((p) => m.pre + n[0] + p);
			}
		}
		let N;
		if (isSequence && n[0] !== void 0 && n[1] !== void 0) {
			const x = numeric(n[0]);
			const y = numeric(n[1]);
			const width = Math.max(n[0].length, n[1].length);
			let incr = n.length === 3 && n[2] !== void 0 ? Math.abs(numeric(n[2])) : 1;
			let test = lte;
			if (y < x) {
				incr *= -1;
				test = gte;
			}
			const pad = n.some(isPadded);
			N = [];
			for (let i = x; test(i, y); i += incr) {
				let c;
				if (isAlphaSequence) {
					c = String.fromCharCode(i);
					if (c === "\\") c = "";
				} else {
					c = String(i);
					if (pad) {
						const need = width - c.length;
						if (need > 0) {
							const z = new Array(need + 1).join("0");
							if (i < 0) c = "-" + z + c.slice(1);
							else c = z + c;
						}
					}
				}
				N.push(c);
			}
		} else {
			N = [];
			for (let j = 0; j < n.length; j++) N.push.apply(N, expand_(n[j], max, false));
		}
		for (let j = 0; j < N.length; j++) for (let k = 0; k < post.length && expansions.length < max; k++) {
			const expansion = pre + N[j] + post[k];
			if (!isTop || isSequence || expansion) expansions.push(expansion);
		}
	}
	return expansions;
}
//#endregion
//#region ../../node_modules/.pnpm/minimatch@10.2.4/node_modules/minimatch/dist/esm/assert-valid-pattern.js
const MAX_PATTERN_LENGTH = 1024 * 64;
const assertValidPattern = (pattern) => {
	if (typeof pattern !== "string") throw new TypeError("invalid pattern");
	if (pattern.length > MAX_PATTERN_LENGTH) throw new TypeError("pattern is too long");
};
//#endregion
//#region ../../node_modules/.pnpm/minimatch@10.2.4/node_modules/minimatch/dist/esm/brace-expressions.js
const posixClasses = {
	"[:alnum:]": ["\\p{L}\\p{Nl}\\p{Nd}", true],
	"[:alpha:]": ["\\p{L}\\p{Nl}", true],
	"[:ascii:]": ["\\x00-\\x7f", false],
	"[:blank:]": ["\\p{Zs}\\t", true],
	"[:cntrl:]": ["\\p{Cc}", true],
	"[:digit:]": ["\\p{Nd}", true],
	"[:graph:]": [
		"\\p{Z}\\p{C}",
		true,
		true
	],
	"[:lower:]": ["\\p{Ll}", true],
	"[:print:]": ["\\p{C}", true],
	"[:punct:]": ["\\p{P}", true],
	"[:space:]": ["\\p{Z}\\t\\r\\n\\v\\f", true],
	"[:upper:]": ["\\p{Lu}", true],
	"[:word:]": ["\\p{L}\\p{Nl}\\p{Nd}\\p{Pc}", true],
	"[:xdigit:]": ["A-Fa-f0-9", false]
};
const braceEscape = (s) => s.replace(/[[\]\\-]/g, "\\$&");
const regexpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
const rangesToString = (ranges) => ranges.join("");
const parseClass = (glob, position) => {
	const pos = position;
	/* c8 ignore start */
	if (glob.charAt(pos) !== "[") throw new Error("not in a brace expression");
	/* c8 ignore stop */
	const ranges = [];
	const negs = [];
	let i = pos + 1;
	let sawStart = false;
	let uflag = false;
	let escaping = false;
	let negate = false;
	let endPos = pos;
	let rangeStart = "";
	WHILE: while (i < glob.length) {
		const c = glob.charAt(i);
		if ((c === "!" || c === "^") && i === pos + 1) {
			negate = true;
			i++;
			continue;
		}
		if (c === "]" && sawStart && !escaping) {
			endPos = i + 1;
			break;
		}
		sawStart = true;
		if (c === "\\") {
			if (!escaping) {
				escaping = true;
				i++;
				continue;
			}
		}
		if (c === "[" && !escaping) {
			for (const [cls, [unip, u, neg]] of Object.entries(posixClasses)) if (glob.startsWith(cls, i)) {
				if (rangeStart) return [
					"$.",
					false,
					glob.length - pos,
					true
				];
				i += cls.length;
				if (neg) negs.push(unip);
				else ranges.push(unip);
				uflag = uflag || u;
				continue WHILE;
			}
		}
		escaping = false;
		if (rangeStart) {
			if (c > rangeStart) ranges.push(braceEscape(rangeStart) + "-" + braceEscape(c));
			else if (c === rangeStart) ranges.push(braceEscape(c));
			rangeStart = "";
			i++;
			continue;
		}
		if (glob.startsWith("-]", i + 1)) {
			ranges.push(braceEscape(c + "-"));
			i += 2;
			continue;
		}
		if (glob.startsWith("-", i + 1)) {
			rangeStart = c;
			i += 2;
			continue;
		}
		ranges.push(braceEscape(c));
		i++;
	}
	if (endPos < i) return [
		"",
		false,
		0,
		false
	];
	if (!ranges.length && !negs.length) return [
		"$.",
		false,
		glob.length - pos,
		true
	];
	if (negs.length === 0 && ranges.length === 1 && /^\\?.$/.test(ranges[0]) && !negate) return [
		regexpEscape(ranges[0].length === 2 ? ranges[0].slice(-1) : ranges[0]),
		false,
		endPos - pos,
		false
	];
	const sranges = "[" + (negate ? "^" : "") + rangesToString(ranges) + "]";
	const snegs = "[" + (negate ? "" : "^") + rangesToString(negs) + "]";
	return [
		ranges.length && negs.length ? "(" + sranges + "|" + snegs + ")" : ranges.length ? sranges : snegs,
		uflag,
		endPos - pos,
		true
	];
};
//#endregion
//#region ../../node_modules/.pnpm/minimatch@10.2.4/node_modules/minimatch/dist/esm/unescape.js
/**
* Un-escape a string that has been escaped with {@link escape}.
*
* If the {@link MinimatchOptions.windowsPathsNoEscape} option is used, then
* square-bracket escapes are removed, but not backslash escapes.
*
* For example, it will turn the string `'[*]'` into `*`, but it will not
* turn `'\\*'` into `'*'`, because `\` is a path separator in
* `windowsPathsNoEscape` mode.
*
* When `windowsPathsNoEscape` is not set, then both square-bracket escapes and
* backslash escapes are removed.
*
* Slashes (and backslashes in `windowsPathsNoEscape` mode) cannot be escaped
* or unescaped.
*
* When `magicalBraces` is not set, escapes of braces (`{` and `}`) will not be
* unescaped.
*/
const unescape = (s, { windowsPathsNoEscape = false, magicalBraces = true } = {}) => {
	if (magicalBraces) return windowsPathsNoEscape ? s.replace(/\[([^\/\\])\]/g, "$1") : s.replace(/((?!\\).|^)\[([^\/\\])\]/g, "$1$2").replace(/\\([^\/])/g, "$1");
	return windowsPathsNoEscape ? s.replace(/\[([^\/\\{}])\]/g, "$1") : s.replace(/((?!\\).|^)\[([^\/\\{}])\]/g, "$1$2").replace(/\\([^\/{}])/g, "$1");
};
//#endregion
//#region ../../node_modules/.pnpm/minimatch@10.2.4/node_modules/minimatch/dist/esm/ast.js
var _a;
const types = new Set([
	"!",
	"?",
	"+",
	"*",
	"@"
]);
const isExtglobType = (c) => types.has(c);
const isExtglobAST = (c) => isExtglobType(c.type);
const adoptionMap = new Map([
	["!", ["@"]],
	["?", ["?", "@"]],
	["@", ["@"]],
	["*", [
		"*",
		"+",
		"?",
		"@"
	]],
	["+", ["+", "@"]]
]);
const adoptionWithSpaceMap = new Map([
	["!", ["?"]],
	["@", ["?"]],
	["+", ["?", "*"]]
]);
const adoptionAnyMap = new Map([
	["!", ["?", "@"]],
	["?", ["?", "@"]],
	["@", ["?", "@"]],
	["*", [
		"*",
		"+",
		"?",
		"@"
	]],
	["+", [
		"+",
		"@",
		"?",
		"*"
	]]
]);
const usurpMap = new Map([
	["!", new Map([["!", "@"]])],
	["?", new Map([["*", "*"], ["+", "*"]])],
	["@", new Map([
		["!", "!"],
		["?", "?"],
		["@", "@"],
		["*", "*"],
		["+", "+"]
	])],
	["+", new Map([["?", "*"], ["*", "*"]])]
]);
const startNoTraversal = "(?!(?:^|/)\\.\\.?(?:$|/))";
const startNoDot = "(?!\\.)";
const addPatternStart = new Set(["[", "."]);
const justDots = new Set(["..", "."]);
const reSpecials = /* @__PURE__ */ new Set("().*{}+?[]^$\\!");
const regExpEscape$1 = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
const qmark = "[^/]";
const star$1 = qmark + "*?";
const starNoEmpty = qmark + "+?";
let ID = 0;
var AST = class {
	type;
	#root;
	#hasMagic;
	#uflag = false;
	#parts = [];
	#parent;
	#parentIndex;
	#negs;
	#filledNegs = false;
	#options;
	#toString;
	#emptyExt = false;
	id = ++ID;
	get depth() {
		return (this.#parent?.depth ?? -1) + 1;
	}
	[Symbol.for("nodejs.util.inspect.custom")]() {
		return {
			"@@type": "AST",
			id: this.id,
			type: this.type,
			root: this.#root.id,
			parent: this.#parent?.id,
			depth: this.depth,
			partsLength: this.#parts.length,
			parts: this.#parts
		};
	}
	constructor(type, parent, options = {}) {
		this.type = type;
		if (type) this.#hasMagic = true;
		this.#parent = parent;
		this.#root = this.#parent ? this.#parent.#root : this;
		this.#options = this.#root === this ? options : this.#root.#options;
		this.#negs = this.#root === this ? [] : this.#root.#negs;
		if (type === "!" && !this.#root.#filledNegs) this.#negs.push(this);
		this.#parentIndex = this.#parent ? this.#parent.#parts.length : 0;
	}
	get hasMagic() {
		/* c8 ignore start */
		if (this.#hasMagic !== void 0) return this.#hasMagic;
		/* c8 ignore stop */
		for (const p of this.#parts) {
			if (typeof p === "string") continue;
			if (p.type || p.hasMagic) return this.#hasMagic = true;
		}
		return this.#hasMagic;
	}
	toString() {
		if (this.#toString !== void 0) return this.#toString;
		if (!this.type) return this.#toString = this.#parts.map((p) => String(p)).join("");
		else return this.#toString = this.type + "(" + this.#parts.map((p) => String(p)).join("|") + ")";
	}
	#fillNegs() {
		/* c8 ignore start */
		if (this !== this.#root) throw new Error("should only call on root");
		if (this.#filledNegs) return this;
		/* c8 ignore stop */
		this.toString();
		this.#filledNegs = true;
		let n;
		while (n = this.#negs.pop()) {
			if (n.type !== "!") continue;
			let p = n;
			let pp = p.#parent;
			while (pp) {
				for (let i = p.#parentIndex + 1; !pp.type && i < pp.#parts.length; i++) for (const part of n.#parts) {
					/* c8 ignore start */
					if (typeof part === "string") throw new Error("string part in extglob AST??");
					/* c8 ignore stop */
					part.copyIn(pp.#parts[i]);
				}
				p = pp;
				pp = p.#parent;
			}
		}
		return this;
	}
	push(...parts) {
		for (const p of parts) {
			if (p === "") continue;
			/* c8 ignore start */
			if (typeof p !== "string" && !(p instanceof _a && p.#parent === this)) throw new Error("invalid part: " + p);
			/* c8 ignore stop */
			this.#parts.push(p);
		}
	}
	toJSON() {
		const ret = this.type === null ? this.#parts.slice().map((p) => typeof p === "string" ? p : p.toJSON()) : [this.type, ...this.#parts.map((p) => p.toJSON())];
		if (this.isStart() && !this.type) ret.unshift([]);
		if (this.isEnd() && (this === this.#root || this.#root.#filledNegs && this.#parent?.type === "!")) ret.push({});
		return ret;
	}
	isStart() {
		if (this.#root === this) return true;
		if (!this.#parent?.isStart()) return false;
		if (this.#parentIndex === 0) return true;
		const p = this.#parent;
		for (let i = 0; i < this.#parentIndex; i++) {
			const pp = p.#parts[i];
			if (!(pp instanceof _a && pp.type === "!")) return false;
		}
		return true;
	}
	isEnd() {
		if (this.#root === this) return true;
		if (this.#parent?.type === "!") return true;
		if (!this.#parent?.isEnd()) return false;
		if (!this.type) return this.#parent?.isEnd();
		/* c8 ignore start */
		const pl = this.#parent ? this.#parent.#parts.length : 0;
		/* c8 ignore stop */
		return this.#parentIndex === pl - 1;
	}
	copyIn(part) {
		if (typeof part === "string") this.push(part);
		else this.push(part.clone(this));
	}
	clone(parent) {
		const c = new _a(this.type, parent);
		for (const p of this.#parts) c.copyIn(p);
		return c;
	}
	static #parseAST(str, ast, pos, opt, extDepth) {
		const maxDepth = opt.maxExtglobRecursion ?? 2;
		let escaping = false;
		let inBrace = false;
		let braceStart = -1;
		let braceNeg = false;
		if (ast.type === null) {
			let i = pos;
			let acc = "";
			while (i < str.length) {
				const c = str.charAt(i++);
				if (escaping || c === "\\") {
					escaping = !escaping;
					acc += c;
					continue;
				}
				if (inBrace) {
					if (i === braceStart + 1) {
						if (c === "^" || c === "!") braceNeg = true;
					} else if (c === "]" && !(i === braceStart + 2 && braceNeg)) inBrace = false;
					acc += c;
					continue;
				} else if (c === "[") {
					inBrace = true;
					braceStart = i;
					braceNeg = false;
					acc += c;
					continue;
				}
				if (!opt.noext && isExtglobType(c) && str.charAt(i) === "(" && extDepth <= maxDepth) {
					ast.push(acc);
					acc = "";
					const ext = new _a(c, ast);
					i = _a.#parseAST(str, ext, i, opt, extDepth + 1);
					ast.push(ext);
					continue;
				}
				acc += c;
			}
			ast.push(acc);
			return i;
		}
		let i = pos + 1;
		let part = new _a(null, ast);
		const parts = [];
		let acc = "";
		while (i < str.length) {
			const c = str.charAt(i++);
			if (escaping || c === "\\") {
				escaping = !escaping;
				acc += c;
				continue;
			}
			if (inBrace) {
				if (i === braceStart + 1) {
					if (c === "^" || c === "!") braceNeg = true;
				} else if (c === "]" && !(i === braceStart + 2 && braceNeg)) inBrace = false;
				acc += c;
				continue;
			} else if (c === "[") {
				inBrace = true;
				braceStart = i;
				braceNeg = false;
				acc += c;
				continue;
			}
			/* c8 ignore stop */
			if (!opt.noext && isExtglobType(c) && str.charAt(i) === "(" && (extDepth <= maxDepth || ast && ast.#canAdoptType(c))) {
				const depthAdd = ast && ast.#canAdoptType(c) ? 0 : 1;
				part.push(acc);
				acc = "";
				const ext = new _a(c, part);
				part.push(ext);
				i = _a.#parseAST(str, ext, i, opt, extDepth + depthAdd);
				continue;
			}
			if (c === "|") {
				part.push(acc);
				acc = "";
				parts.push(part);
				part = new _a(null, ast);
				continue;
			}
			if (c === ")") {
				if (acc === "" && ast.#parts.length === 0) ast.#emptyExt = true;
				part.push(acc);
				acc = "";
				ast.push(...parts, part);
				return i;
			}
			acc += c;
		}
		ast.type = null;
		ast.#hasMagic = void 0;
		ast.#parts = [str.substring(pos - 1)];
		return i;
	}
	#canAdoptWithSpace(child) {
		return this.#canAdopt(child, adoptionWithSpaceMap);
	}
	#canAdopt(child, map = adoptionMap) {
		if (!child || typeof child !== "object" || child.type !== null || child.#parts.length !== 1 || this.type === null) return false;
		const gc = child.#parts[0];
		if (!gc || typeof gc !== "object" || gc.type === null) return false;
		return this.#canAdoptType(gc.type, map);
	}
	#canAdoptType(c, map = adoptionAnyMap) {
		return !!map.get(this.type)?.includes(c);
	}
	#adoptWithSpace(child, index) {
		const gc = child.#parts[0];
		const blank = new _a(null, gc, this.options);
		blank.#parts.push("");
		gc.push(blank);
		this.#adopt(child, index);
	}
	#adopt(child, index) {
		const gc = child.#parts[0];
		this.#parts.splice(index, 1, ...gc.#parts);
		for (const p of gc.#parts) if (typeof p === "object") p.#parent = this;
		this.#toString = void 0;
	}
	#canUsurpType(c) {
		return !!usurpMap.get(this.type)?.has(c);
	}
	#canUsurp(child) {
		if (!child || typeof child !== "object" || child.type !== null || child.#parts.length !== 1 || this.type === null || this.#parts.length !== 1) return false;
		const gc = child.#parts[0];
		if (!gc || typeof gc !== "object" || gc.type === null) return false;
		return this.#canUsurpType(gc.type);
	}
	#usurp(child) {
		const m = usurpMap.get(this.type);
		const gc = child.#parts[0];
		const nt = m?.get(gc.type);
		/* c8 ignore start - impossible */
		if (!nt) return false;
		/* c8 ignore stop */
		this.#parts = gc.#parts;
		for (const p of this.#parts) if (typeof p === "object") p.#parent = this;
		this.type = nt;
		this.#toString = void 0;
		this.#emptyExt = false;
	}
	static fromGlob(pattern, options = {}) {
		const ast = new _a(null, void 0, options);
		_a.#parseAST(pattern, ast, 0, options, 0);
		return ast;
	}
	toMMPattern() {
		/* c8 ignore start */
		if (this !== this.#root) return this.#root.toMMPattern();
		/* c8 ignore stop */
		const glob = this.toString();
		const [re, body, hasMagic, uflag] = this.toRegExpSource();
		if (!(hasMagic || this.#hasMagic || this.#options.nocase && !this.#options.nocaseMagicOnly && glob.toUpperCase() !== glob.toLowerCase())) return body;
		const flags = (this.#options.nocase ? "i" : "") + (uflag ? "u" : "");
		return Object.assign(new RegExp(`^${re}$`, flags), {
			_src: re,
			_glob: glob
		});
	}
	get options() {
		return this.#options;
	}
	toRegExpSource(allowDot) {
		const dot = allowDot ?? !!this.#options.dot;
		if (this.#root === this) {
			this.#flatten();
			this.#fillNegs();
		}
		if (!isExtglobAST(this)) {
			const noEmpty = this.isStart() && this.isEnd() && !this.#parts.some((s) => typeof s !== "string");
			const src = this.#parts.map((p) => {
				const [re, _, hasMagic, uflag] = typeof p === "string" ? _a.#parseGlob(p, this.#hasMagic, noEmpty) : p.toRegExpSource(allowDot);
				this.#hasMagic = this.#hasMagic || hasMagic;
				this.#uflag = this.#uflag || uflag;
				return re;
			}).join("");
			let start = "";
			if (this.isStart()) {
				if (typeof this.#parts[0] === "string") {
					if (!(this.#parts.length === 1 && justDots.has(this.#parts[0]))) {
						const aps = addPatternStart;
						const needNoTrav = dot && aps.has(src.charAt(0)) || src.startsWith("\\.") && aps.has(src.charAt(2)) || src.startsWith("\\.\\.") && aps.has(src.charAt(4));
						const needNoDot = !dot && !allowDot && aps.has(src.charAt(0));
						start = needNoTrav ? startNoTraversal : needNoDot ? startNoDot : "";
					}
				}
			}
			let end = "";
			if (this.isEnd() && this.#root.#filledNegs && this.#parent?.type === "!") end = "(?:$|\\/)";
			return [
				start + src + end,
				unescape(src),
				this.#hasMagic = !!this.#hasMagic,
				this.#uflag
			];
		}
		const repeated = this.type === "*" || this.type === "+";
		const start = this.type === "!" ? "(?:(?!(?:" : "(?:";
		let body = this.#partsToRegExp(dot);
		if (this.isStart() && this.isEnd() && !body && this.type !== "!") {
			const s = this.toString();
			const me = this;
			me.#parts = [s];
			me.type = null;
			me.#hasMagic = void 0;
			return [
				s,
				unescape(this.toString()),
				false,
				false
			];
		}
		let bodyDotAllowed = !repeated || allowDot || dot || false ? "" : this.#partsToRegExp(true);
		if (bodyDotAllowed === body) bodyDotAllowed = "";
		if (bodyDotAllowed) body = `(?:${body})(?:${bodyDotAllowed})*?`;
		let final = "";
		if (this.type === "!" && this.#emptyExt) final = (this.isStart() && !dot ? startNoDot : "") + starNoEmpty;
		else {
			const close = this.type === "!" ? "))" + (this.isStart() && !dot && !allowDot ? startNoDot : "") + star$1 + ")" : this.type === "@" ? ")" : this.type === "?" ? ")?" : this.type === "+" && bodyDotAllowed ? ")" : this.type === "*" && bodyDotAllowed ? `)?` : `)${this.type}`;
			final = start + body + close;
		}
		return [
			final,
			unescape(body),
			this.#hasMagic = !!this.#hasMagic,
			this.#uflag
		];
	}
	#flatten() {
		if (!isExtglobAST(this)) {
			for (const p of this.#parts) if (typeof p === "object") p.#flatten();
		} else {
			let iterations = 0;
			let done = false;
			do {
				done = true;
				for (let i = 0; i < this.#parts.length; i++) {
					const c = this.#parts[i];
					if (typeof c === "object") {
						c.#flatten();
						if (this.#canAdopt(c)) {
							done = false;
							this.#adopt(c, i);
						} else if (this.#canAdoptWithSpace(c)) {
							done = false;
							this.#adoptWithSpace(c, i);
						} else if (this.#canUsurp(c)) {
							done = false;
							this.#usurp(c);
						}
					}
				}
			} while (!done && ++iterations < 10);
		}
		this.#toString = void 0;
	}
	#partsToRegExp(dot) {
		return this.#parts.map((p) => {
			/* c8 ignore start */
			if (typeof p === "string") throw new Error("string type in extglob ast??");
			/* c8 ignore stop */
			const [re, _, _hasMagic, uflag] = p.toRegExpSource(dot);
			this.#uflag = this.#uflag || uflag;
			return re;
		}).filter((p) => !(this.isStart() && this.isEnd()) || !!p).join("|");
	}
	static #parseGlob(glob, hasMagic, noEmpty = false) {
		let escaping = false;
		let re = "";
		let uflag = false;
		let inStar = false;
		for (let i = 0; i < glob.length; i++) {
			const c = glob.charAt(i);
			if (escaping) {
				escaping = false;
				re += (reSpecials.has(c) ? "\\" : "") + c;
				continue;
			}
			if (c === "*") {
				if (inStar) continue;
				inStar = true;
				re += noEmpty && /^[*]+$/.test(glob) ? starNoEmpty : star$1;
				hasMagic = true;
				continue;
			} else inStar = false;
			if (c === "\\") {
				if (i === glob.length - 1) re += "\\\\";
				else escaping = true;
				continue;
			}
			if (c === "[") {
				const [src, needUflag, consumed, magic] = parseClass(glob, i);
				if (consumed) {
					re += src;
					uflag = uflag || needUflag;
					i += consumed - 1;
					hasMagic = hasMagic || magic;
					continue;
				}
			}
			if (c === "?") {
				re += qmark;
				hasMagic = true;
				continue;
			}
			re += regExpEscape$1(c);
		}
		return [
			re,
			unescape(glob),
			!!hasMagic,
			uflag
		];
	}
};
_a = AST;
//#endregion
//#region ../../node_modules/.pnpm/minimatch@10.2.4/node_modules/minimatch/dist/esm/escape.js
/**
* Escape all magic characters in a glob pattern.
*
* If the {@link MinimatchOptions.windowsPathsNoEscape}
* option is used, then characters are escaped by wrapping in `[]`, because
* a magic character wrapped in a character class can only be satisfied by
* that exact character.  In this mode, `\` is _not_ escaped, because it is
* not interpreted as a magic character, but instead as a path separator.
*
* If the {@link MinimatchOptions.magicalBraces} option is used,
* then braces (`{` and `}`) will be escaped.
*/
const escape = (s, { windowsPathsNoEscape = false, magicalBraces = false } = {}) => {
	if (magicalBraces) return windowsPathsNoEscape ? s.replace(/[?*()[\]{}]/g, "[$&]") : s.replace(/[?*()[\]\\{}]/g, "\\$&");
	return windowsPathsNoEscape ? s.replace(/[?*()[\]]/g, "[$&]") : s.replace(/[?*()[\]\\]/g, "\\$&");
};
//#endregion
//#region ../../node_modules/.pnpm/minimatch@10.2.4/node_modules/minimatch/dist/esm/index.js
const minimatch = (p, pattern, options = {}) => {
	assertValidPattern(pattern);
	if (!options.nocomment && pattern.charAt(0) === "#") return false;
	return new Minimatch(pattern, options).match(p);
};
const starDotExtRE = /^\*+([^+@!?\*\[\(]*)$/;
const starDotExtTest = (ext) => (f) => !f.startsWith(".") && f.endsWith(ext);
const starDotExtTestDot = (ext) => (f) => f.endsWith(ext);
const starDotExtTestNocase = (ext) => {
	ext = ext.toLowerCase();
	return (f) => !f.startsWith(".") && f.toLowerCase().endsWith(ext);
};
const starDotExtTestNocaseDot = (ext) => {
	ext = ext.toLowerCase();
	return (f) => f.toLowerCase().endsWith(ext);
};
const starDotStarRE = /^\*+\.\*+$/;
const starDotStarTest = (f) => !f.startsWith(".") && f.includes(".");
const starDotStarTestDot = (f) => f !== "." && f !== ".." && f.includes(".");
const dotStarRE = /^\.\*+$/;
const dotStarTest = (f) => f !== "." && f !== ".." && f.startsWith(".");
const starRE = /^\*+$/;
const starTest = (f) => f.length !== 0 && !f.startsWith(".");
const starTestDot = (f) => f.length !== 0 && f !== "." && f !== "..";
const qmarksRE = /^\?+([^+@!?\*\[\(]*)?$/;
const qmarksTestNocase = ([$0, ext = ""]) => {
	const noext = qmarksTestNoExt([$0]);
	if (!ext) return noext;
	ext = ext.toLowerCase();
	return (f) => noext(f) && f.toLowerCase().endsWith(ext);
};
const qmarksTestNocaseDot = ([$0, ext = ""]) => {
	const noext = qmarksTestNoExtDot([$0]);
	if (!ext) return noext;
	ext = ext.toLowerCase();
	return (f) => noext(f) && f.toLowerCase().endsWith(ext);
};
const qmarksTestDot = ([$0, ext = ""]) => {
	const noext = qmarksTestNoExtDot([$0]);
	return !ext ? noext : (f) => noext(f) && f.endsWith(ext);
};
const qmarksTest = ([$0, ext = ""]) => {
	const noext = qmarksTestNoExt([$0]);
	return !ext ? noext : (f) => noext(f) && f.endsWith(ext);
};
const qmarksTestNoExt = ([$0]) => {
	const len = $0.length;
	return (f) => f.length === len && !f.startsWith(".");
};
const qmarksTestNoExtDot = ([$0]) => {
	const len = $0.length;
	return (f) => f.length === len && f !== "." && f !== "..";
};
/* c8 ignore start */
const defaultPlatform = typeof process === "object" && process ? typeof process.env === "object" && process.env && process.env.__MINIMATCH_TESTING_PLATFORM__ || process.platform : "posix";
const path$1 = {
	win32: { sep: "\\" },
	posix: { sep: "/" }
};
minimatch.sep = defaultPlatform === "win32" ? path$1.win32.sep : path$1.posix.sep;
const GLOBSTAR = Symbol("globstar **");
minimatch.GLOBSTAR = GLOBSTAR;
const star = "[^/]*?";
const twoStarDot = "(?:(?!(?:\\/|^)(?:\\.{1,2})($|\\/)).)*?";
const twoStarNoDot = "(?:(?!(?:\\/|^)\\.).)*?";
const filter = (pattern, options = {}) => (p) => minimatch(p, pattern, options);
minimatch.filter = filter;
const ext = (a, b = {}) => Object.assign({}, a, b);
const defaults = (def) => {
	if (!def || typeof def !== "object" || !Object.keys(def).length) return minimatch;
	const orig = minimatch;
	const m = (p, pattern, options = {}) => orig(p, pattern, ext(def, options));
	return Object.assign(m, {
		Minimatch: class Minimatch extends orig.Minimatch {
			constructor(pattern, options = {}) {
				super(pattern, ext(def, options));
			}
			static defaults(options) {
				return orig.defaults(ext(def, options)).Minimatch;
			}
		},
		AST: class AST extends orig.AST {
			/* c8 ignore start */
			constructor(type, parent, options = {}) {
				super(type, parent, ext(def, options));
			}
			/* c8 ignore stop */
			static fromGlob(pattern, options = {}) {
				return orig.AST.fromGlob(pattern, ext(def, options));
			}
		},
		unescape: (s, options = {}) => orig.unescape(s, ext(def, options)),
		escape: (s, options = {}) => orig.escape(s, ext(def, options)),
		filter: (pattern, options = {}) => orig.filter(pattern, ext(def, options)),
		defaults: (options) => orig.defaults(ext(def, options)),
		makeRe: (pattern, options = {}) => orig.makeRe(pattern, ext(def, options)),
		braceExpand: (pattern, options = {}) => orig.braceExpand(pattern, ext(def, options)),
		match: (list, pattern, options = {}) => orig.match(list, pattern, ext(def, options)),
		sep: orig.sep,
		GLOBSTAR
	});
};
minimatch.defaults = defaults;
const braceExpand = (pattern, options = {}) => {
	assertValidPattern(pattern);
	if (options.nobrace || !/\{(?:(?!\{).)*\}/.test(pattern)) return [pattern];
	return expand(pattern, { max: options.braceExpandMax });
};
minimatch.braceExpand = braceExpand;
const makeRe = (pattern, options = {}) => new Minimatch(pattern, options).makeRe();
minimatch.makeRe = makeRe;
const match = (list, pattern, options = {}) => {
	const mm = new Minimatch(pattern, options);
	list = list.filter((f) => mm.match(f));
	if (mm.options.nonull && !list.length) list.push(pattern);
	return list;
};
minimatch.match = match;
const globMagic = /[?*]|[+@!]\(.*?\)|\[|\]/;
const regExpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
var Minimatch = class {
	options;
	set;
	pattern;
	windowsPathsNoEscape;
	nonegate;
	negate;
	comment;
	empty;
	preserveMultipleSlashes;
	partial;
	globSet;
	globParts;
	nocase;
	isWindows;
	platform;
	windowsNoMagicRoot;
	maxGlobstarRecursion;
	regexp;
	constructor(pattern, options = {}) {
		assertValidPattern(pattern);
		options = options || {};
		this.options = options;
		this.maxGlobstarRecursion = options.maxGlobstarRecursion ?? 200;
		this.pattern = pattern;
		this.platform = options.platform || defaultPlatform;
		this.isWindows = this.platform === "win32";
		this.windowsPathsNoEscape = !!options.windowsPathsNoEscape || options["allowWindowsEscape"] === false;
		if (this.windowsPathsNoEscape) this.pattern = this.pattern.replace(/\\/g, "/");
		this.preserveMultipleSlashes = !!options.preserveMultipleSlashes;
		this.regexp = null;
		this.negate = false;
		this.nonegate = !!options.nonegate;
		this.comment = false;
		this.empty = false;
		this.partial = !!options.partial;
		this.nocase = !!this.options.nocase;
		this.windowsNoMagicRoot = options.windowsNoMagicRoot !== void 0 ? options.windowsNoMagicRoot : !!(this.isWindows && this.nocase);
		this.globSet = [];
		this.globParts = [];
		this.set = [];
		this.make();
	}
	hasMagic() {
		if (this.options.magicalBraces && this.set.length > 1) return true;
		for (const pattern of this.set) for (const part of pattern) if (typeof part !== "string") return true;
		return false;
	}
	debug(..._) {}
	make() {
		const pattern = this.pattern;
		const options = this.options;
		if (!options.nocomment && pattern.charAt(0) === "#") {
			this.comment = true;
			return;
		}
		if (!pattern) {
			this.empty = true;
			return;
		}
		this.parseNegate();
		this.globSet = [...new Set(this.braceExpand())];
		if (options.debug) this.debug = (...args) => console.error(...args);
		this.debug(this.pattern, this.globSet);
		const rawGlobParts = this.globSet.map((s) => this.slashSplit(s));
		this.globParts = this.preprocess(rawGlobParts);
		this.debug(this.pattern, this.globParts);
		let set = this.globParts.map((s, _, __) => {
			if (this.isWindows && this.windowsNoMagicRoot) {
				const isUNC = s[0] === "" && s[1] === "" && (s[2] === "?" || !globMagic.test(s[2])) && !globMagic.test(s[3]);
				const isDrive = /^[a-z]:/i.test(s[0]);
				if (isUNC) return [...s.slice(0, 4), ...s.slice(4).map((ss) => this.parse(ss))];
				else if (isDrive) return [s[0], ...s.slice(1).map((ss) => this.parse(ss))];
			}
			return s.map((ss) => this.parse(ss));
		});
		this.debug(this.pattern, set);
		this.set = set.filter((s) => s.indexOf(false) === -1);
		if (this.isWindows) for (let i = 0; i < this.set.length; i++) {
			const p = this.set[i];
			if (p[0] === "" && p[1] === "" && this.globParts[i][2] === "?" && typeof p[3] === "string" && /^[a-z]:$/i.test(p[3])) p[2] = "?";
		}
		this.debug(this.pattern, this.set);
	}
	preprocess(globParts) {
		if (this.options.noglobstar) {
			for (let i = 0; i < globParts.length; i++) for (let j = 0; j < globParts[i].length; j++) if (globParts[i][j] === "**") globParts[i][j] = "*";
		}
		const { optimizationLevel = 1 } = this.options;
		if (optimizationLevel >= 2) {
			globParts = this.firstPhasePreProcess(globParts);
			globParts = this.secondPhasePreProcess(globParts);
		} else if (optimizationLevel >= 1) globParts = this.levelOneOptimize(globParts);
		else globParts = this.adjascentGlobstarOptimize(globParts);
		return globParts;
	}
	adjascentGlobstarOptimize(globParts) {
		return globParts.map((parts) => {
			let gs = -1;
			while (-1 !== (gs = parts.indexOf("**", gs + 1))) {
				let i = gs;
				while (parts[i + 1] === "**") i++;
				if (i !== gs) parts.splice(gs, i - gs);
			}
			return parts;
		});
	}
	levelOneOptimize(globParts) {
		return globParts.map((parts) => {
			parts = parts.reduce((set, part) => {
				const prev = set[set.length - 1];
				if (part === "**" && prev === "**") return set;
				if (part === "..") {
					if (prev && prev !== ".." && prev !== "." && prev !== "**") {
						set.pop();
						return set;
					}
				}
				set.push(part);
				return set;
			}, []);
			return parts.length === 0 ? [""] : parts;
		});
	}
	levelTwoFileOptimize(parts) {
		if (!Array.isArray(parts)) parts = this.slashSplit(parts);
		let didSomething = false;
		do {
			didSomething = false;
			if (!this.preserveMultipleSlashes) {
				for (let i = 1; i < parts.length - 1; i++) {
					const p = parts[i];
					if (i === 1 && p === "" && parts[0] === "") continue;
					if (p === "." || p === "") {
						didSomething = true;
						parts.splice(i, 1);
						i--;
					}
				}
				if (parts[0] === "." && parts.length === 2 && (parts[1] === "." || parts[1] === "")) {
					didSomething = true;
					parts.pop();
				}
			}
			let dd = 0;
			while (-1 !== (dd = parts.indexOf("..", dd + 1))) {
				const p = parts[dd - 1];
				if (p && p !== "." && p !== ".." && p !== "**") {
					didSomething = true;
					parts.splice(dd - 1, 2);
					dd -= 2;
				}
			}
		} while (didSomething);
		return parts.length === 0 ? [""] : parts;
	}
	firstPhasePreProcess(globParts) {
		let didSomething = false;
		do {
			didSomething = false;
			for (let parts of globParts) {
				let gs = -1;
				while (-1 !== (gs = parts.indexOf("**", gs + 1))) {
					let gss = gs;
					while (parts[gss + 1] === "**") gss++;
					if (gss > gs) parts.splice(gs + 1, gss - gs);
					let next = parts[gs + 1];
					const p = parts[gs + 2];
					const p2 = parts[gs + 3];
					if (next !== "..") continue;
					if (!p || p === "." || p === ".." || !p2 || p2 === "." || p2 === "..") continue;
					didSomething = true;
					parts.splice(gs, 1);
					const other = parts.slice(0);
					other[gs] = "**";
					globParts.push(other);
					gs--;
				}
				if (!this.preserveMultipleSlashes) {
					for (let i = 1; i < parts.length - 1; i++) {
						const p = parts[i];
						if (i === 1 && p === "" && parts[0] === "") continue;
						if (p === "." || p === "") {
							didSomething = true;
							parts.splice(i, 1);
							i--;
						}
					}
					if (parts[0] === "." && parts.length === 2 && (parts[1] === "." || parts[1] === "")) {
						didSomething = true;
						parts.pop();
					}
				}
				let dd = 0;
				while (-1 !== (dd = parts.indexOf("..", dd + 1))) {
					const p = parts[dd - 1];
					if (p && p !== "." && p !== ".." && p !== "**") {
						didSomething = true;
						const splin = dd === 1 && parts[dd + 1] === "**" ? ["."] : [];
						parts.splice(dd - 1, 2, ...splin);
						if (parts.length === 0) parts.push("");
						dd -= 2;
					}
				}
			}
		} while (didSomething);
		return globParts;
	}
	secondPhasePreProcess(globParts) {
		for (let i = 0; i < globParts.length - 1; i++) for (let j = i + 1; j < globParts.length; j++) {
			const matched = this.partsMatch(globParts[i], globParts[j], !this.preserveMultipleSlashes);
			if (matched) {
				globParts[i] = [];
				globParts[j] = matched;
				break;
			}
		}
		return globParts.filter((gs) => gs.length);
	}
	partsMatch(a, b, emptyGSMatch = false) {
		let ai = 0;
		let bi = 0;
		let result = [];
		let which = "";
		while (ai < a.length && bi < b.length) if (a[ai] === b[bi]) {
			result.push(which === "b" ? b[bi] : a[ai]);
			ai++;
			bi++;
		} else if (emptyGSMatch && a[ai] === "**" && b[bi] === a[ai + 1]) {
			result.push(a[ai]);
			ai++;
		} else if (emptyGSMatch && b[bi] === "**" && a[ai] === b[bi + 1]) {
			result.push(b[bi]);
			bi++;
		} else if (a[ai] === "*" && b[bi] && (this.options.dot || !b[bi].startsWith(".")) && b[bi] !== "**") {
			if (which === "b") return false;
			which = "a";
			result.push(a[ai]);
			ai++;
			bi++;
		} else if (b[bi] === "*" && a[ai] && (this.options.dot || !a[ai].startsWith(".")) && a[ai] !== "**") {
			if (which === "a") return false;
			which = "b";
			result.push(b[bi]);
			ai++;
			bi++;
		} else return false;
		return a.length === b.length && result;
	}
	parseNegate() {
		if (this.nonegate) return;
		const pattern = this.pattern;
		let negate = false;
		let negateOffset = 0;
		for (let i = 0; i < pattern.length && pattern.charAt(i) === "!"; i++) {
			negate = !negate;
			negateOffset++;
		}
		if (negateOffset) this.pattern = pattern.slice(negateOffset);
		this.negate = negate;
	}
	matchOne(file, pattern, partial = false) {
		let fileStartIndex = 0;
		let patternStartIndex = 0;
		if (this.isWindows) {
			const fileDrive = typeof file[0] === "string" && /^[a-z]:$/i.test(file[0]);
			const fileUNC = !fileDrive && file[0] === "" && file[1] === "" && file[2] === "?" && /^[a-z]:$/i.test(file[3]);
			const patternDrive = typeof pattern[0] === "string" && /^[a-z]:$/i.test(pattern[0]);
			const patternUNC = !patternDrive && pattern[0] === "" && pattern[1] === "" && pattern[2] === "?" && typeof pattern[3] === "string" && /^[a-z]:$/i.test(pattern[3]);
			const fdi = fileUNC ? 3 : fileDrive ? 0 : void 0;
			const pdi = patternUNC ? 3 : patternDrive ? 0 : void 0;
			if (typeof fdi === "number" && typeof pdi === "number") {
				const [fd, pd] = [file[fdi], pattern[pdi]];
				if (fd.toLowerCase() === pd.toLowerCase()) {
					pattern[pdi] = fd;
					patternStartIndex = pdi;
					fileStartIndex = fdi;
				}
			}
		}
		const { optimizationLevel = 1 } = this.options;
		if (optimizationLevel >= 2) file = this.levelTwoFileOptimize(file);
		if (pattern.includes(GLOBSTAR)) return this.#matchGlobstar(file, pattern, partial, fileStartIndex, patternStartIndex);
		return this.#matchOne(file, pattern, partial, fileStartIndex, patternStartIndex);
	}
	#matchGlobstar(file, pattern, partial, fileIndex, patternIndex) {
		const firstgs = pattern.indexOf(GLOBSTAR, patternIndex);
		const lastgs = pattern.lastIndexOf(GLOBSTAR);
		const [head, body, tail] = partial ? [
			pattern.slice(patternIndex, firstgs),
			pattern.slice(firstgs + 1),
			[]
		] : [
			pattern.slice(patternIndex, firstgs),
			pattern.slice(firstgs + 1, lastgs),
			pattern.slice(lastgs + 1)
		];
		if (head.length) {
			const fileHead = file.slice(fileIndex, fileIndex + head.length);
			if (!this.#matchOne(fileHead, head, partial, 0, 0)) return false;
			fileIndex += head.length;
			patternIndex += head.length;
		}
		let fileTailMatch = 0;
		if (tail.length) {
			if (tail.length + fileIndex > file.length) return false;
			let tailStart = file.length - tail.length;
			if (this.#matchOne(file, tail, partial, tailStart, 0)) fileTailMatch = tail.length;
			else {
				if (file[file.length - 1] !== "" || fileIndex + tail.length === file.length) return false;
				tailStart--;
				if (!this.#matchOne(file, tail, partial, tailStart, 0)) return false;
				fileTailMatch = tail.length + 1;
			}
		}
		if (!body.length) {
			let sawSome = !!fileTailMatch;
			for (let i = fileIndex; i < file.length - fileTailMatch; i++) {
				const f = String(file[i]);
				sawSome = true;
				if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) return false;
			}
			return partial || sawSome;
		}
		const bodySegments = [[[], 0]];
		let currentBody = bodySegments[0];
		let nonGsParts = 0;
		const nonGsPartsSums = [0];
		for (const b of body) if (b === GLOBSTAR) {
			nonGsPartsSums.push(nonGsParts);
			currentBody = [[], 0];
			bodySegments.push(currentBody);
		} else {
			currentBody[0].push(b);
			nonGsParts++;
		}
		let i = bodySegments.length - 1;
		const fileLength = file.length - fileTailMatch;
		for (const b of bodySegments) b[1] = fileLength - (nonGsPartsSums[i--] + b[0].length);
		return !!this.#matchGlobStarBodySections(file, bodySegments, fileIndex, 0, partial, 0, !!fileTailMatch);
	}
	#matchGlobStarBodySections(file, bodySegments, fileIndex, bodyIndex, partial, globStarDepth, sawTail) {
		const bs = bodySegments[bodyIndex];
		if (!bs) {
			for (let i = fileIndex; i < file.length; i++) {
				sawTail = true;
				const f = file[i];
				if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) return false;
			}
			return sawTail;
		}
		const [body, after] = bs;
		while (fileIndex <= after) {
			if (this.#matchOne(file.slice(0, fileIndex + body.length), body, partial, fileIndex, 0) && globStarDepth < this.maxGlobstarRecursion) {
				const sub = this.#matchGlobStarBodySections(file, bodySegments, fileIndex + body.length, bodyIndex + 1, partial, globStarDepth + 1, sawTail);
				if (sub !== false) return sub;
			}
			const f = file[fileIndex];
			if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) return false;
			fileIndex++;
		}
		return partial || null;
	}
	#matchOne(file, pattern, partial, fileIndex, patternIndex) {
		let fi;
		let pi;
		let pl;
		let fl;
		for (fi = fileIndex, pi = patternIndex, fl = file.length, pl = pattern.length; fi < fl && pi < pl; fi++, pi++) {
			this.debug("matchOne loop");
			let p = pattern[pi];
			let f = file[fi];
			this.debug(pattern, p, f);
			/* c8 ignore start */
			if (p === false || p === GLOBSTAR) return false;
			/* c8 ignore stop */
			let hit;
			if (typeof p === "string") {
				hit = f === p;
				this.debug("string match", p, f, hit);
			} else {
				hit = p.test(f);
				this.debug("pattern match", p, f, hit);
			}
			if (!hit) return false;
		}
		if (fi === fl && pi === pl) return true;
		else if (fi === fl) return partial;
		else if (pi === pl) return fi === fl - 1 && file[fi] === "";
		else throw new Error("wtf?");
		/* c8 ignore stop */
	}
	braceExpand() {
		return braceExpand(this.pattern, this.options);
	}
	parse(pattern) {
		assertValidPattern(pattern);
		const options = this.options;
		if (pattern === "**") return GLOBSTAR;
		if (pattern === "") return "";
		let m;
		let fastTest = null;
		if (m = pattern.match(starRE)) fastTest = options.dot ? starTestDot : starTest;
		else if (m = pattern.match(starDotExtRE)) fastTest = (options.nocase ? options.dot ? starDotExtTestNocaseDot : starDotExtTestNocase : options.dot ? starDotExtTestDot : starDotExtTest)(m[1]);
		else if (m = pattern.match(qmarksRE)) fastTest = (options.nocase ? options.dot ? qmarksTestNocaseDot : qmarksTestNocase : options.dot ? qmarksTestDot : qmarksTest)(m);
		else if (m = pattern.match(starDotStarRE)) fastTest = options.dot ? starDotStarTestDot : starDotStarTest;
		else if (m = pattern.match(dotStarRE)) fastTest = dotStarTest;
		const re = AST.fromGlob(pattern, this.options).toMMPattern();
		if (fastTest && typeof re === "object") Reflect.defineProperty(re, "test", { value: fastTest });
		return re;
	}
	makeRe() {
		if (this.regexp || this.regexp === false) return this.regexp;
		const set = this.set;
		if (!set.length) {
			this.regexp = false;
			return this.regexp;
		}
		const options = this.options;
		const twoStar = options.noglobstar ? star : options.dot ? twoStarDot : twoStarNoDot;
		const flags = new Set(options.nocase ? ["i"] : []);
		let re = set.map((pattern) => {
			const pp = pattern.map((p) => {
				if (p instanceof RegExp) for (const f of p.flags.split("")) flags.add(f);
				return typeof p === "string" ? regExpEscape(p) : p === GLOBSTAR ? GLOBSTAR : p._src;
			});
			pp.forEach((p, i) => {
				const next = pp[i + 1];
				const prev = pp[i - 1];
				if (p !== GLOBSTAR || prev === GLOBSTAR) return;
				if (prev === void 0) if (next !== void 0 && next !== GLOBSTAR) pp[i + 1] = "(?:\\/|" + twoStar + "\\/)?" + next;
				else pp[i] = twoStar;
				else if (next === void 0) pp[i - 1] = prev + "(?:\\/|\\/" + twoStar + ")?";
				else if (next !== GLOBSTAR) {
					pp[i - 1] = prev + "(?:\\/|\\/" + twoStar + "\\/)" + next;
					pp[i + 1] = GLOBSTAR;
				}
			});
			const filtered = pp.filter((p) => p !== GLOBSTAR);
			if (this.partial && filtered.length >= 1) {
				const prefixes = [];
				for (let i = 1; i <= filtered.length; i++) prefixes.push(filtered.slice(0, i).join("/"));
				return "(?:" + prefixes.join("|") + ")";
			}
			return filtered.join("/");
		}).join("|");
		const [open, close] = set.length > 1 ? ["(?:", ")"] : ["", ""];
		re = "^" + open + re + close + "$";
		if (this.partial) re = "^(?:\\/|" + open + re.slice(1, -1) + close + ")$";
		if (this.negate) re = "^(?!" + re + ").+$";
		try {
			this.regexp = new RegExp(re, [...flags].join(""));
		} catch (ex) {
			this.regexp = false;
		}
		/* c8 ignore stop */
		return this.regexp;
	}
	slashSplit(p) {
		if (this.preserveMultipleSlashes) return p.split("/");
		else if (this.isWindows && /^\/\/[^\/]+/.test(p)) return ["", ...p.split(/\/+/)];
		else return p.split(/\/+/);
	}
	match(f, partial = this.partial) {
		this.debug("match", f, this.pattern);
		if (this.comment) return false;
		if (this.empty) return f === "";
		if (f === "/" && partial) return true;
		const options = this.options;
		if (this.isWindows) f = f.split("\\").join("/");
		const ff = this.slashSplit(f);
		this.debug(this.pattern, "split", ff);
		const set = this.set;
		this.debug(this.pattern, "set", set);
		let filename = ff[ff.length - 1];
		if (!filename) for (let i = ff.length - 2; !filename && i >= 0; i--) filename = ff[i];
		for (let i = 0; i < set.length; i++) {
			const pattern = set[i];
			let file = ff;
			if (options.matchBase && pattern.length === 1) file = [filename];
			if (this.matchOne(file, pattern, partial)) {
				if (options.flipNegate) return true;
				return !this.negate;
			}
		}
		if (options.flipNegate) return false;
		return this.negate;
	}
	static defaults(def) {
		return minimatch.defaults(def).Minimatch;
	}
};
/* c8 ignore stop */
minimatch.AST = AST;
minimatch.Minimatch = Minimatch;
minimatch.escape = escape;
minimatch.unescape = unescape;
//#endregion
//#region ../../node_modules/.pnpm/@vercel+queue@0.1.4/node_modules/@vercel/queue/dist/index.mjs
var import_picocolors = /* @__PURE__ */ __toESM((/* @__PURE__ */ __commonJSMin(((exports, module) => {
	let p = process || {}, argv = p.argv || [], env = p.env || {};
	let isColorSupported = !(!!env.NO_COLOR || argv.includes("--no-color")) && (!!env.FORCE_COLOR || argv.includes("--color") || p.platform === "win32" || (p.stdout || {}).isTTY && env.TERM !== "dumb" || !!env.CI);
	let formatter = (open, close, replace = open) => (input) => {
		let string = "" + input, index = string.indexOf(close, open.length);
		return ~index ? open + replaceClose(string, close, replace, index) + close : open + string + close;
	};
	let replaceClose = (string, close, replace, index) => {
		let result = "", cursor = 0;
		do {
			result += string.substring(cursor, index) + replace;
			cursor = index + close.length;
			index = string.indexOf(close, cursor);
		} while (~index);
		return result + string.substring(cursor);
	};
	let createColors = (enabled = isColorSupported) => {
		let f = enabled ? formatter : () => String;
		return {
			isColorSupported: enabled,
			reset: f("\x1B[0m", "\x1B[0m"),
			bold: f("\x1B[1m", "\x1B[22m", "\x1B[22m\x1B[1m"),
			dim: f("\x1B[2m", "\x1B[22m", "\x1B[22m\x1B[2m"),
			italic: f("\x1B[3m", "\x1B[23m"),
			underline: f("\x1B[4m", "\x1B[24m"),
			inverse: f("\x1B[7m", "\x1B[27m"),
			hidden: f("\x1B[8m", "\x1B[28m"),
			strikethrough: f("\x1B[9m", "\x1B[29m"),
			black: f("\x1B[30m", "\x1B[39m"),
			red: f("\x1B[31m", "\x1B[39m"),
			green: f("\x1B[32m", "\x1B[39m"),
			yellow: f("\x1B[33m", "\x1B[39m"),
			blue: f("\x1B[34m", "\x1B[39m"),
			magenta: f("\x1B[35m", "\x1B[39m"),
			cyan: f("\x1B[36m", "\x1B[39m"),
			white: f("\x1B[37m", "\x1B[39m"),
			gray: f("\x1B[90m", "\x1B[39m"),
			bgBlack: f("\x1B[40m", "\x1B[49m"),
			bgRed: f("\x1B[41m", "\x1B[49m"),
			bgGreen: f("\x1B[42m", "\x1B[49m"),
			bgYellow: f("\x1B[43m", "\x1B[49m"),
			bgBlue: f("\x1B[44m", "\x1B[49m"),
			bgMagenta: f("\x1B[45m", "\x1B[49m"),
			bgCyan: f("\x1B[46m", "\x1B[49m"),
			bgWhite: f("\x1B[47m", "\x1B[49m"),
			blackBright: f("\x1B[90m", "\x1B[39m"),
			redBright: f("\x1B[91m", "\x1B[39m"),
			greenBright: f("\x1B[92m", "\x1B[39m"),
			yellowBright: f("\x1B[93m", "\x1B[39m"),
			blueBright: f("\x1B[94m", "\x1B[39m"),
			magentaBright: f("\x1B[95m", "\x1B[39m"),
			cyanBright: f("\x1B[96m", "\x1B[39m"),
			whiteBright: f("\x1B[97m", "\x1B[39m"),
			bgBlackBright: f("\x1B[100m", "\x1B[49m"),
			bgRedBright: f("\x1B[101m", "\x1B[49m"),
			bgGreenBright: f("\x1B[102m", "\x1B[49m"),
			bgYellowBright: f("\x1B[103m", "\x1B[49m"),
			bgBlueBright: f("\x1B[104m", "\x1B[49m"),
			bgMagentaBright: f("\x1B[105m", "\x1B[49m"),
			bgCyanBright: f("\x1B[106m", "\x1B[49m"),
			bgWhiteBright: f("\x1B[107m", "\x1B[49m")
		};
	};
	module.exports = createColors();
	module.exports.createColors = createColors;
})))(), 1);
var import_dist = require_dist();
async function streamToBuffer(stream) {
	let totalLength = 0;
	const reader = stream.getReader();
	const chunks = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			totalLength += value.length;
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, totalLength);
}
var JsonTransport = class {
	contentType = "application/json";
	replacer;
	reviver;
	/**
	* Create a new JsonTransport.
	* @param options - Optional JSON serialization options
	* @param options.replacer - Custom replacer for JSON.stringify
	* @param options.reviver - Custom reviver for JSON.parse
	*/
	constructor(options = {}) {
		this.replacer = options.replacer;
		this.reviver = options.reviver;
	}
	serialize(value) {
		return Buffer.from(JSON.stringify(value, this.replacer), "utf8");
	}
	async deserialize(stream) {
		const buffer = await streamToBuffer(stream);
		return JSON.parse(buffer.toString("utf8"), this.reviver);
	}
};
var MessageNotFoundError = class extends Error {
	constructor(messageId) {
		super(`Message ${messageId} not found`);
		this.name = "MessageNotFoundError";
	}
};
var MessageNotAvailableError = class extends Error {
	constructor(messageId, reason) {
		super(`Message ${messageId} not available for processing${reason ? `: ${reason}` : ""}`);
		this.name = "MessageNotAvailableError";
	}
};
var MessageCorruptedError = class extends Error {
	constructor(messageId, reason) {
		super(`Message ${messageId} is corrupted: ${reason}`);
		this.name = "MessageCorruptedError";
	}
};
var UnauthorizedError = class extends Error {
	constructor(message = "Missing or invalid authentication token") {
		super(message);
		this.name = "UnauthorizedError";
	}
};
var ForbiddenError = class extends Error {
	constructor(message = "Queue environment doesn't match token environment") {
		super(message);
		this.name = "ForbiddenError";
	}
};
var BadRequestError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "BadRequestError";
	}
};
var InternalServerError = class extends Error {
	constructor(message = "Unexpected server error") {
		super(message);
		this.name = "InternalServerError";
	}
};
var InvalidLimitError = class extends Error {
	constructor(limit, min = 1, max = 10) {
		super(`Invalid limit: ${limit}. Limit must be between ${min} and ${max}.`);
		this.name = "InvalidLimitError";
	}
};
var MessageAlreadyProcessedError = class extends Error {
	constructor(messageId) {
		super(`Message ${messageId} has already been processed`);
		this.name = "MessageAlreadyProcessedError";
	}
};
var DuplicateMessageError = class extends Error {
	idempotencyKey;
	constructor(message, idempotencyKey) {
		super(message);
		this.name = "DuplicateMessageError";
		this.idempotencyKey = idempotencyKey;
	}
};
var ConsumerDiscoveryError = class extends Error {
	deploymentId;
	constructor(message, deploymentId) {
		super(message);
		this.name = "ConsumerDiscoveryError";
		this.deploymentId = deploymentId;
	}
};
var ConsumerRegistryNotConfiguredError = class extends Error {
	constructor(message = "Consumer registry not configured") {
		super(message);
		this.name = "ConsumerRegistryNotConfiguredError";
	}
};
var DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 300;
var MIN_VISIBILITY_TIMEOUT_SECONDS = 30;
var MAX_RENEWAL_INTERVAL_SECONDS = 60;
var MIN_RENEWAL_INTERVAL_SECONDS = 10;
var RETRY_INTERVAL_MS = 3e3;
function calculateRenewalInterval(visibilityTimeoutSeconds) {
	return Math.min(MAX_RENEWAL_INTERVAL_SECONDS, Math.max(MIN_RENEWAL_INTERVAL_SECONDS, visibilityTimeoutSeconds / 5));
}
var ConsumerGroup = class {
	client;
	topicName;
	consumerGroupName;
	visibilityTimeout;
	/**
	* Create a new ConsumerGroup instance.
	*
	* @param client - ApiClient instance to use for API calls (transport is configured on the client)
	* @param topicName - Name of the topic to consume from (pattern: `[A-Za-z0-9_-]+`)
	* @param consumerGroupName - Name of the consumer group (pattern: `[A-Za-z0-9_-]+`)
	* @param options - Optional configuration
	* @param options.visibilityTimeoutSeconds - Message lock duration (default: 300, max: 3600)
	*/
	constructor(client, topicName, consumerGroupName, options = {}) {
		this.client = client;
		this.topicName = topicName;
		this.consumerGroupName = consumerGroupName;
		this.visibilityTimeout = Math.max(MIN_VISIBILITY_TIMEOUT_SECONDS, options.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS);
	}
	/**
	* Check if an error is a 4xx client error that should stop retries.
	* 4xx errors indicate the request is fundamentally invalid and retrying won't help.
	* - 409: Ticket mismatch (lost ownership to another consumer)
	* - 404: Message/receipt handle not found
	* - 400, 401, 403: Other client errors
	*/
	isClientError(error) {
		return error instanceof MessageNotAvailableError || error instanceof MessageNotFoundError || error instanceof BadRequestError || error instanceof UnauthorizedError || error instanceof ForbiddenError;
	}
	/**
	* Starts a background loop that periodically extends the visibility timeout for a message.
	*
	* Timing strategy:
	* - Renewal interval: min(60s, max(10s, visibilityTimeout/5))
	* - Extensions request the same duration as the initial visibility timeout
	* - When `visibilityDeadline` is provided (binary mode small body), the first
	*   extension delay is calculated from the time remaining until the deadline
	*   using the same renewal formula, ensuring the first extension fires before
	*   the server-assigned lease expires. Subsequent renewals use the standard interval.
	*
	* Retry strategy:
	* - On transient failures (5xx, network errors): retry every 3 seconds
	* - On 4xx client errors: stop retrying (the lease is lost or invalid)
	*
	* @param receiptHandle - The receipt handle to extend visibility for
	* @param options - Optional configuration
	* @param options.visibilityDeadline - Absolute deadline (from server's `ce-vqsvisibilitydeadline`)
	*   when the current visibility timeout expires. Used to calculate the first extension delay.
	*/
	startVisibilityExtension(receiptHandle, options) {
		let isRunning = true;
		let isResolved = false;
		let resolveLifecycle;
		let timeoutId = null;
		const renewalIntervalMs = calculateRenewalInterval(this.visibilityTimeout) * 1e3;
		let firstDelayMs = renewalIntervalMs;
		if (options?.visibilityDeadline) {
			const timeRemainingMs = options.visibilityDeadline.getTime() - Date.now();
			if (timeRemainingMs > 0) firstDelayMs = calculateRenewalInterval(timeRemainingMs / 1e3) * 1e3;
			else firstDelayMs = 0;
		}
		const lifecyclePromise = new Promise((resolve2) => {
			resolveLifecycle = resolve2;
		});
		const safeResolve = () => {
			if (!isResolved) {
				isResolved = true;
				resolveLifecycle();
			}
		};
		const extend = async () => {
			if (!isRunning) {
				safeResolve();
				return;
			}
			try {
				await this.client.changeVisibility({
					queueName: this.topicName,
					consumerGroup: this.consumerGroupName,
					receiptHandle,
					visibilityTimeoutSeconds: this.visibilityTimeout
				});
				if (isRunning) timeoutId = setTimeout(() => extend(), renewalIntervalMs);
				else safeResolve();
			} catch (error) {
				if (this.isClientError(error)) {
					console.error(`Visibility extension failed with client error for receipt handle ${receiptHandle} (stopping retries):`, error);
					safeResolve();
					return;
				}
				console.error(`Failed to extend visibility for receipt handle ${receiptHandle} (will retry in ${RETRY_INTERVAL_MS / 1e3}s):`, error);
				if (isRunning) timeoutId = setTimeout(() => extend(), RETRY_INTERVAL_MS);
				else safeResolve();
			}
		};
		timeoutId = setTimeout(() => extend(), firstDelayMs);
		return async (waitForCompletion = false) => {
			isRunning = false;
			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = null;
			}
			if (waitForCompletion) await lifecyclePromise;
			else safeResolve();
		};
	}
	/**
	* Clean up the message payload if the transport supports it and payload exists.
	*/
	async finalizePayload(payload) {
		const transport = this.client.getTransport();
		if (transport.finalize && payload !== void 0 && payload !== null) try {
			await transport.finalize(payload);
		} catch (finalizeError) {
			console.warn("Failed to finalize message payload:", finalizeError);
		}
	}
	async processMessage(message, handler, options) {
		const stopExtension = this.startVisibilityExtension(message.receiptHandle, options);
		const metadata = {
			messageId: message.messageId,
			deliveryCount: message.deliveryCount,
			createdAt: message.createdAt,
			expiresAt: message.expiresAt ?? new Date(message.createdAt.getTime() + 864e5),
			topicName: this.topicName,
			consumerGroup: this.consumerGroupName,
			region: this.client.getRegion()
		};
		try {
			await handler(message.payload, metadata);
			await stopExtension();
			await this.client.acknowledgeMessage({
				queueName: this.topicName,
				consumerGroup: this.consumerGroupName,
				receiptHandle: message.receiptHandle
			});
		} catch (error) {
			await stopExtension();
			if (options?.retry) {
				let directive;
				try {
					directive = options.retry(error, metadata);
				} catch (retryError) {
					console.warn("retry handler threw:", retryError);
				}
				if (directive) {
					if ("acknowledge" in directive && directive.acknowledge) {
						try {
							await this.client.acknowledgeMessage({
								queueName: this.topicName,
								consumerGroup: this.consumerGroupName,
								receiptHandle: message.receiptHandle
							});
						} catch (ackError) {
							console.warn("Failed to acknowledge message:", ackError);
						}
						await this.finalizePayload(message.payload);
						return;
					}
					if ("afterSeconds" in directive && typeof directive.afterSeconds === "number") {
						try {
							await this.client.changeVisibility({
								queueName: this.topicName,
								consumerGroup: this.consumerGroupName,
								receiptHandle: message.receiptHandle,
								visibilityTimeoutSeconds: directive.afterSeconds
							});
						} catch (changeError) {
							console.warn("Failed to reschedule message for retry:", changeError);
						}
						await this.finalizePayload(message.payload);
						return;
					}
				}
			}
			await this.finalizePayload(message.payload);
			throw error;
		}
	}
	/**
	* Process a pre-fetched message directly, without calling `receiveMessageById`.
	*
	* Used by the binary mode (v2beta) small body fast path, where the server
	* pushes the full message payload in the callback request. The message is
	* processed with the same lifecycle guarantees as `consume()`:
	* - Visibility timeout is extended periodically during processing
	* - Message is acknowledged on successful handler completion
	* - Payload is finalized on error if the transport supports it
	*
	* @param handler - Function to process the message payload and metadata
	* @param message - The complete message including payload and receipt handle
	* @param options - Optional configuration
	* @param options.visibilityDeadline - Absolute deadline when the server-assigned
	*   visibility timeout expires (from `ce-vqsvisibilitydeadline`). Used to
	*   schedule the first visibility extension before the lease expires.
	*/
	async consumeMessage(handler, message, options) {
		await this.processMessage(message, handler, options);
	}
	async consume(handler, options) {
		const retry = options?.retry;
		if (options && "messageId" in options) {
			const response = await this.client.receiveMessageById({
				queueName: this.topicName,
				consumerGroup: this.consumerGroupName,
				messageId: options.messageId,
				visibilityTimeoutSeconds: this.visibilityTimeout
			});
			await this.processMessage(response.message, handler, { retry });
			return 1;
		} else {
			const limit = options && "limit" in options ? options.limit : 1;
			let messagesProcessed = 0;
			for await (const message of this.client.receiveMessages({
				queueName: this.topicName,
				consumerGroup: this.consumerGroupName,
				visibilityTimeoutSeconds: this.visibilityTimeout,
				limit
			})) {
				messagesProcessed++;
				await this.processMessage(message, handler, { retry });
			}
			return messagesProcessed;
		}
	}
	/**
	* Get the consumer group name
	*/
	get name() {
		return this.consumerGroupName;
	}
	/**
	* Get the topic name this consumer group is subscribed to
	*/
	get topic() {
		return this.topicName;
	}
};
var Topic = class {
	client;
	topicName;
	/**
	* @param client ApiClient instance to use for API calls
	* @param topicName Name of the topic to work with
	*/
	constructor(client, topicName) {
		this.client = client;
		this.topicName = topicName;
	}
	/**
	* Publish a message to the topic
	* @param payload The data to publish
	* @param options Optional publish options
	* @returns `{ messageId }` — `messageId` is `null` when deferred
	* @throws {BadRequestError} When request parameters are invalid
	* @throws {UnauthorizedError} When authentication fails
	* @throws {ForbiddenError} When access is denied (environment mismatch)
	* @throws {InternalServerError} When server encounters an error
	*/
	async publish(payload, options) {
		const result = await this.client.sendMessage({
			queueName: this.topicName,
			payload,
			idempotencyKey: options?.idempotencyKey,
			retentionSeconds: options?.retentionSeconds,
			delaySeconds: options?.delaySeconds,
			headers: options?.headers
		});
		if (result.messageId && isDevMode()) invokeDevHandlers(this.topicName, result.messageId, this.client.getRegion(), options?.delaySeconds, options?.retentionSeconds);
		return { messageId: result.messageId };
	}
	/**
	* Create a consumer group for this topic
	* @param consumerGroupName Name of the consumer group
	* @param options Optional configuration for the consumer group
	* @returns A ConsumerGroup instance
	*/
	consumerGroup(consumerGroupName, options) {
		return new ConsumerGroup(this.client, this.topicName, consumerGroupName, options);
	}
	/**
	* Get the topic name
	*/
	get name() {
		return this.topicName;
	}
};
function matchesWildcardPattern(topicName, pattern) {
	const prefix = pattern.slice(0, -1);
	return topicName.startsWith(prefix);
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function parseV1StructuredBody(body, contentType) {
	if (!contentType || !contentType.includes("application/cloudevents+json")) throw new Error("Invalid content type: expected 'application/cloudevents+json'");
	if (!isRecord(body) || !body.type || !body.source || !body.id || !isRecord(body.data)) throw new Error("Invalid CloudEvent: missing required fields");
	if (body.type !== "com.vercel.queue.v1beta") throw new Error(`Invalid CloudEvent type: expected 'com.vercel.queue.v1beta', got '${String(body.type)}'`);
	const { data } = body;
	const missingFields = [];
	if (!("queueName" in data)) missingFields.push("queueName");
	if (!("consumerGroup" in data)) missingFields.push("consumerGroup");
	if (!("messageId" in data)) missingFields.push("messageId");
	if (missingFields.length > 0) throw new Error(`Missing required CloudEvent data fields: ${missingFields.join(", ")}`);
	return {
		queueName: String(data.queueName),
		consumerGroup: String(data.consumerGroup),
		messageId: String(data.messageId)
	};
}
function getHeader(headers, name) {
	if (headers instanceof Headers) return headers.get(name);
	const value = headers[name];
	if (Array.isArray(value)) return value[0] ?? null;
	return value ?? null;
}
function parseBinaryHeaders(headers) {
	const ceType = getHeader(headers, "ce-type");
	if (ceType !== "com.vercel.queue.v2beta") throw new Error(`Invalid CloudEvent type: expected 'com.vercel.queue.v2beta', got '${ceType}'`);
	const queueName = getHeader(headers, "ce-vqsqueuename");
	const consumerGroup = getHeader(headers, "ce-vqsconsumergroup");
	const messageId = getHeader(headers, "ce-vqsmessageid");
	const missingFields = [];
	if (!queueName) missingFields.push("ce-vqsqueuename");
	if (!consumerGroup) missingFields.push("ce-vqsconsumergroup");
	if (!messageId) missingFields.push("ce-vqsmessageid");
	if (missingFields.length > 0) throw new Error(`Missing required CloudEvent headers: ${missingFields.join(", ")}`);
	const base = {
		queueName,
		consumerGroup,
		messageId,
		region: getHeader(headers, "ce-vqsregion") ?? void 0
	};
	const receiptHandle = getHeader(headers, "ce-vqsreceipthandle");
	if (!receiptHandle) return base;
	const result = {
		...base,
		receiptHandle
	};
	const deliveryCount = getHeader(headers, "ce-vqsdeliverycount");
	if (deliveryCount) result.deliveryCount = parseInt(deliveryCount, 10);
	const createdAt = getHeader(headers, "ce-vqscreatedat");
	if (createdAt) result.createdAt = createdAt;
	const expiresAt = getHeader(headers, "ce-vqsexpiresat");
	if (expiresAt) result.expiresAt = expiresAt;
	const contentType = getHeader(headers, "content-type");
	if (contentType) result.contentType = contentType;
	const visibilityDeadline = getHeader(headers, "ce-vqsvisibilitydeadline");
	if (visibilityDeadline) result.visibilityDeadline = visibilityDeadline;
	return result;
}
function parseRawCallback(body, headers) {
	if (getHeader(headers, "ce-type") === "com.vercel.queue.v2beta") {
		const result = parseBinaryHeaders(headers);
		if ("receiptHandle" in result) result.parsedPayload = body;
		return result;
	}
	return parseV1StructuredBody(body, getHeader(headers, "content-type"));
}
async function parseCallback(request) {
	if (request.headers.get("ce-type") === "com.vercel.queue.v2beta") {
		const result = parseBinaryHeaders(request.headers);
		if ("receiptHandle" in result && request.body) result.rawBody = request.body;
		return result;
	}
	let body;
	try {
		body = await request.json();
	} catch {
		throw new Error("Failed to parse CloudEvent from request body");
	}
	const headers = {};
	request.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return parseRawCallback(body, headers);
}
async function handleCallback(handler, request, options) {
	const { queueName, consumerGroup, messageId } = request;
	if (!options?.client) throw new Error("HandleCallbackOptions.client is required");
	let api = getApiClient(options.client);
	if (request.region) api = api.withRegion(request.region);
	const cg = new Topic(api, queueName).consumerGroup(consumerGroup, options?.visibilityTimeoutSeconds !== void 0 ? { visibilityTimeoutSeconds: options.visibilityTimeoutSeconds } : void 0);
	if ("receiptHandle" in request) {
		const transport = api.getTransport();
		let payload;
		if (request.rawBody) payload = await transport.deserialize(request.rawBody);
		else if (request.parsedPayload !== void 0) payload = request.parsedPayload;
		else throw new Error("Binary mode callback with receipt handle is missing payload");
		const message = {
			messageId,
			payload,
			deliveryCount: request.deliveryCount ?? 1,
			createdAt: request.createdAt ? new Date(request.createdAt) : /* @__PURE__ */ new Date(),
			expiresAt: request.expiresAt ? new Date(request.expiresAt) : void 0,
			contentType: request.contentType ?? transport.contentType,
			receiptHandle: request.receiptHandle
		};
		const visibilityDeadline = request.visibilityDeadline ? new Date(request.visibilityDeadline) : void 0;
		await cg.consumeMessage(handler, message, {
			visibilityDeadline,
			retry: options?.retry
		});
	} else await cg.consume(handler, {
		messageId,
		retry: options?.retry
	});
}
var PREFIX = import_picocolors.default.cyan("[queue]");
var OK = import_picocolors.default.green("✓");
var FAIL = import_picocolors.default.red("✗");
var RETRY = import_picocolors.default.yellow("↻");
function isDevMode() {
	return process.env.NODE_ENV === "development";
}
var ROUTE_MAPPINGS_KEY = Symbol.for("@vercel/queue.devRouteMappings");
function filePathToConsumerGroup(filePath) {
	let result = "";
	for (const char of filePath) if (char === "_") result += "__";
	else if (char === "/") result += "_S";
	else if (char === ".") result += "_D";
	else if (/[A-Za-z0-9-]/.test(char)) result += char;
	else result += "_" + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
	return result;
}
function getDevRouteMappings() {
	const g = globalThis;
	if (ROUTE_MAPPINGS_KEY in g) return g[ROUTE_MAPPINGS_KEY] ?? null;
	try {
		const vercelJsonPath = path.join(process.cwd(), "vercel.json");
		if (!fs$1.existsSync(vercelJsonPath)) {
			g[ROUTE_MAPPINGS_KEY] = null;
			return null;
		}
		const vercelJson = JSON.parse(fs$1.readFileSync(vercelJsonPath, "utf-8"));
		if (!vercelJson.functions) {
			g[ROUTE_MAPPINGS_KEY] = null;
			return null;
		}
		const mappings = [];
		for (const [filePath, config] of Object.entries(vercelJson.functions)) {
			if (!config.experimentalTriggers) continue;
			for (const trigger of config.experimentalTriggers) {
				if (!trigger.type?.startsWith("queue/") || !trigger.topic) continue;
				if (trigger.type !== "queue/v2beta") {
					console.warn(`${PREFIX} Unsupported trigger type "${trigger.type}" for topic "${trigger.topic}" in ${filePath}. Use "queue/v2beta" instead.`);
					continue;
				}
				mappings.push({
					filePath,
					topic: trigger.topic,
					consumer: filePathToConsumerGroup(filePath),
					retryAfterSeconds: trigger.retryAfterSeconds
				});
			}
		}
		g[ROUTE_MAPPINGS_KEY] = mappings.length > 0 ? mappings : null;
		return g[ROUTE_MAPPINGS_KEY];
	} catch (error) {
		console.warn(`${PREFIX} Failed to read vercel.json:`, error);
		g[ROUTE_MAPPINGS_KEY] = null;
		return null;
	}
}
function findMatchingRoutes(topicName) {
	const mappings = getDevRouteMappings();
	if (!mappings) return [];
	return mappings.filter((mapping) => {
		if (mapping.topic.includes("*")) return matchesWildcardPattern(topicName, mapping.topic);
		return mapping.topic === topicName;
	});
}
function findRetryAfterSeconds(topicName, consumerGroup) {
	return findMatchingRoutes(topicName).find((r) => r.consumer === consumerGroup)?.retryAfterSeconds;
}
function stripSrcPrefix(filePath) {
	if (/^src\/(app|pages|server)\//.test(filePath)) return filePath.slice(4);
	return null;
}
function matchesFunctionsPattern(sourceFile, pattern) {
	return sourceFile === pattern || minimatch(sourceFile, pattern);
}
function findMappingsForFile(absolutePath) {
	const mappings = getDevRouteMappings();
	if (!mappings) return [];
	const cwd = process.cwd();
	let relative2;
	try {
		relative2 = path.relative(cwd, absolutePath);
	} catch {
		return [];
	}
	const normalized = relative2.replace(/\\/g, "/");
	const stripped = stripSrcPrefix(normalized);
	return mappings.filter((m) => matchesFunctionsPattern(normalized, m.filePath) || stripped !== null && matchesFunctionsPattern(stripped, m.filePath));
}
function parseFrameFilePath(line) {
	let match = line.match(/\((.+?):\d+:\d+\)/);
	if (!match) match = line.match(/at\s+(.+?):\d+:\d+/);
	if (!match) return null;
	let filePath = match[1].trim();
	if (filePath === "native" || filePath.startsWith("node:") || filePath.startsWith("internal")) return null;
	if (filePath.startsWith("file://")) try {
		filePath = new URL(filePath).pathname;
	} catch {
		return null;
	}
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath)) return null;
	if (filePath.startsWith("./")) filePath = filePath.slice(2);
	return filePath;
}
var _sdkPackageDir;
function getSdkPackageDir() {
	if (_sdkPackageDir) return _sdkPackageDir;
	try {
		const thisDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(new URL(import.meta.url).pathname);
		_sdkPackageDir = path.resolve(thisDir, "..");
	} catch {
		_sdkPackageDir = "";
	}
	return _sdkPackageDir;
}
function extractCallerFilePath() {
	const stack = (/* @__PURE__ */ new Error()).stack;
	if (!stack) return null;
	const lines = stack.split("\n").slice(1);
	const pkgDir = getSdkPackageDir();
	for (const line of lines) {
		const fp = parseFrameFilePath(line);
		if (!fp) continue;
		const absolute = path.isAbsolute(fp) ? fp : path.resolve(process.cwd(), fp);
		let realFp;
		try {
			realFp = fs$1.realpathSync(absolute);
		} catch {
			realFp = absolute;
		}
		if (pkgDir && realFp.startsWith(pkgDir)) continue;
		return realFp;
	}
	return null;
}
var HANDLER_REGISTRY_KEY = Symbol.for("@vercel/queue.devHandlerRegistry");
function getHandlerRegistry() {
	const g = globalThis;
	if (!g[HANDLER_REGISTRY_KEY]) g[HANDLER_REGISTRY_KEY] = /* @__PURE__ */ new Map();
	return g[HANDLER_REGISTRY_KEY];
}
function registerHandlerForFile(filePath, handler, client, options) {
	const fileMappings = findMappingsForFile(path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath));
	if (fileMappings.length === 0) return false;
	const registry = getHandlerRegistry();
	for (const mapping of fileMappings) {
		const key = mapping.topic;
		const existing = registry.get(key) ?? [];
		const nextEntry = {
			consumerGroup: mapping.consumer,
			handler,
			client,
			options
		};
		const existingIndex = existing.findIndex((e) => e.consumerGroup === mapping.consumer);
		if (existingIndex >= 0) existing[existingIndex] = nextEntry;
		else existing.push(nextEntry);
		registry.set(key, existing);
	}
	return true;
}
function registerDevHandler(handler, client, options, _testCallerPath) {
	const callerPath = _testCallerPath ?? extractCallerFilePath();
	if (!callerPath) {
		console.warn(`${PREFIX} Could not determine caller file path for handler registration.`);
		return;
	}
	if (!registerHandlerForFile(callerPath, handler, client, options)) {
		const allMappings = getDevRouteMappings();
		if (allMappings && allMappings.length > 0) return;
		const cwd = process.cwd();
		let relative2;
		try {
			relative2 = path.relative(cwd, callerPath).replace(/\\/g, "/");
		} catch {
			relative2 = callerPath;
		}
		console.warn(`${PREFIX} handleCallback() in ${relative2} has no matching experimentalTriggers in vercel.json. This handler won't receive messages.

Add a trigger to vercel.json:
  "${relative2}": {
    "experimentalTriggers": [{ "type": "queue/v2beta", "topic": "your-topic" }]
  }`);
	}
}
function lookupHandlers(topicName) {
	const registry = getHandlerRegistry();
	const result = [];
	for (const [pattern, handlers] of registry) if (pattern.includes("*") ? matchesWildcardPattern(topicName, pattern) : pattern === topicName) result.push(...handlers);
	return result;
}
var DEV_RETRY_INITIAL_DELAY_MS = 50;
var DEV_RETRY_MAX_WAIT_MS = 5e3;
var DEV_RETRY_BACKOFF = 2;
var PORT_CHECK_TIMEOUT_MS = 250;
var PRIME_PORT_ENV_KEYS = [
	"PORT",
	"NEXT_PORT",
	"NEXTJS_PORT",
	"NUXT_PORT",
	"NITRO_PORT",
	"SVELTEKIT_PORT",
	"VITE_PORT",
	"DEV_PORT",
	"npm_config_port"
];
var PRIME_URL_ENV_KEYS = [
	"__NEXT_PRIVATE_ORIGIN",
	"NUXT_PUBLIC_SITE_URL",
	"URL"
];
function formatErrorReason(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
function isMessageNotFoundError(error) {
	if (error instanceof MessageNotFoundError) return true;
	if (error instanceof Error && error.name === "MessageNotFoundError") return true;
	return false;
}
function parsePort(value) {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return null;
	return parsed;
}
function parsePortFromUrl(value) {
	if (!value) return null;
	try {
		const parsed = new URL(value).port;
		return parsePort(parsed);
	} catch {
		return null;
	}
}
function collectPrimePorts() {
	const result = [];
	const seen = /* @__PURE__ */ new Set();
	const add = (port) => {
		if (port && !seen.has(port)) {
			seen.add(port);
			result.push(port);
		}
	};
	for (const key of PRIME_PORT_ENV_KEYS) add(parsePort(process.env[key]));
	for (const key of PRIME_URL_ENV_KEYS) add(parsePortFromUrl(process.env[key]));
	return result;
}
function isPortListening(port) {
	return new Promise((resolve2) => {
		const socket = net$1.connect({
			host: "localhost",
			port
		});
		let settled = false;
		const finish = (listening) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve2(listening);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.setTimeout(PORT_CHECK_TIMEOUT_MS, () => finish(false));
	});
}
async function invokeWithRetry(handler, request, options) {
	let elapsed = 0;
	let delay = DEV_RETRY_INITIAL_DELAY_MS;
	while (true) try {
		await handleCallback(handler, request, options);
		return;
	} catch (error) {
		if (isMessageNotFoundError(error) && elapsed < DEV_RETRY_MAX_WAIT_MS) {
			await new Promise((r) => setTimeout(r, delay));
			elapsed += delay;
			delay = Math.min(delay * DEV_RETRY_BACKOFF, DEV_RETRY_MAX_WAIT_MS - elapsed);
			continue;
		}
		throw error;
	}
}
function filePathToUrlPath(filePath) {
	let urlPath = filePath.replace(/^src\/app\//, "/").replace(/^src\/pages\//, "/").replace(/^src\/server\//, "/").replace(/^src\/routes\//, "/").replace(/^app\//, "/").replace(/^pages\//, "/").replace(/^server\//, "/").replace(/\/route\.(ts|mts|js|mjs|tsx|jsx)$/, "").replace(/\/\+server\.(ts|mts|js|mjs|tsx|jsx)$/, "").replace(/\.(ts|mts|js|mjs|tsx|jsx)$/, "");
	if (!urlPath.startsWith("/")) urlPath = "/" + urlPath;
	return urlPath;
}
async function ensureHandlersLoaded(topicName, options = {}) {
	const diagnostics = {
		triedPorts: collectPrimePorts(),
		listeningPorts: [],
		unavailablePorts: [],
		importFailures: [],
		primeFailures: []
	};
	const matchingRoutes = findMatchingRoutes(topicName);
	if (matchingRoutes.length === 0) return diagnostics;
	const shouldRefreshRegistered = options.refreshRegistered === true;
	for (const port of diagnostics.triedPorts) if (await isPortListening(port)) diagnostics.listeningPorts.push(port);
	else diagnostics.unavailablePorts.push(port);
	for (const route of matchingRoutes) {
		const alreadyRegistered = isHandlerRegistered(topicName, route.consumer);
		if (alreadyRegistered && !shouldRefreshRegistered) continue;
		if (!alreadyRegistered) {
			const absolutePath = path.resolve(process.cwd(), route.filePath);
			try {
				await import(absolutePath);
			} catch (error) {
				diagnostics.importFailures.push({
					filePath: route.filePath,
					reason: formatErrorReason(error)
				});
			}
			if (isHandlerRegistered(topicName, route.consumer)) continue;
		}
		for (const port of diagnostics.listeningPorts) {
			const url = `http://localhost:${port}${filePathToUrlPath(route.filePath)}`;
			try {
				const response = await fetch(url, {
					method: "POST",
					headers: {
						"x-vercel-queue-prime": "1",
						"x-vercel-queue-prime-file": route.filePath
					}
				});
				try {
					await response.text();
				} catch {}
				if (isHandlerRegistered(topicName, route.consumer)) break;
				diagnostics.primeFailures.push({
					filePath: route.filePath,
					url,
					reason: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`.trim()
				});
			} catch (error) {
				diagnostics.primeFailures.push({
					filePath: route.filePath,
					url,
					reason: formatErrorReason(error)
				});
			}
		}
	}
	return diagnostics;
}
function buildNoHandlerWarning(topicName, routes, diagnostics) {
	const files = routes.map((r) => r.filePath);
	const suggestedPort = diagnostics.listeningPorts[0] ?? diagnostics.triedPorts[0];
	const suggestedUrls = suggestedPort ? routes.map((r) => `http://localhost:${suggestedPort}${filePathToUrlPath(r.filePath)}`) : [];
	let portSummary;
	if (diagnostics.triedPorts.length === 0) portSummary = "No local dev port detected from env. Set PORT (or NEXT_PORT/NUXT_PORT/VITE_PORT).";
	else if (diagnostics.listeningPorts.length === 0) portSummary = `Detected env ports: [${diagnostics.triedPorts.join(", ")}], but none are listening.`;
	else {
		const unavailable = diagnostics.unavailablePorts.length > 0 ? ` Not listening: [${diagnostics.unavailablePorts.join(", ")}].` : "";
		portSummary = `Detected env ports: [${diagnostics.triedPorts.join(", ")}]. Listening: [${diagnostics.listeningPorts.join(", ")}].` + unavailable;
	}
	const importSummary = diagnostics.importFailures.length > 0 ? `
Import failures: ` + diagnostics.importFailures.slice(0, 2).map((f) => `${f.filePath} (${f.reason})`).join("; ") : "";
	const primeSummary = diagnostics.primeFailures.length > 0 ? `
Prime failures: ` + diagnostics.primeFailures.slice(0, 3).map((f) => `${f.url} (${f.reason})`).join("; ") : "";
	return `${PREFIX} No registered handler for topic "${topicName}". vercel.json maps this topic to [${files.join(", ")}] but auto-loading failed.
${portSummary}${importSummary}${primeSummary}
Ensure your dev server is running, set PORT if needed, and confirm mapped route files call handleCallback()/handleNodeCallback() at module scope.
` + (suggestedUrls.length > 0 ? `Try opening: ${suggestedUrls.join(" or ")}` : "Set PORT (or NEXT_PORT/NUXT_PORT/VITE_PORT) and try sending again.");
}
function isHandlerRegistered(topicName, consumerGroup) {
	return lookupHandlers(topicName).some((h) => h.consumerGroup === consumerGroup);
}
var DEV_REDELIVERY_MAX_DELAY_S = 10;
var DEV_REDELIVERY_DEFAULT_DELAY_S = 2;
var DEV_REDELIVERY_MAX_ATTEMPTS = 10;
var DEFAULT_RETENTION_S = 86400;
function scheduleDevRedelivery(ctx, delayS) {
	const cappedDelay = Math.min(Math.max(delayS, 0), DEV_REDELIVERY_MAX_DELAY_S);
	console.log(`${PREFIX} ${RETRY} Scheduling re-delivery in ${cappedDelay}s: topic="${ctx.topicName}" consumer="${ctx.consumerGroup}" messageId="${ctx.messageId}"`);
	setTimeout(async () => {
		const nextDeliveryCount = ctx.deliveryCount + 1;
		const expiresAt = new Date(ctx.createdAt.getTime() + ctx.retentionSeconds * 1e3);
		if (Date.now() >= expiresAt.getTime()) {
			console.log(`${PREFIX} Message expired, stopping retries: topic="${ctx.topicName}" messageId="${ctx.messageId}"`);
			return;
		}
		if (nextDeliveryCount > DEV_REDELIVERY_MAX_ATTEMPTS) {
			console.log(`${PREFIX} Max re-deliveries (${DEV_REDELIVERY_MAX_ATTEMPTS}) reached: topic="${ctx.topicName}" messageId="${ctx.messageId}"`);
			return;
		}
		const metadata = {
			messageId: ctx.messageId,
			deliveryCount: nextDeliveryCount,
			createdAt: ctx.createdAt,
			expiresAt,
			topicName: ctx.topicName,
			consumerGroup: ctx.consumerGroup,
			region: ctx.region
		};
		console.log(`${PREFIX} Re-delivering: topic="${ctx.topicName}" consumer="${ctx.consumerGroup}" messageId="${ctx.messageId}" deliveryCount=${nextDeliveryCount}`);
		let succeeded = true;
		let nextRetryAfterS = null;
		let nextAcknowledged = false;
		try {
			await ctx.handler(ctx.payload, metadata);
		} catch (error) {
			succeeded = false;
			if (ctx.retry) {
				let directive;
				try {
					directive = ctx.retry(error, metadata);
				} catch (retryErr) {
					console.warn(`${PREFIX} retry handler threw:`, retryErr);
				}
				if (directive && "afterSeconds" in directive) nextRetryAfterS = directive.afterSeconds;
				else if (directive && "acknowledge" in directive) nextAcknowledged = true;
			}
			if (!nextAcknowledged) console.error(`${PREFIX} ${FAIL} Handler error on re-delivery: topic="${ctx.topicName}" messageId="${ctx.messageId}"`, error);
		}
		if (succeeded) console.log(`${PREFIX} ${OK} Message processed on re-delivery: topic="${ctx.topicName}" consumer="${ctx.consumerGroup}" messageId="${ctx.messageId}"`);
		else if (nextAcknowledged) console.log(`${PREFIX} ${OK} Message acknowledged (will not retry): topic="${ctx.topicName}" consumer="${ctx.consumerGroup}" messageId="${ctx.messageId}"`);
		else {
			const nextDelay = nextRetryAfterS ?? ctx.defaultRetryDelayS;
			scheduleDevRedelivery({
				...ctx,
				deliveryCount: nextDeliveryCount
			}, nextDelay);
		}
	}, cappedDelay * 1e3);
}
function invokeDevHandlers(topicName, messageId, region, delaySeconds, retentionSeconds) {
	if (delaySeconds && delaySeconds > 0) {
		console.log(`${PREFIX} Message sent with delay: topic="${topicName}" messageId="${messageId}" delay=${delaySeconds}s`);
		setTimeout(() => {
			invokeDevHandlers(topicName, messageId, region, void 0, retentionSeconds);
		}, delaySeconds * 1e3);
		return;
	}
	console.log(`${PREFIX} Message sent: topic="${topicName}" messageId="${messageId}"`);
	(async () => {
		let handlers = lookupHandlers(topicName);
		let diagnostics = null;
		if (handlers.length > 0) {
			await ensureHandlersLoaded(topicName, { refreshRegistered: true });
			handlers = lookupHandlers(topicName);
		} else {
			diagnostics = await ensureHandlersLoaded(topicName);
			handlers = lookupHandlers(topicName);
		}
		if (handlers.length === 0) {
			const matchingRoutes = findMatchingRoutes(topicName);
			if (matchingRoutes.length > 0) {
				const safeDiagnostics = diagnostics ?? {
					triedPorts: collectPrimePorts(),
					listeningPorts: [],
					unavailablePorts: [],
					importFailures: [],
					primeFailures: []
				};
				console.warn(buildNoHandlerWarning(topicName, matchingRoutes, safeDiagnostics));
			} else console.warn(`${PREFIX} No registered handler for topic "${topicName}".
Ensure vercel.json has a matching experimentalTriggers entry and the route file calls handleCallback().`);
			return;
		}
		const consumerGroups = handlers.map((h) => h.consumerGroup);
		console.log(`${PREFIX} Invoking handlers for topic="${topicName}" messageId="${messageId}" \u2192 consumers: [${consumerGroups.join(", ")}]`);
		const effectiveRetention = retentionSeconds ?? DEFAULT_RETENTION_S;
		for (const entry of handlers) {
			let capturedPayload;
			let capturedCreatedAt = /* @__PURE__ */ new Date();
			let capturedDeliveryCount = 1;
			let handlerSucceeded = true;
			let retryAfterS = null;
			let retryAcknowledged = false;
			const wrappedHandler = async (message, metadata) => {
				capturedPayload = message;
				capturedCreatedAt = metadata.createdAt;
				capturedDeliveryCount = metadata.deliveryCount;
				try {
					await entry.handler(message, metadata);
				} catch (error) {
					handlerSucceeded = false;
					throw error;
				}
			};
			const wrappedRetry = entry.options?.retry ? (error, metadata) => {
				const directive = entry.options.retry(error, metadata);
				if (directive && "afterSeconds" in directive) retryAfterS = directive.afterSeconds;
				else if (directive && "acknowledge" in directive) retryAcknowledged = true;
				return directive;
			} : void 0;
			const request = {
				queueName: topicName,
				consumerGroup: entry.consumerGroup,
				messageId,
				region
			};
			const callbackOptions = {
				client: entry.client,
				visibilityTimeoutSeconds: entry.options?.visibilityTimeoutSeconds,
				retry: wrappedRetry
			};
			const consumerDefaultDelay = Math.min(findRetryAfterSeconds(topicName, entry.consumerGroup) ?? DEV_REDELIVERY_DEFAULT_DELAY_S, DEV_REDELIVERY_MAX_DELAY_S);
			const buildRedeliveryCtx = () => ({
				handler: entry.handler,
				retry: entry.options?.retry,
				payload: capturedPayload,
				topicName,
				consumerGroup: entry.consumerGroup,
				messageId,
				region,
				createdAt: capturedCreatedAt,
				retentionSeconds: effectiveRetention,
				deliveryCount: capturedDeliveryCount,
				defaultRetryDelayS: consumerDefaultDelay
			});
			try {
				await invokeWithRetry(wrappedHandler, request, callbackOptions);
				if (handlerSucceeded) console.log(`${PREFIX} ${OK} Message processed: topic="${topicName}" consumer="${entry.consumerGroup}" messageId="${messageId}"`);
				else if (retryAcknowledged) console.log(`${PREFIX} ${OK} Message acknowledged (will not retry): topic="${topicName}" consumer="${entry.consumerGroup}" messageId="${messageId}"`);
				else if (retryAfterS !== null) {
					const devDelay = Math.min(retryAfterS, DEV_REDELIVERY_MAX_DELAY_S);
					scheduleDevRedelivery(buildRedeliveryCtx(), devDelay);
				}
			} catch (error) {
				console.error(`${PREFIX} ${FAIL} Handler failed: topic="${topicName}" consumer="${entry.consumerGroup}" messageId="${messageId}"`, error);
				if (!handlerSucceeded) scheduleDevRedelivery(buildRedeliveryCtx(), consumerDefaultDelay);
			}
		}
	})();
}
function clearDevState() {
	const g = globalThis;
	delete g[ROUTE_MAPPINGS_KEY];
	delete g[HANDLER_REGISTRY_KEY];
}
if (process.env.NODE_ENV === "test" || process.env.VITEST) {
	globalThis.__clearDevState = clearDevState;
	globalThis.__filePathToConsumerGroup = filePathToConsumerGroup;
	globalThis.__filePathToUrlPath = filePathToUrlPath;
	globalThis.__matchesFunctionsPattern = matchesFunctionsPattern;
	globalThis.__stripSrcPrefix = stripSrcPrefix;
}
function isDebugEnabled() {
	return process.env.VERCEL_QUEUE_DEBUG === "1" || process.env.VERCEL_QUEUE_DEBUG === "true";
}
async function consumeStream(stream) {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done } = await reader.read();
			if (done) break;
		}
	} finally {
		reader.releaseLock();
	}
}
function throwCommonHttpError(status, statusText, errorText, operation, badRequestDefault = "Invalid parameters") {
	if (status === 400) throw new BadRequestError(errorText || badRequestDefault);
	if (status === 401) throw new UnauthorizedError(errorText || void 0);
	if (status === 403) throw new ForbiddenError(errorText || void 0);
	if (status >= 500) throw new InternalServerError(errorText || `Server error: ${status} ${statusText}`);
	throw new Error(`Failed to ${operation}: ${status} ${statusText}`);
}
function parseQueueHeaders(headers) {
	const messageId = headers.get("Vqs-Message-Id");
	const deliveryCountStr = headers.get("Vqs-Delivery-Count") || "0";
	const timestamp = headers.get("Vqs-Timestamp");
	const contentType = headers.get("Content-Type") || "application/octet-stream";
	const receiptHandle = headers.get("Vqs-Receipt-Handle");
	const expiresAtStr = headers.get("Vqs-Expires-At");
	if (!messageId || !timestamp || !receiptHandle) return null;
	const deliveryCount = parseInt(deliveryCountStr, 10);
	if (Number.isNaN(deliveryCount)) return null;
	return {
		messageId,
		deliveryCount,
		createdAt: new Date(timestamp),
		expiresAt: expiresAtStr ? new Date(expiresAtStr) : void 0,
		contentType,
		receiptHandle
	};
}
var DEFAULT_BASE_URL_RESOLVER = (region) => new URL(`https://${region}.vercel-queue.com`);
function resolveBaseUrl(region, resolver) {
	return (resolver ?? DEFAULT_BASE_URL_RESOLVER)(region);
}
var BASE_PATH = "/api/v3/topic";
var ApiClient = class _ApiClient {
	baseUrl;
	customHeaders;
	providedToken;
	resolvedDeploymentId;
	pinSends;
	explicitlyUnpinned;
	transport;
	region;
	baseUrlResolver;
	dispatcher;
	constructor(options) {
		this.region = options.region;
		this.baseUrlResolver = options.resolveBaseUrl;
		this.baseUrl = resolveBaseUrl(this.region, this.baseUrlResolver);
		this.customHeaders = options.headers || {};
		this.providedToken = options.token;
		this.transport = options.transport || new JsonTransport();
		this.dispatcher = options.dispatcher;
		if (options.deploymentId === null) {
			this.pinSends = false;
			this.explicitlyUnpinned = true;
		} else {
			this.resolvedDeploymentId = options.deploymentId || process.env.VERCEL_DEPLOYMENT_ID;
			this.pinSends = true;
			this.explicitlyUnpinned = false;
		}
	}
	/**
	* Return a new ApiClient targeting the given region, sharing all other
	* configuration (token, transport, headers, deployment ID, resolver).
	* Used internally by handleCallback to route follow-up API calls to the
	* region indicated by the incoming `ce-vqsregion` header.
	*/
	withRegion(region) {
		return new _ApiClient({
			region,
			resolveBaseUrl: this.baseUrlResolver,
			token: this.providedToken,
			headers: { ...this.customHeaders },
			deploymentId: this.explicitlyUnpinned ? null : this.resolvedDeploymentId,
			transport: this.transport,
			dispatcher: this.dispatcher
		});
	}
	getRegion() {
		return this.region;
	}
	getTransport() {
		return this.transport;
	}
	requireDeploymentId() {
		if (isDevMode() || this.explicitlyUnpinned || this.resolvedDeploymentId) return;
		throw new Error("No deployment ID available. VERCEL_DEPLOYMENT_ID is not set.\n\nThis usually means the code is running outside a Vercel deployment (e.g. during build or in a non-Vercel environment).\n\nTo fix this, create a client with an explicit deploymentId:\n  new QueueClient({ deploymentId: \"dpl_xxx\" })\nOr explicitly opt out of deployment pinning:\n  new QueueClient({ deploymentId: null })");
	}
	getSendDeploymentId() {
		if (isDevMode()) return;
		this.requireDeploymentId();
		return this.pinSends ? this.resolvedDeploymentId : void 0;
	}
	getConsumeDeploymentId() {
		if (isDevMode()) return;
		this.requireDeploymentId();
		return this.resolvedDeploymentId;
	}
	async getToken() {
		if (this.providedToken) return this.providedToken;
		try {
			return await (0, import_dist.getVercelOidcToken)();
		} catch (err) {
			const cause = err instanceof Error ? err.message : String(err);
			throw new Error(isDevMode() ? `Failed to get OIDC token for local development.

To fix this, pull your environment variables with Vercel CLI:
  \`vercel env pull\`

Cause: ${cause}` : `Failed to get OIDC token. This usually means the function is running outside of a Vercel Function environment.

To fix this, either:
  - Deploy to Vercel (OIDC tokens are provisioned automatically)
  - Provide a token explicitly: \`new QueueClient({ token: '...' })\`

Cause: ${cause}`);
		}
	}
	buildUrl(queueName, ...pathSegments) {
		const encodedQueue = encodeURIComponent(queueName);
		const segments = pathSegments.map((s) => encodeURIComponent(s));
		const path2 = segments.length > 0 ? "/" + segments.join("/") : "";
		const basePath = this.baseUrl.pathname.replace(/\/+$/, "");
		return `${this.baseUrl.origin}${basePath}${BASE_PATH}/${encodedQueue}${path2}`;
	}
	async fetch(url, init) {
		const method = init.method || "GET";
		if (isDebugEnabled()) {
			const logData = {
				method,
				url,
				headers: init.headers
			};
			const body = init.body;
			if (body !== void 0 && body !== null) if (body instanceof ArrayBuffer) logData.bodySize = body.byteLength;
			else if (body instanceof Uint8Array) logData.bodySize = body.byteLength;
			else if (typeof body === "string") logData.bodySize = body.length;
			else logData.bodyType = typeof body;
			console.debug("[VQS Debug] Request:", JSON.stringify(logData, null, 2));
		}
		init.headers.set("User-Agent", `@vercel/queue/0.1.4`);
		init.headers.set("Vqs-Client-Ts", (/* @__PURE__ */ new Date()).toISOString());
		const fetchInit = this.dispatcher ? {
			...init,
			dispatcher: this.dispatcher
		} : init;
		const response = await fetch(url, fetchInit);
		if (isDebugEnabled()) {
			const logData = {
				method,
				url,
				status: response.status,
				statusText: response.statusText,
				headers: response.headers
			};
			console.debug("[VQS Debug] Response:", JSON.stringify(logData, null, 2));
		}
		return response;
	}
	async sendMessage(options) {
		const transport = this.transport;
		const { queueName, payload, idempotencyKey, retentionSeconds, delaySeconds, headers: optionHeaders } = options;
		const headers = new Headers();
		if (this.customHeaders) for (const [name, value] of Object.entries(this.customHeaders)) headers.append(name, value);
		if (optionHeaders) {
			const protectedHeaderNames = /* @__PURE__ */ new Set(["authorization", "content-type"]);
			const isProtectedHeader = (name) => {
				const lower = name.toLowerCase();
				if (protectedHeaderNames.has(lower)) return true;
				return lower.startsWith("vqs-");
			};
			for (const [name, value] of Object.entries(optionHeaders)) if (!isProtectedHeader(name) && value !== void 0) headers.append(name, value);
		}
		headers.set("Authorization", `Bearer ${await this.getToken()}`);
		headers.set("Content-Type", transport.contentType);
		const deploymentId = this.getSendDeploymentId();
		if (deploymentId) headers.set("Vqs-Deployment-Id", deploymentId);
		if (idempotencyKey) headers.set("Vqs-Idempotency-Key", idempotencyKey);
		if (retentionSeconds !== void 0) headers.set("Vqs-Retention-Seconds", retentionSeconds.toString());
		if (delaySeconds !== void 0) headers.set("Vqs-Delay-Seconds", delaySeconds.toString());
		const serialized = transport.serialize(payload);
		const body = Buffer.isBuffer(serialized) ? new Uint8Array(serialized) : serialized;
		const response = await this.fetch(this.buildUrl(queueName), {
			method: "POST",
			body,
			headers
		});
		if (!response.ok) {
			const errorText = await response.text();
			if (response.status === 409) throw new DuplicateMessageError(errorText || "Duplicate idempotency key detected", idempotencyKey);
			if (response.status === 502) throw new ConsumerDiscoveryError(errorText || "Consumer discovery failed", deploymentId);
			if (response.status === 503) throw new ConsumerRegistryNotConfiguredError(errorText || "Consumer registry not configured");
			throwCommonHttpError(response.status, response.statusText, errorText, "send message");
		}
		if (response.status === 202) return { messageId: null };
		return await response.json();
	}
	async *receiveMessages(options) {
		const transport = this.transport;
		const { queueName, consumerGroup, visibilityTimeoutSeconds, limit } = options;
		if (limit !== void 0 && (limit < 1 || limit > 10)) throw new InvalidLimitError(limit);
		const headers = new Headers({
			Authorization: `Bearer ${await this.getToken()}`,
			Accept: "multipart/mixed",
			...this.customHeaders
		});
		if (visibilityTimeoutSeconds !== void 0) headers.set("Vqs-Visibility-Timeout-Seconds", visibilityTimeoutSeconds.toString());
		if (limit !== void 0) headers.set("Vqs-Max-Messages", limit.toString());
		const effectiveDeploymentId = this.getConsumeDeploymentId();
		if (effectiveDeploymentId) headers.set("Vqs-Deployment-Id", effectiveDeploymentId);
		const response = await this.fetch(this.buildUrl(queueName, "consumer", consumerGroup), {
			method: "POST",
			headers
		});
		if (response.status === 204) return;
		if (!response.ok) {
			const errorText = await response.text();
			throwCommonHttpError(response.status, response.statusText, errorText, "receive messages");
		}
		for await (const multipartMessage of parseMultipartStream(response)) try {
			const parsedHeaders = parseQueueHeaders(multipartMessage.headers);
			if (!parsedHeaders) {
				console.warn("Missing required queue headers in multipart part");
				await consumeStream(multipartMessage.payload);
				continue;
			}
			const deserializedPayload = await transport.deserialize(multipartMessage.payload);
			yield {
				...parsedHeaders,
				payload: deserializedPayload
			};
		} catch (error) {
			console.warn("Failed to process multipart message:", error);
			await consumeStream(multipartMessage.payload);
		}
	}
	async receiveMessageById(options) {
		const transport = this.transport;
		const { queueName, consumerGroup, messageId, visibilityTimeoutSeconds } = options;
		const headers = new Headers({
			Authorization: `Bearer ${await this.getToken()}`,
			Accept: "multipart/mixed",
			...this.customHeaders
		});
		if (visibilityTimeoutSeconds !== void 0) headers.set("Vqs-Visibility-Timeout-Seconds", visibilityTimeoutSeconds.toString());
		const effectiveDeploymentId = this.getConsumeDeploymentId();
		if (effectiveDeploymentId) headers.set("Vqs-Deployment-Id", effectiveDeploymentId);
		const response = await this.fetch(this.buildUrl(queueName, "consumer", consumerGroup, "id", messageId), {
			method: "POST",
			headers
		});
		if (!response.ok) {
			const errorText = await response.text();
			if (response.status === 404) throw new MessageNotFoundError(messageId);
			if (response.status === 409) {
				let errorData = {};
				try {
					errorData = JSON.parse(errorText);
				} catch {}
				if (errorData.originalMessageId) throw new MessageNotAvailableError(messageId, `This message was a duplicate - use originalMessageId: ${errorData.originalMessageId}`);
				throw new MessageNotAvailableError(messageId);
			}
			if (response.status === 410) throw new MessageAlreadyProcessedError(messageId);
			throwCommonHttpError(response.status, response.statusText, errorText, "receive message by ID");
		}
		for await (const multipartMessage of parseMultipartStream(response)) {
			const parsedHeaders = parseQueueHeaders(multipartMessage.headers);
			if (!parsedHeaders) {
				await consumeStream(multipartMessage.payload);
				throw new MessageCorruptedError(messageId, "Missing required queue headers in response");
			}
			const deserializedPayload = await transport.deserialize(multipartMessage.payload);
			return { message: {
				...parsedHeaders,
				payload: deserializedPayload
			} };
		}
		throw new MessageNotFoundError(messageId);
	}
	async acknowledgeMessage(options) {
		const { queueName, consumerGroup, receiptHandle } = options;
		const headers = new Headers({
			Authorization: `Bearer ${await this.getToken()}`,
			...this.customHeaders
		});
		const effectiveDeploymentId = this.getConsumeDeploymentId();
		if (effectiveDeploymentId) headers.set("Vqs-Deployment-Id", effectiveDeploymentId);
		const response = await this.fetch(this.buildUrl(queueName, "consumer", consumerGroup, "lease", receiptHandle), {
			method: "DELETE",
			headers
		});
		if (!response.ok) {
			const errorText = await response.text();
			if (response.status === 404) throw new MessageNotFoundError(receiptHandle);
			if (response.status === 409) throw new MessageNotAvailableError(receiptHandle, errorText || "Invalid receipt handle, message not in correct state, or already processed");
			throwCommonHttpError(response.status, response.statusText, errorText, "acknowledge message", "Missing or invalid receipt handle");
		}
		return { acknowledged: true };
	}
	async changeVisibility(options) {
		const { queueName, consumerGroup, receiptHandle, visibilityTimeoutSeconds } = options;
		const headers = new Headers({
			Authorization: `Bearer ${await this.getToken()}`,
			"Content-Type": "application/json",
			...this.customHeaders
		});
		const effectiveDeploymentId = this.getConsumeDeploymentId();
		if (effectiveDeploymentId) headers.set("Vqs-Deployment-Id", effectiveDeploymentId);
		const response = await this.fetch(this.buildUrl(queueName, "consumer", consumerGroup, "lease", receiptHandle), {
			method: "PATCH",
			headers,
			body: JSON.stringify({ visibilityTimeoutSeconds })
		});
		if (!response.ok) {
			const errorText = await response.text();
			if (response.status === 404) throw new MessageNotFoundError(receiptHandle);
			if (response.status === 409) throw new MessageNotAvailableError(receiptHandle, errorText || "Invalid receipt handle, message not in correct state, or already processed");
			throwCommonHttpError(response.status, response.statusText, errorText, "change visibility", "Missing receipt handle or invalid visibility timeout");
		}
		return { success: true };
	}
};
var apiClients = /* @__PURE__ */ new WeakMap();
var API_CLIENT_KEY = Symbol.for("@vercel/queue.apiClient");
function setApi(client, api) {
	apiClients.set(client, api);
	Object.defineProperty(client, API_CLIENT_KEY, {
		value: api,
		writable: false,
		enumerable: false,
		configurable: false
	});
}
function getApi(client) {
	const api = apiClients.get(client);
	if (api) return api;
	const apiFromSymbol = client[API_CLIENT_KEY];
	if (typeof apiFromSymbol === "object" && apiFromSymbol !== null) {
		const resolvedApi = apiFromSymbol;
		apiClients.set(client, resolvedApi);
		return resolvedApi;
	}
	throw new Error("QueueClient not initialized. This may happen when multiple bundled copies of @vercel/queue are loaded in local dev.");
}
function resolveCallbackRequest(input) {
	if ("request" in input) return input.request;
	return input;
}
function getApiClient(client) {
	return getApi(client);
}
var DEFAULT_REGION = "iad1";
function resolveRegion(region) {
	if (region) return region;
	const fromEnv = process.env.VERCEL_REGION;
	if (fromEnv) return fromEnv;
	if (!isDevMode()) console.warn(`[QueueClient] Region not detected \u2014 defaulting to "${DEFAULT_REGION}". On Vercel this is set automatically via VERCEL_REGION. To silence this warning, pass region explicitly: new QueueClient({ region: "iad1" })`);
	return DEFAULT_REGION;
}
var QueueClient = class {
	constructor(options = {}) {
		const region = resolveRegion(options.region);
		setApi(this, new ApiClient({
			...options,
			region
		}));
	}
	/**
	* Send a message to a topic.
	*
	* This is an arrow function property so it can be destructured:
	* ```typescript
	* const { send } = new QueueClient();
	* await send("my-topic", payload);
	* ```
	*
	* @param topicName - Name of the topic (pattern: `[A-Za-z0-9_-]+`)
	* @param payload - The data to send (serialized via the configured transport)
	* @param options - Optional send options (idempotencyKey, retentionSeconds, delaySeconds, headers)
	* @returns `{ messageId }` — `messageId` is `null` when the server accepted
	*   the message for deferred processing (no ID available yet)
	*/
	send = async (topicName, payload, options) => {
		const api = getApi(this);
		const result = await api.sendMessage({
			queueName: topicName,
			payload,
			idempotencyKey: options?.idempotencyKey,
			retentionSeconds: options?.retentionSeconds,
			delaySeconds: options?.delaySeconds,
			headers: options?.headers
		});
		if (result.messageId && isDevMode()) invokeDevHandlers(topicName, result.messageId, api.getRegion(), options?.delaySeconds, options?.retentionSeconds);
		return { messageId: result.messageId };
	};
	/**
	* Create a Web API route handler for processing queue callback messages.
	*
	* Parses incoming `Request` as a CloudEvent and invokes the handler.
	* For use on Vercel — Vercel invokes this route when messages are available.
	*
	* This is an arrow function property so it can be destructured:
	* ```typescript
	* const { handleCallback } = new QueueClient();
	* export const POST = handleCallback(handler);
	* ```
	*
	* @param handler - Function to process the message payload and metadata
	* @param options - Optional configuration
	* @param options.visibilityTimeoutSeconds - Message lock duration (default: 300, max: 3600)
	* @param options.retry - Called when the handler throws. Return `{ afterSeconds: N }` to
	*   reschedule the message for redelivery after N seconds.
	* @returns A route handler that accepts either `Request` or `{ request: Request }`
	*/
	handleCallback = (handler, options) => {
		if (isDevMode()) registerDevHandler(handler, this, options);
		return async (requestOrEvent) => {
			const request = resolveCallbackRequest(requestOrEvent);
			if (isDevMode() && request.headers.get("x-vercel-queue-prime") === "1") {
				const primeFile = request.headers.get("x-vercel-queue-prime-file");
				if (primeFile) registerDevHandler(handler, this, options, primeFile);
				return Response.json({ status: "primed" });
			}
			try {
				await handleCallback(handler, await parseCallback(request), {
					client: this,
					visibilityTimeoutSeconds: options?.visibilityTimeoutSeconds,
					retry: options?.retry
				});
				return Response.json({ status: "success" });
			} catch (error) {
				console.error("Queue callback error:", error);
				if (error instanceof Error && (error.message.includes("Invalid content type") || error.message.includes("Invalid CloudEvent") || error.message.includes("Missing required CloudEvent") || error.message.includes("Failed to parse CloudEvent") || error.message.includes("Binary mode callback"))) return Response.json({ error: error.message }, { status: 400 });
				return Response.json({ error: "Failed to process queue message" }, { status: 500 });
			}
		};
	};
	/**
	* Create a Connect-style route handler for processing queue callback messages.
	* For use on Vercel — Vercel invokes this route when messages are available.
	*
	* For frameworks using the `(req, res)` middleware pattern where `req.body`
	* is pre-parsed (Next.js Pages Router, etc.).
	*
	* This is an arrow function property so it can be destructured:
	* ```typescript
	* const { handleNodeCallback } = new QueueClient();
	* app.post("/api/queue", handleNodeCallback(handler));
	* ```
	*
	* @param handler - Function to process the message payload and metadata
	* @param options - Optional configuration
	* @param options.visibilityTimeoutSeconds - Message lock duration (default: 300, max: 3600)
	* @param options.retry - Called when the handler throws. Return `{ afterSeconds: N }` to
	*   reschedule the message for redelivery after N seconds.
	* @returns A `(req, res) => Promise<void>` route handler
	*/
	handleNodeCallback = (handler, options) => {
		if (isDevMode()) registerDevHandler(handler, this, options);
		return async (req, res) => {
			if (req.method !== "POST") {
				res.status(200).end();
				return;
			}
			const primeHeader = req.headers["x-vercel-queue-prime"];
			if (isDevMode() && primeHeader === "1") {
				const primeFileHeader = req.headers["x-vercel-queue-prime-file"];
				const primeFile = Array.isArray(primeFileHeader) ? primeFileHeader[0] : primeFileHeader;
				if (primeFile) registerDevHandler(handler, this, options, primeFile);
				res.status(200).json({ status: "primed" });
				return;
			}
			try {
				await handleCallback(handler, parseRawCallback(req.body, req.headers), {
					client: this,
					visibilityTimeoutSeconds: options?.visibilityTimeoutSeconds,
					retry: options?.retry
				});
				res.status(200).json({ status: "success" });
			} catch (error) {
				console.error("Queue callback error:", error);
				if (error instanceof Error && (error.message.includes("Invalid content type") || error.message.includes("Invalid CloudEvent") || error.message.includes("Missing required CloudEvent") || error.message.includes("Failed to parse CloudEvent") || error.message.includes("Binary mode callback"))) {
					res.status(400).json({ error: error.message });
					return;
				}
				res.status(500).json({ error: "Failed to process queue message" });
			}
		};
	};
};
//#endregion
export { JsonTransport as n, QueueClient as r, DuplicateMessageError as t };
