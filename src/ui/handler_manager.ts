import {Event} from '../util/evented';
import * as DOM from '../util/dom';
import HandlerInertia from './handler_inertia';
import {MapEventHandler, BlockableMapEventHandler} from './handler/map_event';
import BoxZoomHandler from './handler/box_zoom';
import TapZoomHandler from './handler/tap_zoom';
import {MousePanHandler, MouseRotateHandler, MousePitchHandler} from './handler/mouse';
import TouchPanHandler from './handler/touch_pan';
import {TouchZoomHandler, TouchRotateHandler, TouchPitchHandler} from './handler/touch_zoom_rotate';
import KeyboardHandler from './handler/keyboard';
import ScrollZoomHandler from './handler/scroll_zoom';
import DoubleClickZoomHandler from './handler/shim/dblclick_zoom';
import ClickZoomHandler from './handler/click_zoom';
import TapDragZoomHandler from './handler/tap_drag_zoom';
import DragPanHandler from './handler/shim/drag_pan';
import DragRotateHandler from './handler/shim/drag_rotate';
import TouchZoomRotateHandler from './handler/shim/touch_zoom_rotate';
import {bindAll, extend} from '../util/util';
import Point from '@mapbox/point-geometry';
import assert from 'assert';
import {vec3} from 'gl-matrix';
import {latFromMercatorY, mercatorScale} from '../geo/mercator_coordinate';

import type MercatorCoordinate from '../geo/mercator_coordinate';
import type {Map} from './map';
import type {MapEvents} from './events';
import type {Handler, HandlerResult} from './handler';

export type InputEvent = MouseEvent | TouchEvent | KeyboardEvent | WheelEvent;

/**
 * One of modifier [KeyboardEvent.key](https://developer.mozilla.org/docs/Web/API/KeyboardEvent/key) values.
 */
export type PitchRotateKey = 'Control' | 'Alt' | 'Shift' | 'Meta';

export type HandlerManagerOptions = {
    interactive: boolean;
    pitchWithRotate: boolean;
    clickTolerance: number;
    bearingSnap: number;
    pitchRotateKey?: PitchRotateKey;
};

type EventsInProgress = {
    [T in keyof MapEvents]?: MapEvents[T];
};

const isMoving = (p: EventsInProgress) => p.zoom || p.drag || p.pitch || p.rotate;

class RenderFrameEvent extends Event<{renderFrame: {timeStamp: number}}, 'renderFrame'> {
    override type: 'renderFrame';
    timeStamp: number;
}

class TrackingEllipsoid {
    constants: vec3;
    radius: number;

    constructor() {
        // a, b, c in the equation x²/a² + y²/b² + z²/c² = 1
        this.constants = [1, 1, 0.01];
        this.radius = 0;
    }

    setup(center: vec3, pointOnSurface: vec3) {
        const centerToSurface = vec3.sub([] as unknown as vec3, pointOnSurface, center);
        if (centerToSurface[2] < 0) {
            this.radius = vec3.length(vec3.div([] as unknown as vec3, centerToSurface, this.constants));
        } else {
            // The point on surface is above the center. This can happen for example when the camera is
            // below the clicked point (like a mountain) Use slightly shorter radius for less aggressive movement
            this.radius = vec3.length([centerToSurface[0], centerToSurface[1], 0]);
        }
    }

    // Cast a ray from the center of the ellipsoid and the intersection point.
    projectRay(dir: vec3): vec3 {
        // Perform the intersection test against a unit sphere
        vec3.div(dir, dir, this.constants);
        vec3.normalize(dir, dir);
        vec3.mul(dir, dir, this.constants);

        const intersection = vec3.scale([] as unknown as vec3, dir, this.radius);

        if (intersection[2] > 0) {
            // The intersection point is above horizon so special handling is required.
            // Otherwise direction of the movement would be inverted due to the ellipsoid shape
            const h = vec3.scale([] as unknown as vec3, [0, 0, 1], vec3.dot(intersection, [0, 0, 1]));
            const r = vec3.scale([] as unknown as vec3, vec3.normalize([] as unknown as vec3, [intersection[0], intersection[1], 0]), this.radius);
            const p = vec3.add([] as unknown as vec3, intersection, vec3.scale([] as unknown as vec3, vec3.sub([] as unknown as vec3, vec3.add([] as unknown as vec3, r, h), intersection), 2));

            intersection[0] = p[0];
            intersection[1] = p[1];
        }

        return intersection;
    }
}

