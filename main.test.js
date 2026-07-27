'use strict';

const { expect } = require('chai');

// Mock @iobroker/adapter-core so that requiring main.js doesn't boot the real ioBroker system
// @ts-ignore
require.cache[require.resolve('@iobroker/adapter-core')] = {
	exports: {
		Adapter: class MockAdapter {
			constructor() {
				this.log = {
					info: () => {},
					warn: () => {},
					error: () => {},
					debug: () => {},
				};
			}
			on() {}
		},
	},
};

const factory = require('./main.js');
const adapter = factory({});

describe('§14a EnWG Tariff Resolution & Validation Tests', () => {
	describe('validateEnwgConfig', () => {
		it('should return valid if EnWG is disabled', () => {
			const config = { enwgEnabled: false };
			const result = adapter.validateEnwgConfig(config);
			expect(result.valid).to.be.true;
		});

		it('should return invalid if EnWG is enabled but no windows configured', () => {
			const config = { enwgEnabled: true, enwgTimeWindows: [] };
			const result = adapter.validateEnwgConfig(config);
			expect(result.valid).to.be.false;
			expect(result.error).to.include('No time windows configured');
		});

		it('should return valid for non-overlapping windows', () => {
			const config = {
				enwgEnabled: true,
				enwgTimeWindows: [
					{ tariff: 'NT', months: '*', startTime: '00:00', endTime: '06:00' },
					{ tariff: 'HT', months: '*', startTime: '22:00', endTime: '24:00' },
				],
			};
			const result = adapter.validateEnwgConfig(config);
			expect(result.valid).to.be.true;
		});

		it('should return invalid for overlapping windows within the same month', () => {
			const config = {
				enwgEnabled: true,
				enwgTimeWindows: [
					{ tariff: 'NT', months: '1,2,3', startTime: '12:00', endTime: '14:00' },
					{ tariff: 'ST', months: '3,4', startTime: '13:00', endTime: '15:00' },
				],
			};
			const result = adapter.validateEnwgConfig(config);
			expect(result.valid).to.be.false;
			expect(result.error).to.include('Overlap detected in month 3');
		});

		it('should handle wildcard * active months correctly', () => {
			const config = {
				enwgEnabled: true,
				enwgTimeWindows: [
					{ tariff: 'NT', months: '*', startTime: '12:00', endTime: '14:00' },
					{ tariff: 'ST', months: '6', startTime: '13:00', endTime: '15:00' },
				],
			};
			const result = adapter.validateEnwgConfig(config);
			expect(result.valid).to.be.false;
			expect(result.error).to.include('Overlap detected in month 6');
		});
	});

	describe('getEnwgTariffForTime', () => {
		const config = {
			enwgEnabled: true,
			enwgTimeWindows: [
				{ tariff: 'NT', months: '1,2,11,12', startTime: '00:00', endTime: '06:00' },
				{ tariff: 'HT', months: '1,2,11,12', startTime: '17:00', endTime: '19:00' },
			],
		};

		it('should return NT during winter months and late night', () => {
			const testDate = new Date(2026, 0, 15, 3, 30); // Jan 15th, 03:30
			const tariff = adapter.getEnwgTariffForTime(testDate, config);
			expect(tariff).to.equal('NT');
		});

		it('should return HT during winter months peak hours', () => {
			const testDate = new Date(2026, 0, 15, 18, 15); // Jan 15th, 18:15
			const tariff = adapter.getEnwgTariffForTime(testDate, config);
			expect(tariff).to.equal('HT');
		});

		it('should return ST during summer months even at late night (as NT is only winter)', () => {
			const testDate = new Date(2026, 5, 15, 3, 30); // June 15th, 03:30
			const tariff = adapter.getEnwgTariffForTime(testDate, config);
			expect(tariff).to.equal('ST');
		});
	});

	describe('getTariffSegmentsForDay', () => {
		const config = {
			enwgEnabled: true,
			enwgTimeWindows: [
				{ tariff: 'NT', months: '1,2,11,12', startTime: '00:00', endTime: '06:00' },
				{ tariff: 'HT', months: '1,2,11,12', startTime: '17:00', endTime: '19:00' },
			],
		};

		it('should group 15-minute slots into correct daily segments', () => {
			const testDate = new Date(2026, 0, 15); // Jan 15th
			const segments = adapter.getTariffSegmentsForDay(testDate, config);

			// Expected:
			// NT: 00:00 (0m) to 06:00 (360m)
			// HT: 17:00 (1020m) to 19:00 (1140m)
			// ST: 06:00 (360m) to 17:00 (1020m) AND 19:00 (1140m) to 24:00 (1440m)
			expect(segments.NT).to.have.lengthOf(1);
			expect(segments.NT[0]).to.deep.equal({ fromMin: 0, toMin: 360 });

			expect(segments.HT).to.have.lengthOf(1);
			expect(segments.HT[0]).to.deep.equal({ fromMin: 1020, toMin: 1140 });

			expect(segments.ST).to.have.lengthOf(2);
			expect(segments.ST[0]).to.deep.equal({ fromMin: 360, toMin: 1020 });
			expect(segments.ST[1]).to.deep.equal({ fromMin: 1140, toMin: 1440 });
		});
	});

	describe('isEnwgActiveForDate', () => {
		it('should return false if enwgEnabled is false', () => {
			adapter.enwgEnabled = false;
			const config = { enwgStartDate: '2026-01-01' };
			const result = adapter.isEnwgActiveForDate(new Date(2026, 0, 5), config);
			expect(result).to.be.false;
		});

		it('should return false if enwgStartDate is invalid format', () => {
			adapter.enwgEnabled = true;
			const config = { enwgStartDate: 'invalid-date' };
			const result = adapter.isEnwgActiveForDate(new Date(2026, 0, 5), config);
			expect(result).to.be.false;
		});

		it('should return true for dates >= enwgStartDate', () => {
			adapter.enwgEnabled = true;
			const config = { enwgStartDate: '2026-05-10' };

			expect(adapter.isEnwgActiveForDate(new Date(2026, 4, 9), config)).to.be.false; // May 9
			expect(adapter.isEnwgActiveForDate(new Date(2026, 4, 10), config)).to.be.true; // May 10
			expect(adapter.isEnwgActiveForDate(new Date(2026, 4, 11), config)).to.be.true; // May 11
		});
	});

	describe('getEnwgGridFees', () => {
		it('should calculate gross and net prices correctly when inputs are net', () => {
			const config = {
				enwgGridFeeSt: 0.1,
				enwgGridFeeNt: 0.05,
				enwgGridFeeHt: 0.15,
				enwgGridFeesAreGross: false,
			};
			const result = adapter.getEnwgGridFees(config);
			expect(result.ST.net).to.equal(0.1);
			expect(result.ST.gross).to.be.closeTo(0.119, 0.0001);
			expect(result.NT.net).to.equal(0.05);
			expect(result.NT.gross).to.be.closeTo(0.0595, 0.0001);
			expect(result.HT.net).to.equal(0.15);
			expect(result.HT.gross).to.be.closeTo(0.1785, 0.0001);
		});

		it('should calculate gross and net prices correctly when inputs are gross', () => {
			const config = {
				enwgGridFeeSt: 0.119,
				enwgGridFeeNt: 0.0595,
				enwgGridFeeHt: 0.1785,
				enwgGridFeesAreGross: true,
			};
			const result = adapter.getEnwgGridFees(config);
			expect(result.ST.gross).to.equal(0.119);
			expect(result.ST.net).to.be.closeTo(0.1, 0.0001);
			expect(result.NT.gross).to.equal(0.0595);
			expect(result.NT.net).to.be.closeTo(0.05, 0.0001);
			expect(result.HT.gross).to.equal(0.1785);
			expect(result.HT.net).to.be.closeTo(0.15, 0.0001);
		});

		it('should parse strings with dots or commas as decimal separators correctly', () => {
			const config = {
				enwgGridFeeSt: '0,10',
				enwgGridFeeNt: '0.05',
				enwgGridFeeHt: '  0,15  ',
				enwgGridFeesAreGross: false,
			};
			const result = adapter.getEnwgGridFees(config);
			expect(result.ST.net).to.equal(0.1);
			expect(result.NT.net).to.equal(0.05);
			expect(result.HT.net).to.equal(0.15);
		});
	});

	describe('getPeriodDates', () => {
		it('should return correct start and end dates for a standard period (start day 18)', () => {
			const date = new Date(2026, 4, 29); // May 29, 2026
			const period = adapter.getPeriodDates(date, 18);
			expect(period.start.getFullYear()).to.equal(2026);
			expect(period.start.getMonth()).to.equal(4); // May (0-indexed)
			expect(period.start.getDate()).to.equal(18);
			expect(period.end.getFullYear()).to.equal(2026);
			expect(period.end.getMonth()).to.equal(5); // June
			expect(period.end.getDate()).to.equal(17);
		});

		it('should return correct start and end dates when date is before the startDay in the month', () => {
			const date = new Date(2026, 4, 15); // May 15, 2026
			const period = adapter.getPeriodDates(date, 18);
			expect(period.start.getFullYear()).to.equal(2026);
			expect(period.start.getMonth()).to.equal(3); // April
			expect(period.start.getDate()).to.equal(18);
			expect(period.end.getFullYear()).to.equal(2026);
			expect(period.end.getMonth()).to.equal(4); // May
			expect(period.end.getDate()).to.equal(17);
		});

		it('should return correct start and end dates when startDay is 1 (calendar month)', () => {
			const date = new Date(2026, 4, 15); // May 15, 2026
			const period = adapter.getPeriodDates(date, 1);
			expect(period.start.getFullYear()).to.equal(2026);
			expect(period.start.getMonth()).to.equal(4); // May
			expect(period.start.getDate()).to.equal(1);
			expect(period.end.getFullYear()).to.equal(2026);
			expect(period.end.getMonth()).to.equal(4); // May
			expect(period.end.getDate()).to.equal(31);
		});
	});

	describe('aggregateHistory', () => {
		let RealDate;

		before(() => {
			RealDate = global.Date;
			// @ts-ignore
			global.Date = function (...args) {
				if (args.length === 0) {
					return new RealDate(2026, 4, 29); // May 29, 2026
				}
				// @ts-ignore
				return new RealDate(...args);
			};
			global.Date.now = () => new RealDate(2026, 4, 29).getTime();
			global.Date.UTC = RealDate.UTC;
			global.Date.parse = RealDate.parse;
		});

		after(() => {
			global.Date = RealDate;
		});

		it('should group daily consumption into correct period folders and dynamically sum slots', async () => {
			const mockObjects = {};
			const mockStates = {};

			// Generate all 30 days for period 2026-04-18 to 2026-05-17
			const startGen = new Date(2026, 3, 18); // April 18
			const endGen = new Date(2026, 4, 17); // May 17
			const current = new Date(startGen);
			while (current <= endGen) {
				const y = current.getFullYear();
				const m = String(current.getMonth() + 1).padStart(2, '0');
				const d = String(current.getDate()).padStart(2, '0');
				const basePath = `octopus-energy-monitor.0.history.${y}.${m}.${d}.octopus`;

				mockObjects[`${basePath}.dailyConsumption`] = { type: 'state' };
				mockObjects[`${basePath}.totalCost`] = { type: 'state' };
				mockObjects[`${basePath}.goConsumption`] = { type: 'state' };
				mockObjects[`${basePath}.goCost`] = { type: 'state' };
				mockObjects[`${basePath}.standardConsumption`] = { type: 'state' };
				mockObjects[`${basePath}.standardCost`] = { type: 'state' };

				// Sum should end up as 10 consumption, 2 cost total
				mockStates[`${basePath}.dailyConsumption`] = { val: 0.33333333 };
				mockStates[`${basePath}.totalCost`] = { val: 0.06666667 };
				mockStates[`${basePath}.goConsumption`] = { val: 0.13333333 };
				mockStates[`${basePath}.goCost`] = { val: 0.01666667 };
				mockStates[`${basePath}.standardConsumption`] = { val: 0.2 };
				mockStates[`${basePath}.standardCost`] = { val: 0.05 };

				current.setDate(current.getDate() + 1);
			}

			// Add only one day for the next period (should be incomplete)
			mockObjects['octopus-energy-monitor.0.history.2026.05.20.octopus.dailyConsumption'] = { type: 'state' };
			mockObjects['octopus-energy-monitor.0.history.2026.05.20.octopus.totalCost'] = { type: 'state' };
			mockObjects['octopus-energy-monitor.0.history.2026.05.20.octopus.goConsumption'] = { type: 'state' };
			mockObjects['octopus-energy-monitor.0.history.2026.05.20.octopus.goCost'] = { type: 'state' };
			mockObjects['octopus-energy-monitor.0.history.2026.05.20.octopus.standardConsumption'] = { type: 'state' };
			mockObjects['octopus-energy-monitor.0.history.2026.05.20.octopus.standardCost'] = { type: 'state' };

			mockStates['octopus-energy-monitor.0.history.2026.05.20.octopus.dailyConsumption'] = { val: 15 };
			mockStates['octopus-energy-monitor.0.history.2026.05.20.octopus.totalCost'] = { val: 3 };
			mockStates['octopus-energy-monitor.0.history.2026.05.20.octopus.goConsumption'] = { val: 5 };
			mockStates['octopus-energy-monitor.0.history.2026.05.20.octopus.goCost'] = { val: 0.6 };
			mockStates['octopus-energy-monitor.0.history.2026.05.20.octopus.standardConsumption'] = { val: 10 };
			mockStates['octopus-energy-monitor.0.history.2026.05.20.octopus.standardCost'] = { val: 2.4 };

			const writtenStates = {};
			const deletedObjects = [];

			// Setup adapter mocks
			const anyAdapter = /** @type {any} */ (adapter);
			anyAdapter.namespace = 'octopus-energy-monitor.0';
			anyAdapter.config = {
				octopusEmail: '',
				octopusPassword: '',
				octopusAccount: '',
				octopusPropertyId: '',
				inexogyEmail: '',
				inexogyPassword: '',
				discrepancyThreshold: 0,
				updateInterval: 0,
				billingPeriodStartDay: 18,
			};
			anyAdapter.masterData = {
				balance: 0,
				propertyId: '',
				tariffName: '',
				isTimeOfUse: true,
				meterNumber: '',
				meterId: '',
				mopName: '',
				dnoName: '',
				rates: [
					{ name: 'Go', rateEuros: 0.12 },
					{ name: 'Standard', rateEuros: 0.24 },
				],
				monthlyStandingCharge: 12.0,
			};

			anyAdapter.getAdapterObjectsAsync = async () => {
				const fullObjects = {};
				for (const [key, obj] of Object.entries(mockObjects)) {
					fullObjects[key] = {
						_id: key,
						type: 'state',
						common: { name: key, type: 'number', role: 'value', read: true, write: false },
						native: {},
					};
				}
				return fullObjects;
			};
			anyAdapter.getStateAsync = async id => mockStates[id];
			anyAdapter.setObjectNotExistsAsync = async id => ({ id });
			anyAdapter.delObjectAsync = async id => {
				deletedObjects.push(id);
			};
			anyAdapter.setStateAsync = async (id, state) => {
				writtenStates[id] = state.val;
				return id;
			};

			await anyAdapter.aggregateHistory();

			// For the 2026-04-18 period (contains 2026.04.20):
			expect(writtenStates['octopus.periods.2026-04-18.startDate']).to.equal('2026-04-18');
			expect(writtenStates['octopus.periods.2026-04-18.endDate']).to.equal('2026-05-17');
			expect(parseFloat(writtenStates['octopus.periods.2026-04-18.totalConsumption'].toFixed(0))).to.equal(10);
			expect(parseFloat(writtenStates['octopus.periods.2026-04-18.totalCost'].toFixed(0))).to.equal(2);
			expect(
				parseFloat(writtenStates['octopus.periods.2026-04-18.totalCostWithStandingCharge'].toFixed(0)),
			).to.equal(14);
			expect(parseFloat(writtenStates['octopus.periods.2026-04-18.goConsumption'].toFixed(0))).to.equal(4);
			expect(parseFloat(writtenStates['octopus.periods.2026-04-18.goCost'].toFixed(1))).to.equal(0.5);
			expect(parseFloat(writtenStates['octopus.periods.2026-04-18.standardConsumption'].toFixed(0))).to.equal(6);
			expect(parseFloat(writtenStates['octopus.periods.2026-04-18.standardCost'].toFixed(1))).to.equal(1.5);

			// Check current month cost with standing charge dynamically
			const yesterday = new Date();
			yesterday.setDate(yesterday.getDate() - 1);
			yesterday.setHours(0, 0, 0, 0);
			const daysInCurrentMonth = new Date(yesterday.getFullYear(), yesterday.getMonth() + 1, 0).getDate();
			const elapsedDaysInMonth = yesterday.getDate();
			const expectedMonthStandingCharge = 12.0 * (elapsedDaysInMonth / daysInCurrentMonth);
			const expectedMonthCostWithStandingCharge = 4.13333339 + expectedMonthStandingCharge;

			expect(parseFloat(writtenStates['octopus.currentMonth.totalCostWithStandingCharge'].toFixed(2))).to.equal(
				parseFloat(expectedMonthCostWithStandingCharge.toFixed(2)),
			);

			// The 2026-05-18 period is incomplete, so it must NOT be written
			expect(writtenStates['octopus.periods.2026-05-18.startDate']).to.be.undefined;
		});
	});

	describe('source-independent history synchronization', () => {
		it('should defer a missing Inexogy day without re-exporting cached Octopus data', () => {
			const retryAfter = Date.now() + 60_000;
			const decision = adapter.getDaySyncDecision(true, false, retryAfter);

			expect(decision.shouldProcess).to.be.false;
			expect(decision.exportOctopus).to.be.false;
			expect(decision.exportInexogy).to.be.true;
			expect(decision.retryDeferred).to.be.true;
		});

		it('should retry Inexogy after the backoff without re-exporting cached Octopus data', () => {
			const retryAfter = Date.now() - 1;
			const decision = adapter.getDaySyncDecision(true, false, retryAfter);

			expect(decision.shouldProcess).to.be.true;
			expect(decision.exportOctopus).to.be.false;
			expect(decision.exportInexogy).to.be.true;
			expect(decision.retryDeferred).to.be.false;
		});

		it('should recalculate cached EnWG data without re-exporting raw intervals', () => {
			const decision = adapter.getDaySyncDecision(true, true, 0, true);

			expect(decision.shouldProcess).to.be.true;
			expect(decision.exportOctopus).to.be.false;
			expect(decision.exportInexogy).to.be.false;
		});

		it('should retain only the requested day from an extended Inexogy response', () => {
			const start = new Date('2026-07-23T22:00:00.000Z');
			const end = new Date('2026-07-24T22:00:00.000Z');
			const readings = [
				{ time: start.getTime() - 1, values: { energy: 1 } },
				{ time: start.getTime(), values: { energy: 2 } },
				{ time: end.getTime(), values: { energy: 3 } },
				{ time: end.getTime() + 1, values: { energy: 4 } },
			];

			const filtered = adapter.filterInexogyReadingsForRange(readings, start, end);
			expect(filtered.map(reading => reading.values.energy)).to.deep.equal([2, 3]);
		});
	});
});
