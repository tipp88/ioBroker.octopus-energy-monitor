'use strict';

const { checked } = require('./daily-export');

/**
 * Reconcile only authoritative Octopus points, never delete a DB-only timestamp.
 *
 * @param send History backend request
 * @param id Existing Octopus consumption series
 * @param start Inclusive Berlin day start (ms)
 * @param end Exclusive Berlin day end (ms)
 * @param intervals Octopus quarter hours
 */
async function repairIntervals(send, id, start, end, intervals) {
	const wanted = new Map();
	for (const { ts, val } of intervals) {
		if (
			!Number.isFinite(ts) ||
			ts < start ||
			ts >= end ||
			(ts - start) % 900000 ||
			!Number.isFinite(val) ||
			val < 0
		) {
			continue;
		}
		if (wanted.has(ts) && wanted.get(ts) !== val) {
			throw new Error('Conflicting Octopus intervals');
		}
		wanted.set(ts, val);
	}
	if (!wanted.size) {
		return;
	}
	const limit = 512;
	const response = await send('getHistory', {
		id,
		options: { start: start - 1, end, aggregate: 'none', count: limit, limit, removeBorderValues: true },
	});
	if (response?.error || !Array.isArray(response?.result) || response.result.length >= limit) {
		throw new Error(response?.error || 'Incomplete interval history response');
	}
	const existing = new Map(response.result.map(point => [point.ts, point.val]));
	const inserts = [];
	const updates = [];
	for (const [ts, val] of wanted) {
		const point = { id, state: { ts, val, ack: true, q: 0 } };
		if (!existing.has(ts)) {
			inserts.push(point);
		} else if (existing.get(ts) !== val) {
			updates.push(point);
		}
	}
	if (inserts.length) {
		await checked(send, 'storeState', inserts);
	}
	if (updates.length) {
		const features = await send('features', {});
		if (!features?.supportedFeatures?.includes('update')) {
			throw new Error('History backend does not advertise interval updates');
		}
		for (const point of updates) {
			await checked(send, 'update', point);
		}
	}
}

module.exports = { repairIntervals };
