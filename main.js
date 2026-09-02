'use strict';
const utils = require('@iobroker/adapter-core');
const axios = require('axios');

const AXIOS_TIMEOUT = 30000;

class EnergyCompare extends utils.Adapter {
	constructor(options) {
		super({ ...options, name: 'octopus-energy-monitor' });
		this.on('ready', this.onReady.bind(this));
		this.on('unload', this.onUnload.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.syncInterval = null;
		this.masterData = null;
		this.octopusAuthToken = null;
		this.inexogyMeterId = null;
	}

	sanitizeIdSegment(raw) {
		return String(raw).replace(/[^a-zA-Z0-9-_]/g, '_');
	}

	async onReady() {
		this.log.info('Starting Octopus Energy Monitor Adapter');

		this.hasOctopus = !!(this.config.octopusEmail && this.config.octopusPassword);
		this.hasInexogy = !!(this.config.inexogyEmail && this.config.inexogyPassword);

		if (!this.hasOctopus) {
			this.log.warn('Octopus credentials missing. Adapter requires at least Octopus credentials.');
			return;
		}

		if (!this.hasInexogy) {
			this.log.info('Inexogy credentials missing. Adapter will run in standalone mode (Octopus only).');
		}

		// Validate §14a EnWG configuration
		const validation = this.validateEnwgConfig(this.config);
		if (!validation.valid) {
			this.log.error(
				`§14a EnWG configuration is invalid: ${validation.error}. Disabling EnWG price calculations!`,
			);
			this.enwgEnabled = false;
		} else {
			this.enwgEnabled = this.config.enwgEnabled;
			if (this.enwgEnabled && !/^\d{4}-\d{2}-\d{2}$/.test(this.config.enwgStartDate)) {
				this.log.error(
					'§14a EnWG start date is invalid (must be YYYY-MM-DD). Disabling EnWG price calculations!',
				);
				this.enwgEnabled = false;
			}
		}

		await this.cleanupLegacyHistory();
		await this.setupObjects();

		this.enwgConfigChanged = false;
		if (this.enwgEnabled) {
			const currentHashObj = {
				enabled: this.config.enwgEnabled,
				startDate: this.config.enwgStartDate,
				gridFeeNt: this.config.enwgGridFeeNt,
				gridFeeSt: this.config.enwgGridFeeSt,
				gridFeeHt: this.config.enwgGridFeeHt,
				gridFeesAreGross: this.config.enwgGridFeesAreGross,
				timeWindows: this.config.enwgTimeWindows,
			};
			const currentHash = JSON.stringify(currentHashObj);
			const storedHashState = await this.getStateAsync('octopus.info.enwgConfigHash');
			if (!storedHashState || storedHashState.val !== currentHash) {
				this.log.info(
					'§14a EnWG settings changed or not initialized. Forcing retroactive recalculation of history data.',
				);
				this.enwgConfigChanged = true;
				await this.setStateAsync('octopus.info.enwgConfigHash', { val: currentHash, ack: true });
			}
		}

		const MAX_INTERVAL_MS = 2147483647;
		const intervalMinutes = Math.max(
			15,
			Math.min(Number(this.config.updateInterval) || 60, Math.floor(MAX_INTERVAL_MS / 60000)),
		);
		this.log.info(`Scheduling data sync every ${intervalMinutes} minutes.`);

		const scheduleNextSync = () => {
			this.syncInterval = this.setTimeout(
				async () => {
					await this.syncData();
					scheduleNextSync();
				},
				intervalMinutes * 60 * 1000,
			);
		};

		this.subscribeStates('octopus.devices.*.smartChargeActive');
		this.subscribeStates('octopus.devices.*.refresh');

		this.syncTimeout = this.setTimeout(async () => {
			await this.syncData();
			scheduleNextSync();
		}, 5000);
	}

	async cleanupLegacyHistory(adapterObjects) {
		const objects = adapterObjects || (await this.getAdapterObjectsAsync());
		this.log.debug('Checking for legacy history.YYYY-MM-DD objects...');
		const historyPrefix = `${this.namespace}.history.`;
		for (const id of Object.keys(objects)) {
			if (id.startsWith(historyPrefix)) {
				const relativeId = id.substring(historyPrefix.length);
				const datePart = relativeId.split('.')[0];
				if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
					this.log.info(`Deleting legacy history object: ${id}`);
					await this.delObjectAsync(id.substring(this.namespace.length + 1));
				}
			}
		}
	}

