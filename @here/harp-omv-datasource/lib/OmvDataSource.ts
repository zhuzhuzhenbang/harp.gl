/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    AttributeMap,
    Definitions,
    Expr,
    GeometryType,
    isJsonExpr,
    ITileDecoder,
    JsonArray,
    OptionsMap,
    StyleSet,
    WorkerServiceProtocol
} from "@here/harp-datasource-protocol";
import { EarthConstants, TileKey, webMercatorTilingScheme } from "@here/harp-geoutils";
import { LineGroup } from "@here/harp-lines";
import { CopyrightInfo, CopyrightProvider, DataSourceOptions } from "@here/harp-mapview";
import { DataProvider, TileDataSource, TileFactory } from "@here/harp-mapview-decoder";
import { getOptionValue, LoggerManager } from "@here/harp-utils";
import {
    FeatureModifierId,
    OMV_TILE_DECODER_SERVICE_TYPE,
    OmvDecoderOptions,
    OmvFeatureFilterDescription
} from "./OmvDecoderDefs";
import { OmvRestClient, OmvRestClientParameters } from "./OmvRestClient";
import { OmvTile } from "./OmvTile";

const logger = LoggerManager.instance.create("OmvDataSource");

export interface LinesGeometry {
    type: GeometryType;
    lines: LineGroup;
    technique: number;

    /**
     * Optional array of objects. It can be used to pass user data from the geometry to the mesh.
     */
    objInfos?: AttributeMap[];

    /**
     * Optional list of feature start indices. The indices point into the index attribute.
     */
    featureStarts?: number[];
}

export interface OmvTileFactory {
    /** Create an instance of [[OmvTile]] or a subclass. */
    createTile(dataSource: OmvDataSource, tileKey: TileKey): OmvTile;
}

export interface OmvDataSourceParameters extends DataSourceOptions {
    /**
     * If set to `true`, features that have no technique in the theme will be printed to the console
     * (can be excessive!).
     */
    showMissingTechniques?: boolean;

    /**
     * If set to `true`, an [[ExtendedTileInfo]] is created for every tile in addition to the
     * [[DecodedTile]]. This is useful if the features should be passed on for processing without
     * geometry being automatically created from them. One application is picking.
     */
    createTileInfo?: boolean;

    /**
     * Specify the decoder that should be used. If not supplied, the default will be used.
     */
    decoder?: ITileDecoder;

    /**
     * Optionally specify the DataProvider that should be used.
     */
    dataProvider?: DataProvider;

    /**
     * Specify the URL to the decoder bundle. If not supplied, the default will be used.
     */
    concurrentDecoderScriptUrl?: string;

    /**
     * Gather feature IDs from `OmvData`. Defaults to `false`.
     * @deprecated, FeatureIds are always gathered, use [[gatherFeatureAttributes]] to gather
     * all feature attributes.
     */
    gatherFeatureIds?: boolean;

    /**
     * Gather feature attributes from `OmvData`. Defaults to `false`.
     */
    gatherFeatureAttributes?: boolean;

    /**
     * Gather road segments data from [[OmvData]]. Defaults to `false`.
     */
    gatherRoadSegments?: boolean;

    /**
     * If not set to `false`, very short text labels will be skipped during decoding based on a
     * heuristic.
     */
    skipShortLabels?: boolean;

    /**
     * A description for the feature filter that can be safely passed down to the web workers. It
     * has to be generated with the help of the [[OmvFeatureFilterDescriptionBuilder]] (to guarantee
     * correctness). This parameter gets applied to the decoder used in the [[OmvDataSource]]
     * which might be shared between various [[OmvDataSource]]s.
     */
    filterDescr?: OmvFeatureFilterDescription;

    /**
     * Optional, custom factory for [[Tile]] instances created by this [[OmvDataSource]].
     */
    tileFactory?: TileFactory<OmvTile>;

    /**
     * Identifier used to choose OmvFeatureModifier, if undefined [[OmvGenericFeatureModifier]] is
     * used. This parameter gets applied to the decoder used in the [[OmvDataSource]] which might
     * be shared between various [[OmvDataSource]]s.
     */
    featureModifierId?: FeatureModifierId;

