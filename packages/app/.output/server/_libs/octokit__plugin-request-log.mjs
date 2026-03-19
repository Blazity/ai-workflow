//#region ../../node_modules/.pnpm/@octokit+plugin-request-log@6.0.0_@octokit+core@7.0.6/node_modules/@octokit/plugin-request-log/dist-src/index.js
function requestLog(octokit) {
	octokit.hook.wrap("request", (request, options) => {
		octokit.log.debug("request", options);
		const start = Date.now();
		const requestOptions = octokit.request.endpoint.parse(options);
		const path = requestOptions.url.replace(options.baseUrl, "");
		return request(options).then((response) => {
			const requestId = response.headers["x-github-request-id"];
			octokit.log.info(`${requestOptions.method} ${path} - ${response.status} with id ${requestId} in ${Date.now() - start}ms`);
			return response;
		}).catch((error) => {
			const requestId = error.response?.headers["x-github-request-id"] || "UNKNOWN";
			octokit.log.error(`${requestOptions.method} ${path} - ${error.status} with id ${requestId} in ${Date.now() - start}ms`);
			throw error;
		});
	});
}
requestLog.VERSION = "6.0.0";
//#endregion
export { requestLog as t };
