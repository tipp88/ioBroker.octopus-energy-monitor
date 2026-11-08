'use strict';

const ENDPOINT = 'https://api.backend.octopusenergy.de/v1/graphql/';
const QUERY = `query VariableGridFees($accountNumber: String!, $gridOperatorCode: String!, $date: Date) {
 variableGridFees(accountNumber: $accountNumber, gridOperatorCode: $gridOperatorCode, date: $date) {
  module gridFees { gridFeeKwhRateType rateTypeIntervalStart rateTypeIntervalEnd validFrom validTo gridOperatorCode gridFeeInCentsPerKwh }
 }
}`;
const CLOCK = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'Europe/Berlin',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
});

/**
 * Parse an API wall-clock boundary; reject sub-quarter-hour schedules.
 *
 * @param {string} value Time string
 */
function minute(value) {
	if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(:00)?$/.test(value)) {
		return NaN;
	}
	const [h, m] = value.split(':').map(Number);
	return m % 15 === 0 ? h * 60 + m : NaN;
}

/**
 * Validate a whole day before using any automatic fees. API amounts are net cents/kWh.
 *
 * @param {object} payload Variable grid fee response
 * @param {string} operator Expected grid operator code
 * @param {Date} start Inclusive day boundary
 * @param {Date} end Exclusive day boundary
 */
function normalizeGridFees(payload, operator, start, end) {
	if (payload?.module !== 'MODULE_3' || !Array.isArray(payload.gridFees) || !payload.gridFees.length) {
		return null;
	}
	const names = { OFFPEAK: 'NT', STANDARD: 'ST', PEAK: 'HT' };
	const rates = payload.gridFees.map(row => ({
		tariff: names[row.gridFeeKwhRateType],
		from: minute(row.rateTypeIntervalStart),
		to: minute(row.rateTypeIntervalEnd),
		validFrom:
			typeof row.validFrom === 'string' && /(Z|[+-]\d\d:\d\d)$/.test(row.validFrom)
				? Date.parse(row.validFrom)
				: NaN,
		validTo:
			row.validTo == null
				? Infinity
				: typeof row.validTo === 'string' && /(Z|[+-]\d\d:\d\d)$/.test(row.validTo)
					? Date.parse(row.validTo)
					: NaN,
		net:
			row.gridFeeInCentsPerKwh == null || row.gridFeeInCentsPerKwh === ''
				? NaN
				: Number(row.gridFeeInCentsPerKwh) / 100,
		operator: row.gridOperatorCode,
	}));
	if (
		rates.some(
			r =>
				!r.tariff ||
				r.operator !== operator ||
				!Number.isFinite(r.net) ||
				r.net < 0 ||
				!Number.isFinite(r.from) ||
				!Number.isFinite(r.to) ||
				!Number.isFinite(r.validFrom) ||
				Number.isNaN(r.validTo) ||
				r.validTo <= r.validFrom ||
				(r.from === r.to && r.from !== 0),
		)
	) {
		return null;
	}
	const intervals = new Map();
	for (let ts = start.getTime(); ts < end.getTime(); ts += 900000) {
		const [h, m] = CLOCK.format(new Date(ts)).split(':').map(Number);
		const clock = h * 60 + m;
		const valid = rates.filter(r => r.validFrom <= ts && r.validTo >= ts + 900000);
		const standards = [...new Set(valid.filter(r => r.tariff === 'ST').map(r => r.net))];
		if (standards.length !== 1) {
			return null;
		}
		const specific = valid.filter(
			r => r.from !== r.to && (r.from < r.to ? clock >= r.from && clock < r.to : clock >= r.from || clock < r.to),
		);
		const candidates = specific.length ? specific : valid.filter(r => r.from === 0 && r.to === 0);
		const unique = [...new Map(candidates.map(r => [`${r.tariff}:${r.net}`, r])).values()];
		if (unique.length !== 1) {
			return null;
		}
		intervals.set(ts, { tariff: unique[0].tariff, net: unique[0].net, standardNet: standards[0] });
	}
	return intervals.size ? { module: payload.module, intervals, rates } : null;
}

module.exports = { ENDPOINT, QUERY, normalizeGridFees };
