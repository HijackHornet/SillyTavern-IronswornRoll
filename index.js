// @ts-nocheck
import { extension_settings } from "../../../extensions.js";
import { power_user, loadMovingUIState } from "../../../power-user.js";
import { saveSettingsDebounced } from "../../../../script.js";

const TOOL_NAME = "IronswornMove";
const ORACLE_TOOL_NAME = "IronswornOracle";
const PANEL_ID = "ironsworn-roll-panel";
const EXTENSION_NAME = "IronswornRoll";
const DATASWORN_URL = new URL("./classic.json", import.meta.url);
const DATASWORN_FALLBACK_URL =
	"https://raw.githubusercontent.com/rsek/datasworn/main/datasworn/classic/classic.json";
let moveCatalogPromise;
let dataswornPromise;
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
	const move = await resolveMove(requestedMoveName);
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

		const response = {
			move: move.name,
			hit_type: roll.hitType,
			isMatch: roll.isMatch,
			quest_rank: questRank,
			experience: experienceTable[questRank][roll.hitType.replace(" ", "_")],
			outcome: formatRuleText(outcomeText),
		};
		if (selectedChoice !== null) response.choice = selectedChoice;
		if (outcomeChoices && !outcomeChoices.playerChoice)
			response.narrative_choices = outcomeChoices.options.map(
				(option) => option.label,
			);
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
	const rollArgs = {
		stats_bonus: stat,
		additional_bonus: args?.additional_bonus,
		momentum: args?.momentum,
	};
	const actionName = move.name;

	const panel = getPanel();
	const settings = getSettings();
	const rollStarted = renderRoll(panel, actionName);

	if (power_user?.movingUI === true) {
		normalizeMovingUIState();
		loadMovingUIState();
	}

	if (!settings.autoRoll) await rollStarted;
	const roll = calculateIronswornRoll(rollArgs);
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
	return JSON.stringify(response);
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
			"Roll a Classic Ironsworn move by name. Move names are fuzzy-matched. Supply the stat bonus as an integer, plus any additional bonus and current momentum. The result includes the exact strong hit, weak hit, or miss outcome text from Datasworn. When momentum is greater than a losing challenge die, show the player a choice to reset momentum and remove every losing die below momentum. Wait for that choice before returning.",
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

async function initialize() {
	try {
		await initializeSettings();
		registerIronswornRollTool();
		console.info("[Ironsworn Roll] Tool registered");
	} catch (error) {
		console.error("[Ironsworn Roll] Failed to register tool:", error);
	}
}

const context = globalThis.SillyTavern?.getContext?.();
const eventSource = context?.eventSource;
const eventTypes = context?.event_types;
if (eventSource && eventTypes?.APP_READY) {
	eventSource.on(eventTypes.APP_READY, initialize);
} else {
	initialize();
}
