// @ts-nocheck
import { extension_settings } from "../../../extensions.js";
import { power_user, loadMovingUIState } from "../../../power-user.js";
import { saveSettingsDebounced, getRequestHeaders } from "../../../../script.js";

const TOOL_NAME = "IronswornMove";
const ORACLE_TOOL_NAME = "IronswornOracle";
const PANEL_ID = "ironsworn-roll-panel";
const EXTENSION_NAME = "IronswornRoll";
const DATASWORN_URL = new URL("./classic.json", import.meta.url);
const DATASWORN_FALLBACK_URL =
	"https://raw.githubusercontent.com/rsek/datasworn/main/datasworn/classic/classic.json";
let moveCatalogPromise;
let dataswornPromise;
let assetCatalogPromise;
const DEFAULT_SETTINGS = {
	autoRoll: false,
	playSfx: true,
	autoContinue: false,
};
const ASSETS = {
	vikingShield: new URL("./assets/viking-shield.svg", import.meta.url).href,
	healingShield: new URL("./assets/healing-shield.svg", import.meta.url).href,
	starsStack: new URL("./assets/stars-stack.svg", import.meta.url).href,
	axeSword: new URL("./assets/axe-sword.svg", import.meta.url).href,
	fireDash: new URL("./assets/fire-dash.svg", import.meta.url).href,
	playerRollSound: new URL(
		"./assets/universfield-punch-impact-hit-567196.mp3",
		import.meta.url,
	).href,
	challengeRollSound: new URL(
		"./assets/universfield-cinematic-impact-hit-02-454665.mp3",
		import.meta.url,
	).href,
};

function getSettings() {
	extension_settings[EXTENSION_NAME] ??= {};
	Object.assign(
		extension_settings[EXTENSION_NAME],
		DEFAULT_SETTINGS,
		extension_settings[EXTENSION_NAME],
	);
	return extension_settings[EXTENSION_NAME];
}

async function initializeSettings() {
	if (!document.getElementById("ironsworn-roll-settings")) {
		const target = document.querySelector(
			"#extensions_settings2, #extensions_settings",
		);
		if (target) {
			const response = await fetch(new URL("./settings.html", import.meta.url));
			target.insertAdjacentHTML("beforeend", await response.text());
		}
	}
	const settings = getSettings();
	for (const [name, value] of Object.entries(DEFAULT_SETTINGS)) {
		const input = document.querySelector(`#ironsworn-${name}`);
		if (input) input.checked = Boolean(settings[name]);
	}
	document.querySelectorAll("[data-ironsworn-setting]").forEach((input) => {
		input.addEventListener("change", (event) => {
			settings[event.currentTarget.dataset.ironswornSetting] =
				event.currentTarget.checked;
			saveSettingsDebounced();
		});
	});
}

function enablePanelDragging(panel) {
	const grip = panel.querySelector(".drag-grabber");
	if (!(grip instanceof HTMLElement)) return;

	let pointerOffsetX = 0;
	let pointerOffsetY = 0;
	let dragging = false;

	const movePanel = (event) => {
		if (!dragging) return;
		panel.style.left = `${Math.max(0, event.clientX - pointerOffsetX)}px`;
		panel.style.top = `${Math.max(0, event.clientY - pointerOffsetY)}px`;
		panel.style.right = "auto";
		panel.style.bottom = "auto";
		panel.style.margin = "0";
		panel.setAttribute("data-dragged", "true");
	};

	const stopDragging = () => {
		if (!dragging) return;
		dragging = false;
		document.removeEventListener("pointermove", movePanel);
		document.removeEventListener("pointerup", stopDragging);

		if (power_user?.movingUIState) {
			const rect = panel.getBoundingClientRect();
			power_user.movingUIState[PANEL_ID] = {
				left: Math.round(rect.left),
				top: Math.round(rect.top),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
			};
			SillyTavern.getContext()?.saveSettingsDebounced?.();
		}
	};

	grip.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		const rect = panel.getBoundingClientRect();
		pointerOffsetX = event.clientX - rect.left;
		pointerOffsetY = event.clientY - rect.top;
		dragging = true;
		document.addEventListener("pointermove", movePanel);
		document.addEventListener("pointerup", stopDragging, { once: true });
		event.preventDefault();
	});
}

function rollDie(sides) {
	return Math.floor(Math.random() * sides) + 1;
}

function normalizeNumber(value, name) {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new Error(`${name} must be a finite number`);
	}
	return number;
}

function normalizeMoveName(name) {
	return String(name)
		.toLocaleLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function getEditDistance(left, right) {
	const distances = Array.from(
		{ length: right.length + 1 },
		(_, index) => index,
	);

	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		let previous = distances[0];
		distances[0] = leftIndex;

		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const current = distances[rightIndex];
			const substitutionCost =
				left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
			distances[rightIndex] = Math.min(
				distances[rightIndex] + 1,
				distances[rightIndex - 1] + 1,
				previous + substitutionCost,
			);
			previous = current;
		}
	}

	return distances[right.length];
}

function extractMoves(datasworn) {
	const moves = [];
	for (const category of Object.values(datasworn.moves ?? {})) {
		for (const move of Object.values(category.contents ?? {})) {
			if (move.type !== "move" || !move.name) continue;
			moves.push(move);
		}
	}
	return moves;
}

function extractOracles(datasworn) {
	const oracles = [];
	const visit = (value) => {
		if (!value || typeof value !== "object") return;
		if (value.type === "oracle_rollable" && value.name && value.rows) {
			oracles.push(value);
		}
		for (const child of Object.values(value)) visit(child);
	};
	visit(datasworn);
	return oracles;
}

async function loadDatasworn() {
	if (!dataswornPromise) {
		dataswornPromise = fetch(DATASWORN_URL)
			.then((response) => {
				if (!response.ok)
					throw new Error("Local Datasworn data is unavailable");
				return response.json();
			})
			.catch(async () => {
				const response = await fetch(DATASWORN_FALLBACK_URL);
				if (!response.ok)
					throw new Error("Remote Datasworn data is unavailable");
				return response.json();
			});
	}
	return dataswornPromise;
}

async function loadMoveCatalog() {
	if (!moveCatalogPromise) {
		moveCatalogPromise = loadDatasworn().then(extractMoves);
	}
	return moveCatalogPromise;
}

async function loadOracleCatalog() {
	return extractOracles(await loadDatasworn());
}

export async function resolveMove(moveName) {
	const moves = await loadMoveCatalog();
	const requestedName = normalizeMoveName(moveName);
	if (requestedName === "ask the oracle") {
		throw new Error(
			'Ask the Oracle is handled by the separate "IronswornAskOracle" tool. Call that tool instead.',
		);
	}
	const exactMatch = moves.find(
		(move) => normalizeMoveName(move.name) === requestedName,
	);
	if (exactMatch) return exactMatch;

	const matchingMoves = moves.filter((move) => {
		const normalizedName = normalizeMoveName(move.name);
		return (
			normalizedName.includes(requestedName) ||
			requestedName.includes(normalizedName)
		);
	});
	if (matchingMoves.length === 1) return matchingMoves[0];
	if (matchingMoves.length > 1) {
		return matchingMoves.sort(
			(left, right) =>
				getEditDistance(normalizeMoveName(left.name), requestedName) -
				getEditDistance(normalizeMoveName(right.name), requestedName),
		)[0];
	}

	const closestMove = moves
		.map((move) => ({
			move,
			distance: getEditDistance(normalizeMoveName(move.name), requestedName),
		}))
		.sort((left, right) => left.distance - right.distance)[0];
	const maximumDistance = Math.max(3, Math.floor(requestedName.length / 3));
	if (closestMove && closestMove.distance <= maximumDistance)
		return closestMove.move;

	const availableMoves = moves.map((move) => move.name).sort();
	throw new Error(
		`Move does not exist: "${moveName}". Available moves: ${availableMoves.join(", ")}`,
	);
}

function extractAssetCatalog(datasworn) {
	const assets = [];
	for (const collection of Object.values(datasworn.assets ?? {})) {
		if (typeof collection.contents !== "object" || collection.contents === null)
			continue;
		for (const asset of Object.values(collection.contents)) {
			if (asset.type !== "asset" || !asset.name) continue;
			assets.push(asset);
		}
	}
	return assets;
}

async function loadAssetCatalog() {
	if (!assetCatalogPromise) {
		assetCatalogPromise = loadDatasworn().then(extractAssetCatalog);
	}
	return assetCatalogPromise;
}

async function resolveAsset(assetName) {
	const assets = await loadAssetCatalog();
	const requestedName = normalizeMoveName(assetName);
	const exactMatch = assets.find(
		(asset) => normalizeMoveName(asset.name) === requestedName,
	);
	if (exactMatch) return exactMatch;

	const matchingAssets = assets.filter((asset) => {
		const normalizedName = normalizeMoveName(asset.name);
		return (
			normalizedName.includes(requestedName) ||
			requestedName.includes(normalizedName)
		);
	});
	if (matchingAssets.length === 1) return matchingAssets[0];
	if (matchingAssets.length > 1) {
		return matchingAssets.sort(
			(left, right) =>
				getEditDistance(normalizeMoveName(left.name), requestedName) -
				getEditDistance(normalizeMoveName(right.name), requestedName),
		)[0];
	}

	const closestAsset = assets
		.map((asset) => ({
			asset,
			distance: getEditDistance(normalizeMoveName(asset.name), requestedName),
		}))
		.sort((left, right) => left.distance - right.distance)[0];
	const maximumDistance = Math.max(3, Math.floor(requestedName.length / 3));
	if (closestAsset && closestAsset.distance <= maximumDistance)
		return closestAsset.asset;
	return null;
}

// A level of 1-3 unlocks that many of the asset's three abilities, in order.
async function resolveCharacterAssets(assetInputs) {
	const result = { resolved: [], unrecognized: [] };
	if (!Array.isArray(assetInputs)) return result;
	for (const input of assetInputs) {
		const name = String(input?.name ?? "").trim();
		if (!name) continue;
		const levelNumber = Number(input?.level);
		const level = Number.isFinite(levelNumber)
			? Math.min(3, Math.max(1, Math.round(levelNumber)))
			: 1;
		const assetDef = await resolveAsset(name);
		if (!assetDef) {
			result.unrecognized.push(name);
			continue;
		}
		const abilities = (assetDef.abilities ?? []).slice(0, level);
		result.resolved.push({ name: assetDef.name, level, abilities });
	}
	return result;
}

// Some assets (Alchemist's Create Elixir, Augur, etc.) grant an entirely new move.
function findAssetSubMove(resolvedAssets, requestedMoveName) {
	const requestedName = normalizeMoveName(requestedMoveName);
	for (const asset of resolvedAssets) {
		for (const ability of asset.abilities) {
			if (!ability.moves) continue;
			for (const subMove of Object.values(ability.moves)) {
				if (subMove?.name && normalizeMoveName(subMove.name) === requestedName) {
					return subMove;
				}
			}
		}
	}
	return null;
}

async function resolveMoveForRoll(requestedMoveName, resolvedAssets) {
	const assetMove = findAssetSubMove(resolvedAssets, requestedMoveName);
	if (assetMove) return assetMove;
	return resolveMove(requestedMoveName);
}

// Best-effort extraction of the mechanical effect from an ability's rule text.
function parseAssetAbilityEffects(text) {
	const effects = {};
	const bonusMatch = text.match(/\badd \+(\d+)\b/i);
	if (bonusMatch) effects.bonus = Number(bonusMatch[1]);
	if (/\breroll any dice\b/i.test(text)) effects.reroll = true;
	const momentumMatch = text.match(
		/take \+(\d+) momentum(?:\s+equal to[^.]+)? on (?:an?|the) ([a-z ]+?)(?=[.,]|$)/i,
	);
	if (momentumMatch) {
		effects.momentumBonus = Number(momentumMatch[1]);
		effects.momentumCondition = momentumMatch[2].trim().toLocaleLowerCase();
	}
	const harmMatch = text.match(/inflict \+(\d+) harm/i);
	if (harmMatch) effects.harmBonus = Number(harmMatch[1]);
	const experienceMatch = text.match(/take \+(\d+) experience/i);
	if (experienceMatch) effects.experienceBonus = Number(experienceMatch[1]);
	return effects;
}

function collectAssetEnhancements(move, resolvedAssets) {
	const candidates = [];
	for (const asset of resolvedAssets) {
		for (const ability of asset.abilities) {
			const entries = ability.enhance_moves;
			if (!Array.isArray(entries)) continue;
			for (const entry of entries) {
				if (entry.roll_type !== move.roll_type) continue;
				const enhancesList = entry.enhances;
				if (Array.isArray(enhancesList) && !enhancesList.includes(move._id))
					continue;
				candidates.push({
					assetName: asset.name,
					text: ability.text,
					conditionText:
						entry.trigger?.conditions
							?.map((condition) => condition.text)
							.filter(Boolean)
							.join("; ") || null,
					effects: parseAssetAbilityEffects(ability.text),
				});
			}
		}
	}
	return candidates;
}

function sumPreRollAssetEffects(selectedCandidates) {
	let bonus = 0;
	let reroll = false;
	for (const candidate of selectedCandidates) {
		if (candidate.effects.bonus) bonus += candidate.effects.bonus;
		if (candidate.effects.reroll) reroll = true;
	}
	return { bonus, reroll };
}

function sumConditionalAssetEffects(selectedCandidates, hitType) {
	let momentum = 0;
	let harm = 0;
	let experience = 0;
	const isHit = hitType === "strong hit" || hitType === "weak hit";
	for (const candidate of selectedCandidates) {
		const effects = candidate.effects;
		if (effects.momentumBonus && effects.momentumCondition) {
			const condition = effects.momentumCondition;
			const conditionMet = condition.includes("strong hit")
				? hitType === "strong hit"
				: condition.includes("weak hit")
					? hitType === "weak hit"
					: condition.includes("hit")
						? isHit
						: false;
			if (conditionMet) momentum += effects.momentumBonus;
		}
		if (effects.harmBonus && isHit) harm += effects.harmBonus;
		if (effects.experienceBonus && isHit) experience += effects.experienceBonus;
	}
	return { momentum, harm, experience };
}

function waitForAssetSelection(panel, candidates, moveName) {
	const content = panel.querySelector(".ironsworn-roll-content");
	const actions = panel.querySelector(".ironsworn-roll-actions");
	content.replaceChildren();
	actions?.replaceChildren();
	const title = document.createElement("h2");
	title.className = "ironsworn-roll-title";
	title.textContent = `${moveName}: Use an asset ability?`;
	const list = document.createElement("div");
	list.className = "ironsworn-asset-choice-list";
	const selected = new Set();
	candidates.forEach((candidate, index) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "ironsworn-asset-choice-option";
		const conditionLabel = candidate.conditionText
			? ` (${candidate.conditionText})`
			: "";
		button.textContent = `${candidate.assetName}${conditionLabel}: ${formatRuleText(candidate.text)}`;
		button.addEventListener("click", () => {
			button.classList.toggle("ironsworn-choice-selected");
			if (selected.has(index)) selected.delete(index);
			else selected.add(index);
		});
		list.append(button);
	});
	content.append(title, list);
	return new Promise((resolve) => {
		const confirmButton = document.createElement("button");
		confirmButton.type = "button";
		confirmButton.textContent = "Roll";
		confirmButton.addEventListener(
			"click",
			() => {
				panel.remove();
				resolve(candidates.filter((_, index) => selected.has(index)));
			},
			{ once: true },
		);
		actions.append(confirmButton);
	});
}

export async function resolveOracle(oracleName) {
	const oracles = await loadOracleCatalog();
	const requestedName = normalizeMoveName(oracleName);
	const exactMatch = oracles.find(
		(oracle) =>
			oracle._id === oracleName ||
			normalizeMoveName(oracle.name) === requestedName ||
			normalizeMoveName(oracle.canonical_name ?? "") === requestedName,
	);
	if (exactMatch) return exactMatch;

	const matchingOracles = oracles.filter((oracle) => {
		const names = [oracle.name, oracle.canonical_name]
			.filter(Boolean)
			.map(normalizeMoveName);
		return names.some(
			(name) => name.includes(requestedName) || requestedName.includes(name),
		);
	});
	if (matchingOracles.length === 1) return matchingOracles[0];
	if (matchingOracles.length > 1) {
		return matchingOracles.sort(
			(left, right) =>
				getEditDistance(normalizeMoveName(left.name), requestedName) -
				getEditDistance(normalizeMoveName(right.name), requestedName),
		)[0];
	}

	const closestOracle = oracles
		.map((oracle) => ({
			oracle,
			distance: Math.min(
				getEditDistance(normalizeMoveName(oracle.name), requestedName),
				getEditDistance(
					normalizeMoveName(oracle.canonical_name ?? ""),
					requestedName,
				),
			),
		}))
		.sort((left, right) => left.distance - right.distance)[0];
	const maximumDistance = Math.max(3, Math.floor(requestedName.length / 3));
	if (closestOracle && closestOracle.distance <= maximumDistance) {
		return closestOracle.oracle;
	}

	const availableOracles = oracles.map((oracle) => oracle.name).sort();
	throw new Error(
		`Oracle does not exist: "${oracleName}". Available oracles: ${availableOracles.join(", ")}`,
	);
}

export async function executeIronswornOracle(args) {
	const requestedOracleName = String(args?.oracle_name ?? "").trim();
	if (!requestedOracleName) throw new Error("oracle_name is required");
	const oracle = await resolveOracle(requestedOracleName);
	const result = rollOracleTable(oracle);

	return JSON.stringify({
		oracle: oracle.name,
		roll: result.roll,
		result: formatRuleText(result.text),
	});
}

function rollOracleTable(oracle) {
	const roll = rollDie(100);
	const row = oracle.rows.find(
		(candidate) => roll >= candidate.min && roll <= candidate.max,
	);
	if (!row)
		throw new Error(`Oracle "${oracle.name}" has no result for roll ${roll}`);
	return { roll, text: row.text };
}

function collectOracleRolls(value, results = []) {
	if (!value || typeof value !== "object") return results;
	if (Array.isArray(value.oracle_rolls)) results.push(...value.oracle_rolls);
	for (const child of Object.values(value)) collectOracleRolls(child, results);
	return results;
}

async function resolveRequiredOracleResults(move) {
	const requirements = collectOracleRolls(move);
	const results = [];
	for (const requirement of requirements) {
		if (!requirement?.oracle) continue;
		const oracle = await resolveOracle(requirement.oracle);
		const result = rollOracleTable(oracle);
		results.push({
			oracle: oracle.name,
			roll: result.roll,
			result: formatRuleText(result.text),
			oracle_reason: "required_by_move",
		});
	}
	return results;
}

export function getHitType(playerValue, challengeDice) {
	const wins = challengeDice.filter((die) => playerValue > die).length;
	if (wins === 2) return "strong hit";
	if (wins === 1) return "weak hit";
	return "miss";
}

