import { t as Octokit$1 } from "./@octokit/core+[...].mjs";
import { t as requestLog } from "./octokit__plugin-request-log.mjs";
import { t as paginateRest } from "./octokit__plugin-paginate-rest.mjs";
import { t as legacyRestEndpointMethods } from "./@octokit/plugin-rest-endpoint-methods+[...].mjs";
//#region ../../node_modules/.pnpm/@octokit+rest@22.0.1/node_modules/@octokit/rest/dist-src/index.js
const Octokit = Octokit$1.plugin(requestLog, legacyRestEndpointMethods, paginateRest).defaults({ userAgent: `octokit-rest.js/22.0.1` });
//#endregion
export { Octokit as t };