function hasChange(result: HandlerResult) {
    return (result.panDelta && result.panDelta.mag()) || result.zoomDelta || result.bearingDelta || result.pitchDelta;
}

class HandlerManager {
    _map: Map;
    _el: HTMLElement;
    _handlers: Array<{
        handlerName: string;
        handler: Handler;
        allowed: Array<string>;
    }>;
    _eventsInProgress: EventsInProgress;
    _frameId: number | null | undefined;
    _inertia: HandlerInertia;
    _bearingSnap: number;
    _handlersById: {
        [key: string]: Handler;
    };
    _updatingCamera: boolean;
    _changes: Array<[HandlerResult, EventsInProgress, Record<string, InputEvent | RenderFrameEvent>]>;
    _previousActiveHandlers: {
        [key: string]: Handler;
    };
    _listeners: Array<[HTMLElement | Document | Window, string, undefined | AddEventListenerOptions]>;
    _trackingEllipsoid: TrackingEllipsoid;
    _dragOrigin: vec3 | null | undefined;
    _originalZoom: number | null | undefined;

    constructor(map: Map, options: HandlerManagerOptions) {
        this._map = map;
        this._el = this._map.getCanvasContainer();
        this._handlers = [];
        this._handlersById = {};
        this._changes = [];

        this._inertia = new HandlerInertia(map);
        this._bearingSnap = options.bearingSnap;
        this._previousActiveHandlers = {};
        this._trackingEllipsoid = new TrackingEllipsoid();
        this._dragOrigin = null;

        // Track whether map is currently moving, to compute start/move/end events
        this._eventsInProgress = {};

        this._addDefaultHandlers(options);

        bindAll(['handleEvent', 'handleWindowEvent'], this);

        const el = this._el;

        this._listeners = [
            // This needs to be `passive: true` so that a double tap fires two
            // pairs of touchstart/end events in iOS Safari 13. If this is set to
            // `passive: false` then the second pair of events is only fired if
            // preventDefault() is called on the first touchstart. Calling preventDefault()
            // undesirably prevents click events.
            [el, 'touchstart', {passive: true}],
            // This needs to be `passive: false` so that scrolls and pinches can be
            // prevented in browsers that don't support `touch-actions: none`, for example iOS Safari 12.
            [el, 'touchmove', {passive: false}],
            [el, 'touchend', undefined],
            [el, 'touchcancel', undefined],

            [el, 'mousedown', undefined],
            [el, 'mousemove', undefined],
            [el, 'mouseup', undefined],

            // Bind window-level event listeners for move and up/end events. In the absence of
            // the pointer capture API, which is not supported by all necessary platforms,
            // window-level event listeners give us the best shot at capturing events that
            // fall outside the map canvas element. Use `{capture: true}` for the move event
            // to prevent map move events from being fired during a drag.
            [document, 'mousemove', {capture: true}],
            [document, 'mouseup', undefined],

            [el, 'mouseover', undefined],
            [el, 'mouseout', undefined],
            [el, 'dblclick', undefined],
            [el, 'click', undefined],

            [el, 'keydown', {capture: false}],
            [el, 'keyup', undefined],

            [el, 'wheel', {passive: false}],
            [el, 'contextmenu', undefined],

            [window, 'blur', undefined]
        ];

        for (const [target, type, listenerOptions] of this._listeners) {
            const listener = target === document ? this.handleWindowEvent : this.handleEvent;
            target.addEventListener(type, listener as EventListener, listenerOptions);
        }
    }

    destroy() {
        for (const [target, type, listenerOptions] of this._listeners) {
            const listener = target === document ? this.handleWindowEvent : this.handleEvent;
            target.removeEventListener(type, listener as EventListener, listenerOptions);
        }
    }

