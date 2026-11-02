"use strict";

// smaller backgrounds are usually icons and sprites
const MIN_BACKGROUND_SIZE = 48;
// the page needs the mouse on these, so they hide anything underneath
const NO_ZOOM = "button,input,select,textarea,label,summary,video,audio,canvas,iframe,embed,object,[role=button],[role=slider]";

const settings = { ...DEFAULT_SETTINGS };

let session = null;
let pressTimer = null;
let lastMouse = null;
let blockClick = false;

chrome.storage.local.get(DEFAULT_SETTINGS).then(stored => Object.assign(settings, stored));
chrome.storage.onChanged.addListener(changes => {
    for (const key in changes) settings[key] = changes[key].newValue;
});

const saveZoomValues = debounce(() => {
    // the extension may have been reloaded since this tab was opened
    if (chrome.runtime?.id) chrome.storage.local.set({ zoom: settings.zoom, size: settings.size });
});

function imageSource(el) {
    if (el instanceof HTMLImageElement)
        // 1px images are spacers laid over the real image
        return el.naturalWidth > 1 && el.naturalHeight > 1 ? el.currentSrc || el.src : null;
    if (el instanceof SVGImageElement)
        return new URL(el.href.baseVal, el.baseURI).href;
    // gifs are often served as videos, blob: ones can't be loaded a second time
    if (el instanceof HTMLVideoElement && el.loop && el.muted && !el.controls && !el.currentSrc.startsWith("blob:"))
        return el.currentSrc || null;
    return null;
}

function hasBackgroundImage(el) {
    if (el === document.documentElement || el === document.body) return false;
    const { width, height } = el.getBoundingClientRect();
    return width >= MIN_BACKGROUND_SIZE && height >= MIN_BACKGROUND_SIZE
        && getComputedStyle(el).backgroundImage.includes("url(");
}

function hasOwnText(el) {
    return [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.data.trim());
}

function elementsAt(root, x, y, seen = new Set()) {
    const found = [];
    for (const el of root.elementsFromPoint(x, y)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.shadowRoot) found.push(...elementsAt(el.shadowRoot, x, y, seen));
        found.push(el);
    }
    return found;
}

function findTarget(x, y) {
    for (const el of elementsAt(document, x, y)) {
        if (el.isContentEditable) return null;
        if (imageSource(el)) return el;
        if (el.matches(NO_ZOOM) || hasOwnText(el)) return null;
        if (hasBackgroundImage(el)) return el;
    }
    return null;
}

// where the picture is drawn on screen, border and padding excluded
function pictureBox(target, isBackground) {
    const style = getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    const inset = side => (parseFloat(style[`border${side}Width`]) || 0)
        + (isBackground ? 0 : parseFloat(style[`padding${side}`]) || 0);
    return {
        left: rect.left + inset("Left"),
        top: rect.top + inset("Top"),
        width: rect.width - inset("Left") - inset("Right"),
        height: rect.height - inset("Top") - inset("Bottom"),
    };
}

function createBackgroundClone(style) {
    const clone = document.createElement("div");
    for (const prop of ["backgroundImage", "backgroundPosition", "backgroundSize", "backgroundRepeat", "backgroundOrigin", "backgroundClip", "backgroundColor", "padding"])
        clone.style[prop] = style[prop];
    clone.style.boxSizing = "border-box";
    return clone;
}

function createImageClone(target, style, src) {
    const clone = document.createElement(target instanceof HTMLVideoElement ? "video" : "img");
    if (target.crossOrigin) clone.crossOrigin = target.crossOrigin;
    if (target.referrerPolicy) clone.referrerPolicy = target.referrerPolicy;
    if (target instanceof HTMLVideoElement) {
        clone.poster = target.poster;
        clone.autoplay = clone.loop = clone.muted = true;
    }
    clone.src = src;
    clone.alt = "";
    clone.style.objectFit = target instanceof SVGImageElement ? "contain" : style.objectFit;
    clone.style.objectPosition = style.objectPosition;
    return clone;
}

function createHost(lens) {
    const host = document.createElement("div");
    host.className = "MagnifierContainer";
    // the top layer shows above modals and fullscreen elements
    host.setAttribute("popover", "manual");
    host.style.cssText = "all:initial !important;position:fixed !important;left:0 !important;top:0 !important;width:100% !important;height:100% !important;z-index:2147483647 !important;cursor:none !important;";
    host.attachShadow({ mode: "open" }).append(lens);
    return host;
}