    /**
     * Optional, default copyright information of tiles provided by this data source.
     * Implementation should provide this information from the source data if possible.
     */
    copyrightInfo?: CopyrightInfo[];

    /**
     * Optional copyright info provider for tiles provided by this data source.
     */
    copyrightProvider?: CopyrightProvider;

    /**
     * Maximum geometry height above groud level this `OmvDataSource` can produce.
     *
     * Used in first stage of frustum culling before [[Tile.maxGeometryHeight]] data is available.
     *
     * @default [[EarthConstants.MAX_BUILDING_HEIGHT]].
     */
    maxGeometryHeight?: number;

    /**
     * Indicates whether overlay on elevation is enabled. Defaults to `false`.
     */
    enableElevationOverlay?: boolean;

    /**
     * Indicates whether to add a ground plane to cover the tile completely. This is necessary for
     * the fallback logic, such that the parent fall back tiles don't overlap the children tiles.
     * Default is true (i.e. if not defined it is taken to be true)
     */
    addGroundPlane?: boolean;
}

/**
 * A helper function to retrieve the [[DataProvider]] from the [[OmvDataSource]]s parameters.
 *
 * @param params The parameters passed into the OmvDataSource.
 */
function getDataProvider(params: OmvWithRestClientParams | OmvWithCustomDataProvider) {
    if ((params as OmvWithCustomDataProvider).dataProvider) {
        return (params as OmvWithCustomDataProvider).dataProvider;
    } else if (
        (params as OmvWithRestClientParams).baseUrl ||
        (params as OmvWithRestClientParams).url
    ) {
        return new OmvRestClient(params as OmvRestClientParameters);
    } else {
        throw new Error("OmvDataSource: missing url, baseUrl or dataProvider params");
    }
}

export type OmvWithRestClientParams = OmvRestClientParameters & OmvDataSourceParameters;
export type OmvWithCustomDataProvider = OmvDataSourceParameters & { dataProvider: DataProvider };

let missingOmvDecoderServiceInfoEmitted: boolean = false;

export class OmvDataSource extends TileDataSource<OmvTile> {
    private readonly m_decoderOptions: OmvDecoderOptions;

    constructor(private m_params: OmvWithRestClientParams | OmvWithCustomDataProvider) {
        super(m_params.tileFactory || new TileFactory(OmvTile), {
            styleSetName: m_params.styleSetName || "omv",
            name: m_params.name,
            tilingScheme: webMercatorTilingScheme,
            dataProvider: getDataProvider(m_params),
            concurrentDecoderServiceName: OMV_TILE_DECODER_SERVICE_TYPE,
            decoder: m_params.decoder,
            concurrentDecoderScriptUrl: m_params.concurrentDecoderScriptUrl,
            copyrightInfo: m_params.copyrightInfo,
            copyrightProvider: m_params.copyrightProvider,
            // tslint:disable-next-line: deprecation
            minZoomLevel: m_params.minZoomLevel,
            // tslint:disable-next-line: deprecation
            maxZoomLevel: m_params.maxZoomLevel,
            minDataLevel: getOptionValue(m_params.minDataLevel, 1),
            maxDataLevel: getOptionValue(m_params.maxDataLevel, 17),
            minDisplayLevel: m_params.minDisplayLevel,
            maxDisplayLevel: m_params.maxDisplayLevel,
            storageLevelOffset: getOptionValue(m_params.storageLevelOffset, -1)
        });

        this.cacheable = true;
        this.addGroundPlane =
            m_params.addGroundPlane === undefined || m_params.addGroundPlane === true;

        this.m_decoderOptions = {
            showMissingTechniques: this.m_params.showMissingTechniques === true,
            filterDescription: this.m_params.filterDescr,
            gatherFeatureAttributes: this.m_params.gatherFeatureAttributes === true,
            createTileInfo: this.m_params.createTileInfo === true,
            gatherRoadSegments: this.m_params.gatherRoadSegments === true,
            featureModifierId: this.m_params.featureModifierId,
            skipShortLabels: this.m_params.skipShortLabels,
            storageLevelOffset: getOptionValue(m_params.storageLevelOffset, -1),
            enableElevationOverlay: this.m_params.enableElevationOverlay === true
        };

        this.maxGeometryHeight = getOptionValue(
            m_params.maxGeometryHeight,
            EarthConstants.MAX_BUILDING_HEIGHT
        );
    }

