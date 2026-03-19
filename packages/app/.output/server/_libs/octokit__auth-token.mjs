//#region ../../node_modules/.pnpm/@octokit+auth-token@6.0.0/node_modules/@octokit/auth-token/dist-bundle/index.js
var b64url = "(?:[a-zA-Z0-9_-]+)";
var sep = "\\.";
var jwtRE = new RegExp(`^${b64url}${sep}${b64url}${sep}${b64url}$`);
var isJWT = jwtRE.test.bind(jwtRE);
async function auth(token) {
	const isApp = isJWT(token);
	const isInstallation = token.startsWith("v1.") || token.startsWith("ghs_");
	const isUserToServer = token.startsWith("ghu_");
	return {
		type: "token",
		token,
		tokenType: isApp ? "app" : isInstallation ? "installation" : isUserToServer ? "user-to-server" : "oauth"
	};
}
function withAuthorizationPrefix(token) {
	if (token.split(/\./).length === 3) return `bearer ${token}`;
	return `token ${token}`;
}
async function hook(token, request, route, parameters) {
	const endpoint = request.endpoint.merge(route, parameters);
	endpoint.headers.authorization = withAuthorizationPrefix(token);
	return request(endpoint);
}
var createTokenAuth = function createTokenAuth2(token) {
	if (!token) throw new Error("[@octokit/auth-token] No token passed to createTokenAuth");
	if (typeof token !== "string") throw new Error("[@octokit/auth-token] Token passed to createTokenAuth is not a string");
	token = token.replace(/^(token|bearer) +/i, "");
	return Object.assign(auth.bind(null, token), { hook: hook.bind(null, token) });
};
//#endregion
export { createTokenAuth as t };
