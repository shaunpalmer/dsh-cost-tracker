// ============================================================
// DSH cost tracker — three-state view normalization.
//
// Dashboard source modes: Local / Local + Cloud / Cloud Only.
// This module handles shape normalization and merging only; it does not render UI.
//   - normalizeCloudDash: fills cloud responses into the local buildDashboard shape.
//   - mergeDash: combines local and cloud data field-by-field.
//
// Key invariant: the server-side cloud-rest view already excludes this machine's
// DSH source, so mergeDash(local, cloudWithoutSelf) equals the global total while
// counting this machine exactly once.
//
// The same implementation is exported as ESM for Node tests and registered as a
// browser ModuleLoader bundle for the DSH client.
// ============================================================

export const BOARD_VIEWS = [
	{ id: "local", label: "Local" },
	{ id: "local+cloud", label: "Local + Cloud" },
	{ id: "cloud", label: "Cloud Only" },
];

export const BOARD_DIMS = [
	{ id: "total", label: "Total" },
	{ id: "device", label: "By Device" },
	{ id: "agent", label: "By Agent" },
	{ id: "model", label: "By Model" },
	{ id: "project", label: "By Project" },
];

export function zeroSlice() { return { real: 0, calls: 0, tokens: 0, sub: 0, subCalls: 0, subTokens: 0 }; }

export function r2(x) { return Math.round((Number(x) || 0) * 100) / 100; }

export function addSlice(a, b) {
	const x = a || zeroSlice(), y = b || zeroSlice();
	return {
		real: (x.real || 0) + (y.real || 0),
		calls: (x.calls || 0) + (y.calls || 0),
		tokens: (x.tokens || 0) + (y.tokens || 0),
		sub: (x.sub || 0) + (y.sub || 0),
		subCalls: (x.subCalls || 0) + (y.subCalls || 0),
		subTokens: (x.subTokens || 0) + (y.subTokens || 0),
	};
}

/**
 * Map cloud slice field names to the local shape. Overview responses use
 * `realCost` / `subEquivalent`, while `/api/v1/plugin-view` uses `real` / `sub`.
 * Missing fields are treated as zero so rendering remains safe.
 */
export function cloudSlices(cloud) {
	const pick = (s) => {
		if (!s) return null;
		return Object.assign(zeroSlice(), s, {
			real: Number(s.real != null ? s.real : (s.realCost != null ? s.realCost : 0)) || 0,
			sub: Number(s.sub != null ? s.sub : (s.subCost != null ? s.subCost : (s.subEquivalent != null ? s.subEquivalent : 0))) || 0,
			calls: Number(s.calls) || 0,
			tokens: Number(s.tokens) || 0,
			subCalls: Number(s.subCalls) || 0,
			subTokens: Number(s.subTokens) || 0,
		});
	};
	const all = pick(cloud.all) || zeroSlice();
	const allRaw = cloud.all || {};
	const summary = cloud.summary || {};
	return {
		today: pick(cloud.today) || zeroSlice(),
		month: pick(cloud.month) || zeroSlice(),
		all,
		summary: {
			real: Number(summary.real != null ? summary.real : (summary.realCost != null ? summary.realCost : all.real)) || 0,
			realCalls: Number(summary.realCalls != null ? summary.realCalls : (allRaw.calls != null ? allRaw.calls : all.calls)) || 0,
			realTokens: Number(summary.realTokens != null ? summary.realTokens : (allRaw.tokens != null ? allRaw.tokens : all.tokens)) || 0,
			sub: Number(summary.sub != null ? summary.sub : (summary.subEquivalent != null ? summary.subEquivalent : summary.subCost != null ? summary.subCost : all.sub)) || 0,
			subCalls: Number(summary.subCalls != null ? summary.subCalls : all.subCalls) || 0,
			subTokens: Number(summary.subTokens != null ? summary.subTokens : all.subTokens) || 0,
			cost: Number(summary.cost != null ? summary.cost : all.real + all.sub) || 0,
			calls: Number(summary.calls != null ? summary.calls : all.calls + all.subCalls) || 0,
			tokens: Number(summary.tokens != null ? summary.tokens : all.tokens + all.subTokens) || 0,
			peakCost: Number(summary.peakCost) || 0,
			offCost: Number(summary.offCost) || 0,
			flatCost: Number(summary.flatCost) || 0,
			driftAbs: Number(summary.driftAbs) || 0,
			estimatedRows: Number(summary.estimatedRows) || 0,
			input: Number(summary.input) || 0,
			output: Number(summary.output) || 0,
			cacheRead: Number(summary.cacheRead) || 0,
			cacheWrite: Number(summary.cacheWrite) || 0,
			reasoning: Number(summary.reasoning) || 0,
		},
	};
}

/**
 * Normalize a cloud response to the local buildDashboard shape.
 *
 * Cost fields must be mapped explicitly. Cloud responses call them `realCost`
 * and `subEquivalent`, while local cards read `real` and `sub`. Earlier versions
 * passed the original fields through unchanged, which produced zero-value cost
 * cards even though call and token counts were correct.
 */
