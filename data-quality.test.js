'use strict';
const { expect } = require('chai');
const { intervalQuality } = require('./lib/data-quality');
const factory = require('./main');

describe('Interval quality diagnostics', () => {
	for (const hours of [23, 24, 25]) {
		it(`accepts a complete ${hours}-hour day, including genuine zero intervals`, () => {
			const start = new Date('2026-01-01T00:00:00Z');
			const end = new Date(start.getTime() + hours * 3600000);
			const intervals = Array.from({ length: hours * 4 }, (_, i) => ({
				ts: start.getTime() + i * 900000,
				val: 0,
			}));
			expect(intervalQuality(intervals, start, end)).to.include({
				expected: hours * 4,
				received: hours * 4,
				complete: true,
				missing: 0,
			});
		});
	}
	it('does not count duplicates or malformed intervals as missing quarter hours', () => {
		const start = new Date(0),
			end = new Date(3600000);
		const quality = intervalQuality(
			[
				{ ts: 0, val: 1 },
				{ ts: 0, val: 2 },
				{ ts: 900000, end: 2700000, val: 1 },
				{ ts: 2700000, val: NaN },
			],
			start,
			end,
		);
		expect(quality).to.include({
			expected: 4,
			received: 1,
			duplicates: 1,
			conflicts: 1,
			invalid: 2,
			missing: 3,
			complete: false,
		});
	});
	it('sanitizes API diagnostics and only publishes enabled sources', async () => {
		const a = factory({});
		a.config = {};
		a.hasOctopus = true;
		a.hasInexogy = false;
		const writes = new Map();
		a.writeStateObject = async (id, _name, value) => writes.set(id, value);
		a.recordApiStatus('octopus', {
			status: 200,
			data: { errors: [{ message: 'secret account', extensions: { errorCode: 'KT-CT-1199' } }] },
		});
		await a.writeDiagnostics(false);
		expect(writes.get('info.api.octopus.lastError')).to.equal('KT-CT-1199');
		expect([...writes.keys()].some(id => id.includes('inexogy'))).to.equal(false);
		expect(writes.get('info.sync.running')).to.equal(false);
		expect(writes.get('info.sync.nextRun')).to.be.greaterThan(Date.now());
		a.recordApiStatus('octopus', { status: 200, data: { data: {} } });
		expect(a.apiStatus.octopus.lastError).to.equal('');
		expect(a.apiStatus.octopus.lastSuccess).to.be.greaterThan(0);
	});
	it('clears the running flag even when synchronization fails', async () => {
		const a = factory({});
		a.config = {};
		const flags = [];
		a.writeDiagnostics = async running => flags.push(running);
		a.performSync = async () => {
			throw new Error('failed');
		};
		await expect(a.syncData()).to.be.rejectedWith('failed');
		expect(flags).to.deep.equal([true, false]);
		expect(a.activeSync).to.equal(null);
	});
});
