'use strict';

/**
 * Inspect distinct quarter hours without judging the plausibility of consumption.
 *
 * @param {Array<{ts:number,val:number,end?:number}>} intervals Input measurements
 * @param {Date} start Inclusive UTC start
 * @param {Date} end Exclusive UTC end
 * @param {boolean} [endStamped] Inexogy stamps the interval end
 */
function intervalQuality(intervals, start, end, endStamped = false) {
	const quarter = 900000;
	const expected = (end.getTime() - start.getTime()) / quarter;
	const seen = new Map();
	let invalid = 0,
		duplicates = 0,
		conflicts = 0;
	for (const interval of intervals) {
		const ts = interval.ts - (endStamped ? quarter : 0);
		if (
			!Number.isFinite(ts) ||
			ts < start.getTime() ||
			ts >= end.getTime() ||
			(ts - start.getTime()) % quarter !== 0 ||
			!Number.isFinite(interval.val) ||
			interval.val < 0 ||
			(interval.end !== undefined && interval.end - ts !== quarter)
		) {
			invalid++;
			continue;
		}
		if (seen.has(ts)) {
			duplicates++;
			if (seen.get(ts) !== interval.val) {
				conflicts++;
			}
		} else {
			seen.set(ts, interval.val);
		}
	}
	const received = seen.size;
	const missing = Math.max(0, expected - received);
	return {
		expected,
		received,
		missing,
		duplicates,
		conflicts,
		invalid,
		complete: missing === 0 && invalid === 0 && conflicts === 0,
	};
}

module.exports = { intervalQuality };
