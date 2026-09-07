// @ts-nocheck
import { extension_settings } from "../../../extensions.js";
import { power_user, loadMovingUIState } from "../../../power-user.js";
import { saveSettingsDebounced } from "../../../../script.js";

const TOOL_NAME = "IronswornRoll";
const PANEL_ID = "ironsworn-roll-panel";
const EXTENSION_NAME = "IronswornRoll";
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
			panel.remove();
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
				panel.remove();
				resolve({ hitType: roll.hitType, momentumUsed: false, actionName });
			},
			{ once: true },
		);
		actions.append(continueButton);
	});
}

export async function executeIronswornRoll(args) {
	const actionName = String(args?.action_name ?? "").trim();
	if (!actionName) throw new Error("action_name is required");

	const panel = getPanel();
	const settings = getSettings();
	const rollStarted = renderRoll(panel, actionName);

	if (power_user?.movingUI === true) {
		normalizeMovingUIState();
		loadMovingUIState();
	}

	if (!settings.autoRoll) await rollStarted;
	const roll = calculateIronswornRoll(args);
	renderDice(panel, roll);
	await animateRoll(panel, roll);

	const choice =
		settings.autoContinue &&
		(roll.hitType === "strong hit" || !roll.canUseMomentum)
			? { hitType: roll.hitType, momentumUsed: false, actionName }
			: roll.canUseMomentum
				? await waitForMomentumChoice(panel, roll, actionName)
				: await waitForContinue(panel, roll, actionName);

	if (
		settings.autoContinue &&
		(roll.hitType === "strong hit" || !roll.canUseMomentum)
	)
		panel.remove();

	return JSON.stringify({
		hit_type: choice.hitType,
		momentum_used: choice.momentumUsed,
		isMatch: roll.isMatch,
	});
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
			"Roll an Ironsworn move: 1d6 plus bonuses against two d10 challenge dice. A higher value than both dice is a strong hit, higher than one is a weak hit, otherwise it is a miss. When momentum is greater than a losing challenge die, show the player a choice to reset momentum and remove every losing die below momentum. Wait for that choice before returning.",
		parameters: {
			type: "object",
			properties: {
				action_name: {
					type: "string",
					description: "The name of the Ironsworn action or move.",
				},
				stats_bonus: {
					type: "number",
					description: "The player stat bonus added to the action d6.",
				},
				additional_bonus: {
					type: "number",
					description: "Any additional bonus added to the player value.",
				},
				momentum: {
					type: "number",
					description: "The player momentum before this roll.",
				},
			},
			required: ["action_name", "stats_bonus", "additional_bonus", "momentum"],
			additionalProperties: false,
		},
		action: executeIronswornRoll,
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
