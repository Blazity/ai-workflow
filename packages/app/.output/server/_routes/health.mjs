import { i as defineEventHandler } from "../_libs/h3+rou3+srvx.mjs";
//#region src/routes/health.get.ts
var health_get_default = defineEventHandler(() => {
	return { status: "ok" };
});
//#endregion
export { health_get_default as default };