    _addDefaultHandlers(options: HandlerManagerOptions) {
        const map = this._map;
        const el = map.getCanvasContainer();
        this._add('mapEvent', new MapEventHandler(map, options));

        const boxZoom = map.boxZoom = new BoxZoomHandler(map, options);
        this._add('boxZoom', boxZoom);

        const tapZoom = new TapZoomHandler();
        const clickZoom = new ClickZoomHandler();
        map.doubleClickZoom = new DoubleClickZoomHandler(clickZoom, tapZoom);
        this._add('tapZoom', tapZoom);
        this._add('clickZoom', clickZoom);

        const tapDragZoom = new TapDragZoomHandler();
        this._add('tapDragZoom', tapDragZoom);

        const touchPitch = map.touchPitch = new TouchPitchHandler(map);
        this._add('touchPitch', touchPitch);

        const mouseRotate = new MouseRotateHandler(options);
        const mousePitch = new MousePitchHandler(options);
        map.dragRotate = new DragRotateHandler(options, mouseRotate, mousePitch);
        this._add('mouseRotate', mouseRotate, ['mousePitch']);
        this._add('mousePitch', mousePitch, ['mouseRotate']);

        const mousePan = new MousePanHandler(options);
        const touchPan = new TouchPanHandler(map, options);
        map.dragPan = new DragPanHandler(el, mousePan, touchPan);
        this._add('mousePan', mousePan);
        this._add('touchPan', touchPan, ['touchZoom', 'touchRotate']);

        const touchRotate = new TouchRotateHandler();
        const touchZoom = new TouchZoomHandler();
        map.touchZoomRotate = new TouchZoomRotateHandler(el, touchZoom, touchRotate, tapDragZoom);
        this._add('touchRotate', touchRotate, ['touchPan', 'touchZoom']);
        this._add('touchZoom', touchZoom, ['touchPan', 'touchRotate']);

        this._add('blockableMapEvent', new BlockableMapEventHandler(map));

        const scrollZoom = map.scrollZoom = new ScrollZoomHandler(map, this);
        this._add('scrollZoom', scrollZoom, ['mousePan']);

        const keyboard = map.keyboard = new KeyboardHandler();
        this._add('keyboard', keyboard);

        for (const name of ['boxZoom', 'doubleClickZoom', 'tapDragZoom', 'touchPitch', 'dragRotate', 'dragPan', 'touchZoomRotate', 'scrollZoom', 'keyboard'] as const) {
            if (options.interactive && options[name]) {
                map[name].enable(options[name]);
            }
        }
    }

    _add(handlerName: string, handler: Handler, allowed?: Array<string>) {
        this._handlers.push({handlerName, handler, allowed});
        this._handlersById[handlerName] = handler;
    }

    stop(allowEndAnimation: boolean) {
        // do nothing if this method was triggered by a gesture update
        if (this._updatingCamera) return;

        for (const {handler} of this._handlers) {
            handler.reset();
        }
        this._inertia.clear();
        this._fireEvents({}, {}, allowEndAnimation);
        this._changes = [];
        this._originalZoom = undefined;
    }

    isActive(): boolean {
        for (const {handler} of this._handlers) {
            if (handler.isActive()) return true;
        }
        return false;
    }

    isZooming(): boolean {
        return !!this._eventsInProgress.zoom || this._map.scrollZoom.isZooming();
    }

    isRotating(): boolean {
        return !!this._eventsInProgress.rotate;
    }

    isMoving(): boolean {
        return !!isMoving(this._eventsInProgress) || this.isZooming();
    }

    _isDragging(): boolean {
        return !!this._eventsInProgress.drag;
    }

    _blockedByActive(
        activeHandlers: {
            [key: string]: Handler;
        },
        allowed: Array<string>,
        myName: string,
    ): boolean {
        for (const name in activeHandlers) {
            if (name === myName) continue;
            if (!allowed || allowed.indexOf(name) < 0) {
                return true;
            }
        }
        return false;
    }

    handleWindowEvent(e: InputEvent) {
        this.handleEvent(e, `${e.type}Window`);
    }

    _getMapTouches(touches: TouchList): TouchList {
        const mapTouches = [];
        for (const t of touches) {
            const target = (t.target as Node);
            if (this._el.contains(target)) {
                mapTouches.push(t);
            }
        }
        return mapTouches as unknown as TouchList;
    }

