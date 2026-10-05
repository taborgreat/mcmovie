# Kit staging reference

How each Hardcore Games kit really behaves (read from the plugin's code in
`~/github/hardcorekits`, numbers from its `config.yml`) and how to put it on
screen with the primitives in `prompts/scene.md` and `prompts/outline.md`.
`prompts/reference/kits.md` says what a kit is for; this file says what it
must look like and what a scene may never show.

## How to use it

1. Outline: give every character a `"kit"` in story.json. Before choosing the
   turn, read `Looks like`, `Rules` and `Cannot show yet` for your kits. Do not
   build a turn on something listed under `Cannot show yet`.
2. Scene: stage the kit exactly as `Stage it` says and break nothing in
   `Rules`. `mcmovie validate` enforces the machine-readable part
   (`config/kit_rules.json`).
3. The kit plugin does not run on the set. Nothing happens by itself: every
   hit, flash, death, block change and flight is yours to stage.

Facts about the set server that matter here (from `lib/mc/server.js`,
`lib/mc/director.js`): difficulty is peaceful (hostile mobs cannot exist;
explosions do not injure actors), fall damage is off, fire neither spreads
nor burns out, mobs you summon wander on their own. Real fire and a real
`lightning` bolt DO hurt and ignite an actor standing in or within 3 blocks
of them, so keep actors out unless that is the point.

World event shapes used below: `{"tick","type":"setblock","at":[x,y,z],"block":"minecraft:..."}`,
`fill` (`from`,`to`,`block`), `summon` (`entity`,`at`, optional `nbt`),
`explode` (`at`, optional `power`, TNT is 4), `lightning` (`at`), `time`
(`value`), `kill` (`selector`), `command` (`cmd`). A `command` is a plain
vanilla 1.21.4 command; the ones marked (untested) have not been filmed yet,
so look at the frame after the first render.

Shared recipes (the entries refer to them by name):

- **HIT**: attacker within 3 blocks, facing the victim, `swing_once`; on the
  same tick the victim gets `knockback:0` (attacker standing or walking) or
  `knockback:1` (attacker on `sprint`), landing 3 / 7.6 blocks straight away.
  A hit that must not move the victim is `hurt` instead.
- **TELEPORT**: a keyframe with `fly` at tick T on the old spot and a keyframe
  at T+1 on the new spot (`fly` has no speed limit), then a normal anim.
  Arrive 1 block beside another actor, never on their block.
- **ARC**: a flight that is not a melee knockback (a throw, a launch, a reel).
  There is no gravity primitive for these, so use `fly` keyframes: one at
  the apex, one at the landing, then a normal anim. Never use `knockback:N`
  for these unless the entry says so.
- **FALL**: `fly` straight down. Real fall times: 5 blocks 12 ticks, 8 blocks
  15, 10 blocks 17, 15 blocks 21, 20 blocks 24, 30 blocks 30. Fall damage is
  (blocks fallen - 3) and is off on the set, so add `hurt` or `death` on the
  landing tick yourself (23 blocks kills an unarmoured player).
- **DOT**: damage over time is `hurt` one-shots at the stated ticks, victim
  staying in their current anim.

A player has 20 health (10 hearts). A sprint hit adds one knockback level for
every kit. Kit abilities are locked for the first 120 s of a match
(invincibility); passives still apply.

---

