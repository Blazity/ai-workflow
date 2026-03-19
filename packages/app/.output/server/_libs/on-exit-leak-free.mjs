import { t as __commonJSMin } from "../_runtime.mjs";
//#region ../../node_modules/.pnpm/on-exit-leak-free@2.1.2/node_modules/on-exit-leak-free/index.js
var require_on_exit_leak_free = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const refs = {
		exit: [],
		beforeExit: []
	};
	const functions = {
		exit: onExit,
		beforeExit: onBeforeExit
	};
	let registry;
	function ensureRegistry() {
		if (registry === void 0) registry = new FinalizationRegistry(clear);
	}
	function install(event) {
		if (refs[event].length > 0) return;
		process.on(event, functions[event]);
	}
	function uninstall(event) {
		if (refs[event].length > 0) return;
		process.removeListener(event, functions[event]);
		if (refs.exit.length === 0 && refs.beforeExit.length === 0) registry = void 0;
	}
	function onExit() {
		callRefs("exit");
	}
	function onBeforeExit() {
		callRefs("beforeExit");
	}
	function callRefs(event) {
		for (const ref of refs[event]) {
			const obj = ref.deref();
			const fn = ref.fn;
			/* istanbul ignore else */
			if (obj !== void 0) fn(obj, event);
		}
		refs[event] = [];
	}
	function clear(ref) {
		for (const event of ["exit", "beforeExit"]) {
			const index = refs[event].indexOf(ref);
			refs[event].splice(index, index + 1);
			uninstall(event);
		}
	}
	function _register(event, obj, fn) {
		if (obj === void 0) throw new Error("the object can't be undefined");
		install(event);
		const ref = new WeakRef(obj);
		ref.fn = fn;
		ensureRegistry();
		registry.register(obj, ref);
		refs[event].push(ref);
	}
	function register(obj, fn) {
		_register("exit", obj, fn);
	}
	function registerBeforeExit(obj, fn) {
		_register("beforeExit", obj, fn);
	}
	function unregister(obj) {
		if (registry === void 0) return;
		registry.unregister(obj);
		for (const event of ["exit", "beforeExit"]) {
			refs[event] = refs[event].filter((ref) => {
				const _obj = ref.deref();
				return _obj && _obj !== obj;
			});
			uninstall(event);
		}
	}
	module.exports = {
		register,
		registerBeforeExit,
		unregister
	};
}));
//#endregion
export { require_on_exit_leak_free as t };
