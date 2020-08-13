/*
 * Copyright (C) 2017-2020 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */
import {
    DecodedTile,
    GeometryKind,
    GeometryKindSet,
    isExtrudedLineTechnique,
    isExtrudedPolygonTechnique,
    isFillTechnique,
    isLineMarkerTechnique,
    isLineTechnique,
    isPoiTechnique,
    isSegmentsTechnique,
    isSolidLineTechnique,
    isTextTechnique,
    Technique
} from "@here/harp-datasource-protocol";
import { PerformanceTimer, TaskQueue } from "@here/harp-utils";

import { TileTaskGroups } from "../MapView";
import { PerformanceStatistics } from "../Statistics";
import { Tile } from "../Tile";
import { TileGeometryCreator } from "./TileGeometryCreator";

/**
 * Loads the geometry for its {@link Tile}. Loads all geometry in a single step.
 */
export class TileGeometryLoader {
    /**
     * Make sure that all technique have their geometryKind set, either from the theme or their
     * default value.
     *
     * Also gather set of the [[GeometryKind]]s found in the techniques and return it.
     *
     * @param {DecodedTile} decodedTile
     * @returns {GeometryKindSet} The set of kinds used in the decodeTile.
     */
    static prepareAvailableGeometryKinds(decodedTile: DecodedTile): GeometryKindSet {
        const foundSet: GeometryKindSet = new GeometryKindSet();

        for (const technique of decodedTile.techniques) {
            const geometryKind = TileGeometryLoader.compileGeometryKind(technique);

            if (geometryKind instanceof Set) {
                for (const kind of geometryKind) {
                    foundSet.add(kind);
                }
            } else {
                foundSet.add(geometryKind);
            }
        }
        return foundSet;
    }

    /**
     * Make sure that the technique has its geometryKind set, either from the theme or their default
     * value.
     *
     * @param {Technique} technique
     */
    static compileGeometryKind(technique: Technique): GeometryKind | GeometryKindSet {
        // tslint:disable-next-line: deprecation
        let geometryKind = technique.kind;

        // Set default kind based on technique.
        if (geometryKind === undefined) {
            if (isFillTechnique(technique)) {
                geometryKind = GeometryKind.Area;
            } else if (
                isLineTechnique(technique) ||
                isSolidLineTechnique(technique) ||
                isSegmentsTechnique(technique) ||
                isExtrudedLineTechnique(technique)
            ) {
                geometryKind = GeometryKind.Line;
            } else if (isExtrudedPolygonTechnique(technique)) {
                geometryKind = GeometryKind.Building;
            } else if (
                isPoiTechnique(technique) ||
                isLineMarkerTechnique(technique) ||
                isTextTechnique(technique)
            ) {
                geometryKind = GeometryKind.Label;
            } else {
                geometryKind = GeometryKind.All;
            }

            // tslint:disable-next-line: deprecation
            technique.kind = geometryKind;
        } else if (Array.isArray(geometryKind)) {
            // tslint:disable-next-line: deprecation
            geometryKind = technique.kind = new GeometryKindSet(geometryKind);
        }

        return geometryKind;
    }

    private m_decodedTile?: DecodedTile;
    private m_isFinished: boolean = false;
    private m_availableGeometryKinds: GeometryKindSet | undefined;
    private m_enabledKinds: GeometryKindSet | undefined;
    private m_disabledKinds: GeometryKindSet | undefined;
    private m_priority: number = 0;

    constructor(private m_tile: Tile, private m_taskQueue: TaskQueue) {}

    set priority(value: number) {
        this.m_priority = value;
    }

    //This is not a getter as it need to be bound to this for the taskqueue
    getPriority(): number {
        return this.m_priority;
    }

    /**
     * The {@link Tile} this `TileGeometryLoader` is managing.
     */
    get tile(): Tile {
        return this.m_tile;
    }

    /**
     * `True` if all geometry of the `Tile` has been loaded and the loading process is finished.
     */
    get isFinished(): boolean {
        return this.m_isFinished;
    }