    handleEvent(e: InputEvent | RenderFrameEvent, eventName?: string) {
        this._updatingCamera = true;
        assert(e.timeStamp !== undefined);

        const isRenderFrame = e.type === 'renderFrame';
        const inputEvent = isRenderFrame ? undefined : e;

        /*
         * We don't call e.preventDefault() for any events by default.
         * Handlers are responsible for calling it where necessary.
         */

        const mergedHandlerResult: HandlerResult = {needsRenderFrame: false};
        const eventsInProgress: EventsInProgress = {};
        const activeHandlers: Record<string, Handler> = {};

        const mapTouches = (e as TouchEvent).touches ? this._getMapTouches((e as TouchEvent).touches) : undefined;
        const points = mapTouches ? DOM.touchPos(this._el, mapTouches) :
            isRenderFrame ? undefined : // renderFrame event doesn't have any points
            DOM.mousePos(this._el, (e as MouseEvent));

        for (const {handlerName, handler, allowed} of this._handlers) {
            if (!handler.isEnabled()) continue;

            let data: HandlerResult | null | undefined;
            if (this._blockedByActive(activeHandlers, allowed, handlerName)) {
                handler.reset();

            } else {
                if (handler[eventName || e.type]) {
                    data = handler[eventName || e.type](e, points, mapTouches);
                    this.mergeHandlerResult(mergedHandlerResult, eventsInProgress, data, handlerName, inputEvent);
                    if (data && data.needsRenderFrame) {
                        this._triggerRenderFrame();
                    }
                }
            }

            if (data || handler.isActive()) {
                activeHandlers[handlerName] = handler;
            }
        }

        const deactivatedHandlers: Record<string, InputEvent | RenderFrameEvent> = {};
        for (const name in this._previousActiveHandlers) {
            if (!activeHandlers[name]) {
                deactivatedHandlers[name] = inputEvent;
            }
        }
        this._previousActiveHandlers = activeHandlers;

        if (Object.keys(deactivatedHandlers).length || hasChange(mergedHandlerResult)) {
            this._changes.push([mergedHandlerResult, eventsInProgress, deactivatedHandlers]);
            this._triggerRenderFrame();
        }

        if (Object.keys(activeHandlers).length || hasChange(mergedHandlerResult)) {
            this._map._stop(true);
        }

        this._updatingCamera = false;

        const {cameraAnimation} = mergedHandlerResult;
        if (cameraAnimation) {
            this._inertia.clear();
            this._fireEvents({}, {}, true);
            this._changes = [];
            cameraAnimation(this._map);
        }
    }

    mergeHandlerResult(mergedHandlerResult: HandlerResult, eventsInProgress: EventsInProgress, handlerResult: HandlerResult, name: string, e?: InputEvent | RenderFrameEvent) {
        if (!handlerResult) return;

        extend(mergedHandlerResult, handlerResult);

        const eventData = {handlerName: name, originalEvent: handlerResult.originalEvent || e};

        // track which handler changed which camera property
        if (handlerResult.zoomDelta !== undefined) {
            eventsInProgress.zoom = eventData as MapEvents['zoom'];
        }
        if (handlerResult.panDelta !== undefined) {
            eventsInProgress.drag = eventData as MapEvents['drag'];
        }
        if (handlerResult.pitchDelta !== undefined) {
            eventsInProgress.pitch = eventData as MapEvents['pitch'];
        }
        if (handlerResult.bearingDelta !== undefined) {
            eventsInProgress.rotate = eventData as MapEvents['rotate'];
        }
    }

    _applyChanges() {
        const combined: HandlerResult = {};
        const combinedEventsInProgress: EventsInProgress = {};
        const combinedDeactivatedHandlers: Record<string, Handler> = {};

        for (const [change, eventsInProgress, deactivatedHandlers] of this._changes) {
            if (change.panDelta) combined.panDelta = (combined.panDelta || new Point(0, 0))._add(change.panDelta);
            if (change.zoomDelta) combined.zoomDelta = (combined.zoomDelta || 0) + change.zoomDelta;
            if (change.bearingDelta) combined.bearingDelta = (combined.bearingDelta || 0) + change.bearingDelta;
            if (change.pitchDelta) combined.pitchDelta = (combined.pitchDelta || 0) + change.pitchDelta;
            if (change.around !== undefined) combined.around = change.around;
            if (change.aroundCoord !== undefined) combined.aroundCoord = change.aroundCoord;
            if (change.pinchAround !== undefined) combined.pinchAround = change.pinchAround;
            if (change.noInertia) combined.noInertia = change.noInertia;

            extend(combinedEventsInProgress, eventsInProgress);
            extend(combinedDeactivatedHandlers, deactivatedHandlers);
        }

        this._updateMapTransform(combined, combinedEventsInProgress, combinedDeactivatedHandlers);
        this._changes = [];
    }

