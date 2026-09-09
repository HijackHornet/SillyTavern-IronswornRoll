// This is the animateProgressRoll function to be inserted before animateRoll
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