    /**
     * `True` if geometry of a `Tile` has been loaded but is not fully processed.
     */
    get geometryCreationPending(): boolean {
        // Geometry loading not yet finished and timeout already set, but not yet processing
        // (m_timeout !== undefined), or timeout callback already in progress
        // (m_timeout === undefined), but decoded tile still not reset.
        return !this.isFinished && this.m_decodedTile !== undefined;
    }

    /**
     * `True` if the basic geometry has been loaded, and the `Tile` is ready  for display.
     */
    get basicGeometryLoaded(): boolean {
        return this.m_tile.hasGeometry;
    }

    /**
     * `True` if all geometry of the `Tile` has been loaded.
     */
    get allGeometryLoaded(): boolean {
        return this.m_isFinished;
    }

    /**
     * Set the {@link @here/harp-datasource-protocol#DecodedTile} of the tile.
     *
     * @remarks
     * Is called after the decoded tile has been loaded, and
     * prepares its content for later processing in the 'updateXXX' methods.
     *
     * @param {DecodedTile} decodedTile The decoded tile with the flat geometry data belonging to
     *      this tile.
     * @returns {DecodedTile} The processed decoded tile.
     */
    setDecodedTile(decodedTile: DecodedTile): DecodedTile {
        this.m_decodedTile = decodedTile;

        if (this.m_decodedTile !== undefined) {
            this.m_availableGeometryKinds = TileGeometryLoader.prepareAvailableGeometryKinds(
                this.m_decodedTile
            );
        }
        return this.m_decodedTile;
    }

    /**
     * The kinds of geometry stored in this {@link Tile}.
     */
    get availableGeometryKinds(): GeometryKindSet | undefined {
        return this.m_availableGeometryKinds;
    }

    /**
     * Start with or continue with loading geometry. Called repeatedly until `isFinished` is `true`.
     */
    update(
        enabledKinds: GeometryKindSet | undefined,
        disabledKinds: GeometryKindSet | undefined
    ): void {
        const tile = this.tile;

        // Cheap sanity check, do it first so no longer processing is needed.
        if (this.isFinished) {
            return;
        }

        // Check if tile should be already discarded (invisible, disposed).
        // If the tile is not ready for display, or if it has become invisible while being loaded,
        // for example by moving the camera, the tile is not finished and its geometry is not
        // created. This is an optimization for fast camera movements and zooms.
        if (this.discardNeedlessTile(tile)) {
            return;
        }

        // Finish loading if tile has no data.
        if (tile.tileLoader?.isFinished && tile.decodedTile === undefined) {
            this.finish();
            return;
        }

        // Geometry kinds have changed when loading, if so reset entire loading because
        // this geometry loader generates all geometry at once.
        if (
            this.geometryCreationPending &&
            !this.compareGeometryKinds(enabledKinds, disabledKinds)
        ) {
            this.reset();
        }

        // First time this tile is handled, or reset has been requested.
        // Note: Finished condition already checked above.
        if (!this.geometryCreationPending && tile.decodedTile !== undefined) {
            TileGeometryCreator.instance.processTechniques(tile, enabledKinds, disabledKinds);
            this.setGeometryKinds(enabledKinds, disabledKinds);
            this.setDecodedTile(tile.decodedTile);
            this.prepareForRender(enabledKinds, disabledKinds);
        }
    }

    /**
     * Dispose of any resources.
     */
    dispose(): void {
        this.m_decodedTile = undefined;
        // TODO: Release other resource: availableGeometryKind, enabled/disabled sets, timeout?
    }

    /**
     * Reset the loader to its initial state and cancels any asynchronous work.
     */
    reset(): void {
        this.m_availableGeometryKinds?.clear();
        this.m_enabledKinds?.clear();
        this.m_disabledKinds?.clear();

        this.m_decodedTile = undefined;
        this.m_isFinished = false;
    }

    private finish() {
        this.m_tile.loadingFinished();
        this.m_tile.removeDecodedTile();

        this.m_decodedTile = undefined;
        this.m_isFinished = true;
    }

