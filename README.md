# Ironsworn Roll
## Disclaimer
This extension is vibecoded. While I usually write my own code, i let AI do this one.

## Introduction
This is an AI tool function to be used in Sillytavern that roll the player and challenge die and offer the player to use its momentum when possible.
It handles base Ironsworn rules, meaning it output matches, Strong/Weak/Miss hits, and if the player chose to *Burn momentum* to get this result.

While this extension could be used as is, it's meant to be used as part of my [Ironsworn with AI]("todo") setup. Have a look at it !

## Description

Registers the `IronswornRoll` and `IronswornOracle` SillyTavern function tools.

The tool resolves a Classic Ironsworn move by fuzzy-matching its name against Datasworn. Action rolls use 1d6 plus the supplied stat and additional bonuses against 2d10. No-roll moves are resolved without dice. When the player must choose, the panel shows only the available choices as vertical buttons. Multi-choice results submit automatically when the required number of options has been selected.

When momentum is negative and the action d6 equals its absolute value, the action d6 is cancelled and only the bonuses count toward the player value.

## Parameters

- `move_name`: the Classic Ironsworn move name; matching is case-insensitive and fuzzy
- `stat`: the relevant stat bonus as an integer for action rolls
- `additional_bonus`: any extra bonus for action rolls
- `momentum`: current momentum for action rolls
- `quest_rank`: the vow rank for `Forsake Your Vow` (`troublesome`, `dangerous`, `formidable`, `extreme`, or `epic`)

Enable function calling in SillyTavern's AI Response Configuration to allow a model to invoke the tool.

Action-roll results include `move`, `hit_type`, `momentum_used`, `isMatch`, and `outcome`. Mechanical choices that belong to the player are shown in the panel; the result includes the selected `choice`. Story-facing alternatives are returned immediately as `narrative_choices` for the AI or GM to interpret. No-roll results include `move`, `roll_type`, and `text`. `Forsake Your Vow` requires `quest_rank` and returns the corresponding `spirit_loss`. If the move cannot be resolved, the tool returns an error containing the invalid name and the full list of available move names.

The extension first tries to load `classic.json` beside `index.js`. If that file is not present, it falls back to the Classic Datasworn file on GitHub. For offline use, copy `datasworn/classic/classic.json` from the Datasworn repository into this extension folder.

`IronswornOracle` accepts `oracle_name`. It fuzzy-matches the name, rolls 1d100, and returns `oracle`, `roll`, and `result`. If the oracle cannot be found, the error includes the available oracle names. Oracle results are prompts for interpretation, not automatic narrative decisions.

`IronswornRoll` refuses the `Ask the Oracle` move because that move is handled by `IronswornAskOracle`. If a future Datasworn move contains an explicit structured `oracle_rolls` requirement, `IronswornRoll` resolves that oracle internally before making the action roll and includes the results in `oracle_results`. Text such as “Ask the Oracle if unsure” is optional guidance and does not trigger an automatic roll.

## Settings

- **Auto roll**: starts the roll without waiting for the Roll button. Default: off.
- **Play sound effects**: enables the roll, player, and challenge sounds. Default: on.
- **Auto continue**: closes automatically after a strong hit or when momentum cannot be used. Default: off.
