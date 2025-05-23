import {Event, ErrorEvent, Evented} from '../../src/util/evented';
import Model from '../data/model';
import convertModel from '../source/model_loader';
import {ResourceType} from '../../src/util/ajax';
import {loadGLTF} from '../util/loaders';

import type {RequestManager} from '../../src/util/mapbox';
import type Painter from '../../src/render/painter';
import type {ModelsSpecification} from '../../src/style-spec/types';

// Keep the number of references to each model
// to avoid deleting models in use
type ReferencedModel = {
    model: Model;
    numReferences: number;
};

class ModelManager extends Evented {
    models: {
        [scope: string]: {
            [id: string]: ReferencedModel;
        };
    };
    modelUris: {
        [scope: string]: {
            [id: string]: string;
        }
    };
    numModelsLoading: {
        [scope: string]: number;
    };
    requestManager: RequestManager;

    constructor(requestManager: RequestManager) {
        super();
        this.requestManager = requestManager;
        this.models = {'': {}};
        this.modelUris = {'': {}};
        this.numModelsLoading = {};
    }

    loadModel(id: string, url: string): Promise<Model | null | undefined> {
        return loadGLTF(this.requestManager.transformRequest(url, ResourceType.Model).url)
            .then(gltf => {
                if (!gltf) return;

                const nodes = convertModel(gltf);
                const model = new Model(id, undefined, undefined, nodes);
                model.computeBoundsAndApplyParent();
                return model;
            })
            .catch((err) => {
                if (err && err.status === 404) {
                    return null;
                }
                this.fire(new ErrorEvent(new Error(`Could not load model ${id} from ${url}: ${err.message}`)));
            });
    }

    load(modelUris: {
        [key: string]: string;
    }, scope: string, options: {
        keepNumReferences?: boolean
    } = {
        keepNumReferences: false
    }) {
        if (!this.models[scope]) this.models[scope] = {};

        const modelIds = Object.keys(modelUris);
        this.numModelsLoading[scope] = (this.numModelsLoading[scope] || 0) + modelIds.length;

        const modelLoads: Promise<Model>[] = [];
        for (const modelId of modelIds) {
            modelLoads.push(this.loadModel(modelId, modelUris[modelId]));
        }

        Promise.allSettled(modelLoads)
            .then(results => {
                for (let i = 0; i < results.length; i++) {
                    const {status, value} = results[i] as PromiseFulfilledResult<Model>;
                    if (status === 'fulfilled' && value) {
                        const previousModel = this.models[scope][modelIds[i]];
                        const numReferences = options.keepNumReferences && previousModel ? previousModel.numReferences : 1;
                        this.models[scope][modelIds[i]] = {model: value, numReferences};
                    }
                }
                this.numModelsLoading[scope] -= modelIds.length;
                this.fire(new Event('data', {dataType: 'style'}));
            })
            .catch((err) => {
                this.fire(new ErrorEvent(new Error(`Could not load models: ${err.message}`)));
            });
    }

    isLoaded(): boolean {
        for (const scope in this.numModelsLoading) {
            if (this.numModelsLoading[scope] > 0) return false;
        }
        return true;
    }

    hasModel(id: string, scope: string): boolean {
        return !!this.getModel(id, scope);
    }

    getModel(id: string, scope: string): Model | null | undefined {
        if (!this.models[scope]) this.models[scope] = {};
        return this.models[scope][id] ? this.models[scope][id].model : undefined;
    }

    addModel(id: string, url: string, scope: string) {
        if (!this.models[scope]) this.models[scope] = {};
        if (!this.modelUris[scope]) this.modelUris[scope] = {};

        // update num references if the model exists
        if (this.hasModel(id, scope)) {
            this.models[scope][id].numReferences++;
        }

        this.modelUris[scope][id] = this.requestManager.normalizeModelURL(url);

        this.load({[id]: this.modelUris[scope][id]}, scope);
    }

    addModels(models: ModelsSpecification, scope: string) {
        if (!this.models[scope]) this.models[scope] = {};
        if (!this.modelUris[scope]) this.modelUris[scope] = {};

        const modelUris: Record<string, any> = this.modelUris[scope];
        for (const modelId in models) {
            // Add an empty object so we mark this model as requested
            this.models[scope][modelId] = {} as ReferencedModel;
            modelUris[modelId] = this.requestManager.normalizeModelURL(models[modelId]);
        }
        this.load(modelUris, scope, {keepNumReferences: true});
    }

    reloadModels(scope: string) {
        this.load(this.modelUris[scope], scope);
    }

    addModelsFromBucket(modelUris: Array<string>, scope: string) {
        if (!this.models[scope]) this.models[scope] = {};
        if (!this.modelUris[scope]) this.modelUris[scope] = {};

        const modelsRequests: Record<string, any> = {};
        for (const modelUri of modelUris) {
            if (this.hasModel(modelUri, scope)) {
                this.models[scope][modelUri].numReferences++;
            } else {
                this.modelUris[scope][modelUri] = this.requestManager.normalizeModelURL(modelUri);
                modelsRequests[modelUri] = this.modelUris[scope][modelUri];
            }
        }
        this.load(modelsRequests, scope);
    }

    removeModel(id: string, scope: string) {
        if (!this.models[scope] || !this.models[scope][id]) return;
        this.models[scope][id].numReferences--;
        if (this.models[scope][id].numReferences === 0) {
            const model = this.models[scope][id].model;
            delete this.models[scope][id];
            delete this.modelUris[scope][id];
            model.destroy();
        }
    }

    listModels(scope: string): Array<string> {
        if (!this.models[scope]) this.models[scope] = {};
        return Object.keys(this.models[scope]);
    }

    upload(painter: Painter, scope: string) {
        if (!this.models[scope]) this.models[scope] = {};
        for (const modelId in this.models[scope]) {
            if (this.models[scope][modelId].model) {
                this.models[scope][modelId].model.upload(painter.context);
            }
        }
    }
}

export default ModelManager;
