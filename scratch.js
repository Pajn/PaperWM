var Extension;
if (imports.misc.extensionUtils.extensions) {
    Extension = imports.misc.extensionUtils.extensions["paperwm@hedning:matrix.org"];
} else {
    Extension = imports.ui.main.extensionManager.lookup("paperwm@hedning:matrix.org");
}

var Clutter = imports.gi.Clutter;
var Meta = imports.gi.Meta;
var St = imports.gi.St;
var Main = imports.ui.main;

var TopBar = Extension.imports.topbar;
var Tiling = Extension.imports.tiling;
var utils = Extension.imports.utils;
var Tweener = utils.tweener;
var debug = utils.debug;
var float, scratchFrame; // symbols used for expando properties on metawindow
var backdrop;

class Backdrop {
    constructor(monitor) {
        this.monitor = monitor;
        let actor = new St.Widget({name: 'scratch-backdrop'});
        actor.set_style('background-color: rgba(0, 0, 0, 0.35);');
        this.actor = actor;

        Main.uiGroup.add_actor(this.actor);
    }

    show(animate) {
        if (this.destroyed)
            return;
        this.actor.width = this.monitor.width;
        this.actor.height = this.monitor.height;
        this.actor.set_position(this.monitor.x, this.monitor.y);
        this.actor.show();
        let time = animate ? 0.25 : 0;
        Tweener.addTween(this.actor,
                         {opacity: 255, time, mode: Clutter.AnimationMode.EASE_OUT_EXPO});
    }

    hide(animate) {
        if (this.destroyed)
            return;
        let time = animate ? 0.25 : 0;
        Tweener.addTween(this.actor,
                         {opacity: 0, time, mode: Clutter.AnimationMode.EASE_OUT_EXPO,
                          onComplete: () => this.actor.hide() });
    }

    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.actor.destroy();
        this.actor = null;
    }
}

function focusMonitor() {
    if (global.display.focus_window) {
        return Main.layoutManager.monitors[global.display.focus_window.get_monitor()]
    } else {
        return Main.layoutManager.primaryMonitor;
    }
}

/**
   Tween window to "frame-coordinate" (targetX, targetY).
   The frame is moved once the tween is done.

   The actual window actor (not clone) is tweened to ensure it's on top of the
   other windows/clones (clones if the space animates)
 */
function tweenScratch(metaWindow, targetX, targetY, tweenParams={}) {
    let Tweener = Extension.imports.utils.tweener;
    let Settings = Extension.imports.settings;
    let f = metaWindow.get_frame_rect();
    let b = metaWindow.get_buffer_rect();
    let dx = f.x - b.x;
    let dy = f.y - b.y;

    Tweener.addTween(metaWindow.get_compositor_private(), Object.assign(
        {
            time: Settings.prefs.animation_time,
            x: targetX - dx,
            y: targetY - dy,
        },
        tweenParams,
        {
            onComplete: function(...args) {
                metaWindow.move_frame(true, targetX , targetY);
                tweenParams.onComplete && tweenParams.onComplete.apply(this, args);
            }
        }));
}

