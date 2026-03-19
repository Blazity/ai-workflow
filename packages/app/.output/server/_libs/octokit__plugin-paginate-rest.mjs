//#region ../../node_modules/.pnpm/@octokit+plugin-paginate-rest@14.0.0_@octokit+core@7.0.6/node_modules/@octokit/plugin-paginate-rest/dist-bundle/index.js
var VERSION = "0.0.0-development";
function normalizePaginatedListResponse(response) {
	if (!response.data) return {
		...response,
		data: []
	};
	if (!(("total_count" in response.data || "total_commits" in response.data) && !("url" in response.data))) return response;
	const incompleteResults = response.data.incomplete_results;
	const repositorySelection = response.data.repository_selection;
	const totalCount = response.data.total_count;
	const totalCommits = response.data.total_commits;
	delete response.data.incomplete_results;
	delete response.data.repository_selection;
	delete response.data.total_count;
	delete response.data.total_commits;
	const namespaceKey = Object.keys(response.data)[0];
	response.data = response.data[namespaceKey];
	if (typeof incompleteResults !== "undefined") response.data.incomplete_results = incompleteResults;
	if (typeof repositorySelection !== "undefined") response.data.repository_selection = repositorySelection;
	response.data.total_count = totalCount;
	response.data.total_commits = totalCommits;
	return response;
}
function iterator(octokit, route, parameters) {
	const options = typeof route === "function" ? route.endpoint(parameters) : octokit.request.endpoint(route, parameters);
	const requestMethod = typeof route === "function" ? route : octokit.request;
	const method = options.method;
	const headers = options.headers;
	let url = options.url;
	return { [Symbol.asyncIterator]: () => ({ async next() {
		if (!url) return { done: true };
		try {
			const normalizedResponse = normalizePaginatedListResponse(await requestMethod({
				method,
				url,
				headers
			}));
			url = ((normalizedResponse.headers.link || "").match(/<([^<>]+)>;\s*rel="next"/) || [])[1];
			if (!url && "total_commits" in normalizedResponse.data) {
				const parsedUrl = new URL(normalizedResponse.url);
				const params = parsedUrl.searchParams;
				const page = parseInt(params.get("page") || "1", 10);
				if (page * parseInt(params.get("per_page") || "250", 10) < normalizedResponse.data.total_commits) {
					params.set("page", String(page + 1));
					url = parsedUrl.toString();
				}
			}
			return { value: normalizedResponse };
		} catch (error) {
			if (error.status !== 409) throw error;
			url = "";
			return { value: {
				status: 200,
				headers: {},
				data: []
			} };
		}
	} }) };
}
function paginate(octokit, route, parameters, mapFn) {
	if (typeof parameters === "function") {
		mapFn = parameters;
		parameters = void 0;
	}
	return gather(octokit, [], iterator(octokit, route, parameters)[Symbol.asyncIterator](), mapFn);
}
function gather(octokit, results, iterator2, mapFn) {
	return iterator2.next().then((result) => {
		if (result.done) return results;
		let earlyExit = false;
		function done() {
			earlyExit = true;
		}
		results = results.concat(mapFn ? mapFn(result.value, done) : result.value.data);
		if (earlyExit) return results;
		return gather(octokit, results, iterator2, mapFn);
	});
}
Object.assign(paginate, { iterator });
function paginateRest(octokit) {
	return { paginate: Object.assign(paginate.bind(null, octokit), { iterator: iterator.bind(null, octokit) }) };
}
paginateRest.VERSION = VERSION;
//#endregion
export { paginateRest as t };