    /**
     * Called by {@link VisibleTileSet} to mark that {@link Tile} is
     * visible and it should prepare geometry.
     */
    private prepareForRender(
        enabledKinds: GeometryKindSet | undefined,
        disabledKinds: GeometryKindSet | undefined
    ) {
        const decodedTile = this.m_decodedTile;

        // Just a sanity check that satisfies compiler check below.
        if (decodedTile === undefined) {
            this.finish();
            return;
        }

        this.m_taskQueue.add({
            execute: this.prepare.bind(this, enabledKinds, disabledKinds),
            group: TileTaskGroups.CREATE,
            getPriority: this.getPriority.bind(this),
            isExpired: () => {
                return !this.tile.isVisible || this.tile.dataSource.isDetached();
            },
            estimatedProcessTime: () => {
                //TODO: this seems to be close in many cases, but take some measures to confirm
                return (this.tile.decodedTile?.decodeTime || 30) / 6;
            }
        });
    }

    private prepare(
        enabledKinds: GeometryKindSet | undefined,
        disabledKinds: GeometryKindSet | undefined
    ) {
        // Reset timeout so it is untouched during processing.
        //this.m_timeout = undefined;
        const tile = this.tile;
        const decodedTile = this.m_decodedTile;

        // Just a sanity check that satisfies compiler check below.
        if (decodedTile === undefined) {
            this.finish();
            return;
        }

        if (this.discardNeedlessTile(tile)) {
            return;
        }

        const stats = PerformanceStatistics.instance;
        let now = 0;
        if (stats.enabled) {
            now = PerformanceTimer.now();
        }

        const geometryCreator = TileGeometryCreator.instance;

        tile.clear();
        // Set up techniques which should be processed.
        geometryCreator.initDecodedTile(decodedTile, enabledKinds, disabledKinds);
        geometryCreator.createAllGeometries(tile, decodedTile);

        if (stats.enabled) {
            const geometryCreationTime = PerformanceTimer.now() - now;
            const currentFrame = stats.currentFrame;

            // Account for the geometry creation in the current frame.
            currentFrame.addValue("render.fullFrameTime", geometryCreationTime);
            currentFrame.addValue("render.geometryCreationTime", geometryCreationTime);

            currentFrame.addValue("geometry.geometryCreationTime", geometryCreationTime);
            currentFrame.addValue("geometryCount.numGeometries", decodedTile.geometries.length);
            currentFrame.addValue("geometryCount.numTechniques", decodedTile.techniques.length);
            currentFrame.addValue(
                "geometryCount.numPoiGeometries",
                decodedTile.poiGeometries !== undefined ? decodedTile.poiGeometries.length : 0
            );
            currentFrame.addValue(
                "geometryCount.numTextGeometries",
                decodedTile.textGeometries !== undefined ? decodedTile.textGeometries.length : 0
            );
            currentFrame.addValue(
                "geometryCount.numTextPathGeometries",
                decodedTile.textPathGeometries !== undefined
                    ? decodedTile.textPathGeometries.length
                    : 0
            );
            currentFrame.addValue(
                "geometryCount.numPathGeometries",
                decodedTile.pathGeometries !== undefined ? decodedTile.pathGeometries.length : 0
            );
            currentFrame.addMessage(
                // tslint:disable-next-line: max-line-length
                `Decoded tile: ${tile.dataSource.name} # lvl=${tile.tileKey.level} col=${tile.tileKey.column} row=${tile.tileKey.row}`
            );
        }
        this.finish();
        tile.dataSource.requestUpdate();
    }