    _updateMapTransform(combinedResult: HandlerResult, combinedEventsInProgress: EventsInProgress, deactivatedHandlers: Record<string, Handler>) {
        const map = this._map;
        const tr = map.transform;

        const eventStarted = (type: string) => {
            const newEvent = combinedEventsInProgress[type];
            return newEvent && !this._eventsInProgress[type];
        };

        const eventEnded = (type: string) => {
            const event = this._eventsInProgress[type];
            return event && !this._handlersById[event.handlerName].isActive();
        };

        const toVec3 = (p: MercatorCoordinate): vec3 => [p.x, p.y, p.z];

        if (eventEnded("drag") && !hasChange(combinedResult)) {
            const preZoom = tr.zoom;
            tr.cameraElevationReference = "sea";
            if (this._originalZoom != null && tr._orthographicProjectionAtLowPitch && tr.projection.name !== 'globe' && tr.pitch  === 0) {
                // keep constant zoom from drag gesture start.
                tr.cameraElevationReference = "ground";
                tr.zoom = this._originalZoom;
            } else {
                tr.recenterOnTerrain();
                tr.cameraElevationReference = "ground";
            }
            // Map zoom might change during the pan operation due to terrain elevation.
            if (preZoom !== tr.zoom) this._map._update(true);
        }

        // Catches double click and double tap zooms when camera is constrained over terrain
        if (tr._isCameraConstrained) map._stop(true);

        if (!hasChange(combinedResult)) {
            this._fireEvents(combinedEventsInProgress, deactivatedHandlers, true);
            return;
        }

        let {panDelta, zoomDelta, bearingDelta, pitchDelta, around, aroundCoord, pinchAround} = combinedResult;

        if (tr._isCameraConstrained) {
            // Catches wheel zoom events when camera is constrained over terrain
            if (zoomDelta > 0) zoomDelta = 0;
            tr._isCameraConstrained = false;
        }

        if (pinchAround !== undefined) {
            around = pinchAround;
        }

        if ((zoomDelta || eventStarted("drag")) && around) {
            this._dragOrigin = toVec3(tr.pointCoordinate3D(around));
            this._originalZoom = tr.zoom;
            // Construct the tracking ellipsoid every time user changes the zoom or drag origin.
            // Direction of the ray will define size of the shape and hence defining the available range of movement
            this._trackingEllipsoid.setup(tr._camera.position, this._dragOrigin);
        }

        // All movement of the camera is done relative to the sea level
        tr.cameraElevationReference = "sea";

        // stop any ongoing camera animations (easeTo, flyTo)
        map._stop(true);

        around = around || map.transform.centerPoint;
        if (bearingDelta) tr.bearing += bearingDelta;
        if (pitchDelta) tr.pitch += pitchDelta;
        tr._updateCameraState();

        // Compute Mercator 3D camera offset based on screenspace panDelta
        const panVec = [0, 0, 0];
        if (panDelta) {
            if (tr.projection.name === 'mercator') {
                assert(this._dragOrigin, '_dragOrigin should have been setup with a previous dragstart');
                const startPoint = this._trackingEllipsoid.projectRay(tr.screenPointToMercatorRay(around).dir);
                const endPoint = this._trackingEllipsoid.projectRay(tr.screenPointToMercatorRay(around.sub(panDelta)).dir);
                panVec[0] = endPoint[0] - startPoint[0];
                panVec[1] = endPoint[1] - startPoint[1];

            } else {
                const startPoint = tr.pointCoordinate(around);
                if (tr.projection.name === 'globe') {
                    // Compute pan vector directly in pixel coordinates for the globe.
                    // Rotate the globe a bit faster when dragging near poles to compensate
                    // different pixel-per-meter ratios (ie. pixel-to-physical-rotation is lower)
                    panDelta = panDelta.rotate(-tr.angle);
                    const scale = tr._pixelsPerMercatorPixel / tr.worldSize;
                    panVec[0] = -panDelta.x * mercatorScale(latFromMercatorY(startPoint.y)) * scale;
                    panVec[1] = -panDelta.y * mercatorScale(tr.center.lat) * scale;

                } else {
                    const endPoint = tr.pointCoordinate(around.sub(panDelta));

                    if (startPoint && endPoint) {
                        panVec[0] = endPoint.x - startPoint.x;
                        panVec[1] = endPoint.y - startPoint.y;
                    }
                }
            }
        }

        const originalZoom = tr.zoom;
        // Compute Mercator 3D camera offset based on screenspace requested ZoomDelta
        const zoomVec = [0, 0, 0];
        if (zoomDelta) {
            // Zoom value has to be computed relative to a secondary map plane that is created from the terrain position below the cursor.
            // This way the zoom interpolation can be kept linear and independent of the (possible) terrain elevation
            const pickedPosition: vec3 = aroundCoord ? toVec3(aroundCoord) : toVec3(tr.pointCoordinate3D(around));

            const aroundRay = {dir: vec3.normalize([] as unknown as vec3, vec3.sub([] as unknown as vec3, pickedPosition, tr._camera.position))};
            if (aroundRay.dir[2] < 0) {
                // Special handling is required if the ray created from the cursor is heading up.
                // This scenario is possible if user is trying to zoom towards a feature like a hill or a mountain.
                // Convert zoomDelta to a movement vector as if the camera would be orbiting around the picked point
                const movement = tr.zoomDeltaToMovement(pickedPosition, zoomDelta);
                vec3.scale(zoomVec as [number, number, number], aroundRay.dir, movement);
            }
        }

        // Mutate camera state via CameraAPI
        const translation = vec3.add(panVec as [number, number, number], panVec as [number, number, number], zoomVec as [number, number, number]);
        tr._translateCameraConstrained(translation);

        if (zoomDelta && Math.abs(tr.zoom - originalZoom) > 0.0001) {
            tr.recenterOnTerrain();
        }

        tr.cameraElevationReference = "ground";

        this._map._update();
        if (!combinedResult.noInertia) this._inertia.record(combinedResult);
        this._fireEvents(combinedEventsInProgress, deactivatedHandlers, true);
    }

