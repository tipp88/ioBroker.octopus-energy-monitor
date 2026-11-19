'use strict';

// Only these numeric series belong to the exporter, including during crash recovery.
const SERIES =
	/^(?:consumption|cost|tariff\.[a-z0-9_-]+\.(?:consumption|cost)|enwg\.(?:nt|st|ht)\.(?:consumption|costGross))$/;
const MARKER = 'dailyExportLedger';
const capabilityWarnings = new WeakMap();

/**
 * Project only graphable gross amounts and kWh from one stored Octopus day.
 *
 * @param {Record<string, unknown>} fields Leaf names and stored values
 * @param {boolean} enwgActive Whether §14a applies on that date
 */
function dailyValues(fields, enwgActive) {
	const values = {};
	if (!Number.isFinite(fields.dailyConsumption)) {
		return values;
	}
	const put = (id, value) => {
		if (Number.isFinite(value)) {
			values[id] = value;
		}
	};
	put('consumption', fields.dailyConsumption);
	const priced = fields.costAvailable !== false;
	if (priced && fields.totalCostAvailable !== false) {
		put('cost', fields.totalCost);
	}
	for (const [field, value] of Object.entries(fields)) {
		const match = /^([a-z0-9_-]+)(Consumption|Cost)$/.exec(field);
		if (!match || field === 'dailyConsumption' || field === 'totalCost') {
			continue;
		}
		const [, slot, metric] = match;
		if (metric === 'Cost' && !priced) {
			continue;
		}
		// EnWG fields have a net-cost sibling in the daily tree; it is never exported.
		const enwg = ['st', 'nt', 'ht'].includes(slot) && Object.hasOwn(fields, `${slot}CostNet`);
		if (enwg && (!enwgActive || fields.gridFeeSource === 'unavailable')) {
			continue;
		}
		put(
			`${enwg ? 'enwg' : 'tariff'}.${slot}.${metric === 'Consumption' ? 'consumption' : enwg ? 'costGross' : 'cost'}`,
			value,
		);
	}
	return values;
}

async function checked(send, command, message) {
	const reply = await send(command, message);
	if (
		reply?.success !== true ||
		reply.error ||
		reply.connected === false ||
		reply.sqlConnected === false ||
		(command === 'storeState' && reply.successCount !== undefined && reply.successCount !== message.length)
	) {
		throw new Error(`${command}: ${reply?.error || 'missing or incomplete database acknowledgement'}`);
	}
}

/**
 * Reconcile one day's values; persist pending keys before sending to survive partial writes or a lost reply.
 *
 * @param context Current day, checkpoint and backend operations
 */
async function reconcile(context) {
	const {
		ledger,
		values,
		ts,
		prefix,
		send,
		save,
		register,
		supports,
		unsupported,
		mayExist = _key => false,
	} = context;
	const known = { ...ledger.values };
	const pending = ledger.pending || [];
	for (const key of new Set([...Object.keys(known), ...pending, ...Object.keys(values)])) {
		if (!SERIES.test(key)) {
			throw new Error('Invalid daily export ledger key');
		}
	}
	// DB retention is independent of the local ledger. Re-created local days may
	// already have a point in previously registered series; adopt it, don't append it.
	const inspect = new Set([...pending, ...Object.keys(values).filter(key => !(key in known) && mayExist(key))]);
	for (const key of inspect) {
		const reply = await send('getHistory', {
			id: prefix + key,
			options: {
				start: ts - 1,
				end: ts + 1,
				aggregate: 'none',
				returnNewestEntries: false,
				removeBorderValues: true,
			},
		});
		if (reply?.error || !Array.isArray(reply?.result)) {
			throw new Error(`Cannot verify ${prefix}${key} at ${ts}: ${reply?.error || 'invalid history response'}`);
		}
		const entry = reply.result.find(row => row.ts === ts && Number.isFinite(row.val));
		if (entry) {
			known[key] = entry.val;
		} else {
			delete known[key];
		}
	}
	const operations = [];
	for (const key of new Set([...Object.keys(values), ...Object.keys(known)])) {
		if (known[key] === values[key]) {
			continue;
		}
		const command = values[key] === undefined ? 'delete' : known[key] === undefined ? 'storeState' : 'update';
		if (command !== 'storeState' && !(await supports(command))) {
			unsupported.add(command);
			continue;
		}
		operations.push({
			key,
			command,
			point: {
				id: prefix + key,
				state: command === 'delete' ? { ts } : { ts, val: values[key], ack: true, q: 0 },
			},
		});
	}
	if (!operations.length) {
		if (inspect.size) {
			await save({ values: known });
		}
		return 0;
	}
	for (const { key, command } of operations) {
		if (command !== 'delete') {
			await register(key);
		}
	}
	await save({ values: known, pending: operations.map(op => op.key) });
	const inserts = operations.filter(op => op.command === 'storeState').map(op => op.point);
	if (inserts.length) {
		await checked(send, 'storeState', inserts);
	}
	for (const { key, command, point } of operations) {
		if (command !== 'storeState') {
			await checked(send, command, point);
		}
		if (command === 'delete') {
			delete known[key];
		} else {
			known[key] = values[key];
		}
	}
	await save({ values: known });
	return operations.length;
}