function createLens(clone) {
    const lens = document.createElement("div");
    Object.assign(lens.style, {
        position: "absolute",
        border: "2px solid grey",
        borderRadius: settings.square ? "0" : "50%",
        overflow: "hidden",
        boxShadow: "inset 0 0 10px 2px grey",
        filter: "drop-shadow(0 0 2px grey)",

        // negate the border offsetting the lens
        margin: "-2px",
    });
    Object.assign(clone.style, {
        position: "absolute",
        transformOrigin: "0 0",
    });
    if (settings.nearestNeighbour) clone.style.imageRendering = "pixelated";
    lens.append(clone);
    return lens;
}

function updateMousePosition(e) {
    const { target, isBackground, host, lens, clone, size, zoom } = session;
    const rect = target.getBoundingClientRect();
    const mouseOver = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    lens.style.opacity = mouseOver ? "1" : "0";
    host.style.setProperty("cursor", mouseOver ? "none" : "auto", "important");
    if (!mouseOver) return;

    const box = pictureBox(target, isBackground);
    const offset = size / 2;
    const x = -((e.clientX - box.left) * zoom - offset);
    const y = -((e.clientY - box.top) * zoom - offset);
    lens.style.width = lens.style.height = size + "px";
    lens.style.transform = `translate(${e.clientX - offset}px, ${e.clientY - offset}px)`;
    clone.style.width = box.width + "px";
    clone.style.height = box.height + "px";
    clone.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
}

function startSession(e, target) {
    const style = getComputedStyle(target);
    const src = imageSource(target);
    const clone = src ? createImageClone(target, style, src) : createBackgroundClone(style);
    const lens = createLens(clone);
    const host = createHost(lens);

    document.documentElement.append(host);
    host.showPopover?.();

    session = {
        target,
        isBackground: !src,
        host,
        lens,
        clone,
        zoom: settings.zoom,
        size: settings.size,
        syncVideos: null,
    };

    if (clone instanceof HTMLVideoElement) {
        session.syncVideos = () => { clone.currentTime = target.currentTime; };
        target.addEventListener("timeupdate", session.syncVideos);
    }

    updateMousePosition(e);
}

function endSession() {
    if (session.syncVideos) session.target.removeEventListener("timeupdate", session.syncVideos);
    session.host.remove();
    session = null;
}

function cancelPress() {
    clearTimeout(pressTimer);
    pressTimer = null;
}

const onMouseDown = e => {
    if (e.button !== 0 /* left click */) return;
    cancelPress();
    if (session) endSession();

    const target = findTarget(e.clientX, e.clientY);
    if (!target) return;

    // stops the native image drag and text selection
    e.preventDefault();
    lastMouse = e;
    // a press released sooner than this is a click, not a zoom
    pressTimer = setTimeout(() => {
        pressTimer = null;
        startSession(lastMouse, target);
    }, settings.delay);
};

const onMouseMove = e => {
    if (!pressTimer && !session) return;
    // the release happened somewhere we couldn't see it
    if (!(e.buttons & 1)) {
        cancelPress();
        if (session) endSession();
        return;
    }
    lastMouse = e;
    if (session) updateMousePosition(e);
};

const onMouseUp = e => {
    if (e.button !== 0 /* left click */) return;
    cancelPress();
    if (!session) return;
    blockClick = true;
    // the click follows right after mouseup, and doesn't come at all if released off the image
    setTimeout(() => { blockClick = false; }, 50);
    endSession();
};

const onClick = e => {
    if (!blockClick) return;
    blockClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
};

const onWheel = e => {
    if (!session) return;
    e.preventDefault();
    e.stopImmediatePropagation();

    // browsers turn shift + wheel into horizontal scrolling
    const delta = (e.deltaY || e.deltaX) * (settings.invertScroll ? -1 : 1);

    if (!e.shiftKey) {
        const val = session.zoom + (delta / 100) * settings.zoomSpeed;
        session.zoom = val <= 1 ? 1 : val;
        if (settings.saveZoomValues) settings.zoom = session.zoom;
    } else {
        const val = session.size + delta * settings.zoomSpeed;
        session.size = val <= 50 ? 50 : val;
        if (settings.saveZoomValues) settings.size = session.size;
    }
    if (settings.saveZoomValues) saveZoomValues();
    updateMousePosition(e);
};

const onDragStart = e => {
    if (pressTimer || session) e.preventDefault();
};

const onBlur = () => {
    cancelPress();
    if (session) endSession();
};

window.addEventListener("mousedown", onMouseDown, true);
window.addEventListener("mousemove", onMouseMove, true);
window.addEventListener("mouseup", onMouseUp, true);
window.addEventListener("click", onClick, true);
window.addEventListener("wheel", onWheel, { capture: true, passive: false });
window.addEventListener("dragstart", onDragStart, true);
window.addEventListener("blur", onBlur);