	async setupObjects() {
		await this.setObjectNotExistsAsync('history', {
			type: 'device',
			common: { name: 'Energy History' },
			native: {},
		});
		await this.setObjectNotExistsAsync('octopus', {
			type: 'device',
			common: { name: 'Octopus Energy' },
			native: {},
		});
		await this.setObjectNotExistsAsync('octopus.info', {
			type: 'channel',
			common: { name: 'Octopus Master Data' },
			native: {},
		});
		await this.setObjectNotExistsAsync('octopus.info.rates', {
			type: 'channel',
			common: { name: 'Octopus Rates' },
			native: {},
		});
		await this.setObjectNotExistsAsync('octopus.currentMonth', {
			type: 'channel',
			common: { name: 'Current Month Aggregation' },
			native: {},
		});
		await this.setObjectNotExistsAsync('octopus.periods', {
			type: 'channel',
			common: { name: 'Billing Periods' },
			native: {},
		});
		await this.setObjectNotExistsAsync('octopus.periods.current', {
			type: 'channel',
			common: { name: 'Current Billing Period' },
			native: {},
		});

		// Clean up legacy currentPeriod/lastPeriod objects
		const legacyPeriodStates = [
			'octopus.currentPeriod.startDate',
			'octopus.currentPeriod.endDate',
			'octopus.currentPeriod.totalConsumption',
			'octopus.currentPeriod.totalCost',
			'octopus.currentPeriod',
			'octopus.lastPeriod.startDate',
			'octopus.lastPeriod.endDate',
			'octopus.lastPeriod.totalConsumption',
			'octopus.lastPeriod.totalCost',
			'octopus.lastPeriod',
		];
		for (const stateId of legacyPeriodStates) {
			await this.delObjectAsync(stateId);
		}

		await this.setObjectNotExistsAsync('octopus.historyJson', {
			type: 'state',
			common: {
				name: 'Octopus Consumption History (JSON Array)',
				type: 'string',
				role: 'json',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('octopus.info.enwgConfigHash', {
			type: 'state',
			common: {
				name: 'EnWG Config Hash',
				type: 'string',
				role: 'text',
				read: true,
				write: false,
			},
			native: {},
		});

		if (this.enwgEnabled) {
			await this.setObjectNotExistsAsync('octopus.info.enwg', {
				type: 'channel',
				common: { name: '§14a EnWG Info' },
				native: {},
			});
			const fees = this.getEnwgGridFees(this.config);
			await this.writeStateObject(
				'octopus.info.enwg.gridFeeStNet',
				'ST Grid Fee Net',
				fees.ST.net,
				'value',
				'number',
				'€/kWh',
			);
			await this.writeStateObject(
				'octopus.info.enwg.gridFeeStGross',
				'ST Grid Fee Gross',
				fees.ST.gross,
				'value',
				'number',
				'€/kWh',
			);
			await this.writeStateObject(
				'octopus.info.enwg.gridFeeNtNet',
				'NT Grid Fee Net',
				fees.NT.net,
				'value',
				'number',
				'€/kWh',
			);
			await this.writeStateObject(
				'octopus.info.enwg.gridFeeNtGross',
				'NT Grid Fee Gross',
				fees.NT.gross,
				'value',
				'number',
				'€/kWh',
			);
			await this.writeStateObject(
				'octopus.info.enwg.gridFeeHtNet',
				'HT Grid Fee Net',
				fees.HT.net,
				'value',
				'number',
				'€/kWh',
			);
			await this.writeStateObject(
				'octopus.info.enwg.gridFeeHtGross',
				'HT Grid Fee Gross',
				fees.HT.gross,
				'value',
				'number',
				'€/kWh',
			);
		}

		if (this.config.enableHistorySync && this.config.historyInstance) {
			await this.setObjectNotExistsAsync('octopus.info.15MinConsumption', {
				type: 'state',
				common: {
					name: 'Octopus 15-Min Consumption',
					type: 'number',
					role: 'value',
					unit: 'kWh',
					read: true,
					write: false,
				},
				native: {},
			});
			await this.setObjectNotExistsAsync('inexogy.info.15MinConsumption', {
				type: 'state',
				common: {
					name: 'Inexogy 15-Min Consumption',
					type: 'number',
					role: 'value',
					unit: 'kWh',
					read: true,
					write: false,
				},
				native: {},
			});
			// Optionally send enableHistory command just to be safe if the custom attribute is not caught initially
			try {
				await this.sendToAsync(this.config.historyInstance, 'enableHistory', {
					id: `${this.namespace}.octopus.info.15MinConsumption`,
					options: { changesOnly: false, debounce: 0, retention: 0, changesRelayout: false },
				});
				await this.sendToAsync(this.config.historyInstance, 'enableHistory', {
					id: `${this.namespace}.inexogy.info.15MinConsumption`,
					options: { changesOnly: false, debounce: 0, retention: 0, changesRelayout: false },
				});
			} catch (e) {
				this.log.debug(`Could not auto-enable history via sendTo: ${e.message}`);
			}
		}

		if (!this.enwgEnabled) {
			await this.delObjectAsync('octopus.info.enwg.gridFeeStNet');
			await this.delObjectAsync('octopus.info.enwg.gridFeeStGross');
			await this.delObjectAsync('octopus.info.enwg.gridFeeNtNet');
			await this.delObjectAsync('octopus.info.enwg.gridFeeNtGross');
			await this.delObjectAsync('octopus.info.enwg.gridFeeHtNet');
			await this.delObjectAsync('octopus.info.enwg.gridFeeHtGross');
			await this.delObjectAsync('octopus.info.enwg');
		}

		if (this.config.inexogyEmail) {
			await this.setObjectNotExistsAsync('inexogy', {
				type: 'device',
				common: { name: 'Inexogy Smart Meter' },
				native: {},
			});

			await this.setObjectNotExistsAsync('inexogy.info', {
				type: 'channel',
				common: { name: 'Inexogy Master Data' },
				native: {},
			});

			await this.setObjectNotExistsAsync('inexogy.historyJson', {
				type: 'state',
				common: {
					name: 'Inexogy Consumption History (JSON Array)',
					type: 'string',
					role: 'json',
					read: true,
					write: false,
				},
				native: {},
			});
		}
	}

	/**
	 * @param {string} id Object ID
	 * @param {string} name Object Name
	 * @param {any} value State Value
	 * @param {string} [role] State Role
	 * @param {ioBroker.CommonType} [type] State Type
	 * @param {string} [unit] State Unit
	 */
	async writeStateObject(id, name, value, role = 'value', type = 'number', unit = '') {
		if (!unit) {
			if (role.includes('power') || name.includes('Consumption') || name.includes('Difference')) {
				unit = 'kWh';
			} else if (name.includes('Cost') || name.includes('Balance')) {
				unit = '€';
			}
		}
		await this.setObjectNotExistsAsync(id, {
			type: 'state',
			common: { name, type, role, unit, read: true, write: false },
			native: {},
		});
		await this.setStateAsync(id, { val: value, ack: true });
	}

	async writeMasterDataStates(data) {
		await this.writeStateObject('octopus.info.balance', 'Account Balance', data.balance, 'value', 'number', '€');
		await this.writeStateObject('octopus.info.tariffName', 'Tariff Name', data.tariffName, 'text', 'string');
		await this.writeStateObject(
			'octopus.info.isTimeOfUse',
			'Is Time Of Use Tariff',
			data.isTimeOfUse,
			'indicator',
			'boolean',
		);
		await this.writeStateObject('octopus.info.meterNumber', 'Meter Number', data.meterNumber, 'text', 'string');
		await this.writeStateObject('octopus.info.mopName', 'Metering Point Operator', data.mopName, 'text', 'string');
		await this.writeStateObject(
			'octopus.info.dnoName',
			'Distribution Network Operator',
			data.dnoName,
			'text',
			'string',
		);
		await this.writeStateObject(
			'octopus.info.monthlyStandingCharge',
			'Monthly Standing Charge',
			data.monthlyStandingCharge || 0,
			'value',
			'number',
			'€',
		);

		for (const rate of data.rates) {
			await this.writeStateObject(
				`octopus.info.rates.${this.sanitizeIdSegment(rate.name).toLowerCase()}`,
				`Rate ${rate.name} (€/kWh)`,
				parseFloat(rate.rateEuros.toFixed(4)),
				'value',
				'number',
				'€/kWh',
			);
		}
	}

	async fetchOctopusMasterData(retry = true) {
		try {
			const apiDomain = 'https://api.oeg-kraken.energy/v1/graphql/';

			if (!this.octopusAuthToken) {
				const authPayload = {
					query: `mutation obtainKrakenToken($input: ObtainJSONWebTokenInput!) {
						obtainKrakenToken(input: $input) { token }
					}`,
					variables: { input: { email: this.config.octopusEmail, password: this.config.octopusPassword } },
				};
				const authRes = await axios.post(apiDomain, authPayload, {
					headers: { 'Content-Type': 'application/json' },
					timeout: AXIOS_TIMEOUT,
				});
				const token = authRes.data?.data?.obtainKrakenToken?.token;
				if (!token) {
					throw new Error('Octopus Login failed.');
				}
				this.octopusAuthToken = token;
			}

			const masterDataPayload = {
				query: `query MyQuery($accountNumber: String!) {
					account(accountNumber: $accountNumber) {
						properties {
							id
							electricityMalos {
								agreements {
									id
									isActive
									product { displayName isTimeOfUse fullName }
									unitRateInformation {
										... on SimpleProductUnitRateInformation {
											__typename latestGrossUnitRateCentsPerKwh
										}
										... on TimeOfUseProductUnitRateInformation {
											__typename
											rates {
												latestGrossUnitRateCentsPerKwh
												timeslotName
												timeslotActivationRules { activeFromTime activeToTime }
											}
										}
									}
								}
								meters { id number }
								mop { name }
								dno { name }
							}
						}
						electricityBalance
					}
				}`,
				variables: { accountNumber: this.config.octopusAccount },
			};

			const dataRes = await axios.post(apiDomain, masterDataPayload, {
				headers: { 'Content-Type': 'application/json', Authorization: this.octopusAuthToken },
				validateStatus: () => true,
				timeout: AXIOS_TIMEOUT,
			});

			if (dataRes.status !== 200 || !dataRes.data?.data?.account) {
				if (retry) {
					this.log.debug('Token might be expired, retrying login...');
					this.octopusAuthToken = null;
					return await this.fetchOctopusMasterData(false);
				}
				throw new Error(
					`Master data fetch failed: ${
						dataRes.data?.errors ? JSON.stringify(dataRes.data.errors) : dataRes.statusText
					}`,
				);
			}

			const account = dataRes.data.data.account;
			const properties = account.properties || [];
			if (properties.length === 0) {
				throw new Error('No properties found');
			}

			const prop = properties[0];
			const propertyId = prop.id;
			const malo = prop.electricityMalos?.[0];
			if (!malo) {
				throw new Error('No electricityMalos found');
			}

			const activeAgreement = malo.agreements?.find(a => a.isActive);
			if (!activeAgreement) {
				throw new Error('No active agreement found');
			}
			this.log.debug(`Active agreement found: ${JSON.stringify(activeAgreement)}`);

			let rates = [];
			if (activeAgreement.unitRateInformation.__typename === 'TimeOfUseProductUnitRateInformation') {
				rates = activeAgreement.unitRateInformation.rates.map(r => ({
					name: r.timeslotName,
					rateEuros: parseFloat(r.latestGrossUnitRateCentsPerKwh) / 100,
					from: r.timeslotActivationRules[0]?.activeFromTime,
					to: r.timeslotActivationRules[0]?.activeToTime,
				}));
			} else {
				rates = [
					{
						name: 'STANDARD',
						rateEuros: parseFloat(activeAgreement.unitRateInformation.latestGrossUnitRateCentsPerKwh) / 100,
						from: '00:00:00',
						to: '24:00:00',
					},
				];
			}

			let standingChargeEuros = 0;
			const agreementId = activeAgreement.id;
			this.log.debug(`Active agreement ID: ${agreementId}`);
			if (agreementId) {
				const standingChargePayload = {
					query: `query AgreementQuery($id: ID!) {
						agreement(id: $id) {
							monthlyStandingCharge
						}
					}`,
					variables: { id: agreementId },
				};
				this.log.debug(`Fetching standing charge for agreement ID ${agreementId}...`);
				try {
					const scRes = await axios.post(apiDomain, standingChargePayload, {
						headers: { 'Content-Type': 'application/json', Authorization: this.octopusAuthToken },
						validateStatus: () => true,
						timeout: AXIOS_TIMEOUT,
					});
					this.log.debug(
						`Standing charge API response status: ${scRes.status}, data: ${JSON.stringify(scRes.data)}`,
					);
					if (scRes.status === 200 && scRes.data?.data?.agreement) {
						const scVal = scRes.data.data.agreement.monthlyStandingCharge;
						this.log.debug(`Raw monthlyStandingCharge from API: ${scVal}`);
						if (scVal !== null && scVal !== undefined) {
							const parsedSc = parseFloat(scVal);
							if (parsedSc > 100) {
								standingChargeEuros = parsedSc / 100;
							} else {
								standingChargeEuros = parsedSc;
							}
						}
					} else {
						this.log.warn(
							`Failed to fetch standing charge: ${scRes.data?.errors ? JSON.stringify(scRes.data.errors) : scRes.statusText}`,
						);
					}
				} catch (err) {
					this.log.error(`Error querying standing charge: ${err.message}`);
				}
			}
			this.log.debug(`Resolved monthly standing charge in Euros: ${standingChargeEuros}`);

			const masterData = {
				balance: account.electricityBalance ? parseFloat(account.electricityBalance) / 100 : 0,
				propertyId: propertyId,
				tariffName: activeAgreement.product?.displayName || 'Unknown',
				isTimeOfUse: activeAgreement.product?.isTimeOfUse || false,
				meterNumber: malo.meters?.[0]?.number || 'Unknown',
				meterId: malo.meters?.[0]?.id || '',
				mopName: malo.mop?.name || 'Unknown',
				dnoName: malo.dno?.name || 'Unknown',
				rates: rates,
				monthlyStandingCharge: standingChargeEuros,
			};

			if (this.config.splitGoTariff && masterData.rates.length === 1) {
				const baseRate = masterData.rates[0].rateEuros;
				masterData.rates = [
					{ name: 'GO', rateEuros: baseRate, from: '00:00:00', to: '05:00:00' },
					{ name: 'STANDARD', rateEuros: baseRate, from: '05:00:00', to: '24:00:00' },
				];
				masterData.isTimeOfUse = true;
			}

			this.masterData = masterData;
			await this.writeMasterDataStates(masterData);
			this.log.debug('Octopus master data fetched and updated.');
			return masterData;
		} catch (error) {
			this.log.error(`Failed to fetch master data: ${error.message}`);
			return null;
		}
	}

	async fetchOctopusMeterReadings() {
		try {
			if (!this.masterData || !this.masterData.meterId) {
				return null;
			}

			const apiDomain = 'https://api.oeg-kraken.energy/v1/graphql/';
			const currentYear = new Date().getFullYear();
			const readFrom = `${currentYear}-01-01T00:00:00Z`;

			const readingsPayload = {
				query: `query MyQuery($accountNumber: String!, $meterId: ID!, $readFrom: DateTime!) {
					electricityMeterReadings(
						meterId: $meterId
						accountNumber: $accountNumber
						last: 100
						readFrom: $readFrom
					) {
						edges {
							node {
								value
								readAt
								typeOfRead
								status
							}
						}
					}
				}`,
				variables: {
					accountNumber: this.config.octopusAccount,
					meterId: this.masterData.meterId,
					readFrom: readFrom,
				},
			};

			const dataRes = await axios.post(apiDomain, readingsPayload, {
				headers: { 'Content-Type': 'application/json', Authorization: this.octopusAuthToken },
				validateStatus: () => true,
				timeout: AXIOS_TIMEOUT,
			});

			if (dataRes.status !== 200 || !dataRes.data?.data?.electricityMeterReadings) {
				this.log.warn(
					`Octopus readings API returned status ${dataRes.status}: ${JSON.stringify(dataRes.data)}`,
				);
				return null;
			}

			const edges = dataRes.data.data.electricityMeterReadings.edges;
			if (!edges || edges.length === 0) {
				return null;
			}

			// Sort by readAt descending to find the latest
			const readings = edges
				.map(e => ({
					value: parseFloat(e.node.value),
					readAt: new Date(e.node.readAt),
				}))
				.sort((a, b) => b.readAt.getTime() - a.readAt.getTime());

			return readings[0];
		} catch (error) {
			this.log.error(`Octopus meter readings fetch error: ${error.message}`);
			return null;
		}
	}

	timeStrToHours(timeStr) {
		if (!timeStr) {
			return 0;
		}
		const parts = timeStr.split(':');
		return parseInt(parts[0], 10) + parseInt(parts[1] || 0, 10) / 60;
	}

	validateEnwgConfig(config) {
		if (!config.enwgEnabled) {
			return { valid: true };
		}

		const windows = config.enwgTimeWindows || [];
		if (windows.length === 0) {
			return { valid: false, error: 'No time windows configured.' };
		}

		for (let month = 1; month <= 12; month++) {
			const slots = new Array(96).fill(null); // 96 slots of 15 minutes
			for (let idx = 0; idx < windows.length; idx++) {
				const win = windows[idx];
				let monthsActive = [];
				const mStr = (win.months || '').trim();
				if (!mStr || mStr === '*' || mStr.toLowerCase() === 'all') {
					monthsActive = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
				} else {
					monthsActive = mStr
						.split(',')
						.map(m => parseInt(m.trim(), 10))
						.filter(m => !isNaN(m));
				}

				if (!monthsActive.includes(month)) {
					continue;
				}

				const startParts = (win.startTime || '00:00').split(':');
				const endParts = (win.endTime || '24:00').split(':');
				const fromMin = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1] || 0, 10);
				let toMin = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1] || 0, 10);

				if (win.endTime === '24:00') {
					toMin = 1440;
				}

				// Mark slots
				for (let slot = 0; slot < 96; slot++) {
					const slotMinStart = slot * 15;
					let inWindow = false;
					if (fromMin < toMin) {
						inWindow = slotMinStart >= fromMin && slotMinStart < toMin;
					} else if (fromMin > toMin) {
						inWindow = slotMinStart >= fromMin || slotMinStart < toMin;
					}

					if (inWindow) {
						if (slots[slot] !== null) {
							return {
								valid: false,
								error: `Overlap detected in month ${month} at ${Math.floor(slotMinStart / 60)
									.toString()
									.padStart(
										2,
										'0',
									)}:${(slotMinStart % 60).toString().padStart(2, '0')} between row ${slots[slot] + 1} and row ${idx + 1}.`,
							};
						}
						slots[slot] = idx;
					}
				}
			}
		}