/**
 * Export only persisted daily states. No API access or pricing code on this path.
 *
 * @param adapter Running adapter
 * @param objects Current adapter object snapshot
 * @param {Date} [now] Clock reference for cutoff dates
 */
async function exportDays(adapter, objects, now = new Date()) {
	const target = adapter.config.historyInstance;
	const prefix = `${adapter.namespace}.history.`;
	const today = adapter.getBerlinDay(now).date;
	const retention = Number(adapter.config.retentionDays);
	const earliest = retention > 0 ? adapter.getBerlinDay(now, -retention).date : '';
	const dates = new Set();
	for (const id of Object.keys(objects)) {
		if (!id.startsWith(prefix)) {
			continue;
		}
		const match = /^(\d{4})\.(\d\d)\.(\d\d)\.octopus\.(?:dailyConsumption|dailyExportLedger)$/.exec(
			id.slice(prefix.length),
		);
		if (match) {
			const date = match.slice(1).join('-');
			if (date < today && date >= earliest) {
				dates.add(date);
			}
		}
	}
	const send = (command, payload) => {
		if (adapter.stopping) {
			throw new Error('Adapter stopping');
		}
		return adapter.sendToAsync(target, command, payload, { timeout: 30000 });
	};
	const registered = new Set();
	const register = async key => {
		if (registered.has(key)) {
			return;
		}
		const id = `octopus.daily.${key}`;
		const full = `${adapter.namespace}.${id}`;
		if (!objects[full]) {
			await adapter.setObjectNotExistsAsync(id, {
				type: 'state',
				common: {
					name: `Octopus daily ${key}`,
					type: 'number',
					role: 'value',
					unit: key.endsWith('consumption') ? 'kWh' : '€',
					read: true,
					write: false,
				},
				native: {},
			});
		}
		if (!objects[full]?.common?.custom?.[target]?.enabled) {
			await checked(send, 'enableHistory', {
				id: full,
				options: { changesOnly: false, debounce: 0, changesRelogInterval: 0 },
			});
		}
		registered.add(key);
	};
	let features;
	const supports = async cmd => {
		if (!features) {
			const reply = await send('features', {});
			if (!Array.isArray(reply?.supportedFeatures)) {
				throw new Error('Missing backend feature list');
			}
			features = reply.supportedFeatures;
		}
		return features.includes(cmd);
	};
	const unsupported = new Set();
	let month,
		fieldsByDay = new Map(),
		dirtyDays = 0,
		points = 0;
	for (const date of [...dates].sort().reverse()) {
		if (adapter.stopping || dirtyDays >= 30) {
			break;
		}
		const dotted = date.replace(/-/g, '.');
		if (month !== dotted.slice(0, 7)) {
			month = dotted.slice(0, 7);
			const monthPrefix = `${prefix + month}.`;
			const states = await adapter.getForeignStatesAsync(`${monthPrefix}*.octopus.*`);
			fieldsByDay = new Map();
			for (const [id, state] of Object.entries(states)) {
				const m = /^(\d\d)\.octopus\.([^.]+)$/.exec(id.slice(monthPrefix.length));
				if (!m || !state) {
					continue;
				}
				if (!fieldsByDay.has(m[1])) {
					fieldsByDay.set(m[1], Object.create(null));
				}
				fieldsByDay.get(m[1])[m[2]] = state.val;
			}
		}
		const base = `history.${dotted}.octopus.`;
		const fields = fieldsByDay.get(dotted.slice(-2));
		if (!fields) {
			continue;
		}
		const journal = fields[MARKER] ? JSON.parse(fields[MARKER]) : {};
		const { start } = adapter.getBerlinDay(new Date(`${date}T12:00:00Z`));
		const count = await reconcile({
			values: dailyValues(fields, adapter.isEnwgActiveForDate(start, adapter.config)),
			ledger: journal[target] || {},
			ts: start.getTime(),
			prefix: `${adapter.namespace}.octopus.daily.`,
			send,
			register,
			mayExist: key => !!objects[`${adapter.namespace}.octopus.daily.${key}`]?.common?.custom?.[target]?.enabled,
			supports,
			unsupported,
			save: async entry => {
				journal[target] = entry;
				await adapter.writeStateObject(
					base + MARKER,
					'Daily database export checkpoint',
					JSON.stringify(journal),
					'json',
					'string',
				);
			},
		});
		if (count) {
			dirtyDays++;
			points += count;
		}
	}
	const warning = unsupported.size ? `${target}:${[...unsupported].sort().join(', ')}` : '';
	if (warning && warning !== capabilityWarnings.get(adapter)) {
		adapter.log.warn(
			`Daily export: ${target} does not support ${[...unsupported].join(', ')}; affected historical points remain unchanged.`,
		);
	}
	capabilityWarnings.set(adapter, warning);
	if (points) {
		adapter.log.info(`Exported ${points} Octopus daily values for ${dirtyDays} day(s) to ${target}.`);
	}
}

module.exports = { dailyValues, reconcile, exportDays };
