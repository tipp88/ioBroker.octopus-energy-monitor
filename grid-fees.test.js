'use strict';
const { expect } = require('chai');
const { normalizeGridFees, ENDPOINT } = require('./lib/grid-fees');
const factory = require('./main');

function payload(operator = 'DNO') {
	const row = (type, from, to, cents) => ({
		gridFeeKwhRateType: type,
		rateTypeIntervalStart: from,
		rateTypeIntervalEnd: to,
		gridFeeInCentsPerKwh: cents,
		gridOperatorCode: operator,
		validFrom: '2020-01-01T00:00:00+01:00',
		validTo: null,
	});
	return {
		module: 'MODULE_3',
		gridFees: [
			row('STANDARD', '00:00:00', '00:00:00', '10'),
			row('OFFPEAK', '22:00:00', '06:00:00', '5'),
			row('PEAK', '17:00:00', '20:00:00', '15'),
		],
	};
}
function setup() {
	const a = factory({});
	a.config = {
		enwgAutoGridFees: true,
		enwgEnabled: true,
		enwgStartDate: '2020-01-01',
		octopusAccount: 'account',
		enwgGridFeeSt: '0.2',
		enwgGridFeeNt: '0.1',
		enwgGridFeeHt: '0.3',
		enwgTimeWindows: [],
	};
	a.hasOctopus = true;
	a.enwgEnabled = true;
	a.masterData = { gridOperatorCode: 'DNO', rates: [] };
	return a;
}