export function calculateIronswornRoll({
	stats_bonus,
	additional_bonus,
	momentum,
}) {
	const stats = normalizeNumber(stats_bonus, "stats_bonus");
	const additional = normalizeNumber(additional_bonus, "additional_bonus");
	const currentMomentum = normalizeNumber(momentum, "momentum");
	const actionDie = rollDie(6);
	const challengeDice = [rollDie(10), rollDie(10)];
	const actionDieCancelled =
		currentMomentum < 0 && actionDie === Math.abs(currentMomentum);
	const countedActionDie = actionDieCancelled ? 0 : actionDie;
	const playerValue = countedActionDie + stats + additional;
	const isMatch = challengeDice[0] === challengeDice[1];
	const hitType = getHitType(playerValue, challengeDice);
	const losingDice = challengeDice.filter((die) => playerValue <= die);
	const canUseMomentum = losingDice.some((die) => currentMomentum > die);

	return {
		actionDie,
		actionDieCancelled,
		challengeDice,
		isMatch,
		statsBonus: stats,
		additionalBonus: additional,
		playerValue,
		hitType,
		losingDice,
		canUseMomentum,
		momentum: currentMomentum,
	};
}

export function calculateProgressRoll({ progress }) {
	const progressValue = Math.floor(normalizeNumber(progress, "progress"));
	const challengeDice = [rollDie(10), rollDie(10)];
	const isMatch = challengeDice[0] === challengeDice[1];
	const hitType = getHitType(progressValue, challengeDice);

	return {
		progressValue,
		challengeDice,
		isMatch,
		hitType,
	};
}

function getPanel() {
	let panel = document.getElementById(PANEL_ID);
	if (panel) {
		panel.remove();
	}

	panel = document.createElement("section");
	panel.id = PANEL_ID;
	panel.className = "ironsworn-roll-panel";
	panel.setAttribute("data-dragged", "false");
	panel.innerHTML = `
        <div class="ironsworn-roll-content"></div>
        <div class="ironsworn-roll-actions"></div>
        <span class="drag-grabber" title="Move roll panel" aria-label="Move roll panel">
            <i class="fa-solid fa-grip"></i>
        </span>
    `;
	document.body.append(panel);
	enablePanelDragging(panel);
	return panel;
}

function normalizeMovingUIState() {
	const state = power_user?.movingUIState?.[PANEL_ID];
	if (!state) return;

	for (const property of [
		"left",
		"top",
		"right",
		"bottom",
		"width",
		"height",
	]) {
		const value = Number.parseFloat(state[property]);
		if (Number.isFinite(value)) state[property] = Math.round(value);
		else delete state[property];
	}
}

function wait(milliseconds) {
	return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function playSound(asset, volume = 0.7) {
	if (!getSettings().playSfx) return;
	const audio = new Audio(asset);
	audio.volume = volume;
	audio.play().catch(() => {});
}

function renderRoll(panel, actionName) {
	const content = panel.querySelector(".ironsworn-roll-content");
	content.replaceChildren();

	const title = document.createElement("h2");
	title.className = "ironsworn-roll-title";
	title.textContent = actionName;
	content.append(title);

	const actions = panel.querySelector(".ironsworn-roll-actions");
	actions.replaceChildren();
	const rollButton = document.createElement("button");
	rollButton.type = "button";
	rollButton.className = "ironsworn-roll-start";
	rollButton.textContent = "ROLL";
	actions.append(rollButton);

	return new Promise((resolve) =>
		rollButton.addEventListener("click", resolve, { once: true }),
	);
}

function formatRuleText(text) {
	return String(text ?? "")
		.replace(/\[([^\]]+)\]\(id:[^)]+\)/g, "$1")
		.replace(/\bid:classic\/(?:moves|oracles)\/[-\w/]+/g, (id) =>
			id.split("/").at(-1).replace(/_/g, " "),
		)
		.replace(/__(.*?)__/g, "$1")
		.replace(/\*\*(.*?)\*\*/g, "$1")
		.replace(/^(\s*)\*\s+/gm, "$1- ")
		.replace(/\*(.*?)\*/g, "$1")
		.replace(/_(.*?)_/g, "$1")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function cleanChoiceText(text) {
	return formatRuleText(text);
}

function getChoiceCount(text) {
	const match = text.match(/choose (?:up to )?(one|two|three|four|five)/i);
	if (!match) return 1;
	return { one: 1, two: 2, three: 3, four: 4, five: 5 }[
		match[1].toLocaleLowerCase()
	];
}

function extractMoveChoices(text) {
	const numericMatch = text.match(
		/up to \+?(\d+)\s+(health|spirit|supply|momentum)/i,
	);
	if (numericMatch) {
		const maximum = Number(numericMatch[1]);
		const track = numericMatch[2].toLocaleLowerCase();
		return {
			options: Array.from({ length: maximum + 1 }, (_, value) => ({
				label: `${value} ${track}`,
				value,
			})),
			maxSelections: 1,
			playerChoice: true,
		};
	}

	const options = text
		.split("\n")
		.filter((line) => /^\s*\*\s+/.test(line))
		.map((line) => cleanChoiceText(line.replace(/^\s*\*\s+/, "")))
		.filter(Boolean)
		.map((label) => ({ label, value: label }));
	if (options.length === 0) return null;
	const choiceData = {
		options,
		maxSelections: getChoiceCount(text),
		playerChoice: isPlayerChoice(options),
	};
	if (
		!choiceData.playerChoice &&
		/\bchoose\s+(?:one|two|three|four|five)\b/i.test(text) &&
		options.some(({ label }) =>
			/\b(?:health|spirit|supply|momentum|harm|stress|initiative|progress|experience)\b/i.test(
				label,
			),
		)
	) {
		choiceData.playerChoice = true;
	}
	return choiceData;
}

function isPlayerChoice(options) {
	return options.some(({ label }) =>
		/(?:^|\b)(?:take|suffer|mark|clear|spend|gain|lose|add|remove|inflict|reroll|retain|prepare|focus|partake|relax|recuperate|bolster|sacrifice|supply|health|spirit|momentum|progress|experience|initiative|harm|stress|asset|vow|bond|quest)\b/i.test(
			label,
		),
	);
}

function renderChoicePanel(panel, titleText) {
	const content = panel.querySelector(".ironsworn-roll-content");
	const actions = panel.querySelector(".ironsworn-roll-actions");
	actions?.remove();
	content.replaceChildren();
	const title = document.createElement("h2");
	title.className = "ironsworn-roll-title";
	title.textContent = titleText;
	content.append(title);
	if (actions) panel.append(actions);
}

function waitForMoveResolution(panel, moveText) {
	const choices = extractMoveChoices(moveText);
	const actions = panel.querySelector(".ironsworn-roll-actions");
	actions.replaceChildren();
	if (!choices?.playerChoice) {
		panel.remove();
		return Promise.resolve({
			choice: choices?.options ?? null,
			choiceData: choices,
		});
	}
	renderChoicePanel(
		panel,
		panel.querySelector(".ironsworn-roll-title")?.textContent ?? "Choose",
	);
	return waitForChoice(panel, choices).then((choice) => ({
		choice,
		choiceData: choices,
	}));
}

function waitForChoice(panel, choices) {
	const actions = panel.querySelector(".ironsworn-roll-actions");
	const selected = new Set();
	let resolveChoice;
	const promise = new Promise((resolve) => {
		resolveChoice = (value) => {
			panel.remove();
			resolve(value);
		};
	});
	const buttons = choices.options.map((option) => {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = option.label;
		button.addEventListener("click", () => {
			if (choices.maxSelections === 1) {
				resolveChoice(option.value);
				return;
			}
			if (selected.has(option.value)) {
				selected.delete(option.value);
				button.classList.remove("ironsworn-choice-selected");
			} else if (selected.size < choices.maxSelections) {
				selected.add(option.value);
				button.classList.add("ironsworn-choice-selected");
			}
			if (selected.size === choices.maxSelections) {
				resolveChoice([...selected]);
			}
		});
		actions.append(button);
		return button;
	});
	void buttons;
	return promise;
}

function renderProgressDice(panel, roll) {
	const content = panel.querySelector(".ironsworn-roll-content");
	const diceStage = document.createElement("div");
	diceStage.className = "ironsworn-dice-stage";
	diceStage.setAttribute(
		"aria-label",
		`Progress roll ${roll.progressValue} vs challenge dice ${roll.challengeDice.join(" and ")}`,
	);
	const sprites = document.createElement("div");
	sprites.className = "ironsworn-roll-sprites";
	sprites.append(
		createSprite(roll.progressValue, ASSETS.vikingShield, "player", "progress"),
	);
	const layout = document.createElement("div");
	layout.className = "ironsworn-roll-layout";
	const actions = panel.querySelector(".ironsworn-roll-actions");
	actions.replaceChildren();
	layout.append(sprites, actions);
	diceStage.append(layout);
	content.append(diceStage);
}

function createSprite(value, asset, type, role) {
	const sprite = document.createElement("div");
	sprite.className = `ironsworn-roll-sprite ironsworn-roll-sprite-${type} ironsworn-roll-sprite-hidden`;
	if (type === "player" && value < 0)
		sprite.classList.add("ironsworn-roll-sprite-negative");
	sprite.dataset.role = role;
	sprite.dataset.value = String(value);
	const number = document.createElement("strong");
	number.className = "ironsworn-roll-number";
	number.textContent = value;
	const image = document.createElement("img");
	image.src = asset;
	image.alt = "";
	image.setAttribute("aria-hidden", "true");
	sprite.append(number, image);
	return sprite;
}

function renderDice(panel, roll) {
	const content = panel.querySelector(".ironsworn-roll-content");
	const diceStage = document.createElement("div");
	diceStage.className = "ironsworn-dice-stage";
	diceStage.setAttribute(
		"aria-label",
		`Player roll ${roll.playerValue}: d6 ${roll.actionDie}, stat bonus ${roll.statsBonus}, bonus ${roll.additionalBonus}; challenge dice ${roll.challengeDice.join(" and ")}`,
	);
	const sprites = document.createElement("div");
	sprites.className = "ironsworn-roll-sprites";
	const displayedActionDie = roll.actionDieCancelled ? 0 : roll.actionDie;
	sprites.append(
		createSprite(displayedActionDie, ASSETS.vikingShield, "player", "action"),
		createSprite(roll.statsBonus, ASSETS.healingShield, "player", "stats"),
		createSprite(
			roll.additionalBonus,
			ASSETS.starsStack,
			"player",
			"additional",
		),
	);
	if (roll.actionDieCancelled)
		sprites
			.querySelector('[data-role="action"]')
			.classList.add("ironsworn-roll-sprite-negative");
	const layout = document.createElement("div");
	layout.className = "ironsworn-roll-layout";
	const actions = panel.querySelector(".ironsworn-roll-actions");
	actions.replaceChildren();
	layout.append(sprites, actions);
	diceStage.append(layout);
	content.append(diceStage);
}

async function animateProgressRoll(panel, roll) {
	const content = panel.querySelector(".ironsworn-roll-content");
	const show = (role) =>
		content
			.querySelector(`[data-role="${role}"]`)
			?.classList.remove("ironsworn-roll-sprite-hidden");

	await wait(250);
	playSound(ASSETS.playerRollSound);
	show("progress");
	await wait(1000);

	const sprites = content.querySelector(".ironsworn-roll-sprites");
	const orderedChallengeDice = [...roll.challengeDice].sort(
		(first, second) => first - second,
	);
	const addChallengeDie = (value, index) => {
		const challengeSprite = createSprite(
			value,
			ASSETS.axeSword,
			"challenge",
			`challenge-${index}`,
		);
		if (value >= roll.progressValue)
			challengeSprite.classList.add("ironsworn-roll-sprite-challenge-threat");
		sprites.append(challengeSprite);
		playSound(ASSETS.challengeRollSound);
		show(`challenge-${index}`);
	};
	addChallengeDie(orderedChallengeDice[0], 0);
	await wait(500);
	addChallengeDie(orderedChallengeDice[1], 1);
	await wait(500);

	const result = document.createElement("strong");
	result.className = `ironsworn-result ironsworn-result-${roll.hitType.replace(" ", "-")}`;
	result.textContent = roll.hitType;
	content.append(result);
}

async function animateRoll(panel, roll) {
	const content = panel.querySelector(".ironsworn-roll-content");
	const show = (role) =>
		content
			.querySelector(`[data-role="${role}"]`)
			?.classList.remove("ironsworn-roll-sprite-hidden");

	await wait(250);
	playSound(
		roll.actionDieCancelled
			? ASSETS.challengeRollSound
			: ASSETS.playerRollSound,
	);
	show("action");
	await wait(600);
	playSound(ASSETS.playerRollSound);
	show("stats");
	await wait(600);
	playSound(ASSETS.playerRollSound);
	show("additional");
	await wait(1000);

	const actionSprite = content.querySelector('[data-role="action"]');
	const bonusSprites = [
		content.querySelector('[data-role="stats"]'),
		content.querySelector('[data-role="additional"]'),
	];
	bonusSprites.forEach((sprite, index) => {
		sprite.style.setProperty(
			"--combine-x",
			index === 0 ? "calc(-100% - 6px)" : "calc(-200% - 12px)",
		);
		sprite.style.setProperty("--combine-y", "0px");
		sprite.classList.add("ironsworn-roll-sprite-combining");
	});
	await wait(650);
	const playerValueIsDangerous = roll.playerValue <= 0;
	actionSprite.querySelector(".ironsworn-roll-number").textContent =
		roll.playerValue;
	if (playerValueIsDangerous) {
		actionSprite.classList.add("ironsworn-roll-sprite-negative");
		playSound(ASSETS.challengeRollSound);
	}
	actionSprite.classList.add("ironsworn-roll-sprite-total");
	bonusSprites.forEach((sprite) =>
		sprite.classList.add("ironsworn-roll-sprite-fading"),
	);
	await wait(350);
	bonusSprites.forEach((sprite) => sprite.remove());
	await wait(300);

	const sprites = content.querySelector(".ironsworn-roll-sprites");
	const orderedChallengeDice = [...roll.challengeDice].sort(
		(first, second) => first - second,
	);
	const addChallengeDie = (value, index) => {
		const challengeSprite = createSprite(
			value,
			ASSETS.axeSword,
			"challenge",
			`challenge-${index}`,
		);
		if (value >= roll.playerValue)
			challengeSprite.classList.add("ironsworn-roll-sprite-challenge-threat");
		sprites.append(challengeSprite);
		playSound(ASSETS.challengeRollSound);
		show(`challenge-${index}`);
	};
	addChallengeDie(orderedChallengeDice[0], 0);
	await wait(500);
	addChallengeDie(orderedChallengeDice[1], 1);
	await wait(500);

	const result = document.createElement("strong");
	result.className = `ironsworn-result ironsworn-result-${roll.hitType.replace(" ", "-")}`;
	result.textContent = roll.hitType;
	content.append(result);
}

function applyMomentum(roll) {
	const remainingDice = roll.challengeDice.filter(
		(die) => !(roll.losingDice.includes(die) && die < roll.momentum),
	);
	const unresolvedLosingDice = remainingDice.filter(
		(die) => roll.playerValue <= die,
	).length;
	const wins = 2 - unresolvedLosingDice;
	if (wins === 2) return "strong hit";
	if (wins === 1) return "weak hit";
	return "miss";
}

function getMomentumPreviewDice(roll) {
	return roll.challengeDice.map((die) =>
		roll.losingDice.includes(die) && die < roll.momentum ? 0 : die,
	);
}

function setDisplayedResult(panel, hitType) {
	const result = panel.querySelector(".ironsworn-result");
	if (!result) return;
	result.textContent = hitType;
	result.className = `ironsworn-result ironsworn-result-${hitType.replace(" ", "-")}`;
}

function setMomentumPreview(panel, roll, enabled) {
	const displayedDice = enabled
		? getMomentumPreviewDice(roll)
		: roll.challengeDice;
	const challengeSprites = [
		...panel.querySelectorAll('[data-role^="challenge-"]'),
	];
	const orderedDice = [...roll.challengeDice].sort(
		(first, second) => first - second,
	);
	challengeSprites.forEach((sprite, index) => {
		const originalValue = orderedDice[index];
		const displayedValue = enabled
			? displayedDice[roll.challengeDice.indexOf(originalValue)]
			: originalValue;
		sprite.querySelector(".ironsworn-roll-number").textContent = displayedValue;
		sprite.classList.toggle(
			"ironsworn-roll-sprite-challenge-threat",
			displayedValue >= roll.playerValue,
		);
	});
	setDisplayedResult(panel, enabled ? applyMomentum(roll) : roll.hitType);
}

function waitForMomentumChoice(panel, roll, actionName) {
	return new Promise((resolve) => {
		const actions = panel.querySelector(".ironsworn-roll-actions");
		let settled = false;
		const useButton = document.createElement("button");
		useButton.type = "button";
		useButton.innerHTML = `<img class="ironsworn-sprite-fire-dash" src="${ASSETS.fireDash}" alt="" aria-hidden="true"> Use momentum`;
		const keepButton = document.createElement("button");
		keepButton.type = "button";
		keepButton.textContent = "Continue";
		actions.append(useButton, keepButton);

		const finish = (useMomentum) => {
			if (settled) return;
			settled = true;
			const finalHitType = useMomentum ? applyMomentum(roll) : roll.hitType;
			if (useMomentum) setMomentumPreview(panel, roll, true);
			else setDisplayedResult(panel, finalHitType);
			actions.replaceChildren();
			const choice = {
				hitType: finalHitType,
				momentumUsed: useMomentum,
				actionName,
			};
			resolve(choice);
		};

		panel.addEventListener("ironsworn-roll-close", () => finish(false), {
			once: true,
		});
		const previewMomentum = () => setMomentumPreview(panel, roll, true);
		const restoreMomentum = () => {
			if (!settled) setMomentumPreview(panel, roll, false);
		};
		useButton.addEventListener("mouseenter", previewMomentum);
		useButton.addEventListener("mouseleave", restoreMomentum);
		useButton.addEventListener("focus", previewMomentum);
		useButton.addEventListener("blur", restoreMomentum);
		useButton.addEventListener("click", () => finish(true), { once: true });
		keepButton.addEventListener("click", () => finish(false), { once: true });
	});
}

function waitForContinue(panel, roll, actionName) {
	return new Promise((resolve) => {
		const actions = panel.querySelector(".ironsworn-roll-actions");
		const continueButton = document.createElement("button");
		continueButton.type = "button";
		continueButton.textContent = "Continue";
		continueButton.addEventListener(
			"click",
			() => {
				actions.replaceChildren();
				resolve({ hitType: roll.hitType, momentumUsed: false, actionName });
			},
			{ once: true },
		);
		actions.append(continueButton);
	});
}