function makeScratch(metaWindow) {
    let fromNonScratch = !metaWindow[float];
    let fromTiling = false;
    // Relevant when called while navigating. Use the position the user actually sees.
    let windowPositionSeen;

    if (fromNonScratch) {
        // Figure out some stuff before the window is removed from the tiling
        let space = Tiling.spaces.spaceOfWindow(metaWindow);
        fromTiling = space.indexOf(metaWindow) > -1;
        windowPositionSeen = metaWindow.clone.get_transformed_position().map(Math.round);
    }

    metaWindow[float] = true;
    metaWindow.make_above();
    metaWindow.stick();  // NB! Removes the window from the tiling (synchronously)

    if (!metaWindow.minimized) {
        backdrop.show(true);
        Tiling.showWindow(metaWindow);
    }

    if (fromTiling) {
        let f = metaWindow.get_frame_rect();
        let targetFrame = null;

        if (metaWindow[scratchFrame]) {
            let sf = metaWindow[scratchFrame];
            if (utils.monitorOfPoint(sf.x, sf.y) === focusMonitor()) {
                targetFrame = sf;
            }
        }

        if (!targetFrame) {
            // Default to moving the window slightly down and reducing the height
            let vDisplacement = 30;
            let [x, y] = windowPositionSeen;  // The window could be non-placable so can't use frame

            targetFrame = new Meta.Rectangle({
                x: x, y: y + vDisplacement,
                width: f.width,
                height: Math.min(f.height - vDisplacement, Math.floor(f.height * 0.9))
            })
        }

        if (!metaWindow.minimized) {
            metaWindow.move_resize_frame(true, f.x, f.y,
                                         targetFrame.width, targetFrame.height);
            tweenScratch(metaWindow, targetFrame.x, targetFrame.y,
                         {onComplete: () => delete metaWindow[scratchFrame]});
        } else {
            // Can't restore the scratch geometry immediately since it distort the minimize animation
            // ASSUMPTION: minimize animation is not disabled and not already done
            let actor = metaWindow.get_compositor_private();
            let signal = actor.connect('effects-completed', () => {
                metaWindow.move_resize_frame(true, targetFrame.x, targetFrame.y,
                                             targetFrame.width, targetFrame.height);
                actor.disconnect(signal)
            })
        }
    }

    let monitor = focusMonitor();
    if (monitor.clickOverlay)
        monitor.clickOverlay.hide();
}

function unmakeScratch(metaWindow) {
    if (!metaWindow[scratchFrame])
        metaWindow[scratchFrame] = metaWindow.get_frame_rect();
    metaWindow[float] = false;
    metaWindow.unmake_above();
    metaWindow.unstick();
}

function toggle(metaWindow) {
    if (isScratchWindow(metaWindow)) {
        unmakeScratch(metaWindow);
        hide();
    } else {
        makeScratch(metaWindow);

        if (metaWindow.has_focus) {
            let space = Tiling.spaces.get(global.workspace_manager.get_active_workspace());
            space.setSelectionInactive();
        }
    }
}

function isScratchWindow(metaWindow) {
    return metaWindow && metaWindow[float];
}

/** Return scratch windows in MRU order */
function getScratchWindows() {
    return global.display.get_tab_list(Meta.TabList.NORMAL, null)
        .filter(isScratchWindow);
}

function isScratchActive() {
    return getScratchWindows().some(metaWindow => !metaWindow.minimized);
}

function toggleScratch() {
    if (isScratchActive())
        hide();
    else
        show();
}

function toggleScratchWindow() {
    let focus = global.display.focus_window;
    if (isScratchWindow(focus))
        hide();
    else
        show(true);
}

function show(top) {
    let windows = getScratchWindows();
    if (windows.length === 0) {
        return;
    }
    if (top)
        windows = windows.slice(0,1);

    TopBar.show();
    backdrop.show(true);

    windows.slice().reverse()
        .map(function(meta_window) {
            meta_window.unminimize();
            meta_window.make_above();
            meta_window.get_compositor_private().show();
    });
    windows[0].activate(global.get_current_time());

    let monitor = focusMonitor();
    if (monitor.clickOverlay)
        monitor.clickOverlay.hide();
}

function hide() {
    let windows = getScratchWindows();
    windows.map(function(meta_window) {
        meta_window.minimize();
    });
    backdrop.hide(true);
}

// Monkey patch the alt-space menu
var PopupMenu = imports.ui.popupMenu;
var WindowMenu = imports.ui.windowMenu;
var originalBuildMenu = WindowMenu.WindowMenu.prototype._buildMenu;

function init() {
    float = Symbol();
    scratchFrame = Symbol();
}

function enable() {
    backdrop = new Backdrop(Main.layoutManager.primaryMonitor);
    WindowMenu.WindowMenu.prototype._buildMenu =
        function (window) {
            let item;
            item = this.addAction(_('Scratch'), () => {
                toggle(window);
            });
            if (isScratchWindow(window))
                item.setOrnament(PopupMenu.Ornament.CHECK);

            originalBuildMenu.call(this, window);
        };
}

function disable() {
    WindowMenu.WindowMenu.prototype._buildMenu = originalBuildMenu;
    if (backdrop) {
        backdrop.destroy();
        backdrop = null;
    }
}
