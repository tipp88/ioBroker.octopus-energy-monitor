'use strict';

// GrossRateInformation dates are VAT-validity dates, not interval forecasts.
const list = value => (Array.isArray(value) ? value : value ? [value] : []);
const number = value => (value === null || value === undefined || value === '' ? NaN : Number(value));

/**
 * Select a single non-revoked agreement for an instant; never guess on overlap.
 *
 * @param {Array<object>} agreements API agreements
 * @param {Date} at Measurement instant
 */
function agreementAt(agreements, at) {
	const matches = agreements.filter(
		a =>
			!a.isRevoked &&
			Number.isFinite(Date.parse(a.validFrom)) &&
			Date.parse(a.validFrom) <= at.getTime() &&
			(a.validTo == null || at.getTime() < Date.parse(a.validTo)),
	);
	return matches.length === 1 ? matches[0] : null;
}

/**
 * Select an explicitly dated gross price for a German calendar date.
 *
 * @param {object|Array<object>} information API gross-rate information
 * @param {string} date German YYYY-MM-DD
 * @param {number} divisor 100 for ct/kWh, 1 for EUR/month
 */
function grossPrice(information, date, divisor) {
	const rows = list(information).filter(
		row =>
			/^\d{4}-\d{2}-\d{2}$/.test(row.date || '') &&
			row.date <= date &&
			(row.rateValidToDate == null || date < row.rateValidToDate),
	);
	if (rows.length !== 1 || !Number.isFinite(number(rows[0].grossRate))) {
		return null;
	}
	return { euros: number(rows[0].grossRate) / divisor, vat: number(rows[0].vatRate) / 100 };
}

/**
 * Return the agreement's tariff windows; unknown/dynamic types are not priced.
 *
 * @param {object|null} agreement API agreement
 * @param {boolean} splitGo Optional legacy GO split
 */
function tariffRates(agreement, splitGo = false) {
	// Forecasts identify dynamic pricing, but cannot establish historical actual prices.
	const productName = [agreement?.product?.code, agreement?.product?.fullName, agreement?.product?.displayName].join(
		' ',
	);
	if (list(agreement?.unitRateForecast).length || /dynamic|dynamisch/i.test(productName)) {
		return [];
	}
	const info = agreement?.unitRateInformation;
	if (info?.__typename === 'TimeOfUseProductUnitRateInformation') {
		return (info.rates || []).map(rate => ({
			name: rate.timeslotName,
			prices: rate.grossRateInformation,
			windows: (rate.timeslotActivationRules || []).map(rule => ({
				from: rule.activeFromTime,
				to: rule.activeToTime,
			})),
		}));
	}
	if (info?.__typename !== 'SimpleProductUnitRateInformation') {
		return [];
	}
	return (
		splitGo
			? [
					{ name: 'GO', from: '00:00', to: '05:00' },
					{ name: 'STANDARD', from: '05:00', to: '24:00' },
				]
			: [{ name: 'STANDARD', from: '00:00', to: '24:00' }]
	).map(rate => ({
		name: rate.name,
		prices: info.grossRateInformation,
		windows: [{ from: rate.from, to: rate.to }],
	}));
}

module.exports = { agreementAt, grossPrice, tariffRates };
