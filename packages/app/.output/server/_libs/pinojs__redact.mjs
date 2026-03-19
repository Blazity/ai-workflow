import { t as __commonJSMin } from "../_runtime.mjs";
//#region ../../node_modules/.pnpm/@pinojs+redact@0.4.0/node_modules/@pinojs/redact/index.js
var require_redact = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	function deepClone(obj) {
		if (obj === null || typeof obj !== "object") return obj;
		if (obj instanceof Date) return new Date(obj.getTime());
		if (obj instanceof Array) {
			const cloned = [];
			for (let i = 0; i < obj.length; i++) cloned[i] = deepClone(obj[i]);
			return cloned;
		}
		if (typeof obj === "object") {
			const cloned = Object.create(Object.getPrototypeOf(obj));
			for (const key in obj) if (Object.prototype.hasOwnProperty.call(obj, key)) cloned[key] = deepClone(obj[key]);
			return cloned;
		}
		return obj;
	}
	function parsePath(path) {
		const parts = [];
		let current = "";
		let inBrackets = false;
		let inQuotes = false;
		let quoteChar = "";
		for (let i = 0; i < path.length; i++) {
			const char = path[i];
			if (!inBrackets && char === ".") {
				if (current) {
					parts.push(current);
					current = "";
				}
			} else if (char === "[") {
				if (current) {
					parts.push(current);
					current = "";
				}
				inBrackets = true;
			} else if (char === "]" && inBrackets) {
				parts.push(current);
				current = "";
				inBrackets = false;
				inQuotes = false;
			} else if ((char === "\"" || char === "'") && inBrackets) if (!inQuotes) {
				inQuotes = true;
				quoteChar = char;
			} else if (char === quoteChar) {
				inQuotes = false;
				quoteChar = "";
			} else current += char;
			else current += char;
		}
		if (current) parts.push(current);
		return parts;
	}
	function setValue(obj, parts, value) {
		let current = obj;
		for (let i = 0; i < parts.length - 1; i++) {
			const key = parts[i];
			if (typeof current !== "object" || current === null || !(key in current)) return false;
			if (typeof current[key] !== "object" || current[key] === null) return false;
			current = current[key];
		}
		const lastKey = parts[parts.length - 1];
		if (lastKey === "*") {
			if (Array.isArray(current)) for (let i = 0; i < current.length; i++) current[i] = value;
			else if (typeof current === "object" && current !== null) {
				for (const key in current) if (Object.prototype.hasOwnProperty.call(current, key)) current[key] = value;
			}
		} else if (typeof current === "object" && current !== null && lastKey in current && Object.prototype.hasOwnProperty.call(current, lastKey)) current[lastKey] = value;
		return true;
	}
	function removeKey(obj, parts) {
		let current = obj;
		for (let i = 0; i < parts.length - 1; i++) {
			const key = parts[i];
			if (typeof current !== "object" || current === null || !(key in current)) return false;
			if (typeof current[key] !== "object" || current[key] === null) return false;
			current = current[key];
		}
		const lastKey = parts[parts.length - 1];
		if (lastKey === "*") {
			if (Array.isArray(current)) for (let i = 0; i < current.length; i++) current[i] = void 0;
			else if (typeof current === "object" && current !== null) {
				for (const key in current) if (Object.prototype.hasOwnProperty.call(current, key)) delete current[key];
			}
		} else if (typeof current === "object" && current !== null && lastKey in current && Object.prototype.hasOwnProperty.call(current, lastKey)) delete current[lastKey];
		return true;
	}
	const PATH_NOT_FOUND = Symbol("PATH_NOT_FOUND");
	function getValueIfExists(obj, parts) {
		let current = obj;
		for (const part of parts) {
			if (current === null || current === void 0) return PATH_NOT_FOUND;
			if (typeof current !== "object" || current === null) return PATH_NOT_FOUND;
			if (!(part in current)) return PATH_NOT_FOUND;
			current = current[part];
		}
		return current;
	}
	function getValue(obj, parts) {
		let current = obj;
		for (const part of parts) {
			if (current === null || current === void 0) return;
			if (typeof current !== "object" || current === null) return;
			current = current[part];
		}
		return current;
	}
	function redactPaths(obj, paths, censor, remove = false) {
		for (const path of paths) {
			const parts = parsePath(path);
			if (parts.includes("*")) redactWildcardPath(obj, parts, censor, path, remove);
			else if (remove) removeKey(obj, parts);
			else {
				const value = getValueIfExists(obj, parts);
				if (value === PATH_NOT_FOUND) continue;
				setValue(obj, parts, typeof censor === "function" ? censor(value, parts) : censor);
			}
		}
	}
	function redactWildcardPath(obj, parts, censor, originalPath, remove = false) {
		const wildcardIndex = parts.indexOf("*");
		if (wildcardIndex === parts.length - 1) {
			const parentParts = parts.slice(0, -1);
			let current = obj;
			for (const part of parentParts) {
				if (current === null || current === void 0) return;
				if (typeof current !== "object" || current === null) return;
				current = current[part];
			}
			if (Array.isArray(current)) if (remove) for (let i = 0; i < current.length; i++) current[i] = void 0;
			else for (let i = 0; i < current.length; i++) {
				const indexPath = [...parentParts, i.toString()];
				const actualCensor = typeof censor === "function" ? censor(current[i], indexPath) : censor;
				current[i] = actualCensor;
			}
			else if (typeof current === "object" && current !== null) if (remove) {
				const keysToDelete = [];
				for (const key in current) if (Object.prototype.hasOwnProperty.call(current, key)) keysToDelete.push(key);
				for (const key of keysToDelete) delete current[key];
			} else for (const key in current) {
				const keyPath = [...parentParts, key];
				const actualCensor = typeof censor === "function" ? censor(current[key], keyPath) : censor;
				current[key] = actualCensor;
			}
		} else redactIntermediateWildcard(obj, parts, censor, wildcardIndex, originalPath, remove);
	}
	function redactIntermediateWildcard(obj, parts, censor, wildcardIndex, originalPath, remove = false) {
		const beforeWildcard = parts.slice(0, wildcardIndex);
		const afterWildcard = parts.slice(wildcardIndex + 1);
		const pathArray = [];
		function traverse(current, pathLength) {
			if (pathLength === beforeWildcard.length) {
				if (Array.isArray(current)) for (let i = 0; i < current.length; i++) {
					pathArray[pathLength] = i.toString();
					traverse(current[i], pathLength + 1);
				}
				else if (typeof current === "object" && current !== null) for (const key in current) {
					pathArray[pathLength] = key;
					traverse(current[key], pathLength + 1);
				}
			} else if (pathLength < beforeWildcard.length) {
				const nextKey = beforeWildcard[pathLength];
				if (current && typeof current === "object" && current !== null && nextKey in current) {
					pathArray[pathLength] = nextKey;
					traverse(current[nextKey], pathLength + 1);
				}
			} else if (afterWildcard.includes("*")) redactWildcardPath(current, afterWildcard, typeof censor === "function" ? (value, path) => {
				return censor(value, [...pathArray.slice(0, pathLength), ...path]);
			} : censor, originalPath, remove);
			else if (remove) removeKey(current, afterWildcard);
			else setValue(current, afterWildcard, typeof censor === "function" ? censor(getValue(current, afterWildcard), [...pathArray.slice(0, pathLength), ...afterWildcard]) : censor);
		}
		if (beforeWildcard.length === 0) traverse(obj, 0);
		else {
			let current = obj;
			for (let i = 0; i < beforeWildcard.length; i++) {
				const part = beforeWildcard[i];
				if (current === null || current === void 0) return;
				if (typeof current !== "object" || current === null) return;
				current = current[part];
				pathArray[i] = part;
			}
			if (current !== null && current !== void 0) traverse(current, beforeWildcard.length);
		}
	}
	function buildPathStructure(pathsToClone) {
		if (pathsToClone.length === 0) return null;
		const pathStructure = /* @__PURE__ */ new Map();
		for (const path of pathsToClone) {
			const parts = parsePath(path);
			let current = pathStructure;
			for (let i = 0; i < parts.length; i++) {
				const part = parts[i];
				if (!current.has(part)) current.set(part, /* @__PURE__ */ new Map());
				current = current.get(part);
			}
		}
		return pathStructure;
	}
	function selectiveClone(obj, pathStructure) {
		if (!pathStructure) return obj;
		function cloneSelectively(source, pathMap, depth = 0) {
			if (!pathMap || pathMap.size === 0) return source;
			if (source === null || typeof source !== "object") return source;
			if (source instanceof Date) return new Date(source.getTime());
			if (Array.isArray(source)) {
				const cloned = [];
				for (let i = 0; i < source.length; i++) {
					const indexStr = i.toString();
					if (pathMap.has(indexStr) || pathMap.has("*")) cloned[i] = cloneSelectively(source[i], pathMap.get(indexStr) || pathMap.get("*"));
					else cloned[i] = source[i];
				}
				return cloned;
			}
			const cloned = Object.create(Object.getPrototypeOf(source));
			for (const key in source) if (Object.prototype.hasOwnProperty.call(source, key)) if (pathMap.has(key) || pathMap.has("*")) cloned[key] = cloneSelectively(source[key], pathMap.get(key) || pathMap.get("*"));
			else cloned[key] = source[key];
			return cloned;
		}
		return cloneSelectively(obj, pathStructure);
	}
	function validatePath(path) {
		if (typeof path !== "string") throw new Error("Paths must be (non-empty) strings");
		if (path === "") throw new Error("Invalid redaction path ()");
		if (path.includes("..")) throw new Error(`Invalid redaction path (${path})`);
		if (path.includes(",")) throw new Error(`Invalid redaction path (${path})`);
		let bracketCount = 0;
		let inQuotes = false;
		let quoteChar = "";
		for (let i = 0; i < path.length; i++) {
			const char = path[i];
			if ((char === "\"" || char === "'") && bracketCount > 0) {
				if (!inQuotes) {
					inQuotes = true;
					quoteChar = char;
				} else if (char === quoteChar) {
					inQuotes = false;
					quoteChar = "";
				}
			} else if (char === "[" && !inQuotes) bracketCount++;
			else if (char === "]" && !inQuotes) {
				bracketCount--;
				if (bracketCount < 0) throw new Error(`Invalid redaction path (${path})`);
			}
		}
		if (bracketCount !== 0) throw new Error(`Invalid redaction path (${path})`);
	}
	function validatePaths(paths) {
		if (!Array.isArray(paths)) throw new TypeError("paths must be an array");
		for (const path of paths) validatePath(path);
	}
	function slowRedact(options = {}) {
		const { paths = [], censor = "[REDACTED]", serialize = JSON.stringify, strict = true, remove = false } = options;
		validatePaths(paths);
		const pathStructure = buildPathStructure(paths);
		return function redact(obj) {
			if (strict && (obj === null || typeof obj !== "object")) {
				if (obj === null || obj === void 0) return serialize ? serialize(obj) : obj;
				if (typeof obj !== "object") return serialize ? serialize(obj) : obj;
			}
			const cloned = selectiveClone(obj, pathStructure);
			const original = obj;
			let actualCensor = censor;
			if (typeof censor === "function") actualCensor = censor;
			redactPaths(cloned, paths, actualCensor, remove);
			if (serialize === false) {
				cloned.restore = function() {
					return deepClone(original);
				};
				return cloned;
			}
			if (typeof serialize === "function") return serialize(cloned);
			return JSON.stringify(cloned);
		};
	}
	module.exports = slowRedact;
}));
//#endregion
export { require_redact as t };
