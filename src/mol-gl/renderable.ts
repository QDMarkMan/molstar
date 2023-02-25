/**
 * Copyright (c) 2018-2022 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { Program } from './webgl/program';
import { RenderableValues, Values, RenderableSchema, BaseValues } from './renderable/schema';
import { GraphicsRenderItem, ComputeRenderItem, GraphicsRenderVariant, MultiDrawBaseData } from './webgl/render-item';
import { ValueCell } from '../mol-util';
import { idFactory } from '../mol-util/id-factory';
import { clamp } from '../mol-math/interpolate';
import { Frustum3D } from '../mol-math/geometry/primitives/frustum3d';
import { Plane3D } from '../mol-math/geometry/primitives/plane3d';
import { Sphere3D } from '../mol-math/geometry';
import { Vec4 } from '../mol-math/linear-algebra/3d/vec4';

// avoiding namespace lookup improved performance in Chrome (Aug 2020)
const p3distanceToPoint = Plane3D.distanceToPoint;
const f3intersectsSphere3D = Frustum3D.intersectsSphere3D;
const s3fromArray = Sphere3D.fromArray;

const getNextRenderableId = idFactory();

export type RenderableState = {
    disposed: boolean
    visible: boolean
    alphaFactor: number
    pickable: boolean
    colorOnly: boolean
    opaque: boolean
    writeDepth: boolean
}

export interface Renderable<T extends RenderableValues> {
    readonly id: number
    readonly materialId: number
    readonly values: T
    readonly state: RenderableState

    cull: (cameraPlane: Plane3D, frustum: Frustum3D) => void
    uncull: () => void
    render: (variant: GraphicsRenderVariant, sharedTexturesCount: number) => void
    getProgram: (variant: GraphicsRenderVariant) => Program
    update: () => void
    dispose: () => void
}

function getMdbData(cellCount: number, mdbData?: MultiDrawBaseData): MultiDrawBaseData {
    if (mdbData && mdbData.instanceCounts.length >= cellCount) {
        return mdbData;
    } else {
        return {
            firsts: new Int32Array(cellCount),
            counts: new Int32Array(cellCount),
            offsets: new Int32Array(cellCount),
            instanceCounts: new Int32Array(cellCount),
            baseVertices: new Int32Array(cellCount),
            baseInstances: new Uint32Array(cellCount),
            count: 0,
            uniforms: [],
        };
    }
}

type GraphicsRenderableValues = RenderableValues & BaseValues

export function createRenderable<T extends GraphicsRenderableValues>(renderItem: GraphicsRenderItem, values: T, state: RenderableState): Renderable<T> {
    const id = getNextRenderableId();

    let mdbData = getMdbData(0);
    const mdbDataList: MultiDrawBaseData[] = [];
    let cullEnabled = false;
    let lodLevelsVersion = -1;

    const s = Sphere3D();

    return {
        id,
        materialId: renderItem.materialId,
        values,
        state,

        cull: (cameraPlane: Plane3D, frustum: Frustum3D) => {
            cullEnabled = false;

            if (values.drawCount.ref.value === 0) return;
            if (values.instanceCount.ref.value === 0) return;
            if (!values.instanceGrid.ref.value) return;

            const { cellOffsets, cellSpheres, cellCount } = values.instanceGrid.ref.value;
            const [minDistance, maxDistance] = values.uLod.ref.value;
            const hasLod = minDistance !== 0 || maxDistance !== 0;

            const lodLevels: [minDistance: number, maxDistance: number, overlap: number, count: number, sizeFactor: number][] | undefined = values.lodLevels?.ref.value;

            if (lodLevels && lodLevels.length > 0) {
                mdbDataList.length = lodLevels.length;
                for (let i = 0, il = lodLevels.length; i < il; ++i) {
                    mdbDataList[i] = getMdbData(cellCount, mdbDataList[i]);
                    mdbDataList[i].count = 0;
                }
                if (values.lodLevels.ref.version !== lodLevelsVersion) {
                    for (let i = 0, il = lodLevels.length; i < il; ++i) {
                        if (mdbDataList[i].uniforms.length !== 1) {
                            mdbDataList[i].uniforms.length = 1;
                            mdbDataList[i].uniforms[0] = ['uLod', ValueCell.create(Vec4())];
                        }
                        ValueCell.update(mdbDataList[i].uniforms[0][1], Vec4.set(mdbDataList[i].uniforms[0][1].ref.value as Vec4, lodLevels[i][0], lodLevels[i][1], lodLevels[i][2], lodLevels[i][4]));
                    }
                    lodLevelsVersion = values.lodLevels.ref.version;
                }

                for (let i = 0; i < cellCount; ++i) {
                    s3fromArray(s, cellSpheres, i * 4);
                    const d = p3distanceToPoint(cameraPlane, s.center);
                    if (hasLod) {
                        if (d + s.radius < minDistance) continue;
                        if (d - s.radius > maxDistance) continue;
                    }
                    if (!f3intersectsSphere3D(frustum, s)) continue;

                    const begin = cellOffsets[i];
                    const end = cellOffsets[i + 1];
                    const count = end - begin;
                    if (count === 0) continue;

                    for (let j = 0, jl = lodLevels.length; j < jl; ++j) {
                        if (d + s.radius < lodLevels[j][0]) continue;
                        if (d - s.radius > lodLevels[j][1]) continue;

                        const l = mdbDataList[j];
                        const o = l.count;

                        if (o > 0 && l.baseInstances[o - 1] + l.instanceCounts[o - 1] === begin && l.counts[o - 1] === lodLevels[j][3]) {
                            l.instanceCounts[o - 1] += count;
                        } else {
                            l.counts[o] = lodLevels[j][3];
                            l.instanceCounts[o] = count;
                            l.baseInstances[o] = begin;
                            l.count += 1;
                        }
                    }
                }
                // console.log(mdbDataList)
            } else {
                mdbData = getMdbData(cellCount, mdbData);
                const { baseInstances, instanceCounts, counts } = mdbData;
                let o = 0;

                for (let i = 0; i < cellCount; ++i) {
                    s3fromArray(s, cellSpheres, i * 4);
                    if (hasLod) {
                        const d = p3distanceToPoint(cameraPlane, s.center);
                        if (d + s.radius < minDistance) continue;
                        if (d - s.radius > maxDistance) continue;
                    }
                    if (!f3intersectsSphere3D(frustum, s)) continue;

                    const begin = cellOffsets[i];
                    const end = cellOffsets[i + 1];
                    const count = end - begin;
                    if (count === 0) continue;

                    if (o > 0 && baseInstances[o - 1] + instanceCounts[o - 1] === begin) {
                        instanceCounts[o - 1] += count;
                    } else {
                        counts[o] = values.drawCount.ref.value;
                        instanceCounts[o] = count;
                        baseInstances[o] = begin;
                        o += 1;
                    }
                }
                mdbData.count = o;
                mdbDataList.length = 1;
                mdbDataList[0] = mdbData;
                mdbDataList[0].uniforms.length = 0;
            }

            // console.log({
            //     counts: counts.slice(),
            //     instanceCounts: instanceCounts.slice(),
            //     baseInstances: baseInstances.slice(),
            //     drawcount: mdbData.count,
            // });

            cullEnabled = true;
        },
        uncull: () => {
            cullEnabled = false;
        },
        render: (variant: GraphicsRenderVariant, sharedTexturesCount: number) => {
            if (values.uAlpha && values.alpha) {
                ValueCell.updateIfChanged(values.uAlpha, clamp(values.alpha.ref.value * state.alphaFactor, 0, 1));
            }
            renderItem.render(variant, sharedTexturesCount, cullEnabled ? mdbDataList : undefined);
        },
        getProgram: (variant: GraphicsRenderVariant) => renderItem.getProgram(variant),
        update: () => renderItem.update(),
        dispose: () => renderItem.destroy()
    };
}

export type GraphicsRenderable = Renderable<GraphicsRenderableValues>

//

export interface ComputeRenderable<T extends RenderableValues> {
    readonly id: number
    readonly values: T

    render: () => void
    update: () => void
    dispose: () => void
}

export function createComputeRenderable<T extends Values<RenderableSchema>>(renderItem: ComputeRenderItem, values: T): ComputeRenderable<T> {
    return {
        id: getNextRenderableId(),
        values,

        render: () => renderItem.render('compute', 0),
        update: () => renderItem.update(),
        dispose: () => renderItem.destroy()
    };
}