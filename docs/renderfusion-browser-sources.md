# RenderFusion 浏览器源码快照

以下为 `arena-web-core` 中 RenderFusion 相关两个文件的完整内容（便于归档与对照）。源路径：

- `src/systems/renderfusion/render-client.js`
- `src/components/renderfusion/remote-render.js`

---

## `render-client.js`

```javascript
import MQTTSignaling from './signaling/mqtt-signaling';
import WebRTCStatsLogger from './webrtc-stats';
import RenderFusionUtils from './utils';
import { ARENA_EVENTS } from '../../constants';

const info = AFRAME.utils.debug('ARENA:render-client:info');
const warn = AFRAME.utils.debug('ARENA:render-client:warn');
// const error = AFRAME.utils.debug('ARENA:render-client:error');

const pcConfig = {
    sdpSemantics: 'unified-plan',
    bundlePolicy: 'balanced',
    offerExtmapAllowMixed: false,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

const sdpConstraints = {
    offerToReceiveAudio: 0,
    offerToReceiveVideo: 1,
    voiceActivityDetection: false,
};

const invalidCodecs = ['video/red', 'video/ulpfec', 'video/rtx'];
const preferredCodec = 'video/H264';
const preferredSdpFmtpPrefix = 'level-asymmetry-allowed=1;packetization-mode=1;';
const preferredSdpFmtpLine = 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f';

const dataChannelOptions = {
    // ordered: true,
    ordered: false, // do not guarantee order
    // maxPacketLifeTime: 17, // in milliseconds
    maxRetransmits: null,
};

const supportsSetCodecPreferences =
    window.RTCRtpTransceiver && 'setCodecPreferences' in window.RTCRtpTransceiver.prototype;

/** a-entity ids that should not participate in remote-render toggling */
const REMOTE_RENDER_SKIP_IDS = new Set(['env', 'my-camera', 'cameraRig', 'floor']);

function shouldSkipRemoteRenderEntityId(id) {
    if (!id) return true;
    if (REMOTE_RENDER_SKIP_IDS.has(id)) return true;
    if (id.startsWith('jitsi-')) return true;
    return false;
}

AFRAME.registerComponent('arena-hybrid-render-client', {
    schema: {
        enabled: { type: 'boolean', default: false },
        getStatsInterval: { type: 'number', default: 500 },
        hasDualCameras: { type: 'boolean', default: false },
        ipd: { type: 'number', default: 0.064 },
        leftProj: { type: 'array' },
        rightProj: { type: 'array' },
    },

    async init() {
        this.isReady = false;
        this.pendingDecisions = {};
        this.currentGlobalMode = null;
        this.renderDecisionsChannel = null;
        this._sceneMutationObserver = null;

        ARENA.events.addMultiEventListener(
            [ARENA_EVENTS.ARENA_LOADED, ARENA_EVENTS.MQTT_LOADED],
            this.ready.bind(this)
        );

        this.position = new THREE.Vector3();
        this.rotation = new THREE.Quaternion();

        // Reuse to avoid allocation
        this.currPos = new THREE.Vector3();
        this.currRot = new THREE.Quaternion();
    },

    async ready() {
        const { el } = this;
        const { sceneEl } = el;

        this.arena = sceneEl.systems['arena-scene'];
        this.mqtt = sceneEl.systems['arena-mqtt'];

        info('Starting Hybrid Rendering...');
        this.connected = false;
        this.frameID = 0;

        this.compositor = sceneEl.systems.compositor;

        this.id = this.arena.idTag;

        const host = this.mqtt.mqttHostURI;
        const username = this.mqtt.userName;
        const token = this.arena.mqttToken.mqtt_token;
        const dbg = Boolean(ARENA.params.debug); // deterministic truthy/falsy boolean

        this.signaler = new MQTTSignaling(this.id, host, username, token, dbg);
        this.signaler.onOffer = this.gotOffer.bind(this);
        this.signaler.onHealthCheck = this.gotHealthCheck.bind(this);
        this.signaler.onAnswer = this.gotAnswer.bind(this);
        this.signaler.onIceCandidate = this.gotIceCandidate.bind(this);
        this.signaler.onConnect = this.connectToCloud.bind(this);
        window.onbeforeunload = () => {
            this.signaler.closeConnection();
        };

        await this.signaler.openConnection();

        window.addEventListener('enter-vr', this.onEnterVR.bind(this));
        window.addEventListener('exit-vr', this.onExitVR.bind(this));
        document.addEventListener('fullscreenchange', this.onEnterVR.bind(this));
        document.addEventListener('mozfullscreenchange', this.onEnterVR.bind(this));
        document.addEventListener('MSFullscreenChange', this.onEnterVR.bind(this));
        document.addEventListener('webkitfullscreenchange', this.onEnterVR.bind(this));

        this._attachSceneMutationObserver();

        this.isReady = true;
    },

    connectToCloud() {
        this.signaler.connectionId = null;

        info('Connecting to remote server...');
        this.signaler.sendConnectACK();
    },

    onRemoteTrack(evt) {
        info('Got remote stream! Hybrid Rendering session started.');

        this.setupTransceiver(evt.transceiver);

        const stream = new MediaStream();
        stream.addTrack(evt.track);

        // send remote track to compositor
        this.remoteVideo = document.getElementById('remoteVideo');
        if (!this.remoteVideo) {
            this.remoteVideo = document.createElement('video');
            this.remoteVideo.id = 'remoteVideo';
            this.remoteVideo.setAttribute('muted', 'false');
            this.remoteVideo.setAttribute('autoplay', 'true');
            this.remoteVideo.setAttribute('playsinline', 'true');
            this.remoteVideo.addEventListener('loadedmetadata', this.onRemoteVideoLoaded.bind(this), true);

            this.remoteVideo.style.position = 'absolute';
            this.remoteVideo.style.zIndex = '9999';
            this.remoteVideo.style.top = '15px';
            this.remoteVideo.style.left = '15px';
            this.remoteVideo.style.width = '384px';
            this.remoteVideo.style.height = '108px';
            document.body.appendChild(this.remoteVideo);

            /* const geometry = new THREE.PlaneGeometry(19.2, 10.8);
             * const material = new THREE.MeshBasicMaterial({ map: remoteRenderTarget.texture });
             * const mesh = new THREE.Mesh(geometry, material);
             * mesh.position.z = -12;
             * mesh.position.y = 7;
             * scene.add(mesh); */
        }
        // this.remoteVideo.style.display = 'block';
        this.remoteVideo.style.display = 'none';
        this.remoteVideo.srcObject = stream;
        this.remoteVideo.play();
    },

    onRemoteVideoLoaded() {
        // console.debug('[render-client], remote video loaded!');
        const videoTexture = new THREE.VideoTexture(this.remoteVideo);
        videoTexture.minFilter = THREE.NearestFilter;
        videoTexture.magFilter = THREE.NearestFilter;
        // videoTexture.colorSpace = THREE.SRGBColorSpace;
        // const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
        // videoTexture.anisotropy = maxAnisotropy;

        const remoteRenderTarget = new THREE.WebGLRenderTarget(
            this.remoteVideo.videoWidth,
            this.remoteVideo.videoHeight
        );
        remoteRenderTarget.texture = videoTexture;

        this.compositor.addRemoteRenderTarget(remoteRenderTarget);
        // this.compositor.bind();
    },

    onIceCandidate(event) {
        // console.debug('pc ICE candidate: \n ' + event.candidate);
        if (event.candidate != null) {
            this.signaler.sendCandidate(event.candidate);
        }
    },

    setupTransceiver(transceiver) {
        if (supportsSetCodecPreferences) {
            // const transceiver = this.pc.addTransceiver('video', {direction: 'recvonly'});
            const { codecs } = RTCRtpReceiver.getCapabilities('video');
            const validCodecs = codecs.filter((codec) => !invalidCodecs.includes(codec.mimeType));
            const preferredCodecs = validCodecs.sort((c1, c2) => {
                if (c1.mimeType === preferredCodec && c1.sdpFmtpLine.includes(preferredSdpFmtpPrefix)) {
                    return -1;
                }
                return 1;
            });
            const selectedCodecIndex = validCodecs.findIndex(
                (c) => c.mimeType === preferredCodec && c.sdpFmtpLine === preferredSdpFmtpLine
            );
            if (selectedCodecIndex !== -1) {
                const selectedCodec = validCodecs[selectedCodecIndex];
                preferredCodecs.splice(selectedCodecIndex, 1);
                preferredCodecs.unshift(selectedCodec);
            }
            console.log('codecs', preferredCodecs);
            transceiver.setCodecPreferences(preferredCodecs);
        }
    },

    gotOffer(offer) {
        // console.debug('got offer.');

        const _this = this;
        this.pc = new RTCPeerConnection(pcConfig);
        this.pc.onicecandidate = this.onIceCandidate.bind(this);
        this.pc.ontrack = this.onRemoteTrack.bind(this);
        this.pc.oniceconnectionstatechange = () => {
            if (_this.pc) {
                // console.debug('iceConnectionState changed:', this.pc.iceConnectionState);
                if (_this.pc.iceConnectionState === 'disconnected') {
                    _this.handleCloudDisconnect();
                }
            }
        };

        this.renderDecisionsChannel = null;
        this.pc.ondatachannel = (evt) => {
            if (evt.channel.label === 'render-decisions') {
                this.renderDecisionsChannel = evt.channel;
                this.renderDecisionsChannel.onmessage = (m) => this.onRenderDecisionMessage(m);
            }
        };

        this.inputDataChannel = this.pc.createDataChannel('client-input', dataChannelOptions);
        this.inputDataChannel.onopen = () => {
            // console.debug('input data channel opened');
        };
        this.inputDataChannel.onclose = () => {
            // console.debug('input data channel closed');
            _this.handleCloudDisconnect();
        };

        this.statusDataChannel = this.pc.createDataChannel('client-status', dataChannelOptions);
        this.statusDataChannel.onopen = () => {
            // console.debug('status data channel opened');
        };
        this.statusDataChannel.onclose = () => {
            // console.debug('status data channel closed');
            _this.handleCloudDisconnect();
        };

        this.stats = new WebRTCStatsLogger(this.pc, this.signaler);

        this.pc
            .setRemoteDescription(new RTCSessionDescription(offer))
            .then(() => {
                this.createAnswer();
            })
            .catch((err) => {
                console.error(err);
            });
    },

    createOffer() {
        // console.debug('creating offer.');

        this.pc
            .createOffer(sdpConstraints)
            .then((description) => {
                this.pc
                    .setLocalDescription(description)
                    .then(() => {
                        // console.debug('sending offer.');
                        this.signaler.sendOffer(this.pc.localDescription);
                    })
                    .catch((err) => {
                        console.error(err);
                    });
            })
            .catch((err) => {
                console.error(err);
            });
    },

    gotAnswer(answer) {
        // console.debug('got answer.');

        this.pc
            .setRemoteDescription(new RTCSessionDescription(answer))
            .then(() => {
                this.connected = true;

                const env = document.getElementById('env');
                env.setAttribute('visible', false);

                this.checkStats();
            })
            .catch((err) => {
                console.error(err);
            });
    },

    createAnswer() {
        // console.debug('creating answer.');

        this.pc
            .createAnswer()
            .then((description) => {
                this.pc.setLocalDescription(description).then(() => {
                    // console.debug('sending answer');
                    this.signaler.sendAnswer(this.pc.localDescription);
                    this.createOffer();
                });
            })
            .then(() => {
                const receivers = this.pc.getReceivers();
                receivers.forEach((receiver) => {
                    // eslint-disable-next-line no-param-reassign
                    receiver.playoutDelayHint = 0;
                });
            })
            .catch((err) => {
                console.error(err);
            });
    },

    gotIceCandidate(candidate) {
        // console.debug('got ice.');
        if (this.connected) {
            this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    },

    gotHealthCheck() {
        this.signaler.sendHealthCheckAck();
    },

    onRenderDecisionMessage(ev) {
        let msg;
        try {
            msg = JSON.parse(ev.data);
        } catch {
            return;
        }
        if (msg.type === 'render_decision') {
            // Unity: 0 = Remote, 1 = Local
            this.applyPerObjectDecision(msg.objectId, msg.renderMode === 0);
        } else if (msg.type === 'render_mode') {
            this.applyGlobalRenderMode(msg.mode);
        }
    },

    ensureCompositorPassEnabled() {
        const { compositor } = this;
        if (!compositor?.pass) return;
        compositor.pass.enabled = true;
        const { effects } = this.el.sceneEl.systems;
        if (effects.composer.passes.indexOf(compositor.pass) === -1) {
            effects.insertPass(compositor.pass, 0);
        }
    },

    applyGlobalRenderMode(mode) {
        this.currentGlobalMode = mode;
        const env = document.getElementById('env');

        if (mode === 'pure_local') {
            this.setAllArenaEntitiesRemoteRender(false);
            this.compositor.disable();
            if (env) env.setAttribute('visible', true);
            if (this.remoteVideo) this.remoteVideo.style.display = 'none';
        } else if (mode === 'pure_remote') {
            this.setAllArenaEntitiesRemoteRender(true);
            this.ensureCompositorPassEnabled();
            if (env) env.setAttribute('visible', false);
        } else {
            // smart (or unknown): compositor on, env hidden like hybrid default; per-object decisions apply
            this.ensureCompositorPassEnabled();
            if (env) env.setAttribute('visible', false);
            this.setAllArenaEntitiesRemoteRender(false);
            const pendingSnapshot = { ...this.pendingDecisions };
            Object.keys(pendingSnapshot).forEach((objectId) => {
                this.applyPerObjectDecision(objectId, pendingSnapshot[objectId]);
            });
        }
    },

    findArenaEntityByObjectId(objectId) {
        if (!objectId) return null;
        const node = document.getElementById(objectId);
        if (node && node.matches && node.matches('a-entity')) return node;
        return null;
    },

    applyPerObjectDecision(objectId, isRemote) {
        if (shouldSkipRemoteRenderEntityId(objectId)) return;
        const entity = this.findArenaEntityByObjectId(objectId);
        if (entity && shouldSkipRemoteRenderEntityId(entity.id)) return;
        if (!entity) {
            this.pendingDecisions[objectId] = isRemote;
            return;
        }
        entity.setAttribute('remote-render', 'enabled', isRemote);
        delete this.pendingDecisions[objectId];
    },

    setAllArenaEntitiesRemoteRender(enabled) {
        const { sceneEl } = this.el;
        if (!sceneEl) return;
        sceneEl.querySelectorAll('a-entity[id]').forEach((entityEl) => {
            if (shouldSkipRemoteRenderEntityId(entityEl.id)) return;
            entityEl.setAttribute('remote-render', 'enabled', enabled);
        });
    },

    _onArenaEntityAttached(entityEl) {
        if (!entityEl?.id || shouldSkipRemoteRenderEntityId(entityEl.id)) return;
        if (Object.prototype.hasOwnProperty.call(this.pendingDecisions, entityEl.id)) {
            const isRemote = this.pendingDecisions[entityEl.id];
            entityEl.setAttribute('remote-render', 'enabled', isRemote);
            delete this.pendingDecisions[entityEl.id];
            return;
        }
        if (this.currentGlobalMode === 'pure_local') {
            entityEl.setAttribute('remote-render', 'enabled', false);
        } else if (this.currentGlobalMode === 'pure_remote') {
            entityEl.setAttribute('remote-render', 'enabled', true);
        }
    },

    _attachSceneMutationObserver() {
        const { sceneEl } = this.el;
        if (!sceneEl || this._sceneMutationObserver) return;

        const flushExisting = () => {
            sceneEl.querySelectorAll('a-entity[id]').forEach((entityEl) => this._onArenaEntityAttached(entityEl));
        };

        this._sceneMutationObserver = new MutationObserver((mutations) => {
            mutations.forEach((record) => {
                record.addedNodes.forEach((node) => {
                    if (node.nodeType !== Node.ELEMENT_NODE) return;
                    if (node.matches?.('a-entity[id]')) {
                        this._onArenaEntityAttached(node);
                    }
                    node.querySelectorAll?.('a-entity[id]').forEach((child) => this._onArenaEntityAttached(child));
                });
            });
        });

        this._sceneMutationObserver.observe(sceneEl, { childList: true, subtree: true });

        if (sceneEl.hasLoaded) {
            flushExisting();
        } else {
            sceneEl.addEventListener('loaded', flushExisting, { once: true });
        }
    },

    handleCloudDisconnect() {
        warn('Hybrid Rendering session ended.');

        if (!this.connected) return;

        const env = document.getElementById('env');
        if (env) env.setAttribute('visible', true);

        this.setAllArenaEntitiesRemoteRender(false);
        this.pendingDecisions = {};
        this.currentGlobalMode = null;
        this.renderDecisionsChannel = null;

        // this.compositor.unbind();
        this.compositor.disable();
        if (this.remoteVideo) this.remoteVideo.style.display = 'none';

        this.connected = false;
        this.inputDataChannel = null;
        this.statusDataChannel = null;
        this.pc = null;
        this.healthCounter = 0;
        this.connectToCloud();
    },

    async checkStats() {
        const { data } = this;
        while (this.connected) {
            this.stats.getStats({ latency: this.compositor.latency });
            // eslint-disable-next-line no-await-in-loop
            await this.sleep(data.getStatsInterval);
        }
    },

    sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    },

    sendStatus() {
        if (!this.connected) return;

        const { el } = this;
        const { data } = this;
        const { sceneEl } = el;

        const isFullScreen =
            (document.fullscreenElement ||
                document.webkitFullscreenElement ||
                document.mozFullScreenElement ||
                document.msFullscreenElement) !== undefined;
        const isVRMode = sceneEl.is('vr-mode') && !isFullScreen;
        const isARMode = sceneEl.is('ar-mode') && !isFullScreen;
        const hasDualCameras = (isVRMode && !isARMode) || data.hasDualCameras;
        this.statusDataChannel.send(
            JSON.stringify({
                isVRMode,
                isARMode,
                hasDualCameras,
                ipd: data.ipd,
                leftProj: data.leftProj,
                rightProj: data.rightProj,
                ts: new Date().getTime(),
            })
        );
    },

    onEnterVR() {
        this.sendStatus();
    },

    onExitVR() {
        this.sendStatus();
    },

    update(oldData) {
        const { data } = this;

        let updateStatus = false;

        if (oldData.ipd !== undefined && data.ipd !== oldData.ipd) {
            updateStatus = true;
        }

        if (oldData.hasDualCameras !== undefined && data.hasDualCameras !== oldData.hasDualCameras) {
            updateStatus = true;
        }

        if (oldData.leftProj !== undefined && !AFRAME.utils.deepEqual(data.leftProj, oldData.leftProj)) {
            updateStatus = true;
        }

        if (oldData.rightProj !== undefined && !AFRAME.utils.deepEqual(data.rightProj, oldData.rightProj)) {
            updateStatus = true;
        }

        if (updateStatus) this.sendStatus();
    },

    tick(t) {
        if (!this.isReady) return;
        const { data, el } = this;

        const { sceneEl } = el;
        const { camera } = sceneEl;

        const { renderer } = sceneEl;

        const cameraVR = renderer.xr.getCamera();

        if (this.connected && this.inputDataChannel.readyState === 'open') {
            const camPose = new THREE.Matrix4();
            camPose.copy(camera.matrixWorld);

            this.currPos.setFromMatrixPosition(camPose);
            this.currRot.setFromRotationMatrix(camPose);

            let changed = false;
            if (this.position.distanceTo(this.currPos) > 0.01) {
                this.position.copy(this.currPos);
                changed = true;
            }

            if (this.rotation.angleTo(this.currRot) > 0.01) {
                this.rotation.copy(this.currRot);
                changed = true;
            }

            if (t < 1000 && changed === false) return;

            const poseMsg = RenderFusionUtils.packPoseMsg(camPose.elements, parseFloat(this.frameID));
            this.inputDataChannel.send(poseMsg);

            if (renderer.xr.enabled === true && renderer.xr.isPresenting === true) {
                const camPoseL = new THREE.Matrix4();
                const camPoseR = new THREE.Matrix4();
                camPoseL.copy(cameraVR.cameras[0].matrixWorld);
                camPoseR.copy(cameraVR.cameras[1].matrixWorld);

                this.compositor.prevFrames[this.frameID] = {
                    pose: [camPoseL, camPoseR],
                    ts: performance.now(),
                };
            } else {
                this.compositor.prevFrames[this.frameID] = {
                    pose: camPose,
                    ts: performance.now(),
                };
            }

            this.frameID = (this.frameID + 100) & 0xffffffff;
        }
    },
});
```

