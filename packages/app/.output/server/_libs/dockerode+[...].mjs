import { r as __require, t as __commonJSMin } from "../_runtime.mjs";
import { t as require_modem } from "./docker-modem+split-ca.mjs";
import { n as require_readable, r as require_inherits, t as require_bl } from "./bl+[...].mjs";
import { t as require_ignore } from "./balena__dockerignore.mjs";
import { t as require_chownr } from "./chownr.mjs";
import { t as require_src } from "./@grpc/grpc-js+[...].mjs";
import { t as require_src$1 } from "./grpc__proto-loader.mjs";
//#region ../../node_modules/.pnpm/tar-stream@2.2.0/node_modules/tar-stream/headers.js
var require_headers = /* @__PURE__ */ __commonJSMin(((exports) => {
	var alloc = Buffer.alloc;
	var ZEROS = "0000000000000000000";
	var SEVENS = "7777777777777777777";
	var ZERO_OFFSET = "0".charCodeAt(0);
	var USTAR_MAGIC = Buffer.from("ustar\0", "binary");
	var USTAR_VER = Buffer.from("00", "binary");
	var GNU_MAGIC = Buffer.from("ustar ", "binary");
	var GNU_VER = Buffer.from(" \0", "binary");
	var MASK = parseInt("7777", 8);
	var MAGIC_OFFSET = 257;
	var VERSION_OFFSET = 263;
	var clamp = function(index, len, defaultValue) {
		if (typeof index !== "number") return defaultValue;
		index = ~~index;
		if (index >= len) return len;
		if (index >= 0) return index;
		index += len;
		if (index >= 0) return index;
		return 0;
	};
	var toType = function(flag) {
		switch (flag) {
			case 0: return "file";
			case 1: return "link";
			case 2: return "symlink";
			case 3: return "character-device";
			case 4: return "block-device";
			case 5: return "directory";
			case 6: return "fifo";
			case 7: return "contiguous-file";
			case 72: return "pax-header";
			case 55: return "pax-global-header";
			case 27: return "gnu-long-link-path";
			case 28:
			case 30: return "gnu-long-path";
		}
		return null;
	};
	var toTypeflag = function(flag) {
		switch (flag) {
			case "file": return 0;
			case "link": return 1;
			case "symlink": return 2;
			case "character-device": return 3;
			case "block-device": return 4;
			case "directory": return 5;
			case "fifo": return 6;
			case "contiguous-file": return 7;
			case "pax-header": return 72;
		}
		return 0;
	};
	var indexOf = function(block, num, offset, end) {
		for (; offset < end; offset++) if (block[offset] === num) return offset;
		return end;
	};
	var cksum = function(block) {
		var sum = 256;
		for (var i = 0; i < 148; i++) sum += block[i];
		for (var j = 156; j < 512; j++) sum += block[j];
		return sum;
	};
	var encodeOct = function(val, n) {
		val = val.toString(8);
		if (val.length > n) return SEVENS.slice(0, n) + " ";
		else return ZEROS.slice(0, n - val.length) + val + " ";
	};
	function parse256(buf) {
		var positive;
		if (buf[0] === 128) positive = true;
		else if (buf[0] === 255) positive = false;
		else return null;
		var tuple = [];
		for (var i = buf.length - 1; i > 0; i--) {
			var byte = buf[i];
			if (positive) tuple.push(byte);
			else tuple.push(255 - byte);
		}
		var sum = 0;
		var l = tuple.length;
		for (i = 0; i < l; i++) sum += tuple[i] * Math.pow(256, i);
		return positive ? sum : -1 * sum;
	}
	var decodeOct = function(val, offset, length) {
		val = val.slice(offset, offset + length);
		offset = 0;
		if (val[offset] & 128) return parse256(val);
		else {
			while (offset < val.length && val[offset] === 32) offset++;
			var end = clamp(indexOf(val, 32, offset, val.length), val.length, val.length);
			while (offset < end && val[offset] === 0) offset++;
			if (end === offset) return 0;
			return parseInt(val.slice(offset, end).toString(), 8);
		}
	};
	var decodeStr = function(val, offset, length, encoding) {
		return val.slice(offset, indexOf(val, 0, offset, offset + length)).toString(encoding);
	};
	var addLength = function(str) {
		var len = Buffer.byteLength(str);
		var digits = Math.floor(Math.log(len) / Math.log(10)) + 1;
		if (len + digits >= Math.pow(10, digits)) digits++;
		return len + digits + str;
	};
	exports.decodeLongPath = function(buf, encoding) {
		return decodeStr(buf, 0, buf.length, encoding);
	};
	exports.encodePax = function(opts) {
		var result = "";
		if (opts.name) result += addLength(" path=" + opts.name + "\n");
		if (opts.linkname) result += addLength(" linkpath=" + opts.linkname + "\n");
		var pax = opts.pax;
		if (pax) for (var key in pax) result += addLength(" " + key + "=" + pax[key] + "\n");
		return Buffer.from(result);
	};
	exports.decodePax = function(buf) {
		var result = {};
		while (buf.length) {
			var i = 0;
			while (i < buf.length && buf[i] !== 32) i++;
			var len = parseInt(buf.slice(0, i).toString(), 10);
			if (!len) return result;
			var b = buf.slice(i + 1, len - 1).toString();
			var keyIndex = b.indexOf("=");
			if (keyIndex === -1) return result;
			result[b.slice(0, keyIndex)] = b.slice(keyIndex + 1);
			buf = buf.slice(len);
		}
		return result;
	};
	exports.encode = function(opts) {
		var buf = alloc(512);
		var name = opts.name;
		var prefix = "";
		if (opts.typeflag === 5 && name[name.length - 1] !== "/") name += "/";
		if (Buffer.byteLength(name) !== name.length) return null;
		while (Buffer.byteLength(name) > 100) {
			var i = name.indexOf("/");
			if (i === -1) return null;
			prefix += prefix ? "/" + name.slice(0, i) : name.slice(0, i);
			name = name.slice(i + 1);
		}
		if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) return null;
		if (opts.linkname && Buffer.byteLength(opts.linkname) > 100) return null;
		buf.write(name);
		buf.write(encodeOct(opts.mode & MASK, 6), 100);
		buf.write(encodeOct(opts.uid, 6), 108);
		buf.write(encodeOct(opts.gid, 6), 116);
		buf.write(encodeOct(opts.size, 11), 124);
		buf.write(encodeOct(opts.mtime.getTime() / 1e3 | 0, 11), 136);
		buf[156] = ZERO_OFFSET + toTypeflag(opts.type);
		if (opts.linkname) buf.write(opts.linkname, 157);
		USTAR_MAGIC.copy(buf, MAGIC_OFFSET);
		USTAR_VER.copy(buf, VERSION_OFFSET);
		if (opts.uname) buf.write(opts.uname, 265);
		if (opts.gname) buf.write(opts.gname, 297);
		buf.write(encodeOct(opts.devmajor || 0, 6), 329);
		buf.write(encodeOct(opts.devminor || 0, 6), 337);
		if (prefix) buf.write(prefix, 345);
		buf.write(encodeOct(cksum(buf), 6), 148);
		return buf;
	};
	exports.decode = function(buf, filenameEncoding, allowUnknownFormat) {
		var typeflag = buf[156] === 0 ? 0 : buf[156] - ZERO_OFFSET;
		var name = decodeStr(buf, 0, 100, filenameEncoding);
		var mode = decodeOct(buf, 100, 8);
		var uid = decodeOct(buf, 108, 8);
		var gid = decodeOct(buf, 116, 8);
		var size = decodeOct(buf, 124, 12);
		var mtime = decodeOct(buf, 136, 12);
		var type = toType(typeflag);
		var linkname = buf[157] === 0 ? null : decodeStr(buf, 157, 100, filenameEncoding);
		var uname = decodeStr(buf, 265, 32);
		var gname = decodeStr(buf, 297, 32);
		var devmajor = decodeOct(buf, 329, 8);
		var devminor = decodeOct(buf, 337, 8);
		var c = cksum(buf);
		if (c === 256) return null;
		if (c !== decodeOct(buf, 148, 8)) throw new Error("Invalid tar header. Maybe the tar is corrupted or it needs to be gunzipped?");
		if (USTAR_MAGIC.compare(buf, MAGIC_OFFSET, MAGIC_OFFSET + 6) === 0) {
			if (buf[345]) name = decodeStr(buf, 345, 155, filenameEncoding) + "/" + name;
		} else if (GNU_MAGIC.compare(buf, MAGIC_OFFSET, MAGIC_OFFSET + 6) === 0 && GNU_VER.compare(buf, VERSION_OFFSET, VERSION_OFFSET + 2) === 0) {} else if (!allowUnknownFormat) throw new Error("Invalid tar header: unknown format.");
		if (typeflag === 0 && name && name[name.length - 1] === "/") typeflag = 5;
		return {
			name,
			mode,
			uid,
			gid,
			size,
			mtime: /* @__PURE__ */ new Date(1e3 * mtime),
			type,
			linkname,
			uname,
			gname,
			devmajor,
			devminor
		};
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/tar-stream@2.2.0/node_modules/tar-stream/extract.js
var require_extract = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var util$1 = __require("util");
	var bl = require_bl();
	var headers = require_headers();
	var Writable = require_readable().Writable;
	var PassThrough = require_readable().PassThrough;
	var noop = function() {};
	var overflow = function(size) {
		size &= 511;
		return size && 512 - size;
	};
	var emptyStream = function(self, offset) {
		var s = new Source(self, offset);
		s.end();
		return s;
	};
	var mixinPax = function(header, pax) {
		if (pax.path) header.name = pax.path;
		if (pax.linkpath) header.linkname = pax.linkpath;
		if (pax.size) header.size = parseInt(pax.size, 10);
		header.pax = pax;
		return header;
	};
	var Source = function(self, offset) {
		this._parent = self;
		this.offset = offset;
		PassThrough.call(this, { autoDestroy: false });
	};
	util$1.inherits(Source, PassThrough);
	Source.prototype.destroy = function(err) {
		this._parent.destroy(err);
	};
	var Extract = function(opts) {
		if (!(this instanceof Extract)) return new Extract(opts);
		Writable.call(this, opts);
		opts = opts || {};
		this._offset = 0;
		this._buffer = bl();
		this._missing = 0;
		this._partial = false;
		this._onparse = noop;
		this._header = null;
		this._stream = null;
		this._overflow = null;
		this._cb = null;
		this._locked = false;
		this._destroyed = false;
		this._pax = null;
		this._paxGlobal = null;
		this._gnuLongPath = null;
		this._gnuLongLinkPath = null;
		var self = this;
		var b = self._buffer;
		var oncontinue = function() {
			self._continue();
		};
		var onunlock = function(err) {
			self._locked = false;
			if (err) return self.destroy(err);
			if (!self._stream) oncontinue();
		};
		var onstreamend = function() {
			self._stream = null;
			var drain = overflow(self._header.size);
			if (drain) self._parse(drain, ondrain);
			else self._parse(512, onheader);
			if (!self._locked) oncontinue();
		};
		var ondrain = function() {
			self._buffer.consume(overflow(self._header.size));
			self._parse(512, onheader);
			oncontinue();
		};
		var onpaxglobalheader = function() {
			var size = self._header.size;
			self._paxGlobal = headers.decodePax(b.slice(0, size));
			b.consume(size);
			onstreamend();
		};
		var onpaxheader = function() {
			var size = self._header.size;
			self._pax = headers.decodePax(b.slice(0, size));
			if (self._paxGlobal) self._pax = Object.assign({}, self._paxGlobal, self._pax);
			b.consume(size);
			onstreamend();
		};
		var ongnulongpath = function() {
			var size = self._header.size;
			this._gnuLongPath = headers.decodeLongPath(b.slice(0, size), opts.filenameEncoding);
			b.consume(size);
			onstreamend();
		};
		var ongnulonglinkpath = function() {
			var size = self._header.size;
			this._gnuLongLinkPath = headers.decodeLongPath(b.slice(0, size), opts.filenameEncoding);
			b.consume(size);
			onstreamend();
		};
		var onheader = function() {
			var offset = self._offset;
			var header;
			try {
				header = self._header = headers.decode(b.slice(0, 512), opts.filenameEncoding, opts.allowUnknownFormat);
			} catch (err) {
				self.emit("error", err);
			}
			b.consume(512);
			if (!header) {
				self._parse(512, onheader);
				oncontinue();
				return;
			}
			if (header.type === "gnu-long-path") {
				self._parse(header.size, ongnulongpath);
				oncontinue();
				return;
			}
			if (header.type === "gnu-long-link-path") {
				self._parse(header.size, ongnulonglinkpath);
				oncontinue();
				return;
			}
			if (header.type === "pax-global-header") {
				self._parse(header.size, onpaxglobalheader);
				oncontinue();
				return;
			}
			if (header.type === "pax-header") {
				self._parse(header.size, onpaxheader);
				oncontinue();
				return;
			}
			if (self._gnuLongPath) {
				header.name = self._gnuLongPath;
				self._gnuLongPath = null;
			}
			if (self._gnuLongLinkPath) {
				header.linkname = self._gnuLongLinkPath;
				self._gnuLongLinkPath = null;
			}
			if (self._pax) {
				self._header = header = mixinPax(header, self._pax);
				self._pax = null;
			}
			self._locked = true;
			if (!header.size || header.type === "directory") {
				self._parse(512, onheader);
				self.emit("entry", header, emptyStream(self, offset), onunlock);
				return;
			}
			self._stream = new Source(self, offset);
			self.emit("entry", header, self._stream, onunlock);
			self._parse(header.size, onstreamend);
			oncontinue();
		};
		this._onheader = onheader;
		this._parse(512, onheader);
	};
	util$1.inherits(Extract, Writable);
	Extract.prototype.destroy = function(err) {
		if (this._destroyed) return;
		this._destroyed = true;
		if (err) this.emit("error", err);
		this.emit("close");
		if (this._stream) this._stream.emit("close");
	};
	Extract.prototype._parse = function(size, onparse) {
		if (this._destroyed) return;
		this._offset += size;
		this._missing = size;
		if (onparse === this._onheader) this._partial = false;
		this._onparse = onparse;
	};
	Extract.prototype._continue = function() {
		if (this._destroyed) return;
		var cb = this._cb;
		this._cb = noop;
		if (this._overflow) this._write(this._overflow, void 0, cb);
		else cb();
	};
	Extract.prototype._write = function(data, enc, cb) {
		if (this._destroyed) return;
		var s = this._stream;
		var b = this._buffer;
		var missing = this._missing;
		if (data.length) this._partial = true;
		if (data.length < missing) {
			this._missing -= data.length;
			this._overflow = null;
			if (s) return s.write(data, cb);
			b.append(data);
			return cb();
		}
		this._cb = cb;
		this._missing = 0;
		var overflow = null;
		if (data.length > missing) {
			overflow = data.slice(missing);
			data = data.slice(0, missing);
		}
		if (s) s.end(data);
		else b.append(data);
		this._overflow = overflow;
		this._onparse();
	};
	Extract.prototype._final = function(cb) {
		if (this._partial) return this.destroy(/* @__PURE__ */ new Error("Unexpected end of data"));
		cb();
	};
	module.exports = Extract;
}));
//#endregion
//#region ../../node_modules/.pnpm/fs-constants@1.0.0/node_modules/fs-constants/index.js
var require_fs_constants = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = __require("fs").constants || __require("constants");
}));
//#endregion
//#region ../../node_modules/.pnpm/wrappy@1.0.2/node_modules/wrappy/wrappy.js
var require_wrappy = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = wrappy;
	function wrappy(fn, cb) {
		if (fn && cb) return wrappy(fn)(cb);
		if (typeof fn !== "function") throw new TypeError("need wrapper function");
		Object.keys(fn).forEach(function(k) {
			wrapper[k] = fn[k];
		});
		return wrapper;
		function wrapper() {
			var args = new Array(arguments.length);
			for (var i = 0; i < args.length; i++) args[i] = arguments[i];
			var ret = fn.apply(this, args);
			var cb = args[args.length - 1];
			if (typeof ret === "function" && ret !== cb) Object.keys(cb).forEach(function(k) {
				ret[k] = cb[k];
			});
			return ret;
		}
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/once@1.4.0/node_modules/once/once.js
var require_once = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var wrappy = require_wrappy();
	module.exports = wrappy(once);
	module.exports.strict = wrappy(onceStrict);
	once.proto = once(function() {
		Object.defineProperty(Function.prototype, "once", {
			value: function() {
				return once(this);
			},
			configurable: true
		});
		Object.defineProperty(Function.prototype, "onceStrict", {
			value: function() {
				return onceStrict(this);
			},
			configurable: true
		});
	});
	function once(fn) {
		var f = function() {
			if (f.called) return f.value;
			f.called = true;
			return f.value = fn.apply(this, arguments);
		};
		f.called = false;
		return f;
	}
	function onceStrict(fn) {
		var f = function() {
			if (f.called) throw new Error(f.onceError);
			f.called = true;
			return f.value = fn.apply(this, arguments);
		};
		f.onceError = (fn.name || "Function wrapped with `once`") + " shouldn't be called more than once";
		f.called = false;
		return f;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/end-of-stream@1.4.5/node_modules/end-of-stream/index.js
var require_end_of_stream = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var once = require_once();
	var noop = function() {};
	var qnt = global.Bare ? queueMicrotask : process.nextTick.bind(process);
	var isRequest = function(stream) {
		return stream.setHeader && typeof stream.abort === "function";
	};
	var isChildProcess = function(stream) {
		return stream.stdio && Array.isArray(stream.stdio) && stream.stdio.length === 3;
	};
	var eos = function(stream, opts, callback) {
		if (typeof opts === "function") return eos(stream, null, opts);
		if (!opts) opts = {};
		callback = once(callback || noop);
		var ws = stream._writableState;
		var rs = stream._readableState;
		var readable = opts.readable || opts.readable !== false && stream.readable;
		var writable = opts.writable || opts.writable !== false && stream.writable;
		var cancelled = false;
		var onlegacyfinish = function() {
			if (!stream.writable) onfinish();
		};
		var onfinish = function() {
			writable = false;
			if (!readable) callback.call(stream);
		};
		var onend = function() {
			readable = false;
			if (!writable) callback.call(stream);
		};
		var onexit = function(exitCode) {
			callback.call(stream, exitCode ? /* @__PURE__ */ new Error("exited with error code: " + exitCode) : null);
		};
		var onerror = function(err) {
			callback.call(stream, err);
		};
		var onclose = function() {
			qnt(onclosenexttick);
		};
		var onclosenexttick = function() {
			if (cancelled) return;
			if (readable && !(rs && rs.ended && !rs.destroyed)) return callback.call(stream, /* @__PURE__ */ new Error("premature close"));
			if (writable && !(ws && ws.ended && !ws.destroyed)) return callback.call(stream, /* @__PURE__ */ new Error("premature close"));
		};
		var onrequest = function() {
			stream.req.on("finish", onfinish);
		};
		if (isRequest(stream)) {
			stream.on("complete", onfinish);
			stream.on("abort", onclose);
			if (stream.req) onrequest();
			else stream.on("request", onrequest);
		} else if (writable && !ws) {
			stream.on("end", onlegacyfinish);
			stream.on("close", onlegacyfinish);
		}
		if (isChildProcess(stream)) stream.on("exit", onexit);
		stream.on("end", onend);
		stream.on("finish", onfinish);
		if (opts.error !== false) stream.on("error", onerror);
		stream.on("close", onclose);
		return function() {
			cancelled = true;
			stream.removeListener("complete", onfinish);
			stream.removeListener("abort", onclose);
			stream.removeListener("request", onrequest);
			if (stream.req) stream.req.removeListener("finish", onfinish);
			stream.removeListener("end", onlegacyfinish);
			stream.removeListener("close", onlegacyfinish);
			stream.removeListener("finish", onfinish);
			stream.removeListener("exit", onexit);
			stream.removeListener("end", onend);
			stream.removeListener("error", onerror);
			stream.removeListener("close", onclose);
		};
	};
	module.exports = eos;
}));
//#endregion
//#region ../../node_modules/.pnpm/tar-stream@2.2.0/node_modules/tar-stream/pack.js
var require_pack = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var constants = require_fs_constants();
	var eos = require_end_of_stream();
	var inherits = require_inherits();
	var alloc = Buffer.alloc;
	var Readable = require_readable().Readable;
	var Writable = require_readable().Writable;
	var StringDecoder = __require("string_decoder").StringDecoder;
	var headers = require_headers();
	var DMODE = parseInt("755", 8);
	var FMODE = parseInt("644", 8);
	var END_OF_TAR = alloc(1024);
	var noop = function() {};
	var overflow = function(self, size) {
		size &= 511;
		if (size) self.push(END_OF_TAR.slice(0, 512 - size));
	};
	function modeToType(mode) {
		switch (mode & constants.S_IFMT) {
			case constants.S_IFBLK: return "block-device";
			case constants.S_IFCHR: return "character-device";
			case constants.S_IFDIR: return "directory";
			case constants.S_IFIFO: return "fifo";
			case constants.S_IFLNK: return "symlink";
		}
		return "file";
	}
	var Sink = function(to) {
		Writable.call(this);
		this.written = 0;
		this._to = to;
		this._destroyed = false;
	};
	inherits(Sink, Writable);
	Sink.prototype._write = function(data, enc, cb) {
		this.written += data.length;
		if (this._to.push(data)) return cb();
		this._to._drain = cb;
	};
	Sink.prototype.destroy = function() {
		if (this._destroyed) return;
		this._destroyed = true;
		this.emit("close");
	};
	var LinkSink = function() {
		Writable.call(this);
		this.linkname = "";
		this._decoder = new StringDecoder("utf-8");
		this._destroyed = false;
	};
	inherits(LinkSink, Writable);
	LinkSink.prototype._write = function(data, enc, cb) {
		this.linkname += this._decoder.write(data);
		cb();
	};
	LinkSink.prototype.destroy = function() {
		if (this._destroyed) return;
		this._destroyed = true;
		this.emit("close");
	};
	var Void = function() {
		Writable.call(this);
		this._destroyed = false;
	};
	inherits(Void, Writable);
	Void.prototype._write = function(data, enc, cb) {
		cb(/* @__PURE__ */ new Error("No body allowed for this entry"));
	};
	Void.prototype.destroy = function() {
		if (this._destroyed) return;
		this._destroyed = true;
		this.emit("close");
	};
	var Pack = function(opts) {
		if (!(this instanceof Pack)) return new Pack(opts);
		Readable.call(this, opts);
		this._drain = noop;
		this._finalized = false;
		this._finalizing = false;
		this._destroyed = false;
		this._stream = null;
	};
	inherits(Pack, Readable);
	Pack.prototype.entry = function(header, buffer, callback) {
		if (this._stream) throw new Error("already piping an entry");
		if (this._finalized || this._destroyed) return;
		if (typeof buffer === "function") {
			callback = buffer;
			buffer = null;
		}
		if (!callback) callback = noop;
		var self = this;
		if (!header.size || header.type === "symlink") header.size = 0;
		if (!header.type) header.type = modeToType(header.mode);
		if (!header.mode) header.mode = header.type === "directory" ? DMODE : FMODE;
		if (!header.uid) header.uid = 0;
		if (!header.gid) header.gid = 0;
		if (!header.mtime) header.mtime = /* @__PURE__ */ new Date();
		if (typeof buffer === "string") buffer = Buffer.from(buffer);
		if (Buffer.isBuffer(buffer)) {
			header.size = buffer.length;
			this._encode(header);
			var ok = this.push(buffer);
			overflow(self, header.size);
			if (ok) process.nextTick(callback);
			else this._drain = callback;
			return new Void();
		}
		if (header.type === "symlink" && !header.linkname) {
			var linkSink = new LinkSink();
			eos(linkSink, function(err) {
				if (err) {
					self.destroy();
					return callback(err);
				}
				header.linkname = linkSink.linkname;
				self._encode(header);
				callback();
			});
			return linkSink;
		}
		this._encode(header);
		if (header.type !== "file" && header.type !== "contiguous-file") {
			process.nextTick(callback);
			return new Void();
		}
		var sink = new Sink(this);
		this._stream = sink;
		eos(sink, function(err) {
			self._stream = null;
			if (err) {
				self.destroy();
				return callback(err);
			}
			if (sink.written !== header.size) {
				self.destroy();
				return callback(/* @__PURE__ */ new Error("size mismatch"));
			}
			overflow(self, header.size);
			if (self._finalizing) self.finalize();
			callback();
		});
		return sink;
	};
	Pack.prototype.finalize = function() {
		if (this._stream) {
			this._finalizing = true;
			return;
		}
		if (this._finalized) return;
		this._finalized = true;
		this.push(END_OF_TAR);
		this.push(null);
	};
	Pack.prototype.destroy = function(err) {
		if (this._destroyed) return;
		this._destroyed = true;
		if (err) this.emit("error", err);
		this.emit("close");
		if (this._stream && this._stream.destroy) this._stream.destroy();
	};
	Pack.prototype._encode = function(header) {
		if (!header.pax) {
			var buf = headers.encode(header);
			if (buf) {
				this.push(buf);
				return;
			}
		}
		this._encodePax(header);
	};
	Pack.prototype._encodePax = function(header) {
		var paxHeader = headers.encodePax({
			name: header.name,
			linkname: header.linkname,
			pax: header.pax
		});
		var newHeader = {
			name: "PaxHeader",
			mode: header.mode,
			uid: header.uid,
			gid: header.gid,
			size: paxHeader.length,
			mtime: header.mtime,
			type: "pax-header",
			linkname: header.linkname && "PaxHeader",
			uname: header.uname,
			gname: header.gname,
			devmajor: header.devmajor,
			devminor: header.devminor
		};
		this.push(headers.encode(newHeader));
		this.push(paxHeader);
		overflow(this, paxHeader.length);
		newHeader.size = header.size;
		newHeader.type = header.type;
		this.push(headers.encode(newHeader));
	};
	Pack.prototype._read = function(n) {
		var drain = this._drain;
		this._drain = noop;
		drain();
	};
	module.exports = Pack;
}));
//#endregion
//#region ../../node_modules/.pnpm/tar-stream@2.2.0/node_modules/tar-stream/index.js
var require_tar_stream = /* @__PURE__ */ __commonJSMin(((exports) => {
	exports.extract = require_extract();
	exports.pack = require_pack();
}));
//#endregion
//#region ../../node_modules/.pnpm/pump@3.0.4/node_modules/pump/index.js
var require_pump = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var once = require_once();
	var eos = require_end_of_stream();
	var fs;
	try {
		fs = __require("fs");
	} catch (e) {}
	var noop = function() {};
	var ancient = typeof process === "undefined" ? false : /^v?\.0/.test(process.version);
	var isFn = function(fn) {
		return typeof fn === "function";
	};
	var isFS = function(stream) {
		if (!ancient) return false;
		if (!fs) return false;
		return (stream instanceof (fs.ReadStream || noop) || stream instanceof (fs.WriteStream || noop)) && isFn(stream.close);
	};
	var isRequest = function(stream) {
		return stream.setHeader && isFn(stream.abort);
	};
	var destroyer = function(stream, reading, writing, callback) {
		callback = once(callback);
		var closed = false;
		stream.on("close", function() {
			closed = true;
		});
		eos(stream, {
			readable: reading,
			writable: writing
		}, function(err) {
			if (err) return callback(err);
			closed = true;
			callback();
		});
		var destroyed = false;
		return function(err) {
			if (closed) return;
			if (destroyed) return;
			destroyed = true;
			if (isFS(stream)) return stream.close(noop);
			if (isRequest(stream)) return stream.abort();
			if (isFn(stream.destroy)) return stream.destroy();
			callback(err || /* @__PURE__ */ new Error("stream was destroyed"));
		};
	};
	var call = function(fn) {
		fn();
	};
	var pipe = function(from, to) {
		return from.pipe(to);
	};
	var pump = function() {
		var streams = Array.prototype.slice.call(arguments);
		var callback = isFn(streams[streams.length - 1] || noop) && streams.pop() || noop;
		if (Array.isArray(streams[0])) streams = streams[0];
		if (streams.length < 2) throw new Error("pump requires two streams per minimum");
		var error;
		var destroys = streams.map(function(stream, i) {
			var reading = i < streams.length - 1;
			return destroyer(stream, reading, i > 0, function(err) {
				if (!error) error = err;
				if (err) destroys.forEach(call);
				if (reading) return;
				destroys.forEach(call);
				callback(error);
			});
		});
		return streams.reduce(pipe);
	};
	module.exports = pump;
}));
//#endregion
//#region ../../node_modules/.pnpm/mkdirp-classic@0.5.3/node_modules/mkdirp-classic/index.js
var require_mkdirp_classic = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var path$3 = __require("path");
	var fs$2 = __require("fs");
	var _0777 = parseInt("0777", 8);
	module.exports = mkdirP.mkdirp = mkdirP.mkdirP = mkdirP;
	function mkdirP(p, opts, f, made) {
		if (typeof opts === "function") {
			f = opts;
			opts = {};
		} else if (!opts || typeof opts !== "object") opts = { mode: opts };
		var mode = opts.mode;
		var xfs = opts.fs || fs$2;
		if (mode === void 0) mode = _0777 & ~process.umask();
		if (!made) made = null;
		var cb = f || function() {};
		p = path$3.resolve(p);
		xfs.mkdir(p, mode, function(er) {
			if (!er) {
				made = made || p;
				return cb(null, made);
			}
			switch (er.code) {
				case "ENOENT":
					mkdirP(path$3.dirname(p), opts, function(er, made) {
						if (er) cb(er, made);
						else mkdirP(p, opts, cb, made);
					});
					break;
				default:
					xfs.stat(p, function(er2, stat) {
						if (er2 || !stat.isDirectory()) cb(er, made);
						else cb(null, made);
					});
					break;
			}
		});
	}
	mkdirP.sync = function sync(p, opts, made) {
		if (!opts || typeof opts !== "object") opts = { mode: opts };
		var mode = opts.mode;
		var xfs = opts.fs || fs$2;
		if (mode === void 0) mode = _0777 & ~process.umask();
		if (!made) made = null;
		p = path$3.resolve(p);
		try {
			xfs.mkdirSync(p, mode);
			made = made || p;
		} catch (err0) {
			switch (err0.code) {
				case "ENOENT":
					made = sync(path$3.dirname(p), opts, made);
					sync(p, opts, made);
					break;
				default:
					var stat;
					try {
						stat = xfs.statSync(p);
					} catch (err1) {
						throw err0;
					}
					if (!stat.isDirectory()) throw err0;
					break;
			}
		}
		return made;
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/tar-fs@2.1.4/node_modules/tar-fs/index.js
var require_tar_fs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var chownr = require_chownr();
	var tar = require_tar_stream();
	var pump = require_pump();
	var mkdirp = require_mkdirp_classic();
	var fs$1 = __require("fs");
	var path$2 = __require("path");
	var win32 = __require("os").platform() === "win32";
	var noop = function() {};
	var echo = function(name) {
		return name;
	};
	var normalize = !win32 ? echo : function(name) {
		return name.replace(/\\/g, "/").replace(/[:?<>|]/g, "_");
	};
	var statAll = function(fs, stat, cwd, ignore, entries, sort) {
		var queue = entries || ["."];
		return function loop(callback) {
			if (!queue.length) return callback();
			var next = queue.shift();
			var nextAbs = path$2.join(cwd, next);
			stat.call(fs, nextAbs, function(err, stat) {
				if (err) return callback(err);
				if (!stat.isDirectory()) return callback(null, next, stat);
				fs.readdir(nextAbs, function(err, files) {
					if (err) return callback(err);
					if (sort) files.sort();
					for (var i = 0; i < files.length; i++) if (!ignore(path$2.join(cwd, next, files[i]))) queue.push(path$2.join(next, files[i]));
					callback(null, next, stat);
				});
			});
		};
	};
	var strip = function(map, level) {
		return function(header) {
			header.name = header.name.split("/").slice(level).join("/");
			var linkname = header.linkname;
			if (linkname && (header.type === "link" || path$2.isAbsolute(linkname))) header.linkname = linkname.split("/").slice(level).join("/");
			return map(header);
		};
	};
	exports.pack = function(cwd, opts) {
		if (!cwd) cwd = ".";
		if (!opts) opts = {};
		var xfs = opts.fs || fs$1;
		var ignore = opts.ignore || opts.filter || noop;
		var map = opts.map || noop;
		var mapStream = opts.mapStream || echo;
		var statNext = statAll(xfs, opts.dereference ? xfs.stat : xfs.lstat, cwd, ignore, opts.entries, opts.sort);
		var strict = opts.strict !== false;
		var umask = typeof opts.umask === "number" ? ~opts.umask : ~processUmask();
		var dmode = typeof opts.dmode === "number" ? opts.dmode : 0;
		var fmode = typeof opts.fmode === "number" ? opts.fmode : 0;
		var pack = opts.pack || tar.pack();
		var finish = opts.finish || noop;
		if (opts.strip) map = strip(map, opts.strip);
		if (opts.readable) {
			dmode |= parseInt(555, 8);
			fmode |= parseInt(444, 8);
		}
		if (opts.writable) {
			dmode |= parseInt(333, 8);
			fmode |= parseInt(222, 8);
		}
		var onsymlink = function(filename, header) {
			xfs.readlink(path$2.join(cwd, filename), function(err, linkname) {
				if (err) return pack.destroy(err);
				header.linkname = normalize(linkname);
				pack.entry(header, onnextentry);
			});
		};
		var onstat = function(err, filename, stat) {
			if (err) return pack.destroy(err);
			if (!filename) {
				if (opts.finalize !== false) pack.finalize();
				return finish(pack);
			}
			if (stat.isSocket()) return onnextentry();
			var header = {
				name: normalize(filename),
				mode: (stat.mode | (stat.isDirectory() ? dmode : fmode)) & umask,
				mtime: stat.mtime,
				size: stat.size,
				type: "file",
				uid: stat.uid,
				gid: stat.gid
			};
			if (stat.isDirectory()) {
				header.size = 0;
				header.type = "directory";
				header = map(header) || header;
				return pack.entry(header, onnextentry);
			}
			if (stat.isSymbolicLink()) {
				header.size = 0;
				header.type = "symlink";
				header = map(header) || header;
				return onsymlink(filename, header);
			}
			header = map(header) || header;
			if (!stat.isFile()) {
				if (strict) return pack.destroy(/* @__PURE__ */ new Error("unsupported type for " + filename));
				return onnextentry();
			}
			var entry = pack.entry(header, onnextentry);
			if (!entry) return;
			var rs = mapStream(xfs.createReadStream(path$2.join(cwd, filename), {
				start: 0,
				end: header.size > 0 ? header.size - 1 : header.size
			}), header);
			rs.on("error", function(err) {
				entry.destroy(err);
			});
			pump(rs, entry);
		};
		var onnextentry = function(err) {
			if (err) return pack.destroy(err);
			statNext(onstat);
		};
		onnextentry();
		return pack;
	};
	var head = function(list) {
		return list.length ? list[list.length - 1] : null;
	};
	var processGetuid = function() {
		return process.getuid ? process.getuid() : -1;
	};
	var processUmask = function() {
		return process.umask ? process.umask() : 0;
	};
	exports.extract = function(cwd, opts) {
		if (!cwd) cwd = ".";
		if (!opts) opts = {};
		var xfs = opts.fs || fs$1;
		var ignore = opts.ignore || opts.filter || noop;
		var map = opts.map || noop;
		var mapStream = opts.mapStream || echo;
		var own = opts.chown !== false && !win32 && processGetuid() === 0;
		var extract = opts.extract || tar.extract();
		var stack = [];
		var now = /* @__PURE__ */ new Date();
		var umask = typeof opts.umask === "number" ? ~opts.umask : ~processUmask();
		var dmode = typeof opts.dmode === "number" ? opts.dmode : 0;
		var fmode = typeof opts.fmode === "number" ? opts.fmode : 0;
		var strict = opts.strict !== false;
		if (opts.strip) map = strip(map, opts.strip);
		if (opts.readable) {
			dmode |= parseInt(555, 8);
			fmode |= parseInt(444, 8);
		}
		if (opts.writable) {
			dmode |= parseInt(333, 8);
			fmode |= parseInt(222, 8);
		}
		var utimesParent = function(name, cb) {
			var top;
			while ((top = head(stack)) && name.slice(0, top[0].length) !== top[0]) stack.pop();
			if (!top) return cb();
			xfs.utimes(top[0], now, top[1], cb);
		};
		var utimes = function(name, header, cb) {
			if (opts.utimes === false) return cb();
			if (header.type === "directory") return xfs.utimes(name, now, header.mtime, cb);
			if (header.type === "symlink") return utimesParent(name, cb);
			xfs.utimes(name, now, header.mtime, function(err) {
				if (err) return cb(err);
				utimesParent(name, cb);
			});
		};
		var chperm = function(name, header, cb) {
			var link = header.type === "symlink";
			var chmod = link ? xfs.lchmod : xfs.chmod;
			var chown = link ? xfs.lchown : xfs.chown;
			if (!chmod) return cb();
			var mode = (header.mode | (header.type === "directory" ? dmode : fmode)) & umask;
			if (chown && own) chown.call(xfs, name, header.uid, header.gid, onchown);
			else onchown(null);
			function onchown(err) {
				if (err) return cb(err);
				if (!chmod) return cb();
				chmod.call(xfs, name, mode, cb);
			}
		};
		extract.on("entry", function(header, stream, next) {
			header = map(header) || header;
			header.name = normalize(header.name);
			var name = path$2.join(cwd, path$2.join("/", header.name));
			if (ignore(name, header)) {
				stream.resume();
				return next();
			}
			var stat = function(err) {
				if (err) return next(err);
				utimes(name, header, function(err) {
					if (err) return next(err);
					if (win32) return next();
					chperm(name, header, next);
				});
			};
			var onsymlink = function() {
				if (win32) return next();
				xfs.unlink(name, function() {
					if (!inCwd(path$2.resolve(path$2.dirname(name), header.linkname), cwd)) return next(/* @__PURE__ */ new Error(name + " is not a valid symlink"));
					xfs.symlink(header.linkname, name, stat);
				});
			};
			var onlink = function() {
				if (win32) return next();
				xfs.unlink(name, function() {
					var srcpath = path$2.join(cwd, path$2.join("/", header.linkname));
					xfs.realpath(srcpath, function(err, dst) {
						if (err || !inCwd(dst, cwd)) return next(/* @__PURE__ */ new Error(name + " is not a valid hardlink"));
						xfs.link(dst, name, function(err) {
							if (err && err.code === "EPERM" && opts.hardlinkAsFilesFallback) {
								stream = xfs.createReadStream(srcpath);
								return onfile();
							}
							stat(err);
						});
					});
				});
			};
			var onfile = function() {
				var ws = xfs.createWriteStream(name);
				var rs = mapStream(stream, header);
				ws.on("error", function(err) {
					rs.destroy(err);
				});
				pump(rs, ws, function(err) {
					if (err) return next(err);
					ws.on("close", stat);
				});
			};
			if (header.type === "directory") {
				stack.push([name, header.mtime]);
				return mkdirfix(name, {
					fs: xfs,
					own,
					uid: header.uid,
					gid: header.gid
				}, stat);
			}
			var dir = path$2.dirname(name);
			validate(xfs, dir, path$2.join(cwd, "."), function(err, valid) {
				if (err) return next(err);
				if (!valid) return next(/* @__PURE__ */ new Error(dir + " is not a valid path"));
				mkdirfix(dir, {
					fs: xfs,
					own,
					uid: header.uid,
					gid: header.gid
				}, function(err) {
					if (err) return next(err);
					switch (header.type) {
						case "file": return onfile();
						case "link": return onlink();
						case "symlink": return onsymlink();
					}
					if (strict) return next(/* @__PURE__ */ new Error("unsupported type for " + name + " (" + header.type + ")"));
					stream.resume();
					next();
				});
			});
		});
		if (opts.finish) extract.on("finish", opts.finish);
		return extract;
	};
	function validate(fs, name, root, cb) {
		if (name === root) return cb(null, true);
		fs.lstat(name, function(err, st) {
			if (err && err.code !== "ENOENT") return cb(err);
			if (err || st.isDirectory()) return validate(fs, path$2.join(name, ".."), root, cb);
			cb(null, false);
		});
	}
	function mkdirfix(name, opts, cb) {
		mkdirp(name, { fs: opts.fs }, function(err, made) {
			if (!err && made && opts.own) chownr(made, opts.uid, opts.gid, cb);
			else cb(err);
		});
	}
	function inCwd(dst, cwd) {
		cwd = path$2.resolve(cwd);
		return cwd === dst || dst.startsWith(cwd + path$2.sep);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/dockerode@4.0.9/node_modules/dockerode/lib/util.js
var require_util = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var DockerIgnore = require_ignore();
	var fs = __require("fs");
	var path$1 = __require("path");
	var tar = require_tar_fs();
	var zlib = __require("zlib");
	var arr = [];
	var each = arr.forEach;
	var slice = arr.slice;
	module.exports.extend = function(obj) {
		each.call(slice.call(arguments, 1), function(source) {
			if (source) for (var prop in source) obj[prop] = source[prop];
		});
		return obj;
	};
	module.exports.processArgs = function(opts, callback, defaultOpts) {
		if (!callback && typeof opts === "function") {
			callback = opts;
			opts = null;
		}
		return {
			callback,
			opts: module.exports.extend({}, defaultOpts, opts)
		};
	};
	/**
	* Parse the given repo tag name (as a string) and break it out into repo/tag pair.
	* // if given the input http://localhost:8080/woot:latest
	* {
	*   repository: 'http://localhost:8080/woot',
	*   tag: 'latest'
	* }
	* @param {String} input Input e.g: 'repo/foo', 'ubuntu', 'ubuntu:latest'
	* @return {Object} input parsed into the repo and tag.
	*/
	module.exports.parseRepositoryTag = function(input) {
		var separatorPos;
		var digestPos = input.indexOf("@");
		var colonPos = input.lastIndexOf(":");
		if (digestPos >= 0) separatorPos = digestPos;
		else if (colonPos >= 0) separatorPos = colonPos;
		else return { repository: input };
		var tag = input.slice(separatorPos + 1);
		if (tag.indexOf("/") === -1) return {
			repository: input.slice(0, separatorPos),
			tag
		};
		return { repository: input };
	};
	module.exports.prepareBuildContext = function(file, next) {
		if (file && file.context) fs.readFile(path$1.join(file.context, ".dockerignore"), (err, data) => {
			let ignoreFn;
			let filterFn;
			if (!err) {
				filterFn = DockerIgnore({ ignorecase: false }).add(data.toString()).createFilter();
				ignoreFn = (path) => {
					return !filterFn(path);
				};
			}
			const entries = file.src.slice() || [];
			next(tar.pack(file.context, {
				entries: filterFn ? entries.filter(filterFn) : entries,
				ignore: ignoreFn
			}).pipe(zlib.createGzip()));
		});
		else next(file);
	};
}));
//#endregion
//#region ../../node_modules/.pnpm/dockerode@4.0.9/node_modules/dockerode/lib/exec.js
var require_exec = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var util = require_util();
	/**
	* Represents an Exec
	* @param {Object} modem docker-modem
	* @param {String} id    Exec's ID
	*/
	var Exec = function(modem, id) {
		this.modem = modem;
		this.id = id;
	};
	Exec.prototype[__require("util").inspect.custom] = function() {
		return this;
	};
	/**
	* Start the exec call that was setup.
	*
	* @param {object} opts
	* @param {function} callback
	*/
	Exec.prototype.start = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/exec/" + this.id + "/start",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			isStream: true,
			allowEmpty: true,
			hijack: args.opts.hijack,
			openStdin: args.opts.stdin,
			statusCodes: {
				200: true,
				204: true,
				404: "no such exec",
				409: "container stopped/paused",
				500: "container not running"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			if (err) return args.callback(err, data);
			args.callback(err, data);
		});
	};
	/**
	* Resize the exec call that was setup.
	*
	* @param {object} opts
	* @param {function} callback
	*/
	Exec.prototype.resize = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/exec/" + this.id + "/resize?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "no such exec",
				500: "container not running"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			if (err) return args.callback(err, data);
			args.callback(err, data);
		});
	};
	/**
	* Get low-level information about the exec call.
	*
	* @param {Object}   opts     Options (optional)
	* @param {function} callback
	*/
	Exec.prototype.inspect = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/exec/" + this.id + "/json",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "no such exec",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			if (err) return args.callback(err, data);
			args.callback(err, data);
		});
	};
	module.exports = Exec;
}));
//#endregion
//#region ../../node_modules/.pnpm/dockerode@4.0.9/node_modules/dockerode/lib/container.js
var require_container = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	require_util().extend;
	var Exec = require_exec(), util = require_util();
	/**
	* Represents a Container
	* @param {Object} modem docker-modem
	* @param {String} id    Container's ID
	*/
	var Container = function(modem, id) {
		this.modem = modem;
		this.id = id;
		this.defaultOptions = {
			top: {},
			start: {},
			commit: {},
			stop: {},
			pause: {},
			unpause: {},
			restart: {},
			resize: {},
			attach: {},
			remove: {},
			copy: {},
			kill: {},
			exec: {},
			rename: {},
			log: {},
			stats: {},
			getArchive: {},
			infoArchive: {},
			putArchive: {},
			update: {},
			wait: {}
		};
	};
	Container.prototype[__require("util").inspect.custom] = function() {
		return this;
	};
	/**
	* Inspect
	* @param  {Object}   opts     Options (optional)
	* @param  {Function} callback Callback, if supplied will query Docker.
	* @return {Object}            ID only and only if callback isn't supplied.
	*/
	Container.prototype.inspect = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/containers/" + this.id + "/json?",
			method: "GET",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "no such container",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Rename
	* @param  {Object}   opts     Rename options
	* @param  {Function} callback Callback
	*/
	Container.prototype.rename = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.rename);
		var optsf = {
			path: "/containers/" + this.id + "/rename?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Update
	* @param  {Object}   opts     Update options
	* @param  {Function} callback Callback
	*/
	Container.prototype.update = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.update);
		var optsf = {
			path: "/containers/" + this.id + "/update",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				400: "bad parameter",
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Top
	* @param  {Object}   opts like 'ps_args' (optional)
	* @param  {Function} callback Callback
	*/
	Container.prototype.top = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.top);
		var optsf = {
			path: "/containers/" + this.id + "/top?",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Containers changes
	* @param  {Object}   Options
	* @param  {Function} callback Callback
	*/
	Container.prototype.changes = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/containers/" + this.id + "/changes",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "no such container",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Checkpoints list
	* @param  {Object}   opts     List checkpoints options (optional)
	* @param  {Function} callback Callback
	*/
	Container.prototype.listCheckpoint = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/containers/" + this.id + "/checkpoints?",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Delete checkpoint
	* @param  {Object}   opts     Delete checkpoint options (optional)
	* @param  {Function} callback Callback
	*/
	Container.prototype.deleteCheckpoint = function(checkpoint, opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/containers/" + this.id + "/checkpoints/" + checkpoint + "?",
			method: "DELETE",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Create checkpoint
	* @param  {Object}   opts     Create checkpoint options (optional)
	* @param  {Function} callback Callback
	*/
	Container.prototype.createCheckpoint = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/containers/" + this.id + "/checkpoints",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			allowEmpty: true,
			statusCodes: {
				200: true,
				201: true,
				204: true,
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Export
	* @param  {Object}   opts     Options (optional)
	* @param  {Function} callback Callback with the octet-stream.
	*/
	Container.prototype.export = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/containers/" + this.id + "/export",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			isStream: true,
			statusCodes: {
				200: true,
				404: "no such container",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Start
	* @param  {Object}   opts     Container start options (optional)
	* @param  {Function} callback Callback
	*/
	Container.prototype.start = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.start);
		var optsf = {
			path: "/containers/" + this.id + "/start?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				304: "container already started",
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Pause
	* @param  {Object}   opts     Pause options (optional)
	* @param  {Function} callback Callback
	*/
	Container.prototype.pause = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.pause);
		var optsf = {
			path: "/containers/" + this.id + "/pause",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Unpause
	* @param  {Object}   opts     Unpause options (optional)
	* @param  {Function} callback Callback
	*/
	Container.prototype.unpause = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.unpause);
		var optsf = {
			path: "/containers/" + this.id + "/unpause",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Setup an exec call to a running container
	*
	* @param {object} opts
	* @param {function} callback
	*/
	Container.prototype.exec = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.exec);
		var optsf = {
			path: "/containers/" + this.id + "/exec",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				201: true,
				404: "no such container",
				409: "container stopped/paused",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(new Exec(self.modem, data.Id));
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			if (err) return args.callback(err, data);
			args.callback(err, new Exec(self.modem, data.Id));
		});
	};
	/**
	* Commit
	* @param  {Object}   opts     Commit options like 'Hostname' (optional)
	* @param  {Function} callback Callback
	*/
	Container.prototype.commit = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.commit);
		args.opts.container = this.id;
		var optsf = {
			path: "/commit?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				201: true,
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Stop
	* @param  {Object}   opts     Container stop options, like 't' (optional)
	* @param  {Function} callback Callback
	*/
	Container.prototype.stop = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.stop);
		var optsf = {
			path: "/containers/" + this.id + "/stop?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				304: "container already stopped",
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Restart
	* @param  {Object}   opts     Container restart options, like 't' (optional)
	* @param  {Function} callback Callback
	*/
	Container.prototype.restart = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.restart);
		var optsf = {
			path: "/containers/" + this.id + "/restart?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Kill
	* @param  {Object}   opts     Container kill options, like 'signal' (optional)
	* @param  {Function} callback Callback
	*/
	Container.prototype.kill = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.kill);
		var optsf = {
			path: "/containers/" + this.id + "/kill?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Container resize
	* @param  {[type]}   opts     Resize options. (optional)
	* @param  {Function} callback Callback
	*/
	Container.prototype.resize = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.resize);
		var optsf = {
			path: "/containers/" + this.id + "/resize?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				400: "bad parameter",
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Attach
	* @param  {Object}   opts     Attach options, like 'logs' (optional)
	* @param  {Function} callback Callback with stream.
	*/
	Container.prototype.attach = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.attach);
		var optsf = {
			path: "/containers/" + this.id + "/attach?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			isStream: true,
			hijack: args.opts.hijack,
			openStdin: args.opts.stdin,
			statusCodes: {
				200: true,
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, stream) {
				if (err) return reject(err);
				resolve(stream);
			});
		});
		else this.modem.dial(optsf, function(err, stream) {
			args.callback(err, stream);
		});
	};
	/**
	* Waits for a container to end.
	* @param  {[type]}   opts     Container wait options, like condition. (optional)
	* @param  {Function} callback Callback
	*/
	Container.prototype.wait = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.wait);
		var optsf = {
			path: "/containers/" + this.id + "/wait?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				400: "bad parameter",
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Removes a container
	* @param  {Object}   opts     Remove options, like 'force' (optional)
	* @param  {Function} callback Callback
	*/
	Container.prototype.remove = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.remove);
		var optsf = {
			path: "/containers/" + this.id + "?",
			method: "DELETE",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				400: "bad parameter",
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Copy (WARNING: DEPRECATED since RAPI v1.20)
	* @param  {Object}   opts     Copy options, like 'Resource' (optional)
	* @param  {Function} callback Callback with stream.
	*/
	Container.prototype.copy = function(opts, callback) {
		var self = this;
		console.log("container.copy is deprecated since Docker v1.8.x");
		var args = util.processArgs(opts, callback, this.defaultOptions.copy);
		var optsf = {
			path: "/containers/" + this.id + "/copy",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			isStream: true,
			statusCodes: {
				200: true,
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* getArchive
	* @param  {Object}   opts     Archive options, like 'path'
	* @param  {Function} callback Callback with stream.
	*/
	Container.prototype.getArchive = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.getArchive);
		var optsf = {
			path: "/containers/" + this.id + "/archive?",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			isStream: true,
			statusCodes: {
				200: true,
				400: "client error, bad parameters",
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* infoArchive
	* @param  {Object}   opts     Archive options, like 'path'
	* @param  {Function} callback Callback with stream.
	*/
	Container.prototype.infoArchive = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.infoArchive);
		var optsf = {
			path: "/containers/" + this.id + "/archive?",
			method: "HEAD",
			abortSignal: args.opts.abortSignal,
			isStream: true,
			statusCodes: {
				200: true,
				400: "client error, bad parameters",
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* putArchive
	* @param  {Object}   opts     Archive options, like 'path'
	* @param  {Function} callback Callback with stream.
	*/
	Container.prototype.putArchive = function(file, opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.putArchive);
		var optsf = {
			path: "/containers/" + this.id + "/archive?",
			method: "PUT",
			file,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				400: "client error, bad parameters",
				403: "client error, permission denied",
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Container logs
	* @param  {Object}   opts     Logs options. (optional)
	* @param  {Function} callback Callback with data
	*/
	Container.prototype.logs = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.log);
		var optsf = {
			path: "/containers/" + this.id + "/logs?",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			isStream: args.opts.follow || false,
			statusCodes: {
				200: true,
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Container stats
	* @param  {Object}   opts     Stats options. (optional)
	* @param  {Function} callback Callback with data
	*/
	Container.prototype.stats = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.stats);
		var isStream = true;
		if (args.opts.stream === false) isStream = false;
		var optsf = {
			path: "/containers/" + this.id + "/stats?",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			isStream,
			statusCodes: {
				200: true,
				404: "no such container",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	module.exports = Container;
}));
//#endregion
//#region ../../node_modules/.pnpm/dockerode@4.0.9/node_modules/dockerode/lib/image.js
var require_image = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var util = require_util();
	/**
	* Represents an image
	* @param {Object} modem docker-modem
	* @param {String} name  Image's name
	*/
	var Image = function(modem, name) {
		this.modem = modem;
		this.name = name;
	};
	Image.prototype[__require("util").inspect.custom] = function() {
		return this;
	};
	/**
	* Inspect
	* @param  {Object} opts       Inspect options, only 'manifests' (optional)
	* @param  {Function} callback Callback, if specified Docker will be queried.
	* @return {Object}            Name only if callback isn't specified.
	*/
	Image.prototype.inspect = function(opts, callback) {
		var args = util.processArgs(opts, callback);
		var self = this;
		var opts = {
			path: "/images/" + this.name + "/json",
			method: "GET",
			options: args.opts,
			statusCodes: {
				200: true,
				404: "no such image",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(opts, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(opts, function(err, data) {
			if (err) return args.callback(err, data);
			args.callback(err, data);
		});
	};
	/**
	* Distribution
	* @param {Object} opts
	* @param  {Function} callback Callback, if specified Docker will be queried.
	* @return {Object}            Name only if callback isn't specified.
	*/
	Image.prototype.distribution = function(opts, callback) {
		var args = util.processArgs(opts, callback);
		var self = this;
		var fopts = {
			path: "/distribution/" + this.name + "/json",
			method: "GET",
			statusCodes: {
				200: true,
				401: "no such image",
				500: "server error"
			},
			authconfig: args.opts ? args.opts.authconfig : void 0
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(fopts, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(fopts, function(err, data) {
			if (err) return args.callback(err, data);
			args.callback(err, data);
		});
	};
	/**
	* History
	* @param  {Function} callback Callback
	*/
	Image.prototype.history = function(callback) {
		var self = this;
		var opts = {
			path: "/images/" + this.name + "/history",
			method: "GET",
			statusCodes: {
				200: true,
				404: "no such image",
				500: "server error"
			}
		};
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(opts, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(opts, function(err, data) {
			if (err) return callback(err, data);
			callback(err, data);
		});
	};
	/**
	* Get
	* @param  {Function} callback Callback with data stream.
	*/
	Image.prototype.get = function(callback) {
		var self = this;
		var opts = {
			path: "/images/" + this.name + "/get",
			method: "GET",
			isStream: true,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(opts, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(opts, function(err, data) {
			if (err) return callback(err, data);
			callback(err, data);
		});
	};
	/**
	* Push
	* @param  {Object}   opts     Push options, like 'registry' (optional)
	* @param  {Function} callback Callback with stream.
	* @param  {Object}   auth     Registry authentication
	*/
	Image.prototype.push = function(opts, callback, auth) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var isStream = true;
		if (args.opts.stream === false) isStream = false;
		var optsf = {
			path: "/images/" + this.name + "/push?",
			method: "POST",
			options: args.opts,
			authconfig: args.opts.authconfig || auth,
			abortSignal: args.opts.abortSignal,
			isStream,
			statusCodes: {
				200: true,
				404: "no such image",
				500: "server error"
			}
		};
		delete optsf.options.authconfig;
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			callback(err, data);
		});
	};
	/**
	* Tag
	* @param  {Object}   opts     Tag options, like 'repo' (optional)
	* @param  {Function} callback Callback
	*/
	Image.prototype.tag = function(opts, callback) {
		var self = this;
		var optsf = {
			path: "/images/" + this.name + "/tag?",
			method: "POST",
			options: opts,
			abortSignal: opts && opts.abortSignal,
			statusCodes: {
				200: true,
				201: true,
				400: "bad parameter",
				404: "no such image",
				409: "conflict",
				500: "server error"
			}
		};
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			callback(err, data);
		});
	};
	/**
	* Removes the image
	* @param  {[Object]}   opts     Remove options (optional)
	* @param  {Function} callback Callback
	*/
	Image.prototype.remove = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/images/" + this.name + "?",
			method: "DELETE",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "no such image",
				409: "conflict",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	module.exports = Image;
}));
//#endregion
//#region ../../node_modules/.pnpm/dockerode@4.0.9/node_modules/dockerode/lib/volume.js
var require_volume = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var util = require_util();
	/**
	* Represents a volume
	* @param {Object} modem docker-modem
	* @param {String} name  Volume's name
	*/
	var Volume = function(modem, name) {
		this.modem = modem;
		this.name = name;
	};
	Volume.prototype[__require("util").inspect.custom] = function() {
		return this;
	};
	/**
	* Inspect
	* @param  {Object}   opts     Options (optional)
	* @param  {Function} callback Callback, if specified Docker will be queried.
	* @return {Object}            Name only if callback isn't specified.
	*/
	Volume.prototype.inspect = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/volumes/" + this.name,
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "no such volume",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Removes the volume
	* @param  {[Object]}   opts     Remove options (optional)
	* @param  {Function} callback Callback
	*/
	Volume.prototype.remove = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/volumes/" + this.name,
			method: "DELETE",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				204: true,
				404: "no such volume",
				409: "conflict",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	module.exports = Volume;
}));
//#endregion
//#region ../../node_modules/.pnpm/dockerode@4.0.9/node_modules/dockerode/lib/network.js
var require_network = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var util = require_util();
	/**
	* Represents an network
	* @param {Object} modem docker-modem
	* @param {String} id  Network's id
	*/
	var Network = function(modem, id) {
		this.modem = modem;
		this.id = id;
	};
	Network.prototype[__require("util").inspect.custom] = function() {
		return this;
	};
	/**
	* Inspect
	* @param  {Function} callback Callback, if specified Docker will be queried.
	* @return {Object}            Id only if callback isn't specified.
	*/
	Network.prototype.inspect = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var opts = {
			path: "/networks/" + this.id + "?",
			method: "GET",
			statusCodes: {
				200: true,
				404: "no such network",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(opts, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(opts, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Removes the network
	* @param  {[Object]}   opts     Remove options (optional)
	* @param  {Function} callback Callback
	*/
	Network.prototype.remove = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/networks/" + this.id,
			method: "DELETE",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				404: "no such network",
				409: "conflict",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Connects a container to a network
	* @param  {[Object]}   opts     Connect options (optional)
	* @param  {Function} callback Callback
	*/
	Network.prototype.connect = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/networks/" + this.id + "/connect",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				201: true,
				404: "network or container is not found",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Disconnects a container from a network
	* @param  {[Object]}   opts     Disconnect options (optional)
	* @param  {Function} callback Callback
	*/
	Network.prototype.disconnect = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/networks/" + this.id + "/disconnect",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				201: true,
				404: "network or container is not found",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	module.exports = Network;
}));
//#endregion
//#region ../../node_modules/.pnpm/dockerode@4.0.9/node_modules/dockerode/lib/service.js
var require_service = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var util = require_util();
	/**
	* Represents an Service
	* @param {Object} modem docker-modem
	* @param {String} id    Service's ID
	*/
	var Service = function(modem, id) {
		this.modem = modem;
		this.id = id;
	};
	Service.prototype[__require("util").inspect.custom] = function() {
		return this;
	};
	/**
	* Query Docker for service details.
	*
	* @param {Object}   opts     Options (optional)
	* @param {function} callback
	*/
	Service.prototype.inspect = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/services/" + this.id,
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "no such service",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Delete Service
	*
	* @param {Object}   opts     Options (optional)
	* @param {function} callback
	*/
	Service.prototype.remove = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/services/" + this.id,
			method: "DELETE",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				404: "no such service",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Update service
	*
	* @param {object} auth
	* @param {object} opts
	* @param {function} callback
	*/
	Service.prototype.update = function(auth, opts, callback) {
		var self = this;
		if (!callback) {
			var t = typeof opts;
			if (t === "function") {
				callback = opts;
				opts = auth;
				auth = opts.authconfig || void 0;
			} else if (t === "undefined") {
				opts = auth;
				auth = opts.authconfig || void 0;
			}
		}
		var optsf = {
			path: "/services/" + this.id + "/update?",
			method: "POST",
			abortSignal: opts && opts.abortSignal,
			statusCodes: {
				200: true,
				404: "no such service",
				500: "server error"
			},
			authconfig: auth,
			options: opts
		};
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			callback(err, data);
		});
	};
	/**
	* Service logs
	* @param  {Object}   opts     Logs options. (optional)
	* @param  {Function} callback Callback with data
	*/
	Service.prototype.logs = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, {});
		var optsf = {
			path: "/services/" + this.id + "/logs?",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			isStream: args.opts.follow || false,
			statusCodes: {
				200: true,
				404: "no such service",
				500: "server error",
				503: "node is not part of a swarm"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	module.exports = Service;
}));
//#endregion
//#region ../../node_modules/.pnpm/dockerode@4.0.9/node_modules/dockerode/lib/plugin.js
var require_plugin = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var util = require_util();
	/**
	* Represents a plugin
	* @param {Object} modem docker-modem
	* @param {String} name  Plugin's name
	*/
	var Plugin = function(modem, name, remote) {
		this.modem = modem;
		this.name = name;
		this.remote = remote || name;
	};
	Plugin.prototype[__require("util").inspect.custom] = function() {
		return this;
	};
	/**
	* Inspect
	*
	* @param  {Object}   opts     Options (optional)
	* @param  {Function} callback Callback, if specified Docker will be queried.
	* @return {Object}            Name only if callback isn't specified.
	*/
	Plugin.prototype.inspect = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/plugins/" + this.name + "/json",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "plugin is not installed",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Removes the plugin
	* @param  {[Object]}   opts     Remove options (optional)
	* @param  {Function} callback Callback
	*/
	Plugin.prototype.remove = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/plugins/" + this.name + "?",
			method: "DELETE",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "plugin is not installed",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			if (err) return args.callback(err, data);
			args.callback(err, data);
		});
	};
	/**
	* get privileges
	* @param  {Object}   opts     Options (optional)
	* @param  {Function} callback Callback
	* @return {Object}            Name only if callback isn't specified.
	*/
	Plugin.prototype.privileges = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/plugins/privileges?",
			method: "GET",
			options: { "remote": this.remote },
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Installs a new plugin
	* @param {Object}   opts     Create options
	* @param {Function} callback Callback
	*/
	Plugin.prototype.pull = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		if (args.opts._query && !args.opts._query.name) args.opts._query.name = this.name;
		if (args.opts._query && !args.opts._query.remote) args.opts._query.remote = this.remote;
		var optsf = {
			path: "/plugins/pull?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			isStream: true,
			options: args.opts,
			statusCodes: {
				200: true,
				204: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Enable
	* @param  {Object}   opts     Plugin enable options (optional)
	* @param  {Function} callback Callback
	*/
	Plugin.prototype.enable = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/plugins/" + this.name + "/enable?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Disable
	* @param  {Object}   opts     Plugin disable options (optional)
	* @param  {Function} callback Callback
	*/
	Plugin.prototype.disable = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/plugins/" + this.name + "/disable",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Push
	* @param  {Object}   opts     Plugin push options (optional)
	* @param  {Function} callback Callback
	*/
	Plugin.prototype.push = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/plugins/" + this.name + "/push",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "plugin not installed",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* COnfigure
	* @param  {Object}   opts     Plugin configure options (optional)
	* @param  {Function} callback Callback
	*/
	Plugin.prototype.configure = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/plugins/" + this.name + "/set",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				404: "plugin not installed",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Upgrade plugin
	*
	* @param {object} auth
	* @param {object} opts
	* @param {function} callback
	*/
	Plugin.prototype.upgrade = function(auth, opts, callback) {
		var self = this;
		if (!callback && typeof opts === "function") {
			callback = opts;
			opts = auth;
			auth = opts.authconfig || void 0;
		}
		var optsf = {
			path: "/plugins/" + this.name + "/upgrade?",
			method: "POST",
			abortSignal: opts && opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				404: "plugin not installed",
				500: "server error"
			},
			authconfig: auth,
			options: opts
		};
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			callback(err, data);
		});
	};
	module.exports = Plugin;
}));
//#endregion
//#region ../../node_modules/.pnpm/dockerode@4.0.9/node_modules/dockerode/lib/secret.js
var require_secret = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var util = require_util();
	/**
	* Represents a secret
	* @param {Object} modem docker-modem
	* @param {String} id  Secret's id
	*/
	var Secret = function(modem, id) {
		this.modem = modem;
		this.id = id;
	};
	Secret.prototype[__require("util").inspect.custom] = function() {
		return this;
	};
	/**
	* Inspect
	* @param  {Object}   opts     Options (optional)
	* @param  {Function} callback Callback, if specified Docker will be queried.
	* @return {Object}            Name only if callback isn't specified.
	*/
	Secret.prototype.inspect = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/secrets/" + this.id,
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "secret not found",
				406: "node is not part of a swarm",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Update a secret.
	*
	* @param {object} opts
	* @param {function} callback
	*/
	Secret.prototype.update = function(opts, callback) {
		var self = this;
		if (!callback && typeof opts === "function") callback = opts;
		var optsf = {
			path: "/secrets/" + this.id + "/update?",
			method: "POST",
			abortSignal: opts && opts.abortSignal,
			statusCodes: {
				200: true,
				404: "secret not found",
				500: "server error"
			},
			options: opts
		};
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			callback(err, data);
		});
	};
	/**
	* Removes the secret
	* @param  {[Object]}   opts     Remove options (optional)
	* @param  {Function} callback Callback
	*/
	Secret.prototype.remove = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/secrets/" + this.id,
			method: "DELETE",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				404: "secret not found",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	module.exports = Secret;
}));
//#endregion
//#region ../../node_modules/.pnpm/dockerode@4.0.9/node_modules/dockerode/lib/config.js
var require_config = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var util = require_util();
	/**
	* Represents a config
	* @param {Object} modem docker-modem
	* @param {String} id  Config's id
	*/
	var Config = function(modem, id) {
		this.modem = modem;
		this.id = id;
	};
	Config.prototype[__require("util").inspect.custom] = function() {
		return this;
	};
	/**
	* Inspect
	*
	* @param  {Object}   opts     Options (optional)
	* @param  {Function} callback Callback, if specified Docker will be queried.
	* @return {Object}            Name only if callback isn't specified.
	*/
	Config.prototype.inspect = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/configs/" + this.id,
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "config not found",
				500: "server error",
				503: "node is not part of a swarm"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Update a config.
	*
	* @param {object} opts
	* @param {function} callback
	*/
	Config.prototype.update = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/configs/" + this.id + "/update?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "config not found",
				500: "server error",
				503: "node is not part of a swarm"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Removes the config
	* @param  {[Object]}   opts     Remove options (optional)
	* @param  {Function} callback Callback
	*/
	Config.prototype.remove = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/configs/" + this.id,
			method: "DELETE",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				404: "config not found",
				500: "server error",
				503: "node is not part of a swarm"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	module.exports = Config;
}));
//#endregion
//#region ../../node_modules/.pnpm/dockerode@4.0.9/node_modules/dockerode/lib/task.js
var require_task = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var util = require_util();
	/**
	* Represents an Task
	* @param {Object} modem docker-modem
	* @param {String} id    Task's ID
	*/
	var Task = function(modem, id) {
		this.modem = modem;
		this.id = id;
		this.defaultOptions = { log: {} };
	};
	Task.prototype[__require("util").inspect.custom] = function() {
		return this;
	};
	/**
	* Query Docker for Task details.
	*
	* @param {Object}   opts     Options (optional)
	* @param {function} callback
	*/
	Task.prototype.inspect = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/tasks/" + this.id,
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "unknown task",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Task logs
	* @param  {Object}   opts     Logs options. (optional)
	* @param  {Function} callback Callback with data
	*/
	Task.prototype.logs = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback, this.defaultOptions.log);
		var optsf = {
			path: "/tasks/" + this.id + "/logs?",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			isStream: args.opts.follow || false,
			statusCodes: {
				101: true,
				200: true,
				404: "no such container",
				500: "server error",
				503: "node is not part of a swarm"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	module.exports = Task;
}));
//#endregion
//#region ../../node_modules/.pnpm/dockerode@4.0.9/node_modules/dockerode/lib/node.js
var require_node = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var util = require_util();
	/**
	* Represents an Node
	* @param {Object} modem docker-modem
	* @param {String} id    Node's ID
	*/
	var Node = function(modem, id) {
		this.modem = modem;
		this.id = id;
	};
	Node.prototype[__require("util").inspect.custom] = function() {
		return this;
	};
	/**
	* Query Docker for Node details.
	*
	* @param {Object}   opts     Options (optional)
	* @param {function} callback
	*/
	Node.prototype.inspect = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/nodes/" + this.id,
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "no such node",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Update a node.
	*
	* @param {object} opts
	* @param {function} callback
	*/
	Node.prototype.update = function(opts, callback) {
		var self = this;
		if (!callback && typeof opts === "function") callback = opts;
		var optsf = {
			path: "/nodes/" + this.id + "/update?",
			method: "POST",
			abortSignal: opts && opts.abortSignal,
			statusCodes: {
				200: true,
				404: "no such node",
				406: "node is not part of a swarm",
				500: "server error"
			},
			options: opts
		};
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			callback(err, data);
		});
	};
	/**
	* Remove a Node.
	* Warning: This method is not documented in the API.
	*
	* @param {object} opts
	* @param {function} callback
	*/
	Node.prototype.remove = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/nodes/" + this.id + "?",
			method: "DELETE",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				404: "no such node",
				500: "server error"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	module.exports = Node;
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/max.js
var require_max = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	exports.default = "ffffffff-ffff-ffff-ffff-ffffffffffff";
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/nil.js
var require_nil = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	exports.default = "00000000-0000-0000-0000-000000000000";
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/regex.js
var require_regex = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	exports.default = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/validate.js
var require_validate = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	var _regex = _interopRequireDefault(require_regex());
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	function validate(uuid) {
		return typeof uuid === "string" && _regex.default.test(uuid);
	}
	exports.default = validate;
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/parse.js
var require_parse = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	var _validate = _interopRequireDefault(require_validate());
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	function parse(uuid) {
		if (!(0, _validate.default)(uuid)) throw TypeError("Invalid UUID");
		let v;
		const arr = new Uint8Array(16);
		arr[0] = (v = parseInt(uuid.slice(0, 8), 16)) >>> 24;
		arr[1] = v >>> 16 & 255;
		arr[2] = v >>> 8 & 255;
		arr[3] = v & 255;
		arr[4] = (v = parseInt(uuid.slice(9, 13), 16)) >>> 8;
		arr[5] = v & 255;
		arr[6] = (v = parseInt(uuid.slice(14, 18), 16)) >>> 8;
		arr[7] = v & 255;
		arr[8] = (v = parseInt(uuid.slice(19, 23), 16)) >>> 8;
		arr[9] = v & 255;
		arr[10] = (v = parseInt(uuid.slice(24, 36), 16)) / 1099511627776 & 255;
		arr[11] = v / 4294967296 & 255;
		arr[12] = v >>> 24 & 255;
		arr[13] = v >>> 16 & 255;
		arr[14] = v >>> 8 & 255;
		arr[15] = v & 255;
		return arr;
	}
	exports.default = parse;
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/stringify.js
var require_stringify = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	exports.unsafeStringify = unsafeStringify;
	var _validate = _interopRequireDefault(require_validate());
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	/**
	* Convert array of 16 byte values to UUID string format of the form:
	* XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
	*/
	const byteToHex = [];
	for (let i = 0; i < 256; ++i) byteToHex.push((i + 256).toString(16).slice(1));
	function unsafeStringify(arr, offset = 0) {
		return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
	}
	function stringify(arr, offset = 0) {
		const uuid = unsafeStringify(arr, offset);
		if (!(0, _validate.default)(uuid)) throw TypeError("Stringified UUID is invalid");
		return uuid;
	}
	exports.default = stringify;
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/rng.js
var require_rng = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = rng;
	var _nodeCrypto$3 = _interopRequireDefault(__require("node:crypto"));
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	const rnds8Pool = new Uint8Array(256);
	let poolPtr = rnds8Pool.length;
	function rng() {
		if (poolPtr > rnds8Pool.length - 16) {
			_nodeCrypto$3.default.randomFillSync(rnds8Pool);
			poolPtr = 0;
		}
		return rnds8Pool.slice(poolPtr, poolPtr += 16);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/v1.js
var require_v1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	var _rng = _interopRequireDefault(require_rng());
	var _stringify = require_stringify();
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	let _nodeId;
	let _clockseq;
	let _lastMSecs = 0;
	let _lastNSecs = 0;
	function v1(options, buf, offset) {
		let i = buf && offset || 0;
		const b = buf || new Array(16);
		options = options || {};
		let node = options.node;
		let clockseq = options.clockseq;
		if (!options._v6) {
			if (!node) node = _nodeId;
			if (clockseq == null) clockseq = _clockseq;
		}
		if (node == null || clockseq == null) {
			const seedBytes = options.random || (options.rng || _rng.default)();
			if (node == null) {
				node = [
					seedBytes[0],
					seedBytes[1],
					seedBytes[2],
					seedBytes[3],
					seedBytes[4],
					seedBytes[5]
				];
				if (!_nodeId && !options._v6) {
					node[0] |= 1;
					_nodeId = node;
				}
			}
			if (clockseq == null) {
				clockseq = (seedBytes[6] << 8 | seedBytes[7]) & 16383;
				if (_clockseq === void 0 && !options._v6) _clockseq = clockseq;
			}
		}
		let msecs = options.msecs !== void 0 ? options.msecs : Date.now();
		let nsecs = options.nsecs !== void 0 ? options.nsecs : _lastNSecs + 1;
		const dt = msecs - _lastMSecs + (nsecs - _lastNSecs) / 1e4;
		if (dt < 0 && options.clockseq === void 0) clockseq = clockseq + 1 & 16383;
		if ((dt < 0 || msecs > _lastMSecs) && options.nsecs === void 0) nsecs = 0;
		if (nsecs >= 1e4) throw new Error("uuid.v1(): Can't create more than 10M uuids/sec");
		_lastMSecs = msecs;
		_lastNSecs = nsecs;
		_clockseq = clockseq;
		msecs += 0xb1d069b5400;
		const tl = ((msecs & 268435455) * 1e4 + nsecs) % 4294967296;
		b[i++] = tl >>> 24 & 255;
		b[i++] = tl >>> 16 & 255;
		b[i++] = tl >>> 8 & 255;
		b[i++] = tl & 255;
		const tmh = msecs / 4294967296 * 1e4 & 268435455;
		b[i++] = tmh >>> 8 & 255;
		b[i++] = tmh & 255;
		b[i++] = tmh >>> 24 & 15 | 16;
		b[i++] = tmh >>> 16 & 255;
		b[i++] = clockseq >>> 8 | 128;
		b[i++] = clockseq & 255;
		for (let n = 0; n < 6; ++n) b[i + n] = node[n];
		return buf || (0, _stringify.unsafeStringify)(b);
	}
	exports.default = v1;
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/v1ToV6.js
var require_v1ToV6 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = v1ToV6;
	var _parse = _interopRequireDefault(require_parse());
	var _stringify = require_stringify();
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	/**
	* Convert a v1 UUID to a v6 UUID
	*
	* @param {string|Uint8Array} uuid - The v1 UUID to convert to v6
	* @returns {string|Uint8Array} The v6 UUID as the same type as the `uuid` arg
	* (string or Uint8Array)
	*/
	function v1ToV6(uuid) {
		const v6Bytes = _v1ToV6(typeof uuid === "string" ? (0, _parse.default)(uuid) : uuid);
		return typeof uuid === "string" ? (0, _stringify.unsafeStringify)(v6Bytes) : v6Bytes;
	}
	function _v1ToV6(v1Bytes, randomize = false) {
		return Uint8Array.of((v1Bytes[6] & 15) << 4 | v1Bytes[7] >> 4 & 15, (v1Bytes[7] & 15) << 4 | (v1Bytes[4] & 240) >> 4, (v1Bytes[4] & 15) << 4 | (v1Bytes[5] & 240) >> 4, (v1Bytes[5] & 15) << 4 | (v1Bytes[0] & 240) >> 4, (v1Bytes[0] & 15) << 4 | (v1Bytes[1] & 240) >> 4, (v1Bytes[1] & 15) << 4 | (v1Bytes[2] & 240) >> 4, 96 | v1Bytes[2] & 15, v1Bytes[3], v1Bytes[8], v1Bytes[9], v1Bytes[10], v1Bytes[11], v1Bytes[12], v1Bytes[13], v1Bytes[14], v1Bytes[15]);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/v35.js
var require_v35 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.URL = exports.DNS = void 0;
	exports.default = v35;
	var _stringify = require_stringify();
	var _parse = _interopRequireDefault(require_parse());
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	function stringToBytes(str) {
		str = unescape(encodeURIComponent(str));
		const bytes = [];
		for (let i = 0; i < str.length; ++i) bytes.push(str.charCodeAt(i));
		return bytes;
	}
	const DNS = exports.DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
	const URL = exports.URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
	function v35(name, version, hashfunc) {
		function generateUUID(value, namespace, buf, offset) {
			var _namespace;
			if (typeof value === "string") value = stringToBytes(value);
			if (typeof namespace === "string") namespace = (0, _parse.default)(namespace);
			if (((_namespace = namespace) === null || _namespace === void 0 ? void 0 : _namespace.length) !== 16) throw TypeError("Namespace must be array-like (16 iterable integer values, 0-255)");
			let bytes = new Uint8Array(16 + value.length);
			bytes.set(namespace);
			bytes.set(value, namespace.length);
			bytes = hashfunc(bytes);
			bytes[6] = bytes[6] & 15 | version;
			bytes[8] = bytes[8] & 63 | 128;
			if (buf) {
				offset = offset || 0;
				for (let i = 0; i < 16; ++i) buf[offset + i] = bytes[i];
				return buf;
			}
			return (0, _stringify.unsafeStringify)(bytes);
		}
		try {
			generateUUID.name = name;
		} catch (err) {}
		generateUUID.DNS = DNS;
		generateUUID.URL = URL;
		return generateUUID;
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/md5.js
var require_md5 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	var _nodeCrypto$2 = _interopRequireDefault(__require("node:crypto"));
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	function md5(bytes) {
		if (Array.isArray(bytes)) bytes = Buffer.from(bytes);
		else if (typeof bytes === "string") bytes = Buffer.from(bytes, "utf8");
		return _nodeCrypto$2.default.createHash("md5").update(bytes).digest();
	}
	exports.default = md5;
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/v3.js
var require_v3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	var _v = _interopRequireDefault(require_v35());
	var _md = _interopRequireDefault(require_md5());
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	exports.default = (0, _v.default)("v3", 48, _md.default);
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/native.js
var require_native = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	var _nodeCrypto$1 = _interopRequireDefault(__require("node:crypto"));
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	exports.default = { randomUUID: _nodeCrypto$1.default.randomUUID };
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/v4.js
var require_v4 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	var _native = _interopRequireDefault(require_native());
	var _rng = _interopRequireDefault(require_rng());
	var _stringify = require_stringify();
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	function v4(options, buf, offset) {
		if (_native.default.randomUUID && !buf && !options) return _native.default.randomUUID();
		options = options || {};
		const rnds = options.random || (options.rng || _rng.default)();
		rnds[6] = rnds[6] & 15 | 64;
		rnds[8] = rnds[8] & 63 | 128;
		if (buf) {
			offset = offset || 0;
			for (let i = 0; i < 16; ++i) buf[offset + i] = rnds[i];
			return buf;
		}
		return (0, _stringify.unsafeStringify)(rnds);
	}
	exports.default = v4;
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/sha1.js
var require_sha1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	var _nodeCrypto = _interopRequireDefault(__require("node:crypto"));
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	function sha1(bytes) {
		if (Array.isArray(bytes)) bytes = Buffer.from(bytes);
		else if (typeof bytes === "string") bytes = Buffer.from(bytes, "utf8");
		return _nodeCrypto.default.createHash("sha1").update(bytes).digest();
	}
	exports.default = sha1;
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/v5.js
var require_v5 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	var _v = _interopRequireDefault(require_v35());
	var _sha = _interopRequireDefault(require_sha1());
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	exports.default = (0, _v.default)("v5", 80, _sha.default);
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/v6.js
var require_v6 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = v6;
	var _stringify = require_stringify();
	var _v = _interopRequireDefault(require_v1());
	var _v1ToV = _interopRequireDefault(require_v1ToV6());
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	/**
	*
	* @param {object} options
	* @param {Uint8Array=} buf
	* @param {number=} offset
	* @returns
	*/
	function v6(options = {}, buf, offset = 0) {
		let bytes = (0, _v.default)({
			...options,
			_v6: true
		}, new Uint8Array(16));
		bytes = (0, _v1ToV.default)(bytes);
		if (buf) {
			for (let i = 0; i < 16; i++) buf[offset + i] = bytes[i];
			return buf;
		}
		return (0, _stringify.unsafeStringify)(bytes);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/v6ToV1.js
var require_v6ToV1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = v6ToV1;
	var _parse = _interopRequireDefault(require_parse());
	var _stringify = require_stringify();
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	/**
	* Convert a v6 UUID to a v1 UUID
	*
	* @param {string|Uint8Array} uuid - The v6 UUID to convert to v6
	* @returns {string|Uint8Array} The v1 UUID as the same type as the `uuid` arg
	* (string or Uint8Array)
	*/
	function v6ToV1(uuid) {
		const v1Bytes = _v6ToV1(typeof uuid === "string" ? (0, _parse.default)(uuid) : uuid);
		return typeof uuid === "string" ? (0, _stringify.unsafeStringify)(v1Bytes) : v1Bytes;
	}
	function _v6ToV1(v6Bytes) {
		return Uint8Array.of((v6Bytes[3] & 15) << 4 | v6Bytes[4] >> 4 & 15, (v6Bytes[4] & 15) << 4 | (v6Bytes[5] & 240) >> 4, (v6Bytes[5] & 15) << 4 | v6Bytes[6] & 15, v6Bytes[7], (v6Bytes[1] & 15) << 4 | (v6Bytes[2] & 240) >> 4, (v6Bytes[2] & 15) << 4 | (v6Bytes[3] & 240) >> 4, 16 | (v6Bytes[0] & 240) >> 4, (v6Bytes[0] & 15) << 4 | (v6Bytes[1] & 240) >> 4, v6Bytes[8], v6Bytes[9], v6Bytes[10], v6Bytes[11], v6Bytes[12], v6Bytes[13], v6Bytes[14], v6Bytes[15]);
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/v7.js
var require_v7 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	var _rng = _interopRequireDefault(require_rng());
	var _stringify = require_stringify();
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	/**
	* UUID V7 - Unix Epoch time-based UUID
	*
	* The IETF has published RFC9562, introducing 3 new UUID versions (6,7,8). This
	* implementation of V7 is based on the accepted, though not yet approved,
	* revisions.
	*
	* RFC 9562:https://www.rfc-editor.org/rfc/rfc9562.html Universally Unique
	* IDentifiers (UUIDs)
	
	*
	* Sample V7 value:
	* https://www.rfc-editor.org/rfc/rfc9562.html#name-example-of-a-uuidv7-value
	*
	* Monotonic Bit Layout: RFC rfc9562.6.2 Method 1, Dedicated Counter Bits ref:
	*     https://www.rfc-editor.org/rfc/rfc9562.html#section-6.2-5.1
	*
	*   0                   1                   2                   3 0 1 2 3 4 5 6
	*   7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
	*  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
	*  |                          unix_ts_ms                           |
	*  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
	*  |          unix_ts_ms           |  ver  |        seq_hi         |
	*  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
	*  |var|               seq_low               |        rand         |
	*  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
	*  |                             rand                              |
	*  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
	*
	* seq is a 31 bit serialized counter; comprised of 12 bit seq_hi and 19 bit
	* seq_low, and randomly initialized upon timestamp change. 31 bit counter size
	* was selected as any bitwise operations in node are done as _signed_ 32 bit
	* ints. we exclude the sign bit.
	*/
	let _seqLow = null;
	let _seqHigh = null;
	let _msecs = 0;
	function v7(options, buf, offset) {
		options = options || {};
		let i = buf && offset || 0;
		const b = buf || new Uint8Array(16);
		const rnds = options.random || (options.rng || _rng.default)();
		const msecs = options.msecs !== void 0 ? options.msecs : Date.now();
		let seq = options.seq !== void 0 ? options.seq : null;
		let seqHigh = _seqHigh;
		let seqLow = _seqLow;
		if (msecs > _msecs && options.msecs === void 0) {
			_msecs = msecs;
			if (seq !== null) {
				seqHigh = null;
				seqLow = null;
			}
		}
		if (seq !== null) {
			if (seq > 2147483647) seq = 2147483647;
			seqHigh = seq >>> 19 & 4095;
			seqLow = seq & 524287;
		}
		if (seqHigh === null || seqLow === null) {
			seqHigh = rnds[6] & 127;
			seqHigh = seqHigh << 8 | rnds[7];
			seqLow = rnds[8] & 63;
			seqLow = seqLow << 8 | rnds[9];
			seqLow = seqLow << 5 | rnds[10] >>> 3;
		}
		if (msecs + 1e4 > _msecs && seq === null) {
			if (++seqLow > 524287) {
				seqLow = 0;
				if (++seqHigh > 4095) {
					seqHigh = 0;
					_msecs++;
				}
			}
		} else _msecs = msecs;
		_seqHigh = seqHigh;
		_seqLow = seqLow;
		b[i++] = _msecs / 1099511627776 & 255;
		b[i++] = _msecs / 4294967296 & 255;
		b[i++] = _msecs / 16777216 & 255;
		b[i++] = _msecs / 65536 & 255;
		b[i++] = _msecs / 256 & 255;
		b[i++] = _msecs & 255;
		b[i++] = seqHigh >>> 4 & 15 | 112;
		b[i++] = seqHigh & 255;
		b[i++] = seqLow >>> 13 & 63 | 128;
		b[i++] = seqLow >>> 5 & 255;
		b[i++] = seqLow << 3 & 255 | rnds[10] & 7;
		b[i++] = rnds[11];
		b[i++] = rnds[12];
		b[i++] = rnds[13];
		b[i++] = rnds[14];
		b[i++] = rnds[15];
		return buf || (0, _stringify.unsafeStringify)(b);
	}
	exports.default = v7;
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/version.js
var require_version = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	var _validate = _interopRequireDefault(require_validate());
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	function version(uuid) {
		if (!(0, _validate.default)(uuid)) throw TypeError("Invalid UUID");
		return parseInt(uuid.slice(14, 15), 16);
	}
	exports.default = version;
}));
//#endregion
//#region ../../node_modules/.pnpm/uuid@10.0.0/node_modules/uuid/dist/index.js
var require_dist = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	Object.defineProperty(exports, "MAX", {
		enumerable: true,
		get: function() {
			return _max.default;
		}
	});
	Object.defineProperty(exports, "NIL", {
		enumerable: true,
		get: function() {
			return _nil.default;
		}
	});
	Object.defineProperty(exports, "parse", {
		enumerable: true,
		get: function() {
			return _parse.default;
		}
	});
	Object.defineProperty(exports, "stringify", {
		enumerable: true,
		get: function() {
			return _stringify.default;
		}
	});
	Object.defineProperty(exports, "v1", {
		enumerable: true,
		get: function() {
			return _v.default;
		}
	});
	Object.defineProperty(exports, "v1ToV6", {
		enumerable: true,
		get: function() {
			return _v1ToV.default;
		}
	});
	Object.defineProperty(exports, "v3", {
		enumerable: true,
		get: function() {
			return _v2.default;
		}
	});
	Object.defineProperty(exports, "v4", {
		enumerable: true,
		get: function() {
			return _v3.default;
		}
	});
	Object.defineProperty(exports, "v5", {
		enumerable: true,
		get: function() {
			return _v4.default;
		}
	});
	Object.defineProperty(exports, "v6", {
		enumerable: true,
		get: function() {
			return _v5.default;
		}
	});
	Object.defineProperty(exports, "v6ToV1", {
		enumerable: true,
		get: function() {
			return _v6ToV.default;
		}
	});
	Object.defineProperty(exports, "v7", {
		enumerable: true,
		get: function() {
			return _v6.default;
		}
	});
	Object.defineProperty(exports, "validate", {
		enumerable: true,
		get: function() {
			return _validate.default;
		}
	});
	Object.defineProperty(exports, "version", {
		enumerable: true,
		get: function() {
			return _version.default;
		}
	});
	var _max = _interopRequireDefault(require_max());
	var _nil = _interopRequireDefault(require_nil());
	var _parse = _interopRequireDefault(require_parse());
	var _stringify = _interopRequireDefault(require_stringify());
	var _v = _interopRequireDefault(require_v1());
	var _v1ToV = _interopRequireDefault(require_v1ToV6());
	var _v2 = _interopRequireDefault(require_v3());
	var _v3 = _interopRequireDefault(require_v4());
	var _v4 = _interopRequireDefault(require_v5());
	var _v5 = _interopRequireDefault(require_v6());
	var _v6ToV = _interopRequireDefault(require_v6ToV1());
	var _v6 = _interopRequireDefault(require_v7());
	var _validate = _interopRequireDefault(require_validate());
	var _version = _interopRequireDefault(require_version());
	function _interopRequireDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
}));
//#endregion
//#region ../../node_modules/.pnpm/dockerode@4.0.9/node_modules/dockerode/lib/session.js
var require_session = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var grpc = require_src(), protoLoader = require_src$1(), path = __require("path"), uuid = require_dist().v4;
	function withSession(docker, auth, handler) {
		const sessionId = uuid();
		const opts = {
			method: "POST",
			path: "/session",
			hijack: true,
			headers: {
				Upgrade: "h2c",
				"X-Docker-Expose-Session-Uuid": sessionId,
				"X-Docker-Expose-Session-Name": "testcontainers"
			},
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		docker.modem.dial(opts, function(err, socket) {
			if (err) return handler(err, null, () => void 0);
			const server = new grpc.Server();
			const creds = grpc.ServerCredentials.createInsecure();
			server.createConnectionInjector(creds).injectConnection(socket);
			const pkg = protoLoader.loadSync(path.resolve(__dirname, "proto", "auth.proto"));
			const service = grpc.loadPackageDefinition(pkg);
			server.addService(service.moby.filesync.v1.Auth.service, { Credentials({ request }, callback) {
				if (auth) callback(null, {
					Username: auth.username,
					Secret: auth.password
				});
				else callback(null, {});
			} });
			function done() {
				server.forceShutdown();
				socket.end();
			}
			handler(null, sessionId, done);
		});
	}
	module.exports = withSession;
}));
//#endregion
//#region ../../node_modules/.pnpm/dockerode@4.0.9/node_modules/dockerode/lib/docker.js
var require_docker = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var EventEmitter = __require("events").EventEmitter, Modem = require_modem(), Container = require_container(), Image = require_image(), Volume = require_volume(), Network = require_network(), Service = require_service(), Plugin = require_plugin(), Secret = require_secret(), Config = require_config(), Task = require_task(), Node = require_node(), Exec = require_exec(), util = require_util(), withSession = require_session(), extend = util.extend;
	var Docker = function(opts) {
		if (!(this instanceof Docker)) return new Docker(opts);
		var plibrary = global.Promise;
		if (opts && opts.Promise) {
			plibrary = opts.Promise;
			if (Object.keys(opts).length === 1) opts = void 0;
		}
		if (opts && opts.modem) this.modem = opts.modem;
		else this.modem = new Modem(opts);
		this.modem.Promise = plibrary;
	};
	/**
	* Creates a new container
	* @param {Object}   opts     Create options
	* @param {Function} callback Callback
	*/
	Docker.prototype.createContainer = function(opts, callback) {
		var self = this;
		var optsf = {
			path: "/containers/create?",
			method: "POST",
			options: opts,
			authconfig: opts.authconfig,
			abortSignal: opts.abortSignal,
			statusCodes: {
				200: true,
				201: true,
				400: "bad parameter",
				404: "no such container",
				406: "impossible to attach",
				500: "server error"
			}
		};
		delete opts.authconfig;
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(self.getContainer(data.Id));
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			if (err) return callback(err, data);
			callback(err, self.getContainer(data.Id));
		});
	};
	/**
	* Creates a new image
	* @param {Object}   auth     Authentication (optional)
	* @param {Object}   opts     Create options
	* @param {Function} callback Callback
	*/
	Docker.prototype.createImage = function(auth, opts, callback) {
		var self = this;
		if (!callback && typeof opts === "function") {
			callback = opts;
			opts = auth;
			auth = opts.authconfig || void 0;
		} else if (!callback && !opts) {
			opts = auth;
			auth = opts.authconfig;
		}
		var optsf = {
			path: "/images/create?",
			method: "POST",
			options: opts,
			authconfig: auth,
			abortSignal: opts.abortSignal,
			isStream: true,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			callback(err, data);
		});
	};
	/**
	* Load image
	* @param {String}   file     File
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.loadImage = function(file, opts, callback) {
		var self = this;
		if (!callback && typeof opts === "function") {
			callback = opts;
			opts = null;
		}
		var optsf = {
			path: "/images/load?",
			method: "POST",
			options: opts,
			file,
			abortSignal: opts && opts.abortSignal,
			isStream: true,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			callback(err, data);
		});
	};
	/**
	* Import image from a tar archive
	* @param {String}   file     File
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.importImage = function(file, opts, callback) {
		var self = this;
		if (!callback && typeof opts === "function") {
			callback = opts;
			opts = void 0;
		}
		if (!opts) opts = {};
		opts.fromSrc = "-";
		var optsf = {
			path: "/images/create?",
			method: "POST",
			options: opts,
			file,
			abortSignal: opts.abortSignal,
			isStream: true,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			callback(err, data);
		});
	};
	/**
	* Verifies auth
	* @param {Object}   opts     Options
	* @param {Function} callback Callback
	*/
	Docker.prototype.checkAuth = function(opts, callback) {
		var self = this;
		var optsf = {
			path: "/auth",
			method: "POST",
			options: opts,
			abortSignal: opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				500: "server error"
			}
		};
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			callback(err, data);
		});
	};
	/**
	* Builds an image
	* @param {String}   file     File
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.buildImage = function(file, opts, callback) {
		var self = this;
		if (!callback && typeof opts === "function") {
			callback = opts;
			opts = null;
		}
		var optsf = {
			path: "/build?",
			method: "POST",
			file: void 0,
			options: opts,
			abortSignal: opts && opts.abortSignal,
			isStream: true,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (opts) {
			if (opts.registryconfig) {
				optsf.registryconfig = optsf.options.registryconfig;
				delete optsf.options.registryconfig;
			}
			if (opts.authconfig) {
				optsf.authconfig = optsf.options.authconfig;
				delete optsf.options.authconfig;
			}
			if (opts.cachefrom && Array.isArray(opts.cachefrom)) optsf.options.cachefrom = JSON.stringify(opts.cachefrom);
		}
		function dial(callback) {
			util.prepareBuildContext(file, (ctx) => {
				optsf.file = ctx;
				self.modem.dial(optsf, callback);
			});
		}
		function dialWithSession(callback) {
			if (opts?.version === "2") withSession(self, optsf.authconfig, (err, sessionId, done) => {
				if (err) return callback(err);
				optsf.options.session = sessionId;
				dial((err, data) => {
					callback(err, data);
					if (data) data.on("end", done);
				});
			});
			else dial(callback);
		}
		if (callback === void 0) return new self.modem.Promise(function(resolve, reject) {
			dialWithSession(function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else dialWithSession(callback);
	};
	/**
	* Fetches a Container by ID
	* @param {String} id Container's ID
	*/
	Docker.prototype.getContainer = function(id) {
		return new Container(this.modem, id);
	};
	/**
	* Fetches an Image by name
	* @param {String} name Image's name
	*/
	Docker.prototype.getImage = function(name) {
		return new Image(this.modem, name);
	};
	/**
	* Fetches a Volume by name
	* @param {String} name Volume's name
	*/
	Docker.prototype.getVolume = function(name) {
		return new Volume(this.modem, name);
	};
	/**
	* Fetches a Plugin by name
	* @param {String} name Volume's name
	*/
	Docker.prototype.getPlugin = function(name, remote) {
		return new Plugin(this.modem, name, remote);
	};
	/**
	* Fetches a Service by id
	* @param {String} id Services's id
	*/
	Docker.prototype.getService = function(id) {
		return new Service(this.modem, id);
	};
	/**
	* Fetches a Task by id
	* @param {String} id Task's id
	*/
	Docker.prototype.getTask = function(id) {
		return new Task(this.modem, id);
	};
	/**
	* Fetches Node by id
	* @param {String} id Node's id
	*/
	Docker.prototype.getNode = function(id) {
		return new Node(this.modem, id);
	};
	/**
	* Fetches a Network by id
	* @param {String} id network's id
	*/
	Docker.prototype.getNetwork = function(id) {
		return new Network(this.modem, id);
	};
	/**
	* Fetches a Secret by id
	* @param {String} id network's id
	*/
	Docker.prototype.getSecret = function(id) {
		return new Secret(this.modem, id);
	};
	/**
	* Fetches a Config by id
	* @param {String} id network's id
	*/
	Docker.prototype.getConfig = function(id) {
		return new Config(this.modem, id);
	};
	/**
	* Fetches an Exec instance by ID
	* @param {String} id Exec instance's ID
	*/
	Docker.prototype.getExec = function(id) {
		return new Exec(this.modem, id);
	};
	/**
	* Lists containers
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.listContainers = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/containers/json?",
			method: "GET",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				400: "bad parameter",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Lists images
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.listImages = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/images/json?",
			method: "GET",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				400: "bad parameter",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Get images
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.getImages = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/images/get?",
			method: "GET",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			isStream: true,
			statusCodes: {
				200: true,
				400: "bad parameter",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Lists Services
	* @param {Object} opts
	* @param {Function} callback Callback
	*/
	Docker.prototype.listServices = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/services?",
			method: "GET",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Lists Nodes
	* @param {Object} opts
	* @param {Function} callback Callback
	*/
	Docker.prototype.listNodes = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/nodes?",
			method: "GET",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				400: "bad parameter",
				404: "no such node",
				500: "server error",
				503: "node is not part of a swarm"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Lists Tasks
	* @param {Object} opts
	* @param {Function} callback Callback
	*/
	Docker.prototype.listTasks = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/tasks?",
			method: "GET",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Creates a new secret
	* @param {Object}   opts     Create options
	* @param {Function} callback Callback
	*/
	Docker.prototype.createSecret = function(opts, callback) {
		var args = util.processArgs(opts, callback);
		var self = this;
		var optsf = {
			path: "/secrets/create?",
			method: "POST",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				201: true,
				406: "server error or node is not part of a swarm",
				409: "name conflicts with an existing object",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(self.getSecret(data.ID));
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			if (err) return args.callback(err, data);
			args.callback(err, self.getSecret(data.ID));
		});
	};
	/**
	* Creates a new config
	* @param {Object}   opts     Config options
	* @param {Function} callback Callback
	*/
	Docker.prototype.createConfig = function(opts, callback) {
		var args = util.processArgs(opts, callback);
		var self = this;
		var optsf = {
			path: "/configs/create?",
			method: "POST",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				201: true,
				406: "server error or node is not part of a swarm",
				409: "name conflicts with an existing object",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(self.getConfig(data.ID));
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			if (err) return args.callback(err, data);
			args.callback(err, self.getConfig(data.ID));
		});
	};
	/**
	* Lists secrets
	* @param {Object} opts
	* @param {Function} callback Callback
	*/
	Docker.prototype.listSecrets = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/secrets?",
			method: "GET",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Lists configs
	* @param {Object} opts
	* @param {Function} callback Callback
	*/
	Docker.prototype.listConfigs = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/configs?",
			method: "GET",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Creates a new plugin
	* @param {Object}   opts     Create options
	* @param {Function} callback Callback
	*/
	Docker.prototype.createPlugin = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/plugins/create?",
			method: "POST",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				204: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(self.getPlugin(args.opts.name));
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			if (err) return args.callback(err, data);
			args.callback(err, self.getPlugin(args.opts.name));
		});
	};
	/**
	* Lists plugins
	* @param {Object} opts
	* @param {Function} callback Callback
	*/
	Docker.prototype.listPlugins = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/plugins?",
			method: "GET",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Prune images
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.pruneImages = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/images/prune?",
			method: "POST",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Prune builder
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.pruneBuilder = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/build/prune",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Prune containers
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.pruneContainers = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/containers/prune?",
			method: "POST",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Prune volumes
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.pruneVolumes = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/volumes/prune?",
			method: "POST",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Prune networks
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.pruneNetworks = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/networks/prune?",
			method: "POST",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Creates a new volume
	* @param {Object}   opts     Create options
	* @param {Function} callback Callback
	*/
	Docker.prototype.createVolume = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/volumes/create?",
			method: "POST",
			allowEmpty: true,
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				201: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(self.getVolume(data.Name));
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			if (err) return args.callback(err, data);
			args.callback(err, self.getVolume(data.Name));
		});
	};
	/**
	* Creates a new service
	* @param {Object}   auth
	* @param {Object}   opts     Create options
	* @param {Function} callback Callback
	*/
	Docker.prototype.createService = function(auth, opts, callback) {
		if (!callback && typeof opts === "function") {
			callback = opts;
			opts = auth;
			auth = opts.authconfig || void 0;
		} else if (!opts && !callback) opts = auth;
		var self = this;
		var optsf = {
			path: "/services/create",
			method: "POST",
			options: opts,
			authconfig: auth,
			abortSignal: opts && opts.abortSignal,
			statusCodes: {
				200: true,
				201: true,
				500: "server error"
			}
		};
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(self.getService(data.ID || data.Id));
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			if (err) return callback(err, data);
			callback(err, self.getService(data.ID || data.Id));
		});
	};
	/**
	* Lists volumes
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.listVolumes = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/volumes?",
			method: "GET",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				400: "bad parameter",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Creates a new network
	* @param {Object}   opts     Create options
	* @param {Function} callback Callback
	*/
	Docker.prototype.createNetwork = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/networks/create?",
			method: "POST",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				201: true,
				404: "driver not found",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(self.getNetwork(data.Id));
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			if (err) return args.callback(err, data);
			args.callback(err, self.getNetwork(data.Id));
		});
	};
	/**
	* Lists networks
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.listNetworks = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/networks?",
			method: "GET",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				400: "bad parameter",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Search images
	* @param {Object}   opts     Options
	* @param {Function} callback Callback
	*/
	Docker.prototype.searchImages = function(opts, callback) {
		var self = this;
		var optsf = {
			path: "/images/search?",
			method: "GET",
			options: opts,
			authconfig: opts.authconfig,
			abortSignal: opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			callback(err, data);
		});
	};
	/**
	* Info
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback with info
	*/
	Docker.prototype.info = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var opts = {
			path: "/info",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(opts, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(opts, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Version
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.version = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var opts = {
			path: "/version",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(opts, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(opts, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Ping
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.ping = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/_ping",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* SystemDf 	equivalent to system/df API Engine
	*		get usage data information
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.df = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/system/df",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Events
	* @param {Object}   opts     Events options, like 'since' (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.getEvents = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/events?",
			method: "GET",
			options: args.opts,
			abortSignal: args.opts.abortSignal,
			isStream: true,
			statusCodes: {
				200: true,
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Pull is a wrapper around createImage, parsing image's tags.
	* @param  {String}   repoTag  Repository tag
	* @param  {Object}   opts     Options (optional)
	* @param  {Function} callback Callback
	* @param  {Object}   auth     Authentication (optional)
	* @return {Object}            Image
	*/
	Docker.prototype.pull = function(repoTag, opts, callback, auth) {
		var args = util.processArgs(opts, callback);
		var imageSrc = util.parseRepositoryTag(repoTag);
		args.opts.fromImage = imageSrc.repository;
		args.opts.tag = imageSrc.tag || "latest";
		var argsf = [args.opts, args.callback];
		if (auth) argsf = [
			auth,
			args.opts,
			args.callback
		];
		return this.createImage.apply(this, argsf);
	};
	/**
	* PullAll is a wrapper around createImage, to pull all image tags of an image.
	* @param  {String}   repoTag  Repository tag
	* @param  {Object}   opts     Options (optional)
	* @param  {Function} callback Callback
	* @param  {Object}   auth     Authentication (optional)
	* @return {Object}            Image
	*/
	Docker.prototype.pullAll = function(repoTag, opts, callback, auth) {
		var args = util.processArgs(opts, callback);
		var imageSrc = util.parseRepositoryTag(repoTag);
		args.opts.fromImage = imageSrc.repository;
		var argsf = [args.opts, args.callback];
		if (auth) argsf = [
			auth,
			args.opts,
			args.callback
		];
		return this.createImage.apply(this, argsf);
	};
	/**
	* Like run command from Docker's CLI
	* @param  {String}   image         Image name to be used.
	* @param  {Array}   cmd           Command to run in array format.
	* @param  {Object}   streamo       Output stream
	* @param  {Object}   createOptions Container create options (optional)
	* @param  {Object}   startOptions  Container start options (optional)
	* @param  {Function} callback      Callback
	* @return {Object}                 EventEmitter
	*/
	Docker.prototype.run = function(image, cmd, streamo, createOptions, startOptions, callback) {
		if (typeof arguments[arguments.length - 1] === "function") return this.runCallback(image, cmd, streamo, createOptions, startOptions, callback);
		else return this.runPromise(image, cmd, streamo, createOptions, startOptions);
	};
	Docker.prototype.runCallback = function(image, cmd, streamo, createOptions, startOptions, callback) {
		if (!callback && typeof createOptions === "function") {
			callback = createOptions;
			createOptions = {};
			startOptions = {};
		} else if (!callback && typeof startOptions === "function") {
			callback = startOptions;
			startOptions = {};
		}
		var hub = new EventEmitter();
		function handler(err, container) {
			if (err) return callback(err, null, container);
			hub.emit("container", container);
			container.attach({
				stream: true,
				stdout: true,
				stderr: true
			}, function handler(err, stream) {
				if (err) return callback(err, null, container);
				hub.emit("stream", stream);
				if (streamo) if (streamo instanceof Array) {
					stream.on("end", function() {
						try {
							streamo[0].end();
						} catch (e) {}
						try {
							streamo[1].end();
						} catch (e) {}
					});
					container.modem.demuxStream(stream, streamo[0], streamo[1]);
				} else {
					stream.setEncoding("utf8");
					stream.pipe(streamo, { end: true });
				}
				container.start(startOptions, function(err, data) {
					if (err) return callback(err, data, container);
					hub.emit("start", container);
					container.wait(function(err, data) {
						hub.emit("data", data);
						callback(err, data, container);
					});
				});
			});
		}
		var optsc = {
			"Hostname": "",
			"User": "",
			"AttachStdin": false,
			"AttachStdout": true,
			"AttachStderr": true,
			"Tty": true,
			"OpenStdin": false,
			"StdinOnce": false,
			"Env": null,
			"Cmd": cmd,
			"Image": image,
			"Volumes": {},
			"VolumesFrom": []
		};
		extend(optsc, createOptions);
		this.createContainer(optsc, handler);
		return hub;
	};
	Docker.prototype.runPromise = function(image, cmd, streamo, createOptions, startOptions) {
		var self = this;
		createOptions = createOptions || {};
		startOptions = startOptions || {};
		var optsc = {
			"Hostname": "",
			"User": "",
			"AttachStdin": false,
			"AttachStdout": true,
			"AttachStderr": true,
			"Tty": true,
			"OpenStdin": false,
			"StdinOnce": false,
			"Env": null,
			"Cmd": cmd,
			"Image": image,
			"Volumes": {},
			"VolumesFrom": []
		};
		extend(optsc, createOptions);
		var containero;
		return new this.modem.Promise(function(resolve, reject) {
			self.createContainer(optsc).then(function(container) {
				containero = container;
				return container.attach({
					stream: true,
					stdout: true,
					stderr: true
				});
			}).then(function(stream) {
				if (streamo) if (streamo instanceof Array) {
					stream.on("end", function() {
						try {
							streamo[0].end();
						} catch (e) {}
						try {
							streamo[1].end();
						} catch (e) {}
					});
					containero.modem.demuxStream(stream, streamo[0], streamo[1]);
				} else {
					stream.setEncoding("utf8");
					stream.pipe(streamo, { end: true });
				}
				return containero.start(startOptions);
			}).then(function(data) {
				return containero.wait();
			}).then(function(data) {
				resolve([data, containero]);
			}).catch(function(err) {
				reject(err);
			});
		});
	};
	/**
	* Init swarm.
	*
	* @param {object} opts
	* @param {function} callback
	*/
	Docker.prototype.swarmInit = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/swarm/init",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				400: "bad parameter",
				406: "node is already part of a Swarm"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Join swarm.
	*
	* @param {object} opts
	* @param {function} callback
	*/
	Docker.prototype.swarmJoin = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/swarm/join",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				400: "bad parameter",
				406: "node is already part of a Swarm"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Leave swarm.
	*
	* @param {object} opts
	* @param {function} callback
	*/
	Docker.prototype.swarmLeave = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/swarm/leave?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				406: "node is not part of a Swarm"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Update swarm.
	*
	* @param {object} opts
	* @param {function} callback
	*/
	Docker.prototype.swarmUpdate = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/swarm/update?",
			method: "POST",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				400: "bad parameter",
				406: "node is already part of a Swarm"
			},
			options: args.opts
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	/**
	* Inspect a Swarm.
	* Warning: This method is not documented in the API
	*
	* @param {Object}   opts     Options (optional)
	* @param {Function} callback Callback
	*/
	Docker.prototype.swarmInspect = function(opts, callback) {
		var self = this;
		var args = util.processArgs(opts, callback);
		var optsf = {
			path: "/swarm",
			method: "GET",
			abortSignal: args.opts.abortSignal,
			statusCodes: {
				200: true,
				406: "This node is not a swarm manager",
				500: "server error"
			}
		};
		if (args.callback === void 0) return new this.modem.Promise(function(resolve, reject) {
			self.modem.dial(optsf, function(err, data) {
				if (err) return reject(err);
				resolve(data);
			});
		});
		else this.modem.dial(optsf, function(err, data) {
			args.callback(err, data);
		});
	};
	Docker.Container = Container;
	Docker.Image = Image;
	Docker.Volume = Volume;
	Docker.Network = Network;
	Docker.Service = Service;
	Docker.Plugin = Plugin;
	Docker.Secret = Secret;
	Docker.Task = Task;
	Docker.Node = Node;
	Docker.Exec = Exec;
	module.exports = Docker;
}));
//#endregion
export { require_docker as t };