    _fireEvents(newEventsInProgress: EventsInProgress, deactivatedHandlers: Record<string, Handler>, allowEndAnimation: boolean) {
        const wasMoving = isMoving(this._eventsInProgress);
        const nowMoving = isMoving(newEventsInProgress);

        const startEvents: EventsInProgress = {};

        for (const eventName in newEventsInProgress) {
            const {originalEvent} = newEventsInProgress[eventName];
            if (!this._eventsInProgress[eventName]) {
                startEvents[`${eventName}start`] = originalEvent;
            }
            this._eventsInProgress[eventName] = newEventsInProgress[eventName];
        }

        // fire start events only after this._eventsInProgress has been updated
        if (!wasMoving && nowMoving) {
            this._fireEvent('movestart', nowMoving.originalEvent);
        }

        for (const name in startEvents) {
            this._fireEvent(name as keyof MapEvents, startEvents[name]);
        }

        if (nowMoving) {
            this._fireEvent('move', nowMoving.originalEvent);
        }

        for (const eventName in newEventsInProgress) {
            const {originalEvent} = newEventsInProgress[eventName];
            this._fireEvent(eventName as keyof MapEvents, originalEvent);
        }

        const endEvents: EventsInProgress = {};

        let originalEndEvent;
        for (const eventName in this._eventsInProgress) {
            const {handlerName, originalEvent} = this._eventsInProgress[eventName];
            if (!this._handlersById[handlerName].isActive()) {
                delete this._eventsInProgress[eventName];
                originalEndEvent = deactivatedHandlers[handlerName] || originalEvent;
                endEvents[`${eventName}end`] = originalEndEvent;
            }
        }

        for (const name in endEvents) {
            this._fireEvent(name as keyof MapEvents, endEvents[name]);
        }

        const stillMoving = isMoving(this._eventsInProgress);
        if (allowEndAnimation && (wasMoving || nowMoving) && !stillMoving) {
            this._updatingCamera = true;
            const inertialEase = this._inertia._onMoveEnd(this._map.dragPan._inertiaOptions);

            const shouldSnapToNorth = (bearing: number) => bearing !== 0 && -this._bearingSnap < bearing && bearing < this._bearingSnap;

            if (inertialEase) {
                if (shouldSnapToNorth(inertialEase.bearing || this._map.getBearing())) {
                    inertialEase.bearing = 0;
                }
                this._map.easeTo(inertialEase, {originalEvent: originalEndEvent});
            } else {
                this._map.fire(new Event('moveend', {originalEvent: originalEndEvent}));
                if (shouldSnapToNorth(this._map.getBearing())) {
                    this._map.resetNorth();
                }
            }
            this._updatingCamera = false;
        }

    }

    _fireEvent(type: keyof MapEvents, event?: MouseEvent | TouchEvent) {
        const eventData = (event ? {originalEvent: event} : {});
        this._map.fire(new Event(type, eventData as MapEvents[keyof MapEvents]));
    }

    _requestFrame(): number {
        this._map.triggerRepaint();
        return this._map._renderTaskQueue.add(timeStamp => {
            this._frameId = undefined;
            this.handleEvent(new RenderFrameEvent('renderFrame', {timeStamp}));
            this._applyChanges();
        });
    }

    _triggerRenderFrame() {
        if (this._frameId === undefined) {
            this._frameId = this._requestFrame();
        }
    }
}

export default HandlerManager;
