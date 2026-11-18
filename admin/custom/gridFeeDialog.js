// ES module federation entry for Admin's jsonConfig custom component loader.
// Use the host's React instance so hooks work with both Admin 7 and Admin 8.
let React;

/**
 * Initialize the component with the React instance shared by the Admin host.
 *
 * @param {object} scope Module federation share scope
 */
export async function init(scope) {
	const versions = Object.values(scope.react);
	const shared = versions.find(entry => entry.loaded) || versions[0];
	const module = (await shared.get())();
	React = module.default || module;
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
	const dialog = useRef(null);
	const de = (oContext.systemConfig?.common?.language || navigator.language).startsWith('de');
	const tr = (german, english) => (de ? german : english);
	const enabled = alive && data.enwgEnabled && data.enwgAutoGridFees;
	const account = data.octopusAccount;
	useEffect(() => {
		if (result && dialog.current && !dialog.current.open) {
			dialog.current.showModal();
		}
	}, [result]);
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
		try {
			response = await oContext.socket.sendTo(`${oContext.adapterName}.${oContext.instance}`, 'previewGridFees', {
				account,
			});
		} catch {
			response = null;
		} finally {
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
		setResult(response && typeof response === 'object' ? response : { error: 'gridFeeRequestFailed' });
	}

	const preview = result?.preview;
	const style = { padding: '0.55em 1em', borderRadius: '4px', font: 'inherit', cursor: 'pointer' };
	const primary = {
		...style,
		backgroundColor: oContext.theme?.palette?.primary?.main || '#1976d2',
		color: oContext.theme?.palette?.primary?.contrastText || 'white',
		border: 0,
	};
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
					return h('li', { key: tariff }, `${tariff}: ${times} · ${amount(price)} €/kWh netto`);
				}),
			),
			h(
				'p',
				null,
				tr(
					'Als manuellen Ersatz für den angezeigten Monat ins Formular übernehmen?',
					'Use this schedule in the form as a manual fallback for the displayed month?',
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
		body = `${tr('Tarifplan nicht verwendbar', 'Schedule unavailable')} (${result.args.join(', ')}).`;
	} else {
		body = tr('Die Netzentgelte konnten nicht abgerufen werden.', 'The grid fee request failed.');
	}
	return h(
		'div',
		{ style: { padding: 8 } },
		h(
			'button',
			{
				type: 'button',
				disabled: !enabled || busy,
				onClick: fetchFees,
				style: { ...primary, opacity: enabled && !busy ? 1 : 0.5 },
			},
			busy
				? tr('Abruf läuft …', 'Fetching …')
				: tr('Modul-3-Entgelte abrufen und übernehmen', 'Fetch and import Module 3 fees'),
		),
		result &&
			h(
				'dialog',
				{
					ref: dialog,
					'aria-label': tr('Octopus-Netzentgelte', 'Octopus grid fees'),
					onClose: () => setResult(null),
					style: { border: 0, borderRadius: 8, padding: 24, maxWidth: 'min(32rem, 90vw)' },
				},
				h(
					'strong',
					null,
					preview
						? tr('Warnung: Modul 3 ist nicht aktiv', 'Warning: Module 3 is inactive')
						: tr('Octopus-Netzentgelte', 'Octopus grid fees'),
				),
				h('div', { style: { margin: '1em 0' } }, body),
				h(
					'div',
					{ style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
					h(
						'button',
						{ type: 'button', autoFocus: true, style, onClick: () => dialog.current.close() },
						'OK',
					),
					preview &&
						h(
							'button',
							{
								type: 'button',
								style: primary,
								onClick: () => {
									apply(preview.settings);
									dialog.current.close();
								},
							},
							tr('Trotzdem übernehmen', 'Import anyway'),
						),
				),
			),
	);
}
