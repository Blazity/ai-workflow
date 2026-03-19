import { r as __require, t as __commonJSMin } from "../_runtime.mjs";
//#region ../../node_modules/.pnpm/@balena+dockerignore@1.0.2/node_modules/@balena/dockerignore/ignore.js
var require_ignore = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* @license
	* Copyright 2020 Balena Ltd.
	*
	* Licensed under the Apache License, Version 2.0 (the "License");
	* you may not use this file except in compliance with the License.
	* You may obtain a copy of the License at
	*
	*    http://www.apache.org/licenses/LICENSE-2.0
	*
	* Unless required by applicable law or agreed to in writing, software
	* distributed under the License is distributed on an "AS IS" BASIS,
	* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	* See the License for the specific language governing permissions and
	* limitations under the License.
	*
	* ------------------------------------------------------------------------
	*
	* Copyright 2018 Zeit, Inc.
	* Licensed under the MIT License. See file LICENSE.md for a full copy.
	*
	* ------------------------------------------------------------------------
	*/
	/**
	* This module implements the [dockerignore
	* spec](https://docs.docker.com/engine/reference/builder/#dockerignore-file),
	* closely following Docker's (Moby) Golang implementation:
	* https://github.com/moby/moby/blob/v19.03.8/builder/dockerignore/dockerignore.go
	* https://github.com/moby/moby/blob/v19.03.8/pkg/fileutils/fileutils.go
	* https://github.com/moby/moby/blob/v19.03.8/pkg/archive/archive.go#L825
	*
	* Something the spec is not clear about, but we discovered by reading source code
	* and testing against the "docker build" command, is the handling of backslashes and
	* forward slashes as path separators and escape characters in the .dockerignore file
	* across platforms including Windows, Linux and macOS:
	*
	* * On Linux and macOS, only forward slashes can be used as path separators in the
	*   .dockerignore file, and the backslash works as an escape character.
	* * On Windows, both forward slashes and backslashes are allowed as path separators
	*   in the .dockerignore file, and the backslash is not used as an escape character.
	*
	* This is consistent with how Windows works generally: both forward slashes and
	* backslashes are accepted as path separators by the cmd.exe Command Prompt or
	* PowerShell, and by library functions like the Golang filepath.Clean or the
	* Node.js path.normalize.
	*
	* Similarly, path strings provided to the IgnoreBase.ignores() and IgnoreBase.filter()
	* methods can use either forward slashes or backslashes as path separators on Windows,
	* but only forward slashes are accepted as path separators on Linux and macOS.
	*/
	const path = __require("path");
	const factory = (options) => new IgnoreBase(options);
	factory.default = factory;
	module.exports = factory;
	function make_array(subject) {
		return Array.isArray(subject) ? subject : [subject];
	}
	const REGEX_TRAILING_PATH_SEP = path.sep === "\\" ? /(?<=.)\\$/ : /(?<=.)\/$/;
	const KEY_IGNORE = typeof Symbol !== "undefined" ? Symbol.for("dockerignore") : "dockerignore";
	function cleanPath(file) {
		return path.normalize(file).replace(REGEX_TRAILING_PATH_SEP, "");
	}
	function toSlash(file) {
		if (path.sep === "/") return file;
		return file.replace(/\\/g, "/");
	}
	function fromSlash(file) {
		if (path.sep === "/") return file;
		return file.replace(/\//g, path.sep);
	}
	var IgnoreBase = class {
		constructor({ ignorecase = true } = {}) {
			this._rules = [];
			this._ignorecase = ignorecase;
			this[KEY_IGNORE] = true;
			this._initCache();
		}
		_initCache() {
			this._cache = {};
		}
		add(pattern) {
			this._added = false;
			if (typeof pattern === "string") pattern = pattern.split(/\r?\n/g);
			make_array(pattern).forEach(this._addPattern, this);
			if (this._added) this._initCache();
			return this;
		}
		addPattern(pattern) {
			return this.add(pattern);
		}
		_addPattern(pattern) {
			if (pattern && pattern[KEY_IGNORE]) {
				this._rules = this._rules.concat(pattern._rules);
				this._added = true;
				return;
			}
			if (this._checkPattern(pattern)) {
				const rule = this._createRule(pattern.trim());
				if (rule !== null) {
					this._added = true;
					this._rules.push(rule);
				}
			}
		}
		_checkPattern(pattern) {
			return pattern && typeof pattern === "string" && pattern.indexOf("#") !== 0 && pattern.trim() !== "";
		}
		filter(paths) {
			return make_array(paths).filter((path) => this._filter(path));
		}
		createFilter() {
			return (path) => this._filter(path);
		}
		ignores(path) {
			return !this._filter(path);
		}
		_createRule(pattern) {
			const origin = pattern;
			let negative = false;
			if (pattern[0] === "!") {
				negative = true;
				pattern = pattern.substring(1).trim();
			}
			if (pattern.length > 0) {
				pattern = cleanPath(pattern);
				pattern = toSlash(pattern);
				if (pattern.length > 1 && pattern[0] === "/") pattern = pattern.slice(1);
			}
			if (negative) pattern = "!" + pattern;
			pattern = pattern.trim();
			if (pattern === "") return null;
			pattern = cleanPath(pattern);
			if (pattern[0] === "!") {
				if (pattern.length === 1) return null;
				negative = true;
				pattern = pattern.substring(1);
			} else negative = false;
			return {
				origin,
				pattern,
				dirs: pattern.split(path.sep),
				negative
			};
		}
		_filter(path) {
			if (!path) return false;
			if (path in this._cache) return this._cache[path];
			return this._cache[path] = this._test(path);
		}
		_test(file) {
			file = fromSlash(file);
			const parentPath = cleanPath(path.dirname(file));
			const parentPathDirs = parentPath.split(path.sep);
			let matched = false;
			this._rules.forEach((rule) => {
				let match = this._match(file, rule);
				if (!match && parentPath !== ".") {
					if (rule.dirs.includes("**")) for (let i = rule.dirs.filter((x) => x !== "**").length; i <= parentPathDirs.length; i++) match = match || this._match(parentPathDirs.slice(0, i).join(path.sep), rule);
					else if (rule.dirs.length <= parentPathDirs.length) match = this._match(parentPathDirs.slice(0, rule.dirs.length).join(path.sep), rule);
				}
				if (match) matched = !rule.negative;
			});
			return !matched;
		}
		_match(file, rule) {
			return this._compile(rule).regexp.test(file);
		}
		_compile(rule) {
			if (rule.regexp) return rule;
			let regStr = "^";
			let escapedSlash = path.sep === "\\" ? "\\\\" : path.sep;
			for (let i = 0; i < rule.pattern.length; i++) {
				const ch = rule.pattern[i];
				if (ch === "*") if (rule.pattern[i + 1] === "*") {
					i++;
					if (rule.pattern[i + 1] === path.sep) i++;
					if (rule.pattern[i + 1] === void 0) regStr += ".*";
					else regStr += `(.*${escapedSlash})?`;
				} else regStr += `[^${escapedSlash}]*`;
				else if (ch === "?") regStr += `[^${escapedSlash}]`;
				else if (ch === "." || ch === "$") regStr += `\\${ch}`;
				else if (ch === "\\") {
					if (path.sep === "\\") {
						regStr += escapedSlash;
						continue;
					}
					if (rule.pattern[i + 1] !== void 0) {
						regStr += "\\" + rule.pattern[i + 1];
						i++;
					} else regStr += "\\";
				} else regStr += ch;
			}
			regStr += "$";
			rule.regexp = new RegExp(regStr, this._ignorecase ? "i" : "");
			return rule;
		}
	};
}));
//#endregion
export { require_ignore as t };