export function normalizeCloudDash(cloud, fallbackDays) {
	if (!cloud || cloud.ok === false) return null;
	const s = cloudSlices(cloud);
	return Object.assign({}, cloud, {
		days: cloud.days || fallbackDays || 7,
		today: s.today,
		month: s.month,
		all: s.all,
		summary: s.summary,
		byDay: cloud.byDay || [],
		byModel: cloud.byModel || [],
		byModelDay: (cloud.byModelDay || []).map((m) => Object.assign({}, m, {
			days: (m.days || []).map((d) => Object.assign({ calls: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, d)),
		})),
		recent: cloud.recent || [],
		devices: cloud.devices || [],
		sources: cloud.sources || [],
	});
}

/** Merge two buildDashboard-shaped datasets (local + cloud). */
export function mergeDash(local, cloud) {
	if (!local) return cloud;
	if (!cloud) return local;
	const byDayMap = new Map();
	for (const d of (local.byDay || [])) byDayMap.set(d.date, { date: d.date, label: d.label, peak: d.peak || 0, off: d.off || 0, flat: d.flat || 0 });
	for (const d of (cloud.byDay || [])) {
		const cur = byDayMap.get(d.date) || { date: d.date, label: d.label, peak: 0, off: 0, flat: 0 };
		cur.peak += d.peak || 0; cur.off += d.off || 0; cur.flat += d.flat || 0;
		byDayMap.set(d.date, cur);
	}
	const byModelMap = new Map();
	const addModel = (m) => {
		const cur = byModelMap.get(m.model) || { model: m.model, subscription: !!m.subscription, estimated: !!m.estimated, calls: 0, tokens: 0, cost: 0 };
		cur.calls += m.calls || 0; cur.tokens += m.tokens || 0; cur.cost += m.cost || 0;
		cur.subscription = cur.subscription && !!m.subscription;
		cur.estimated = cur.estimated || !!m.estimated;
		byModelMap.set(m.model, cur);
	};
	for (const m of (local.byModel || [])) addModel(m);
	for (const m of (cloud.byModel || [])) addModel(m);

	// Merge per-model daily rows by date so chart axes stay aligned.
	const byModelDayMap = new Map();
	const addModelDay = (m) => {
		const cur = byModelDayMap.get(m.model) || { model: m.model, subscription: !!m.subscription, estimated: !!m.estimated, days: new Map() };
		for (const d of (m.days || [])) {
			const cell = cur.days.get(d.date) || { date: d.date, label: d.label, calls: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
			cell.calls += d.calls || 0; cell.tokens += d.tokens || 0; cell.input += d.input || 0; cell.output += d.output || 0;
			cell.cacheRead += d.cacheRead || 0; cell.cacheWrite += d.cacheWrite || 0; cell.cost += d.cost || 0;
			cur.days.set(d.date, cell);
		}
		byModelDayMap.set(m.model, cur);
	};
	for (const m of (local.byModelDay || [])) addModelDay(m);
	for (const m of (cloud.byModelDay || [])) addModelDay(m);
	const dates = Array.from(byDayMap.keys()).sort();
	const byModelDay = Array.from(byModelDayMap.values()).map((m) => Object.assign({}, m, {
		days: dates.map((d) => m.days.get(d) || { date: d, label: byDayMap.get(d).label, calls: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
	}));
	return Object.assign({}, local, {
		source: "merged",
		realCost: r2((local.realCost || 0) + (cloud.realCost || 0)),
		realCalls: (local.realCalls || 0) + (cloud.realCalls || 0),
		realTokens: (local.realTokens || 0) + (cloud.realTokens || 0),
		subEquivalent: r2((local.subEquivalent || 0) + (cloud.subEquivalent || 0)),
		subCalls: (local.subCalls || 0) + (cloud.subCalls || 0),
		subTokens: (local.subTokens || 0) + (cloud.subTokens || 0),
		peakCost: r2((local.peakCost || 0) + (cloud.peakCost || 0)),
		offCost: r2((local.offCost || 0) + (cloud.offCost || 0)),
		flatCost: r2((local.flatCost || 0) + (cloud.flatCost || 0)),
		today: addSlice(local.today, cloud.today),
		month: addSlice(local.month, cloud.month),
		all: addSlice(local.all, cloud.all),
		byDay: dates.map((d) => byDayMap.get(d)),
		byModel: Array.from(byModelMap.values()).sort((a, b) => b.cost - a.cost),
		byModelDay,
		recent: (cloud.recent || []).concat(local.recent || []).slice(0, 20),
		devices: cloud.devices || [],
		sources: cloud.sources || [],
		asOf: cloud.asOf || 0,
	});
}

// ------------------------------------------------------------
// Browser bundle registration. client.js obtains this through require("./view").
// ------------------------------------------------------------
/* istanbul ignore next */
if (typeof window !== "undefined" && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === "function") {
	window.__ModuleLoader__.load({
		id: "@shaunpalmer/dsh-cost-tracker/view",
		factory: () => ({
			BOARD_VIEWS, BOARD_DIMS, zeroSlice, addSlice, r2, normalizeCloudDash, mergeDash, cloudSlices,
		}),
	});
}
