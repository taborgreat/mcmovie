# Hardcore Games Kits Reference

Hardcore Games (hardcorepvp.com) is a last-player-standing Paper plugin using 1.8-style PvP: no attack cooldown, sweep attacks off, sprint crits on, legacy knockback, shields disabled, no ender-pearl cooldown, 4s natural regen tick. Before the match each player picks one of 48 kits with `/kit <id>`; picking nothing means playing as "None" with only the compass everyone gets. Mushroom stew is the healing economy (soup heals 7 HP); the feast is the only source of diamond gear. Numbers below are `config.yml` defaults from `GameConfig.java`.

**Match flow** (`GameState`): `WAITING` (lobby, kit selection, players parked at centre) -> `COUNTDOWN` (3 min, or 60s once 20+ players) -> `INVULNERABLE` -> `ACTIVE` -> `FEAST` -> `ENDING` -> `RESETTING`. At the drop everyone falls in from 20 blocks up, scattered within 50 blocks of centre (0,0). Invincibility lasts 120s; **every kit ability is locked until it ends** (passives like Fireman's immunity still apply). Late joiners are admitted during invincibility but get no kit. The map is a fixed 1000x1000 square (it does not shrink); stepping outside takes ramping damage (0.5 heart/s in a 10-block grace band, +2 dmg/s per block beyond) with a hard vanilla wall 20 blocks further out. At 17 min a grass feast circle (radius 15) appears within 200 blocks of centre; at 22 min an enchanting table and 12 loot chests (diamond gear, god apples, pearls, potions, soup, TNT, buckets) drop into it. At 55 min an End Game countdown starts; at 60 min everyone alive is teleported into a sealed bedrock box in the sky (21x21, 30 tall) and lava pours in from the ceiling one layer every 5s until nothing survives (unconditional kill at the end, so even a Fireman dies). Disconnecting within 3s of taking damage is an instant death; otherwise a 60s reconnect window, max 3 disconnects. Win condition: last one in the alive set; the winner is lifted onto a 5x5 cake platform with fireworks and chants, then the server restarts with a fresh world. Kill count is shown as the XP level; cooldowns drain on the XP bar.

### Anchor
- No starting items; cannot wear boots (any boots equipped are removed a tick later).
- Takes zero knockback from melee and deals zero melee knockback, so neither side can disengage and towers/ledges are safe to fight on.
- Plays an iron-golem footstep every 2.5 blocks walked, audible to everyone nearby — an Anchor is heard before seen.
- Counter (explicit): arrows and explosions still knock an Anchor around normally.

### Barbarian
- Starts with "Tyrfing", an unbreakable wooden sword stamped with the owner's UUID; a looted Tyrfing freezes at its tier and never grows for anyone else.
- Total XP *earned* (mob kills, ore, furnace, bottles, fishing) reforges the sword in place: wood 0 / stone 100 / iron 300 / diamond 700 / Sharpness I 2000 / II 3400 / III 5200 XP. Spending levels at an enchanting table costs no progress.
- Player kills pay an escalating bounty: 100 XP for the first, +100 more per subsequent kill (200, 300...); mob kills pay a flat 14.
- Weakness: starts strictly weaker than every geared kit and only snowballs through fighting or long grinding; upgrades skip silently while Tyrfing is out of the inventory.

### Beastmaster
- Starts with 3 wolf spawn eggs and 4 bones; every bone fed by a Beastmaster tames (vanilla's 1-in-3 roll is bypassed).
- Each tamed wolf gets permanent Speed I or Regeneration I (50/50) and fights like a vanilla wolf: piles onto whoever the owner hits or is hit by.
- Counter (explicit): go through the owner, not the dogs; wolves are a delay, not the threat. Taming during invincibility just hands other players free wolf kills. Wolves never target a Werewolf.

### Berserker
- No starting items. "Blood Lust": a mob kill grants Strength I for 10s; a player kill grants Strength II for 15s (a weaker buff never overwrites a stronger one).
- Drawback: while buffed the Berserker cannot jump at all (jump strength zeroed), so no chasing over terrain, no retreating up a block, no fighting from height.
- Plays on momentum: kill a mob on the way into a fight, chain player kills through a team. Counter: the wind-up is visible, and running punishes the rooted state.

### Cannibal
- Starts with 1 raw cod and 1 ocelot spawn egg (cod makes the ocelot trust you; ocelots scare creepers off).
- Every melee or projectile hit on a *player* restores 2 food + 1 saturation and applies Hunger I to the victim for 30s (refreshes, doesn't stack). Hitting mobs does nothing.
- Attrition kit: a Cannibal that keeps finding fights never needs to forage, and whoever it fights starves whether they win or flee.

### Cookiemonster
- No starting items; breaking grass/ferns has a 20% chance to drop a cookie.
- Eating a cookie is instant and prioritised: +2 food if hungry, else +1 heart if hurt, else Speed II for 5s. Hurt Cookiemonsters heal; healthy ones run.
- Counter (explicit): keep hitting them so cookies keep going into healing instead of Speed.

### Cultivator
- No starting items. Anything planted grows to maturity the tick it is placed: crops snap to max age, saplings/fungi/mushrooms become full trees (bonemeal loop with forced-tree fallback).
- Entirely scavenging-dependent: value is instant food from seeds, or instant cover/height/escape from a single sapling.

### Demoman
- Starts with 2 gravel and 2 stone pressure plates (one mine per pair). A plate placed on gravel *by a Demoman* is armed; the same blocks placed by anyone else are ordinary.
- Stepping on an armed plate (anyone, the Demoman included) detonates a 4.0-power explosion that breaks blocks; the gravel and plate vanish first so nothing drops.
- Breaking the plate or gravel defuses the mine. More mines require scavenging more gravel/plates.

### Digger
- Starts with 6 dragon eggs, each a one-shot trap; placed by any other kit they're inert eggs.
- Placing one hisses for 30 ticks (1.5s), then the 5x5 column under it drops 8 blocks (never through bedrock or containers). The egg is swallowed by its own hole unless knocked away first.
- Plays as a pursuit-breaker (drop one behind you) or an opener (pit a target, then finish them). Counter: the fuse is a visible warning; a trapped player with blocks can pillar out.

### Endermage
- Starts with one end portal frame. Placing it drags everyone in the 5x5 column above *and* below it (height ignored) to the frame, with 5s immunity for all dragged players and the caster; riders bring their horse.
- The block is cosmetic (reverts after ~1.5s); the item leaves the inventory and returns after 30s, so only one portal is ever in play.
- Pick/engage tool for pulling tower campers and cave hiders into melee. Weakness: a miss wastes the full 30s charge.

### Fighter
- Starts with a wooden sword and 2 cooked beef. No abilities, no passives.
- The plain "gear instead of a trick" option; not a fallback — picking no kit gives nothing.

### Fireman
- Starts with a water bucket. Immune to fire, burning, lava, lightning and hot-block contact damage (fire ticks reset too).
- Still drowns normally, including while submerged in lava, which is the kit's built-in limit on lava-camping. The End Game kill ignores immunity.
- Hard counter to Thor and Pyro; lava pools become safe cover. The bucket doubles as a cliff ladder, a safe descent, or (refilled with lava) a weapon.

### Fisherman
- Starts with a fishing rod. Hooking a player and reeling pulls the *victim* in a solved arc (at least 1.2 blocks above the path) to land at the Fisherman's feet — not a nudge, not a teleport.
- Range 32 blocks; the hook itself deals 1.0 damage (attribution); each victim can only be reeled once per 2s by anyone; each hook costs rod durability (~a dozen pulls per rod, per code comment).
- Counters towering, running and kiting; set up a hole and reel people into it. Weakness: a real flight path, so terrain in the way blocks it.

### Flash
- Starts with a redstone torch. Click with it (left or right) to teleport up to 60 blocks to the block you're looking at (open sky = full range, then gravity). Hops under 2 blocks are refused and cost nothing.
- Cost: Weakness I for 1s per 2 blocks travelled, plus a 150s (2:30) cooldown. Arrival fires a cosmetic lightning strike and a portal-particle trail along the path, so it is never stealthy.
- Escape or surprise-engage tool; a cross-map flash leaves you too weak to swing on arrival, so precise short flashes pay best.

### Forger
- Starts with 3 coal. In the inventory, drop a coal stack onto iron/gold/copper ore or raw metal to smelt instantly, 1 coal per ingot, no furnace, no smoke signature. No diamond recipe (the map has no diamond ore by design).
- Pure economy kit with zero combat power; value depends on finding coal and ore.

### Gambler
- Starts with a stone button (portable: break and re-place anywhere). Only a button placed *and* pressed by the Gambler pays out.
- Each press (10s cooldown) rolls a weighted table: ~12.4% each of Speed, Strength, Regeneration, full stomach, Slowness, Poison, Hunger II, Weakness (30s each), plus 0.1% full diamond armour and 0.1% instant death. The two jackpots are broadcast server-wide.
- Pure variance: no reliable power, equal odds of winning or losing the game on one press.

### Gladiator
- Starts with iron bars named "Shadow Game". Right-click an enemy to teleport both into a sealed 9x9 bedrock duel box at Y 230 (3s arrival immunity).
- Sealed for 60s (only exit is through the other fighter), then walls and ceiling fall away so a drop or outside arrows can end it. Quitting mid-duel is an instant forfeit.
- Survivor gets 15s to loot/heal, then returns within 50 blocks of the challenge spot (never exactly on it, to deny camping). 90s cooldown, one duel at a time, disabled once the End Game begins.

### Grandpa
- Starts with one plain-looking stick secretly enchanted Knockback II (enchant and glint hidden). No listener; the item is the kit.
- Negligible damage, huge knockback: knocks enemies off cliffs/towers, cuts off runners, buys time to soup. Only one exists — losing it loses the kit.

### Grappler
- Starts with a fishing rod named "Grappling Hook". Reeling in after the hook lands on terrain, a mob or a player launches the *Grappler* toward the hook (power 1.6 with gentle lift) — the mirror of Fisherman.
- Reeling resets fall distance, so hooking anything mid-fall (even air) saves the landing. 3 pulls per burst, then a 3s cooldown; each pull costs 4 rod durability (~16 pulls per rod).
- Mobility/escape kit limited by rod lifetime and burst cadence.

### Hades
- Starts with an iron ingot "wand" (never consumed). Right-click any mob to recruit it as a named minion, up to 5.
- Minions heel within 6 blocks, never hurt their owner (even a drafted creeper's blast), and all rally onto whoever the owner damages or is damaged by. Owner death disbands the army.
- Counter (explicit): minions keep their mob's own health and damage, so kill the mob or fight through them; passive mobs are only fodder/shields.

### Hermit
- No starting items; the only kit that overrides the drop point. Lands in the furthest swamp (preferred, for mushrooms), else jungle, else desert, else a random spot at least 300 blocks from centre.
- Uncontested early wood/stone/iron in isolation, at the cost of being far from the feast and the fighting.

### Horseman
- Starts with a horse spawn egg and 2 hay bales. The egg spawns an adult, tamed, saddled, iron-armoured horse with the player already mounted (speed 0.3, jump 0.7, 30 HP); usable from the drop, before abilities unlock.
- Only the owner can ever mount it. Each player kill fully heals the horse; hay bales heal it by hand.
- One horse per match: when it dies the kit is spent. No combat buff beyond mobility.

### Hulk
- No starting items; the ability needs an empty main hand. Right-click a player or mob to pick them up as a passenger (one at a time).
- Hold crouch to charge (2s to full, up to 2.5x), then left-click to throw along your look direction (base power 1.6, lift 0.6-0.8 capped). 5s cooldown after a throw.
- Victims escape by sneaking ("You wriggled free"). Counters (explicit): attack from behind, fight indoors where a throw goes nowhere, sneak the instant you're grabbed. Combos with cliffs and Demoman mines.

### Jackhammer
- Starts with a stone axe named "Hammer" (any stone axe works). Breaking a block with it breaks the whole column above, one block every 2 ticks up to the sky (blocks drop; bedrock/barriers/portal frames stop it).
- 5 uses per burst, then a 30s cooldown. Digs up only, never down: it pulls the ground out from under someone above you.
- Counter (explicit): stand on a platform wider than one block, and keep moving — the column is animated and can be outrun.

### Jellyfish
- No starting items; the empty hand is the kit. Right-click a block with nothing held to conjure a water source against it for 3s, then it drains.
- 4s cooldown, max 6 puddles live, never placed adjacent to existing water (prevents infinite springs), only into air/fire/replaceable blocks.
- Pure utility: break a fall, douse yourself, slow a chaser, ride water upward. No offensive tool at all.

### Kangaroo
- Starts with a "Rocket" (firework) that is never consumed. Right-click to launch yourself in your facing direction (forward 0.5, up 1.0) on a 5s vanilla item cooldown.
- Landing a hit on a player disables your fall damage for 8s, so you can chase someone off a cliff or dive-crit from above for free.
- Mobility only; no damage buff.

### Kaya
- Starts with 8 grass blocks; a Kaya-only recipe (dirt + wheat seeds) makes more.
- Grass placed by a Kaya vanishes the instant any other player stands on it (the owner never triggers it); a sheet over a ravine, pit or lava is an invisible kill trap. Digging a trap up disarms it.
- Counter (explicit): walk, don't sprint — a careful player sees the ground go and steps back.

### Launcher
- Starts with 20 sponges. Only sponges a Launcher placed are live; stepping on one throws the stepper (anyone, Launcher included) upward and grants 15s of fall immunity.
- Height comes from the stack beneath (0.58 per sponge, max 5) and from returned falling speed (1.0x restitution, hard cap ~60 blocks); direction comes from pad shape — an even pad throws straight up, (the sideways throw from a lopsided pad is switched off on the live server: pads throw straight up) a lopsided line/edge would throw sideways away from the mass (0.6).
- Mobility for the Launcher and a trap/launch pad for enemies; pads are dormant during invincibility and disarmed when broken.

### Monk
- Starts with a blaze rod (never consumed). Right-click a player with it to shove their held item out of the hotbar into the backpack (first free slot, or a random swap).
- 5s cooldown; touching an empty hand does nothing and spends no cooldown. The victim is told what was knocked away.
- Disarm kit: strongest against sword-dependent fighters, weakest against passives that don't need a held item.

### Ninja
- No starting items. Landing any hit (melee or arrow) marks that player for 10s; crouching inside the window teleports the Ninja onto them wherever they've gone, fall distance cleared.
- 7s cooldown between jumps; the mark expires if the target dies or leaves.
- Counter (explicit): you can't outrun it — survive 10s so the mark lapses before they crouch.

### Poseidon
- No starting items. While standing in water, melee (not arrows) deals 1.6x damage (a Strength I icon shows as a badge, its own bonus subtracted so it doesn't compound); swimming keeps air full.
- Leaving water applies Slowness I for 5s (cancelled early on re-entry). Floating still underwater drowns like anyone else.
- Bring a bucket to flood a feast or a shaft. Counter (explicit): remove the water, or fight them anywhere dry.

### Pyro
- Starts with flint and steel and 5 fire charges. Right-clicking a charge throws it as a fireball (not vanilla's lighter); impact is a 1.5-power block-breaking explosion that ignites everything within 3 blocks for 5s (the thrower excluded).
- No cooldown, no recharge: five decisions per match (open a fight, break one up, panic the feast). Flint and steel is the quiet half: cook mobs, make doorways expensive.
- Hard-countered by Fireman; water and Jellyfish puddles put the fire out.

### Reaper
- Starts with a wooden hoe "Scythe" (any wooden hoe works). Every hit landed *with the hoe* applies Wither I for 5s (refreshes, doesn't stack); hearts render black so the victim can't read their health.
- Wither can land the killing blow (unlike poison), which is what makes the weak hoe swing worth it. Swapping to a looted sword turns the curse off.

### Scorch
- Starts with "Flame Boots" (tagged leather boots) and a blaze powder. With boots worn and powder in main hand, real fire ignites 2 blocks behind every step; swap to a sword and the trail stops.
- The fire is vanilla fire: it spreads and burns the Scorch as readily as anyone, so stopping or doubling back is self-immolation. Chase/zoning tool: pursuers cross fire or break off.

### Snail
- No starting items. Every landed hit (melee or projectile, players and mobs) has a 1-in-3 chance to apply Slowness II for 5s. No cooldown.
- Passive chip control: makes runners catchable and lets the Snail disengage; also slows a chasing wolf.

### Soulstealer
- No starting items. The first death is intercepted: the Soulstealer rises where they fell, invisible, with 10s to touch another player (fail = dies for real).
- A touch marks the prey, ends invisibility and grants a stone sword; the prey must then die (by anyone) within 10s or the Soulstealer dies. All hunt damage is dealt at 40%.
- One extra life, earned by ambushing someone already weak; logging out mid-hunt is a normal death.

### Spiderman
- Starts with 6 ordinary snowballs (scoop more from snow). Each thrown snowball bursts into a 2x2 cobweb patch that lasts 20s. 3 throws per burst, then a 30s cooldown.
- Standing in any cobweb grants the Spiderman Speed IV (config level 4) and the webs are sent to their own client as air, so they move through freely while everyone else is stuck.
- Zone control and escape; webs are plain breakable blocks.

### Spy
- No starting items; the kit upgrades the universal compass. Clicking it locks the needle onto the nearest opponent, re-aiming every sweep, and reports their coordinates, distance and kit once per lock.
- Any opponent within 40 blocks triggers a one-time action-bar alert (name, kit, bearing, distance); anyone in line of sight within 96 blocks is identified with their kit every 0.5s.
- Pure information, all private; no combat buff. Knowing where someone is usually means being near them.

### Stomper
- Starts with 16 ladders (for height). The Stomper's own fall damage is capped at 4 (2 hearts); the *uncapped* amount is dealt to every player within 5 blocks of the landing, full value at the centre tapering to zero at the edge.
- A victim who is sneaking takes at most 4 from the stomp; armour reduces it normally. Damage is credited to the Stomper.
- Ambush kit: pillar up or find a cliff and drop onto a group. Counter: crouch when a Stomper is above you.

### Switcher
- Starts with 10 tagged "Switcher Balls" (looted snowballs don't count). A ball that hits any living entity swaps the thrower's and target's positions, fall distance wiped, 3s immunity for both.
- 10s cooldown between throws (throwing on cooldown is cancelled, not wasted); a miss consumes the ball.
- Pulls tower campers down and puts the Switcher on their perch, or trades out of a losing fight. Counter (explicit): dodge — every miss is a tenth of the kit gone.

### Tank
- No starting items. Explosion damage from any source never hurts a Tank (and blast-shove fall damage is waived for 5s).
- Killing a player detonates a 4.0-power explosion at the corpse (it breaks blocks); the victim's drops are held and released after the blast so loot survives.
- Anti-team kit: kill one in a cluster and everyone around the body takes the blast. Weakness: just as dangerous to your own allies near the corpse.

### Thor
- Starts with a plain wooden axe (re-craftable). Right-click any block to strike lightning on the *highest* block of that column — click the base of a pillar and it hits whoever is on top.
- Strikes above Y 80 shove harder (1.2 vs 0.7 within 4 blocks, with upward lift) and leave burning netherrack; striking that netherrack again detonates it at half TNT power. 3 strikes, then a 5s cooldown.
- Damage is vanilla lightning. Counters (explicit): a roof overhead eats the strike; Fireman is immune.

### Timelord
- Starts with a clock "Pocket Watch". Right-click to freeze every other player and mob within 6 blocks for 10s: frozen players are pinned in place (moves/teleports rolled back) but can still look and swing; they can't build or dig. Mobs have their AI disabled.
- Hitting a frozen player releases them early, so the Timelord chooses who moves. Cooldown is the 10s freeze plus 30s.
- Crowd control, not damage: isolate one target from a group, or survive a bad spawn.

### Turtle
- No starting items. While crouching, incoming damage is capped at 2 (1 heart), or 1 with a shield up (shields are disabled server-wide, so effectively 2); weaker hits land normally.
- Cannot attack at all while crouched. Explosions, the border, void and custom damage bypass the shell entirely (a Demoman mine kills a Turtle like anyone).
- Crouch-to-tank, stand-to-swing rhythm; also bait for a teammate. Counter (explicit): ignore the crouching Turtle and hit whoever else is there.

### Vampire
- No starting items. Any kill heals: 6 HP for a player, 2 for a mob. A "clean" player kill (no damage taken in the prior 10s) grants a "Vampire's Vial" splash that deals 2 to everyone else and heals the thrower 4.
- Inverted chemistry: Harming splashes heal the Vampire, Healing splashes hurt it (4 per intensity), so feast health potions and allies' heals are poison in their hands and enemy harming is a free heal.
- Walks out of team fights healthier than it entered; relies on securing kills.

### Viper
- No starting items. Every hit on a player (melee or projectile) has a 33% chance to apply Poison I for 5s (refreshes, doesn't stack).
- Poison can't kill (stops at half a heart): it's chip damage and panic that punishes running, towering and re-souping; a Viper still needs real damage to finish.

### Werewolf
- Starts with a clock (to read the time; there is no visual wolf disguise). Checked every 2s: at night (13000-23000) Strength I, Speed I and Night Vision; by day Weakness I and Night Vision is stripped at dawn.
- Wolves, tamed or wild, never target a Werewolf — a Beastmaster's dogs are "the wrong answer to this kit".
- Dominant in night fights; avoid fighting by day.

### Wisp
- Starts with 5 magma creams. Each use spawns 5 mannequin decoys wearing the Wisp's skin, name and current armour, drifting off in random directions for 60s.
- Decoys never attack, die to any hit, drop nothing; killing someone else's decoy costs the killer 1 heart for no reward (the Wisp can kill its own for free).
- Covers retreats, muddles chases, floods the feast as six people. Counter (explicit): the one swinging back is the real one.