    /** @override */
    async connect() {
        try {
            await super.connect();
        } catch (error) {
            if (
                WorkerServiceProtocol.isUnknownServiceError(error) &&
                !missingOmvDecoderServiceInfoEmitted
            ) {
                logger.info(
                    "Unable to create decoder service in worker. Use " +
                        " 'OmvTileDecoderService.start();' in decoder script."
                );
                missingOmvDecoderServiceInfoEmitted = true;
            }
            throw error;
        }
        this.configureDecoder(undefined, undefined, undefined, this.m_decoderOptions);
    }

    /**
     * Remove the current data filter.
     * Will be applied to the decoder, which might be shared with other omv datasources.
     */
    removeDataFilter(): void {
        this.configureDecoder(undefined, undefined, undefined, {
            filterDescription: null,
            dataFilter: null
        });
    }

    /**
     * Set a new data filter. Can also be done during the creation of an [[OmvDataSource]].
     * Will be applied to the decoder, which might be shared with other omv datasources.
     *
     * @param filterDescription Data filter description created with
     * [[OmvFeatureFilterDescriptionBuilder]].
     *
     * @deprecated
     */
    setDataFilter(filterDescription: OmvFeatureFilterDescription): void;

    /**
     * Sets the expression used to filter features.
     *
     * For example, the following expression can be used to filter
     * features in the 'buildings' and 'water' layers.
     * ```typescript
     *   omvDataSource.setDataFilter([
     *       "match", ["get", "$layer"],
     *          ["buildings", "water"], true,
     *          false
     *   ]);
     * ```
     *
     * @param dataFilter The expression used to filter data features.
     */
    // tslint:disable-next-line: unified-signatures
    setDataFilter(dataFilter: JsonArray | Expr): void;

    setDataFilter(filterDescription: OmvFeatureFilterDescription | JsonArray | Expr): void {
        if (isJsonExpr(filterDescription) || Expr.isExpr(filterDescription)) {
            this.m_decoderOptions.dataFilter = Expr.isExpr(filterDescription)
                ? (filterDescription.toJSON() as JsonArray)
                : filterDescription;

            this.configureDecoder(undefined, undefined, undefined, {
                dataFilter: filterDescription
            });
        } else {
            this.m_decoderOptions.filterDescription =
                filterDescription !== null ? filterDescription : undefined;

            this.configureDecoder(undefined, undefined, undefined, {
                filterDescription
            });
        }
    }

    /** @override */
    shouldPreloadTiles(): boolean {
        return true;
    }

    /** @override */
    setLanguages(languages?: string[]): void {
        if (languages !== undefined) {
            this.configureDecoder(undefined, undefined, languages, undefined);
        }
    }

    /** @override */
    get storageLevelOffset() {
        return super.storageLevelOffset;
    }

    /** @override */
    set storageLevelOffset(levelOffset: number) {
        super.storageLevelOffset = levelOffset;
        this.m_decoderOptions.storageLevelOffset = this.storageLevelOffset;
        this.configureDecoder(undefined, undefined, undefined, {
            storageLevelOffset: this.storageLevelOffset
        });
    }

    /** @override */
    setEnableElevationOverlay(enable: boolean) {
        if (this.m_decoderOptions.enableElevationOverlay !== enable) {
            this.m_decoderOptions.enableElevationOverlay = enable;
            this.configureDecoder(undefined, undefined, undefined, {
                enableElevationOverlay: enable
            });
        }
    }

    private configureDecoder(
        styleSet?: StyleSet,
        definitions?: Definitions,
        languages?: string[],
        options?: OptionsMap
    ) {
        this.clearCache();
        this.decoder.configure(styleSet, definitions, languages, options);
        this.mapView.markTilesDirty(this);
    }
}