## Anchor
- Does: passive. Melee knockback is cancelled both ways: the Anchor is never moved by a melee hit and nobody the Anchor hits is moved. Arrows and explosions still move it. Boots come off a tick after being put on. An iron-golem step sounds every 2.5 blocks walked.
- Looks like: two players trading blows toe to toe and neither one shifting, most striking on a ledge or tower top where anyone else would be knocked off. No boots.
- Stage it: no kit item; give a weapon (`hold:minecraft:stone_sword`). Every hit in either direction is `swing_once` plus `hurt` on the victim with no position change. Armour without boots: `command` events `/item replace entity <id> armor.chest with minecraft:iron_chestplate` (same for `armor.head`, `armor.legs`); do not use `wear:`, it adds boots.
- Rules: never `knockback:N` on an Anchor from a melee hit, whatever the weapon (a Grandpa's stick moves nothing). Never `knockback:N` on anyone the Anchor hits, even when the Anchor sprints. Never boots. An `explode` may still throw it.
- Cannot show yet: the iron footsteps (no sound primitive reaches the film); an arrow knocking it back (no projectile primitive).

## Barbarian
- Does: passive. Starts with Tyrfing, an unbreakable wooden sword that reforges itself as XP is earned: stone at 100 XP, iron at 300, diamond at 700, then Sharpness I/II/III at 2000/3400/5200. The first player kill pays 100 XP and each later kill 100 more (100, 200, 300...); a mob kill pays 14.
- Looks like: the same sword getting better after each kill: wood, stone, iron, diamond.
- Stage it: `hold:minecraft:wooden_sword` at tick 0. A tick after the first victim's `death`: `hold:minecraft:stone_sword`. After the second kill `hold:minecraft:iron_sword`, after the fourth `hold:minecraft:diamond_sword`. Hold a beat on the hand after each change.
- Rules: the tier must match the kill count (0 kills wood, 1 stone, 2-3 iron, 4+ diamond; about 7 mob kills equal one player kill). The sword never breaks. A Tyrfing looted by someone else never upgrades.
- Cannot show yet: the Sharpness glint at 6+ kills (no enchanted-item primitive); the XP count (no HUD).

## Beastmaster
- Does: starts with 3 `wolf_spawn_egg` and 4 `bone`. Right-clicking an untamed wolf with a bone always tames it (red collar) and gives it Speed I or Regeneration I for the match. Tamed wolves attack whoever the owner hits or is hit by (vanilla). Wolves never target a Werewolf.
- Looks like: a player holding a bone with up to three wolves at their side, then the wolves on the enemy.
- Stage it: `hold:minecraft:bone`; `summon` `minecraft:wolf` 1-2 blocks from the actor (at most 3), `swing_once` toward each as the taming click. When the pack should be biting, keep the enemy near the wolves and give them `hurt` every 15-20 ticks.
- Rules: at most 3 wolves from the kit. Wolves never bite their owner or a Werewolf. The Beastmaster has no other power; killing the owner is the counter.
- Cannot show yet: wolves that heel, chase and bite on cue, or wear the red collar (no mob choreography primitive; summoned wolves wander).

## Berserker
- Does: passive on kill. A mob kill gives Strength I for 10 s, a player kill Strength II for 15 s (a weaker buff never replaces a stronger one). While buffed the Berserker cannot jump at all.
- Looks like: a kill, then the same player dropping the next target in far fewer hits, and staying on the ground: walking around a one-block step instead of hopping it.
- Stage it: kill something first: `summon` `minecraft:pig`, two `swing_once`, a `kill` event with `"selector":"@e[type=minecraft:pig]"`; then HIT the real target, who dies in about half the hits (Strength I adds 3 damage a hit, II adds 6). Keep the Berserker on `walk`/`sprint`.
- Rules: no `jump`, `jump_once` or climb onto a block for 200 ticks after a mob kill, 300 after a player kill. No buff without a kill first.
- Cannot show yet: nothing (the buff has no visible effect in the game either; show it as fewer hits to kill).

## Cannibal
- Does: starts with 1 `cod` and 1 `ocelot_spawn_egg`. Every hit on a player (melee or projectile) gives the Cannibal 2 food and 1 saturation and gives the victim Hunger I for 30 s. Hits on mobs do nothing.
- Looks like: nothing by itself, hunger is a HUD bar. On screen: the Cannibal never stops to eat; whoever fought it has to.
- Stage it: ordinary HIT exchanges. Afterwards the victim kneels (`sneak` on the spot) with `hold:minecraft:cooked_beef` while the Cannibal keeps moving. Optional `summon` `minecraft:ocelot` near the Cannibal as a prop. Let the narrator say the rest.
- Rules: normal knockback, no damage bonus. The ocelot does not follow or fight.
- Cannot show yet: the hunger bars (no HUD primitive).

## Cookiemonster
- Does: no items. Breaking `short_grass`, `tall_grass`, `fern` or `large_fern` drops a cookie 1 time in 5. Right-clicking a cookie is instant: +2 food if hungry, else +1 heart if hurt, else Speed II for 5 s.
- Looks like: a player punching grass, a cookie in hand, then a burst of speed nobody can match.
- Stage it: `setblock` `minecraft:short_grass` tufts at feet level; `swing_once` at one and `setblock` it to `minecraft:air` on the same tick; `hold:minecraft:cookie`; 10 ticks later `drop` (eaten) and `sprint` away while the chaser only `walk`s.
- Rules: a hurt Cookiemonster gets a heart back, not speed, so the escape only works at full health. No eating animation, it is instant. No grass, no cookies.
- Cannot show yet: the real Speed II pace, 7.9 blocks/s (no speed modifier on `sprint`, which is capped at 5.6).

## Cultivator
- Does: passive, no items. Anything planted is fully grown a tick later: crops at max age, saplings, mushrooms and fungi become full trees.
- Looks like: a sapling goes in the ground and a full tree is standing there.
- Stage it: `hold:minecraft:oak_sapling`, `swing_once` at the ground, `setblock` `minecraft:oak_sapling` at tick T; at T+1 a `fill` of `minecraft:oak_leaves` 5x3x5 centred 5 blocks up, then a `fill` of `minecraft:oak_log` 1x5x1 from the sapling's block up (or `command` `/place feature minecraft:oak <x> <y> <z>`, untested). Crops: `setblock` `minecraft:farmland` under `minecraft:wheat[age=7]`.
- Rules: growth is instant, never gradual. The Cultivator starts with nothing, so the sapling or seeds were found first.
- Cannot show yet: nothing.

## Demoman
- Does: starts with 2 `gravel` and 2 `stone_pressure_plate`. A plate the Demoman places on gravel is an armed mine. Anyone stepping on it, the Demoman included, sets off a power 4 explosion (TNT size, breaks blocks, no fire). Breaking the plate or the gravel disarms it.
- Looks like: a stone plate on a gravel block in the path; someone walks onto it; a TNT-sized blast and a crater.
- Stage it: `hold:minecraft:stone_pressure_plate`, `swing_once`, then `setblock` `minecraft:gravel` replacing the ground block and `setblock` `minecraft:stone_pressure_plate` on top of it. When the victim's keyframe reaches the plate: `explode` at the plate with `"power":4` and victim `death` on that tick; anyone within 4 blocks `hurt`.
- Rules: two mines at most. The plate must sit on gravel. It kills a crouching Turtle like anyone, throws an Anchor, and never hurts a Tank.
- Cannot show yet: nothing.

## Digger
- Does: starts with 6 `dragon_egg`. Placing one hisses for 30 ticks, then the 5x5 column under the egg, 8 blocks deep, is gone (the egg with it). Bedrock and chests stay.
- Looks like: a dragon egg set down, 1.5 s later a square pit opens and whoever stood there drops out of sight.
- Stage it: `hold:minecraft:dragon_egg`, `swing_once`, `setblock` `minecraft:dragon_egg` at feet level at tick T. At T+30: `setblock` the egg to air and one `fill` of `minecraft:air` from [x-2, ground_y-7, z-2] to [x+2, ground_y, z+2]. Everyone inside the 5x5 does a FALL of 8 blocks (15 ticks) with `hurt` on landing. Needs 8 blocks of ground under the stage (natural terrain).
- Rules: exactly 30 ticks from egg to hole. The pit is 5x5 centred on the egg; the Digger falls too if still inside it. Six eggs a match.
- Cannot show yet: the fuse hiss (no sound primitive).

## Endermage
- Does: starts with 1 `end_portal_frame`. Placing it teleports every player whose x and z are within 2 blocks of it, at any height above or below, to the frame, and the caster too. Everyone moved gets 5 s of immunity. The block vanishes after 30 ticks; the item returns after 30 s.
- Looks like: a portal frame is placed and the player who was on top of a tower or down a hole is suddenly standing next to the Endermage.
- Stage it: `hold:minecraft:end_portal_frame`, `swing_once`, `setblock` `minecraft:end_portal_frame` at T directly under or above the target; each victim does a TELEPORT at T to a spot 1 block from the frame; `setblock` air at T+30; `drop` the Endermage's hand at T.
- Rules: only players in that 5x5 column are pulled; height never matters. No `hurt`, `knockback` or `death` on the caster or anyone pulled for 100 ticks. One portal per 600 ticks.
- Cannot show yet: nothing.

## Fighter
- Does: starts with a `wooden_sword` and 2 `cooked_beef`. No ability.
- Looks like: a plain player with a wooden sword.
- Stage it: `hold:minecraft:wooden_sword`; HIT.
- Rules: nothing special ever happens around a Fighter.
- Cannot show yet: nothing.

## Fireman
- Does: passive. Fire, burning, lava, lightning and hot blocks (magma, campfire) do no damage and the flames go out. Starts with a `water_bucket`. Still drowns, even in lava.
- Looks like: a player standing calmly in fire or lava, or under a lightning bolt, unhurt.
- Stage it: `hold:minecraft:water_bucket`. At tick 0 `command` `/effect give <id> minecraft:fire_resistance infinite 0 true` so the set's real fire cannot hurt the actor, then `setblock` `minecraft:fire` or `minecraft:lava` under and around them and give them no `hurt`. Bucket use: `setblock` `minecraft:water`, later back to air.
- Rules: never `hurt` or `death` from fire, lava or lightning. A Thor strike still shoves a Fireman (`knockback:1`), it just does no damage. Explosions and melee hurt normally.
- Cannot show yet: a lightning bolt that leaves the Fireman untouched: the set's bolt really flashes and ignites an actor within 3 blocks (try `command` `/effect give <id> minecraft:resistance infinite 4 true`, untested; needs a harmless-lightning or invulnerable-actor primitive).

## Fisherman
- Does: starts with a `fishing_rod`. Hook a player and reel: the hook does 1 damage, then the victim flies an arc (peak at least 1.2 blocks above them, 0.15 block per block on long pulls) and lands at the Fisherman's feet. Range 32 blocks. A victim can be reeled once per 2 s.
- Looks like: rod in hand, a cast, and the victim yanked through the air to land right in front of the Fisherman: off a tower, off a ledge, into a hole.
- Stage it: `hold:minecraft:fishing_rod`, `swing_once` (cast), 15 ticks later `swing_once` (reel) with `hurt` on the victim, then the victim's ARC: apex above the midpoint (1.2 blocks up, 3 for a 20-block pull), landing 1 block in front of the Fisherman. Flight: 12 ticks for 10 blocks, 17 for 20, 22 for a pull down off a 10-block tower.
- Rules: the victim comes to the Fisherman, never the other way round. Terrain in the line of flight stops it. Never over 32 blocks. Not the same victim twice within 40 ticks.
- Cannot show yet: the line and bobber (no projectile primitive); the true arc (no ballistic primitive, `fly` segments are straight).

## Flash
- Does: starts with a `redstone_torch`. Clicking with it teleports to the block being looked at, up to 60 blocks (open sky: the full range, then a fall). Under 2 blocks is refused. Cost: Weakness I for 1 s per 2 blocks, 150 s cooldown. A cosmetic lightning bolt lands at the arrival point with a portal-particle trail.
- Looks like: torch in hand, the player is gone, and lightning cracks where they now stand.
- Stage it: `hold:minecraft:redstone_torch`, `swing_once` and TELEPORT at T, `lightning` at the arrival spot at T+1. Keep other actors 4+ blocks from the arrival spot.
- Rules: once per film (150 s). Arrival is never quiet. After a long flash its hits barely hurt (30 s of Weakness for 60 blocks), so it does not win a fight on arrival.
- Cannot show yet: a harmless bolt: the set's `lightning` is real and will flash and ignite the Flash himself (needs a cosmetic-lightning primitive; without it, put the bolt 4 blocks beside the arrival spot); the particle trail.

## Forger
- Does: starts with 3 `coal`. In the inventory, dropping coal onto iron, gold or copper ore (or raw metal) smelts it at once, one coal per ingot. No furnace.
- Looks like: nothing in the world; it is an inventory action. On screen: raw iron in hand, then ingots, then iron armour long before anyone else has it.
- Stage it: `hold:minecraft:raw_iron`, a beat, `hold:minecraft:iron_ingot`, later `wear:iron`. The narrator carries it.
- Rules: no combat effect at all. Needs coal and ore. No diamonds this way.
- Cannot show yet: the inventory screen (no HUD/GUI primitive).

## Gambler
- Does: starts with a `stone_button`. Place it and press it (10 s between presses): one of Speed I, Strength I, Regeneration I, a full stomach, Slowness I, Poison I, Hunger II, Weakness I, each about 1 in 8 and lasting 30 s; 1 in 1000 full diamond armour; 1 in 1000 instant death.
- Looks like: a button on a block, a press, and then something happens to the player: they bolt, stagger, drop dead, or stand in full diamond.
- Stage it: `hold:minecraft:stone_button`, `swing_once`, `setblock` `minecraft:stone_button[face=floor]` on a block (or `[face=wall,facing=north]` on its side); step back, `swing_once` at it. Outcome: `death` on that tick; or `wear:diamond`; or poison as DOT (`hurt` every 25 ticks); or `sprint` off (speed); or `walk` only (slowness).
- Rules: one roll per 200 ticks. Only the Gambler's own button, pressed by the Gambler. Bad results are as likely as good ones; the two jackpots are announced to the whole server.
- Cannot show yet: nothing.

## Gladiator
- Does: starts with `iron_bars` ("Shadow Game"). Right-click a player: both are teleported into a sealed bedrock box at y 230 above the spot: 9x9 floor inside, 4 high, glowstone in the four ceiling corners, fighters 4 blocks apart facing each other, 3 s immunity. After 60 s the walls and ceiling vanish. The survivor gets 15 s, then returns within 50 blocks of the start. 90 s cooldown.
- Looks like: iron bars in hand, both players vanish, cut to a dark bedrock room in the sky where the two of them fight alone.
- Stage it: world.json: a hollow `box` of `minecraft:bedrock`, size [11,6,11], high above the stage, with `setblock` `minecraft:glowstone` in the ceiling corners. Scene: `hold:minecraft:iron_bars`, `swing_once` at a victim within 3 blocks, both TELEPORT to the box floor, 4 blocks apart, `look_at` each other. Fight with HIT at `knockback:0` (the room is only 9 wide). Walls drop: `fill` walls and ceiling with air 1200 ticks after arrival.
- Rules: no `hurt` for 60 ticks after arrival. Nobody else is ever in the box and nobody leaves before one dies or 1200 ticks pass. The click needs melee reach.
- Cannot show yet: nothing.

## Grandpa
- Does: starts with one `stick` carrying hidden Knockback II (no glint). Every hit with it throws the victim 12.5 blocks on flat ground, 17.6 when the Grandpa is sprinting. It does a fist's damage.
- Looks like: an ordinary stick, one swing, and the victim sails away, ideally off a cliff.
- Stage it: `hold:minecraft:stick`; `swing_once` within 3 blocks; victim `knockback:2` (Grandpa standing or walking) or `knockback:3` (Grandpa on `sprint`), landing 12.5 / 17.6 blocks straight away and 21 / 23 ticks later. Put a ledge behind the victim and land them lower: they fall the whole way; add `hurt` or `death` on landing.
- Rules: only with the stick in hand; with anything else a hit is `knockback:0`/`1`. The stick does not kill; the fall does. There is one stick. An Anchor does not move.
- Cannot show yet: nothing.

## Grappler
- Does: starts with a `fishing_rod` ("Grappling Hook"). Reeling in with the hook in terrain, in a mob or player, or in open air 2+ blocks away launches the Grappler toward the hook: speed 1.6 along the line plus lift (0.4 + 0.04 per block, max 1.4), about 15 blocks per pull. Fall distance is wiped. 3 pulls, then 3 s rest.
- Looks like: rod in hand, a cast up at a tower or across a gap, and the Grappler flies to it.
- Stage it: `hold:minecraft:fishing_rod`, `swing_once` (cast), 10-20 ticks later `swing_once` (reel) and an ARC to the hook point: about 15 blocks in 20 ticks, apex 4-8 blocks up. No `hurt` on the landing.
- Rules: the Grappler moves, the thing hooked does not. Three pulls in a row at most, then 60 ticks without. A landing straight after a pull never hurts.
- Cannot show yet: the line and bobber (no projectile primitive); the true arc (no ballistic primitive).

## Hades
- Does: starts with an `iron_ingot` (a wand, never used up). Right-click any mob: it becomes a named minion, up to 5. Minions stay within 6 blocks, never hurt their owner, and all attack whoever the owner hits or is hit by. The army disbands when the owner dies.
- Looks like: a player with an iron ingot leading a small pack of mobs that turn on the enemy.
- Stage it: `hold:minecraft:iron_ingot`; `summon` up to 5 mobs close by and `swing_once` at each. The set is peaceful, so no zombies, skeletons, spiders or creepers: use `minecraft:iron_golem`, `minecraft:wolf`, `minecraft:cow`. When they should be attacking, keep the enemy among them with `hurt` every 15-20 ticks.
- Rules: five minions at most. They never hurt the Hades. Each dies like the mob it is. No Hades, no army.
- Cannot show yet: hostile-mob minions (peaceful set); minions that follow and attack on cue (no mob choreography primitive).

## Hermit
- Does: passive, no items. The only kit that changes the drop point: the furthest swamp from centre, else jungle, else desert, else at least 300 blocks out.
- Looks like: one player alone in a swamp, jungle or desert, gathering in peace while everyone else fights at centre.
- Stage it: needs a stage whose `terrain.json` biome is swamp, jungle or desert. The Hermit is alone in the opening scene; other characters only arrive later. Optional entrance: FALL of 20 blocks with no `hurt` (the drop is free for everyone).
- Rules: never near other players at the start. No combat ability. Far from the feast.
- Cannot show yet: nothing.

## Horseman
- Does: starts with a `horse_spawn_egg` and 2 `hay_block`. The egg hatches a tamed, saddled, iron-armoured horse with the owner already mounted (about 13 blocks/s, 30 health, jumps 3 blocks). Works even during invincibility. Only the owner can mount it. Each player kill heals the horse fully. One horse a match.
- Looks like: a player on an armoured horse outrunning everyone on foot.
- Stage it: only as a prop: `summon` `minecraft:horse` with `"nbt":"{Tame:1b,NoAI:1b,SaddleItem:{id:\"minecraft:saddle\",count:1},body_armor_item:{id:\"minecraft:iron_horse_armor\",count:1}}"` (untested) and the Horseman standing beside it with `hold:minecraft:hay_block`.
- Rules: nobody else is ever on that horse. If it dies there is no second one.
- Cannot show yet: riding at all (no mount primitive and no keyframed horse). Do not write a turn that needs the Horseman mounted.

## Hulk
- Does: no items; needs an empty main hand. Right-click a player or mob to lift them onto the shoulders (one at a time). Holding crouch charges for up to 2 s (throw x2.5). Left-click throws them where the Hulk looks: about 14 blocks uncharged, about 38 fully charged, 2-4 blocks high. 5 s cooldown. The victim gets free by sneaking.
- Looks like: an empty-handed player with someone on his shoulders, crouching to wind up, then the victim flying a long way, usually off something.
- Stage it: Hulk `drop` (empty hand), `swing_once` at a victim within 3 blocks; victim TELEPORT to the Hulk's x/z at y+1.8 and follows the Hulk's keyframes there on `fly`; Hulk `sneak` on the spot for up to 40 ticks; Hulk `swing_once`, victim ARC along the Hulk's facing: 14 blocks in 16 ticks (no charge) up to 38 blocks in 21 ticks (full charge), apex 2.4-4 blocks; `hurt` or a FALL at the end.
- Rules: the Hulk holds nothing while grabbing or throwing. One victim at a time. The throw goes where the Hulk faces. 100 ticks before the next grab. The throw itself does no damage; the landing does.
- Cannot show yet: the seated carry pose (no mount primitive); the true throw arc (no ballistic primitive).

## Jackhammer
- Does: starts with a `stone_axe` ("Hammer"). Breaking a block with it breaks every block above it in that column, one every 2 ticks, upward only. 5 uses, then 30 s.
- Looks like: a stone axe chops the base of a pillar and the pillar vanishes from the bottom up; whoever stood on top falls.
- Stage it: world.json pillar (`fill`, 1 wide). `hold:minecraft:stone_axe`, `swing` at the base for 10 ticks, `setblock` the base to air at T, the next block up at T+2, then T+4 and so on. The percher starts a FALL on the tick their block goes; `hurt`/`death` on landing.
- Rules: upward only, from the block that was broken, 10 blocks a second. The Jackhammer must be within reach of the base. A platform wider than one block keeps its other blocks.
- Cannot show yet: nothing.

## Jellyfish
- Does: no items; needs an empty hand. Right-click a block: a water source appears on that face for 3 s. 4 s cooldown, at most 6 at once, never next to other water.
- Looks like: an empty hand, water where there was none, gone three seconds later.
- Stage it: `drop`, `swing_once` at the block, `setblock` `minecraft:water` at T, `setblock` `minecraft:air` at T+60. Fall save: put the water on the landing block 5 ticks before a FALL ends and give no `hurt`. Dousing: `setblock` the `minecraft:fire` block to water.
- Rules: empty hand only. 80 ticks between waters. Always gone after 60 ticks. It is not a weapon.
- Cannot show yet: nothing.

## Kangaroo
- Does: starts with a `firework_rocket` ("Rocket", never used up). Right-click: launched 0.5 forward and 1.0 up in the facing direction: about 6 blocks high, 5 forward, 25 ticks in the air. 5 s cooldown. Landing a hit on a player turns fall damage off for 8 s.
- Looks like: a rocket in hand and a huge leap: over a wall, out of a pit, onto someone's head.
- Stage it: `hold:minecraft:firework_rocket`, `swing_once` at T, ARC: apex 6 blocks up and 2.5 forward at T+11, landing 5 blocks forward at T+25 (later and further if the ground is lower). A `jump` segment is only 1.25 high and is not this.
- Rules: one hop per 100 ticks. A hop on level ground costs about a heart on landing (`hurt`) unless the Kangaroo hit a player in the 160 ticks before. No damage bonus.
- Cannot show yet: the true arc (no ballistic primitive).

## Kaya
- Does: starts with 8 `grass_block` (a Kaya-only recipe, dirt plus wheat seeds, makes more). Grass the Kaya places vanishes the instant any other player stands on it. The Kaya never triggers it.
- Looks like: ordinary ground over a pit; the Kaya walks across; the chaser steps on it, the block is gone, and they drop.
- Stage it: world.json: a pit (`fill` air, 2+ wide, 6+ deep, lava at the bottom if wanted) roofed with `minecraft:grass_block` at ground level. To show the laying: `hold:minecraft:grass_block`, `swing_once`, `setblock`. The Kaya `walk`s over. On the tick the victim's keyframe is on a trap block: `setblock` it to air and start their FALL; `hurt`/`death` at the bottom.
- Rules: only the blocks a victim actually steps on vanish, one per step. The Kaya's own steps never do it. Grass blocks only.
- Cannot show yet: nothing.

## Launcher
- Does: starts with 20 `sponge`. A sponge the Launcher placed throws whoever steps on it straight up: 1 sponge about 2 blocks, 2 stacked about 8, 3 about 16, 4 about 26, 5 (the cap) about 40-60. Running momentum carries through. Dropping onto a pad bounces back as high as the fall. The first landing within 15 s is free. Dormant during invincibility.
- Looks like: yellow sponge in the ground; someone runs over it and is shot into the sky.
- Stage it: `hold:minecraft:sponge`, `swing_once`, `setblock` `minecraft:sponge` replacing the ground block (stack more below it for height). The stepper's ARC: straight up plus their running drift, apex after 16 / 28 / 41 ticks for 1 / 2 / 3 sponges, then a FALL with no `hurt`.
- Rules: it throws anyone, the Launcher included. Straight up plus existing momentum only; the sideways throw from lopsided pads is switched off in the config. The first landing never hurts; a second fall does.
- Cannot show yet: the true arc (no ballistic primitive).

## Monk
- Does: starts with a `blaze_rod` (never used up). Right-click a player: whatever they hold is moved out of their hand into their backpack. 5 s cooldown. Nothing happens to an empty hand.
- Looks like: a touch with a blaze rod and the opponent's sword is simply gone from their hand.
- Stage it: `hold:minecraft:blaze_rod`, `swing_once` at a victim within 3 blocks, victim `drop` on the same tick (that one-shot empties the hand; nothing lands on the ground). The victim swings bare-handed until a later `hold:` (40-60 ticks, they dig it back out).
- Rules: the touch does no damage and no knockback. Once per 100 ticks. The item is not lost and not on the floor.
- Cannot show yet: nothing.

## Ninja
- Does: no items. Hitting a player (melee or arrow) marks them for 10 s. Crouching inside that window teleports the Ninja onto them, wherever they are. 7 s between teleports. Fall distance is wiped.
- Looks like: a hit, the target gets away (or knocks the Ninja off a tower), the Ninja crouches and is instantly at their back.
- Stage it: HIT, the victim `sprint`s off; within 200 ticks the Ninja `sneak`s on the spot at T (2-3 ticks), TELEPORT to 1 block behind the victim with `look_at` the victim, then `swing_once` (HIT again).
- Rules: no teleport without the Ninja's own hit landed in the previous 200 ticks. 140 ticks between teleports. It always arrives at the marked player, never anywhere else. No `hurt` from the arrival.
- Cannot show yet: nothing.

## Poseidon
- Does: passive, no items. While standing in water its melee does 1.6x damage and swimming never drowns it. Leaving water gives Slowness I for 5 s (cancelled on getting back in).
- Looks like: a fighter who will not leave the pond and wins every fight in it; on dry land he is slow.
- Stage it: world.json: a pool (`fill` `minecraft:water`, 1 deep, 5+ wide). The Poseidon fights from inside it; victims die in about two thirds of the usual hits. For 100 ticks after stepping out he only `walk`s while others `sprint`.
- Rules: the bonus needs the Poseidon's own feet in water and applies to melee only. Never `sprint` within 100 ticks of leaving water. Knockback is normal.
- Cannot show yet: a swimming pose (scene.md lists no swim anim); the exact slowed pace (no speed modifier).

## Pyro
- Does: starts with `flint_and_steel` and 5 `fire_charge`. Right-click a charge: a fireball flies where the Pyro looks (1.2 blocks/tick). Impact: a power 1.5 explosion with fire that breaks blocks, and everything within 3 blocks except the Pyro burns for 5 s. No cooldown; five charges a match.
- Looks like: a fire charge in hand, a small blast where it lands, fire on the ground and players burning.
- Stage it: `hold:minecraft:fire_charge`, `swing_once` at T; at T + distance/1.2: `explode` at the target with `"power":1.5`, `setblock` `minecraft:fire` on 3-5 blocks at feet level around it, victims `hurt` then DOT every 20 ticks for 100 ticks (actors standing in the fire burn for real on the set). Flint: `hold:minecraft:flint_and_steel`, `swing_once`, `setblock` `minecraft:fire`.
- Rules: five fireballs a match. The Pyro never ignites from his own fireball. The blast is small: it hurts and scatters, it is not a one-shot kill. A Fireman does not burn. Water puts it out.
- Cannot show yet: the fireball in flight (no projectile primitive; `command` `/summon minecraft:small_fireball` with a Motion tag is untested).

## Reaper
- Does: starts with a `wooden_hoe` ("Scythe"). Every hit with the hoe gives the victim Wither I for 5 s: 1 damage every 2 s, and it can kill. Refreshes, never stacks.
- Looks like: a hoe used as a weapon; the victim keeps flashing red after the Reaper has stopped hitting, and can die while running away.
- Stage it: `hold:minecraft:wooden_hoe`; HIT; then DOT on the victim 40 and 80 ticks after the last hoe hit. A `death` may land on one of those ticks, away from the Reaper.
- Rules: only with the hoe in hand. The hoe itself hits like a fist, so a Reaper kill takes many hits or the wither finishing a wounded player. Knockback is normal.
- Cannot show yet: the black hearts (no HUD primitive).

## Scorch
- Does: starts with "Flame Boots" (`leather_boots`) and a `blaze_powder`. With the boots on and the powder in the main hand, each block the Scorch leaves catches fire, 2 blocks behind. It is real fire and burns the Scorch too.
- Looks like: leather boots, blaze powder in hand, a line of fire following the runner, the chaser burning or breaking off.
- Stage it: at tick 0 `command` `/item replace entity <id> armor.feet with minecraft:leather_boots` (not `wear:leather`, that is the full set); `hold:minecraft:blaze_powder`; as the Scorch runs, one `setblock` `minecraft:fire` per path block at feet level, each fired when the Scorch is 2 blocks past it (one every 3-4 ticks at `sprint`). A chaser who crosses it: `hurt` and DOT every 20 ticks.
- Rules: no trail with a sword (or anything but the powder) in hand. The fire is always behind, never under the Scorch. The Scorch never runs back through its own trail unhurt. Fire only on solid ground. A Fireman ignores it.
- Cannot show yet: nothing (set fire never burns out; clear it with a `fill` of air if the scene needs it gone).

## Snail
- Does: passive, no items. Each hit (melee or projectile, on players and mobs) has a 1 in 3 chance to give Slowness II for 5 s.
- Looks like: after taking a hit, the victim cannot get away: they move at a trudge and are caught.
- Stage it: two or three HITs; after one of them the victim flees on `walk` for 100 ticks while the Snail follows on `sprint`.
- Rules: about one hit in three, not every hit. 100 ticks. No damage bonus, normal knockback.
- Cannot show yet: the exact slowed pace, 30% slower (no speed modifier on movement anims).

## Soulstealer
- Does: passive, no items, once a match. On death the Soulstealer rises where they fell, invisible, with 10 s to hit a player. That hit marks the prey, ends the invisibility and gives a `stone_sword`; the prey must die (by anyone's hand) within 10 s or the Soulstealer dies for good. All its damage in the hunt is 40%.
- Looks like: the Soulstealer dies; seconds later someone is hit by nothing; the Soulstealer is standing there with a stone sword and ten seconds on the clock.
- Stage it: `death` at T; `respawn` at T+10 on the same spot with `command` `/effect give <id> minecraft:invisibility 10 0 true` (untested; held items and armour would still show, so `drop` and no `wear:`); the touch: `swing_once`, prey `hurt`, `command` `/effect clear <id> minecraft:invisibility`, `hold:minecraft:stone_sword`; then the prey's `death` or the Soulstealer's second `death` within 200 ticks.
- Rules: once only; the second death is final. The touch within 200 ticks of rising, the prey dead within 200 ticks of the touch. Its hits are weak, so the prey must already be hurt or be finished by someone else.
- Cannot show yet: nothing if the invisibility command films correctly (otherwise an invisible-actor primitive is missing).

## Spiderman
- Does: starts with 6 `snowball`. Each thrown snowball becomes a 2x2 patch of `cobweb`, one high, where it lands, for 20 s. 3 throws, then 30 s. Standing in any web gives the Spiderman Speed IV and webs do not hold him.
- Looks like: a snowball throw, cobwebs around the target who is suddenly stuck, the Spiderman running straight through.
- Stage it: `hold:minecraft:snowball`, `swing_once` at T; at T+10 a `fill` of `minecraft:cobweb` from [x,y,z] to [x+1,y,z+1] at the victim's feet level; the victim drops to `sneak` pace or `idle` while inside (actors are not slowed by blocks, you slow them); the Spiderman crosses on `sprint`; `fill` air 400 ticks later.
- Rules: three webs in a row at most, then 600 ticks. Webs last 400 ticks and do no damage. Everyone but the Spiderman crawls in them.
- Cannot show yet: the snowball in flight (no projectile primitive).

## Spy
- Does: passive, no items; upgrades the compass everyone has. Clicking it locks onto the nearest opponent and reports coordinates, distance and kit. Anyone coming within 40 blocks triggers an alert; anyone in sight within 96 blocks is named with their kit. All of it is private text.
- Looks like: nothing in the world. On screen: a player with a compass who is already facing the right way and ready when the ambusher arrives.
- Stage it: `hold:minecraft:compass`; `look_at` the hidden enemy's position before they appear; move or prepare first. The narrator says what the Spy knows.
- Rules: information only: no damage, speed or defence. The Spy is not warned of anyone further than 40 blocks unless looking at them.
- Cannot show yet: the readout itself (no HUD/text overlay primitive).

## Stomper
- Does: starts with 16 `ladder`. Its own fall damage is capped at 4 (2 hearts). On landing, the uncapped fall damage (blocks fallen - 3) hits every player within 5 blocks: full on the landing block, fading to nothing at 5. A sneaking victim takes 4 at most.
- Looks like: a player steps off a tower or cliff onto others below; they die or flash red and the Stomper walks away.
- Stage it: a drop of 23+ blocks to kill an unarmoured player at the landing point. Stomper FALL (24 ticks for 20 blocks), landing 1 block from the victim; on the landing tick the Stomper gets `hurt`, each victim within 5 blocks `death` or `hurt`, a `sneak`ing victim only `hurt`. Getting up: `hold:minecraft:ladder`, `setblock` `minecraft:ladder[facing=north]` up a pillar, climb on `fly` at 2.3 blocks/s.
- Rules: damage is (drop - 3) x (1 - distance/5): no height, no stomp, and a drop under 4 blocks does nothing. The Stomper still loses up to 2 hearts on a big drop and never more. A crouching victim at full health never dies to it.
- Cannot show yet: nothing (the fall is a straight `fly`; a gravity fall primitive would look better).

## Switcher
- Does: starts with 10 Switcher Balls (`snowball`). A ball that hits a player or mob swaps the thrower's and the target's positions; both get 3 s of immunity. 10 s between throws; a miss wastes the ball.
- Looks like: a snowball throw and the two players have traded places: the camper is on the ground, the Switcher on the tower.
- Stage it: `hold:minecraft:snowball`, `swing_once` at T; at T + distance/1.5 both do a TELEPORT on the same tick, each to exactly where the other stood. No `hurt` on either for 60 ticks.
- Rules: an exact swap, nothing else moves. 200 ticks between throws. Needs a clear throw. No damage.
- Cannot show yet: the ball in flight (no projectile primitive).

## Tank
- Does: passive, no items. Explosions never damage the Tank (and a fall within 5 s of being blasted is free). A player the Tank kills explodes where they died: power 4 (TNT), breaking blocks; the loot appears after the blast.
- Looks like: the Tank lands the killing blow, the body goes off like TNT, bystanders are thrown or killed, and the Tank stands in the crater untouched.
- Stage it: victim `death` at T; `explode` at their spot at T+1 with `"power":4`; others within 4 blocks get `death` or `hurt`; the Tank gets nothing. The set is peaceful, so the blast will not hurt actors by itself.
- Rules: only kills made by the Tank explode. Never `hurt` on a Tank from any explosion: mines, Pyro, its own. The Tank's allies near the body are hit like anyone.
- Cannot show yet: nothing.

## Thor
- Does: starts with a `wooden_axe`. Right-click a block: lightning hits the highest block of that column. Players within 4 blocks of the strike (not the Thor) are shoved away, about 5 blocks, or about 9 when the struck block is above y 80, where it also turns to burning netherrack. Striking that netherrack again explodes it (power 2, with fire). 3 strikes, then 5 s. The bolt does vanilla lightning damage (5, and sets alight).
- Looks like: a wooden axe, a click at the foot of a tower, a bolt on its top, and the camper blown off it.
- Stage it: `hold:minecraft:wooden_axe`, `swing_once` at a block within 4 blocks; same tick `lightning` at the top of that column; each player within 4 blocks of the bolt `knockback:1`, landing 5.5 blocks from the strike point (9 for a high strike) straight away from it, lower if off a tower (then `hurt`/`death` on landing). High strike: `setblock` `minecraft:netherrack` on the top block and `minecraft:fire` above it. Detonation: a second `lightning` plus `explode` with `"power":2`.
- Rules: the bolt always lands on the highest block of the clicked column; a roof takes it. The Thor needs a block within reach to click; he cannot strike at range. Three strikes, then 100 ticks. The Thor is not shoved by his own strike but is hurt if within 3 blocks. A Fireman takes no damage. Netherrack only above y 80.
- Cannot show yet: nothing.

## Timelord
- Does: starts with a `clock` ("Pocket Watch"). Right-click: every other player and mob within 6 blocks is frozen for 10 s: they cannot move, build or dig, but can look around and swing. Hitting a frozen player frees them. 40 s before the next cast.
- Looks like: a clock in hand and everyone nearby stops mid-stride while the Timelord walks among them and picks one.
- Stage it: `hold:minecraft:clock`, `swing_once` at T; every actor within 6 blocks holds position on `idle` for up to 200 ticks (they may `swing_once` and turn with `look_at`); the Timelord walks to one and HITs them: that victim takes `knockback:0` and moves freely from then on.
- Rules: frozen players do not walk, run, jump or teleport until 200 ticks pass or they are hit. Only those within 6 blocks at the cast. A frozen player can still hit the Timelord if he comes within reach. Once per film (40 s).
- Cannot show yet: the snowflakes around frozen players (particle commands do not show).

## Turtle
- Does: passive, no items. While crouching, any one hit does at most 2 damage (1 heart), and the Turtle cannot attack: its swing is cancelled. Explosions, the void and the border ignore the shell. The code does not touch knockback.
- Looks like: a crouched player taking a flurry of blows and still standing; it stands up to swing, then crouches again.
- Stage it: `sneak` on the spot while attackers `swing_once`; every hit lands (the Turtle flashes) and it survives: 10 hits from full health. To answer: a keyframe on `idle`, `swing_once` (HIT), back to `sneak`.
- Rules: never `swing` or `swing_once` from a Turtle whose anim is `sneak`. Never the `death` of a crouching Turtle from fewer than 10 melee or arrow hits. An `explode` kills it normally. Knockback is an open point: the plugin's code only caps damage, so by the code a crouching Turtle is shoved like anyone (`knockback:0`, 3 blocks); the owner's note says a Turtle takes no knockback (in the code that is the Anchor). Ask before a turn depends on it; if no-knockback is confirmed, use `hurt` with no movement and set `"no_knockback":"sneaking"` for `turtle` in `config/kit_rules.json`.
- Cannot show yet: nothing.

## Vampire
- Does: passive, no items. A kill heals: 6 health for a player, 2 for a mob. A clean kill (no damage taken in the 10 s before) gives a "Vampire's Vial", a splash potion that heals the Vampire 4 and deals 2 to everyone else it hits. Harming potions heal it; healing potions hurt it.
- Looks like: little by itself. On screen: the Vampire ends each kill fresher than it began and goes straight into the next fight while others stop to soup.
- Stage it: after a victim's `death`, the Vampire turns at once to the next target with no pause to heal. Vial: `hold:minecraft:splash_potion`, `swing_once` at the ground, others within 3 blocks `hurt`.
- Rules: healing comes only from kills. A vial only after a kill where the Vampire was not hit in the 200 ticks before. Never show it drinking or being splashed with healing to recover.
- Cannot show yet: the health coming back (no health bar in staged films); the thrown vial (no projectile primitive).

## Viper
- Does: passive, no items. Each hit on a player (melee or projectile) has a 33% chance to give Poison I for 5 s: 1 damage every 25 ticks, never below half a heart.
- Looks like: the victim keeps flashing red after getting away from the fight.
- Stage it: two or three HITs; after one of them DOT on the victim at +25, +50, +75 and +100 ticks.
- Rules: poison never kills: a `death` must fall on a real hit, never on a poison tick. About one hit in three. Players only, not mobs. Normal knockback.
- Cannot show yet: the green hearts (no HUD primitive).

## Werewolf
- Does: starts with a `clock`. Checked every 2 s: at night (time 13000-23000) Strength I, Speed I and Night Vision; by day Weakness I. Wolves never target a Werewolf. There is no wolf form.
- Looks like: the same player losing a fight in daylight and dominating it after dark.
- Stage it: `hold:minecraft:clock` in a quiet beat. Day scene: his hits barely hurt and he loses or runs. Then a `time` event (`"value":13000` or later) or a night scene: he `sprint`s, and victims die in about half the hits. `summon` `minecraft:wolf` nearby as wolves that leave him alone.
- Rules: strong only while the scene's time is 13000-23000; by day he is weaker than a kitless player, not equal. He always looks like an ordinary player. No wolf ever bites him.
- Cannot show yet: the Speed I pace (no speed modifier).

## Wisp
- Does: starts with 5 `magma_cream`. Using one spawns 5 decoys with the Wisp's skin, name and armour, each holding a magma cream, drifting off in random directions for 60 s. Decoys never attack and die to any hit; whoever kills one (other than the Wisp) loses 1 heart.
- Looks like: one player becomes six identical ones scattering; an attacker swings at one, it drops, and the attacker flinches.
- Stage it: `hold:minecraft:magma_cream`, `swing_once` at T. Decoys are extra characters in story.json with the Wisp's `skin`, their first keyframe at tick T on blocks next to the Wisp, `hold:minecraft:magma_cream`, the same `wear:`, each on `walk` in its own direction, never swinging. Attacker's `swing_once` at a decoy: decoy `death`, attacker `hurt` on the same tick.
- Rules: decoys never swing. One hit kills a decoy and always costs the killer a heart. Five decoys per cream, five creams. Decoys hold a magma cream, not the Wisp's weapon. The real Wisp is the one who swings back.
- Cannot show yet: true decoys: same name tag as the Wisp, and a death with no loot scatter (no decoy/clone actor primitive; five extra bots per cream is also heavy).

---

## Missing primitives

Ranked by how many kits need them.

1. **Ballistic flight** (13: Fisherman, Grappler, Hulk, Kangaroo, Launcher, Stomper, Digger, Kaya, Jackhammer, Thor, Tank, Demoman, Flash). An anim like `knockback:N` for any launch: given a start, an end and a launch speed or apex, fly the real gravity arc, and a `fall` that accelerates. Today these are straight `fly` segments.
2. **Health and status readout** (12: Turtle, Vampire, Viper, Reaper, Cannibal, Berserker, Poseidon, Werewolf, Soulstealer, Barbarian, Spy, Forger). A health bar over staged actors (match films already have one), plus a short on-screen text line for hunger, XP, compass and inventory facts.
3. **Thrown projectile and line** (6, plus arrow hits for Anchor, Ninja, Cannibal, Viper, Snail: Fisherman, Grappler, Pyro, Spiderman, Switcher, Vampire). An event that launches a snowball, fireball, potion, arrow or fishing bobber from an actor so it arrives at a point on a given tick, with the rod's line drawn.
4. **Speed modifier on movement anims** (6: Cookiemonster, Werewolf, Spiderman, Snail, Poseidon, Gambler). `sprint` and `walk` at Speed or Slowness pace, accepted by the validator.
5. **Sound cues that reach the film** (6: Anchor, Digger, Ninja, Endermage, Switcher, Hulk). A working `sound` event for the iron steps, the fuse hiss and the teleport pop.
6. **Choreographed mobs** (5: Beastmaster, Hades, Horseman, Cannibal, Wisp). Keyframes for a summoned mob or a decoy body: walk here, attack that actor, die without loot, share a name tag.
7. **Particles** (3: Timelord, Flash, Beastmaster). A `particle` event that shows: snowflakes, portal trail, hearts.
8. **Mounting** (2: Horseman, Hulk). Seat an actor on a horse or on another actor and move them together.
9. **Per-piece armour** (2: Anchor, Scorch). `wear:` for a single piece or a set without boots; today only through `command`.
10. **Harmless lightning and invulnerable actors** (2: Flash, Fireman). A bolt that is only a picture, and a flag that stops the set server hurting or igniting an actor.
11. **Swim and climb anims in scene.md** (2: Poseidon, Stomper). `lib/speeds.js` has the speeds; the scene prompt does not offer them.
