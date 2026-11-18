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
	a.writeStateObject = async () => {};
	return a;
}

describe('Optional automatic Module 3 grid fees', () => {
	it('imports a validated Berlin day into the unsaved form with the runtime option still disabled', async () => {
		const a = setup();
		const day = a.getBerlinDay(new Date('2026-11-18T12:00:00Z'));
		a.getBerlinDay = () => day;
		a.config.enwgAutoGridFees = false;
		a.enwgEnabled = false;
		const original = JSON.stringify(a.config);
		let calls = 0;
		a.requestOctopus = async (request, endpoint) => {
			calls++;
			expect(endpoint).to.equal(ENDPOINT);
			expect(request.variables).to.deep.equal({ accountNumber: 'account', gridOperatorCode: 'DNO', date: '2026-11-18' });
			return { status: 200, data: { data: { variableGridFees: payload() } } };
		};
		let reply;
		a.sendTo = (_from, _command, response) => { reply = response; };
		await a.onMessage({ command: 'previewGridFees', message: { account: 'account' }, callback: {}, from: 'test' });
		expect(calls).to.equal(1);
		expect(reply.native).to.deep.equal({
			enwgGridFeeSt: '0.1', enwgGridFeeNt: '0.05', enwgGridFeeHt: '0.15', enwgGridFeesAreGross: false,
			enwgTimeWindows: [
				{ months: '11', tariff: 'NT', startTime: '00:00', endTime: '06:00' },
				{ months: '11', tariff: 'HT', startTime: '17:00', endTime: '20:00' },
				{ months: '11', tariff: 'NT', startTime: '22:00', endTime: '24:00' },
			],
		});
		expect(JSON.stringify(a.config)).to.equal(original);
	});

	it('returns no form changes for another account, Module 1, API errors or unrepresentable schedules', async () => {
		const a = setup();
		expect((await a.previewGridFees('different')).error).to.equal('gridFeeAccountRequired');
		const plan = payload();
		for (const [response, error] of [
			[{ status: 429 }, 'gridFeeRequestFailed'],
			[{ status: 200, data: { data: { variableGridFees: { ...plan, module: 'MODULE_1' } } } }, 'gridFeeWrongModule'],
			[{ status: 200, data: { data: { variableGridFees: { ...plan, gridFees: plan.gridFees.slice(0, 2) } } } }, 'gridFeeInvalidSchedule'],
		]) {
			a.requestOctopus = async () => response;
			const result = await a.previewGridFees('account');
			expect(result.error).to.equal(error);
			expect(result).not.to.have.property('native');
		}
	});

	it('distinguishes absent modules, empty schedules and invalid fee entries', () => {
		const day = setup().getBerlinDay(new Date('2026-11-08T12:00:00Z'));
		for (const [response, expected] of [
			[null, 'missing_variable_grid_fees'],
			[{ module: null, gridFees: [] }, 'missing_module'],
			[{ module: 'MODULE_1', gridFees: [] }, 'module_not_3'],
			[{ module: 'MODULE_3', gridFees: [] }, 'empty_grid_fees'],
			[{ module: 'MODULE_3', gridFees: null }, 'invalid_grid_fees_array'],
			[{ module: 'MODULE_3', gridFees: [null] }, 'invalid_grid_fee_entry'],
		]) {
			const diagnostics = { reason: '' };
			expect(normalizeGridFees(response, 'DNO', day.start, day.end, diagnostics)).to.equal(null);
			expect(diagnostics.reason).to.equal(expected);
		}
		const response = payload();
		response.gridFees[1].rateTypeIntervalStart = '22:07:00';
		const diagnostics = { reason: '' };
		normalizeGridFees(response, 'DNO', day.start, day.end, diagnostics);
		expect(diagnostics.reason).to.equal('unsupported_time_window:entry=1');
	});

	it('publishes response fields without account or authorization data and clears stale responses on failure', async () => {
		const a = setup(),
			at = new Date('2026-11-08T12:00:00Z');
		const writes = new Map();
		a.writeStateObject = async (id, _name, value) => writes.set(id, value);
		const response = { module: 'MODULE_1', gridFees: [] };
		a.requestOctopus = async () => ({
			status: 200,
			headers: { Authorization: 'secret' },
			data: { data: { variableGridFees: { ...response, accountNumber: 'secret' } } },
		});
		await a.prepareGridFees(at);
		expect(JSON.parse(writes.get('info.api.gridFees.rawResponse'))).to.deep.equal(response);
		expect(writes.get('info.api.gridFees.httpStatus')).to.equal(200);
		expect(writes.get('info.api.gridFees.responseDate')).to.equal('2026-11-08');
		expect(writes.get('info.api.gridFees.rejectionReason')).to.equal('module_not_3');
		a.gridFeeCache.clear();
		a.requestOctopus = async () => {
			throw new Error('secret');
		};
		await a.prepareGridFees(at);
		expect(writes.get('info.api.gridFees.rawResponse')).to.equal('null');
		expect(writes.get('info.api.gridFees.httpStatus')).to.equal(0);
		expect(writes.get('info.api.gridFees.rejectionReason')).to.equal('request_failed');
	});

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
		a.config.enwgTimeWindows = [{ tariff: 'NT', startTime: '00:00', endTime: '06:00' }];
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
		delete a.config.enwgGridFeeSt;
		delete a.config.enwgGridFeeNt;
		delete a.config.enwgGridFeeHt;
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
