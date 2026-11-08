'use strict';

/**
 * Extract machine-readable GraphQL error codes.
 *
 * @param {object} response HTTP response
 */
function errorCodes(response) {
	return (Array.isArray(response.data?.errors) ? response.data.errors : []).map(
		error => error.extensions?.errorCode || error.extensions?.code,
	);
}

/**
 * Detect HTTP and GraphQL quota responses.
 *
 * @param {object} response HTTP response
 */
function isRateLimited(response) {
	return response.status === 429 || errorCodes(response).includes('KT-CT-1199');
}

/**
 * Detect explicit authentication failures, not arbitrary server errors.
 *
 * @param {object} response HTTP response
 */
function isAuthenticationError(response) {
	return (
		response.status === 401 ||
		errorCodes(response).some(code => ['KT-CT-1124', 'KT-CT-1111', 'UNAUTHENTICATED'].includes(code))
	);
}

/**
 * Parse Retry-After without shortening a server-specified delay.
 *
 * @param {string|number|undefined} value Header value
 * @param {number} [now] Current UTC timestamp
 */
function retryAfterMs(value, now = Date.now()) {
	if (value === undefined || value === null) {
		return null;
	}
	const seconds = Number(value);
	if (String(value).trim() !== '' && Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1000);
	}
	const date = Date.parse(String(value));
	return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * Decode expiry solely for refresh scheduling, not token verification.
 *
 * @param {string} token JWT or opaque token
 * @param {number} [now] Current UTC timestamp
 */
function tokenExpiry(token, now = Date.now()) {
	try {
		const expiry = Number(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp);
		if (Number.isFinite(expiry) && expiry > 0) {
			return expiry * 1000;
		}
	} catch {
		/* Older opaque tokens cannot expose an expiry. */
	}
	return now + 15 * 60 * 1000;
}

/**
 * Cancellable delay for retries and page pacing.
 *
 * @param {number} ms Delay
 * @param {AbortSignal} signal Instance lifecycle signal
 */
function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error('Adapter stopping'));
			return;
		}
		const abort = () => {
			clearTimeout(timer);
			reject(new Error('Adapter stopping'));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', abort);
			resolve(undefined);
		}, ms);
		signal.addEventListener('abort', abort, { once: true });
	});
}

module.exports = { errorCodes, isRateLimited, isAuthenticationError, retryAfterMs, tokenExpiry, delay };
