import { EventHandler } from '../../core/event-handler.js';
import { TEXTURELOCK_READ } from '../../platform/graphics/constants.js';
import { platform } from '../../core/platform.js';
import { SortWorker } from './gsplat-sort-worker.js';

const absNow = () => {
    if (typeof performance === 'undefined') {
        return Date.now();
    }

    return (performance.timeOrigin ?? (Date.now() - performance.now())) + performance.now();
};

class GSplatSorter extends EventHandler {
    worker;

    orderTexture;

    centers;

    scene;

    sortRequestId = 0;

    constructor(scene) {
        super();
        this.scene = scene ?? null;

        const messageHandler = (message) => {
            const msgData = message.data ?? message;
            const profile = msgData.profile ? {
                ...msgData.profile,
                mainReceiveAbs: absNow()
            } : null;

            // Fire sortTime event on scene
            if (this.scene && msgData.sortTime !== undefined) {
                this.scene.fire('gsplat:sorted', msgData.sortTime);
            }

            const applyStart = performance.now();
            const newOrder = msgData.order;
            const oldOrder = this.orderTexture._levels[0].buffer;

            // send vertex storage to worker to start the next frame
            this.worker.postMessage({
                order: oldOrder
            }, [oldOrder]);

            // write the new order data to gpu texture memory
            this.orderTexture._levels[0] = new Uint32Array(newOrder);
            this.orderTexture.upload();
            const mainApplyMs = performance.now() - applyStart;
            const details = profile ? {
                ...profile,
                mainApplyMs,
                mainApplyEndAbs: absNow(),
                drawSplats: msgData.count,
                count: msgData.count,
                sortTime: msgData.sortTime
            } : null;

            if (this.scene && details) {
                this.scene.fire('gsplat:sort:profile', details);
            }

            // set new data directly on texture
            this.fire('updated', msgData.count, details);
        };

        const workerSource = `(${SortWorker.toString()})()`;

        if (platform.environment === 'node') {
            this.worker = new Worker(workerSource, {
                eval: true
            });
            this.worker.on('message', messageHandler);
        } else {
            this.worker = new Worker(URL.createObjectURL(new Blob([workerSource], {
                type: 'application/javascript'
            })));
            this.worker.addEventListener('message', messageHandler);
        }
    }

    destroy() {
        this.worker.terminate();
        this.worker = null;
    }

    init(orderTexture, centers, chunks) {
        this.orderTexture = orderTexture;
        this.centers = centers.slice();

        // get the texture's storage buffer and make a copy
        const orderBuffer = this.orderTexture.lock({
            mode: TEXTURELOCK_READ
        }).slice();
        this.orderTexture.unlock();

        // initialize order data
        for (let i = 0; i < orderBuffer.length; ++i) {
            orderBuffer[i] = i;
        }

        const obj = {
            order: orderBuffer.buffer,
            centers: centers.buffer,
            chunks: chunks?.buffer
        };

        const transfer = [orderBuffer.buffer, centers.buffer].concat(chunks ? [chunks.buffer] : []);

        // send the initial buffer to worker
        this.worker.postMessage(obj, transfer);
    }

    setMapping(mapping) {
        const requestStart = performance.now();
        const requestStartAbs = absNow();
        const requestId = ++this.sortRequestId;
        const activeSplats = mapping ? mapping.length : (this.centers?.length ?? 0) / 3;
        const mappingLength = mapping ? mapping.length : 0;

        if (mapping) {
            const buildStart = performance.now();
            // create new centers array
            const centers = new Float32Array(mapping.length * 3);
            for (let i = 0; i < mapping.length; ++i) {
                const src = mapping[i] * 3;
                const dst = i * 3;
                centers[dst + 0] = this.centers[src + 0];
                centers[dst + 1] = this.centers[src + 1];
                centers[dst + 2] = this.centers[src + 2];
            }
            const mainBuildMs = performance.now() - buildStart;

            // update worker with new centers and mapping for the subset of splats
            this.worker.postMessage({
                centers: centers.buffer,
                mapping: mapping.buffer,
                profile: {
                    requestId,
                    requestType: 'mapping',
                    requestStartAbs,
                    mainPostAbs: absNow(),
                    mainSetMappingMs: performance.now() - requestStart,
                    mainBuildMs,
                    activeSplats,
                    mappingLength
                }
            }, [centers.buffer, mapping.buffer]);
        } else {
            // restore original centers
            const buildStart = performance.now();
            const centers = this.centers.slice();
            const mainBuildMs = performance.now() - buildStart;
            this.worker.postMessage({
                centers: centers.buffer,
                mapping: null,
                profile: {
                    requestId,
                    requestType: 'mapping',
                    requestStartAbs,
                    mainPostAbs: absNow(),
                    mainSetMappingMs: performance.now() - requestStart,
                    mainBuildMs,
                    activeSplats,
                    mappingLength
                }
            }, [centers.buffer]);
        }
    }

    setCamera(pos, dir) {
        const requestStart = performance.now();
        const requestStartAbs = absNow();
        const requestId = ++this.sortRequestId;
        this.worker.postMessage({
            cameraPosition: { x: pos.x, y: pos.y, z: pos.z },
            cameraDirection: { x: dir.x, y: dir.y, z: dir.z },
            profile: {
                requestId,
                requestType: 'camera',
                requestStartAbs,
                mainPostAbs: absNow(),
                mainSetCameraMs: performance.now() - requestStart,
                activeSplats: (this.centers?.length ?? 0) / 3
            }
        });
    }
}

export { GSplatSorter };