    private discardNeedlessTile(tile: Tile): boolean {
        // If the tile has become invisible while being loaded, for example by moving the
        // camera, the tile is not finished and its geometry is not created. This is an
        // optimization for fast camera movements and zooms.
        if (!tile.isVisible) {
            // Dispose the tile from the visible set, so it can be reloaded properly next time
            // it is needed.
            tile.mapView.visibleTileSet.disposeTile(tile);

            const stats = PerformanceStatistics.instance;
            if (stats.enabled) {
                stats.currentFrame.addMessage(
                    // tslint:disable-next-line: max-line-length
                    `Decoded tile: ${tile.dataSource.name} # lvl=${tile.tileKey.level} col=${tile.tileKey.column} row=${tile.tileKey.row} DISCARDED - invisible`
                );
            }
            this.finish();
            return true;
        }
        // Tile already disposed (this may potentially happen in timeout callback).
        else if (tile.disposed) {
            const stats = PerformanceStatistics.instance;
            if (stats.enabled) {
                stats.currentFrame.addMessage(
                    // tslint:disable-next-line: max-line-length
                    `Decoded tile: ${tile.dataSource.name} # lvl=${tile.tileKey.level} col=${tile.tileKey.column} row=${tile.tileKey.row} DISCARDED - disposed`
                );
            }
            this.finish();
            return true;
        }
        return false;
    }

    /**
     * Stores geometry kinds used to load decoded tile geometry.
     *
     * This values are stored to detect geometry kind changes during loading.
     *
     * @param enabledKinds - Set of geometry kinds to be displayed or undefined.
     * @param disabledKinds - Set of geometry kinds that won't be rendered.
     */
    private setGeometryKinds(
        enabledKinds: GeometryKindSet | undefined,
        disabledKinds: GeometryKindSet | undefined
    ): void {
        if (enabledKinds !== undefined) {
            this.m_enabledKinds = Object.assign(
                this.m_enabledKinds ?? new GeometryKindSet(),
                enabledKinds
            );
        }
        if (disabledKinds !== undefined) {
            this.m_disabledKinds = Object.assign(
                this.m_disabledKinds ?? new GeometryKindSet(),
                disabledKinds
            );
        }
    }

    /**
     * Compare enabled and disabled geometry kinds with currently set.
     *
     * Method compares input sets with recently used geometry kinds in performance wise
     * manner, taking special care of undefined and zero size sets.
     *
     * @param enabledKinds - Set of geometry kinds to be displayed or undefined.
     * @param disabledKinds - Set of geometry kinds that won't be rendered.
     * @return `true` only if sets are logically equal, meaning that undefined and empty sets
     * may result in same geometry (techniques kind) beeing rendered.
     */
    private compareGeometryKinds(
        enabledKinds: GeometryKindSet | undefined,
        disabledKinds: GeometryKindSet | undefined
    ): boolean {
        const enabledSame = this.m_enabledKinds === enabledKinds;
        const disabledSame = this.m_disabledKinds === disabledKinds;
        // Same references, no need to compare.
        if (enabledSame && disabledSame) {
            return true;
        }
        const enabledEmpty =
            (this.m_enabledKinds === undefined || this.m_enabledKinds.size === 0) &&
            (enabledKinds === undefined || enabledKinds.size === 0);
        const disabledEmpty =
            (this.m_disabledKinds === undefined || this.m_disabledKinds.size === 0) &&
            (disabledKinds === undefined || disabledKinds.size === 0);

        // We deal only with empty, the same or undefined sets - fast return, no need to compare.
        if (
            (enabledEmpty && disabledEmpty) ||
            (enabledSame && disabledEmpty) ||
            (disabledSame && enabledEmpty)
        ) {
            return true;
        }
        // It is enough that one the the sets are different, try to spot difference otherwise
        // return true. Compare only non-empty sets.
        if (!enabledEmpty) {
            // If one set undefined then other must be non-empty, for sure different.
            if (enabledKinds === undefined || this.m_enabledKinds === undefined) {
                return false;
            }
            // Both defined and non-empty, compare the sets.
            else if (!enabledKinds.has(this.m_enabledKinds)) {
                return false;
            }
        }
        if (!disabledEmpty) {
            // One set defined and non-empty other undefined, for sure different.
            if (disabledKinds === undefined || this.m_disabledKinds === undefined) {
                return false;
            }
            // Both defined and non-empty, compare the sets.
            else if (!disabledKinds.has(this.m_disabledKinds)) {
                return false;
            }
        }
        // No difference found.
        return true;
    }
}
