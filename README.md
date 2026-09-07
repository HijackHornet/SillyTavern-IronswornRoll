# Ironsworn Roll
## Disclaimer
This extension is vibecoded. While I usually write my own code, i let AI do this one.

## Introduction
This is an AI tool function to be used in Sillytavern that roll the player and challenge die and offer the player to use its momentum when possible.
It handles base Ironsworn rules, meaning it output matches, Strong/Weak/Miss hits, and if the player chose to *Burn momentum* to get this result.

While this extension could be used as is, it's meant to be used as part of my [Ironsworn with AI]("todo") setup. Have a look at it !

## Description

Registers the `IronswornRoll` SillyTavern function tool.

The tool rolls 1d6 plus the supplied stat and additional bonuses against 2d10. It returns JSON with `hit_type` (`strong hit`, `weak hit`, or `miss`), `momentum_used`, and `isMatch`, which is `true` when both challenge dice show the same value. When momentum can remove at least one losing challenge die, the tool waits for the player to choose whether to use it in a movable result panel.

When momentum is negative and the action d6 equals its absolute value, the action d6 is cancelled and only the bonuses count toward the player value.

## Parameters

- `action_name`: the move or action being attempted (visual only)
- `stats_bonus`: bonus from the relevant stat
- `additional_bonus`: any extra bonus
- `momentum`: current momentum

Enable function calling in SillyTavern's AI Response Configuration to allow a model to invoke the tool.

## Settings

- **Auto roll**: starts the roll without waiting for the Roll button. Default: off.
- **Play sound effects**: enables the roll, player, and challenge sounds. Default: on.
- **Auto continue**: closes automatically after a strong hit or when momentum cannot be used. Default: off.