---

## `remote-render.js`

```javascript
AFRAME.registerComponent('remote-render', {
    schema: {
        enabled: { type: 'boolean', default: false },
        printObjectStats: { type: 'boolean', default: true },
    },

    init() {
        const { data, el } = this;
        if (!el) return;

        this.getObjectStats = this.getObjectStats.bind(this);

        if (data.printObjectStats) {
            if (el.hasAttribute('gltf-model')) {
                el.addEventListener('model-loaded', this.getObjectStats, { once: true });
            } else {
                this.getObjectStats();
            }
        }
    },

    clipCornersToViewport(corners) {
        const clippedCorners = [];

        corners.forEach((corner) => {
            const clippedCorner = new THREE.Vector3(
                Math.min(Math.max(corner.x, -1), 1),
                Math.min(Math.max(corner.y, -1), 1),
                corner.z
            );
            clippedCorners.push(clippedCorner);
        });

        return clippedCorners;
    },

    solidAngleSubtendedByBoundingBox(cameraPosition, center, dimensions) {
        const width = dimensions.x;
        const height = dimensions.y;
        const depth = dimensions.z;

        const diagonalLength = Math.sqrt(width * width + height * height + depth * depth) / 2;
        const A = Math.PI * diagonalLength ** 2;

        const r = cameraPosition.distanceTo(center);

        const solidAngle = A / r ** 2;

        return solidAngle;
    },

    getObjectStats() {
        const { el } = this;
        if (!el?.sceneEl) return;
        const { sceneEl } = el;

        const { camera } = sceneEl;

        const object = el.getObject3D('mesh');
        if (object === undefined) return;

        let triangleCount = 0;
        object.traverse((node) => {
            if (node.isMesh) {
                triangleCount += node.geometry.attributes.position.count / 3;
            }
        });

        // console.log('Triangle count:', el.id, triangleCount);

        const box = new THREE.Box3().setFromObject(el.object3D);

        const center = new THREE.Vector3();
        box.getCenter(center);

        const dimensions = new THREE.Vector3();
        box.getSize(dimensions);

        // const box1 = new THREE.BoxHelper(el.object3D, 0xffff00);
        // sceneEl.object3D.add(box1);

        const cameraPosition = camera.position;
        const solidAngle = this.solidAngleSubtendedByBoundingBox(cameraPosition, center, dimensions);

        // console.log('Total solid angle:', el.id, solidAngle);
    },

    update() {
        // console.log('[render-client]', this.el.id, this.data.enabled);
        if (!this.el) return;
        this.el.setAttribute('visible', !this.data.enabled);
    },
});
```
