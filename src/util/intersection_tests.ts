import {isCounterClockwise} from './util';
import Point from '@mapbox/point-geometry';

export {polygonIntersectsBufferedPoint, polygonIntersectsMultiPolygon, polygonIntersectsBufferedMultiLine, polygonIntersectsPolygon, distToSegmentSquared, polygonIntersectsBox, polygonContainsPoint, triangleIntersectsTriangle, segmentSegmentIntersection};

type Line = ReadonlyArray<Point>;
type MultiLine = ReadonlyArray<Line>;
type Ring = ReadonlyArray<Point>;
type Polygon = ReadonlyArray<Point>;
type MultiPolygon = ReadonlyArray<Polygon>;

function polygonIntersectsPolygon(polygonA: Polygon, polygonB: Polygon): boolean {
    for (let i = 0; i < polygonA.length; i++) {
        if (polygonContainsPoint(polygonB, polygonA[i])) return true;
    }

    for (let i = 0; i < polygonB.length; i++) {
        if (polygonContainsPoint(polygonA, polygonB[i])) return true;
    }

    if (lineIntersectsLine(polygonA, polygonB)) return true;

    return false;
}

function polygonIntersectsBufferedPoint(polygon: Polygon, point: Point, radius: number): boolean {
    if (polygonContainsPoint(polygon, point)) return true;
    if (pointIntersectsBufferedLine(point, polygon, radius)) return true;
    return false;
}

function polygonIntersectsMultiPolygon(polygon: Polygon, multiPolygon: MultiPolygon): boolean {

    if (polygon.length === 1) {
        return multiPolygonContainsPoint(multiPolygon, polygon[0]);
    }

    for (let m = 0; m < multiPolygon.length; m++) {
        const ring = multiPolygon[m];
        for (let n = 0; n < ring.length; n++) {
            if (polygonContainsPoint(polygon, ring[n])) return true;
        }
    }

    for (let i = 0; i < polygon.length; i++) {
        if (multiPolygonContainsPoint(multiPolygon, polygon[i])) return true;
    }

    for (let k = 0; k < multiPolygon.length; k++) {
        if (lineIntersectsLine(polygon, multiPolygon[k])) return true;
    }

    return false;
}

function polygonIntersectsBufferedMultiLine(polygon: Polygon, multiLine: MultiLine, radius: number): boolean {
    for (let i = 0; i < multiLine.length; i++) {
        const line = multiLine[i];

        if (polygon.length >= 3) {
            for (let k = 0; k < line.length; k++) {
                if (polygonContainsPoint(polygon, line[k])) return true;
            }
        }

        if (lineIntersectsBufferedLine(polygon, line, radius)) return true;
    }
    return false;
}

function lineIntersectsBufferedLine(lineA: Line, lineB: Line, radius: number) {

    if (lineA.length > 1) {
        if (lineIntersectsLine(lineA, lineB)) return true;

        // Check whether any point in either line is within radius of the other line
        for (let j = 0; j < lineB.length; j++) {
            if (pointIntersectsBufferedLine(lineB[j], lineA, radius)) return true;
        }
    }

    for (let k = 0; k < lineA.length; k++) {
        if (pointIntersectsBufferedLine(lineA[k], lineB, radius)) return true;
    }

    return false;
}

function lineIntersectsLine(lineA: Line, lineB: Line) {
    if (lineA.length === 0 || lineB.length === 0) return false;
    for (let i = 0; i < lineA.length - 1; i++) {
        const a0 = lineA[i];
        const a1 = lineA[i + 1];
        for (let j = 0; j < lineB.length - 1; j++) {
            const b0 = lineB[j];
            const b1 = lineB[j + 1];
            if (lineSegmentIntersectsLineSegment(a0, a1, b0, b1)) return true;
        }
    }
    return false;
}

function lineSegmentIntersectsLineSegment(a0: Point, a1: Point, b0: Point, b1: Point) {
    return isCounterClockwise(a0, b0, b1) !== isCounterClockwise(a1, b0, b1) &&
        isCounterClockwise(a0, a1, b0) !== isCounterClockwise(a0, a1, b1);
}

function signedAreaTriangle(a: Point, b: Point, c: Point): number {
    return (a.x - c.x) * (b.y - c.y) - (a.y - c.y) * (b.x - c.x);
}

// Performs intersection between two line segments and returns the intersection point (t, s) along both segments if any
function segmentSegmentIntersection(a0: Point, a1: Point, b0: Point, b1: Point): [number, number] | undefined {
    const area0 = signedAreaTriangle(a0, a1, b1);
    const area1 = signedAreaTriangle(a0, a1, b0);

    if (Math.sign(area0) === Math.sign(area1)) {
        return undefined;
    }

    const area2 = signedAreaTriangle(b0, b1, a0);
    const area3 = area2 + area1 - area0;

    if (Math.sign(area2) === Math.sign(area3)) {
        return undefined;
    }

    return [area2 / (area2 - area3), area1 / (area1 - area0)];
}

