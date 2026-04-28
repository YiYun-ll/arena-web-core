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

const MODE_MESSAGE_TIMEOUT_MS = 3000;

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
        this._modeMessageTimeoutId = null;

        ARENA.events.addMultiEventListener(
            [ARENA_EVENTS.ARENA_LOADED, ARENA_EVENTS.MQTT_LOADED],
            this.ready.bind(this)
        );

        this.position = new THREE.Vector3();
        this.rotation = new THREE.Quaternion();

        // Reuse to avoid allocation
        this.currPos = new THREE.Vector3();
        this.currRot = new THREE.Quaternion();

        // v10: 连接世代计数器，防止旧连接的延迟回调中断新连接
        this._connectionGen = 0;
        this._rafFrameCount = 0;
        this._rafLastSampleTime = performance.now();
        this._rafFps = 0;
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

        // v10: 清理旧连接，防止旧 PC/DataChannel 的延迟回调与新连接竞态
        if (this.pc) {
            try {
                this.pc.close();
            } catch (e) {
                // ignore
            }
            this.pc = null;
        }
        this.inputDataChannel = null;
        this.statusDataChannel = null;
        this.renderDecisionsChannel = null;

        this.pc = new RTCPeerConnection(pcConfig);
        // v10: 递增连接世代，用于过滤旧连接的延迟事件回调
        this._connectionGen++;
        const myGen = this._connectionGen;

        this.pc.onicecandidate = this.onIceCandidate.bind(this);
        this.pc.ontrack = this.onRemoteTrack.bind(this);
        this.pc.oniceconnectionstatechange = () => {
            if (!_this.pc) return;
            // v10: 忽略非当前世代 PC 的事件
            if (_this._connectionGen !== myGen) return;
            // console.debug('iceConnectionState changed:', this.pc.iceConnectionState);
            if (_this.pc.iceConnectionState === 'disconnected') {
                _this.handleCloudDisconnect();
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
            // v10: 忽略旧世代 DataChannel 的关闭事件，防止中断新连接
            if (_this._connectionGen !== myGen) return;
            _this.handleCloudDisconnect();
        };

        this.statusDataChannel = this.pc.createDataChannel('client-status', dataChannelOptions);
        this.statusDataChannel.onopen = () => {
            // console.debug('status data channel opened');
        };
        this.statusDataChannel.onclose = () => {
            // console.debug('status data channel closed');
            // v10: 忽略旧世代 DataChannel 的关闭事件，防止中断新连接
            if (_this._connectionGen !== myGen) return;
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
                this.currentGlobalMode = null;
                this._scheduleModeMessageFallback();

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
        // v10: 增加保护，避免在断开或重连期间处理迟到的 candidate
        if (!this.connected || !this.pc) {
            return;
        }
        this.pc.addIceCandidate(new RTCIceCandidate(candidate));
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
            this._clearModeMessageFallback();
            this.applyGlobalRenderMode(msg.mode);
        }
    },

    _scheduleModeMessageFallback() {
        this._clearModeMessageFallback();
        this._modeMessageTimeoutId = window.setTimeout(() => {
            this._modeMessageTimeoutId = null;
            if (!this.connected || this.currentGlobalMode !== null) return;
            warn(`No render_mode received within ${MODE_MESSAGE_TIMEOUT_MS}ms; falling back to pure_local.`);
            this.applyGlobalRenderMode('pure_local');
        }, MODE_MESSAGE_TIMEOUT_MS);
    },

    _clearModeMessageFallback() {
        if (this._modeMessageTimeoutId === null) return;
        window.clearTimeout(this._modeMessageTimeoutId);
        this._modeMessageTimeoutId = null;
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

        this._clearModeMessageFallback();
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
        // v10: 先关闭再置空，但保留 gotOffer 自行创建新 PC 的权责
        if (this.pc) {
            try {
                this.pc.close();
            } catch (e) {
                // ignore
            }
        }
        this.pc = null;
        this.healthCounter = 0;
        this.connectToCloud();
    },

    async checkStats() {
        const { data } = this;
        // v10: 使用 await + try-catch，防止 getStats 异常中断整个循环
        while (this.connected) {
            try {
                if (this.currentGlobalMode === 'pure_local') {
                    // PureLocal 模式无视频流，绕过 webrtc-stats 直接上报浏览器侧指标
                    if (this.signaler) {
                        this.signaler.sendStats({
                            rafFps: this._rafFps,
                            // framesPerSecond 会被 mqtt-signaling 映射为 frameRateFps，
                            // Unity 侧最终写入 CSV 的 clientFPS 列
                            framesPerSecond: this._rafFps,
                            statsSchemaVersion: 2,
                        });
                    }
                } else if (this.stats) {
                    await this.stats.getStats({
                        latency: this.compositor.latency,
                        rafFps: this._rafFps,
                    });
                }
            } catch (err) {
                console.warn('[checkStats] stats error:', err);
            }
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
        this._rafFrameCount += 1;
        const now = performance.now();
        if (now - this._rafLastSampleTime >= 1000) {
            this._rafFps = (this._rafFrameCount * 1000) / (now - this._rafLastSampleTime);
            this._rafFrameCount = 0;
            this._rafLastSampleTime = now;
        }
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
