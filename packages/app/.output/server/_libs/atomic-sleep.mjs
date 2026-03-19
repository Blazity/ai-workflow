import { t as __commonJSMin } from "../_runtime.mjs";
//#region ../../node_modules/.pnpm/atomic-sleep@1.0.0/node_modules/atomic-sleep/index.js
var require_atomic_sleep = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	if (typeof SharedArrayBuffer !== "undefined" && typeof Atomics !== "undefined") {
		const nil = new Int32Array(new SharedArrayBuffer(4));
		function sleep(ms) {
			if ((ms > 0 && ms < Infinity) === false) {
				if (typeof ms !== "number" && typeof ms !== "bigint") throw TypeError("sleep: ms must be a number");
				throw RangeError("sleep: ms must be a number that is greater than 0 but less than Infinity");
			}
			Atomics.wait(nil, 0, 0, Number(ms));
		}
		module.exports = sleep;
	} else {
		function sleep(ms) {
			if ((ms > 0 && ms < Infinity) === false) {
				if (typeof ms !== "number" && typeof ms !== "bigint") throw TypeError("sleep: ms must be a number");
				throw RangeError("sleep: ms must be a number that is greater than 0 but less than Infinity");
			}
			const target = Date.now() + Number(ms);
			while (target > Date.now());
		}
		module.exports = sleep;
	}
}));
//#endregion
export { require_atomic_sleep as t };