export async function executeIronswornRoll(args) {
	const requestedMoveName = String(args?.move_name ?? "").trim();
	if (!requestedMoveName) throw new Error("move_name is required");
	const characterAssets = await resolveCharacterAssets(args?.assets);
	const move = await resolveMoveForRoll(requestedMoveName, characterAssets.resolved);
	const currentSupply =
		args?.current_supply !== undefined
			? normalizeNumber(args.current_supply, "current_supply")
			: null;
	if (move.roll_type === "no_roll") {
		const questRank = String(args?.quest_rank ?? "").toLocaleLowerCase();
		if (move.name === "Forsake Your Vow") {
			if (
				!["troublesome", "dangerous", "formidable", "extreme", "epic"].includes(
					questRank,
				)
			) {
				throw new Error(
					"quest_rank is required for Forsake Your Vow and must be troublesome, dangerous, formidable, extreme, or epic",
				);
			}
		}
		const panel = getPanel();
		renderChoicePanel(panel, move.name);
		const { choice, choiceData: moveChoices } = await waitForMoveResolution(
			panel,
			move.text,
		);
		let penaltyAllocation = null;
		if (
			move.name === "Out of Supply" &&
			currentSupply !== null &&
			currentSupply < 0
		) {
			const penaltyAmount = Math.abs(currentSupply);
			const allocPanel = getPanel();
			renderChoicePanel(allocPanel, `Allocate ${penaltyAmount} Penalty`);
			const allocChoices = {
				options: [
					{
						label: `Lose ${penaltyAmount} Health`,
						value: { type: "health", amount: penaltyAmount },
					},
					{
						label: `Lose ${penaltyAmount} Spirit`,
						value: { type: "spirit", amount: penaltyAmount },
					},
					{
						label: `Lose ${penaltyAmount} Momentum`,
						value: { type: "momentum", amount: penaltyAmount },
					},
				],
				maxSelections: 1,
				playerChoice: true,
			};
			penaltyAllocation = await waitForChoice(allocPanel, allocChoices);
		}
		const response = {
			move: move.name,
			roll_type: move.roll_type,
		};
		if (move.name === "Forsake Your Vow") {
			response.quest_rank = questRank;
			response.spirit_loss = {
				troublesome: 1,
				dangerous: 2,
				formidable: 3,
				extreme: 4,
				epic: 5,
			}[questRank];
		}
		if (moveChoices?.playerChoice && choice !== null) response.choice = choice;
		if (moveChoices && !moveChoices.playerChoice) {
			response.narrative_choices = moveChoices.options.map(
				(option) => option.label,
			);
		}
		if (penaltyAllocation) response.penalty_allocation = penaltyAllocation;
		if (characterAssets.unrecognized.length)
			response.unrecognized_assets = characterAssets.unrecognized;
		return JSON.stringify(response);
	}
	if (move.roll_type === "progress_roll") {
		// Per Ironsworn rules, momentum is ignored on progress rolls (Fulfill Your Vow, End the Fight, etc)
		const questRank = String(args?.quest_rank ?? "").toLocaleLowerCase();
		if (
			!questRank ||
			!["troublesome", "dangerous", "formidable", "extreme", "epic"].includes(
				questRank,
			)
		) {
			throw new Error(
				"quest_rank is required for progress rolls and must be troublesome, dangerous, formidable, extreme, or epic",
			);
		}
		const currentProgress =
			args?.current_progress !== undefined
				? normalizeNumber(args.current_progress, "current_progress")
				: null;
		if (currentProgress === null) {
			throw new Error("current_progress is required for progress rolls");
		}

		const progressAssetCandidates = collectAssetEnhancements(
			move,
			characterAssets.resolved,
		);
		let selectedProgressAssets = [];
		if (progressAssetCandidates.length > 0) {
			selectedProgressAssets = await waitForAssetSelection(
				getPanel(),
				progressAssetCandidates,
				move.name,
			);
		}

		const panel = getPanel();
		const settings = getSettings();
		const rollStarted = renderRoll(panel, move.name);

		if (power_user?.movingUI === true) {
			normalizeMovingUIState();
			loadMovingUIState();
		}

		if (!settings.autoRoll) await rollStarted;
		const roll = calculateProgressRoll({ progress: currentProgress });
		renderProgressDice(panel, roll);
		await animateProgressRoll(panel, roll);

		const outcomeText = move.outcomes[roll.hitType.replace(" ", "_")].text;
		const outcomeChoices = extractMoveChoices(outcomeText);
		let selectedChoice = null;
		if (outcomeChoices?.playerChoice) {
			renderChoicePanel(panel, move.name);
			selectedChoice = await waitForChoice(panel, outcomeChoices);
		} else {
			panel.remove();
		}

		const experienceTable = {
			troublesome: { strong_hit: 1, weak_hit: 0, miss: 0 },
			dangerous: { strong_hit: 2, weak_hit: 1, miss: 0 },
			formidable: { strong_hit: 3, weak_hit: 2, miss: 0 },
			extreme: { strong_hit: 4, weak_hit: 3, miss: 0 },
			epic: { strong_hit: 5, weak_hit: 4, miss: 0 },
		};

		const progressAssetEffects = sumConditionalAssetEffects(
			selectedProgressAssets,
			roll.hitType,
		);
		const response = {
			move: move.name,
			hit_type: roll.hitType,
			isMatch: roll.isMatch,
			quest_rank: questRank,
			experience:
				experienceTable[questRank][roll.hitType.replace(" ", "_")] +
				progressAssetEffects.experience,
			outcome: formatRuleText(outcomeText),
		};
		if (selectedChoice !== null) response.choice = selectedChoice;
		if (outcomeChoices && !outcomeChoices.playerChoice)
			response.narrative_choices = outcomeChoices.options.map(
				(option) => option.label,
			);
		if (selectedProgressAssets.length > 0)
			response.assets_used = selectedProgressAssets.map((candidate) => ({
				asset: candidate.assetName,
				ability: formatRuleText(candidate.text),
			}));
		if (progressAssetEffects.experience)
			response.asset_experience_bonus = progressAssetEffects.experience;
		if (characterAssets.unrecognized.length)
			response.unrecognized_assets = characterAssets.unrecognized;
		return JSON.stringify(response);
	}
	if (move.roll_type !== "action_roll") {
		throw new Error(
			`Move "${move.name}" uses ${move.roll_type}, which is not supported by this tool yet.`,
		);
	}
	const oracleResults = await resolveRequiredOracleResults(move);
	if (args?.stat === undefined)
		throw new Error("stat is required for an action roll");
	if (args?.additional_bonus === undefined)
		throw new Error("additional_bonus is required for an action roll");
	if (args?.momentum === undefined)
		throw new Error("momentum is required for an action roll");
	const stat = normalizeNumber(args?.stat, "stat");
	if (!Number.isInteger(stat)) throw new Error("stat must be an integer");
	const actionName = move.name;

	const assetCandidates = collectAssetEnhancements(move, characterAssets.resolved);
	let selectedAssets = [];
	if (assetCandidates.length > 0) {
		selectedAssets = await waitForAssetSelection(
			getPanel(),
			assetCandidates,
			actionName,
		);
	}
	const preRollAssetEffects = sumPreRollAssetEffects(selectedAssets);

	const rollArgs = {
		stats_bonus: stat,
		additional_bonus:
			normalizeNumber(args.additional_bonus, "additional_bonus") +
			preRollAssetEffects.bonus,
		momentum: args?.momentum,
	};

	const panel = getPanel();
	const settings = getSettings();
	const rollStarted = renderRoll(panel, actionName);

	if (power_user?.movingUI === true) {
		normalizeMovingUIState();
		loadMovingUIState();
	}

	if (!settings.autoRoll) await rollStarted;
	let roll = calculateIronswornRoll(rollArgs);
	if (preRollAssetEffects.reroll) roll = calculateIronswornRoll(rollArgs);
	renderDice(panel, roll);
	await animateRoll(panel, roll);

	const choice =
		settings.autoContinue &&
		(roll.hitType === "strong hit" || !roll.canUseMomentum)
			? { hitType: roll.hitType, momentumUsed: false, actionName }
			: roll.canUseMomentum
				? await waitForMomentumChoice(panel, roll, actionName)
				: await waitForContinue(panel, roll, actionName);

	const outcomeText = move.outcomes[choice.hitType.replace(" ", "_")].text;
	const outcomeChoices = extractMoveChoices(outcomeText);
	let selectedChoice = null;
	if (outcomeChoices?.playerChoice) {
		renderChoicePanel(panel, move.name);
		selectedChoice = await waitForChoice(panel, outcomeChoices);
	} else {
		panel.remove();
	}
	const conditionalAssetEffects = sumConditionalAssetEffects(
		selectedAssets,
		choice.hitType,
	);
	const response = {
		move: move.name,
		hit_type: choice.hitType,
		momentum_used: choice.momentumUsed,
		isMatch: roll.isMatch,
		outcome: formatRuleText(outcomeText),
	};
	if (selectedChoice !== null) response.choice = selectedChoice;
	if (outcomeChoices && !outcomeChoices.playerChoice)
		response.narrative_choices = outcomeChoices.options.map(
			(option) => option.label,
		);
	if (oracleResults.length > 0) response.oracle_results = oracleResults;
	if (selectedAssets.length > 0)
		response.assets_used = selectedAssets.map((candidate) => ({
			asset: candidate.assetName,
			ability: formatRuleText(candidate.text),
		}));
	if (preRollAssetEffects.bonus)
		response.asset_bonus_applied = preRollAssetEffects.bonus;
	if (preRollAssetEffects.reroll) response.asset_reroll_used = true;
	if (conditionalAssetEffects.momentum)
		response.asset_momentum_bonus = conditionalAssetEffects.momentum;
	if (conditionalAssetEffects.harm)
		response.asset_harm_bonus = conditionalAssetEffects.harm;
	if (conditionalAssetEffects.experience)
		response.asset_experience_bonus = conditionalAssetEffects.experience;
	if (characterAssets.unrecognized.length)
		response.unrecognized_assets = characterAssets.unrecognized;
	return JSON.stringify(response);
}

function extractWorldTruths(datasworn) {
	const truths = {};
	if (!datasworn.truths || typeof datasworn.truths !== "object") return truths;
	
	for (const [truthId, truthData] of Object.entries(datasworn.truths)) {
		if (truthData.name && Array.isArray(truthData.options)) {
			truths[truthId] = {
				_id: truthData._id,
				name: truthData.name,
				options: truthData.options.map((opt) => ({
					min: opt.min,
					max: opt.max,
					description: opt.description,
					quest_starter: opt.quest_starter,
				})),
			};
		}
	}
	return truths;
}

async function loadWorldTruths() {
	const datasworn = await loadDatasworn();
	return extractWorldTruths(datasworn);
}

function createWorldBuilderPanel() {
	let panel = document.getElementById("ironsworn-worldbuilder-panel");
	if (panel) {
		panel.remove();
	}

	panel = document.createElement("section");
	panel.id = "ironsworn-worldbuilder-panel";
	panel.className = "ironsworn-worldbuilder-panel";
	panel.setAttribute("data-dragged", "false");
	panel.innerHTML = `
        <div class="ironsworn-worldbuilder-header">
            <h2>Create Your World - Select Truths</h2>
            <span class="drag-grabber" title="Move panel" aria-label="Move panel">
                <i class="fa-solid fa-grip"></i>
            </span>
        </div>
        <div class="ironsworn-worldbuilder-content"></div>
        <div class="ironsworn-worldbuilder-footer">
            <button class="ironsworn-wb-continue" type="button">Continue</button>
            <button class="ironsworn-wb-cancel" type="button">Cancel</button>
        </div>
    `;
	document.body.append(panel);
	enablePanelDragging(panel);
	return panel;
}

function createWorldBuilderModal() {
	// Remove any existing modals
	const existing = document.getElementById("ironsworn-worldbuilder-modal-overlay");
	if (existing) existing.remove();

	// Create overlay
	const overlay = document.createElement("div");
	overlay.id = "ironsworn-worldbuilder-modal-overlay";
	overlay.className = "ironsworn-worldbuilder-modal-overlay";

	// Create modal
	const modal = document.createElement("section");
	modal.className = "ironsworn-worldbuilder-modal";
	modal.innerHTML = `
        <div class="ironsworn-worldbuilder-modal-header">
            <h2>Create Your World - Select Truths</h2>
            <button class="ironsworn-worldbuilder-modal-close" type="button" title="Close">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="ironsworn-worldbuilder-modal-content"></div>
        <div class="ironsworn-worldbuilder-footer">
            <div class="ironsworn-wb-error-message"></div>
            <div class="ironsworn-wb-buttons">
                <button class="ironsworn-wb-continue" type="button">Continue</button>
                <button class="ironsworn-wb-cancel" type="button">Cancel</button>
            </div>
        </div>
    `;

	overlay.append(modal);
	document.body.append(overlay);

	// Close button handler
	const closeBtn = modal.querySelector(".ironsworn-worldbuilder-modal-close");
	closeBtn.addEventListener("click", () => overlay.remove());

	return modal;
}

function renderTruthSelector(panel, truths, truthOrder) {
	const content = panel.querySelector(".ironsworn-worldbuilder-content") ||
		panel.querySelector(".ironsworn-worldbuilder-modal-content");
	content.replaceChildren();

	const truthEntries = Object.entries(truths).sort(
		(a, b) => truthOrder.indexOf(a[0]) - truthOrder.indexOf(b[0]),
	);

	for (const [truthId, truthData] of truthEntries) {
		const truthSection = document.createElement("div");
		truthSection.className = "ironsworn-wb-truth-section";
		truthSection.dataset.truthId = truthId;

		const titleEl = document.createElement("h3");
		titleEl.className = "ironsworn-wb-truth-title";
		titleEl.textContent = truthData.name;
		truthSection.append(titleEl);

		const optionsContainer = document.createElement("div");
		optionsContainer.className = "ironsworn-wb-options";

		// Create custom div and get references first
		const customDiv = document.createElement("div");
		customDiv.className = "ironsworn-wb-custom";
		customDiv.innerHTML = `
            <label class="ironsworn-wb-custom-label">
                <input type="radio" name="truth-${truthId}-select" class="ironsworn-wb-custom-radio" value="custom">
                <span>Create Custom Truth</span>
            </label>
            <textarea class="ironsworn-wb-custom-input" placeholder="Write your own truth for this world aspect..." rows="3"></textarea>
        `;
		const customRadio = customDiv.querySelector(".ironsworn-wb-custom-radio");
		const customTextarea = customDiv.querySelector(".ironsworn-wb-custom-input");

		// Add preset options
		for (let i = 0; i < truthData.options.length; i++) {
			const option = truthData.options[i];
			const optionButton = document.createElement("button");
			optionButton.type = "button";
			optionButton.className = "ironsworn-wb-option";
			optionButton.dataset.optionIndex = String(i);
			optionButton.dataset.truthId = truthId;
			optionButton.innerHTML = `
                <strong class="ironsworn-wb-option-num">Option ${i + 1}</strong>
                <p class="ironsworn-wb-option-text">${formatRuleText(option.description)}</p>
            `;

			optionButton.addEventListener("click", (e) => {
				e.preventDefault();
				const selectedButton = optionsContainer.querySelector(".ironsworn-wb-option-selected");
				if (selectedButton) selectedButton.classList.remove("ironsworn-wb-option-selected");
				optionButton.classList.add("ironsworn-wb-option-selected");
				truthSection.dataset.selectedType = "preset";
				truthSection.dataset.selectedIndex = String(i);
				delete truthSection.dataset.customText;
				// Uncheck custom radio
				customRadio.checked = false;
			});

			optionsContainer.append(optionButton);
		}

		customRadio.addEventListener("change", () => {
			if (customRadio.checked) {
				// Deselect all preset options
				const selectedButton = optionsContainer.querySelector(".ironsworn-wb-option-selected");
				if (selectedButton) selectedButton.classList.remove("ironsworn-wb-option-selected");
				truthSection.dataset.selectedType = "custom";
				delete truthSection.dataset.selectedIndex;
				customTextarea.focus();
			}
		});

		customTextarea.addEventListener("input", () => {
			truthSection.dataset.customText = customTextarea.value;
			if (customTextarea.value) {
				// Automatically select custom when typing
				customRadio.checked = true;
				const selectedButton = optionsContainer.querySelector(".ironsworn-wb-option-selected");
				if (selectedButton) selectedButton.classList.remove("ironsworn-wb-option-selected");
				truthSection.dataset.selectedType = "custom";
				delete truthSection.dataset.selectedIndex;
			}
		});

		truthSection.append(optionsContainer, customDiv);
		content.append(truthSection);
	}
}

function collectSelectedTruths(panel) {
	const selected = {};
	const sections = panel.querySelectorAll(".ironsworn-wb-truth-section");

	for (const section of sections) {
		const truthId = section.dataset.truthId;
		const selectedType = section.dataset.selectedType;

		if (!selectedType) {
			throw new Error(`No selection made for truth: ${truthId}`);
		}

		if (selectedType === "preset") {
			const selectedIndex = parseInt(section.dataset.selectedIndex, 10);
			selected[truthId] = {
				type: "preset",
				index: selectedIndex,
			};
		} else if (selectedType === "custom") {
			const customText = section.dataset.customText || "";
			if (!customText.trim()) {
				throw new Error(`Empty custom truth for: ${truthId}`);
			}
			selected[truthId] = {
				type: "custom",
				text: customText.trim(),
			};
		}
	}

	return selected;
}

async function addIronswornLorebookEntry(lorebookName, entryData) {
	const ctx = SillyTavern?.getContext?.();
	if (!ctx) throw new Error("SillyTavern context not available");

	let bookData = null;
	
	// Try to load existing lorebook
	try {
		bookData = await ctx.loadWorldInfo?.(lorebookName);
	} catch (_) {}

	// If not found, try API
	if (!bookData) {
		try {
			const res = await fetch("/api/worldinfo/get", {
				method: "POST",
				headers: getRequestHeaders(),
				body: JSON.stringify({ name: lorebookName }),
			});
			if (res.ok) {
				const data = await res.json();
				if (data && typeof data === "object" && data.entries) {
					bookData = data;
				}
			}
		} catch (_) {}
	}

	// Create new lorebook if needed
	if (!bookData) {
		bookData = {
			entries: {},
			name: lorebookName,
			scan_depth: 4,
			token_budget: 2000,
			recursive: false,
			extensions: {},
		};
	}

	// Calculate next UID
	const existingUids = Object.keys(bookData.entries || {})
		.map(Number)
		.filter((n) => !isNaN(n));
	const nextUid = existingUids.length > 0 ? Math.max(...existingUids) + 1 : 0;

	// Create entry
	const entry = {
		uid: nextUid,
		key: Array.isArray(entryData.key) ? entryData.key : [entryData.key],
		keysecondary: entryData.keysecondary || [],
		comment: entryData.comment || "Ironsworn Truth",
		content: entryData.content,
		constant: entryData.constant !== false,
		selective: entryData.selective !== false,
		selectiveLogic: 0,
		addMemo: true,
		memo: entryData.comment || "Ironsworn Truth",
		order: 100,
		position: 0,
		disable: false,
		probability: 100,
		useProbability: false,
		depth: 4,
		group: "",
		groupOverride: false,
		groupWeight: 100,
		extensions: {},
	};

	bookData.entries[nextUid] = entry;

	// Save immediately; the shared debounced save can otherwise be cancelled
	// by another in-flight saveWorldInfo call before it ever writes to disk.
	await ctx.saveWorldInfo?.(lorebookName, bookData, true);
	await ctx.updateWorldInfoList?.();

	// Refresh UI
	if (ctx.reloadWorldInfoEditor) {
		ctx.reloadWorldInfoEditor(lorebookName);
	}
	if (ctx.eventSource && ctx.event_types?.WORLDINFO_UPDATED) {
		ctx.eventSource.emit(ctx.event_types.WORLDINFO_UPDATED, lorebookName, bookData);
	}

	return `${lorebookName}::${nextUid}`;
}

