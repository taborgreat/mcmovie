package movie.labels;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.Sound;
import org.bukkit.SoundCategory;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Display;
import org.bukkit.entity.Entity;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Player;
import org.bukkit.entity.TextDisplay;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.event.Listener;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.block.BlockIgniteEvent;
import org.bukkit.event.block.BlockBurnEvent;
import io.papermc.paper.event.player.PlayerFailMoveEvent;
import org.bukkit.event.player.PlayerTeleportEvent;
import org.bukkit.util.Transformation;
import org.joml.Quaternionf;
import org.joml.Vector3f;

/** Studio-only labels. Riding the actor shares the client's interpolated position. */
public final class FilmLabels extends JavaPlugin implements Listener {
    private final Map<UUID, TextDisplay> labels = new HashMap<>();
    @Override public void onEnable() {
        if (getServer().getOnlineMode()) {
            getLogger().severe("FilmLabels is for the isolated offline film studio only.");
            getServer().getPluginManager().disablePlugin(this);
            return;
        }
        getCommand("filmlabel").setExecutor(this);
        getCommand("filmactor").setExecutor(this);
        Bukkit.getPluginManager().registerEvents(this, this);
        Bukkit.getScheduler().runTaskTimer(this, () -> {
            labels.entrySet().removeIf(entry -> {
                Player actor = Bukkit.getPlayer(entry.getKey());
                TextDisplay label = entry.getValue();
                if (actor == null || !actor.isOnline() || actor.isDead() || !label.isValid()) {
                    label.remove();
                    return true;
                }
                // Teleports may detach passengers. Reattach the same label, never
                // independently animate it toward a sampled coordinate.
                if (label.getVehicle() != actor) {
                    label.teleport(actor.getLocation());
                    actor.addPassenger(label);
                }
                boolean hidden = actor.isInvisible();
                if (label.isVisibleByDefault() == hidden) {
                    label.setVisibleByDefault(!hidden);
                    for (Player viewer : Bukkit.getOnlinePlayers()) {
                        if (hidden) viewer.hideEntity(this, label);
                        else viewer.showEntity(this, label);
                    }
                }
                return false;
            });
        }, 1L, 1L);
    }
    @Override public boolean onCommand(CommandSender sender, Command command, String alias, String[] args) {
        if (!sender.isOp()) return true;
        if (command.getName().equals("filmactor")) {
            if (args.length != 2) return false;
            for (Entity entity : Bukkit.selectEntities(sender, args[1])) {
                if (!replayActor(entity)) continue;
                if (args[0].equals("remove")) { entity.remove(); continue; }
                if (!(entity instanceof LivingEntity living)) continue;
                if (args[0].equals("die")) living.setHealth(0);
                else if (args[0].equals("hurt")) {
                    // Visual/audio evidence only: never simulate another combat hit.
                    living.playHurtAnimation(0);
                    Sound sound = living.getHurtSound();
                    if (sound != null) living.getWorld().playSound(living.getLocation(), sound,
                        living instanceof Player ? SoundCategory.PLAYERS : SoundCategory.NEUTRAL, 1, living.getSoundPitch());
                } else return false;
            }
            return true;
        }
        if (args.length == 1 && args[0].equals("clear")) { clear(); return true; }
        if (args.length < 3 || !args[0].equals("set")) return false;
        Player actor = Bukkit.getPlayerExact(args[1]);
        if (actor == null) return false;
        TextDisplay old = labels.remove(actor.getUniqueId());
        if (old != null) old.remove();
        String text = String.join(" ", java.util.Arrays.copyOfRange(args, 2, args.length));
        TextDisplay label = actor.getWorld().spawn(actor.getLocation(), TextDisplay.class, entity -> {
            entity.text(Component.text(text));
            entity.setBillboard(Display.Billboard.CENTER);
            entity.setSeeThrough(false);
            entity.setShadowed(true);
            entity.setGravity(false);
            entity.setPersistent(false);
            entity.setInvulnerable(true);
            entity.setTeleportDuration(0);
            entity.setTransformation(new Transformation(new Vector3f(0, 0.15f, 0), new Quaternionf(), new Vector3f(0.35f), new Quaternionf()));
            entity.addScoreboardTag("mlabel");
        });
        if (!actor.addPassenger(label)) {
            label.remove();
            throw new IllegalStateException("Cannot attach film label to " + actor.getName());
        }
        labels.put(actor.getUniqueId(), label);
        return true;
    }
    private void clear() { labels.values().forEach(TextDisplay::remove); labels.clear(); }
    private boolean replayActor(Entity entity) {
        return entity.getScoreboardTags().contains("mmob") ||
            (entity instanceof Player player && player.getName().matches("FilmActor\\d+"));
    }
    @EventHandler(priority = EventPriority.HIGHEST)
    public void retainRecordedMovement(PlayerFailMoveEvent event) {
        // Only actors explicitly attached by the director may bypass the live
        // game's movement correction. Interpolated edge/climb poses and real
        // recorded teleports are not a fresh attempt to play the match.
        if (!labels.containsKey(event.getPlayer().getUniqueId())) return;
        switch (event.getFailReason()) {
            case CLIPPED_INTO_BLOCK, MOVED_WRONGLY, MOVED_TOO_QUICKLY -> {
                event.setAllowed(true);
                event.setLogWarning(false);
            }
            default -> { } // unloaded chunks still stop movement
        }
    }
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void preventUnrecordedTeleport(PlayerTeleportEvent event) {
        if (!labels.containsKey(event.getPlayer().getUniqueId()) || event.getTo() == null) return;
        if (event.getCause() == PlayerTeleportEvent.TeleportCause.COMMAND) return; // director placement
        if (event.getFrom().getWorld() == event.getTo().getWorld() && event.getFrom().distanceSquared(event.getTo()) < 0.0001D) return; // skin refresh
        // A real portal or kit must not teleport the puppet a second time.
        // Recorded teleports arrive in the authoritative movement stream.
        event.setCancelled(true);
    }
    @EventHandler(priority = EventPriority.HIGHEST)
    public void preventUnrecordedDamage(EntityDamageEvent event) {
        if (replayActor(event.getEntity())) event.setCancelled(true);
    }
    // Recorded block changes are set explicitly by the replay. Natural fire or
    // an ability's second explosion must not create a different world history.
    @EventHandler(priority = EventPriority.HIGHEST)
    public void preventUnrecordedIgnition(BlockIgniteEvent event) { event.setCancelled(true); }
    @EventHandler(priority = EventPriority.HIGHEST)
    public void preventUnrecordedBurn(BlockBurnEvent event) { event.setCancelled(true); }
    @EventHandler(priority = EventPriority.HIGHEST)
    public void preserveRecordedBlocks(EntityExplodeEvent event) { event.blockList().clear(); }
    @Override public void onDisable() { clear(); }
}
