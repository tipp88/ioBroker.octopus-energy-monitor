'use strict';
const assert = require('node:assert/strict');
const { dailyValues, reconcile, exportDays } = require('./lib/daily-export');
const factory = require('./main');

describe('Octopus daily chart export', () => {
	it('maps dynamic slots, € gross and real zeroes without metadata, net or standing charge', () => {
		const fields = {
			dailyConsumption: 4,
			totalCost: 0.92,
			goConsumption: 0,
			goCost: 0,
			winter_peakConsumption: 4,
			winter_peakCost: 0.92,
			standardConsumption: 0,
			ntConsumption: 0,
			ntCost: 0,
			ntCostNet: 0,
			stConsumption: 4,
			stCost: 0.92,
			stCostNet: 0.8,
			standingCharge: 1,
			pricingVersion: 1,
		};
		assert.deepEqual(dailyValues(fields, true), {
			consumption: 4,
			cost: 0.92,
			'tariff.go.consumption': 0,
			'tariff.go.cost': 0,
			'tariff.winter_peak.consumption': 4,
			'tariff.winter_peak.cost': 0.92,
			'tariff.standard.consumption': 0,
			'enwg.nt.consumption': 0,
			'enwg.nt.costGross': 0,
			'enwg.st.consumption': 4,
			'enwg.st.costGross': 0.92,
		});
		assert.ok(!('enwg.st.costGross' in dailyValues(fields, false)));
		assert.ok(!('enwg.st.consumption' in dailyValues({ ...fields, gridFeeSource: 'unavailable' }, true)));
		assert.ok(!('cost' in dailyValues({ ...fields, costAvailable: false }, true)));
		assert.deepEqual(dailyValues({ dailyConsumption: null, goCost: 5 }, true), {});
		assert.deepEqual(dailyValues({ dailyConsumption: 0, totalCost: null, goCost: NaN }, false), { consumption: 0 });
	});

	it('recovers partially accepted batches without a duplicate; corrects and removes only owned points', async () => {
		const prefix = 'octopus-energy-monitor.0.octopus.daily.';
		const db = new Map();
		let journal = {},
			loseReply = true,
			allowDelete = false;
		const mutations = [];
		const run = values =>
			reconcile({
				values,
				ledger: journal,
				ts: 1234,
				prefix,
				register: async () => {},
				supports: async cmd => cmd !== 'delete' || allowDelete,
				unsupported: new Set(),
				save: async entry => {
					journal = structuredClone(entry);
				},
				send: async (cmd, data) => {
					if (cmd === 'getHistory') return { result: db.has(data.id) ? [db.get(data.id)] : [] };
					for (const { id, state } of Array.isArray(data) ? data : [data]) {
						assert.equal(state.ts, 1234);
						mutations.push([cmd, id]);
						if (cmd === 'storeState') assert.ok(!db.has(id));
						if (cmd === 'delete') db.delete(id);
						else db.set(id, state);
						if (loseReply) {
							loseReply = false;
							return { success: true, successCount: 1 };
						}
					}
					return { success: true };
				},
			});
		await assert.rejects(run({ cost: 2, consumption: 5 }), /incomplete/);
		assert.equal(journal.pending.length, 2);
		await run({ cost: 2, consumption: 5 });
		const n = mutations.length;
		await run({ cost: 2, consumption: 5 });
		assert.equal(mutations.length, n);
		await run({ consumption: 7 });
		assert.equal(mutations.at(-1)[0], 'update');
		assert.equal(db.get(prefix + 'cost').val, 2);
		allowDelete = true;
		await run({ consumption: 7 });
		assert.deepEqual([...db.keys()], [prefix + 'consumption']);
		assert.deepEqual(mutations.at(-1), ['delete', prefix + 'cost']);
	});

	it('adopts an existing DB point after local retention instead of appending another value', async () => {
		let saved;
		const commands = [];
		await reconcile({
			ledger: {},
			values: { cost: 4 },
			ts: 1234,
			prefix: 'series.',
			mayExist: () => true,
			save: async entry => {
				saved = entry;
			},
			send: async (cmd, payload) => {
				commands.push(cmd);
				assert.equal(payload.id, 'series.cost');
				return {
					result: [
						{ ts: 1233, val: 1 },
						{ ts: 1234, val: 4 },
					],
				};
			},
		});
		assert.deepEqual(commands, ['getHistory']);
		assert.deepEqual(saved, { values: { cost: 4 } });
	});

	it('backfills retained closed Berlin days in batches independently per DB target and across both DST changes', async () => {
		const a = factory({});
		a.namespace = 'octopus-energy-monitor.0';
		a.config = { historyInstance: 'history.0', retentionDays: 0 };
		const states = {},
			objects = {},
			writes = [];
		const set = (id, val) => {
			const full = a.namespace + '.' + id;
			states[full] = { val };
			objects[full] ||= { type: 'state' };
		};
		for (let i = 1; i <= 31; i++)
			set('history.2026.03.' + String(i).padStart(2, '0') + '.octopus.dailyConsumption', i);
		set('history.2026.10.25.octopus.dailyConsumption', 2);
		set('history.2026.11.19.octopus.dailyConsumption', 5); // still open
		set('history.2026.10.26.inexogy.dailyConsumption', 4);
		set('history.2026.10.25.comparison.difference', 1);
		set('history.2026.10.25.octopus.gridFeeSchedule', 'unused');
		const reads = [];
		a.getForeignStatesAsync = async ids => {
			assert.ok(Array.isArray(ids));
			assert.ok(ids.every(id => Object.hasOwn(states, id) && !id.includes('*')));
			reads.push(ids);
			return Object.fromEntries(ids.map(id => [id, states[id]]));
		};
		a.setObjectNotExistsAsync = async (id, obj) => {
			objects[a.namespace + '.' + id] ||= obj;
		};
		a.writeStateObject = async (id, _name, val) => set(id, val);
		a.sendToAsync = async (target, cmd, payload) => {
			if (cmd === 'storeState') writes.push(...payload.map(row => [target, row.state.ts]));
			else assert.equal(cmd, 'enableHistory');
			return { success: true };
		};
		const run = () => exportDays(a, objects, new Date('2026-11-19T14:00Z'));
		await run();
		assert.equal(writes.length, 30);
		assert.equal(reads.length, 2); // October and March, one bulk read each
		assert.deepEqual(reads[0], [a.namespace + '.history.2026.10.25.octopus.dailyConsumption']);
		await run();
		assert.equal(writes.length, 32);
		await run();
		assert.equal(writes.length, 32);
		const times = writes.map(entry => entry[1]);
		for (const utc of ['2026-03-28T23:00Z', '2026-03-29T22:00Z', '2026-10-24T22:00Z'])
			assert.ok(times.includes(Date.parse(utc)));
		a.config.historyInstance = 'sql.0';
		a.config.retentionDays = 30;
		await run();
		assert.deepEqual(writes.at(-1), ['sql.0', Date.parse('2026-10-24T22:00Z')]);
		assert.equal(writes.length, 33);
		a.config.historyInstance = 'history.0';
		await run();
		assert.equal(writes.length, 33);
	});
});