function pointIntersectsBufferedLine(p: Point, line: Line, radius: number) {
    const radiusSquared = radius * radius;

    if (line.length === 1) return p.distSqr(line[0]) < radiusSquared;

    for (let i = 1; i < line.length; i++) {
        // Find line segments that have a distance <= radius^2 to p
        // In that case, we treat the line as "containing point p".
        const v = line[i - 1], w = line[i];
        if (distToSegmentSquared(p, v, w) < radiusSquared) return true;
    }
    return false;
}

// Code from http://stackoverflow.com/a/1501725/331379.
function distToSegmentSquared(p: Point, v: Point, w: Point): number {
    const l2 = v.distSqr(w);
    if (l2 === 0) return p.distSqr(v);
    const t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    if (t < 0) return p.distSqr(v);
    if (t > 1) return p.distSqr(w);
    return p.distSqr(w.sub(v)._mult(t)._add(v));
}

// point in polygon ray casting algorithm
function multiPolygonContainsPoint(rings: MultiPolygon, p: Point) {
    let c = false,
        ring, p1, p2;

    for (let k = 0; k < rings.length; k++) {
        ring = rings[k];
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            p1 = ring[i];
            p2 = ring[j];
            if (((p1.y > p.y) !== (p2.y > p.y)) && (p.x < (p2.x - p1.x) * (p.y - p1.y) / (p2.y - p1.y) + p1.x)) {
                c = !c;
            }
        }
    }
    return c;
}

function polygonContainsPoint(ring: Ring, p: Point): boolean {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const p1 = ring[i];
        const p2 = ring[j];
        if (((p1.y > p.y) !== (p2.y > p.y)) && (p.x < (p2.x - p1.x) * (p.y - p1.y) / (p2.y - p1.y) + p1.x)) {
            c = !c;
        }
    }
    return c;
}

function polygonIntersectsBox(ring: Ring, boxX1: number, boxY1: number, boxX2: number, boxY2: number): boolean {
    for (const p of ring) {
        if (boxX1 <= p.x &&
            boxY1 <= p.y &&
            boxX2 >= p.x &&
            boxY2 >= p.y) return true;
    }

    const corners = [
        new Point(boxX1, boxY1),
        new Point(boxX1, boxY2),
        new Point(boxX2, boxY2),
        new Point(boxX2, boxY1)];

    if (ring.length > 2) {
        for (const corner of corners) {
            if (polygonContainsPoint(ring, corner)) return true;
        }
    }

    for (let i = 0; i < ring.length - 1; i++) {
        const p1 = ring[i];
        const p2 = ring[i + 1];
        if (edgeIntersectsBox(p1, p2, corners)) return true;
    }

    return false;
}

export function edgeIntersectsBox(e1: Point, e2: Point, corners: Array<Point>) {
    const tl = corners[0];
    const br = corners[2];
    // the edge and box do not intersect in either the x or y dimensions
    if (((e1.x < tl.x) && (e2.x < tl.x)) ||
        ((e1.x > br.x) && (e2.x > br.x)) ||
        ((e1.y < tl.y) && (e2.y < tl.y)) ||
        ((e1.y > br.y) && (e2.y > br.y))) return false;

    // check if all corners of the box are on the same side of the edge
    const dir = isCounterClockwise(e1, e2, corners[0]);
    return dir !== isCounterClockwise(e1, e2, corners[1]) ||
        dir !== isCounterClockwise(e1, e2, corners[2]) ||
        dir !== isCounterClockwise(e1, e2, corners[3]);
}

// Checks whether the triangle [p0, p1, p2] is on the left side of the edge [a, b].
function triangleLeftSideOfEdge(
    a: Point,
    b: Point,
    p0: Point,
    p1: Point,
    p2: Point,
    padding?: number | null,
): boolean {
    let nx = b.y - a.y;
    let ny = a.x - b.x;

    padding = padding || 0;

    if (padding) {
        const nLenSq = nx * nx + ny * ny;
        if (nLenSq === 0) {
            return true;
        }

        const len = Math.sqrt(nLenSq);
        nx /= len;
        ny /= len;
    }

    if ((p0.x - a.x) * nx + (p0.y - a.y) * ny - padding < 0) {
        return false;
    } else if ((p1.x - a.x) * nx + (p1.y - a.y) * ny - padding < 0) {
        return false;
    } else if ((p2.x - a.x) * nx + (p2.y - a.y) * ny - padding < 0) {
        return false;
    }

    return true;
}

function triangleIntersectsTriangle(
    a0: Point,
    b0: Point,
    c0: Point,
    a1: Point,
    b1: Point,
    c1: Point,
    padding?: number | null,
): boolean {
    // Triangles are not intersecting if even one separating axis can be found
    if (triangleLeftSideOfEdge(a0, b0, a1, b1, c1, padding)) {
        return false;
    } else if (triangleLeftSideOfEdge(b0, c0, a1, b1, c1, padding)) {
        return false;
    } else if (triangleLeftSideOfEdge(c0, a0, a1, b1, c1, padding)) {
        return false;
    } else if (triangleLeftSideOfEdge(a1, b1, a0, b0, c0, padding)) {
        return false;
    } else if (triangleLeftSideOfEdge(b1, c1, a0, b0, c0, padding)) {
        return false;
    } else if (triangleLeftSideOfEdge(c1, a1, a0, b0, c0, padding)) {
        return false;
    }
    return true;
}