async function handleIronswornWorldBuilder(args) {
	try {
		// Get world name from current chat name + ID
		const ctx = SillyTavern?.getContext?.();
		let worldName = "Ironsworn World";
		
		if (ctx) {
			const chatId = ctx.chatId || "unknown";
			const chatName = ctx.chat?.[0]?.name || ctx.characterName || "World";
			worldName = `${chatName}_${chatId}`;
		}
		
		const truths = await loadWorldTruths();
		const truthOrder = ["old_world", "iron", "legacies", "communities", "leaders", "defense", "mysticism", "religion", "firstborn", "beasts", "horrors"];

		const panel = createWorldBuilderModal();
		renderTruthSelector(panel, truths, truthOrder);

		// Wait for user to complete selections
		const selectedTruths = await new Promise((resolve, reject) => {
			const continueButton = panel.querySelector(".ironsworn-wb-continue");
			const cancelButton = panel.querySelector(".ironsworn-wb-cancel");

			if (!continueButton || !cancelButton) {
				reject(new Error("World builder panel not properly initialized"));
				return;
			}

			const errorMessageEl = panel.querySelector(".ironsworn-wb-error-message");

			const handleContinue = () => {
				try {
					errorMessageEl.textContent = "";
					const selections = collectSelectedTruths(panel);
					// Remove the overlay (which contains the modal)
					const overlay = document.getElementById("ironsworn-worldbuilder-modal-overlay");
					if (overlay) {
						overlay.remove();
					} else {
						panel.remove();
					}
					// Remove event listeners after success
					continueButton.removeEventListener("click", handleContinue);
					cancelButton.removeEventListener("click", handleCancel);
					resolve(selections);
				} catch (error) {
					errorMessageEl.textContent = error.message;
				}
			};

			const handleCancel = () => {
				// Remove the overlay (which contains the modal)
				const overlay = document.getElementById("ironsworn-worldbuilder-modal-overlay");
				if (overlay) {
					overlay.remove();
				} else {
					panel.remove();
				}
				// Remove event listeners
				continueButton.removeEventListener("click", handleContinue);
				cancelButton.removeEventListener("click", handleCancel);
				reject(new Error("World creation cancelled by user"));
			};

			continueButton.addEventListener("click", handleContinue);
			cancelButton.addEventListener("click", handleCancel);
		});

		// Generate lorebook entries and add them
		const lorebookName = `Ironsworn - ${worldName}`;
		let entriesAdded = 0;

		// Add individual truth entries
		for (const [truthId, selection] of Object.entries(selectedTruths)) {
			const truthData = truths[truthId];
			if (!truthData) continue;

			let content = "";
			if (selection.type === "preset") {
				const option = truthData.options[selection.index];
				content = `${formatRuleText(option.description)}\n\n`;
				if (option.quest_starter) {
					content += `**Quest Starter:** ${formatRuleText(option.quest_starter)}`;
				}
			} else {
				content = selection.text;
			}

			try {
				await addIronswornLorebookEntry(lorebookName, {
					key: [truthData.name.toLowerCase(), truthId],
					comment: `World Truth: ${truthData.name}`,
					content: content,
					constant: true,
					selective: false,
				});
				entriesAdded++;
			} catch (e) {
				console.warn(`[Ironsworn World Builder] Failed to add ${truthData.name} entry:`, e);
			}
		}

		console.info(`[Ironsworn World Builder] World "${worldName}" created with ${entriesAdded} truths`);
	} catch (error) {
		const errorMsg = `[Ironsworn World Builder] Error: ${error.message}`;
		console.error(errorMsg);
		
		// Show error to user
		const context = SillyTavern?.getContext?.();
		if (context?.toastr) {
			context.toastr.error(errorMsg, "Ironsworn World Builder");
		} else {
			alert(errorMsg);
		}
		
		throw error;
	}
}

// Character Creation Wizard
function extractAssetsFromDatasworn(datasworn) {
	const assets = {
		companions: [],
		paths: [],
		combatTalents: [],
		rituals: [],
	};

	if (!datasworn.assets) return assets;

	for (const collection of Object.values(datasworn.assets)) {
		if (typeof collection.contents !== "object" || collection.contents === null) continue;

		for (const asset of Object.values(collection.contents)) {
			const assetData = {
				id: asset._id,
				name: asset.name,
				description: asset.description || "",
				abilities:
					asset.abilities?.map((ab) => ({
						label: ab.text || ab.label || ab.title || "",
						description: ab.description || "",
					})) || [],
				type: "companion", // default, will be overridden
			};

			if (collection._id.includes("companion")) {
				assetData.type = "companion";
				assets.companions.push(assetData);
			} else if (collection._id.includes("path")) {
				assetData.type = "path";
				assets.paths.push(assetData);
			} else if (collection._id.includes("combat_talent")) {
				assetData.type = "combat_talent";
				assets.combatTalents.push(assetData);
			} else if (collection._id.includes("ritual")) {
				assetData.type = "ritual";
				assets.rituals.push(assetData);
			}
		}
	}

	return assets;
}

function generateCharacterTracker(character, selectedAssets, bonds, vows, worldTruths) {
	const { name, stats, inventory } = character;
	
	// Clean ability text: remove move references like [Move Name](id:...) and extract first meaningful part
	const cleanAbilityText = (text) => {
		if (!text) return "";
		// Remove markdown links like [Text](id:...)
		let cleaned = text.replace(/\[([^\]]+)\]\(id:[^\)]+\)/g, "$1");
		// Remove extra whitespace and newlines
		cleaned = cleaned.replace(/\s+/g, " ").trim();
		// Get just the first sentence or meaningful clause
		const sentences = cleaned.split(/\.\s+/);
		return sentences[0] + (sentences.length > 1 ? "." : "");
	};
	
	let tracker = "[TIME]\n";
	tracker += `Current Time: 08:00, Day 1\n`;
	tracker += "[/TIME]\n\n";

	tracker += "[CHARACTER]\n";
	tracker += `${name}:\n`;
	tracker += `Combat: Edge: +${stats.edge} | Heart: +${stats.heart} | Iron: +${stats.iron} | Shadow: +${stats.shadow} | Wits: +${stats.wits}\n`;
	tracker += `HP ((SLOTS-#a83232)) 5/5\n`;
	tracker += `Supply ((SLOTS-orange)) 5/5\n`;
	tracker += `Spirit ((ORBS-cyan)) 5/5\n`;
	tracker += `((INFO)) 0 XP (To spend)\n`;
	tracker += "[/CHARACTER]\n\n";

	tracker += "[MOMENTUM]\n";
	tracker += `((BARREL)) Momentum: +2/10\n`;
	tracker += "[/MOMENTUM]\n\n";

	// Vows section
	tracker += "[VOWS]\n";
	vows.forEach((vow, index) => {
		tracker += `Vow: ((PILL)) ${vow.name} (${vow.description})\n`;
		tracker += `((SLOTS)) 0/10 (${vow.rank}) ((PILL)) ? (No milestone yet)\n`;
	});
	tracker += "[/VOWS]\n\n";

	// Inventory section
	if (inventory && inventory.trim()) {
		tracker += "[INVENTORY]\n";
		const items = inventory.split("\n").filter(i => i.trim());
		
		// Group items by category
		const categories = {};
		items.forEach(item => {
			// Format: emoji [rarity] name (category)
			const match = item.match(/^(\S+)\s+\[([^\]]+)\]\s+(.+)\s+\(([^)]+)\)$/);
			if (match) {
				let [, emoji, rarity, name, category] = match;
				// Clean up name (remove trailing spaces that might have been captured)
				name = name.trim();
				if (!categories[category]) categories[category] = [];
				categories[category].push({ emoji, rarity, name });
			} else {
				// Fallback for simple item names
				if (!categories["gear"]) categories["gear"] = [];
				categories["gear"].push({ emoji: "🏹", rarity: "Common", name: item.trim() });
			}
		});
		
		// Format by category
		Object.entries(categories).forEach(([cat, items]) => {
			const catName = cat.charAt(0).toUpperCase() + cat.slice(1) + ":";
			tracker += `${catName}\n`;
			items.forEach(item => {
				tracker += `- ${item.emoji} [${item.rarity}] ${item.name}\n`;
			});
		});
		tracker += "[/INVENTORY]\n\n";
	} else {
		tracker += "[INVENTORY]\n";
		tracker += `Gear:\n`;
		tracker += `- Equipment (add your items here)\n`;
		tracker += "[/INVENTORY]\n\n";
	}

	// Separate companions from other assets
	const companions = selectedAssets.filter(a => a.type === "companion");
	const otherAssets = selectedAssets.filter(a => a.type !== "companion");

	// Companions section
	if (companions.length > 0) {
		tracker += "[COMPANIONS]\n";
		companions.forEach((companion) => {
			tracker += `- ((NPC))${companion.name} (${(companion.type || 'Companion').replace(/_/g, ' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')})\n`;
			tracker += `  HP((SLOTS-#a83232)) 5/5\n`;
			
			if (companion.abilities && companion.abilities.length > 0) {
				tracker += `  Abilities: `;
				const abilityLines = companion.abilities.map((a, idx) => {
					const prefix = idx === 0 ? "((PILLS))" : "🔒";
					const cleaned = cleanAbilityText(a.label);
					return `${prefix} ${cleaned}`;
				});
				tracker += abilityLines.join(",");
				tracker += "\n";
			}
		});
		tracker += "[/COMPANIONS]\n\n";
	}

	// Assets section (non-companion)
	if (otherAssets.length > 0) {
		tracker += "[ASSETS]\n";
		otherAssets.forEach((asset) => {
			const typeName = (asset.type || 'Asset')
				.replace(/_/g, ' ')
				.split(' ')
				.map(w => w.charAt(0).toUpperCase() + w.slice(1))
				.join(' ');
			tracker += `- ${asset.name} (${typeName})\n`;
			
			if (asset.abilities && asset.abilities.length > 0) {
				tracker += `  `;
				const abilityLines = asset.abilities.map((a, idx) => {
					const prefix = idx === 0 ? "((PILLS))" : "🔒";
					const cleaned = cleanAbilityText(a.label || a.text || "");
					return `${prefix} Ability ${idx + 1} (${cleaned})`;
				});
				tracker += abilityLines.join(",");
				tracker += "\n";
			}
		});
		tracker += "[/ASSETS]\n\n";
	}

	// Bonds section
	tracker += "[BONDS]\n";
	const bondProgress = (bonds.length * 0.25).toFixed(2);
	tracker += `Bonds ((SLOTS-pink)) ${bondProgress}/10\n`;
	bonds.forEach((bond) => {
		tracker += `- ((NPC)) ${bond.name} (${bond.type})\n`;
	});
	tracker += "[/BONDS]\n";

	return tracker;
}

function createCharacterWizardModal(step, totalSteps, title, content, previousDisabled = false) {
	const existing = document.getElementById("ironsworn-character-wizard-overlay");
	if (existing) existing.remove();

	const overlay = document.createElement("div");
	overlay.id = "ironsworn-character-wizard-overlay";
	overlay.className = "ironsworn-worldbuilder-modal-overlay";

	const modal = document.createElement("section");
	modal.className = "ironsworn-worldbuilder-modal";
	modal.innerHTML = `
        <div class="ironsworn-worldbuilder-modal-header">
            <h2>${title}</h2>
            <span class="ironsworn-wizard-step">Step ${step}/${totalSteps}</span>
            <button class="ironsworn-worldbuilder-modal-close" type="button" title="Close">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="ironsworn-worldbuilder-modal-content"></div>
        <div class="ironsworn-worldbuilder-footer">
            <div class="ironsworn-wb-error-message"></div>
            <div class="ironsworn-wb-buttons">
                <button class="ironsworn-wizard-previous" type="button" ${previousDisabled ? "disabled" : ""}>Previous</button>
                <button class="ironsworn-wb-cancel" type="button">Cancel</button>
                <button class="ironsworn-wizard-next" type="button">Next</button>
            </div>
        </div>
    `;

	const contentDiv = modal.querySelector(".ironsworn-worldbuilder-modal-content");
	contentDiv.append(content);

	overlay.append(modal);
	document.body.append(overlay);

	const closeBtn = modal.querySelector(".ironsworn-worldbuilder-modal-close");
	closeBtn.addEventListener("click", () => overlay.remove());

	return modal;
}

function createWorldStep(savedData = null) {
	const container = document.createElement("div");
	container.className = "ironsworn-wizard-step-content";
	container.innerHTML = `
        <p style="margin-bottom: 1rem; font-size: 0.95rem; color: var(--SmartThemeBodyColor);">
            Define core truths about your world. These shape the setting and challenges your character will face.
        </p>
        <div class="ironsworn-world-truths-container" style="max-height: 500px; overflow-y: auto;"></div>
    `;

	let selectedTruths = savedData || null;

	async function initializeTruths() {
		const truths = await loadWorldTruths();
		const truthOrder = ["old_world", "iron", "legacies", "communities", "leaders", "defense", "mysticism", "religion", "firstborn", "beasts", "horrors"];
		const truthContainer = container.querySelector(".ironsworn-world-truths-container");

		truthOrder.forEach((truthKey) => {
			const truthSection = truths[truthKey];
			if (!truthSection) return;

			const sectionDiv = document.createElement("div");
			sectionDiv.className = "ironsworn-wb-truth-section";
			sectionDiv.style.marginBottom = "1.5rem";
			sectionDiv.style.paddingBottom = "1rem";
			sectionDiv.style.borderBottom = "1px solid var(--SmartThemeBorderColor, #687080)";

			const titleDiv = document.createElement("h3");
			titleDiv.className = "ironsworn-wb-truth-title";
			titleDiv.textContent = truthSection.name || truthKey;
			titleDiv.style.fontFamily = "'PR Viking', Georgia, serif";
			titleDiv.style.fontSize = "1.2em";
			titleDiv.style.fontWeight = "700";
			titleDiv.style.marginBottom = "0.75rem";
			titleDiv.style.color = "var(--SmartThemeBodyColor)";

			sectionDiv.appendChild(titleDiv);

			if (truthSection.options && Array.isArray(truthSection.options)) {
				truthSection.options.forEach((option, idx) => {
					const optionDiv = document.createElement("div");
					optionDiv.className = "ironsworn-wb-option";
					optionDiv.style.display = "flex";
					optionDiv.style.alignItems = "center";
					optionDiv.style.padding = "0.75rem";
					optionDiv.style.marginBottom = "0.5rem";
					optionDiv.style.textAlign = "left";
					optionDiv.style.background = "var(--SmartThemeBlurTintColor, #303642)";
					optionDiv.style.border = "2px solid var(--SmartThemeBorderColor, #687080)";
					optionDiv.style.borderRadius = "4px";
					optionDiv.style.cursor = "pointer";
					optionDiv.style.transition = "all 150ms ease";

					const radio = document.createElement("input");
					radio.type = "radio";
					radio.name = truthKey;
					radio.value = idx;
					radio.style.marginRight = "0.75rem";
					radio.style.cursor = "pointer";

					const textDiv = document.createElement("div");
					textDiv.style.flex = "1";

					const optionTitle = document.createElement("div");
					optionTitle.style.fontWeight = "600";
					optionTitle.style.marginBottom = "0.25rem";
					optionTitle.style.color = "var(--SmartThemeBodyColor)";
					optionTitle.textContent = option.name || `Option ${idx + 1}`;

					const optionText = document.createElement("div");
					optionText.style.fontSize = "0.85rem";
					optionText.style.color = "#aaa";
					optionText.textContent = option.description || "";

					textDiv.appendChild(optionTitle);
					textDiv.appendChild(optionText);

					optionDiv.appendChild(radio);
					optionDiv.appendChild(textDiv);

					const updateStyle = () => {
						if (radio.checked) {
							optionDiv.style.borderColor = "#7fd694";
							optionDiv.style.background = "rgba(127, 214, 148, 0.1)";
							optionDiv.style.boxShadow = "inset 0 0 8px rgba(127, 214, 148, 0.2)";
						} else {
							optionDiv.style.background = "var(--SmartThemeBlurTintColor, #303642)";
							optionDiv.style.borderColor = "var(--SmartThemeBorderColor, #687080)";
							optionDiv.style.boxShadow = "none";
						}
					};

					radio.addEventListener("change", updateStyle);
					optionDiv.addEventListener("click", () => {
						radio.checked = true;
						updateStyle();
					});
					optionDiv.addEventListener("mouseenter", () => {
						if (!radio.checked) {
							optionDiv.style.background = "var(--SmartThemeQuoteColor, #485264)";
							optionDiv.style.borderColor = "var(--SmartThemeQuoteColor, #485264)";
						}
					});
					optionDiv.addEventListener("mouseleave", () => {
						if (!radio.checked) {
							optionDiv.style.background = "var(--SmartThemeBlurTintColor, #303642)";
							optionDiv.style.borderColor = "var(--SmartThemeBorderColor, #687080)";
						}
					});

					sectionDiv.appendChild(optionDiv);
				});
			}

			truthContainer.appendChild(sectionDiv);
		});
	}

	function getSelected() {
		if (!selectedTruths) {
			const radioGroups = {};
			const radios = container.querySelectorAll('input[type="radio"]');
			radios.forEach((radio) => {
				if (radio.checked) {
					const truthKey = radio.name;
					const optionIdx = parseInt(radio.value);
					radioGroups[truthKey] = optionIdx;
				}
			});

			if (Object.keys(radioGroups).length === 0) {
				throw new Error("Please select a truth for each category");
			}

			selectedTruths = radioGroups;
		}
		return selectedTruths;
	}

	initializeTruths();

	return { element: container, getSelected };
}