		return { valid: true };
	}

	/**
	 * Calculates the start and end Date objects (local time) for the billing period containing the given date.
	 *
	 * @param {Date} date Reference date
	 * @param {number} startDay Start day of the billing period (1 to 28)
	 * @returns {{start: Date, end: Date}} Calculated period start and end dates
	 */
	getPeriodDates(date, startDay) {
		const year = date.getFullYear();
		const month = date.getMonth();
		let start, end;
		if (date.getDate() >= startDay) {
			start = new Date(year, month, startDay);
			end = new Date(year, month + 1, startDay - 1);
		} else {
			start = new Date(year, month - 1, startDay);
			end = new Date(year, month, startDay - 1);
		}
		start.setHours(0, 0, 0, 0);
		end.setHours(23, 59, 59, 999);
		return { start, end };
	}

	getEnwgTariffForTime(date, config) {
		const month = date.getMonth() + 1; // 1-12
		const checkMin = date.getHours() * 60 + date.getMinutes();

		const windows = config.enwgTimeWindows || [];
		for (const win of windows) {
			// Parse months
			let monthsActive = [];
			const mStr = (win.months || '').trim();
			if (!mStr || mStr === '*' || mStr.toLowerCase() === 'all') {
				monthsActive = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
			} else {
				monthsActive = mStr
					.split(',')
					.map(m => parseInt(m.trim(), 10))
					.filter(m => !isNaN(m));
			}

			if (!monthsActive.includes(month)) {
				continue;
			}

			// Parse start and end times
			const startParts = (win.startTime || '00:00').split(':');
			const endParts = (win.endTime || '24:00').split(':');
			const fromMin = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1] || 0, 10);
			let toMin = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1] || 0, 10);

			if (win.endTime === '24:00') {
				toMin = 1440;
			}

			let inWindow = false;
			if (fromMin < toMin) {
				inWindow = checkMin >= fromMin && checkMin < toMin;
			} else if (fromMin > toMin) {
				inWindow = checkMin >= fromMin || checkMin < toMin;
			}

			if (inWindow) {
				return win.tariff; // 'NT', 'ST', or 'HT'
			}
		}

		// Fallback to ST if no window matches
		return 'ST';
	}

	getTariffSegmentsForDay(date, config) {
		const segments = {
			NT: [{ fromMin: 0, toMin: 0 }],
			ST: [{ fromMin: 0, toMin: 0 }],
			HT: [{ fromMin: 0, toMin: 0 }],
		};
		segments.NT.length = 0;
		segments.ST.length = 0;
		segments.HT.length = 0;
		let currentTariff = null;
		let segmentStartMin = 0;

		for (let i = 0; i <= 96; i++) {
			let W = null;
			if (i < 96) {
				// Get tariff for this 15-min slot
				const checkDate = new Date(date);
				const mins = i * 15;
				checkDate.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
				W = this.getEnwgTariffForTime(checkDate, config);
			}

			if (W !== currentTariff) {
				if (currentTariff !== null) {
					segments[currentTariff].push({
						fromMin: segmentStartMin,
						toMin: i * 15,
					});
				}
				currentTariff = W;
				segmentStartMin = i * 15;
			}
		}
		return segments;
	}

	isEnwgActiveForDate(date, config) {
		if (!this.enwgEnabled || !config.enwgStartDate) {
			return false;
		}
		// Parse enwgStartDate: YYYY-MM-DD
		const parts = config.enwgStartDate.split('-');
		if (parts.length !== 3) {
			return false;
		}
		const startYear = parseInt(parts[0], 10);
		const startMonth = parseInt(parts[1], 10) - 1;
		const startDay = parseInt(parts[2], 10);
		const startDate = new Date(startYear, startMonth, startDay, 0, 0, 0, 0);

		const checkDate = new Date(date);
		checkDate.setHours(0, 0, 0, 0);

		return checkDate >= startDate;
	}

	parseConfigNumber(val) {
		if (typeof val === 'number') {
			return val;
		}
		if (typeof val === 'string') {
			const cleaned = val.replace(',', '.').trim();
			const parsed = parseFloat(cleaned);
			return isNaN(parsed) ? 0 : parsed;
		}
		return 0;
	}

	getEnwgGridFees(config) {
		const isGross = !!config.enwgGridFeesAreGross;
		const feeSt = this.parseConfigNumber(config.enwgGridFeeSt);
		const feeNt = this.parseConfigNumber(config.enwgGridFeeNt);
		const feeHt = this.parseConfigNumber(config.enwgGridFeeHt);

		return {
			ST: {
				net: isGross ? feeSt / 1.19 : feeSt,
				gross: isGross ? feeSt : feeSt * 1.19,
			},
			NT: {
				net: isGross ? feeNt / 1.19 : feeNt,
				gross: isGross ? feeNt : feeNt * 1.19,
			},
			HT: {
				net: isGross ? feeHt / 1.19 : feeHt,
				gross: isGross ? feeHt : feeHt * 1.19,
			},
		};
	}

	async fetchOctopus(start, _end) {
		try {
			if (!this.masterData) {
				return null;
			}
			const enwgActive = this.isEnwgActiveForDate(start, this.config);
			const fees = enwgActive ? this.getEnwgGridFees(this.config) : null;
			const isSplit = (this.masterData.isTimeOfUse && this.masterData.rates.length > 1) || enwgActive;

			const fetchRaw = isSplit || this.config.enableHistorySync;

			const apiDomain = 'https://api.oeg-kraken.energy/v1/graphql/';
			const dateString = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;

			const usagePayload = {
				query: `query getSmartMeterUsage($accountNumber: String!, $propertyId: ID!, $date: Date!) {
					account(accountNumber: $accountNumber) {
						property(id: $propertyId) {
							measurements(
								utilityFilters: {electricityFilters: {readingFrequencyType: ${fetchRaw ? 'RAW_INTERVAL' : 'DAY_INTERVAL'}, readingQuality: ACTUAL}}
								startOn: $date
								first: ${fetchRaw ? 150 : 1}
							) {
								edges { node { ... on IntervalMeasurementType { endAt startAt value } } }
							}
						}
					}
				}`,
				variables: {
					accountNumber: this.config.octopusAccount,
					propertyId: this.masterData.propertyId,
					date: dateString,
				},
			};

			const dataRes = await axios.post(apiDomain, usagePayload, {
				headers: { 'Content-Type': 'application/json', Authorization: this.octopusAuthToken },
				validateStatus: () => true,
				timeout: AXIOS_TIMEOUT,
			});

			if (dataRes.status !== 200 || !dataRes.data?.data?.account) {
				return null;
			}

			const edges = dataRes.data.data.account.property?.measurements?.edges;
			if (!edges || edges.length === 0) {
				return null;
			}

			const startMs = start.getTime();
			const endMs = start.getTime() + 24 * 60 * 60 * 1000;

			let result = { total: 0, slots: {}, rawIntervals: /** @type {Array<{ts: number, val: number}>} */ ([]) };
			for (const r of this.masterData.rates) {
				result.slots[r.name] = { consumption: 0, cost: 0, rateEuros: r.rateEuros };
			}

			if (enwgActive) {
				result.enwgSlots = {
					NT: { consumption: 0, costGross: 0, costNet: 0 },
					ST: { consumption: 0, costGross: 0, costNet: 0 },
					HT: { consumption: 0, costGross: 0, costNet: 0 },
				};
			}

			for (const edge of edges) {
				const nodeVal = parseFloat(edge.node?.value || 0);
				const startDt = new Date(edge.node.startAt);
				const nodeMs = startDt.getTime();

				if (nodeMs < startMs || nodeMs >= endMs) {
					continue;
				}

				if (fetchRaw) {
					result.rawIntervals.push({ ts: nodeMs, val: nodeVal });
				}

				result.total += nodeVal;

				if (isSplit) {
					const nodeHour = startDt.getHours() + startDt.getMinutes() / 60;
					let slotted = false;
					let matchedRate = null;
					for (const rate of this.masterData.rates) {
						const fromH = this.timeStrToHours(rate.from);
						const toH = this.timeStrToHours(rate.to) || 24;

						let inSlot = false;
						if (fromH < toH) {
							inSlot = nodeHour >= fromH && nodeHour < toH;
						} else {
							// wraps around midnight, e.g. 23:00 to 05:00
							inSlot = nodeHour >= fromH || nodeHour < toH;
						}

						if (inSlot) {
							result.slots[rate.name].consumption += nodeVal;
							matchedRate = rate;
							slotted = true;
							break;
						}
					}
					// fallback to first slot if not matched
					if (!slotted && this.masterData.rates.length > 0) {
						result.slots[this.masterData.rates[0].name].consumption += nodeVal;
						matchedRate = this.masterData.rates[0];
					}

					// If EnWG is active, calculate EnWG rates for the interval
					if (enwgActive && matchedRate && fees) {
						const pApi = matchedRate.rateEuros; // Gross price from Octopus API for this interval
						const tariffEnwg = this.getEnwgTariffForTime(startDt, this.config);

						const gStGross = fees.ST.gross;
						const gActiveGross = fees[tariffEnwg].gross;
						const pFinalGross = pApi - gStGross + gActiveGross;

						const gStNet = fees.ST.net;
						const gActiveNet = fees[tariffEnwg].net;

						// Net API price: divide by 1.19
						const pApiNet = pApi / 1.19;
						const pFinalNet = pApiNet - gStNet + gActiveNet;

						result.enwgSlots[tariffEnwg].consumption += nodeVal;
						result.enwgSlots[tariffEnwg].costGross += nodeVal * pFinalGross;
						result.enwgSlots[tariffEnwg].costNet += nodeVal * pFinalNet;

						// ALSO add to standard slots
						result.slots[matchedRate.name].cost += nodeVal * pFinalGross;
					}
				} else {
					result.slots[this.masterData.rates[0].name].consumption += nodeVal;
					if (enwgActive && fees) {
						const pApi = this.masterData.rates[0].rateEuros;
						const tariffEnwg = this.getEnwgTariffForTime(startDt, this.config);

						const gStGross = fees.ST.gross;
						const gActiveGross = fees[tariffEnwg].gross;
						const pFinalGross = pApi - gStGross + gActiveGross;

						const gStNet = fees.ST.net;
						const gActiveNet = fees[tariffEnwg].net;
						const pApiNet = pApi / 1.19;
						const pFinalNet = pApiNet - gStNet + gActiveNet;

						result.enwgSlots[tariffEnwg].consumption += nodeVal;
						result.enwgSlots[tariffEnwg].costGross += nodeVal * pFinalGross;
						result.enwgSlots[tariffEnwg].costNet += nodeVal * pFinalNet;

						// ALSO add to standard slots
						result.slots[this.masterData.rates[0].name].cost += nodeVal * pFinalGross;
					}
				}
			}

			let totalCost = 0;
			for (const key of Object.keys(result.slots)) {
				if (!enwgActive) {
					result.slots[key].cost = result.slots[key].consumption * result.slots[key].rateEuros;
				}
				totalCost += result.slots[key].cost;
			}
			result.totalCost = totalCost;

			return result;
		} catch (error) {
			this.log.error(`Octopus fetch error: ${error.message}`);
			return null;
		}
	}

	parseInexogyData(dataRes) {
		if (dataRes.status === 200 && dataRes.data && dataRes.data.energy) {
			const diffWh = Math.abs((dataRes.data.energy.maximum || 0) - (dataRes.data.energy.minimum || 0));
			let kwh = diffWh / 10000000000;
			if (diffWh > 0 && diffWh < 100000) {
				kwh = diffWh / 1000;
			}
			return parseFloat(kwh.toFixed(3));
		}
		return null;
	}

	async fetchInexogyReadings(meterId, headers, fromDate, toDate) {
		const url = `https://api.inexogy.com/public/v1/readings?meterId=${meterId}&from=${fromDate.getTime()}&to=${toDate.getTime()}&resolution=fifteen_minutes`;
		const res = await axios.get(url, { headers, validateStatus: () => true, timeout: AXIOS_TIMEOUT });
		if (res.status === 200 && Array.isArray(res.data)) {
			return res.data;
		}
		return null;
	}

	async fetchInexogy(start, end) {
		try {
			if (!this.masterData) {
				return null;
			}
			const enwgActive = this.isEnwgActiveForDate(start, this.config);
			const isSplit = (this.masterData.isTimeOfUse && this.masterData.rates.length > 1) || enwgActive;
			const basicAuth = Buffer.from(`${this.config.inexogyEmail}:${this.config.inexogyPassword}`).toString(
				'base64',
			);

			if (!this.inexogyMeterId) {
				const meterRes = await axios.get('https://api.inexogy.com/public/v1/meters', {
					headers: { Authorization: `Basic ${basicAuth}` },
					validateStatus: () => true,
					timeout: AXIOS_TIMEOUT,
				});
				if (meterRes.status !== 200 || !meterRes.data || meterRes.data.length === 0) {
					return null;
				}
				this.inexogyMeterId = meterRes.data[0].meterId;
			}

			const meterId = this.inexogyMeterId;
			const headers = { Authorization: `Basic ${basicAuth}` };

			const readings = await this.fetchInexogyReadings(meterId, headers, start, end);
			if (!readings || readings.length === 0) {
				return null;
			}

			const fetchRaw = isSplit || this.config.enableHistorySync;
			/** @type {{ total: number, slots: Object<string, any>, enwgSlots?: Object<string, any>, rawIntervals: Array<{ts: number, val: number}> }} */
			let result = { total: 0, slots: {}, rawIntervals: [] };

			// Calculate consumption per 15-min interval
			// Readings provide the absolute 'energy' counter at the end of each slot.
			// We need the diff between reading[i] and reading[i-1]
			for (let i = 1; i < readings.length; i++) {
				const prev = readings[i - 1];
				const curr = readings[i];
				if (!curr.values || !curr.values.energy || !prev.values || !prev.values.energy) {
					continue;
				}

				const diffWh = Math.abs(curr.values.energy - prev.values.energy);
				let kwh = diffWh / 10000000000;
				if (diffWh > 0 && diffWh < 100000) {
					kwh = diffWh / 1000;
				}
				const consumption = parseFloat(kwh.toFixed(3));
				const ts = curr.time; // timestamp of the reading (end of the 15m slot)

				if (fetchRaw) {
					result.rawIntervals.push({ ts, val: consumption });
				}
				result.total += consumption;
			}

			// Inexogy requires fallback to total if no split is needed, but we keep the structure
			for (const r of this.masterData.rates) {
				result.slots[r.name] = { consumption: 0, cost: 0, rateEuros: r.rateEuros };
			}

			if (enwgActive) {
				result.enwgSlots = {
					NT: { consumption: 0, costGross: 0, costNet: 0 },
					ST: { consumption: 0, costGross: 0, costNet: 0 },
					HT: { consumption: 0, costGross: 0, costNet: 0 },
				};
			}

			if (!isSplit) {
				result.slots[this.masterData.rates[0].name].consumption = result.total;
				return result;
			}

			// We now need to distribute the rawIntervals into the time slots
			// We iterate through the raw intervals and bin them based on their timestamp
			for (const interval of result.rawIntervals) {
				const slotDt = new Date(interval.ts - 1000); // use a time slightly before the end of the slot to correctly bucket it
				const nodeHour = slotDt.getHours() + slotDt.getMinutes() / 60;

				// Distribute into EnWG slots
				if (enwgActive) {
					const segments = this.getTariffSegmentsForDay(start, this.config);
					for (const [tariffName, tariffSegs] of Object.entries(segments)) {
						let matched = false;
						for (const seg of tariffSegs) {
							const fromH = seg.fromMin / 60;
							const toH = seg.toMin / 60;
							if (nodeHour >= fromH && nodeHour < toH) {
								if (result.enwgSlots) {
									result.enwgSlots[tariffName].consumption += interval.val;
								}
								matched = true;
								break;
							}
						}
						if (matched) {
							break;
						}
					}
				}

				// Distribute into standard slots
				for (const rate of this.masterData.rates) {
					const fromH = this.timeStrToHours(rate.from);
					const toH = this.timeStrToHours(rate.to) || 24;

					let inSlot = false;
					if (fromH < toH) {
						inSlot = nodeHour >= fromH && nodeHour < toH;
					} else {
						inSlot = nodeHour >= fromH || nodeHour < toH;
					}
					if (inSlot) {
						result.slots[rate.name].consumption += interval.val;
						break;
					}
				}
			}

			return result;
		} catch (error) {
			this.log.error(`Inexogy fetch error: ${error.message}`);
			return null;
		}
	}

	async fetchInexogyMasterData() {
		try {
			const basicAuth = Buffer.from(`${this.config.inexogyEmail}:${this.config.inexogyPassword}`).toString(
				'base64',
			);
			const headers = { Authorization: `Basic ${basicAuth}` };

			const meterRes = await axios.get('https://api.inexogy.com/public/v1/meters', {
				headers,
				validateStatus: () => true,
				timeout: AXIOS_TIMEOUT,
			});
			if (meterRes.status !== 200 || !meterRes.data || meterRes.data.length === 0) {
				this.log.warn('Failed to fetch Inexogy meter master data');
				return null;
			}

			const meter = meterRes.data[0];
			this.inexogyMeterId = meter.meterId;

			await this.writeStateObject('inexogy.info.meterId', 'Meter ID', meter.meterId, 'text', 'string');
			await this.writeStateObject(
				'inexogy.info.manufacturerId',
				'Manufacturer ID',
				meter.manufacturerId || '',
				'text',
				'string',
			);
			await this.writeStateObject(
				'inexogy.info.serialNumber',
				'Serial Number',
				meter.serialNumber || '',
				'text',
				'string',
			);
			await this.writeStateObject(
				'inexogy.info.fullSerialNumber',
				'Full Serial Number',
				meter.fullSerialNumber || '',
				'text',
				'string',
			);

			if (meter.location) {
				await this.writeStateObject(
					'inexogy.info.street',
					'Street',
					meter.location.street || '',
					'text',
					'string',
				);
				await this.writeStateObject('inexogy.info.city', 'City', meter.location.city || '', 'text', 'string');
				await this.writeStateObject('inexogy.info.zip', 'ZIP Code', meter.location.zip || '', 'text', 'string');
			}

			const readingRes = await axios.get(
				`https://api.inexogy.com/public/v1/last_reading?meterId=${this.inexogyMeterId}`,
				{ headers, validateStatus: () => true, timeout: AXIOS_TIMEOUT },
			);
			if (readingRes.status === 200 && readingRes.data) {
				if (readingRes.data.time) {
					await this.writeStateObject(
						'inexogy.info.lastReadingTime',
						'Last Reading Time',
						new Date(readingRes.data.time).toLocaleString(),
						'text',
						'string',
					);
				}
				if (readingRes.data.values) {
					if (readingRes.data.values.energy !== undefined) {
						const kwh = readingRes.data.values.energy / 10000000000;
						await this.writeStateObject(
							'inexogy.info.lastReadingEnergy',
							'Last Reading Energy (Bezug)',
							parseFloat(kwh.toFixed(3)),
							'value',
							'number',
							'kWh',
						);
					}
					if (readingRes.data.values.energyOut !== undefined) {
						const kwhOut = readingRes.data.values.energyOut / 10000000000;
						await this.writeStateObject(
							'inexogy.info.lastReadingEnergyOut',
							'Last Reading Energy Out (Einspeisung)',
							parseFloat(kwhOut.toFixed(3)),
							'value',
							'number',
							'kWh',
						);
					}
					if (readingRes.data.values.power !== undefined) {
						const powerW = readingRes.data.values.power / 1000;
						await this.writeStateObject(
							'inexogy.info.lastReadingPower',
							'Current Power',
							parseFloat(powerW.toFixed(3)),
							'value.power',
							'number',
							'W',
						);
					}
				}
			}

			this.log.debug('Inexogy master data and last reading fetched and updated.');
		} catch (error) {
			this.log.error(`Failed to fetch Inexogy master data: ${error.message}`);
		}
	}

	async fetchOctopusDevices() {
		try {
			if (!this.octopusAuthToken || !this.config.octopusAccount) {
				return;
			}

			const apiDomain = 'https://api.oeg-kraken.energy/v1/graphql/';
			const payload = {
				query: `query Devices($account: String!) {
					devices(accountNumber: $account) {
						id name integrationDeviceId propertyId provider deviceType
						status {
							current currentState isSuspended
							... on SmartFlexDeviceStatus { current isSuspended currentState }
							... on SmartFlexVehicleStatus { current isSuspended currentState stateOfCharge { value } activePower { value } }
						}
					}
				}`,
				variables: { account: this.config.octopusAccount },
			};

			const res = await axios.post(apiDomain, payload, {
				headers: { 'Content-Type': 'application/json', Authorization: this.octopusAuthToken },
				validateStatus: () => true,
				timeout: AXIOS_TIMEOUT,
			});

			if (res.status === 200 && res.data?.data?.devices) {
				const devices = res.data.data.devices;
				for (const device of devices) {
					if (!device.id) {
						continue;
					}
					const safeDeviceId = this.sanitizeIdSegment(device.id);
					const basePath = `octopus.devices.${safeDeviceId}`;

					await this.setObjectNotExistsAsync(`octopus.devices`, {
						type: 'channel',
						common: { name: 'Octopus Devices' },
						native: {},
					});
					await this.setObjectNotExistsAsync(basePath, {
						type: 'channel',
						common: { name: device.name || 'Device' },
						native: {},
					});

					await this.writeStateObject(`${basePath}.deviceId`, 'API Device ID', device.id, 'text', 'string');
					await this.writeStateObject(`${basePath}.name`, 'Device Name', device.name || '', 'text', 'string');
					await this.setObjectNotExistsAsync(`${basePath}.refresh`, {
						type: 'state',
						common: {
							name: 'Refresh Device Data',
							type: 'boolean',
							role: 'button',
							read: true,
							write: true,
						},
						native: {},
					});
					await this.setStateAsync(`${basePath}.refresh`, { val: false, ack: true });
					await this.writeStateObject(
						`${basePath}.provider`,
						'Provider',
						device.provider || '',
						'text',
						'string',
					);
					await this.writeStateObject(
						`${basePath}.deviceType`,
						'Device Type',
						device.deviceType || '',
						'text',
						'string',
					);
					await this.writeStateObject(
						`${basePath}.integrationDeviceId`,
						'Integration Device ID',
						device.integrationDeviceId || '',
						'text',
						'string',
					);

					if (device.status) {
						await this.setObjectNotExistsAsync(`${basePath}.status`, {
							type: 'channel',
							common: { name: 'Device Status' },
							native: {},
						});
						await this.writeStateObject(
							`${basePath}.status.current`,
							'Current Status',
							device.status.current || '',
							'text',
							'string',
						);
						await this.writeStateObject(
							`${basePath}.status.currentState`,
							'Current State',
							device.status.currentState || '',
							'text',
							'string',
						);

						if (device.status.stateOfCharge && device.status.stateOfCharge.value) {
							await this.writeStateObject(
								`${basePath}.status.stateOfCharge`,
								'State of Charge',
								parseFloat(device.status.stateOfCharge.value),
								'value.battery',
								'number',
								'%',
							);
						}
						if (device.status.activePower && device.status.activePower.value) {
							await this.writeStateObject(
								`${basePath}.status.activePower`,
								'Active Power',
								parseFloat(device.status.activePower.value),
								'value.power',
								'number',
								'kW',
							);
						}

						const isSuspended = !!device.status.isSuspended;
						await this.writeStateObject(
							`${basePath}.status.isSuspended`,
							'Is Suspended',
							isSuspended,
							'indicator',
							'boolean',
						);

						const smartChargeActive = !isSuspended;
						await this.setObjectNotExistsAsync(`${basePath}.smartChargeActive`, {
							type: 'state',
							common: {
								name: 'Smart Charging Active',
								type: 'boolean',
								role: 'switch',
								read: true,
								write: true,
							},
							native: {},
						});
						await this.setStateAsync(`${basePath}.smartChargeActive`, {
							val: smartChargeActive,
							ack: true,
						});
					}
				}
				this.log.debug(`Fetched and updated ${devices.length} Octopus devices.`);
			}
		} catch (error) {
			this.log.error(`Failed to fetch Octopus devices: ${error.message}`);
		}
	}

	async setSmartChargeStatus(deviceId, action) {
		try {
			if (!this.octopusAuthToken) {
				return;
			}
			const apiDomain = 'https://api.oeg-kraken.energy/v1/graphql/';

			const payload = {
				query: `mutation MyMutation($deviceID: ID!) {
					updateDeviceSmartControl(input: {deviceId: $deviceID, action: ${action}}) {
						id name
					}
				}`,
				variables: { deviceID: deviceId },
			};

			const res = await axios.post(apiDomain, payload, {
				headers: { 'Content-Type': 'application/json', Authorization: this.octopusAuthToken },
				validateStatus: () => true,
				timeout: AXIOS_TIMEOUT,
			});

			if (res.status === 200 && res.data?.data?.updateDeviceSmartControl) {
				this.log.info(
					`Smart Charging mutation ${action} sent for device ${deviceId}. Refreshing status in 5s...`,
				);

				// Wait 5 seconds for the backend to propagate the change, then refresh
				this.smartChargeTimeout = this.setTimeout(async () => {
					await this.fetchOctopusDevices();
				}, 5000);
			} else {
				this.log.error(
					`Failed to set smart charge status. Response: ${JSON.stringify(res.data || res.statusText)}`,
				);
			}
		} catch (error) {
			this.log.error(`Error setting smart charge status: ${error.message}`);
		}
	}

	async onStateChange(id, state) {
		if (state && !state.ack) {
			const prefix = `${this.namespace}.octopus.devices.`;
			if (id.startsWith(prefix) && id.endsWith('.smartChargeActive')) {
				const parts = id.split('.');
				const safeDeviceId = parts[parts.length - 2];
				const action = state.val ? 'UNSUSPEND' : 'SUSPEND';

				const deviceIdState = await this.getStateAsync(
					`${this.namespace}.octopus.devices.${safeDeviceId}.deviceId`,
				);
				const originalDeviceId = deviceIdState && deviceIdState.val ? String(deviceIdState.val) : safeDeviceId;

				this.log.info(`User requested smart charge action ${action} for device ${originalDeviceId}`);
				await this.setSmartChargeStatus(originalDeviceId, action);
			} else if (id.startsWith(prefix) && id.endsWith('.refresh')) {
				this.log.info(`User requested manual refresh for Octopus devices`);
				await this.fetchOctopusDevices();
				await this.setStateAsync(id, { val: false, ack: true });
			}
		}
	}

	/**
	 * Check whether daily consumption data for a specific day is already cached.
	 * Days with 0 or missing consumption are considered not cached to allow retroactive updates
	 * when smart meter data is delivered with a delay by the API provider.
	 *
	 * @param {ioBroker.State | null | undefined} checkOctopus Octopus state object
	 * @param {ioBroker.State | null | undefined} checkInexogy Inexogy state object
	 * @param {boolean} [hasInexogy] Whether Inexogy is configured
	 * @param {boolean} [enwgConfigChanged] Whether EnWG settings changed
	 * @param {boolean} [enwgActive] Whether EnWG is active for the target date
	 * @returns {boolean} True if the day has cached data and does not need to be refetched
	 */
	isDayCached(checkOctopus, checkInexogy, hasInexogy = false, enwgConfigChanged = false, enwgActive = false) {
		const hasOctopus = !!(
			checkOctopus &&
			checkOctopus.val !== null &&
			checkOctopus.val !== undefined &&
			Number(checkOctopus.val) > 0
		);

		let hasInexogyData = true;
		if (hasInexogy) {
			hasInexogyData = !!(
				checkInexogy &&
				checkInexogy.val !== null &&
				checkInexogy.val !== undefined &&
				Number(checkInexogy.val) > 0
			);
		}

		let isCached = hasOctopus && hasInexogyData;
		if (enwgConfigChanged && enwgActive) {
			isCached = false;
		}
		return isCached;
	}

	async syncData() {
		const adapterObjects = await this.getAdapterObjectsAsync();
		await this.cleanupLegacyHistory(adapterObjects);
		let syncDays = Number(this.config.syncDays) || 30;
		const retentionDays = Number(this.config.retentionDays) || 0;

		if (retentionDays > 0 && syncDays > retentionDays) {
			this.log.warn(
				`Sync period (${syncDays} days) exceeds retention period (${retentionDays} days). Capping sync period to ${retentionDays} days to avoid fetching data that will be immediately deleted.`,
			);
			syncDays = retentionDays;
		}

		if (this.enwgEnabled && this.config.enwgStartDate) {
			const startParts = this.config.enwgStartDate.split('-');
			if (startParts.length === 3) {
				const startYear = parseInt(startParts[0], 10);
				const startMonth = parseInt(startParts[1], 10) - 1;
				const startDay = parseInt(startParts[2], 10);
				const startDate = new Date(startYear, startMonth, startDay, 0, 0, 0, 0);
				const today = new Date();
				today.setHours(0, 0, 0, 0);
				const diffTime = today.getTime() - startDate.getTime();
				if (diffTime > 0) {
					const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
					if (diffDays > syncDays) {
						let newSyncDays = diffDays;
						if (retentionDays > 0 && newSyncDays > retentionDays) {
							newSyncDays = retentionDays;
							this.log.info(
								`§14a EnWG start date is ${diffDays} days ago, but sync period extension is capped by retention policy to ${retentionDays} days.`,
							);
						} else {
							this.log.info(
								`§14a EnWG start date is ${diffDays} days ago. Extending sync period from ${syncDays} to ${diffDays} days to recalculate history.`,
							);
						}
						syncDays = Math.max(syncDays, newSyncDays);
					}
				}
			}
		}

		this.log.debug(`Starting ${syncDays}-day retroactive data sync...`);

		const masterData = await this.fetchOctopusMasterData();
		if (!masterData) {
			this.log.warn('Aborting sync because master data could not be fetched.');
			return;
		}

		await this.fetchOctopusDevices();

		if (this.hasInexogy) {
			await this.fetchInexogyMasterData();
		}

		let historyPayloads = [];

		try {
			for (let i = syncDays; i >= 1; i--) {
				const targetDate = new Date();
				targetDate.setDate(targetDate.getDate() - i);
				targetDate.setHours(0, 0, 0, 0);
				const endDate = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);

				const yearStr = `${targetDate.getFullYear()}`;
				const monthStr = String(targetDate.getMonth() + 1).padStart(2, '0');
				const dayStr = String(targetDate.getDate()).padStart(2, '0');

				const basePathYear = `history.${yearStr}`;
				const basePathMonth = `${basePathYear}.${monthStr}`;
				const basePathDay = `${basePathMonth}.${dayStr}`;

				const checkOctopus = await this.getStateAsync(`${basePathDay}.octopus.dailyConsumption`);
				const checkInexogy = this.hasInexogy
					? await this.getStateAsync(`${basePathDay}.inexogy.dailyConsumption`)
					: null;

				const enwgActive = this.isEnwgActiveForDate(targetDate, this.config);
				const isCached = this.isDayCached(
					checkOctopus,
					checkInexogy,
					this.hasInexogy,
					this.enwgConfigChanged,
					enwgActive,
				);

				if (!isCached) {
					this.log.debug(`Syncing data for ${yearStr}-${monthStr}-${dayStr}...`);

					// Create hierarchical folders
					await this.setObjectNotExistsAsync(basePathYear, {
						type: 'channel',
						common: { name: `Year ${yearStr}` },
						native: {},
					});
					await this.setObjectNotExistsAsync(basePathMonth, {
						type: 'channel',
						common: { name: `Month ${yearStr}-${monthStr}` },
						native: {},
					});
					await this.setObjectNotExistsAsync(basePathDay, {
						type: 'channel',
						common: { name: `Day ${yearStr}-${monthStr}-${dayStr}` },
						native: {},
					});
					await this.setObjectNotExistsAsync(`${basePathDay}.octopus`, {
						type: 'channel',
						common: { name: 'Octopus Energy Data' },
						native: {},
					});
					if (this.hasInexogy) {
						await this.setObjectNotExistsAsync(`${basePathDay}.inexogy`, {
							type: 'channel',
							common: { name: 'Inexogy Smart Meter Data' },
							native: {},
						});
						await this.setObjectNotExistsAsync(`${basePathDay}.comparison`, {
							type: 'channel',
							common: { name: 'Comparison Data' },
							native: {},
						});
					}

					const octopusData = await this.fetchOctopus(targetDate, endDate);
					let inexogyData = null;
					if (this.hasInexogy) {
						inexogyData = await this.fetchInexogy(targetDate, endDate);
					}

					if (octopusData) {
						await this.writeStateObject(
							`${basePathDay}.octopus.dailyConsumption`,
							'Daily Consumption',
							parseFloat(octopusData.total.toFixed(3)),
						);
						await this.writeStateObject(
							`${basePathDay}.octopus.totalCost`,
							'Total Daily Cost',
							parseFloat(octopusData.totalCost.toFixed(2)),
							'value',
							'number',
							'€',
						);

						for (const [slotName, slotData] of Object.entries(octopusData.slots)) {
							const safeName = this.sanitizeIdSegment(slotName).toLowerCase();
							await this.writeStateObject(
								`${basePathDay}.octopus.${safeName}Consumption`,
								`Consumption ${slotName}`,
								parseFloat(slotData.consumption.toFixed(3)),
							);
							await this.writeStateObject(
								`${basePathDay}.octopus.${safeName}Cost`,
								`Cost ${slotName}`,
								parseFloat(slotData.cost.toFixed(2)),
								'value',
								'number',
								'€',
							);
						}

						if (octopusData.enwgSlots) {
							for (const [slotName, slotData] of Object.entries(octopusData.enwgSlots)) {
								const safeName = this.sanitizeIdSegment(slotName).toLowerCase();
								await this.writeStateObject(
									`${basePathDay}.octopus.${safeName}Consumption`,
									`Consumption EnWG ${slotName}`,
									parseFloat(slotData.consumption.toFixed(3)),
								);
								await this.writeStateObject(
									`${basePathDay}.octopus.${safeName}Cost`,
									`Cost EnWG ${slotName}`,
									parseFloat(slotData.costGross.toFixed(2)),
									'value',
									'number',
									'€',
								);
								await this.writeStateObject(
									`${basePathDay}.octopus.${safeName}CostNet`,
									`Cost Net EnWG ${slotName}`,
									parseFloat(slotData.costNet.toFixed(2)),
									'value',
									'number',
									'€',
								);
							}
						} else if (this.enwgEnabled) {
							for (const slotName of ['NT', 'ST', 'HT']) {
								const safeName = this.sanitizeIdSegment(slotName).toLowerCase();
								await this.writeStateObject(
									`${basePathDay}.octopus.${safeName}Consumption`,
									`Consumption EnWG ${slotName}`,
									0,
								);
								await this.writeStateObject(
									`${basePathDay}.octopus.${safeName}Cost`,
									`Cost EnWG ${slotName}`,
									0,
									'value',
									'number',
									'€',
								);
								await this.writeStateObject(
									`${basePathDay}.octopus.${safeName}CostNet`,
									`Cost Net EnWG ${slotName}`,
									0,
									'value',
									'number',
									'€',
								);
							}
						}

						if (this.config.enableHistorySync && this.config.historyInstance && octopusData.rawIntervals) {
							for (const p of octopusData.rawIntervals) {
								historyPayloads.push({
									id: `${this.namespace}.octopus.info.15MinConsumption`,
									state: { ts: p.ts, val: p.val, ack: true, q: 0 },
								});
							}
						}

						if (inexogyData) {
							await this.writeStateObject(
								`${basePathDay}.inexogy.dailyConsumption`,
								'Daily Consumption',
								parseFloat(inexogyData.total.toFixed(3)),
							);

							for (const [slotName, slotData] of Object.entries(inexogyData.slots)) {
								const safeName = this.sanitizeIdSegment(slotName).toLowerCase();
								await this.writeStateObject(
									`${basePathDay}.inexogy.${safeName}Consumption`,
									`Consumption ${slotName}`,
									parseFloat(slotData.consumption.toFixed(3)),
								);

								const diff = Math.abs(octopusData.slots[slotName].consumption - slotData.consumption);
								await this.writeStateObject(
									`${basePathDay}.comparison.${safeName}Difference`,
									`Difference ${slotName}`,
									parseFloat(diff.toFixed(3)),
								);
							}

							if (inexogyData.enwgSlots) {
								for (const [slotName, slotData] of Object.entries(inexogyData.enwgSlots)) {
									const safeName = this.sanitizeIdSegment(slotName).toLowerCase();
									await this.writeStateObject(
										`${basePathDay}.inexogy.${safeName}Consumption`,
										`Consumption EnWG ${slotName}`,
										parseFloat(slotData.consumption.toFixed(3)),
									);

									const octCons = octopusData.enwgSlots[slotName]?.consumption || 0;
									const diff = Math.abs(octCons - slotData.consumption);
									await this.writeStateObject(
										`${basePathDay}.comparison.${safeName}Difference`,
										`Difference EnWG ${slotName}`,
										parseFloat(diff.toFixed(3)),
									);
								}
							} else if (this.enwgEnabled) {
								for (const slotName of ['NT', 'ST', 'HT']) {
									const safeName = this.sanitizeIdSegment(slotName).toLowerCase();
									await this.writeStateObject(
										`${basePathDay}.inexogy.${safeName}Consumption`,
										`Consumption EnWG ${slotName}`,
										0,
									);
									await this.writeStateObject(
										`${basePathDay}.comparison.${safeName}Difference`,
										`Difference EnWG ${slotName}`,
										0,
									);
								}
							}

							const totalDiff = Math.abs(octopusData.total - inexogyData.total);
							const threshold = Number(this.config.discrepancyThreshold) || 0.1;
							await this.writeStateObject(
								`${basePathDay}.comparison.difference`,
								'Absolute Difference',
								parseFloat(totalDiff.toFixed(3)),
							);
							await this.writeStateObject(
								`${basePathDay}.comparison.hasDiscrepancy`,
								'Has Discrepancy',
								totalDiff >= threshold,
								'indicator',
								'boolean',
							);

							if (totalDiff >= threshold) {
								this.log.warn(
									`Discrepancy for ${yearStr}-${monthStr}-${dayStr}! Diff: ${totalDiff.toFixed(3)} kWh`,
								);
							}

							if (
								this.config.enableHistorySync &&
								this.config.historyInstance &&
								inexogyData.rawIntervals
							) {
								for (const p of inexogyData.rawIntervals) {
									historyPayloads.push({
										id: `${this.namespace}.inexogy.info.15MinConsumption`,
										state: { ts: p.ts, val: p.val, ack: true, q: 0 },
									});
								}
							}
						}
					} else {
						this.log.warn(`Skipping ${yearStr}-${monthStr}-${dayStr} due to missing Octopus data.`);
					}
				}
			}

			if (historyPayloads.length > 0) {
				this.log.info(
					`Pushing ${historyPayloads.length} interval data points directly to ${this.config.historyInstance}...`,
				);
				try {
					await this.sendToAsync(this.config.historyInstance, 'storeState', historyPayloads);
				} catch (e) {
					this.log.error(`Failed to push history data to ${this.config.historyInstance}: ${e.message}`);
				}
			}

			// Reset config changed flag since we finished the sync
			this.enwgConfigChanged = false;

			// Aggregate hierarchical data
			await this.aggregateHistory(adapterObjects);

			// Update JSONs
			await this.updateHistoryJson(adapterObjects);

			// 3. Update meter reading
			const lastOfficialReading = await this.fetchOctopusMeterReadings();
			if (lastOfficialReading) {
				let totalSinceLastReading = 0;
				const historyPrefixForSum = `${this.namespace}.history.`;

				for (const id of Object.keys(adapterObjects)) {
					if (id.startsWith(historyPrefixForSum)) {
						const relativeId = id.substring(historyPrefixForSum.length);
						const parts = relativeId.split('.');
						// parts = [YYYY, MM, DD, 'octopus', 'dailyConsumption']
						if (parts.length === 5 && parts[3] === 'octopus' && parts[4] === 'dailyConsumption') {
							const year = parseInt(parts[0], 10);
							const month = parseInt(parts[1], 10);
							const day = parseInt(parts[2], 10);
							const stateDate = new Date(year, month - 1, day);

							// If the day is AFTER the official reading day
							if (stateDate > lastOfficialReading.readAt) {
								const consState = await this.getStateAsync(id);
								if (consState && consState.val) {
									totalSinceLastReading += Number(consState.val);
								}
							}
						}
					}
				}

				const calculatedReading = lastOfficialReading.value + totalSinceLastReading;
				await this.writeStateObject(
					'octopus.info.meterReading',
					'Current Calculated Meter Reading',
					parseFloat(calculatedReading.toFixed(3)),
					'value',
					'number',
					'kWh',
				);
				this.log.debug(`Updated calculated meter reading: ${calculatedReading.toFixed(3)} kWh`);
			}

			// 4. Apply data retention
			await this.applyDataRetention(adapterObjects);
		} catch (error) {
			this.log.error(`Error during syncData: ${error.message}`);
		}
	}

	async applyDataRetention(adapterObjects) {
		const retentionDays = Number(this.config.retentionDays) || 0;
		if (retentionDays <= 0) {
			return;
		}

		this.log.debug(`Applying data retention: deleting history older than ${retentionDays} days...`);
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - retentionDays);
		cutoff.setHours(0, 0, 0, 0);

		const objects = adapterObjects || (await this.getAdapterObjectsAsync());
		const historyPrefix = `${this.namespace}.history.`;

		// Collect day-level date strings (YYYY.MM.DD) that are older than cutoff
		const oldDates = new Set();
		for (const id of Object.keys(objects)) {
			if (id.startsWith(historyPrefix)) {
				const relativeId = id.substring(historyPrefix.length);
				const parts = relativeId.split('.');
				if (
					parts.length >= 3 &&
					/^\d{4}$/.test(parts[0]) &&
					/^\d{2}$/.test(parts[1]) &&
					/^\d{2}$/.test(parts[2])
				) {
					const dateObj = new Date(
						parseInt(parts[0], 10),
						parseInt(parts[1], 10) - 1,
						parseInt(parts[2], 10),
					);
					if (dateObj < cutoff) {
						oldDates.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
					}
				}
			}
		}

		if (oldDates.size === 0) {
			return;
		}

		this.log.info(`Data retention: removing ${oldDates.size} day(s) older than ${retentionDays} days.`);

		// Delete all objects belonging to old dates (day channels and their children)
		for (const id of Object.keys(objects)) {
			if (id.startsWith(historyPrefix)) {
				const relativeId = id.substring(historyPrefix.length);
				const parts = relativeId.split('.');
				if (parts.length >= 3) {
					const dateKey = `${parts[0]}.${parts[1]}.${parts[2]}`;
					if (oldDates.has(dateKey)) {
						await this.delObjectAsync(id.substring(this.namespace.length + 1));
						if (adapterObjects) {
							delete adapterObjects[id];
						}
					}
				}
			}
		}
	}

	async aggregateHistory(adapterObjects) {
		this.log.debug('Aggregating hierarchical history...');
		const objects = adapterObjects || (await this.getAdapterObjectsAsync());
		const historyPrefix = `${this.namespace}.history.`;

		const yearMap = {}; // year -> { consumption, cost, months: { month -> { consumption, cost } } }
		let currentMonthTotals = { consumption: 0, cost: 0 };
		const currentY = new Date().getFullYear();
		const currentM = String(new Date().getMonth() + 1).padStart(2, '0');

		const billingPeriodStartDay = Number(this.config.billingPeriodStartDay) || 1;
		const today = new Date();

		// Store dynamic periods map: periodStartDate (format: YYYY-MM-DD) -> periodData
		const periodMap = {};
		const existingDays = new Set();

		const formatDateStr = d => {
			return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
		};

		for (const id of Object.keys(objects)) {
			if (id.startsWith(historyPrefix)) {
				const relativeId = id.substring(historyPrefix.length);
				const parts = relativeId.split('.');
				// parts = [YYYY, MM, DD, 'octopus', 'dailyConsumption']
				if (parts.length === 5 && parts[3] === 'octopus' && parts[4] === 'dailyConsumption') {
					const year = parts[0];
					const month = parts[1];
					const day = parts[2];
					existingDays.add(`${year}-${month}-${day}`);

					if (!yearMap[year]) {
						yearMap[year] = { consumption: 0, cost: 0, months: {} };
					}
					if (!yearMap[year].months[month]) {
						yearMap[year].months[month] = { consumption: 0, cost: 0 };
					}

					const consState = await this.getStateAsync(id);
					const costState = await this.getStateAsync(
						`${historyPrefix}${year}.${month}.${day}.octopus.totalCost`,
					);

					const cons = consState && consState.val ? Number(consState.val) : 0;
					const cost = costState && costState.val ? Number(costState.val) : 0;

					yearMap[year].consumption += cons;
					yearMap[year].cost += cost;
					yearMap[year].months[month].consumption += cons;
					yearMap[year].months[month].cost += cost;

					if (year === String(currentY) && month === currentM) {
						currentMonthTotals.consumption += cons;
						currentMonthTotals.cost += cost;
					}

					const yearNum = parseInt(year, 10);
					const monthNum = parseInt(month, 10);
					const dayNum = parseInt(day, 10);
					const stateDate = new Date(yearNum, monthNum - 1, dayNum);

					// Determine period for this day
					const period = this.getPeriodDates(stateDate, billingPeriodStartDay);
					const periodKey = formatDateStr(period.start);

					if (!periodMap[periodKey]) {
						periodMap[periodKey] = {
							start: period.start,
							end: period.end,
							consumption: 0,
							cost: 0,
							slots: {},
						};
					}

					periodMap[periodKey].consumption += cons;
					periodMap[periodKey].cost += cost;

					// Dynamically query slot states
					if (this.masterData && this.masterData.rates) {
						for (const rate of this.masterData.rates) {
							const slotName = this.sanitizeIdSegment(rate.name).toLowerCase();
							const slotConsId = `${historyPrefix}${year}.${month}.${day}.octopus.${slotName}Consumption`;
							const slotCostId = `${historyPrefix}${year}.${month}.${day}.octopus.${slotName}Cost`;

							const slotConsState = await this.getStateAsync(slotConsId);
							const slotCostState = await this.getStateAsync(slotCostId);

							const slotCons = slotConsState && slotConsState.val ? Number(slotConsState.val) : 0;
							const slotCost = slotCostState && slotCostState.val ? Number(slotCostState.val) : 0;

							if (!periodMap[periodKey].slots[slotName]) {
								periodMap[periodKey].slots[slotName] = { consumption: 0, cost: 0 };
							}
							periodMap[periodKey].slots[slotName].consumption += slotCons;
							periodMap[periodKey].slots[slotName].cost += slotCost;
						}
					}
				}
			}
		}

		// Filter periodMap: only keep periods with a complete dataset of past/elapsed days
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		yesterday.setHours(0, 0, 0, 0);

		// Get monthly standing charge from masterData
		const standingChargeEuros =
			this.masterData && this.masterData.monthlyStandingCharge ? this.masterData.monthlyStandingCharge : 0;
		this.log.debug(`aggregateHistory using standingChargeEuros: ${standingChargeEuros}`);

		for (const [key, pData] of Object.entries(periodMap)) {
			let isComplete = true;
			const checkStart = new Date(pData.start);
			const checkEnd = pData.end < yesterday ? new Date(pData.end) : new Date(yesterday);

			const currentCheck = new Date(checkStart);
			while (currentCheck <= checkEnd) {
				const dateStr = `${currentCheck.getFullYear()}-${String(currentCheck.getMonth() + 1).padStart(2, '0')}-${String(currentCheck.getDate()).padStart(2, '0')}`;
				if (!existingDays.has(dateStr)) {
					isComplete = false;
					this.log.debug(`Period starting ${key} is incomplete: missing day ${dateStr}`);
					break;
				}
				currentCheck.setDate(currentCheck.getDate() + 1);
			}

			if (!isComplete) {
				delete periodMap[key];
			}
		}

		for (const [year, yData] of Object.entries(yearMap)) {
			await this.writeStateObject(
				`history.${year}.totalConsumption`,
				`Year ${year} Consumption`,
				parseFloat(yData.consumption.toFixed(3)),
			);
			await this.writeStateObject(
				`history.${year}.totalCost`,
				`Year ${year} Cost`,
				parseFloat(yData.cost.toFixed(2)),
				'value',
				'number',
				'€',
			);

			for (const [month, mData] of Object.entries(yData.months)) {
				await this.writeStateObject(
					`history.${year}.${month}.totalConsumption`,
					`Month ${year}-${month} Consumption`,
					parseFloat(mData.consumption.toFixed(3)),
				);
				await this.writeStateObject(
					`history.${year}.${month}.totalCost`,
					`Month ${year}-${month} Cost`,
					parseFloat(mData.cost.toFixed(2)),
					'value',
					'number',
					'€',
				);
			}
		}

		await this.writeStateObject(
			'octopus.currentMonth.totalConsumption',
			'Current Month Consumption',
			parseFloat(currentMonthTotals.consumption.toFixed(3)),
		);
		await this.writeStateObject(
			'octopus.currentMonth.totalCost',
			'Current Month Cost',
			parseFloat(currentMonthTotals.cost.toFixed(2)),
			'value',
			'number',
			'€',
		);

		const daysInCurrentMonth = new Date(yesterday.getFullYear(), yesterday.getMonth() + 1, 0).getDate();
		const elapsedDaysInMonth = yesterday.getDate();
		const proportionalMonthCharge = standingChargeEuros * (elapsedDaysInMonth / daysInCurrentMonth);
		const currentMonthCostWithStandingCharge = currentMonthTotals.cost + proportionalMonthCharge;

		await this.writeStateObject(
			'octopus.currentMonth.totalCostWithStandingCharge',
			'Current Month Cost incl. Standing Charge',
			parseFloat(currentMonthCostWithStandingCharge.toFixed(2)),
			'value',
			'number',
			'€',
		);

		// Keep track of active object IDs for garbage collection
		const activePeriodIds = new Set();
		activePeriodIds.add(`${this.namespace}.octopus.periods`);
		activePeriodIds.add(`${this.namespace}.octopus.periods.current`);
		activePeriodIds.add(`${this.namespace}.octopus.periods.current.startDate`);
		activePeriodIds.add(`${this.namespace}.octopus.periods.current.endDate`);
		activePeriodIds.add(`${this.namespace}.octopus.periods.current.totalConsumption`);
		activePeriodIds.add(`${this.namespace}.octopus.periods.current.totalCost`);
		activePeriodIds.add(`${this.namespace}.octopus.periods.current.totalCostWithStandingCharge`);

		// Write all dynamic period states
		for (const [key, pData] of Object.entries(periodMap)) {
			const basePath = `octopus.periods.${key}`;
			activePeriodIds.add(`${this.namespace}.${basePath}`);
			activePeriodIds.add(`${this.namespace}.${basePath}.startDate`);
			activePeriodIds.add(`${this.namespace}.${basePath}.endDate`);
			activePeriodIds.add(`${this.namespace}.${basePath}.totalConsumption`);
			activePeriodIds.add(`${this.namespace}.${basePath}.totalCost`);
			activePeriodIds.add(`${this.namespace}.${basePath}.totalCostWithStandingCharge`);

			await this.setObjectNotExistsAsync(basePath, {
				type: 'channel',
				common: { name: `Period ${formatDateStr(pData.start)} to ${formatDateStr(pData.end)}` },
				native: {},
			});

			await this.writeStateObject(
				`${basePath}.startDate`,
				'Period Start Date',
				formatDateStr(pData.start),
				'text',
				'string',
			);
			await this.writeStateObject(
				`${basePath}.endDate`,
				'Period End Date',
				formatDateStr(pData.end),
				'text',
				'string',
			);
			await this.writeStateObject(
				`${basePath}.totalConsumption`,
				'Period Total Consumption',
				parseFloat(pData.consumption.toFixed(3)),
			);
			await this.writeStateObject(
				`${basePath}.totalCost`,
				'Period Total Cost',
				parseFloat(pData.cost.toFixed(2)),
				'value',
				'number',
				'€',
			);

			const checkEnd = pData.end < yesterday ? new Date(pData.end) : new Date(yesterday);
			const totalDays = Math.round((pData.end.getTime() - pData.start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
			const elapsedDays = Math.round((checkEnd.getTime() - pData.start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
			const proportionalCharge = standingChargeEuros * (elapsedDays / totalDays);
			const totalCostWithStandingCharge = pData.cost + proportionalCharge;

			await this.writeStateObject(
				`${basePath}.totalCostWithStandingCharge`,
				'Period Total Cost incl. Standing Charge',
				parseFloat(totalCostWithStandingCharge.toFixed(2)),
				'value',
				'number',
				'€',
			);

			// Write slot states for this period
			for (const [slotName, slotData] of Object.entries(pData.slots)) {
				const capSlot = slotName.toUpperCase();
				const consPath = `${basePath}.${slotName}Consumption`;
				const costPath = `${basePath}.${slotName}Cost`;

				activePeriodIds.add(`${this.namespace}.${consPath}`);
				activePeriodIds.add(`${this.namespace}.${costPath}`);

				await this.writeStateObject(
					consPath,
					`${capSlot} Consumption`,
					parseFloat(slotData.consumption.toFixed(3)),
				);
				await this.writeStateObject(
					costPath,
					`${capSlot} Cost`,
					parseFloat(slotData.cost.toFixed(2)),
					'value',
					'number',
					'€',
				);
			}

			// If this is the current active period containing today's date
			if (today >= pData.start && today <= pData.end) {
				await this.writeStateObject(
					'octopus.periods.current.startDate',
					'Current Period Start Date',
					formatDateStr(pData.start),
					'text',
					'string',
				);
				await this.writeStateObject(
					'octopus.periods.current.endDate',
					'Current Period End Date',
					formatDateStr(pData.end),
					'text',
					'string',
				);
				await this.writeStateObject(
					'octopus.periods.current.totalConsumption',
					'Current Period Consumption',
					parseFloat(pData.consumption.toFixed(3)),
				);
				await this.writeStateObject(
					'octopus.periods.current.totalCost',
					'Current Period Cost',
					parseFloat(pData.cost.toFixed(2)),
					'value',
					'number',
					'€',
				);
				await this.writeStateObject(
					'octopus.periods.current.totalCostWithStandingCharge',
					'Current Period Cost incl. Standing Charge',
					parseFloat(totalCostWithStandingCharge.toFixed(2)),
					'value',
					'number',
					'€',
				);

				for (const [slotName, slotData] of Object.entries(pData.slots)) {
					const capSlot = slotName.toUpperCase();
					const curConsPath = `octopus.periods.current.${slotName}Consumption`;
					const curCostPath = `octopus.periods.current.${slotName}Cost`;

					activePeriodIds.add(`${this.namespace}.${curConsPath}`);
					activePeriodIds.add(`${this.namespace}.${curCostPath}`);

					await this.writeStateObject(
						curConsPath,
						`Current Period ${capSlot} Consumption`,
						parseFloat(slotData.consumption.toFixed(3)),
					);
					await this.writeStateObject(
						curCostPath,
						`Current Period ${capSlot} Cost`,
						parseFloat(slotData.cost.toFixed(2)),
						'value',
						'number',
						'€',
					);
				}
			}
		}

		// Cleanup old/legacy objects under octopus.periods.*
		const prefix = `${this.namespace}.octopus.periods.`;
		for (const id of Object.keys(objects)) {
			if (id.startsWith(prefix) && !activePeriodIds.has(id)) {
				this.log.info(`Deleting legacy period object: ${id}`);
				await this.delObjectAsync(id.substring(this.namespace.length + 1));
			}
		}
	}

	async updateHistoryJson(adapterObjects) {
		this.log.debug('Updating history JSON arrays...');
		const objects = adapterObjects || (await this.getAdapterObjectsAsync());
		const historyPrefix = `${this.namespace}.history.`;

		const dates = new Set();
		for (const id of Object.keys(objects)) {
			if (id.startsWith(historyPrefix)) {
				const relativeId = id.substring(historyPrefix.length);
				const parts = relativeId.split('.');
				if (
					parts.length >= 3 &&
					/^\d{4}$/.test(parts[0]) &&
					/^\d{2}$/.test(parts[1]) &&
					/^\d{2}$/.test(parts[2])
				) {
					dates.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
				}
			}
		}

		const sortedDates = Array.from(dates).sort();
		const octopusHistory = [];
		const inexogyHistory = [];

		for (const dateStr of sortedDates) {
			const [year, month, day] = dateStr.split('.').map(Number);
			const timestamp = new Date(year, month - 1, day).getTime();
			const basePath = `history.${dateStr}`;

			const dayObj = {
				date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
				timestamp: timestamp,
				total: (await this.getStateAsync(`${basePath}.octopus.dailyConsumption`))?.val || 0,
				totalCost: (await this.getStateAsync(`${basePath}.octopus.totalCost`))?.val || 0,
			};

			if (this.masterData && this.masterData.rates) {
				for (const rate of this.masterData.rates) {
					const name = this.sanitizeIdSegment(rate.name).toLowerCase();
					dayObj[name] = (await this.getStateAsync(`${basePath}.octopus.${name}Consumption`))?.val || 0;
					dayObj[`${name}Cost`] = (await this.getStateAsync(`${basePath}.octopus.${name}Cost`))?.val || 0;
				}
			}

			// Add EnWG fields if active for this date
			const targetDate = new Date(year, month - 1, day);
			if (this.isEnwgActiveForDate(targetDate, this.config)) {
				for (const slotName of ['nt', 'st', 'ht']) {
					dayObj[`${slotName}Consumption`] =
						(await this.getStateAsync(`${basePath}.octopus.${slotName}Consumption`))?.val || 0;
					dayObj[`${slotName}Cost`] =
						(await this.getStateAsync(`${basePath}.octopus.${slotName}Cost`))?.val || 0;
					dayObj[`${slotName}CostNet`] =
						(await this.getStateAsync(`${basePath}.octopus.${slotName}CostNet`))?.val || 0;
				}
			}

			octopusHistory.push(dayObj);

			if (this.hasInexogy) {
				const inxDayObj = {
					date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
					timestamp: timestamp,
					total: (await this.getStateAsync(`${basePath}.inexogy.dailyConsumption`))?.val || 0,
				};

				if (this.masterData && this.masterData.rates) {
					for (const rate of this.masterData.rates) {
						const name = this.sanitizeIdSegment(rate.name).toLowerCase();
						inxDayObj[name] =
							(await this.getStateAsync(`${basePath}.inexogy.${name}Consumption`))?.val || 0;
					}
				}

				if (this.isEnwgActiveForDate(targetDate, this.config)) {
					for (const slotName of ['nt', 'st', 'ht']) {
						inxDayObj[`${slotName}Consumption`] =
							(await this.getStateAsync(`${basePath}.inexogy.${slotName}Consumption`))?.val || 0;
					}
				}

				inexogyHistory.push(inxDayObj);
			}
		}

		await this.setStateAsync('octopus.historyJson', { val: JSON.stringify(octopusHistory), ack: true });
		if (this.hasInexogy) {
			await this.setStateAsync('inexogy.historyJson', { val: JSON.stringify(inexogyHistory), ack: true });
		}
	}

	onUnload(callback) {
		try {
			if (this.syncInterval) {
				this.clearTimeout(this.syncInterval);
			}
			if (this.syncTimeout) {
				this.clearTimeout(this.syncTimeout);
			}
			if (this.smartChargeTimeout) {
				this.clearTimeout(this.smartChargeTimeout);
			}
			callback();
		} catch {
			callback();
		}
	}
}

if (require.main !== module) {
	module.exports = options => new EnergyCompare(options);
} else {
	new EnergyCompare();
}