describe('Optional automatic Module 3 grid fees', () => {
	for (const [date, count] of [
		['2026-03-29', 92],
		['2026-10-25', 100],
		['2026-09-23', 96],
	]) {
		it(`validates all ${count} intervals on ${date} with Berlin and overnight windows`, () => {
			const a = setup(),
				day = a.getBerlinDay(new Date(`${date}T12:00:00Z`));
			const schedule = normalizeGridFees(payload(), 'DNO', day.start, day.end);
			expect(schedule.intervals.size).to.equal(count);
			expect(schedule.intervals.get(day.start.getTime())).to.deep.equal({
				tariff: 'NT',
				net: 0.05,
				standardNet: 0.1,
			});
		});
	}
	it('rejects wrong module/operator, gaps, ambiguity, invalid prices and partial validity', () => {
		const day = setup().getBerlinDay(new Date('2026-09-23T12:00:00Z'));
		for (const mutate of [
			p => (p.module = 'MODULE_1'),
			p => (p.gridFees[0].gridOperatorCode = 'OTHER'),
			p => (p.gridFees[0].rateTypeIntervalEnd = '01:00:00'),
			p => p.gridFees.push({ ...p.gridFees[1], gridFeeInCentsPerKwh: '6' }),
			p => (p.gridFees[0].gridFeeInCentsPerKwh = ''),
			p => (p.gridFees[0].validTo = '2026-09-23T12:00:00Z'),
			p => (p.gridFees[0].validFrom = '2020-01-01T00:00:00'),
			p => (p.gridFees[1].rateTypeIntervalStart = '22:07:00'),
		]) {
			const p = payload();
			mutate(p);
			expect(normalizeGridFees(p, 'DNO', day.start, day.end)).to.equal(null);
		}
	});
	it('caches by account, operator and Berlin day and converts net cents using historical VAT', async () => {
		const a = setup();
		let calls = 0;
		a.requestOctopus = async (request, endpoint) => {
			calls++;
			expect(endpoint).to.equal(ENDPOINT);
			expect(request.variables.date).to.match(/^2026-09-2[34]$/);
			return { status: 200, data: { data: { variableGridFees: payload(a.masterData.gridOperatorCode) } } };
		};
		const at = new Date('2026-09-22T22:00:00Z');
		await a.prepareGridFees(at);
		await a.prepareGridFees(at);
		expect(calls).to.equal(1);
		expect(a.getEnwgTariffForTime(at, a.config)).to.equal('NT');
		expect(a.getEnwgGridFees(a.config, at, 0.16).NT.gross).to.be.closeTo(0.058, 1e-12);
		expect(a.getEnwgGridFees(a.config, at, 0.16).ST.gross).to.be.closeTo(0.116, 1e-12);
		await a.prepareGridFees(new Date('2026-09-24T12:00:00Z'));
		a.masterData.gridOperatorCode = 'OTHER';
		await a.prepareGridFees(at);
		a.config.octopusAccount = 'second';
		await a.prepareGridFees(at);
		expect(calls).to.equal(4);
	});
	it('does not call the API when disabled and retains manual fallback on errors', async () => {
		const a = setup();
		let calls = 0;
		a.requestOctopus = async () => {
			calls++;
			throw new Error('unavailable');
		};
		const at = new Date('2026-09-23T12:00:00Z');
		a.config.enwgAutoGridFees = false;
		await a.prepareGridFees(at);
		expect(calls).to.equal(0);
		a.config.enwgAutoGridFees = true;
		await a.prepareGridFees(at);
		await a.prepareGridFees(at);
		expect(calls).to.equal(1);
		expect(a.getEnwgGridFees(a.config, at).ST.net).to.equal(0.2);
		const writes = new Map();
		a.writeStateObject = async (id, _name, val) => writes.set(id, val);
		await a.writeGridFeeSnapshot('day', at);
		expect(writes.get('day.gridFeeSource')).to.equal('manual_fallback');
		expect(writes.get('day.gridFeeFallbackReason')).to.equal('request_failed');
		expect(writes.get('day.gridFeeSchedule')).not.to.contain('account');
	});
	it('uses the same automatic Berlin windows for Inexogy interval-end readings', async () => {
		const a = setup(),
			at = new Date('2026-09-22T22:00:00Z');
		a.inexogyMeterId = 'meter';
		a.requestOctopus = async () => ({ status: 200, data: { data: { variableGridFees: payload() } } });
		await a.prepareGridFees(at);
		a.fetchInexogyReadings = async () => [
			{ time: +at, values: { energy: 1e10 } },
			{ time: +at + 900000, values: { energy: 2e10 } },
		];
		const day = a.getBerlinDay(at);
		const result = await a.fetchInexogy(day.start, day.end);
		expect(result.enwgSlots.NT.consumption).to.equal(1);
		expect(result.enwgSlots.ST.consumption).to.equal(0);
	});

	it('applies automatic fees to historical costs and keeps source slots consistent', async () => {
		const a = setup(),
			at = new Date('2026-09-22T22:00:00Z');
		a.masterData.agreements = [
			{
				id: 'A',
				validFrom: '2020-01-01T00:00:00Z',
				validTo: null,
				unitRateInformation: {
					__typename: 'SimpleProductUnitRateInformation',
					grossRateInformation: [{ date: '2020-01-01', grossRate: '30', vatRate: '19' }],
				},
				standingChargeGrossRateInformation: [{ date: '2020-01-01', grossRate: '12', vatRate: '19' }],
			},
		];
		a.requestOctopus = async () => ({ status: 200, data: { data: { variableGridFees: payload() } } });
		await a.prepareGridFees(at);
		const day = a.getBerlinDay(at);
		const result = a.calculateHistoricalUsage(
			[{ node: { startAt: at.toISOString(), endAt: new Date(+at + 900000).toISOString(), value: '1' } }],
			day.start,
			day.end,
		);
		expect(result.totalCost).to.be.closeTo(0.3 - 0.119 + 0.0595, 1e-12);
		expect(result.enwgSlots.NT.consumption).to.equal(1);
		expect(result.enwgSlots.NT.costGross).to.equal(result.totalCost);
		delete a.masterData.agreements[0].unitRateInformation.grossRateInformation[0].vatRate;
		const unknownVat = a.calculateHistoricalUsage(
			[{ node: { startAt: at.toISOString(), value: '1' } }],
			day.start,
			day.end,
		);
		expect(unknownVat.total).to.equal(1);
		expect(unknownVat.costAvailable).to.equal(false);
		expect(unknownVat.totalCost).to.satisfy(Number.isNaN);
	});
});