function createCharacterStep(savedData = {}) {
	const container = document.createElement("div");
	container.className = "ironsworn-wizard-step-content";
	container.innerHTML = `
        <div style="margin-bottom: 1.5rem;">
            <label style="display: block; font-weight: bold; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Character Name</label>
            <input type="text" class="ironsworn-char-name ironsworn-form-input" placeholder="Enter your character name" value="${savedData.name || ''}" style="width: 100%; padding: 0.75rem; margin-top: 0.25rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem;">
        </div>
        <div style="margin-bottom: 1.5rem;">
            <label style="display: block; font-weight: bold; margin-bottom: 0.75rem; color: var(--SmartThemeBodyColor);">Stats (assign 3, 2, 2, 1, 1)</label>
            <div style="display: flex; flex-direction: column; gap: 1rem; margin-top: 0.5rem;">
                <div style="background: rgba(0,0,0,0.2); padding: 1rem; border-radius: 4px; border: 1px solid rgba(224, 120, 120, 0.2);">
                    <div style="font-weight: 600; color: var(--SmartThemeBodyColor); margin-bottom: 0.5rem;">Edge</div>
                    <div style="font-size: 0.85rem; color: #999; margin-bottom: 0.75rem;">Quickness, agility, and ranged combat</div>
                    <div style="display: flex; gap: 0.5rem;">
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="edge" value="1" ${savedData.stats?.edge === 1 ? 'checked' : ''} class="ironsworn-stat-radio">
                            1
                        </label>
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="edge" value="2" ${savedData.stats?.edge === 2 ? 'checked' : ''} class="ironsworn-stat-radio">
                            2
                        </label>
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="edge" value="3" ${savedData.stats?.edge === 3 ? 'checked' : ''} class="ironsworn-stat-radio">
                            3
                        </label>
                    </div>
                </div>
                <div style="background: rgba(0,0,0,0.2); padding: 1rem; border-radius: 4px; border: 1px solid rgba(224, 120, 120, 0.2);">
                    <div style="font-weight: 600; color: var(--SmartThemeBodyColor); margin-bottom: 0.5rem;">Heart</div>
                    <div style="font-size: 0.85rem; color: #999; margin-bottom: 0.75rem;">Courage, willpower, empathy, and loyalty</div>
                    <div style="display: flex; gap: 0.5rem;">
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="heart" value="1" ${savedData.stats?.heart === 1 ? 'checked' : ''} class="ironsworn-stat-radio">
                            1
                        </label>
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="heart" value="2" ${savedData.stats?.heart === 2 ? 'checked' : ''} class="ironsworn-stat-radio">
                            2
                        </label>
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="heart" value="3" ${savedData.stats?.heart === 3 ? 'checked' : ''} class="ironsworn-stat-radio">
                            3
                        </label>
                    </div>
                </div>
                <div style="background: rgba(0,0,0,0.2); padding: 1rem; border-radius: 4px; border: 1px solid rgba(224, 120, 120, 0.2);">
                    <div style="font-weight: 600; color: var(--SmartThemeBodyColor); margin-bottom: 0.5rem;">Iron</div>
                    <div style="font-size: 0.85rem; color: #999; margin-bottom: 0.75rem;">Strength, endurance, and close combat</div>
                    <div style="display: flex; gap: 0.5rem;">
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="iron" value="1" ${savedData.stats?.iron === 1 ? 'checked' : ''} class="ironsworn-stat-radio">
                            1
                        </label>
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="iron" value="2" ${savedData.stats?.iron === 2 ? 'checked' : ''} class="ironsworn-stat-radio">
                            2
                        </label>
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="iron" value="3" ${savedData.stats?.iron === 3 ? 'checked' : ''} class="ironsworn-stat-radio">
                            3
                        </label>
                    </div>
                </div>
                <div style="background: rgba(0,0,0,0.2); padding: 1rem; border-radius: 4px; border: 1px solid rgba(224, 120, 120, 0.2);">
                    <div style="font-weight: 600; color: var(--SmartThemeBodyColor); margin-bottom: 0.5rem;">Shadow</div>
                    <div style="font-size: 0.85rem; color: #999; margin-bottom: 0.75rem;">Stealth, deception, and cunning</div>
                    <div style="display: flex; gap: 0.5rem;">
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="shadow" value="1" ${savedData.stats?.shadow === 1 ? 'checked' : ''} class="ironsworn-stat-radio">
                            1
                        </label>
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="shadow" value="2" ${savedData.stats?.shadow === 2 ? 'checked' : ''} class="ironsworn-stat-radio">
                            2
                        </label>
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="shadow" value="3" ${savedData.stats?.shadow === 3 ? 'checked' : ''} class="ironsworn-stat-radio">
                            3
                        </label>
                    </div>
                </div>
                <div style="background: rgba(0,0,0,0.2); padding: 1rem; border-radius: 4px; border: 1px solid rgba(224, 120, 120, 0.2);">
                    <div style="font-weight: 600; color: var(--SmartThemeBodyColor); margin-bottom: 0.5rem;">Wits</div>
                    <div style="font-size: 0.85rem; color: #999; margin-bottom: 0.75rem;">Knowledge, expertise, and observation</div>
                    <div style="display: flex; gap: 0.5rem;">
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="wits" value="1" ${savedData.stats?.wits === 1 ? 'checked' : ''} class="ironsworn-stat-radio">
                            1
                        </label>
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="wits" value="2" ${savedData.stats?.wits === 2 ? 'checked' : ''} class="ironsworn-stat-radio">
                            2
                        </label>
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; color: var(--SmartThemeBodyColor);">
                            <input type="radio" name="wits" value="3" ${savedData.stats?.wits === 3 ? 'checked' : ''} class="ironsworn-stat-radio">
                            3
                        </label>
                    </div>
                </div>
            </div>
        </div>
        <div style="margin-bottom: 1.5rem;">
            <label style="display: block; font-weight: bold; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Inventory (optional)</label>
            <textarea class="ironsworn-inventory ironsworn-form-input" placeholder="Add important items here (one per line). Ordinary gear is covered by Supply." style="width: 100%; padding: 0.75rem; height: 4rem; margin-top: 0.25rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem; resize: vertical;">${savedData.inventory || ''}</textarea>
        </div>
    `;

	function getCharacterData() {
		const name = container.querySelector(".ironsworn-char-name").value.trim();
		const stats = {
			edge: Number(container.querySelector('input[name="edge"]:checked')?.value) || 0,
			heart: Number(container.querySelector('input[name="heart"]:checked')?.value) || 0,
			iron: Number(container.querySelector('input[name="iron"]:checked')?.value) || 0,
			shadow: Number(container.querySelector('input[name="shadow"]:checked')?.value) || 0,
			wits: Number(container.querySelector('input[name="wits"]:checked')?.value) || 0,
		};
		const inventory = container.querySelector(".ironsworn-inventory").value.trim();

		const statValues = Object.values(stats);
		const hasValidStats =
			statValues.includes(3) && statValues.includes(2) && statValues.filter((v) => v === 2).length === 2 && statValues.filter((v) => v === 1).length === 2;

		if (!name) throw new Error("Character name is required");
		if (!hasValidStats) throw new Error("Stats must be exactly: 3, 2, 2, 1, 1");

		return { name, stats, inventory };
	}

	return { element: container, getCharacterData };
}

function createAssetsStep(savedData = []) {
	const container = document.createElement("div");
	container.className = "ironsworn-wizard-step-content";
	container.innerHTML = `
        <p style="margin-bottom: 1.5rem; font-size: 0.95rem; color: var(--SmartThemeBodyColor);">Select exactly 3 assets. Browse by category and click to select:</p>
        <div class="ironsworn-assets-categories" style="display: flex; gap: 0.5rem; margin-bottom: 1.5rem; flex-wrap: wrap;">
            <button class="ironsworn-category-btn ironsworn-category-btn-active" data-category="all" type="button" style="padding: 0.5rem 1rem; background: rgba(224, 120, 120, 0.3); border: 1px solid rgba(224, 120, 120, 0.6); color: var(--SmartThemeBodyColor); cursor: pointer; border-radius: 4px; font-weight: bold;">All</button>
            <button class="ironsworn-category-btn" data-category="companion" type="button" style="padding: 0.5rem 1rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); color: var(--SmartThemeBodyColor); cursor: pointer; border-radius: 4px;">Companions</button>
            <button class="ironsworn-category-btn" data-category="path" type="button" style="padding: 0.5rem 1rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); color: var(--SmartThemeBodyColor); cursor: pointer; border-radius: 4px;">Paths</button>
            <button class="ironsworn-category-btn" data-category="combat_talent" type="button" style="padding: 0.5rem 1rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); color: var(--SmartThemeBodyColor); cursor: pointer; border-radius: 4px;">Combat Talents</button>
            <button class="ironsworn-category-btn" data-category="ritual" type="button" style="padding: 0.5rem 1rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); color: var(--SmartThemeBodyColor); cursor: pointer; border-radius: 4px;">Rituals</button>
        </div>
        <div style="max-height: 400px; overflow-y: auto; border: 1px solid rgba(224, 120, 120, 0.3); padding: 1rem; border-radius: 4px; background: rgba(0,0,0,0.1);">
            <div class="ironsworn-assets-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.75rem;"></div>
        </div>
        <div class="ironsworn-assets-selected" style="margin-top: 1.5rem; padding: 1rem; background: rgba(224, 120, 120, 0.1); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; min-height: 2rem;">
            <strong style="color: var(--SmartThemeBodyColor);">Selected (0/3):</strong>
            <div class="ironsworn-selected-list" style="margin-top: 0.75rem; font-size: 0.9rem; color: var(--SmartThemeBodyColor);"></div>
        </div>
    `;

	const selectedAssets = savedData.length > 0 ? [...savedData] : [];
	let currentCategory = "all";

	async function initializeAssets() {
		const datasworn = await loadDatasworn();
		const assets = extractAssetsFromDatasworn(datasworn);
		const allAssets = [...assets.companions, ...assets.paths, ...assets.combatTalents, ...assets.rituals];

		function renderAssets(category) {
			const grid = container.querySelector(".ironsworn-assets-grid");
			grid.innerHTML = "";

			const filtered = category === "all" 
				? allAssets 
				: allAssets.filter(a => {
					if (category === "companion") return a.id.includes("companion");
					if (category === "path") return a.id.includes("path");
					if (category === "combat_talent") return a.id.includes("combat_talent");
					if (category === "ritual") return a.id.includes("ritual");
					return false;
				});

			filtered.forEach((asset) => {
				const typeLabel = asset.id.includes("companion")
					? "Companion"
					: asset.id.includes("path")
						? "Path"
						: asset.id.includes("combat_talent")
							? "Combat Talent"
							: "Ritual";

				const isSelected = selectedAssets.some(a => a.id === asset.id);

				const card = document.createElement("div");
				card.className = "ironsworn-asset-card";
				card.style.cssText = `
                    padding: 1rem;
                    background: ${isSelected ? 'rgba(224, 120, 120, 0.2)' : 'rgba(0,0,0,0.3)'};
                    border: 2px solid ${isSelected ? 'rgba(224, 120, 120, 0.8)' : 'rgba(224, 120, 120, 0.3)'};
                    border-radius: 6px;
                    cursor: pointer;
                    transition: all 150ms ease;
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                `;
				card.innerHTML = `
                    <div style="font-weight: bold; color: var(--SmartThemeBodyColor);">${asset.name}</div>
                    <div style="font-size: 0.8rem; color: #aaa;">${typeLabel}</div>
                    <div style="font-size: 0.85rem; color: #bbb; margin-top: 0.25rem;">${asset.abilities[0]?.label || 'Ability'}</div>
                    ${isSelected ? '<div style="margin-top: 0.5rem; padding: 0.25rem 0.5rem; background: rgba(224, 120, 120, 0.4); border-radius: 3px; font-size: 0.8rem; color: #e07878; text-align: center; font-weight: bold;">✓ Selected</div>' : ''}
                `;

				card.addEventListener("click", () => {
					if (isSelected) {
						const idx = selectedAssets.findIndex((a) => a.id === asset.id);
						if (idx !== -1) selectedAssets.splice(idx, 1);
					} else {
						if (selectedAssets.length >= 3) {
							container.querySelector(".ironsworn-wb-error-message").textContent = "You can only select 3 assets";
							return;
						}
						selectedAssets.push({
							id: asset.id,
							name: asset.name,
							type: typeLabel,
							abilities: asset.abilities,
						});
					}
					updateSelectedDisplay();
					renderAssets(currentCategory);
				});

				card.addEventListener("mouseenter", () => {
					if (!isSelected) {
						card.style.background = 'rgba(224, 120, 120, 0.15)';
						card.style.borderColor = 'rgba(224, 120, 120, 0.5)';
					}
				});

				card.addEventListener("mouseleave", () => {
					if (!isSelected) {
						card.style.background = 'rgba(0,0,0,0.3)';
						card.style.borderColor = 'rgba(224, 120, 120, 0.3)';
					}
				});

				grid.append(card);
			});
		}

		// Category button handlers
		container.querySelectorAll(".ironsworn-category-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				container.querySelectorAll(".ironsworn-category-btn").forEach((b) => {
					b.style.background = "rgba(0,0,0,0.3)";
					b.style.borderColor = "rgba(224, 120, 120, 0.3)";
					b.classList.remove("ironsworn-category-btn-active");
				});
				btn.style.background = "rgba(224, 120, 120, 0.3)";
				btn.style.borderColor = "rgba(224, 120, 120, 0.6)";
				btn.classList.add("ironsworn-category-btn-active");
				currentCategory = btn.dataset.category;
				renderAssets(currentCategory);
			});
		});

		function updateSelectedDisplay() {
			const selected = container.querySelector(".ironsworn-selected-list");
			container.querySelector(".ironsworn-assets-selected strong").textContent = `Selected (${selectedAssets.length}/3):`;
			selected.innerHTML = selectedAssets.map((a) => `<div style="color: #e07878;">• ${a.name} (${a.type})</div>`).join("");
		}

		renderAssets(currentCategory);
		updateSelectedDisplay();
	}

	initializeAssets().catch((e) => console.error("Failed to load assets:", e));

	function getSelectedAssets() {
		if (selectedAssets.length !== 3) throw new Error("You must select exactly 3 assets");
		return selectedAssets;
	}

	return { element: container, getSelectedAssets };
}

function createBondsStep(savedData = []) {
	const container = document.createElement("div");
	container.className = "ironsworn-wizard-step-content";
	container.innerHTML = `
        <p style="margin-bottom: 1.5rem; font-size: 0.95rem; color: var(--SmartThemeBodyColor);">Create up to 3 starting bonds with people, communities, or places. These connections provide narrative texture and mechanical benefits.</p>
        <div class="ironsworn-bonds-list"></div>
        <button class="ironsworn-add-bond" type="button" style="width: 100%; padding: 0.75rem; margin-top: 1rem; background: rgba(224, 120, 120, 0.2); border: 1px solid rgba(224, 120, 120, 0.5); color: var(--SmartThemeBodyColor); cursor: pointer; border-radius: 4px; font-weight: bold; transition: all 150ms ease;">+ Add Bond</button>
    `;

	const bonds = [];

	function addBondInput(name = "", type = "NPC") {
		const bondContainer = document.createElement("div");
		bondContainer.className = "ironsworn-bond-input";
		bondContainer.style.cssText = "display: grid; grid-template-columns: 1fr 150px auto; gap: 0.75rem; margin-bottom: 0.75rem; padding: 1rem; background: rgba(0,0,0,0.2); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px;";
		bondContainer.innerHTML = `
            <input type="text" class="bond-name ironsworn-form-input" placeholder="Bond name" value="${name}" style="padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor);">
            <select class="bond-type ironsworn-form-input" style="padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor);">
                <option value="NPC" ${type === "NPC" ? "selected" : ""}>NPC</option>
                <option value="Community" ${type === "Community" ? "selected" : ""}>Community</option>
                <option value="Place" ${type === "Place" ? "selected" : ""}>Place</option>
                <option value="Faction" ${type === "Faction" ? "selected" : ""}>Faction</option>
            </select>
            <button class="remove-bond" type="button" style="padding: 0.75rem 1rem; background: rgba(180, 80, 80, 0.3); border: 1px solid rgba(224, 120, 120, 0.5); color: #e07878; cursor: pointer; border-radius: 4px; font-weight: bold; transition: all 150ms ease;">✕</button>
        `;

		const removeBtn = bondContainer.querySelector(".remove-bond");
		removeBtn.addEventListener("click", () => {
			bondContainer.remove();
			bonds.splice(bonds.indexOf(bondContainer), 1);
		});

		removeBtn.addEventListener("mouseenter", () => {
			removeBtn.style.background = "rgba(180, 80, 80, 0.5)";
		});

		removeBtn.addEventListener("mouseleave", () => {
			removeBtn.style.background = "rgba(180, 80, 80, 0.3)";
		});

		container.querySelector(".ironsworn-bonds-list").append(bondContainer);
		bonds.push(bondContainer);
	}

	const addBtn = container.querySelector(".ironsworn-add-bond");
	addBtn.addEventListener("click", () => {
		if (bonds.length < 3) {
			addBondInput();
		} else {
			container.querySelector(".ironsworn-wb-error-message").textContent = "Maximum 3 bonds allowed";
		}
	});

	addBtn.addEventListener("mouseenter", () => {
		addBtn.style.background = "rgba(224, 120, 120, 0.3)";
		addBtn.style.borderColor = "rgba(224, 120, 120, 0.8)";
	});

	addBtn.addEventListener("mouseleave", () => {
		addBtn.style.background = "rgba(224, 120, 120, 0.2)";
		addBtn.style.borderColor = "rgba(224, 120, 120, 0.5)";
	});

	// Add saved bonds or 3 empty ones
	if (savedData.length > 0) {
		savedData.forEach((bond) => addBondInput(bond.name, bond.type));
	} else {
		for (let i = 0; i < 3; i++) {
			addBondInput();
		}
	}

	function getSelectedBonds() {
		const selectedBonds = [];
		bonds.forEach((bondContainer) => {
			const name = bondContainer.querySelector(".bond-name").value.trim();
			const type = bondContainer.querySelector(".bond-type").value;
			if (name) {
				selectedBonds.push({ name, type });
			}
		});
		if (selectedBonds.length > 3) throw new Error("Maximum 3 bonds allowed");
		return selectedBonds;
	}

	return { element: container, getSelectedBonds };
}

