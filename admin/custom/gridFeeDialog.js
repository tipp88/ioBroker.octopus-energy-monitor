// ES module federation entry for Admin's jsonConfig custom component loader.
// Use the host's React instance so hooks work with both Admin 7 and Admin 8.
let React;
let mui;

/**
 * Initialize the component with the React instance shared by the Admin host.
 *
 * @param {object} scope Module federation share scope
 */
export async function init(scope) {
	async function load(name) {
		const versions = Object.values(scope[name]);
		const shared = versions.find(entry => entry.loaded) || versions[0];
		return (await shared.get())();
	}
	const [react, material] = await Promise.all([load('react'), load('@mui/material')]);
	React = react.default || react;
	mui = material.Button ? material : material.default;
}

/**
 * Provide the component collection requested by jsonConfig.
 *
 * @param {string} name Exposed module name
 */
export async function get(name) {
	if (name !== './Components') {
		throw new Error('Unknown grid fee component');
	}
	return () => ({ default: { GridFeeDialog } });
}

function GridFeeDialog(props) {
	const { createElement: h, useEffect, useRef, useState } = React;
	const { oContext, data, alive } = props;
	const latest = useRef(props);
	latest.current = props;
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState(null);
	const { Button, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions } = mui;
	const config = oContext.systemConfig || props.systemConfig;
	const suppliedLanguage = config?.common?.language || config?.language;
	const [loadedLanguage, setLoadedLanguage] = useState(null);
	useEffect(() => {
		if (suppliedLanguage) {
			return;
		}
		let active = true;
		oContext.socket
			.getObject('system.config')
			.then(obj => {
				if (active) setLoadedLanguage(obj?.common?.language);
			})
			.catch(() => {}); // No read permission: use the default translation, never the client locale.
		return () => {
			active = false;
		};
	}, [suppliedLanguage, oContext.socket]);
	const language = suppliedLanguage || loadedLanguage || 'en';
	const de = language.toLowerCase().split(/[-_]/)[0] === 'de';
	const tr = (german, english) => (de ? german : english);
	const enabled = alive && data.enwgEnabled && data.enwgAutoGridFees;
	const account = data.octopusAccount;
	useEffect(() => {
		setResult(null);
	}, [enabled, account]);

	function apply(settings) {
		const current = latest.current;
		if (
			!current.alive ||
			!current.data.enwgEnabled ||
			!current.data.enwgAutoGridFees ||
			current.data.octopusAccount !== account
		) {
			return;
		}
		const draft = { ...current.data, ...settings };
		current.onChange(draft, undefined, () => current.oContext.forceUpdate(Object.keys(settings), draft));
	}

	async function fetchFees() {
		setBusy(true);
		let response;
		let timer;
		try {
			const request = oContext.socket.sendTo(`${oContext.adapterName}.${oContext.instance}`, 'previewGridFees', {
				account,
			});
			response = await Promise.race([
				request,
				new Promise(resolve => {
					timer = setTimeout(() => resolve({ error: 'gridFeeTimeout' }), 60000);
				}),
			]);
		} catch {
			response = { error: 'gridFeeSocketFailed' };
		} finally {
			clearTimeout(timer);
			setBusy(false);
		}
		if (
			latest.current.data.octopusAccount !== account ||
			!latest.current.data.enwgAutoGridFees ||
			!latest.current.data.enwgEnabled
		) {
			return;
		}
		if (response?.native) {
			apply(response.native);
		}
		setResult(response && typeof response === 'object' ? response : { error: 'gridFeeInvalidReply' });
	}

	const preview = result?.preview;
	const amount = value => Number(value).toLocaleString(de ? 'de-DE' : 'en-GB', { maximumFractionDigits: 12 });
	let body;
	if (preview) {
		const fees = preview.settings;
		body = h(
			'div',
			null,
			h(
				'p',
				null,
				tr(
					`Octopus meldet ${preview.module} für den ${preview.date}.`,
					`Octopus reported ${preview.module} for ${preview.date}.`,
				),
			),
			h(
				'ul',
				null,
				...['NT', 'HT', 'ST'].map(tariff => {
					const windows = fees.enwgTimeWindows
						.filter(w => w.tariff === tariff)
						.map(w => `${w.startTime}–${w.endTime}`)
						.join(', ');
					const times = tariff === 'ST' ? tr('übrige Zeiten', 'remaining hours') : windows;
					const price = fees[`enwgGridFee${tariff[0]}${tariff[1].toLowerCase()}`];
					return h(
						'li',
						{ key: tariff },
						`${tariff}: ${times} · ${amount(price)} €/kWh ${tr('netto', 'net')}`,
					);
				}),
			),
			h(
				'p',
				null,
				tr(
					'Diese Zeitfenster ganzjährig als manuellen Ersatz ins Formular übernehmen?',
					'Import these time windows as a year-round manual fallback?',
				),
			),
		);
	} else if (result?.native) {
		body = tr(
			'Modul-3-Werte ins Formular übernommen. Bitte prüfen und speichern.',
			'Module 3 values copied to the form. Review and save.',
		);
	} else if (result?.error === 'gridFeeAccountRequired') {
		body = tr(
			'Bitte Kontodaten speichern und warten, bis die Instanz den Netzbetreibercode geladen hat.',
			'Save the account details and wait for the instance to load the grid operator.',
		);
	} else if (result?.error === 'gridFeeInvalidSchedule') {
		body = `${tr('Tarifplan nicht verwendbar', 'Schedule unavailable')} (${(result.args || []).join(', ')}).`;
	} else if (result?.error === 'gridFeeRequestFailed') {
		body =
			tr('Abruf bei Octopus fehlgeschlagen', 'Octopus request failed') +
			(result.detail ? ` (${result.detail}).` : '.');
	} else if (result?.error === 'gridFeeSocketFailed' || result?.error === 'gridFeeTimeout') {
		body =
			result.error === 'gridFeeTimeout'
				? tr(
						'Die Instanz hat innerhalb von 60 Sekunden nicht geantwortet.',
						'The instance did not reply within 60 seconds.',
					)
				: tr('Admin konnte die Adapterinstanz nicht erreichen.', 'Admin could not reach the adapter instance.');
	} else {
		body = tr(
			'Unerwartete Antwort der Adapterinstanz. Bitte prüfen, ob Admin-Dateien und laufende Instanz denselben Stand haben.',
			'Unexpected adapter reply. Check that the Admin files and running instance are on the same version.',
		);
	}
	return h(
		'div',
		{ style: { padding: 8, width: 'min(100%, 50rem)', boxSizing: 'border-box' } },
		h(
			Button,
			{
				type: 'button',
				disabled: !enabled || busy,
				onClick: fetchFees,
				variant: 'contained',
				color: 'primary',
				fullWidth: true,
			},
			busy
				? tr('Abruf läuft …', 'Fetching …')
				: tr('Modul-3-Entgelte abrufen und übernehmen', 'Fetch and import Module 3 fees'),
		),
		result &&
			h(
				Dialog,
				{
					open: true,
					'aria-label': tr('Octopus-Netzentgelte', 'Octopus grid fees'),
					onClose: () => setResult(null),
					maxWidth: 'sm',
					fullWidth: true,
				},
				h(
					DialogTitle,
					null,
					preview
						? tr('Warnung: Modul 3 ist nicht aktiv', 'Warning: Module 3 is inactive')
						: tr('Octopus-Netzentgelte', 'Octopus grid fees'),
				),
				h(DialogContent, null, h(DialogContentText, { component: 'div' }, body)),
				h(
					DialogActions,
					null,
					h(
						Button,
						{
							type: 'button',
							variant: 'contained',
							color: 'primary',
							autoFocus: true,
							onClick: () => setResult(null),
						},
						preview ? tr('Abbrechen', 'Cancel') : 'OK',
					),
					preview &&
						h(
							Button,
							{
								type: 'button',
								variant: 'text',
								color: 'primary',
								onClick: () => {
									apply(preview.settings);
									setResult(null);
								},
							},
							tr('Trotzdem übernehmen', 'Import anyway'),
						),
				),
			),
	);
}