function createVowsStep(savedData = {}) {
	const container = document.createElement("div");
	container.className = "ironsworn-wizard-step-content";
	container.innerHTML = `
        <p style="margin-bottom: 1.5rem; font-size: 0.95rem; color: var(--SmartThemeBodyColor);">
            Create two starting vows: an inciting vow (immediate problem) and a long-term vow (personal goal).
        </p>
        <div style="display: flex; flex-direction: column; gap: 2rem;">
            <div style="background: rgba(0,0,0,0.2); padding: 1.5rem; border-radius: 4px; border: 1px solid rgba(224, 120, 120, 0.2);">
                <h3 style="font-weight: bold; margin: 0 0 1rem 0; color: var(--SmartThemeBodyColor); font-family: 'PR Viking', Georgia, serif;">Inciting Vow</h3>
                <div style="margin-bottom: 1rem;">
                    <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Name</label>
                    <input type="text" class="ironsworn-vow-1-name ironsworn-form-input" placeholder="e.g., Bring peace" value="${savedData.vows?.[0]?.name || ''}" style="width: 100%; padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem;">
                </div>
                <div style="margin-bottom: 1rem;">
                    <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Description</label>
                    <textarea class="ironsworn-vow-1-desc ironsworn-form-input" placeholder="Describe this vow in detail..." style="width: 100%; padding: 0.75rem; height: 3rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem; resize: vertical;">${savedData.vows?.[0]?.description || ''}</textarea>
                </div>
                <div>
                    <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Rank</label>
                    <select class="ironsworn-vow-1-rank ironsworn-form-input" style="width: 100%; padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem;">
                        <option value="Troublesome" ${savedData.vows?.[0]?.rank === "Troublesome" ? "selected" : ""}>Troublesome</option>
                        <option value="Dangerous" ${savedData.vows?.[0]?.rank === "Dangerous" ? "selected" : ""}>Dangerous</option>
                        <option value="Formidable" ${savedData.vows?.[0]?.rank === "Formidable" || !savedData.vows?.[0] ? "selected" : ""}>Formidable (default)</option>
                        <option value="Extreme" ${savedData.vows?.[0]?.rank === "Extreme" ? "selected" : ""}>Extreme</option>
                        <option value="Epic" ${savedData.vows?.[0]?.rank === "Epic" ? "selected" : ""}>Epic</option>
                    </select>
                </div>
            </div>
            <div style="background: rgba(0,0,0,0.2); padding: 1.5rem; border-radius: 4px; border: 1px solid rgba(224, 120, 120, 0.2);">
                <h3 style="font-weight: bold; margin: 0 0 1rem 0; color: var(--SmartThemeBodyColor); font-family: 'PR Viking', Georgia, serif;">Long-term Vow</h3>
                <div style="margin-bottom: 1rem;">
                    <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Name</label>
                    <input type="text" class="ironsworn-vow-2-name ironsworn-form-input" placeholder="e.g., Clear our names" value="${savedData.vows?.[1]?.name || ''}" style="width: 100%; padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem;">
                </div>
                <div style="margin-bottom: 1rem;">
                    <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Description</label>
                    <textarea class="ironsworn-vow-2-desc ironsworn-form-input" placeholder="Describe this vow in detail..." style="width: 100%; padding: 0.75rem; height: 3rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem; resize: vertical;">${savedData.vows?.[1]?.description || ''}</textarea>
                </div>
                <div>
                    <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Rank</label>
                    <select class="ironsworn-vow-2-rank ironsworn-form-input" style="width: 100%; padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem;">
                        <option value="Troublesome" ${savedData.vows?.[1]?.rank === "Troublesome" ? "selected" : ""}>Troublesome</option>
                        <option value="Dangerous" ${savedData.vows?.[1]?.rank === "Dangerous" ? "selected" : ""}>Dangerous</option>
                        <option value="Formidable" ${savedData.vows?.[1]?.rank === "Formidable" ? "selected" : ""}>Formidable</option>
                        <option value="Extreme" ${savedData.vows?.[1]?.rank === "Extreme" || !savedData.vows?.[1] ? "selected" : ""}>Extreme (default)</option>
                        <option value="Epic" ${savedData.vows?.[1]?.rank === "Epic" ? "selected" : ""}>Epic</option>
                    </select>
                </div>
            </div>
        </div>
    `;

	function getVows() {
		const vow1Name = container.querySelector(".ironsworn-vow-1-name").value.trim();
		const vow1Desc = container.querySelector(".ironsworn-vow-1-desc").value.trim();
		const vow1Rank = container.querySelector(".ironsworn-vow-1-rank").value;

		const vow2Name = container.querySelector(".ironsworn-vow-2-name").value.trim();
		const vow2Desc = container.querySelector(".ironsworn-vow-2-desc").value.trim();
		const vow2Rank = container.querySelector(".ironsworn-vow-2-rank").value;

		if (!vow1Name || !vow1Desc) throw new Error("Inciting vow requires a name and description");
		if (!vow2Name || !vow2Desc) throw new Error("Long-term vow requires a name and description");

		return [
			{ name: vow1Name, description: vow1Desc, rank: vow1Rank },
			{ name: vow2Name, description: vow2Desc, rank: vow2Rank },
		];
	}

	return { element: container, getVows };
}

async function handleIronswornCharacterInit() {
	try {
		// Load all data needed
		const truths = await loadWorldTruths();
		const datasworn = await loadDatasworn();
		const assets = extractAssetsFromDatasworn(datasworn);
		const allAssets = [...assets.companions, ...assets.paths, ...assets.combatTalents, ...assets.rituals];
		const truthOrder = ["old_world", "iron", "legacies", "communities", "leaders", "defense", "mysticism", "religion", "firstborn", "beasts", "horrors"];

		// Master form container - this persists across all step navigation
		const masterForm = document.createElement("div");
		masterForm.id = "ironsworn-character-master-form";
		masterForm.style.width = "100%";
		masterForm.style.boxSizing = "border-box";
		masterForm.style.display = "flex";
		masterForm.style.flexDirection = "column";

		const steps = [
			{ title: "Create Your World - Select Truths", id: "step-world" },
			{ title: "Character Stats & Inventory", id: "step-character" },
			{ title: "Select Your Assets", id: "step-assets" },
			{ title: "Create Your Bonds", id: "step-bonds" },
			{ title: "Define Your Vows", id: "step-vows" },
		];

		let currentStep = 0;
		const formElements = {};

		// === STEP 1: WORLD TRUTHS ===
		const stepWorld = document.createElement("div");
		stepWorld.id = "step-world";
		stepWorld.className = "ironsworn-wizard-step-content";
		stepWorld.style.width = "100%";
		stepWorld.style.display = "block";
		stepWorld.style.boxSizing = "border-box";
		stepWorld.innerHTML = `
            <p style="margin-bottom: 1rem; font-size: 0.95rem; color: var(--SmartThemeBodyColor);">
                Define core truths about your world. These shape the setting and challenges your character will face.
            </p>
            <div class="ironsworn-world-truths-container" style="max-height: 400px; overflow-y: auto;"></div>
        `;
		masterForm.appendChild(stepWorld);
		formElements.world = { container: stepWorld };

		// Populate world truths
		const truthContainer = stepWorld.querySelector(".ironsworn-world-truths-container");
		truthOrder.forEach((truthKey) => {
			const truthSection = truths[truthKey];
			if (!truthSection) return;

			const sectionDiv = document.createElement("div");
			sectionDiv.className = "ironsworn-wb-truth-section";
			sectionDiv.style.marginBottom = "1.5rem";
			sectionDiv.style.paddingBottom = "1rem";
			sectionDiv.style.borderBottom = "1px solid var(--SmartThemeBorderColor, #687080)";

			const titleDiv = document.createElement("h3");
			titleDiv.className = "ironsworn-wb-truth-title";
			titleDiv.textContent = truthSection.name || truthKey;
			titleDiv.style.fontFamily = "'PR Viking', Georgia, serif";
			titleDiv.style.fontSize = "1.2em";
			titleDiv.style.fontWeight = "700";
			titleDiv.style.marginBottom = "0.75rem";
			titleDiv.style.color = "var(--SmartThemeBodyColor)";

			sectionDiv.appendChild(titleDiv);

			// Regular options
			if (truthSection.options && Array.isArray(truthSection.options)) {
				truthSection.options.forEach((option, idx) => {
					const optionDiv = document.createElement("div");
					optionDiv.className = "ironsworn-wb-option";
				optionDiv.style.display = "block";
					optionDiv.style.borderRadius = "4px";
					optionDiv.style.cursor = "pointer";
					optionDiv.style.transition = "all 150ms ease";

					const radio = document.createElement("input");
					radio.type = "radio";
					radio.name = truthKey;
					radio.value = idx;
					radio.className = `truth-${truthKey}`;
					radio.style.marginRight = "0.75rem";
					radio.style.cursor = "pointer";
				radio.style.display = "none"; // Hide radio button visually

				const textDiv = document.createElement("div");
				textDiv.style.flex = "1";
				textDiv.style.textAlign = "left";

				const optionTitle = document.createElement("div");
				optionTitle.style.fontWeight = "600";
				optionTitle.style.marginBottom = "0.25rem";
				optionTitle.style.color = "var(--SmartThemeBodyColor)";
				optionTitle.textContent = option.name || `Option ${idx + 1}`;

				const optionText = document.createElement("div");
				optionText.style.fontSize = "0.85rem";
				optionText.style.color = "#aaa";
				optionText.textContent = option.description || "";

				textDiv.appendChild(optionTitle);
				textDiv.appendChild(optionText);

				optionDiv.appendChild(radio);
				optionDiv.appendChild(textDiv);

				const updateStyle = () => {
					if (radio.checked) {
						optionDiv.style.borderColor = "#7fd694";
						optionDiv.style.background = "rgba(127, 214, 148, 0.1)";
						optionDiv.style.boxShadow = "inset 0 0 8px rgba(127, 214, 148, 0.2)";
					} else {
						optionDiv.style.background = "var(--SmartThemeBlurTintColor, #303642)";
						optionDiv.style.borderColor = "var(--SmartThemeBorderColor, #687080)";
					optionDiv.style.boxShadow = "none";
				}
			};

			radio.addEventListener("change", () => {
				// Update all options in this truth section
				const allOptionsInSection = sectionDiv.querySelectorAll(`input[name="${truthKey}"]`);
				allOptionsInSection.forEach(r => {
					const optDiv = r.closest(".ironsworn-wb-option") || r.closest(".ironsworn-wb-custom");
					if (optDiv) {
						if (r.checked) {
							optDiv.style.borderColor = "#7fd694";
							optDiv.style.background = "rgba(127, 214, 148, 0.1)";
							optDiv.style.boxShadow = "inset 0 0 8px rgba(127, 214, 148, 0.2)";
						} else {
							optDiv.style.background = "var(--SmartThemeBlurTintColor, #303642)";
							optDiv.style.borderColor = "var(--SmartThemeBorderColor, #687080)";
							optDiv.style.boxShadow = "none";
						}
					}
				});
			});
			optionDiv.addEventListener("click", () => {
				radio.checked = true;
				radio.dispatchEvent(new Event("change", { bubbles: true }));
			});
			optionDiv.addEventListener("mouseenter", () => {
				if (!radio.checked) {
					optionDiv.style.background = "var(--SmartThemeQuoteColor, #485264)";
					optionDiv.style.borderColor = "var(--SmartThemeQuoteColor, #485264)";
				}
			});
			optionDiv.addEventListener("mouseleave", () => {
				if (!radio.checked) {
					optionDiv.style.background = "var(--SmartThemeBlurTintColor, #303642)";
					optionDiv.style.borderColor = "var(--SmartThemeBorderColor, #687080)";
				}
			});

			sectionDiv.appendChild(optionDiv);
		});
		}

		// Custom option - INSIDE forEach loop
		const customDiv = document.createElement("div");
		customDiv.className = "ironsworn-wb-custom";
		customDiv.style.marginTop = "1rem";
		customDiv.style.padding = "0.75rem";
		customDiv.style.background = "var(--SmartThemeBlurTintColor, #303642)";
		customDiv.style.border = "1px solid var(--SmartThemeBorderColor, #687080)";
		customDiv.style.borderRadius = "4px";
		customDiv.style.cursor = "pointer";
		customDiv.style.transition = "all 150ms ease";
		customDiv.style.textAlign = "left";

		const customLabel = document.createElement("label");
		customLabel.className = "ironsworn-wb-custom-label";
		customLabel.style.display = "block";
		customLabel.style.cursor = "pointer";
		customLabel.style.fontSize = "0.95em";
		customLabel.style.color = "var(--SmartThemeBodyColor)";

		const customRadio = document.createElement("input");
		customRadio.type = "radio";
		customRadio.name = truthKey;
		customRadio.value = "custom";
		customRadio.className = `truth-${truthKey}-custom`;
		customRadio.style.cursor = "pointer";
		customRadio.style.display = "none"; // Hide radio button visually

		customLabel.appendChild(customRadio);
		customLabel.appendChild(document.createTextNode("Custom"));

		const customInput = document.createElement("textarea");
		customInput.className = `truth-${truthKey}-input ironsworn-wb-custom-input`;
		customInput.placeholder = "Enter your own truth...";
		customInput.style.padding = "0.5rem";
		customInput.style.background = "var(--SmartThemeBlurTintColor, #20242c)";
		customInput.style.color = "var(--SmartThemeBodyColor)";
		customInput.style.border = "1px solid var(--SmartThemeBorderColor, #687080)";
		customInput.style.borderRadius = "4px";
		customInput.style.fontFamily = "inherit";
		customInput.style.fontSize = "0.9em";
		customInput.style.maxHeight = "80px";
		customInput.style.marginTop = "0.5rem";
		customInput.style.display = "none";

		customRadio.addEventListener("change", () => {
			customInput.style.display = customRadio.checked ? "block" : "none";
		});

		customDiv.addEventListener("click", () => {
			customRadio.checked = true;
			customInput.style.display = "block";
		});

		customDiv.addEventListener("mouseenter", () => {
			if (!customRadio.checked) {
				customDiv.style.background = "var(--SmartThemeQuoteColor, #485264)";
				customDiv.style.borderColor = "var(--SmartThemeQuoteColor, #485264)";
			}
		});

		customDiv.addEventListener("mouseleave", () => {
			if (!customRadio.checked) {
				customDiv.style.background = "var(--SmartThemeBlurTintColor, #303642)";
				customDiv.style.borderColor = "var(--SmartThemeBorderColor, #687080)";
			}
		});

		customDiv.appendChild(customLabel);
		customDiv.appendChild(customInput);
		sectionDiv.appendChild(customDiv);

			truthContainer.appendChild(sectionDiv);
		});

		// === STEP 2: CHARACTER ===
		const stepCharacter = document.createElement("div");
		stepCharacter.id = "step-character";
		stepCharacter.className = "ironsworn-wizard-step-content";
		stepCharacter.style.width = "100%";
		stepCharacter.style.display = "none";
		stepCharacter.style.boxSizing = "border-box";
		stepCharacter.innerHTML = `
            <div style="margin-bottom: 1.5rem;">
                <label style="display: block; font-weight: bold; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Character Name</label>
                <input type="text" id="char-name" class="ironsworn-form-input" placeholder="Enter your character name" style="width: 100%; padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem;">
            </div>
            <div style="margin-bottom: 1.5rem;">
                <label style="display: block; font-weight: bold; margin-bottom: 0.75rem; color: var(--SmartThemeBodyColor);">Stats (assign 3, 2, 2, 1, 1)</label>
                <table style="width: 100%; border-collapse: collapse; margin-top: 0.5rem; background: rgba(0,0,0,0.2); border: 1px solid rgba(224, 120, 120, 0.2); border-radius: 4px; overflow: hidden;">
                    <thead>
                        <tr>
                            <th style="padding: 0.75rem; text-align: left; border-right: 1px solid rgba(224, 120, 120, 0.2); color: var(--SmartThemeBodyColor); font-weight: bold; width: 20%;">Stat</th>
                            <th style="padding: 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2); color: var(--SmartThemeBodyColor); font-weight: bold;">3</th>
                            <th style="padding: 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2); color: var(--SmartThemeBodyColor); font-weight: bold;">2</th>
                            <th style="padding: 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2); color: var(--SmartThemeBodyColor); font-weight: bold;">2</th>
                            <th style="padding: 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2); color: var(--SmartThemeBodyColor); font-weight: bold;">1</th>
                            <th style="padding: 0.75rem; text-align: center; color: var(--SmartThemeBodyColor); font-weight: bold;">1</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr style="border-top: 1px solid rgba(224, 120, 120, 0.2);">
                            <td style="padding: 1rem 0.75rem; border-right: 1px solid rgba(224, 120, 120, 0.2);">
                                <div style="font-weight: 600; color: var(--SmartThemeBodyColor);">Edge</div>
                                <div style="font-size: 0.8rem; color: #999; margin-top: 0.25rem;">Quickness, agility, ranged</div>
                            </td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="edge" value="3" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="edge" value="2" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="edge" value="2" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="edge" value="1" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center;"><input type="radio" name="edge" value="1" style="cursor: pointer; width: 18px; height: 18px;"></td>
                        </tr>
                        <tr style="border-top: 1px solid rgba(224, 120, 120, 0.2);">
                            <td style="padding: 1rem 0.75rem; border-right: 1px solid rgba(224, 120, 120, 0.2);">
                                <div style="font-weight: 600; color: var(--SmartThemeBodyColor);">Heart</div>
                                <div style="font-size: 0.8rem; color: #999; margin-top: 0.25rem;">Courage, willpower, empathy</div>
                            </td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="heart" value="3" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="heart" value="2" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="heart" value="2" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="heart" value="1" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center;"><input type="radio" name="heart" value="1" style="cursor: pointer; width: 18px; height: 18px;"></td>
                        </tr>
                        <tr style="border-top: 1px solid rgba(224, 120, 120, 0.2);">
                            <td style="padding: 1rem 0.75rem; border-right: 1px solid rgba(224, 120, 120, 0.2);">
                                <div style="font-weight: 600; color: var(--SmartThemeBodyColor);">Iron</div>
                                <div style="font-size: 0.8rem; color: #999; margin-top: 0.25rem;">Strength, endurance, close combat</div>
                            </td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="iron" value="3" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="iron" value="2" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="iron" value="2" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="iron" value="1" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center;"><input type="radio" name="iron" value="1" style="cursor: pointer; width: 18px; height: 18px;"></td>
                        </tr>
                        <tr style="border-top: 1px solid rgba(224, 120, 120, 0.2);">
                            <td style="padding: 1rem 0.75rem; border-right: 1px solid rgba(224, 120, 120, 0.2);">
                                <div style="font-weight: 600; color: var(--SmartThemeBodyColor);">Shadow</div>
                                <div style="font-size: 0.8rem; color: #999; margin-top: 0.25rem;">Stealth, deception, cunning</div>
                            </td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="shadow" value="3" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="shadow" value="2" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="shadow" value="2" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="shadow" value="1" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center;"><input type="radio" name="shadow" value="1" style="cursor: pointer; width: 18px; height: 18px;"></td>
                        </tr>
                        <tr style="border-top: 1px solid rgba(224, 120, 120, 0.2);">
                            <td style="padding: 1rem 0.75rem; border-right: 1px solid rgba(224, 120, 120, 0.2);">
                                <div style="font-weight: 600; color: var(--SmartThemeBodyColor);">Wits</div>
                                <div style="font-size: 0.8rem; color: #999; margin-top: 0.25rem;">Knowledge, expertise, observation</div>
                            </td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="wits" value="3" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="wits" value="2" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="wits" value="2" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center; border-right: 1px solid rgba(224, 120, 120, 0.2);"><input type="radio" name="wits" value="1" style="cursor: pointer; width: 18px; height: 18px;"></td>
                            <td style="padding: 1rem 0.75rem; text-align: center;"><input type="radio" name="wits" value="1" style="cursor: pointer; width: 18px; height: 18px;"></td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div style="margin-bottom: 1.5rem;">
                <label style="display: block; font-weight: bold; margin-bottom: 0.75rem; color: var(--SmartThemeBodyColor);">Inventory (optional)</label>
                <div id="inventory-builder" style="border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; padding: 1rem; background: rgba(0,0,0,0.1);">
                    <div id="inventory-items-list" style="display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 1rem;"></div>
                    <button id="add-inventory-item" type="button" style="width: 100%; padding: 0.75rem; background: rgba(224, 120, 120, 0.2); border: 1px solid rgba(224, 120, 120, 0.5); color: rgba(224, 120, 120, 0.8); cursor: pointer; border-radius: 4px; font-weight: 600; transition: all 150ms ease;">+ Add Item</button>
                </div>
                <textarea id="char-inventory" class="ironsworn-form-input" placeholder="Items list" style="width: 100%; padding: 0.75rem; height: 0; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem; resize: vertical; display: none;"></textarea>
            </div>
        `;
		masterForm.appendChild(stepCharacter);

		// === STAT RADIO CONSTRAINT LOGIC ===
		// Ensure only one "3", two "2"s, two "1"s can be selected vertically
		const statRadios = stepCharacter.querySelectorAll("input[type='radio']");
		const statNames = ["edge", "heart", "iron", "shadow", "wits"];

		statRadios.forEach((radio) => {
			radio.addEventListener("change", () => {
				if (!radio.checked) return;

				const selectedValue = radio.value;
				const selectedStat = radio.name;
				const requiredCounts = { "3": 1, "2": 2, "1": 2 }; // Only one stat can have 3
				const currentCount = {};

				// Count current selections for this value
				statNames.forEach((stat) => {
					if (stepCharacter.querySelector(`input[name="${stat}"]:checked`)?.value === selectedValue) {
						currentCount[stat] = true;
					}
				});

				const countForValue = Object.keys(currentCount).length;

				// If we're exceeding the limit, deselect the oldest occurrence of this value
				if (countForValue > requiredCounts[selectedValue]) {
					for (const stat of statNames) {
						if (stat !== selectedStat) {
							const otherRadio = stepCharacter.querySelector(`input[name="${stat}"][value="${selectedValue}"]:checked`);
							if (otherRadio) {
								otherRadio.checked = false;
								break;
							}
						}
					}
				}
			});
		});

		// === INVENTORY BUILDER ===
		const inventoryItems = [];
		const inventoryItemsList = stepCharacter.querySelector("#inventory-items-list");
		const addInventoryItemBtn = stepCharacter.querySelector("#add-inventory-item");
		const inventoryTextarea = stepCharacter.querySelector("#char-inventory");

		const emojiOptions = {
			gear: ["🏹", "🗡️", "🛡️", "🧥", "👢", "💼", "🎒", "⚒️", "🔧", "🔨"],
			weapons: ["⚔️", "🗡️", "🏹", "🪓", "🗺️", "🧨", "⛓️", "🪝"],
			supplies: ["🪢", "🧭", "🧂", "💰", "📖", "🪨", "📜", "🧪"],
			quest: ["💎", "🗝️", "📿", "👑", "📦", "🏺", "📜", "💍"]
		};

		const rarityOptions = ["Common", "Uncommon", "Rare", "Legendary"];

		function updateInventoryTextarea() {
			const items = inventoryItems.map(item => 
				`${item.emoji} [${item.rarity}] ${item.name} (${item.category})`
			).join("\n");
			inventoryTextarea.value = items;
		}

		function addInventoryRow(item = null) {
			const itemData = item || { name: "", emoji: "🏹", category: "gear", rarity: "Common" };
			const itemDiv = document.createElement("div");
			itemDiv.style.display = "flex";
			itemDiv.style.gap = "0.5rem";
			itemDiv.style.alignItems = "center";
			itemDiv.style.padding = "0.75rem";
			itemDiv.style.background = "rgba(0,0,0,0.2)";
			itemDiv.style.borderRadius = "4px";
			itemDiv.style.border = "1px solid rgba(224, 120, 120, 0.3)";

			// Emoji selector
			const emojiSelect = document.createElement("select");
			emojiSelect.style.padding = "0.5rem";
			emojiSelect.style.background = "rgba(0,0,0,0.3)";
			emojiSelect.style.border = "1px solid rgba(224, 120, 120, 0.3)";
			emojiSelect.style.borderRadius = "4px";
			emojiSelect.style.color = "var(--SmartThemeBodyColor)";
			emojiSelect.style.cursor = "pointer";
			emojiSelect.style.fontSize = "1.2rem";
			emojiSelect.style.minWidth = "50px";
			
			const allEmojis = [...new Set(Object.values(emojiOptions).flat())];
			allEmojis.forEach(emoji => {
				const opt = document.createElement("option");
				opt.value = emoji;
				opt.textContent = emoji;
				emojiSelect.appendChild(opt);
			});
			emojiSelect.value = itemData.emoji;

			// Item name input
			const nameInput = document.createElement("input");
			nameInput.type = "text";
			nameInput.placeholder = "Item name";
			nameInput.value = itemData.name;
			nameInput.style.flex = "1";
			nameInput.style.padding = "0.5rem";
			nameInput.style.background = "rgba(0,0,0,0.3)";
			nameInput.style.border = "1px solid rgba(224, 120, 120, 0.3)";
			nameInput.style.borderRadius = "4px";
			nameInput.style.color = "var(--SmartThemeBodyColor)";

			// Category select
			const categorySelect = document.createElement("select");
			categorySelect.style.padding = "0.5rem";
			categorySelect.style.background = "rgba(0,0,0,0.3)";
			categorySelect.style.border = "1px solid rgba(224, 120, 120, 0.3)";
			categorySelect.style.borderRadius = "4px";
			categorySelect.style.color = "var(--SmartThemeBodyColor)";
			categorySelect.style.cursor = "pointer";
			["gear", "weapons", "supplies", "quest"].forEach(cat => {
				const opt = document.createElement("option");
				opt.value = cat;
				opt.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
				categorySelect.appendChild(opt);
			});
			categorySelect.value = itemData.category;

			// Rarity select
			const raritySelect = document.createElement("select");
			raritySelect.style.padding = "0.5rem";
			raritySelect.style.background = "rgba(0,0,0,0.3)";
			raritySelect.style.border = "1px solid rgba(224, 120, 120, 0.3)";
			raritySelect.style.borderRadius = "4px";
			raritySelect.style.color = "var(--SmartThemeBodyColor)";
			raritySelect.style.cursor = "pointer";
			rarityOptions.forEach(rarity => {
				const opt = document.createElement("option");
				opt.value = rarity;
				opt.textContent = rarity;
				raritySelect.appendChild(opt);
			});
			raritySelect.value = itemData.rarity;

			// Remove button
			const removeBtn = document.createElement("button");
			removeBtn.textContent = "✕";
			removeBtn.type = "button";
			removeBtn.style.padding = "0.5rem 0.75rem";
			removeBtn.style.background = "rgba(224, 120, 120, 0.2)";
			removeBtn.style.border = "1px solid rgba(224, 120, 120, 0.5)";
			removeBtn.style.color = "#e07878";
			removeBtn.style.borderRadius = "4px";
			removeBtn.style.cursor = "pointer";
			removeBtn.style.fontWeight = "600";

			const updateItem = () => {
				const idx = inventoryItems.findIndex(i => i === itemData);
				if (idx >= 0) {
					inventoryItems[idx] = {
						name: nameInput.value,
						emoji: emojiSelect.value,
						category: categorySelect.value,
						rarity: raritySelect.value
					};
					updateInventoryTextarea();
				}
			};

			emojiSelect.addEventListener("change", updateItem);
			nameInput.addEventListener("input", updateItem);
			categorySelect.addEventListener("change", updateItem);
			raritySelect.addEventListener("change", updateItem);

			removeBtn.addEventListener("click", () => {
				const idx = inventoryItems.findIndex(i => i === itemData);
				if (idx >= 0) {
					inventoryItems.splice(idx, 1);
					itemDiv.remove();
					updateInventoryTextarea();
				}
			});

			itemDiv.appendChild(emojiSelect);
			itemDiv.appendChild(nameInput);
			itemDiv.appendChild(categorySelect);
			itemDiv.appendChild(raritySelect);
			itemDiv.appendChild(removeBtn);

			inventoryItemsList.appendChild(itemDiv);
			inventoryItems.push(itemData);
			updateInventoryTextarea();
		}

		addInventoryItemBtn.addEventListener("click", () => {
			const newItem = { name: "", emoji: "🏹", category: "gear", rarity: "Common" };
			inventoryItems.push(newItem);
			addInventoryRow(newItem);
		});

		// === STEP 3: ASSETS ===
		const stepAssets = document.createElement("div");
		stepAssets.id = "step-assets";
		stepAssets.className = "ironsworn-wizard-step-content";
		stepAssets.style.width = "100%";
		stepAssets.style.display = "none";
		stepAssets.style.boxSizing = "border-box";
		stepAssets.innerHTML = `
            <p style="margin-bottom: 1.5rem; font-size: 0.95rem; color: var(--SmartThemeBodyColor);">Select exactly 3 assets. Browse by category and click to select:</p>
            <div class="ironsworn-assets-categories" style="display: flex; gap: 0.5rem; margin-bottom: 1.5rem; flex-wrap: wrap;">
                <button class="ironsworn-category-btn ironsworn-category-btn-active" data-category="all" type="button" style="padding: 0.5rem 1rem; background: rgba(224, 120, 120, 0.3); border: 1px solid rgba(224, 120, 120, 0.6); color: var(--SmartThemeBodyColor); cursor: pointer; border-radius: 4px; font-weight: bold;">All</button>
                <button class="ironsworn-category-btn" data-category="companion" type="button" style="padding: 0.5rem 1rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); color: var(--SmartThemeBodyColor); cursor: pointer; border-radius: 4px;">Companions</button>
                <button class="ironsworn-category-btn" data-category="path" type="button" style="padding: 0.5rem 1rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); color: var(--SmartThemeBodyColor); cursor: pointer; border-radius: 4px;">Paths</button>
                <button class="ironsworn-category-btn" data-category="combat_talent" type="button" style="padding: 0.5rem 1rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); color: var(--SmartThemeBodyColor); cursor: pointer; border-radius: 4px;">Combat Talents</button>
                <button class="ironsworn-category-btn" data-category="ritual" type="button" style="padding: 0.5rem 1rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); color: var(--SmartThemeBodyColor); cursor: pointer; border-radius: 4px;">Rituals</button>
            </div>
            <div style="max-height: 600px; overflow-y: auto; border: 1px solid rgba(224, 120, 120, 0.3); padding: 1rem; border-radius: 4px; background: rgba(0,0,0,0.1);">
                <div class="ironsworn-assets-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem;"></div>
            </div>
            <div class="ironsworn-assets-selected" style="margin-top: 1.5rem; padding: 1rem; background: rgba(224, 120, 120, 0.1); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; min-height: 2rem;">
                <strong style="color: var(--SmartThemeBodyColor);">Selected (0/3):</strong>
                <div class="ironsworn-selected-list" style="margin-top: 0.75rem; font-size: 0.9rem; color: var(--SmartThemeBodyColor);"></div>
            </div>
        `;
		masterForm.appendChild(stepAssets);
		formElements.assets = { selectedAssets: [], allAssets };

		// Populate assets
		const assetsCategories = stepAssets.querySelector(".ironsworn-assets-categories");
		const categoryBtns = assetsCategories.querySelectorAll(".ironsworn-category-btn");
		const assetsGrid = stepAssets.querySelector(".ironsworn-assets-grid");
		const selectedList = stepAssets.querySelector(".ironsworn-selected-list");
		const selectedCounter = stepAssets.querySelector(".ironsworn-assets-selected");

		function renderAssets(category) {
			assetsGrid.innerHTML = "";
			const filtered = category === "all" ? allAssets : allAssets.filter((a) => a.type === category);

			filtered.forEach((asset) => {
				const card = document.createElement("div");
				card.className = "ironsworn-asset-card";
			card.style.padding = "1.25rem";
			card.style.background = "rgba(0,0,0,0.2)";
			card.style.border = "2px solid rgba(224, 120, 120, 0.3)";
			card.style.borderRadius = "6px";
			card.style.cursor = "pointer";
			card.style.transition = "all 150ms ease";
			card.style.display = "flex";
			card.style.flexDirection = "column";
			card.style.minHeight = "200px";
				const isSelected = formElements.assets.selectedAssets.some((a) => a.name === asset.name);
				if (isSelected) {
					card.style.background = "rgba(224, 120, 120, 0.2)";
					card.style.borderColor = "rgba(224, 120, 120, 0.6)";
				}

			// Clean ability text: remove markdown links and ((PILLS)) markers
			const cleanAbilityDisplay = (text) => {
				if (!text) return "";
				// Remove markdown links like [Text](id:...)
				let cleaned = text.replace(/\[([^\]]+)\]\(id:[^\)]+\)/g, "$1");
				// Remove ((PILLS)) and other markers
				cleaned = cleaned.replace(/\(\(PILLS?\)\)/g, "").trim();
				return cleaned;
			};

			const abilitiesHtml = asset.abilities?.map((ab, idx) => {
				const cleanedText = cleanAbilityDisplay(ab.label);
				return `<div style="font-size: 0.8rem; color: #bbb; margin-top: 0.5rem; line-height: 1.4;">• ${cleanedText}</div>`;
			}).join('') || '<div style="font-size: 0.8rem; color: #888;">No abilities</div>';

			card.innerHTML = `
                    <div style="font-weight: 600; margin-bottom: 0.25rem; color: var(--SmartThemeBodyColor);">${asset.name}</div>
                    <div style="font-size: 0.75rem; color: #aaa; margin-bottom: 0.75rem; text-transform: capitalize;">${asset.type}</div>
                    <div style="font-size: 0.8rem; color: #ccc; border-top: 1px solid rgba(224, 120, 120, 0.2); padding-top: 0.5rem;">${abilitiesHtml}</div>
                    ${isSelected ? '<div style="margin-top: 0.75rem; color: #7fd694; font-weight: bold; text-align: center; padding: 0.25rem 0.5rem; background: rgba(127, 214, 148, 0.1); border-radius: 3px;">✓ Selected</div>' : ""}
                `;

				card.addEventListener("click", () => {
					const idx = formElements.assets.selectedAssets.findIndex((a) => a.name === asset.name);
					if (idx >= 0) {
						formElements.assets.selectedAssets.splice(idx, 1);
					} else if (formElements.assets.selectedAssets.length < 3) {
						formElements.assets.selectedAssets.push(asset);
					}
					renderAssets(category);
					updateAssetCounter();
				});

				card.addEventListener("mouseenter", () => {
					if (!isSelected) {
						card.style.background = "rgba(224, 120, 120, 0.15)";
						card.style.borderColor = "rgba(224, 120, 120, 0.5)";
					} else {
						card.style.borderColor = "rgba(224, 120, 120, 0.8)";
						card.style.boxShadow = "0 0 12px rgba(224, 120, 120, 0.2)";
					}
				});

				card.addEventListener("mouseleave", () => {
					if (!isSelected) {
						card.style.background = "rgba(0,0,0,0.2)";
						card.style.borderColor = "rgba(224, 120, 120, 0.3)";
					} else {
						card.style.borderColor = "rgba(224, 120, 120, 0.6)";
						card.style.boxShadow = "none";
					}
				});

				assetsGrid.appendChild(card);
			});
		}

		function updateAssetCounter() {
			selectedCounter.innerHTML = `<strong style="color: var(--SmartThemeBodyColor);">Selected (${formElements.assets.selectedAssets.length}/3):</strong>`;
			selectedList.innerHTML = formElements.assets.selectedAssets
				.map((a) => `<div style="margin: 0.25rem 0;">${a.name}</div>`)
				.join("");
		}

		categoryBtns.forEach((btn) => {
			btn.addEventListener("click", () => {
				categoryBtns.forEach((b) => {
					b.classList.remove("ironsworn-category-btn-active");
					b.style.background = "rgba(0,0,0,0.3)";
					b.style.borderColor = "rgba(224, 120, 120, 0.3)";
				});
				btn.classList.add("ironsworn-category-btn-active");
				btn.style.background = "rgba(224, 120, 120, 0.3)";
				btn.style.borderColor = "rgba(224, 120, 120, 0.6)";
				renderAssets(btn.dataset.category);
			});
		});

		renderAssets("all");

		// === STEP 4: BONDS ===
		const stepBonds = document.createElement("div");
		stepBonds.id = "step-bonds";
		stepBonds.className = "ironsworn-wizard-step-content";
		stepBonds.style.width = "100%";
		stepBonds.style.display = "none";
		stepBonds.style.boxSizing = "border-box";
		stepBonds.innerHTML = `
            <p style="margin-bottom: 1.5rem; font-size: 0.95rem; color: var(--SmartThemeBodyColor);">Create up to 3 bonds with people, communities, or meaningful groups.</p>
            <div id="bonds-container" style="display: flex; flex-direction: column; gap: 1rem;"></div>
            <button id="add-bond-btn" type="button" style="margin-top: 1rem; padding: 0.5rem 1rem; background: rgba(224, 120, 120, 0.2); border: 1px solid rgba(224, 120, 120, 0.5); color: rgba(224, 120, 120, 0.8); cursor: pointer; border-radius: 4px; font-weight: 600; transition: all 150ms ease;">+ Add Bond</button>
        `;
		masterForm.appendChild(stepBonds);
		formElements.bonds = { entries: [] };

		const bondsContainer = stepBonds.querySelector("#bonds-container");
		const addBondBtn = stepBonds.querySelector("#add-bond-btn");

		function addBondEntry(name = "", type = "NPC") {
			if (formElements.bonds.entries.length >= 3) return;

			const entryDiv = document.createElement("div");
			entryDiv.className = "ironsworn-bond-input";
			entryDiv.style.background = "rgba(0,0,0,0.2)";
			entryDiv.style.padding = "1rem";
			entryDiv.style.borderRadius = "4px";
			entryDiv.style.border = "1px solid rgba(224, 120, 120, 0.2)";
			entryDiv.style.display = "flex";
			entryDiv.style.gap = "1rem";
			entryDiv.style.alignItems = "flex-start";

			entryDiv.innerHTML = `
                <div style="flex: 1;">
                    <input type="text" class="bond-name ironsworn-form-input" placeholder="Bond name" value="${name}" style="width: 100%; padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem; margin-bottom: 0.5rem;">
                    <select class="bond-type ironsworn-form-input" style="width: 100%; padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem;">
                        <option value="NPC" ${type === "NPC" ? "selected" : ""}>NPC</option>
                        <option value="Community" ${type === "Community" ? "selected" : ""}>Community</option>
                        <option value="Place" ${type === "Place" ? "selected" : ""}>Place</option>
                        <option value="Faction" ${type === "Faction" ? "selected" : ""}>Faction</option>
                    </select>
                </div>
                <button class="remove-bond-btn" type="button" style="padding: 0.75rem 1rem; background: rgba(224, 120, 120, 0.2); border: 1px solid rgba(224, 120, 120, 0.5); color: rgba(224, 120, 120, 0.8); cursor: pointer; border-radius: 4px; font-weight: 600; margin-top: 1.75rem;">Remove</button>
            `;

			bondsContainer.appendChild(entryDiv);
			formElements.bonds.entries.push(entryDiv);

			entryDiv.querySelector(".remove-bond-btn").addEventListener("click", () => {
				entryDiv.remove();
				formElements.bonds.entries = formElements.bonds.entries.filter((e) => e !== entryDiv);
				addBondBtn.style.display = formElements.bonds.entries.length < 3 ? "block" : "none";
			});

			addBondBtn.style.display = formElements.bonds.entries.length < 3 ? "block" : "none";
		}

		// Add initial 3 empty bond entries
		addBondEntry();
		addBondEntry();
		addBondEntry();

		addBondBtn.addEventListener("click", () => addBondEntry());

		// === STEP 5: VOWS ===
		const stepVows = document.createElement("div");
		stepVows.id = "step-vows";
		stepVows.className = "ironsworn-wizard-step-content";
		stepVows.style.width = "100%";
		stepVows.style.display = "none";
		stepVows.style.boxSizing = "border-box";
		stepVows.innerHTML = `
            <p style="margin-bottom: 1.5rem; font-size: 0.95rem; color: var(--SmartThemeBodyColor);">Create two starting vows: an inciting vow (immediate problem) and a long-term vow (personal goal).</p>
            <div style="display: flex; flex-direction: column; gap: 2rem;">
                <div style="background: rgba(0,0,0,0.2); padding: 1.5rem; border-radius: 4px; border: 1px solid rgba(224, 120, 120, 0.2);">
                    <h3 style="font-weight: bold; margin: 0 0 1rem 0; color: var(--SmartThemeBodyColor); font-family: 'PR Viking', Georgia, serif;">Inciting Vow</h3>
                    <div style="margin-bottom: 1rem;">
                        <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Name</label>
                        <input type="text" id="vow1-name" class="ironsworn-form-input" placeholder="e.g., Bring peace" style="width: 100%; padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem;">
                    </div>
                    <div style="margin-bottom: 1rem;">
                        <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Description</label>
                        <textarea id="vow1-desc" class="ironsworn-form-input" placeholder="Describe this vow in detail..." style="width: 100%; padding: 0.75rem; height: 3rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem; resize: vertical;"></textarea>
                    </div>
                    <div>
                        <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Rank</label>
                        <select id="vow1-rank" class="ironsworn-form-input" style="width: 100%; padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem;">
                            <option value="Troublesome">Troublesome</option>
                            <option value="Dangerous">Dangerous</option>
                            <option value="Formidable" selected>Formidable (default)</option>
                            <option value="Extreme">Extreme</option>
                            <option value="Epic">Epic</option>
                        </select>
                    </div>
                </div>
                <div style="background: rgba(0,0,0,0.2); padding: 1.5rem; border-radius: 4px; border: 1px solid rgba(224, 120, 120, 0.2);">
                    <h3 style="font-weight: bold; margin: 0 0 1rem 0; color: var(--SmartThemeBodyColor); font-family: 'PR Viking', Georgia, serif;">Long-term Vow</h3>
                    <div style="margin-bottom: 1rem;">
                        <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Name</label>
                        <input type="text" id="vow2-name" class="ironsworn-form-input" placeholder="e.g., Clear our names" style="width: 100%; padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem;">
                    </div>
                    <div style="margin-bottom: 1rem;">
                        <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Description</label>
                        <textarea id="vow2-desc" class="ironsworn-form-input" placeholder="Describe this vow in detail..." style="width: 100%; padding: 0.75rem; height: 3rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem; resize: vertical;"></textarea>
                    </div>
                    <div>
                        <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: var(--SmartThemeBodyColor);">Rank</label>
                        <select id="vow2-rank" class="ironsworn-form-input" style="width: 100%; padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(224, 120, 120, 0.3); border-radius: 4px; color: var(--SmartThemeBodyColor); font-size: 1rem;">
                            <option value="Troublesome">Troublesome</option>
                            <option value="Dangerous">Dangerous</option>
                            <option value="Formidable">Formidable</option>
                            <option value="Extreme" selected>Extreme (default)</option>
                            <option value="Epic">Epic</option>
                        </select>
                    </div>
                </div>
            </div>
        `;
		masterForm.appendChild(stepVows);

		// === WIZARD NAVIGATION ===
		async function showStep(stepIndex) {
			if (stepIndex < 0 || stepIndex >= steps.length) return;

			currentStep = stepIndex;
			const { title } = steps[stepIndex];

			// Hide all steps
			masterForm.querySelectorAll(".ironsworn-wizard-step-content").forEach((el) => {
				el.style.display = "none";
			});

			// Show current step
			const currentStepEl = masterForm.querySelector(`#${steps[stepIndex].id}`);
			if (currentStepEl) {
				currentStepEl.style.display = "block";
			}

			// Ensure masterForm is visible and properly styled
			masterForm.style.display = "block";

			const modal = createCharacterWizardModal(stepIndex + 1, steps.length, title, masterForm, stepIndex === 0);

			const nextBtn = modal.querySelector(".ironsworn-wizard-next");
			const prevBtn = modal.querySelector(".ironsworn-wizard-previous");
			const cancelBtn = modal.querySelector(".ironsworn-wb-cancel");
			const errorMsg = modal.querySelector(".ironsworn-wb-error-message");

			if (stepIndex === steps.length - 1) {
				nextBtn.textContent = "Generate Tracker";
			}

			return new Promise((resolve) => {
				nextBtn.addEventListener("click", async () => {
					try {
						errorMsg.textContent = "";

						// Only validate on final step
						if (stepIndex === steps.length - 1) {
							// Collect all data
							const charName = masterForm.querySelector("#char-name").value.trim();
							const stats = {
								edge: Number(masterForm.querySelector('input[name="edge"]:checked')?.value) || 0,
								heart: Number(masterForm.querySelector('input[name="heart"]:checked')?.value) || 0,
								iron: Number(masterForm.querySelector('input[name="iron"]:checked')?.value) || 0,
								shadow: Number(masterForm.querySelector('input[name="shadow"]:checked')?.value) || 0,
								wits: Number(masterForm.querySelector('input[name="wits"]:checked')?.value) || 0,
							};

							const worldTruths = {};
							truthOrder.forEach((key) => {
								const radio = masterForm.querySelector(`input[name="${key}"]:checked`);
								if (radio) {
									if (radio.value === "custom") {
										const customInput = masterForm.querySelector(`.truth-${key}-input`);
										worldTruths[key] = customInput.value.trim();
									} else {
										worldTruths[key] = parseInt(radio.value);
									}
								}
							});

							const vow1Name = masterForm.querySelector("#vow1-name").value.trim();
							const vow1Desc = masterForm.querySelector("#vow1-desc").value.trim();
							const vow1Rank = masterForm.querySelector("#vow1-rank").value;

							const vow2Name = masterForm.querySelector("#vow2-name").value.trim();
							const vow2Desc = masterForm.querySelector("#vow2-desc").value.trim();
							const vow2Rank = masterForm.querySelector("#vow2-rank").value;

							const bonds = Array.from(masterForm.querySelectorAll(".ironsworn-bond-input"))
								.map((entry) => ({
									name: entry.querySelector(".bond-name").value.trim(),
									type: entry.querySelector(".bond-type").value,
								}))
								.filter((b) => b.name);

							// Validate
							if (!charName) throw new Error("Character name is required");

							const statValues = Object.values(stats);
							const hasValidStats =
								statValues.includes(3) &&
								statValues.includes(2) &&
								statValues.filter((v) => v === 2).length === 2 &&
								statValues.filter((v) => v === 1).length === 2;
							if (!hasValidStats) throw new Error("Stats must be exactly: 3, 2, 2, 1, 1");

							if (Object.keys(worldTruths).length === 0) throw new Error("Please select all world truths");
							if (formElements.assets.selectedAssets.length !== 3) throw new Error("You must select exactly 3 assets");
							if (bonds.length !== 3) throw new Error("You must have exactly 3 bonds");
							if (!vow1Name || !vow1Desc) throw new Error("Inciting vow requires a name and description");
							if (!vow2Name || !vow2Desc) throw new Error("Long-term vow requires a name and description");

							// Generate tracker
							const overlay = document.getElementById("ironsworn-character-wizard-overlay");
							if (overlay) overlay.remove();

							const tracker = generateCharacterTracker(
								{ name: charName, stats, inventory: masterForm.querySelector("#char-inventory").value.trim() },
								formElements.assets.selectedAssets,
								bonds,
								[
									{ name: vow1Name, description: vow1Desc, rank: vow1Rank },
									{ name: vow2Name, description: vow2Desc, rank: vow2Rank },
								],
								worldTruths
							);

							// Generate world truths lorebook entry
							try {
								const lorebookName = `Ironsworn_${charName}_WorldTruth`;
								const truthOrder = ["old_world", "iron", "legacies", "communities", "leaders", "defense", "mysticism", "religion", "firstborn", "beasts", "horrors"];
								const truthLabels = {
									old_world: "The Old World",
									iron: "Iron",
									legacies: "Legacies",
									communities: "Communities",
									leaders: "Leaders",
									defense: "Defense",
									mysticism: "Mysticism",
									religion: "Religion",
									firstborn: "Firstborn",
									beasts: "Beasts",
									horrors: "Horrors"
								};

								let truthContent = "**World Truths**\n\n";
								truthOrder.forEach((key) => {
									const truthValue = worldTruths[key];
									const label = truthLabels[key] || key;
									if (typeof truthValue === 'string') {
										truthContent += `**${label}**: ${truthValue}\n\n`;
									} else if (typeof truthValue === 'number') {
										const description = truths[key]?.options?.[truthValue]?.description;
										truthContent += `**${label}**: ${formatRuleText(description ?? `Option ${truthValue}`)}\n\n`;
									}
								});

								await addIronswornLorebookEntry(lorebookName, {
									key: [charName, "world truths"],
									comment: `${charName} - World Truths`,
									content: truthContent,
								});
							} catch (e) {
								console.warn("Could not generate world truths lorebook entry:", e);
							}

							// Show result modal
							const resultOverlay = document.createElement("div");
							resultOverlay.className = "ironsworn-worldbuilder-modal-overlay";
							const resultModal = document.createElement("section");
							resultModal.className = "ironsworn-worldbuilder-modal";
							
							// Format tracker for display with colors
							const formatTrackerForDisplay = (trackerText) => {
								return trackerText
									.replace(/When you/g, '<span style="color: #f4b860; font-weight: 600;">When you</span>')
									.replace(/Once you/g, '<span style="color: #f4b860; font-weight: 600;">Once you</span>')
									.replace(/If you/g, '<span style="color: #f4b860; font-weight: 600;">If you</span>')
									.replace(/Choose/g, '<span style="color: #f4b860; font-weight: 600;">Choose</span>')
									.replace(/add \+/g, '<span style="color: #7fd694;">add +</span>')
									.replace(/take \+/g, '<span style="color: #7fd694;">take +</span>')
									.replace(/roll \+/g, '<span style="color: #7fd694;">roll +</span>');
							};
							
							resultModal.innerHTML = `
                                <div class="ironsworn-worldbuilder-modal-header">
                                    <h2>Character Tracker Generated! 🎉</h2>
                                </div>
                                <div class="ironsworn-worldbuilder-modal-content" style="max-height: 500px; overflow-y: auto;">
                                    <p style="margin-bottom: 1rem;">Your character tracker has been generated. Copy the code below and paste it into Multihog's character tracker:</p>
                                    <div class="ironsworn-tracker-display" style="width: 100%; height: 300px; padding: 0.75rem; font-family: monospace; font-size: 0.85rem; background: #1a1a1a; border: 1px solid #555; border-radius: 0.25rem; overflow-y: auto; white-space: pre-wrap; word-break: break-word; color: #e0e0e0; line-height: 1.5;">${formatTrackerForDisplay(tracker)}</div>
                                    <textarea readonly style="width: 100%; height: 0; padding: 0; border: none; background: transparent; display: none;" class="ironsworn-tracker-plain">${tracker}</textarea>
                                </div>
                                <div class="ironsworn-worldbuilder-footer">
                                    <button class="ironsworn-copy-tracker" type="button">Copy to Clipboard</button>
                                    <button class="ironsworn-done-wizard" type="button">Done</button>
                                </div>
                            `;
							resultOverlay.append(resultModal);
							document.body.append(resultOverlay);

							const copyBtn = resultModal.querySelector(".ironsworn-copy-tracker");
							const doneBtn = resultModal.querySelector(".ironsworn-done-wizard");

							copyBtn.addEventListener("click", () => {
								navigator.clipboard
									.writeText(tracker)
									.then(() => {
										copyBtn.textContent = "✓ Copied!";
										setTimeout(() => {
											copyBtn.textContent = "Copy to Clipboard";
										}, 2000);
									})
									.catch((e) => console.error("Copy failed:", e));
							});

							doneBtn.addEventListener("click", () => {
								resultOverlay.remove();
								const wizardOverlay = document.getElementById("ironsworn-character-wizard-overlay");
								if (wizardOverlay) wizardOverlay.remove();
							});

							resolve();
							return;
						}

						// Navigate to next step without validation
						const overlay = document.getElementById("ironsworn-character-wizard-overlay");
						if (overlay) overlay.remove();
						await showStep(stepIndex + 1);
						resolve();
					} catch (error) {
						errorMsg.textContent = error.message;
					}
				});

				prevBtn.addEventListener("click", () => {
					const overlay = document.getElementById("ironsworn-character-wizard-overlay");
					if (overlay) overlay.remove();
					resolve();
					showStep(stepIndex - 1);
				});

				cancelBtn.addEventListener("click", () => {
					const overlay = document.getElementById("ironsworn-character-wizard-overlay");
					if (overlay) overlay.remove();
					resolve();
				});
			});
		}

		await showStep(0);

		// Cleanup: remove any remaining wizard overlays
		const overlay = document.getElementById("ironsworn-character-wizard-overlay");
		if (overlay) overlay.remove();
	} catch (error) {
		const errorMsg = `[Ironsworn Character Init] Error: ${error.message}`;
		console.error(errorMsg);

		// Cleanup on error too
		const overlay = document.getElementById("ironsworn-character-wizard-overlay");
		if (overlay) overlay.remove();

		const context = SillyTavern?.getContext?.();
		if (context?.toastr) {
			context.toastr.error(errorMsg, "Ironsworn Character Creator");
		} else {
			alert(errorMsg);
		}
	}
}

export function registerIronswornRollTool() {
	const context = SillyTavern.getContext();
	const { registerFunctionTool, unregisterFunctionTool } = context;
	if (typeof registerFunctionTool !== "function") return;

	unregisterFunctionTool?.(TOOL_NAME);
	registerFunctionTool({
		name: TOOL_NAME,
		displayName: "Ironsworn Roll",
		description:
			"Roll a Classic Ironsworn move by name. Move names are fuzzy-matched. Supply the stat bonus as an integer, plus any additional bonus and current momentum. The result includes the exact strong hit, weak hit, or miss outcome text from Datasworn. When momentum is greater than a losing challenge die, show the player a choice to reset momentum and remove every losing die below momentum. Wait for that choice before returning. Pass the character's assets so the tool can offer their abilities as an in-panel choice whenever they apply to this move (no need to track once-per-fight limits yourself; the tool offers them every time they are relevant).",
		parameters: {
			type: "object",
			properties: {
				move_name: {
					type: "string",
					description: "The name of the Classic Ironsworn move.",
				},
				stat: {
					type: "number",
					description: "The relevant stat bonus as an integer.",
				},
				additional_bonus: {
					type: "number",
					description: "Any additional bonus added to the player value.",
				},
				momentum: {
					type: "number",
					description: "The player momentum before this roll.",
				},
				quest_rank: {
					type: "string",
					enum: ["troublesome", "dangerous", "formidable", "extreme", "epic"],
					description:
						"The vow's quest rank. Required for Forsake Your Vow; ignored by other moves.",
				},
				current_supply: {
					type: "number",
					description:
						"Current supply value. Used by Out of Supply to determine penalty distribution. Optional.",
				},
				current_progress: {
					type: "number",
					description:
						"Progress boxes filled on the track (0-10). Required for progress rolls like Fulfill Your Vow or End the Fight. Momentum is ignored on progress rolls per Ironsworn rules.",
				},
				assets: {
					type: "array",
					description:
						"The character's equipped assets. Send only the asset name and its level (1-3, how many abilities are marked); the tool looks up the asset's real abilities and offers any that apply to this move as an in-panel choice.",
					items: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "The asset's name, e.g. Archer or Cave Lion.",
							},
							level: {
								type: "number",
								description: "How many of the asset's abilities are marked (1-3).",
							},
						},
						required: ["name", "level"],
					},
				},
			},
			required: ["move_name"],
			additionalProperties: false,
		},
		action: executeIronswornRoll,
		formatMessage: () => "",
	});
	unregisterFunctionTool?.(ORACLE_TOOL_NAME);
	registerFunctionTool({
		name: ORACLE_TOOL_NAME,
		displayName: "Ironsworn Oracle",
		description:
			"Roll a Classic Ironsworn oracle table by name. Oracle names are fuzzy-matched. Roll 1d100 and return the matching table result. Use the result as a narrative prompt and interpret it in context; this tool does not decide what the result means.",
		parameters: {
			type: "object",
			properties: {
				oracle_name: {
					type: "string",
					description: "The name of the Classic Ironsworn oracle table.",
				},
			},
			required: ["oracle_name"],
			additionalProperties: false,
		},
		action: executeIronswornOracle,
		formatMessage: () => "",
	});
}

function registerIronswornWorldBuilderCommand() {
	const context = SillyTavern?.getContext?.();
	const { registerSlashCommand } = context || {};
	if (typeof registerSlashCommand !== "function") {
		console.warn("[Ironsworn Roll] registerSlashCommand not available");
		return;
	}

	try {
		registerSlashCommand("ironsworn-init", handleIronswornCharacterInit, [], "Open the Ironsworn Character Creator to build your character and world with a guided multi-step wizard.", true, true);
		console.info("[Ironsworn Roll] /ironsworn-init command registered successfully");
	} catch (error) {
		console.error("[Ironsworn Roll] Failed to register /ironsworn-init command:", error);
	}
}

async function initialize() {
	try {
		await initializeSettings();
		registerIronswornRollTool();
		registerIronswornWorldBuilderCommand();
		console.info("[Ironsworn Roll] Tools and commands registered");
	} catch (error) {
		console.error("[Ironsworn Roll] Failed to register tools/commands:", error);
	}
}

const context = globalThis.SillyTavern?.getContext?.();
const eventSource = context?.eventSource;
const eventTypes = context?.event_types;
if (eventSource && eventTypes?.APP_READY) {
	eventSource.on(eventTypes.APP_READY, initialize);
} else {
	// Fallback: initialize immediately and also on window load
	initialize().catch(e => console.error("[Ironsworn Roll] Init error:", e));
	window.addEventListener("load", initialize, { once: true });
}
